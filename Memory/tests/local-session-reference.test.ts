import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSourceRegistry } from "../src/agent-source/adapters/source-registry.js";
import type { ConversationMessage, SourceAdapter } from "../src/agent-source/adapters/types.js";
import { createLocalProjectStore, type LocalProjectStore } from "../src/agent-source/session-reference/local-project-store.js";
import { cleanQuestion, createLocalSessionReferenceService } from "../src/agent-source/session-reference/local-session-reference.js";
import { isSameWorkspace, matchScore, matchesQuery } from "../src/agent-source/session-reference/local-session-rank.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("local session candidates", () => {
  it("lists each session once with its first question as title and skips the asking conversation", async () => {
    const { service } = serviceWith([fakeAdapter("codex", "Codex", [
      message("codex", "c-1", "user", "分享弹窗重复分享时怎么提示？", "2026-10-20T08:00:00.000Z", "/repo"),
      message("codex", "c-1", "assistant", "返回 409 时提示「已分享给该成员」。", "2026-10-20T08:00:05.000Z", "/repo"),
      message("codex", "c-1", "user", "账号不存在呢？", "2026-10-20T08:05:00.000Z", "/repo"),
      message("codex", "c-asking", "user", "/memmy-ref 分享", "2026-10-20T09:00:00.000Z", "/repo"),
      message("codex", "c-no-question", "system", "boot", "2026-10-20T07:00:00.000Z", "/repo")
    ])]);

    const sessions = await service.available({ excludeConversationIds: ["c-asking"] });

    expect(sessions).toEqual([{
      sourceId: "codex",
      agentName: "Codex",
      conversationId: "c-1",
      title: "分享弹窗重复分享时怎么提示？",
      lastQuestion: "账号不存在呢？",
      workspacePath: "/repo",
      updatedAt: "2026-10-20T08:05:00.000Z",
      turnCount: 2
    }]);
  });

  it("renders the referenced session into a Markdown file outside any project", async () => {
    const cacheDir = tempRoot();
    const { service, store } = serviceWith([fakeAdapter("claude_code", "Claude Code", [
      message("claude_code", "s-1", "user", "修复权限弹窗卡死", "2026-10-21T07:00:00.000Z", "/repo"),
      message("claude_code", "s-1", "tool", "Tool: Bash\n\nInput: ls", "2026-10-21T07:00:01.000Z", "/repo", { toolName: "Bash" }),
      message("claude_code", "s-1", "tool", "Tool: Bash\n\nInput: git status", "2026-10-21T07:00:02.000Z", "/repo", { toolName: "Bash" }),
      message("claude_code", "s-1", "tool", "Tool: Edit\n\nInput: {}", "2026-10-21T07:00:03.000Z", "/repo"),
      message("claude_code", "s-1", "assistant", "检测请求加了超时，检测中可以关闭弹窗。", "2026-10-21T07:00:04.000Z", "/repo")
    ])], { cacheDir, now: () => Date.parse("2026-10-21T08:00:00.000Z") });
    await associate(store, "/repo", [{ sourceId: "claude_code", conversationId: "s-1" }]);

    const reference = await service.reference({ sourceId: "claude_code", conversationId: "s-1" });

    expect(reference.path).toBe(join(cacheDir, "claude_code-s-1.md"));
    expect(readFileSync(reference.path, "utf8")).toBe(reference.markdown);
    expect(reference.markdown).toContain("# 修复权限弹窗卡死");
    expect(reference.markdown).toContain("- Agent：Claude Code");
    expect(reference.markdown).toContain("- 工作目录：/repo");
    expect(reference.markdown).toContain("## 会话记录（共 1 轮）");
    expect(reference.markdown).toContain("提问：修复权限弹窗卡死\n回复：检测请求加了超时，检测中可以关闭弹窗。\n执行步骤：Bash ×2、Edit");
  });

  it("keeps listing other agents when one source fails", async () => {
    const broken: SourceAdapter = {
      descriptor: { sourceId: "cursor", displayName: "Cursor", builtin: true, dataPath: "/missing" },
      detect: async () => true,
      scan: async function* () {
        throw new Error("native module mismatch");
      }
    };
    const { service } = serviceWith([
      broken,
      fakeAdapter("workbuddy", "WorkBuddy", [message("workbuddy", "w-1", "user", "sitemap 是什么", "2026-10-21T03:00:00.000Z", null)])
    ]);

    expect((await service.available({})).map((session) => session.conversationId)).toEqual(["w-1"]);
  });

  it("ranks sessions from the asking directory first, then the most recent", async () => {
    const { service } = serviceWith([
      fakeAdapter("cursor", "Cursor", [message("cursor", "old-other", "user", "旧会话", "2026-07-08T00:00:00.000Z", "/elsewhere")]),
      fakeAdapter("codex", "Codex", [
        message("codex", "new-other", "user", "别的仓库", "2026-10-21T10:00:00.000Z", "/elsewhere"),
        message("codex", "old-here", "user", "同仓库旧会话", "2026-10-19T10:00:00.000Z", "/repo/App")
      ]),
      fakeAdapter("claude_code", "Claude Code", [message("claude_code", "new-here", "user", "同仓库新会话", "2026-10-21T09:00:00.000Z", "/repo")])
    ]);

    expect((await service.available({ cwd: "/repo" })).map((session) => session.conversationId))
      .toEqual(["new-here", "old-here", "new-other", "old-other"]);
    expect((await service.available({ cwd: null })).map((session) => session.conversationId))
      .toEqual(["new-other", "new-here", "old-here", "old-other"]);
    expect((await service.available({ cwd: "/repo", query: "旧" })).map((session) => session.conversationId))
      .toEqual(["old-here", "old-other"]);
    expect((await service.available({ cwd: "/repo", sourceIds: ["codex"] })).map((session) => session.conversationId))
      .toEqual(["old-here", "new-other"]);
  });

  it("drops injected memory context from the questions it shows", async () => {
    const { service } = serviceWith([fakeAdapter("cursor", "Cursor", [
      message("cursor", "c-1", "user", "<system_reminder>\n<memos_memory_context>旧记忆</memos_memory_context>\n</system_reminder>\n提交推送", "2026-07-08T00:00:00.000Z", "/repo")
    ])]);

    expect((await service.available({}))[0]).toMatchObject({ title: "提交推送", lastQuestion: "提交推送" });
  });

  it("reuses the session snapshot within its time to live", async () => {
    let clock = 0;
    const adapter = fakeAdapter("codex", "Codex", [message("codex", "c-1", "user", "hi", "2026-10-20T08:00:00.000Z", null)]);
    const scan = vi.spyOn(adapter, "scan");
    const { service } = serviceWith([adapter], { snapshotTtlMs: 1_000, now: () => clock });

    await service.available({});
    clock = 500;
    await service.available({});
    expect(scan).toHaveBeenCalledTimes(1);
    clock = 1_500;
    await service.available({});
    expect(scan).toHaveBeenCalledTimes(2);
  });
});

describe("associated sessions only", () => {
  const adapter = () => fakeAdapter("codex", "Codex", [
    message("codex", "c-1", "user", "分享弹窗重复分享时怎么提示？", "2026-10-20T08:00:00.000Z", "/repo"),
    message("codex", "c-2", "user", "另一个会话", "2026-10-19T08:00:00.000Z", "/repo")
  ]);

  it("offers only sessions associated with the project containing the asking directory", async () => {
    const { service, store } = serviceWith([adapter()]);
    await associate(store, "/repo", [{ sourceId: "codex", conversationId: "c-1", title: "分享弹窗", lastQuestion: "分享弹窗重复分享时怎么提示？" }]);

    const result = await service.search({ cwd: "/repo" });

    expect(result.project).toMatchObject({ name: "Repo", rootPath: "/repo" });
    expect(result.sessions.map((session) => session.conversationId)).toEqual(["c-1"]);
  });

  it("does not offer a local session that was never associated", async () => {
    const { service } = serviceWith([adapter()]);

    const result = await service.search({ cwd: "/repo" });

    expect(result.sessions).toEqual([]);
    expect(result.reason).toBe("no_project");
  });

  it("reports an empty association separately from a directory outside every project", async () => {
    const { service, store } = serviceWith([adapter()]);
    await store.createOrUpdate({ name: "Repo", rootPath: "/repo" });

    const empty = await service.search({ cwd: "/repo" });
    const outside = await service.search({ cwd: "/elsewhere" });

    expect(empty.sessions).toEqual([]);
    expect(empty.reason).toBe("no_association");
    expect(outside.project).toBeNull();
    expect(outside.reason).toBe("no_project");
  });

  it("separates a keyword miss from an empty project", async () => {
    const { service, store } = serviceWith([adapter()]);
    await associate(store, "/repo", [{ sourceId: "codex", conversationId: "c-1", title: "分享弹窗", lastQuestion: "分享弹窗重复分享时怎么提示？" }]);

    const missed = await service.search({ cwd: "/repo", query: "登录 部署" });

    expect(missed.sessions).toEqual([]);
    expect(missed.reason).toBe("no_match");
  });

  it("matches the deepest project when projects are nested", async () => {
    const { service, store } = serviceWith([adapter()]);
    const outer = await store.createOrUpdate({ name: "Outer", rootPath: "/repo" });
    await store.addSessions(outer.id, [{ sourceId: "codex", conversationId: "c-2", title: "外层会话" }]);
    const inner = await store.createOrUpdate({ name: "Inner", rootPath: "/repo/App" });
    await store.addSessions(inner.id, [{ sourceId: "codex", conversationId: "c-1", title: "内层会话" }]);

    const result = await service.search({ cwd: "/repo/App" });

    expect(result.project).toMatchObject({ name: "Inner" });
    expect(result.sessions.map((session) => session.conversationId)).toEqual(["c-1"]);
  });

  it("refuses to reference a session outside the project", async () => {
    const { service, store } = serviceWith([adapter()]);
    await associate(store, "/repo", [{ sourceId: "codex", conversationId: "c-1" }]);

    await expect(service.reference({ sourceId: "codex", conversationId: "c-2" }))
      .rejects.toThrow("not associated with a local project");
    await expect(service.reference({ sourceId: "unknown", conversationId: "x" }))
      .rejects.toThrow("Unknown agent source");
  });

  it("refreshes the association snapshot when the session is read", async () => {
    const { service, store } = serviceWith([adapter()]);
    const project = await associate(store, "/repo", [{ sourceId: "codex", conversationId: "c-1", title: "旧标题" }]);

    await service.reference({ sourceId: "codex", conversationId: "c-1" });

    expect((await store.get(project.id))?.sessions[0]).toMatchObject({
      title: "分享弹窗重复分享时怎么提示？",
      updatedAt: "2026-10-20T08:00:00.000Z",
      turnCount: 1
    });
  });
});

describe("local project store", () => {
  it("persists associations and keeps one entry per session", async () => {
    const filePath = join(tempRoot(), "local-projects.json");
    const store = createLocalProjectStore({ filePath, now: () => "2026-10-21T00:00:00.000Z" });
    const project = await store.createOrUpdate({ name: "Repo", rootPath: "/repo/" });

    await store.addSessions(project.id, [{ sourceId: "codex", conversationId: "c-1", title: "一" }]);
    await store.addSessions(project.id, [{ sourceId: "codex", conversationId: "c-1", title: "二" }]);

    const reopened = createLocalProjectStore({ filePath });
    const [saved] = await reopened.list();
    expect(saved?.rootPath).toBe("/repo");
    expect(saved?.sessions).toHaveLength(1);
    expect(saved?.sessions[0]?.title).toBe("二");
  });

  it("removes associations and whole projects", async () => {
    const store = createLocalProjectStore({ filePath: join(tempRoot(), "local-projects.json") });
    const project = await store.createOrUpdate({ name: "Repo", rootPath: "/repo" });
    await store.addSessions(project.id, [
      { sourceId: "codex", conversationId: "c-1" },
      { sourceId: "cursor", conversationId: "c-2" }
    ]);

    const remaining = await store.removeSessions(project.id, [{ sourceId: "codex", conversationId: "c-1" }]);
    expect(remaining.sessions.map((session) => session.conversationId)).toEqual(["c-2"]);

    await store.remove(project.id);
    expect(await store.list()).toEqual([]);
  });

  it("matches a directory by prefix without matching a sibling with the same prefix", async () => {
    const store = createLocalProjectStore({ filePath: join(tempRoot(), "local-projects.json") });
    await store.createOrUpdate({ name: "Repo", rootPath: "/repo" });

    expect((await store.findByPath("/repo/App"))?.name).toBe("Repo");
    expect(await store.findByPath("/repo-other")).toBeNull();
    expect(await store.findByPath("")).toBeNull();
  });
});

describe("session titles", () => {
  it("strips injected context so the title is what the person actually asked", () => {
    expect(cleanQuestion("# Files mentioned by the user: ## a.png\n\n请把这张图里的登录页改一下"))
      .toBe("请把这张图里的登录页改一下");
    expect(cleanQuestion("# AGENTS.md instructions for /repo\n\n修一下浮窗的卡顿"))
      .toBe("修一下浮窗的卡顿");
    expect(cleanQuestion("<environment_context><cwd>/repo</cwd></environment_context>\n排查弹窗卡死"))
      .toBe("排查弹窗卡死");
  });

  it("keeps only the automation name for scheduled sessions", () => {
    expect(cleanQuestion("Automation: MemOS 社区周报 Automation ID: memos Automation memory: $CODEX_HOME/x"))
      .toBe("MemOS 社区周报");
  });

  it("returns nothing for a message that is only injected content", () => {
    expect(cleanQuestion("<recommended_plugins> a, b </recommended_plugins>")).toBe("");
  });

  it("falls back to the folder and date when no usable question exists", async () => {
    const { service } = serviceWith([fakeAdapter("codex", "Codex", [
      message("codex", "c-1", "user", "<recommended_plugins> a </recommended_plugins>", "2026-10-21T10:00:00.000Z", "/repo/Memmy")
    ])]);

    const [session] = await service.available({});

    expect(session?.title).toContain("Memmy");
    expect(session?.title).not.toContain("recommended_plugins");
  });

  it("skips a bare link so the next question becomes the title", async () => {
    const { service } = serviceWith([fakeAdapter("codex", "Codex", [
      message("codex", "c-1", "user", "https://github.com/x/y/issues/1", "2026-10-21T09:00:00.000Z", "/repo"),
      message("codex", "c-1", "user", "这个 issue 里的崩溃怎么修", "2026-10-21T10:00:00.000Z", "/repo")
    ])]);

    const [session] = await service.available({});

    expect(session?.title).toBe("这个 issue 里的崩溃怎么修");
  });
});

describe("local session ranking helpers", () => {
  const session = {
    sourceId: "codex",
    agentName: "Codex",
    conversationId: "c-1",
    title: "分享弹窗重复分享提示",
    lastQuestion: "账号不存在呢？",
    workspacePath: "/Users/a/memmy-agent/App",
    updatedAt: "2026-10-20T08:05:00.000Z",
    turns: [{ question: "分享弹窗重复分享提示", reply: "", steps: [], startedAt: "" }, { question: "账号不存在呢？", reply: "", steps: [], startedAt: "" }]
  };

  it("scores how many keywords match the title, questions and agent name", () => {
    expect(matchScore(session, "")).toBe(1);
    expect(matchScore(session, "分享 账号")).toBe(2);
    expect(matchScore(session, "codex 弹窗")).toBe(2);
    // One hit is enough to stay a candidate, so a long pasted title still finds its session.
    expect(matchScore(session, "分享 登录")).toBe(1);
    expect(matchesQuery(session, "分享 登录")).toBe(true);
    expect(matchesQuery(session, "登录 部署")).toBe(false);
  });

  it("treats a session inside the asking directory as the same workspace", () => {
    expect(isSameWorkspace(session, "/Users/a/memmy-agent")).toBe(true);
    expect(isSameWorkspace(session, "/Users/a/memmy-agent/")).toBe(true);
    expect(isSameWorkspace(session, "/Users/a/memmy")).toBe(false);
    expect(isSameWorkspace(session, null)).toBe(false);
  });
});

type ServiceOptions = {
  cacheDir?: string;
  snapshotTtlMs?: number;
  now?: () => number;
};

/** Builds the reference service with a throwaway association store. */
function serviceWith(adapters: SourceAdapter[], options: ServiceOptions = {}) {
  const store = createLocalProjectStore({ filePath: join(tempRoot(), "local-projects.json") });
  const service = createLocalSessionReferenceService({
    registry: createSourceRegistry(adapters),
    projects: store,
    cacheDir: options.cacheDir ?? tempRoot(),
    ...(options.snapshotTtlMs === undefined ? {} : { snapshotTtlMs: options.snapshotTtlMs }),
    ...(options.now === undefined ? {} : { now: options.now })
  });
  return { service, store };
}

/** Associates sessions with a project rooted at `rootPath`, creating it when needed. */
async function associate(
  store: LocalProjectStore,
  rootPath: string,
  sessions: Array<Record<string, unknown> & { sourceId: string; conversationId: string }>
) {
  const project = await store.createOrUpdate({ name: "Repo", rootPath });
  await store.addSessions(project.id, sessions);
  return project;
}

function fakeAdapter(sourceId: string, displayName: string, messages: ConversationMessage[]): SourceAdapter {
  return {
    descriptor: { sourceId, displayName, builtin: true, dataPath: `/fake/${sourceId}` },
    detect: async () => true,
    scan: async function* () {
      yield* messages;
    }
  };
}

function message(
  sourceId: string,
  conversationId: string,
  role: ConversationMessage["role"],
  content: string,
  createdAt: string,
  workspacePath: string | null,
  rawMeta: Record<string, unknown> = {}
): ConversationMessage {
  return { messageId: `${conversationId}:${createdAt}`, sourceId, conversationId, role, content, createdAt, workspacePath, gitRoot: null, rawMeta };
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "memmy-session-ref-"));
  roots.push(root);
  return root;
}
