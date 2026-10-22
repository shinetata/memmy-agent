import { describe, expect, it } from "vitest";
import { createSourceRegistry } from "../src/agent-source/adapters/source-registry.js";
import type { ConversationMessage, SourceAdapter } from "../src/agent-source/adapters/types.js";
import { cleanQuestion, createLocalSessionReader } from "../src/agent-source/session-reference/local-session-reader.js";

describe("local session reader", () => {
  it("lists each session once with its first question as title", async () => {
    const reader = readerWith([fakeAdapter("codex", "Codex", [
      message("codex", "c-1", "user", "分享弹窗重复分享时怎么提示？", "2026-10-20T08:00:00.000Z", "/repo"),
      message("codex", "c-1", "assistant", "返回 409 时提示「已分享给该成员」。", "2026-10-20T08:00:05.000Z", "/repo"),
      message("codex", "c-1", "user", "账号不存在呢？", "2026-10-20T08:05:00.000Z", "/repo"),
      message("codex", "c-no-question", "system", "boot", "2026-10-20T07:00:00.000Z", "/repo")
    ])]);

    expect((await reader.available({})).sessions).toEqual([{
      sourceId: "codex",
      agentName: "Codex",
      conversationId: "c-1",
      title: "分享弹窗重复分享时怎么提示？",
      lastQuestion: "账号不存在呢？",
      workspacePath: "/repo",
      group: { id: "/repo", label: "repo", path: "/repo" },
      updatedAt: "2026-10-20T08:05:00.000Z",
      turnCount: 2
    }]);
  });

  it("ranks keyword hits, then the given directory, then the most recent, and filters by agent", async () => {
    const reader = readerWith([
      fakeAdapter("codex", "Codex", [
        message("codex", "new-other", "user", "别的仓库的分享", "2026-10-21T10:00:00.000Z", "/elsewhere"),
        message("codex", "old-here", "user", "同仓库旧会话", "2026-10-19T10:00:00.000Z", "/repo/App")
      ]),
      fakeAdapter("claude_code", "Claude Code", [message("claude_code", "new-here", "user", "同仓库新会话", "2026-10-21T09:00:00.000Z", "/repo")])
    ]);

    expect((await reader.available({ cwd: "/repo" })).sessions.map((session) => session.conversationId))
      .toEqual(["new-here", "old-here", "new-other"]);
    expect((await reader.available({ query: "分享" })).sessions.map((session) => session.conversationId)).toEqual(["new-other"]);
    expect((await reader.available({ sourceIds: ["claude_code"] })).sessions.map((session) => session.conversationId)).toEqual(["new-here"]);
  });

  it("keeps listing other agents when one source fails", async () => {
    const broken: SourceAdapter = {
      descriptor: { sourceId: "cursor", displayName: "Cursor", builtin: true, dataPath: "/missing" },
      detect: async () => true,
      scan: async function* () {
        throw new Error("native module mismatch");
      }
    };
    const reader = readerWith([
      broken,
      fakeAdapter("workbuddy", "WorkBuddy", [message("workbuddy", "w-1", "user", "sitemap 是什么", "2026-10-21T03:00:00.000Z", null)])
    ]);

    expect((await reader.available({})).sessions.map((session) => session.conversationId)).toEqual(["w-1"]);
  });

  it("answers from the last scan at once while a newer scan runs, and waits only when asked for fresh", async () => {
    const messages = [message("codex", "c-1", "user", "第一个会话", "2026-10-21T08:00:00.000Z", "/repo")];
    let clock = 0;
    const reader = createLocalSessionReader({
      registry: createSourceRegistry([fakeAdapter("codex", "Codex", messages)]),
      snapshotTtlMs: 15_000,
      now: () => clock
    });

    expect(await reader.available({})).toMatchObject({ refreshing: false, sessions: [{ conversationId: "c-1" }] });
    messages.push(message("codex", "c-2", "user", "新会话", "2026-10-21T09:00:00.000Z", "/repo"));
    expect((await reader.available({})).sessions).toHaveLength(1);

    clock = 20_000;
    const stale = await reader.available({});
    expect(stale.refreshing).toBe(true);
    expect(stale.sessions).toHaveLength(1);
    const fresh = await reader.available({ fresh: true });
    expect(fresh.refreshing).toBe(false);
    expect(fresh.sessions.map((session) => session.conversationId)).toEqual(["c-2", "c-1"]);
  });

  it("reads one session's turns with replies and tool steps, without injected context", async () => {
    const reader = readerWith([fakeAdapter("claude_code", "Claude Code", [
      message("claude_code", "s-1", "user", "<memmy_memory_context>旧记忆</memmy_memory_context>修复权限弹窗卡死", "2026-10-21T07:00:00.000Z", "/repo"),
      message("claude_code", "s-1", "tool", "Tool: Bash\n\nInput: ls", "2026-10-21T07:00:01.000Z", "/repo", { toolName: "Bash" }),
      message("claude_code", "s-1", "tool", "Tool: Edit\n\nInput: {}", "2026-10-21T07:00:03.000Z", "/repo"),
      message("claude_code", "s-1", "assistant", "检测请求加了超时。", "2026-10-21T07:00:04.000Z", "/repo"),
      message("claude_code", "s-2", "user", "别的会话", "2026-10-21T08:00:00.000Z", "/repo")
    ])]);

    const session = await reader.read({ sourceId: "claude_code", conversationId: "s-1" });

    expect(session.title).toBe("修复权限弹窗卡死");
    expect(session.turns).toEqual([{
      question: "修复权限弹窗卡死",
      reply: "检测请求加了超时。",
      steps: ["Bash", "Edit"],
      startedAt: "2026-10-21T07:00:00.000Z"
    }]);
    await expect(reader.read({ sourceId: "claude_code", conversationId: "missing" })).rejects.toThrow(/Session not found/u);
    await expect(reader.read({ sourceId: "nope", conversationId: "s-1" })).rejects.toThrow(/Unknown agent source/u);
  });

  it("strips host-injected blocks and automation ids from titles", () => {
    expect(cleanQuestion("<environment_context>cwd</environment_context>帮我拉起服务")).toBe("帮我拉起服务");
    expect(cleanQuestion("Automation: MemOS 社区周报 Automation ID: abc")).toBe("MemOS 社区周报");
  });
});

function readerWith(adapters: SourceAdapter[]) {
  return createLocalSessionReader({ registry: createSourceRegistry(adapters), snapshotTtlMs: 0 });
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
