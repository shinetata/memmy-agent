import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCollabService,
  linkedSessionKeys,
  pageOf,
  parseSessionReference,
  sessionKey,
  type CollabServiceOptions,
  type LocalAgentSession
} from "../collab-service.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Answers cloud and Memory requests from a route table and records each call. */
function fakeFetch(routes: Record<string, (call: Call) => unknown>) {
  const calls: Call[] = [];
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined
    };
    calls.push(call);
    const key = `${call.method} ${new URL(url).pathname}`;
    const handler = routes[key];
    if (!handler) return new Response(JSON.stringify({ code: 404, message: "no route", data: null }), { status: 404 });
    const result = handler(call);
    return result instanceof Response ? result : new Response(JSON.stringify(result), { status: 200 });
  }) as typeof fetch;
  return { fetcher, calls };
}

function service(fetcher: typeof fetch, overrides: Partial<CollabServiceOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), "memmy-collab-"));
  roots.push(root);
  return createCollabService({
    cloudBaseUrl: "https://cloud.test.invalid",
    getAccount: () => ({ accountId: "u-b", credential: "uuid-b" }),
    memory: { baseUrl: "http://127.0.0.1:18960", token: "mem-token" },
    projectsDir: root,
    fetcher,
    now: () => new Date("2026-10-22T06:32:00.000Z"),
    ...overrides
  });
}

const cloudSession = {
  id: "5c1b2d3e-0000-4000-8000-000000000409",
  projectId: "p-1",
  projectName: "Memmy 开发",
  title: "重复分享返回 409",
  lastQuestion: "接口文档也同步更新。",
  memberName: "用户C",
  mine: false,
  source: "codex",
  turnCount: 18,
  lastActiveAt: "2026-10-20T06:32:00Z"
};

describe("collab service", () => {
  it("accepts a pasted link, the copied share text, or a bare session ID", () => {
    const id = cloudSession.id;
    expect(parseSessionReference(`https://memmy.example/s/${id}`)).toBe(id);
    expect(parseSessionReference(`【Memmy】重复分享返回 409 https://memmy.example/s/${id} 按这个处理`)).toBe(id);
    expect(parseSessionReference(id)).toBe(id);
    expect(parseSessionReference("https://memmy.example/projects/p-1")).toBeNull();
    expect(parseSessionReference("../../etc/passwd")).toBeNull();
  });

  it("adds the link and share text to listed sessions", async () => {
    const { fetcher, calls } = fakeFetch({
      "GET /api/collab/projects/p-1/sessions": () => ({ code: 0, data: { project: { id: "p-1", name: "Memmy 开发" }, sessions: [cloudSession] } })
    });
    const result = await service(fetcher).listSessions("p-1");
    expect(calls[0]?.headers.Authorization).toBe("Bearer uuid-b");
    expect(result.sessions[0]).toMatchObject({
      link: `https://cloud.test.invalid/s/${cloudSession.id}`,
      shareText: `【Memmy】重复分享返回 409 https://cloud.test.invalid/s/${cloudSession.id}`
    });
  });

  it("downloads a referenced session into the project cache and returns the text for the agent", async () => {
    const { fetcher } = fakeFetch({
      [`GET /api/collab/sessions/${cloudSession.id}`]: () => ({
        code: 0,
        data: { session: { ...cloudSession, turns: [{ question: "重复分享时接口返回 500，怎么处理？", reply: "改为返回 HTTP 409。", steps: ["Edit", "Bash", "Bash"], startedAt: "" }] } }
      })
    });
    const svc = service(fetcher);
    const reference = await svc.readSession(`【Memmy】重复分享返回 409 https://memmy.example/s/${cloudSession.id}`);

    expect(reference.path.endsWith(join("p-1", "sessions", `${cloudSession.id}.md`))).toBe(true);
    const markdown = readFileSync(reference.path, "utf8");
    expect(markdown).toContain("# 重复分享返回 409");
    expect(markdown).toContain("- 成员：用户C");
    expect(markdown).toContain("## 会话记录（共 18 轮，保留最近 1 轮）");
    expect(markdown).toContain("### 第 18 轮\n用户C：重复分享时接口返回 500，怎么处理？\n回复：改为返回 HTTP 409。\n执行步骤：Edit、Bash ×2");
    expect(reference.text).toContain("已引用用户C的会话「重复分享返回 409」（Memmy 开发，");
    expect(reference.text).toContain(`完整记录：${reference.path}`);
    expect(reference.text).toContain("回答与该会话相关的问题前，先读取此文件。");
  });

  it("covers a whole group except its excluded sessions, plus sessions linked on their own", () => {
    const candidates = [
      { sourceId: "claude_code", conversationId: "a1", groupId: "/repo" },
      { sourceId: "claude_code", conversationId: "a2", groupId: "/repo" },
      { sourceId: "claude_code", conversationId: "b1", groupId: "/other" },
      { sourceId: "codex", conversationId: "r1", groupId: "/repo" },
      { sourceId: "codex", conversationId: "c1", groupId: null }
    ];
    const keys = linkedSessionKeys({
      groups: [{ sourceId: "claude_code", groupId: "/repo", excluded: ["a2"] }],
      sessions: [{ sourceId: "codex", conversationId: "c1" }]
    }, candidates);

    expect([...keys].sort()).toEqual([
      sessionKey({ sourceId: "claude_code", conversationId: "a1" }),
      sessionKey({ sourceId: "codex", conversationId: "c1" })
    ].sort());
  });

  it("uploads an associated group, then its new and changed sessions on each sync", async () => {
    const local: LocalAgentSession[] = [
      localSession("claude_code", "a1", "/repo", "2026-10-22T01:00:00.000Z"),
      localSession("claude_code", "a2", "/repo", "2026-10-22T01:00:00.000Z"),
      localSession("claude_code", "b1", "/other", "2026-10-22T01:00:00.000Z"),
      localSession("codex", "c1", null, "2026-10-22T01:00:00.000Z")
    ];
    const { fetcher, calls } = linkFetch(local);
    const svc = service(fetcher);

    const saved = await svc.saveLinks("p-1", {
      groups: [{ sourceId: "claude_code", groupId: "/repo", excluded: ["a2"] }],
      sessions: [{ sourceId: "codex", conversationId: "c1" }]
    });
    // The selection is saved at once and the two sessions upload in the background.
    expect(saved).toEqual({ uploaded: 0, removed: 0, failed: 0, started: 2 });
    await waitForUploads(svc, "p-1");
    expect(uploadedIds(calls)).toEqual(["a1", "c1"]);
    expect(await svc.getLinks("p-1")).toEqual({
      groups: [{ sourceId: "claude_code", groupId: "/repo", excluded: ["a2"] }],
      sessions: [{ sourceId: "codex", conversationId: "c1" }]
    });

    calls.length = 0;
    local.push(localSession("claude_code", "a3", "/repo", "2026-10-22T02:00:00.000Z"));
    local[0] = localSession("claude_code", "a1", "/repo", "2026-10-22T02:30:00.000Z");
    expect(await svc.syncLinkedSessions()).toEqual({ uploaded: 2, removed: 0, failed: 0 });
    expect(uploadedIds(calls).sort()).toEqual(["a1", "a3"]);
    // A cached list is enough: forcing a rescan every minute re-walks every agent's history.
    expect(calls.find((call) => call.url.endsWith("/agent-sessions/available"))?.body).not.toMatchObject({ fresh: true });
  });

  it("re-uploads a session whose title changed, even when its turns did not", async () => {
    const local: LocalAgentSession[] = [
      { ...localSession("claude_code", "a1", "/repo", "2026-10-22T01:00:00.000Z"), title: "关于MemOS项目记忆这部分内容，算法这边提出了疑问" }
    ];
    // The upload rereads the session, so its title is the same one the listing reported.
    let readTitle = "关于MemOS项目记忆这部分内容，算法这边提出了疑问";
    const { fetcher, calls } = fakeFetch({
      "POST /api/v1/agent-sessions/available": () => ({ sessions: local, refreshing: false }),
      "POST /api/v1/agent-sessions/read": () => ({
        session: { title: readTitle, updatedAt: "2026-10-22T01:00:00.000Z", turns: [{ question: "问", reply: "答", steps: [], startedAt: "" }] }
      }),
      "PUT /api/collab/projects/p-1/sessions": (call) => {
        const upload = (call.body as { sessions: Array<{ sourceSessionId: string }> }).sessions[0]!;
        return { code: 0, data: { sessions: [{ id: `id-${upload.sourceSessionId}` }] } };
      }
    });
    const svc = service(fetcher);
    await svc.saveLinks("p-1", { groups: [{ sourceId: "claude_code", groupId: "/repo", excluded: [] }], sessions: [] });
    await waitForUploads(svc, "p-1");
    expect(uploadedIds(calls)).toEqual(["a1"]);

    // The agent finally names the conversation; nothing else about the session changed.
    calls.length = 0;
    readTitle = "Memmy项目协作记忆方案";
    local[0] = { ...local[0]!, title: "Memmy项目协作记忆方案" };
    expect(await svc.syncLinkedSessions()).toEqual({ uploaded: 1, removed: 0, failed: 0 });
    expect(uploadedIds(calls)).toEqual(["a1"]);
    expect(uploadedTitles(calls)).toEqual(["Memmy项目协作记忆方案"]);

    // Once the cloud has that title, the next sync has nothing left to do.
    calls.length = 0;
    expect(await svc.syncLinkedSessions()).toEqual({ uploaded: 0, removed: 0, failed: 0 });
    expect(uploadedIds(calls)).toEqual([]);
  });

  it("removes only what the person unchecked, and never uploads a deleted session again", async () => {
    const local: LocalAgentSession[] = [
      localSession("claude_code", "a1", "/repo", "2026-10-22T01:00:00.000Z"),
      localSession("codex", "c1", null, "2026-10-22T01:00:00.000Z")
    ];
    const { fetcher, calls } = linkFetch(local);
    const svc = service(fetcher);
    await svc.saveLinks("p-1", {
      groups: [{ sourceId: "claude_code", groupId: "/repo", excluded: [] }],
      sessions: [{ sourceId: "codex", conversationId: "c1" }]
    });
    // Unchecking a group can only remove what the earlier association already uploaded.
    await waitForUploads(svc, "p-1");

    calls.length = 0;
    expect(await svc.saveLinks("p-1", { groups: [], sessions: [{ sourceId: "codex", conversationId: "c1" }] }))
      .toEqual({ uploaded: 0, removed: 1, failed: 0 });
    expect(calls.filter((call) => call.method === "DELETE").map((call) => call.url)).toEqual(["https://cloud.test.invalid/api/collab/projects/p-1/sessions/id-a1"]);

    await svc.removeSession("p-1", "id-c1");
    calls.length = 0;
    local[1] = localSession("codex", "c1", null, "2026-10-22T05:00:00.000Z");
    expect(await svc.syncLinkedSessions()).toEqual({ uploaded: 0, removed: 0, failed: 0 });
    expect(uploadedIds(calls)).toEqual([]);
    expect(await svc.getLinks("p-1")).toEqual({ groups: [], sessions: [] });
  });

  it("pages a project's sessions ten at a time, counting every match", async () => {
    const list = Array.from({ length: 23 }, (_, index) => projectSession(`s-${index}`, index));
    const first = pageOf(list, { offset: 0, limit: 10 });
    expect(first.sessions).toHaveLength(10);
    expect(first.total).toBe(23);
    expect(pageOf(list, { offset: 20, limit: 10 }).sessions).toHaveLength(3);
    expect(pageOf(list, { offset: 30, limit: 10 }).sessions).toHaveLength(0);
  });

  it("matches any keyword against the title, the last question, or the member", () => {
    const list = [
      projectSession("s-1", 0, { title: "重复分享返回 409", lastQuestion: "提示怎么写", memberName: "用户C" }),
      projectSession("s-2", 1, { title: "知识库分享", lastQuestion: "重复分享的提示", memberName: "用户D" })
    ];
    expect(pageOf(list, { query: "409" }).sessions.map((session) => session.id)).toEqual(["s-1"]);
    expect(pageOf(list, { query: "重复分享" }).sessions).toHaveLength(2);
    expect(pageOf(list, { query: "用户D" }).sessions.map((session) => session.id)).toEqual(["s-2"]);
    expect(pageOf(list, { query: "无关" }).total).toBe(0);
  });

  it("keeps the member filter separate from the keyword", () => {
    const list = [
      projectSession("s-1", 0, { mine: true }),
      projectSession("s-2", 1, { mine: false })
    ];
    expect(pageOf(list, { member: "me" }).sessions.map((session) => session.id)).toEqual(["s-1"]);
    expect(pageOf(list, { member: "others" }).sessions.map((session) => session.id)).toEqual(["s-2"]);
    expect(pageOf(list, {}).total).toBe(2);
  });

  it("creates a cloud project with a managed working directory when none was chosen", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-collab-home-"));
    roots.push(root);
    const { fetcher, calls } = fakeFetch({
      "POST /api/collab/projects": () => ({ code: 0, data: { project: { id: "p-9", name: "Memmy 开发", role: "owner", memberCount: 1, sessionCount: 0, createdAt: null } } })
    });
    const svc = service(fetcher, { projectsDir: join(root, "projects") });

    const created = await svc.createProject("Memmy 开发");

    expect(created.project).toMatchObject({ id: "p-9", localProjectId: null });
    // The folder is named after the project: a task page and the project picker show this name, not an id.
    expect(created.localDirectory).toBe(join(root, "online-projects", "Memmy 开发"));
    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual(["POST /api/collab/projects"]);
  });

  it("keeps the project's own name in the managed folder, and disambiguates a duplicate", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-collab-home-"));
    roots.push(root);
    mkdirSync(join(root, "online-projects", "Memmy 开发"), { recursive: true });
    const { fetcher } = fakeFetch({
      "POST /api/collab/projects": () => ({ code: 0, data: { project: { id: "p-9abcdef1", name: "Memmy 开发", role: "owner", memberCount: 1, sessionCount: 0, createdAt: null } } })
    });
    const svc = service(fetcher, { projectsDir: join(root, "projects") });

    // Another project already owns the plain name, so this one gets a short id suffix instead of an id-only name.
    const created = await svc.createProject("Memmy 开发");
    expect(created.localDirectory).toBe(join(root, "online-projects", "Memmy 开发-p-9abcde"));
  });

  it("uses the folder the person picked and registers it as the local project", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-collab-home-"));
    roots.push(root);
    const chosen = mkdtempSync(join(tmpdir(), "memmy-collab-folder-"));
    roots.push(chosen);
    const { fetcher } = fakeFetch({
      "POST /api/collab/projects": () => ({ code: 0, data: { project: { id: "p-9", name: "Memmy 开发", role: "owner", memberCount: 1, sessionCount: 0, createdAt: null } } }),
      "GET /api/collab/projects": () => ({ code: 0, data: { projects: [{ id: "p-9", name: "Memmy 开发", role: "owner", memberCount: 1, sessionCount: 0, createdAt: null }] } })
    });
    const svc = service(fetcher, { projectsDir: join(root, "projects") });

    const created = await svc.createProject("Memmy 开发", chosen);
    expect(created.localDirectory).toBe(chosen);

    await svc.bindLocalProject("p-9", "local-9");
    expect((await svc.listProjects()).projects[0]).toMatchObject({ id: "p-9", localProjectId: "local-9" });
  });

  it("uploads the bound project's own Memmy tasks, which need no session link", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-collab-home-"));
    roots.push(root);
    const agentSessions = join(root, "workspace", "sessions");
    mkdirSync(agentSessions, { recursive: true });
    writeMemmyTask(agentSessions, "task-1", "local-9", "部署记录", [
      { role: "user", content: "帮我看下部署", timestamp: "2026-10-22T03:00:00.000Z" },
      { role: "tool", name: "read_file", timestamp: "2026-10-22T03:00:01.000Z" },
      { role: "assistant", content: "已确认可以部署。", timestamp: "2026-10-22T03:00:02.000Z" }
    ]);
    writeMemmyTask(agentSessions, "task-2", "local-other", "别的项目", [
      { role: "user", content: "别的项目的问题", timestamp: "2026-10-22T03:00:00.000Z" }
    ]);
    const { fetcher, calls } = fakeFetch({
      "GET /api/collab/projects": () => ({ code: 0, data: { projects: [{ id: "p-9", name: "Memmy 开发", role: "owner", memberCount: 1, sessionCount: 0, createdAt: null }] } }),
      "PUT /api/collab/projects/p-9/sessions": (call) => {
        const upload = (call.body as { sessions: Array<{ sourceSessionId: string }> }).sessions[0]!;
        return { code: 0, data: { sessions: [{ id: `id-${upload.sourceSessionId}` }] } };
      }
    });
    const svc = service(fetcher, { projectsDir: join(root, "projects"), agentSessionsDir: agentSessions });

    await svc.bindLocalProject("p-9", "local-9");
    calls.length = 0;
    expect(await svc.syncLinkedSessions()).toEqual({ uploaded: 1, removed: 0, failed: 0 });

    const upload = calls.find((call) => call.method === "PUT")!.body as { sessions: Array<{ source: string; title: string; turns: Array<{ question: string; reply: string; steps: string[] }> }> };
    expect(upload.sessions[0]).toMatchObject({ source: "memmy", title: "部署记录" });
    expect(upload.sessions[0]!.turns).toEqual([
      { question: "帮我看下部署", reply: "已确认可以部署。", steps: ["read_file"], startedAt: "2026-10-22T03:00:00.000Z" }
    ]);
  });

  it("syncs a board opening from Memmy tasks alone, without asking the Memory service", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-collab-home-"));
    roots.push(root);
    const agentSessions = join(root, "workspace", "sessions");
    mkdirSync(agentSessions, { recursive: true });
    writeMemmyTask(agentSessions, "task-9", "local-9", "只看任务", [
      { role: "user", content: "只同步任务", timestamp: "2026-10-22T04:00:00.000Z" },
      { role: "assistant", content: "好", timestamp: "2026-10-22T04:00:01.000Z" }
    ]);
    const { fetcher, calls } = fakeFetch({
      "GET /api/collab/projects": () => ({ code: 0, data: { projects: [{ id: "p-9", name: "Memmy 开发", role: "owner", memberCount: 1, sessionCount: 0, createdAt: null }] } }),
      "PUT /api/collab/projects/p-9/sessions": (call) => {
        const upload = (call.body as { sessions: Array<{ sourceSessionId: string }> }).sessions[0]!;
        return { code: 0, data: { sessions: [{ id: `id-${upload.sourceSessionId}` }] } };
      }
    });
    const svc = service(fetcher, { projectsDir: join(root, "projects"), agentSessionsDir: agentSessions });

    await svc.bindLocalProject("p-9", "local-9");
    calls.length = 0;
    expect(await svc.syncProjectTasks()).toEqual({ uploaded: 1, removed: 0, failed: 0 });
    expect(calls.some((call) => call.url.includes("/agent-sessions/"))).toBe(false);
  });

  it("saves the next selection without waiting for the upload already running", async () => {
    const local: LocalAgentSession[] = [
      localSession("claude_code", "a1", "/repo", "2026-10-22T01:00:00.000Z"),
      localSession("codex", "c1", null, "2026-10-22T01:00:00.000Z")
    ];
    // A slow upload of the first group must not hold up the second save.
    const routes = {
      "POST /api/v1/agent-sessions/available": () => ({ sessions: local, refreshing: false }),
      "POST /api/v1/agent-sessions/read": async (call: Call) => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        const body = call.body as { conversationId: string };
        return { session: { title: `会话 ${body.conversationId}`, updatedAt: "2026-10-22T01:00:00.000Z", turns: [] } };
      },
      "PUT /api/collab/projects/p-1/sessions": (call: Call) => {
        const upload = (call.body as { sessions: Array<{ sourceSessionId: string }> }).sessions[0]!;
        return { code: 0, data: { sessions: [{ id: `id-${upload.sourceSessionId}` }] } };
      }
    } as Record<string, (call: Call) => unknown>;
    const fetcher = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const key = `${init?.method ?? "GET"} ${new URL(url).pathname}`;
      const handler = routes[key];
      const call = { url, method: init?.method ?? "GET", headers: {}, body: init?.body ? JSON.parse(String(init.body)) : undefined };
      if (!handler) return new Response(JSON.stringify({ code: 404, message: "no route", data: null }), { status: 404 });
      return new Response(JSON.stringify(await handler(call)), { status: 200 });
    }) as typeof fetch;
    const svc = service(fetcher);

    await svc.saveLinks("p-1", { groups: [{ sourceId: "claude_code", groupId: "/repo", excluded: [] }], sessions: [] });
    // The first upload is still running; the second save returns straight away.
    const startedAt = Date.now();
    const second = await svc.saveLinks("p-1", {
      groups: [{ sourceId: "claude_code", groupId: "/repo", excluded: [] }],
      sessions: [{ sourceId: "codex", conversationId: "c1" }]
    });
    expect(Date.now() - startedAt).toBeLessThan(35);
    expect(second.removed).toBe(0);

    await waitForUploads(svc, "p-1");
    expect((await svc.getLinks("p-1")).sessions).toEqual([{ sourceId: "codex", conversationId: "c1" }]);
  });

  it("offers @ candidates from one project only, never across projects", async () => {
    const { fetcher, calls } = fakeFetch({
      "GET /api/collab/projects/p-1/sessions": () => ({
        code: 0,
        data: {
          project: { id: "p-1", name: "Memmy 开发", role: "owner", memberCount: 1, sessionCount: 2, createdAt: null },
          sessions: [
            { id: "s-1", projectId: "p-1", projectName: "Memmy 开发", title: "重复分享返回 409", memberName: "用户C", mine: false, lastActiveAt: "2026-10-22T05:00:00.000Z" },
            { id: "s-2", projectId: "p-1", projectName: "Memmy 开发", title: "知识库分享", memberName: "我", mine: true, lastActiveAt: "2026-10-22T04:00:00.000Z" }
          ],
          total: 2
        }
      })
    });
    const svc = service(fetcher);

    const candidates = await svc.candidateSessions("p-1", { limit: 5 });
    expect(candidates.sessions.map((session) => session.id)).toEqual(["s-1", "s-2"]);
    // Only the project's own sessions endpoint is read: there is no cross-project search.
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(["/api/collab/projects/p-1/sessions"]);
  });

  it("deletes the cloud project and keeps the local project usable", async () => {
    const local: LocalAgentSession[] = [localSession("claude_code", "a1", "/repo", "2026-10-22T01:00:00.000Z")];
    const deleted: string[] = [];
    const { fetcher } = fakeFetch({
      "POST /api/v1/agent-sessions/available": () => ({ sessions: local, refreshing: false }),
      "POST /api/v1/agent-sessions/read": () => ({ session: { title: "会话", updatedAt: "2026-10-22T01:00:00.000Z", turns: [] } }),
      "PUT /api/collab/projects/p-1/sessions": () => ({ code: 0, data: { sessions: [{ id: "id-a1" }] } }),
      "DELETE /api/collab/projects/p-1": () => {
        deleted.push("p-1");
        return { code: 0, data: { ok: true } };
      }
    });
    const svc = service(fetcher);
    await svc.saveLinks("p-1", { groups: [{ sourceId: "claude_code", groupId: "/repo", excluded: [] }], sessions: [] });
    await svc.bindLocalProject("p-1", "local-9");

    await svc.deleteProject("p-1");

    expect(deleted).toEqual(["p-1"]);
    // The binding is gone so the local project shows as a plain local project with its tasks.
    expect(await svc.getLinks("p-1")).toEqual({ groups: [], sessions: [] });
    expect((await svc.getSyncProgress("p-1")).running).toBe(false);
  });

  it("keeps each account's links apart on a shared computer", async () => {
    const local = [localSession("claude_code", "a1", "/repo", "2026-10-22T01:00:00.000Z")];
    const { fetcher } = linkFetch(local);
    const root = mkdtempSync(join(tmpdir(), "memmy-collab-"));
    roots.push(root);
    await service(fetcher, { projectsDir: root }).saveLinks("p-1", { groups: [], sessions: [{ sourceId: "claude_code", conversationId: "a1" }] });

    const other = service(fetcher, { projectsDir: root, getAccount: () => ({ accountId: "u-c", credential: "uuid-c" }) });
    expect(await other.getLinks("p-1")).toEqual({ groups: [], sessions: [] });
    expect(await other.syncLinkedSessions()).toEqual({ uploaded: 0, removed: 0, failed: 0 });
  });

  it("explains what to do when signed out, offline, or the link is not a session", async () => {
    const { fetcher } = fakeFetch({
      [`GET /api/collab/sessions/${cloudSession.id}`]: () => new Response(JSON.stringify({ code: 404, message: "项目或会话不存在，或你不是该项目的成员", data: null }), { status: 404 })
    });
    await expect(service(fetcher, { getAccount: () => null }).listProjects()).rejects.toMatchObject({ code: "unauthorized" });
    await expect(service(fetcher).readSession("https://memmy.example/docs")).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(service(fetcher).readSession(cloudSession.id)).rejects.toMatchObject({ code: "not_found", message: "项目或会话不存在，或你不是该项目的成员" });
    const offline = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    await expect(service(offline).listProjects()).rejects.toMatchObject({ message: "暂时无法连接 Memmy 云端，请稍后重试。" });
    await expect(service(fetcher, { memory: null }).listLocalSessions({})).rejects.toMatchObject({ message: "无法连接 Memmy，请打开 Memmy 后重试。" });
  });
});

function localSession(sourceId: string, conversationId: string, groupId: string | null, updatedAt: string): LocalAgentSession {
  return {
    sourceId,
    agentName: sourceId,
    conversationId,
    title: `会话 ${conversationId}`,
    lastQuestion: "",
    workspacePath: groupId,
    group: groupId ? { id: groupId, label: groupId, path: groupId } : null,
    updatedAt,
    turnCount: 1
  };
}

/** Memory lists `local`; the cloud accepts uploads as id-<conversation> and deletes any session. */
function linkFetch(local: LocalAgentSession[]) {
  const deleted = (call: Call) => (call.url.includes("/sessions/id-") ? { code: 0, data: null } : new Response("{}", { status: 404 }));
  return fakeFetch({
    "POST /api/v1/agent-sessions/available": () => ({ sessions: local, refreshing: false }),
    "POST /api/v1/agent-sessions/read": (call) => {
      const body = call.body as { conversationId: string };
      return { session: { title: `会话 ${body.conversationId}`, updatedAt: "2026-10-22T01:00:00.000Z", turns: [{ question: "问", reply: "答", steps: [], startedAt: "" }] } };
    },
    "PUT /api/collab/projects/p-1/sessions": (call) => {
      const upload = (call.body as { sessions: Array<{ sourceSessionId: string }> }).sessions[0]!;
      return { code: 0, data: { sessions: [{ id: `id-${upload.sourceSessionId}` }] } };
    },
    "DELETE /api/collab/projects/p-1/sessions/id-a1": deleted,
    "DELETE /api/collab/projects/p-1/sessions/id-c1": deleted
  });
}

function uploadedIds(calls: Call[]): string[] {
  return calls
    .filter((call) => call.method === "PUT")
    .map((call) => (call.body as { sessions: Array<{ sourceSessionId: string }> }).sessions[0]!.sourceSessionId);
}

function uploadedTitles(calls: Call[]): string[] {
  return calls
    .filter((call) => call.method === "PUT")
    .map((call) => (call.body as { sessions: Array<{ title: string }> }).sessions[0]!.title);
}

/** Writes a Memmy task session file: a metadata line first, then the records of each turn. */
function writeMemmyTask(
  directory: string,
  id: string,
  projectId: string,
  title: string,
  records: Array<Record<string, unknown>>
): void {
  const lines = [{
    recordType: "metadata",
    key: `websocket:${id}`,
    createdAt: "2026-10-22T03:00:00.000Z",
    updatedAt: "2026-10-22T03:00:02.000Z",
    metadata: { webui: true, webuiProjectId: projectId, webuiWorkspaceCwd: "/tmp/project", title }
  }, ...records];
  writeFileSync(join(directory, `websocket_${id}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
}

/** Waits until a queued association finishes uploading, so a test can assert what reached the cloud. */
async function waitForUploads(svc: ReturnType<typeof service>, projectId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const progress = await svc.getSyncProgress(projectId);
    if (!progress.running) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("upload did not finish");
}

/** A listed session, for the paging and search rules. */
function projectSession(
  id: string,
  index: number,
  overrides: Partial<{ title: string; lastQuestion: string; memberName: string; mine: boolean }> = {}
) {
  return {
    id,
    projectId: "p-1",
    projectName: "Memmy 开发",
    title: overrides.title ?? `会话 ${index}`,
    lastQuestion: overrides.lastQuestion ?? "",
    memberName: overrides.memberName ?? "用户C",
    mine: overrides.mine ?? false,
    source: "memmy",
    turnCount: 1,
    lastActiveAt: `2026-10-22T0${index % 10}:00:00.000Z`,
    link: `https://cloud.test.invalid/s/${id}`,
    shareText: `【Memmy】会话 ${index} https://cloud.test.invalid/s/${id}`
  };
}
