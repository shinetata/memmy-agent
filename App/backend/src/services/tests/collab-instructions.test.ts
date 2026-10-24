/** 协作项目的项目指令：云端读写与同步到本机，项目里的任务据此注入。 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCollabService } from "../collab-service.js";
import { createProjectInstructionsService } from "../project-instructions-service.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Call {
  method: string;
  path: string;
  body: unknown;
}

const project = {
  id: "p-1",
  name: "Memmy 开发",
  role: "ADMIN",
  memberCount: 2,
  sessionCount: 0,
  createdAt: null,
  instructions: "本项目负责 Memmy 桌面端的研发。"
};

/** Answers cloud requests from a route table keyed by "METHOD /path", and records each call. */
function cloud(routes: Record<string, (call: Call) => unknown>) {
  const calls: Call[] = [];
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      path: new URL(String(input)).pathname,
      body: init?.body ? JSON.parse(String(init.body)) : undefined
    };
    calls.push(call);
    const handler = routes[`${call.method} ${call.path}`];
    if (!handler) return new Response(JSON.stringify({ code: 404, message: "no route", data: null }), { status: 404 });
    return new Response(JSON.stringify({ code: 0, message: "ok", data: await handler(call) }), { status: 200 });
  }) as typeof fetch;
  return { fetcher, calls };
}

function setup(routes: Record<string, (call: Call) => unknown>) {
  const root = mkdtempSync(join(tmpdir(), "memmy-collab-instructions-"));
  roots.push(root);
  const { fetcher, calls } = cloud(routes);
  const projectsDir = join(root, "projects");
  const projectInstructions = createProjectInstructionsService({ filePath: join(root, "project-instructions.json") });
  const svc = createCollabService({
    cloudBaseUrl: "https://cloud.test.invalid",
    getAccount: () => ({ accountId: "u-a", credential: "uuid-a" }),
    localSessions: null,
    projectsDir,
    agentSessionsDir: join(root, "sessions"),
    projectInstructions,
    fetcher,
    now: () => new Date("2026-10-24T12:00:00.000Z")
  });
  return { svc, calls, projectInstructions, projectsDir };
}

/** The directory this computer's tasks for the project run in, as createProject records it. */
async function boundProject(svc: ReturnType<typeof setup>["svc"], projectId: string) {
  const created = await svc.createProject(project.name);
  await svc.bindLocalProject(projectId, "local-1");
  return created.localDirectory;
}

describe("collab project instructions", () => {
  it("carries the instructions in the project view", async () => {
    const { svc } = setup({
      "GET /api/collab/projects": () => ({ projects: [project] })
    });
    const listed = await svc.listProjects();
    expect(listed.projects[0]).toMatchObject({ id: "p-1", instructions: "本项目负责 Memmy 桌面端的研发。" });
  });

  it("mirrors the cloud instructions to the folder this computer's tasks run in", async () => {
    const { svc, projectInstructions } = setup({
      "POST /api/collab/projects": () => ({ project }),
      "PUT /api/collab/projects/p-1/binding": () => ({ ok: true }),
      "GET /api/collab/projects": () => ({ projects: [project] })
    });
    const directory = await boundProject(svc, "p-1");
    // 每次启动都会读项目列表：成员就是这样拿到所有者改过的指令的。
    await svc.listProjects();
    await expect(projectInstructions.read(directory)).resolves.toMatchObject({
      text: "本项目负责 Memmy 桌面端的研发。",
      origin: "cloud",
      cloudProjectId: "p-1"
    });
  });

  it("saves through the cloud and keeps this computer's copy in step", async () => {
    const next = { ...project, instructions: "前端代码遵循《前端代码规范》。" };
    const { svc, calls, projectInstructions } = setup({
      "POST /api/collab/projects": () => ({ project: { ...project, instructions: "" } }),
      "PUT /api/collab/projects/p-1/binding": () => ({ ok: true }),
      "PATCH /api/collab/projects/p-1": () => ({ project: next, instructions: next.instructions })
    });
    const directory = await boundProject(svc, "p-1");

    const saved = await svc.updateInstructions("p-1", "  前端代码遵循《前端代码规范》。  ", directory);
    expect(calls.at(-1)).toMatchObject({ method: "PATCH", body: { instructions: "前端代码遵循《前端代码规范》。" } });
    expect(saved.project.instructions).toBe("前端代码遵循《前端代码规范》。");
    await expect(projectInstructions.read(directory)).resolves.toMatchObject({ text: "前端代码遵循《前端代码规范》。", origin: "cloud" });

    // 清空指令：云端与这份副本都清掉，任务不再带上已经删掉的内容。
    const cleared = setup({
      "POST /api/collab/projects": () => ({ project }),
      "PUT /api/collab/projects/p-1/binding": () => ({ ok: true }),
      "PATCH /api/collab/projects/p-1": () => ({ project: { ...project, instructions: "" }, instructions: "" })
    });
    const clearedDirectory = await boundProject(cleared.svc, "p-1");
    await cleared.svc.updateInstructions("p-1", " ", clearedDirectory);
    await expect(cleared.projectInstructions.read(clearedDirectory)).resolves.toMatchObject({ text: "" });
  });

  it("rejects instructions over the limit before calling the cloud", async () => {
    const { svc, calls } = setup({
      "POST /api/collab/projects": () => ({ project }),
      "PUT /api/collab/projects/p-1/binding": () => ({ ok: true })
    });
    await boundProject(svc, "p-1");
    await expect(svc.updateInstructions("p-1", "字".repeat(2_001)))
      .rejects.toThrow("不超过 2000 字");
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);
  });

  it("keeps the instructions as local ones when the cloud project is gone", async () => {
    const { svc, projectInstructions } = setup({
      "POST /api/collab/projects": () => ({ project }),
      "PUT /api/collab/projects/p-1/binding": () => ({ ok: true }),
      "DELETE /api/collab/projects/p-1": () => ({ ok: true })
    });
    const directory = await boundProject(svc, "p-1");
    await svc.listProjects().catch(() => undefined);
    await projectInstructions.mirrorCloud(directory, project.instructions, "p-1");

    await svc.deleteProject("p-1");
    // 停止共享后本项目仍在本机，所有者写的指令继续生效，不会跟着云端记录一起消失。
    await expect(projectInstructions.read(directory)).resolves.toMatchObject({
      text: "本项目负责 Memmy 桌面端的研发。",
      origin: "local",
      cloudProjectId: null
    });
    expect(readFileSync(join(roots.at(-1)!, "project-instructions.json"), "utf8")).toContain("Memmy 桌面端的研发");
  });
});
