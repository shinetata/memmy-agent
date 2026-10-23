import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runMemmySession } from "../memmy-session.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runtimeFile(contents: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "memmy-session-cli-"));
  roots.push(root);
  const path = join(root, "runtime.json");
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

function run(argv: string[], deps: Parameters<typeof runMemmySession>[1]) {
  return runMemmySession(argv, deps);
}

describe("memmy-session", () => {
  it("reads a pasted link through the desktop's local API and prints the reference text", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    const fetcher = (async (input: string | URL, init?: RequestInit) => {
      calls.push({ url: String(input), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ text: "已引用用户C 的会话「重复分享返回 409」。\n完整记录：/tmp/s.md" }), { status: 200 });
    }) as typeof fetch;
    const runtimeConfigPath = runtimeFile({ baseUrl: "http://127.0.0.1:62315", localToken: "local-token" });

    const output = await run(["read", "https://memmy.example/s/abc-123"], { fetch: fetcher, runtimeConfigPath });

    expect(output).toBe("已引用用户C 的会话「重复分享返回 409」。\n完整记录：/tmp/s.md");
    expect(calls[0]).toEqual({
      url: "http://127.0.0.1:62315/api/collab/sessions/read",
      headers: { "x-memmy-local-token": "local-token", "content-type": "application/json" },
      body: { reference: "https://memmy.example/s/abc-123", view: {} }
    });
  });

  it("prints one line per search result, or says nothing matched", async () => {
    let lastUrl = "";
    const sessions = [{ id: "s-409", title: "重复分享返回 409", projectName: "Memmy 开发", memberName: "用户C", mine: false, lastActiveAt: null }];
    const fetcher = (async (input: string | URL) => {
      lastUrl = String(input);
      return new Response(JSON.stringify({ sessions: lastUrl.includes("q=nothing") ? [] : sessions }), { status: 200 });
    }) as typeof fetch;
    const runtimeConfigPath = runtimeFile({ baseUrl: "http://127.0.0.1:62315", localToken: "t" });

    expect(await run(["search", "重复分享", "--member", "用户C", "--limit", "3"], { fetch: fetcher, runtimeConfigPath }))
      .toBe("s-409  重复分享返回 409  Memmy 开发 · 用户C");
    const url = new URL(lastUrl);
    expect(url.pathname).toBe("/api/collab/sessions/search");
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: "重复分享", member: "用户C", limit: "3" });
    expect(await run(["search", "nothing"], { fetch: fetcher, runtimeConfigPath })).toMatch(/^没有匹配的会话。/u);
  });

  it("names every project a merged result is shared to and passes --since through", async () => {
    let lastUrl = "";
    const sessions = [{
      id: "a",
      title: "Memmy项目协作记忆方案",
      projectName: "Markdown事项验证",
      projectNames: ["Markdown事项验证", "测试"],
      memberName: "用户C",
      mine: false,
      lastActiveAt: null
    }];
    const fetcher = (async (input: string | URL) => {
      lastUrl = String(input);
      return new Response(JSON.stringify({ sessions }), { status: 200 });
    }) as typeof fetch;
    const runtimeConfigPath = runtimeFile({ baseUrl: "http://127.0.0.1:62315", localToken: "t" });

    expect(await run(["search", "项目", "记忆", "--since", "30d"], { fetch: fetcher, runtimeConfigPath }))
      .toBe("a  Memmy项目协作记忆方案  Markdown事项验证、测试 · 用户C");
    expect(Object.fromEntries(new URL(lastUrl).searchParams)).toEqual({ q: "项目 记忆", since: "30d" });
  });

  it("sends the read range the agent asked for, one at a time", async () => {
    const bodies: unknown[] = [];
    const fetcher = (async (_input: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ text: "ok" }), { status: 200 });
    }) as typeof fetch;
    const runtimeConfigPath = runtimeFile({ baseUrl: "http://127.0.0.1:62315", localToken: "t" });

    await run(["read", "abc", "--around", "12"], { fetch: fetcher, runtimeConfigPath });
    await run(["read", "abc", "--turns", "8-3"], { fetch: fetcher, runtimeConfigPath });
    await run(["read", "abc", "--find", "云端先校验版本"], { fetch: fetcher, runtimeConfigPath });
    await run(["read", "abc", "--all"], { fetch: fetcher, runtimeConfigPath });
    expect(bodies.map((body) => (body as { view: unknown }).view)).toEqual([
      { around: 12 },
      { turns: { from: 3, to: 8 } },
      { find: "云端先校验版本" },
      { all: true }
    ]);
    await expect(run(["read", "abc", "--around", "2", "--all"], { fetch: fetcher, runtimeConfigPath })).rejects.toThrow(/只能指定一种读取范围/u);
    await expect(run(["read", "abc", "--turns", "a-b"], { fetch: fetcher, runtimeConfigPath })).rejects.toThrow(/--turns/u);
    await expect(run(["read", "abc", "--around", "0"], { fetch: fetcher, runtimeConfigPath })).rejects.toThrow(/--around/u);
  });

  it("tells the agent to open Memmy when the desktop app is not running, and relays API errors", async () => {
    const missing = join(tmpdir(), "memmy-no-such-runtime.json");
    await expect(run(["read", "abc"], { runtimeConfigPath: missing })).rejects.toThrow("无法连接 Memmy，请打开 Memmy 后重试。");
    const denied = (async () => new Response(JSON.stringify({ error: { code: "not_found", message: "项目或会话不存在，或你不是该项目的成员" } }), { status: 404 })) as typeof fetch;
    const runtimeConfigPath = runtimeFile({ baseUrl: "http://127.0.0.1:62315", localToken: "t" });
    await expect(run(["read", "abc"], { fetch: denied, runtimeConfigPath })).rejects.toThrow("项目或会话不存在，或你不是该项目的成员");
    await expect(run(["read"], { runtimeConfigPath })).rejects.toThrow(/需要 Memmy 会话链接/u);
    expect(await run([], { runtimeConfigPath })).toMatch(/^Usage:/u);
    await expect(run(["list"], { runtimeConfigPath })).rejects.toThrow(/未知命令：list/u);
  });
});
