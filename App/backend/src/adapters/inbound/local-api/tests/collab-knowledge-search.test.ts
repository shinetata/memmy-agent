/** Collab knowledge search: a named project needs membership, a bare search needs the session's own project. */
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollabService } from "../../../../services/collab-service.js";
import { registerCollabRoutes } from "../routes/collab.js";

const ONE = { id: "p-1", name: "MemOS" };
const TWO = { id: "p-2", name: "产品" };

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/**
 * `linked` 是这条会话关联到的项目，`memberOf` 是本人加入的全部项目：两者分开，
 * 才能守住「--project 点名时按成员身份放行，不必先 session add」。
 */
function createApp(linked: unknown[], recall: ReturnType<typeof vi.fn>, memberOf: unknown[] = linked) {
  const projectsForAgentSession = vi.fn().mockResolvedValue(linked);
  const listProjects = vi.fn().mockResolvedValue({ projects: memberOf });
  app = Fastify();
  registerCollabRoutes(app, {
    collab: { projectsForAgentSession, listProjects } as unknown as CollabService,
    authenticateRuntimeToken: async () => undefined,
    recallProjectKnowledge: recall as unknown as (query: string, projectId: string) => Promise<{ enabled: boolean; evidence: unknown[] }>
  });
  return { projectsForAgentSession, listProjects };
}

describe("collab knowledge search", () => {
  it("searches the project the session is linked to", async () => {
    const recall = vi.fn().mockResolvedValue({ enabled: true, evidence: [{ title: "需求", content: "模板" }] });
    const { projectsForAgentSession } = createApp([ONE], recall);

    const response = await app!.inject({
      method: "POST",
      url: "/api/collab/knowledge/search",
      payload: { query: "属性记忆模板", sourceId: "codex", conversationId: "thread-1" }
    });

    expect(response.statusCode).toBe(200);
    expect(projectsForAgentSession).toHaveBeenCalledWith("codex", "thread-1");
    expect(recall).toHaveBeenCalledWith("属性记忆模板", "p-1");
    expect(response.json()).toMatchObject({ project: ONE, enabled: true, evidence: [{ title: "需求" }] });
  });

  // 用户报的就是这一条：任务已经在项目里共享，--project 也点名了，却被「未关联项目」挡住。
  it("lets a named project through even when the session is not linked to it", async () => {
    const recall = vi.fn().mockResolvedValue({ enabled: true, evidence: [{ title: "积分方案", content: "规则" }] });
    const { projectsForAgentSession } = createApp([], recall, [ONE]);

    const response = await app!.inject({
      method: "POST",
      url: "/api/collab/knowledge/search",
      payload: { query: "积分", sourceId: "codex", conversationId: "thread-1", project: "MemOS" }
    });

    expect(response.statusCode).toBe(200);
    expect(recall).toHaveBeenCalledWith("积分", "p-1");
    // 点名项目时不必再去算会话归属，少一次列表与本地链接读取。
    expect(projectsForAgentSession).not.toHaveBeenCalled();
  });

  it("refuses to guess when the session is linked to several projects", async () => {
    const recall = vi.fn();
    createApp([ONE, TWO], recall);
    const payload = { query: "属性记忆模板", sourceId: "codex", conversationId: "thread-1" };

    const ambiguous = await app!.inject({ method: "POST", url: "/api/collab/knowledge/search", payload });

    expect(ambiguous.statusCode).toBe(409);
    expect(ambiguous.json()).toMatchObject({ error: { code: "conflict" } });
    // 同名项目只能靠短码区分，所以提示里两个都带上 id 前 8 位。
    expect(ambiguous.json().error.message).toContain("MemOS #p-1、产品 #p-2");
    expect(recall).not.toHaveBeenCalled();

    const selected = await app!.inject({ method: "POST", url: "/api/collab/knowledge/search", payload: { ...payload, project: "MemOS" } });
    expect(selected.statusCode).toBe(200);
    expect(recall).toHaveBeenCalledWith("属性记忆模板", "p-1");

    // --project 直接给 id 也认：这是同名项目唯一可靠的指定方式。
    const byId = await app!.inject({ method: "POST", url: "/api/collab/knowledge/search", payload: { ...payload, project: "p-2" } });
    expect(byId.statusCode).toBe(200);
    expect(recall).toHaveBeenCalledWith("属性记忆模板", "p-2");
  });

  it("turns away a project one is not a member of, and an incomplete identity", async () => {
    const recall = vi.fn();
    createApp([ONE], recall);

    const wrong = await app!.inject({
      method: "POST",
      url: "/api/collab/knowledge/search",
      payload: { query: "模板", sourceId: "codex", conversationId: "thread-1", project: "其他" }
    });
    const halfIdentity = await app!.inject({
      method: "POST",
      url: "/api/collab/knowledge/search",
      payload: { query: "模板", sourceId: "codex" }
    });
    const noTarget = await app!.inject({ method: "POST", url: "/api/collab/knowledge/search", payload: { query: "模板" } });

    expect(wrong.statusCode).toBe(404);
    expect(wrong.json()).toMatchObject({ error: { message: "没有名为「其他」的协作项目，或你不是它的成员" } });
    expect(halfIdentity.statusCode).toBe(400);
    expect(noTarget.statusCode).toBe(400);
    expect(recall).not.toHaveBeenCalled();
  });

  it("tells a session with no project how to link one", async () => {
    const recall = vi.fn();
    createApp([], recall);

    const response = await app!.inject({
      method: "POST",
      url: "/api/collab/knowledge/search",
      payload: { query: "模板", sourceId: "codex", conversationId: "thread-1" }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toContain("没有关联任何协作项目");
    expect(response.json().error.message).toContain("memmy-project session add");
    expect(recall).not.toHaveBeenCalled();
  });
});
