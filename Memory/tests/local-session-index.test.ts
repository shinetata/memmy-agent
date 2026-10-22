import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSourceRegistry } from "../src/agent-source/adapters/source-registry.js";
import type { ConversationMessage, SourceAdapter } from "../src/agent-source/adapters/types.js";
import { createLocalSessionIndex } from "../src/agent-source/session-reference/local-session-index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("local session index", () => {
  it("indexes only the most recent sessions per agent by default", async () => {
    const { index } = build({
      adapter: fakeAdapter("codex", "Codex", [
        message("codex", "c-1", "user", "最近的会话", "2026-10-21T10:00:00.000Z", "/repo"),
        message("codex", "c-2", "user", "次新的会话", "2026-10-20T10:00:00.000Z", "/repo"),
        message("codex", "c-3", "user", "更早的会话", "2026-10-19T10:00:00.000Z", "/repo")
      ]),
      perAgent: 2
    });

    await index.refreshRecent();
    const result = await index.search({ limit: 10 });

    expect(result.sessions.map((session) => session.conversationId)).toEqual(["c-1", "c-2"]);
    expect(result.status.sessions).toBe(2);
  });

  it("answers from the index without rescanning, then picks up new sessions on refresh", async () => {
    const messages: ConversationMessage[] = [
      message("codex", "c-1", "user", "第一个会话", "2026-10-21T10:00:00.000Z", "/repo")
    ];
    const adapter = fakeAdapter("codex", "Codex", messages);
    const { index } = build({ adapter });
    await index.refreshRecent();

    messages.push(message("codex", "c-2", "user", "新增的会话", "2026-10-21T11:00:00.000Z", "/repo"));
    const before = await index.search({});
    expect(before.sessions.map((session) => session.conversationId)).toEqual(["c-1"]);

    await index.refreshRecent();
    const after = await index.search({});
    expect(after.sessions.map((session) => session.conversationId)).toEqual(["c-2", "c-1"]);
  });

  it("filters by keyword and prefers sessions from the asking directory", async () => {
    const { index } = build({
      adapter: fakeAdapter("workbuddy", "WorkBuddy", [
        message("workbuddy", "w-1", "user", "修复弹窗卡死", "2026-10-21T10:00:00.000Z", "/repo"),
        message("workbuddy", "w-2", "user", "整理周报", "2026-10-21T12:00:00.000Z", "/elsewhere")
      ]),
      perAgent: 10
    });
    await index.refreshRecent();

    expect((await index.search({ query: "弹窗" })).sessions.map((s) => s.conversationId)).toEqual(["w-1"]);
    // 同目录的会话优先，即使它更旧
    expect((await index.search({ cwd: "/repo" })).sessions.map((s) => s.conversationId)).toEqual(["w-1", "w-2"]);
  });

  it("expands to the whole history when a full index is requested", async () => {
    const { index } = build({
      adapter: fakeAdapter("codex", "Codex", [
        message("codex", "c-1", "user", "最近的", "2026-10-21T10:00:00.000Z", "/repo"),
        message("codex", "c-2", "user", "较早的", "2026-09-01T10:00:00.000Z", "/repo")
      ]),
      perAgent: 1
    });
    await index.refreshRecent();
    expect((await index.search({ limit: 10 })).sessions).toHaveLength(1);

    index.startFullIndex();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const result = await index.search({ limit: 10 });

    expect(result.sessions.map((session) => session.conversationId)).toEqual(["c-1", "c-2"]);
    expect(result.status.state).toBe("idle");
  });

  it("reports a failure instead of throwing when a source breaks", async () => {
    const broken: SourceAdapter = {
      descriptor: { sourceId: "cursor", displayName: "Cursor", builtin: true, dataPath: "/missing" },
      detect: async () => true,
      scan: async function* () {
        throw new Error("native module mismatch");
      }
    };
    const { index } = build({ adapter: broken });

    await index.refreshRecent();

    // 扫描失败被吞掉，索引保持可用（空列表），不会把服务拖垮
    expect((await index.search({})).sessions).toEqual([]);
    expect(index.status().state).toBe("idle");
  });
});

function build(input: { adapter: SourceAdapter; perAgent?: number }) {
  const filePath = join(tempRoot(), "local-session-index.json");
  const index = createLocalSessionIndex({
    filePath,
    registry: createSourceRegistry([input.adapter]),
    ...(input.perAgent === undefined ? {} : { perAgent: input.perAgent })
  });
  return { index, filePath };
}

function fakeAdapter(sourceId: string, displayName: string, messages: ConversationMessage[]): SourceAdapter {
  return {
    descriptor: { sourceId, displayName, builtin: true, dataPath: `/fake/${sourceId}` },
    detect: async () => true,
    scan: async function* (options?: { maxScanTargets?: number }) {
      // 与真实适配器一致：按最近活动优先返回，并遵守会话数上限
      const sorted = [...messages].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      const limit = options?.maxScanTargets ?? Number.POSITIVE_INFINITY;
      const seen = new Set<string>();
      for (const item of sorted) {
        if (!seen.has(item.conversationId)) {
          if (seen.size >= limit) return;
          seen.add(item.conversationId);
        }
        yield item;
      }
    }
  };
}

function message(
  sourceId: string,
  conversationId: string,
  role: ConversationMessage["role"],
  content: string,
  createdAt: string,
  workspacePath: string | null
): ConversationMessage {
  return { messageId: `${conversationId}:${createdAt}`, sourceId, conversationId, role, content, createdAt, workspacePath, gitRoot: null, rawMeta: {} };
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "memmy-session-index-"));
  roots.push(root);
  return root;
}
