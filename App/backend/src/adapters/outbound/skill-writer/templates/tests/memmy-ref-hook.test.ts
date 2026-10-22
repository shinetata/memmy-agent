import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadMemmyWorkspaceBridgeRuntimeAsset } from "../../workspace-bridge/runtime-loader.js";
import { renderMemmyResumeHookScript } from "../memmy-resume-hook.js";
import { renderMemmyResumeHookScript as renderCliHook } from "../../../../../../../../Memory/src/agent-source/integration/templates/memmy-resume-hook.js";

const SESSIONS = [
  {
    sourceId: "codex",
    agentName: "Codex",
    conversationId: "codex-1",
    title: "分享弹窗重复分享提示",
    lastQuestion: "账号不存在呢？",
    workspacePath: "/repo",
    updatedAt: "2026-10-20T08:05:00.000Z",
    turnCount: 2
  },
  {
    sourceId: "workbuddy",
    agentName: "WorkBuddy",
    conversationId: "wb-1",
    title: "sitemap 是什么",
    lastQuestion: "sitemap 是什么",
    workspacePath: null,
    updatedAt: "2026-10-21T03:00:00.000Z",
    turnCount: 1
  }
];

const SHIM = (args: string) => [
  "MEMMY_REF_COMMAND_ARGUMENTS:",
  args,
  "MEMMY_REF_COMMAND_END",
  "",
  "This slash command is a parser shim for the installed Memmy UserPromptSubmit hook."
].join("\n");

describe("memmy-ref hook", () => {
  let tempDir = "";
  let runtimeAsset = "";

  beforeAll(async () => {
    runtimeAsset = await loadMemmyWorkspaceBridgeRuntimeAsset();
  });

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  it.each([
    ["desktop", renderMemmyResumeHookScript],
    ["memory CLI", renderCliHook]
  ])("%s Claude hook lists local sessions, then injects the picked one with the question", async (_label, render) => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-ref-hook-"));
    const fake = await startFakeMemmy();
    try {
      const script = installHook(tempDir, "claude_code", "claude-code", fake.endpoint, runtimeAsset, render);

      const listed = await runHook(script, { hook_event_name: "UserPromptSubmit", session_id: "asking", cwd: "/repo", prompt: SHIM("分享") });
      expect(fake.bodies("/api/v1/agent-sessions/search")).toEqual([
        { query: "分享", cwd: "/repo", excludeConversationIds: ["asking"], limit: 5 }
      ]);
      const blocked = JSON.parse(listed.stdout) as { decision: string; reason: string };
      expect(blocked.decision).toBe("block");
      expect(blocked.reason).toContain("可引用的会话（输入序号引用）：\n1. 分享弹窗重复分享提示\n   Codex · ");
      expect(blocked.reason).toContain("   账号不存在呢？\n2. sitemap 是什么\n   WorkBuddy · ");
      expect(existsSync(join(tempDir, "memmy-ref-state.json"))).toBe(true);

      const picked = await runHook(script, { hook_event_name: "UserPromptSubmit", session_id: "asking", cwd: "/repo", prompt: "1 按这个改提示文案" });
      expect(fake.bodies("/api/v1/agent-sessions/reference")).toEqual([{ sourceId: "codex", conversationId: "codex-1" }]);
      const injected = JSON.parse(picked.stdout) as { hookSpecificOutput: { additionalContext: string } };
      const context = injected.hookSpecificOutput.additionalContext;
      expect(context).toContain("<memmy_reference>\n已引用 Codex 的会话「分享弹窗重复分享提示」");
      expect(context).toContain("完整记录：/cache/codex-codex-1.md\n回答与该会话相关的问题前，先读取此文件。");
      expect(context).not.toContain("还没有提问");
      expect(existsSync(join(tempDir, "memmy-ref-state.json"))).toBe(false);
    } finally {
      await fake.close();
    }
  }, 30000);

  it("holds a number-only pick and sends it with the question typed next", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-ref-hook-"));
    const fake = await startFakeMemmy();
    try {
      const script = installHook(tempDir, "codex", "codex", fake.endpoint, runtimeAsset);
      await runHook(script, { hook_event_name: "UserPromptSubmit", session_id: "asking", prompt: "$memmy-ref" });
      expect(fake.bodies("/api/v1/agent-sessions/search")).toEqual([
        { query: "", cwd: "", excludeConversationIds: ["asking"], limit: 5 }
      ]);

      // Picking alone must not reach the agent: the pick is held so the next message can carry it.
      const picked = await runHook(script, { hook_event_name: "UserPromptSubmit", session_id: "asking", prompt: "2" });
      expect(fake.bodies("/api/v1/agent-sessions/reference")).toEqual([{ sourceId: "workbuddy", conversationId: "wb-1" }]);
      const held = JSON.parse(picked.stdout) as { decision: string; reason: string };
      expect(held.decision).toBe("block");
      expect(held.reason).toContain("已引用 WorkBuddy 的会话「sitemap 是什么」。直接在输入框里写你的问题");
      expect(held.reason).not.toContain("还没有提问");
      expect(existsSync(join(tempDir, "memmy-ref-state.json"))).toBe(true);

      const asked = await runHook(script, { hook_event_name: "UserPromptSubmit", session_id: "asking", prompt: "这个会话讲了什么？" });
      const context = (JSON.parse(asked.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
      expect(context).toContain("<memmy_reference>");
      expect(context).toContain("已引用 WorkBuddy 的会话「sitemap 是什么」");
      expect(context).toContain("完整记录：/cache/workbuddy-wb-1.md");
      expect(context).not.toContain("用户只选择了引用");
      expect(existsSync(join(tempDir, "memmy-ref-state.json"))).toBe(false);
      // The reference endpoint is not called twice: the pick was already resolved.
      expect(fake.bodies("/api/v1/agent-sessions/reference")).toHaveLength(1);
    } finally {
      await fake.close();
    }
  }, 30000);

  it("does not swallow another slash command while a pick is held", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-ref-hook-"));
    const fake = await startFakeMemmy();
    try {
      const script = installHook(tempDir, "claude_code", "claude-code", fake.endpoint, runtimeAsset);
      await runHook(script, { hook_event_name: "UserPromptSubmit", session_id: "asking", prompt: "/memmy-ref" });
      await runHook(script, { hook_event_name: "UserPromptSubmit", session_id: "asking", prompt: "1" });

      const other = await runHook(script, { hook_event_name: "UserPromptSubmit", session_id: "asking", prompt: "/clear" });

      expect(other.stdout.trim()).toBe("");
    } finally {
      await fake.close();
    }
  }, 30000);

  it("only treats the very next input as a selection", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-ref-hook-"));
    const fake = await startFakeMemmy();
    try {
      const script = installHook(tempDir, "claude_code", "claude-code", fake.endpoint, runtimeAsset);
      await runHook(script, { hook_event_name: "UserPromptSubmit", session_id: "asking", prompt: "/memmy-ref" });
      await runHook(script, { hook_event_name: "UserPromptSubmit", session_id: "asking", prompt: "先看看日志" });
      await runHook(script, { hook_event_name: "UserPromptSubmit", session_id: "asking", prompt: "1" });
      expect(fake.bodies("/api/v1/agent-sessions/reference")).toEqual([]);
    } finally {
      await fake.close();
    }
  }, 30000);

  it("ignores candidates listed in another conversation", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-ref-hook-"));
    const fake = await startFakeMemmy();
    try {
      const script = installHook(tempDir, "claude_code", "claude-code", fake.endpoint, runtimeAsset);
      await runHook(script, { hook_event_name: "UserPromptSubmit", session_id: "first", prompt: "/memmy-ref" });
      await runHook(script, { hook_event_name: "UserPromptSubmit", session_id: "second", prompt: "1" });
      expect(fake.bodies("/api/v1/agent-sessions/reference")).toEqual([]);
    } finally {
      await fake.close();
    }
  }, 30000);

  it("cancels the candidate list", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-ref-hook-"));
    const fake = await startFakeMemmy();
    try {
      const script = installHook(tempDir, "claude_code", "claude-code", fake.endpoint, runtimeAsset);
      await runHook(script, { hook_event_name: "UserPromptSubmit", session_id: "asking", prompt: "/memmy-ref" });
      const cancelled = await runHook(script, { hook_event_name: "UserPromptSubmit", session_id: "asking", prompt: "/memmy-ref cancel" });
      expect(JSON.parse(cancelled.stdout)).toEqual({ decision: "block", reason: "已取消引用。" });
      expect(existsSync(join(tempDir, "memmy-ref-state.json"))).toBe(false);
    } finally {
      await fake.close();
    }
  }, 30000);

  it("hands Cursor the file path because its prompt hook cannot inject", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-ref-hook-"));
    const fake = await startFakeMemmy();
    try {
      const script = installHook(tempDir, "cursor", "cursor", fake.endpoint, runtimeAsset);
      const listed = await runHook(script, { hook_event_name: "beforeSubmitPrompt", conversation_id: "asking", prompt: "/memmy-ref 分享" });
      expect(JSON.parse(listed.stdout)).toMatchObject({ continue: false });
      const picked = await runHook(script, { hook_event_name: "beforeSubmitPrompt", conversation_id: "asking", prompt: "1" });
      expect(JSON.parse(picked.stdout)).toEqual({
        continue: false,
        user_message: "已保存会话「分享弹窗重复分享提示」：/cache/codex-codex-1.md\n请在下一条消息中让 Agent 先读取这个文件。"
      });
    } finally {
      await fake.close();
    }
  }, 30000);

  it.each([
    ["no_project", "当前目录还没有关联到 Memmy 本地项目。先在 Memmy 中把这个目录建为本地项目并关联会话，再输入 /memmy-ref。"],
    ["no_association", "这个本地项目还没有关联任何会话。先在 Memmy 中关联其他 Agent 的会话，再输入 /memmy-ref。"],
    ["no_match", "没有匹配的会话。换个更短的关键词，或直接输入 /memmy-ref 查看全部。"]
  ])("tells the person what to fix when the project is empty (%s)", async (reason, expected) => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-ref-hook-"));
    const fake = await startFakeMemmy([], reason);
    try {
      const script = installHook(tempDir, "claude_code", "claude-code", fake.endpoint, runtimeAsset);
      const listed = await runHook(script, { hook_event_name: "UserPromptSubmit", session_id: "asking", cwd: "/repo", prompt: "/memmy-ref" });
      expect(JSON.parse(listed.stdout)).toEqual({ decision: "block", reason: expected });
      expect(existsSync(join(tempDir, "memmy-ref-state.json"))).toBe(false);
    } finally {
      await fake.close();
    }
  }, 30000);

  it("reports an empty result without keeping a candidate list", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-ref-hook-"));
    const fake = await startFakeMemmy([]);
    try {
      const script = installHook(tempDir, "claude_code", "claude-code", fake.endpoint, runtimeAsset);
      const listed = await runHook(script, { hook_event_name: "UserPromptSubmit", session_id: "asking", prompt: "/memmy-ref 不存在" });
      expect(JSON.parse(listed.stdout)).toEqual({ decision: "block", reason: "没有匹配的会话。" });
      expect(existsSync(join(tempDir, "memmy-ref-state.json"))).toBe(false);
    } finally {
      await fake.close();
    }
  }, 30000);
});

async function startFakeMemmy(sessions = SESSIONS, reason?: string): Promise<{
  endpoint: string;
  bodies(path: string): Record<string, unknown>[];
  close(): Promise<void>;
}> {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    const path = request.url ?? "";
    const body = await requestBody(request);
    requests.push({ path, body });
    response.setHeader("content-type", "application/json");
    if (path === "/api/v1/agent-sessions/search") {
      response.end(JSON.stringify(reason ? { sessions, reason } : { sessions }));
      return;
    }
    if (path === "/api/v1/agent-sessions/reference") {
      const session = sessions.find((item) => item.conversationId === body.conversationId)!;
      response.end(JSON.stringify({ ...session, path: `/cache/${session.sourceId}-${session.conversationId}.md`, markdown: "# x" }));
      return;
    }
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    bodies: (path) => requests.filter((request) => request.path === path).map((request) => withoutSource(request.body)),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

function withoutSource(body: Record<string, unknown>): Record<string, unknown> {
  const { source: _source, ...rest } = body;
  return rest;
}

function installHook(
  directory: string,
  source: string,
  mode: "claude-code" | "codex" | "cursor",
  endpoint: string,
  runtimeAsset: string,
  render = renderMemmyResumeHookScript
): string {
  const hookScriptPath = join(directory, "memmy-resume-hook.mjs");
  writeFileSync(hookScriptPath, render({ source, mode }));
  writeFileSync(join(directory, "memmy-workspace-bridge.mjs"), runtimeAsset);
  writeFileSync(join(directory, "memmy-memory-config.json"), JSON.stringify({
    memmy_config_path: join(directory, "missing-config.yaml"),
    endpoint,
    token: "",
    userId: "installed-owner",
    workspaceHostId: "a".repeat(64)
  }));
  return hookScriptPath;
}

async function runHook(scriptPath: string, payload: Record<string, unknown>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath], {
      env: { ...process.env, MEMMY_CONFIG: join(dirname(scriptPath), "missing-config.yaml") }
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => {
      clearTimeout(timeout);
      resolve({ status, stdout, stderr });
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function requestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.method === "GET") return {};
  let value = "";
  for await (const chunk of request) value += chunk;
  return value ? JSON.parse(value) as Record<string, unknown> : {};
}
