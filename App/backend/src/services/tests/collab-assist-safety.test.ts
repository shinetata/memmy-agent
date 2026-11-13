import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistReviewer } from "../assist/review.js";
import {
  createCollabAssistService,
  pendingText,
  resultText,
  type AssistRunner
} from "../collab-assist-service.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home(): string {
  const root = mkdtempSync(join(tmpdir(), "memmy-assist-safety-"));
  roots.push(root);
  return root;
}

const MEMBER = { userId: "2102247370314383361", name: "孙起", mine: false };
const ME = { userId: "2102247370314383362", name: "王雨", mine: true };
const REQUEST_ID = "a7f3k111-1111-1111-1111-111111111111";

function request(overrides: Record<string, unknown> = {}) {
  return {
    id: REQUEST_ID,
    projectId: "p1",
    projectName: "Memmy 内测反馈",
    threadId: "thread-1",
    attempt: 1,
    via: "Codex",
    title: "清一下缓存后重新复现",
    reason: "本机复现不了分享弹窗的问题",
    items: ["删除 ~/Library/Caches/memmy 后重新打开 Memmy"],
    attachments: null,
    status: "pending",
    agent: null,
    scope: null,
    grant: null,
    steps: [],
    reply: "",
    resultItems: [],
    files: [],
    failure: null,
    requester: MEMBER,
    executor: { ...ME, mine: false },
    mine: false,
    createdAt: "2026-11-13T08:41:00Z",
    decidedAt: null,
    finishedAt: null,
    autoRun: false,
    safety: null,
    ...overrides
  };
}

function fakeCloud(handler: (path: string, init?: { method?: string; body?: any }) => Record<string, unknown>) {
  const calls: Array<{ path: string; method: string; body: any }> = [];
  return {
    calls,
    cloud: async (path: string, init?: { method?: string; body?: unknown }) => {
      calls.push({ path, method: init?.method ?? "GET", body: init?.body });
      return handler(path, init);
    }
  };
}

/** 审查器：按需给出结论，并记下被问了什么。 */
function reviewer(options: {
  requester?: Awaited<ReturnType<AssistReviewer["reviewRequester"]>>;
  executor?: Awaited<ReturnType<AssistReviewer["reviewExecutor"]>>;
}): AssistReviewer & { executorInputs: unknown[] } {
  const executorInputs: unknown[] = [];
  return {
    executorInputs,
    reviewRequester: async () => options.requester ?? null,
    reviewExecutor: async (input) => {
      executorInputs.push(input);
      return options.executor ?? null;
    }
  };
}

function recordingRunner(reply = "版本是 15.6。"): AssistRunner & { inputs: any[] } {
  const inputs: any[] = [];
  return {
    inputs,
    async run(input) {
      inputs.push(input);
      input.onStep({ text: "运行 sw_vers", output: "macOS 15.6" });
      input.onSession("s-42");
      return { reply, steps: [{ text: "运行 sw_vers", output: "macOS 15.6" }], sessionId: "s-42" };
    }
  };
}

describe("the requester's own check runs before the request is sent", () => {
  it("refuses a request that does not spell out its operations, and sends nothing", async () => {
    const { calls, cloud } = fakeCloud(() => ({ projects: [{ id: "p1", name: "Memmy 内测反馈" }] }));
    const service = createCollabAssistService({
      cloud,
      homeDirectory: home(),
      projectDirectory: async () => null,
      agents: async () => [],
      runner: recordingRunner(),
      reviewer: reviewer({
        requester: {
          sensitive: [{ action: "删除文件", clear: false }],
          secrets: [],
          summary: "会删除文件"
        }
      })
    });

    await expect(service.createRequest({
      project: "Memmy 内测反馈",
      member: "王雨",
      title: "清一下缓存后重新复现",
      items: ["删除缓存后重新打开 Memmy"]
    })).rejects.toMatchObject({ code: "collab_assist_safety_rejected" });
    expect(calls.some((call) => call.path === "/projects/p1/assist/requests")).toBe(false);
  });

  it("refuses a request that carries a secret", async () => {
    const { cloud } = fakeCloud(() => ({ projects: [{ id: "p1", name: "Memmy 内测反馈" }] }));
    const service = createCollabAssistService({
      cloud,
      homeDirectory: home(),
      projectDirectory: async () => null,
      agents: async () => [],
      runner: recordingRunner(),
      reviewer: reviewer({
        requester: { sensitive: [], secrets: ["附件 setup.sh 第 3 行附近"], summary: "不涉及敏感操作" }
      })
    });

    await expect(service.createRequest({
      project: "Memmy 内测反馈",
      member: "王雨",
      title: "跑一下附带脚本",
      items: ["运行 setup.sh"],
      attachments: [{ name: "setup.sh", content: "#!/bin/sh\nexport TOKEN=abc\n" }]
    })).rejects.toMatchObject({ code: "collab_assist_safety_rejected" });
  });

  it("sends the declaration when the request spells everything out", async () => {
    const { calls, cloud } = fakeCloud((path) => {
      if (path === "/projects") return { projects: [{ id: "p1", name: "Memmy 内测反馈" }] };
      return request();
    });
    const service = createCollabAssistService({
      cloud,
      homeDirectory: home(),
      projectDirectory: async () => null,
      agents: async () => [],
      runner: recordingRunner(),
      reviewer: reviewer({
        requester: {
          sensitive: [{ action: "删除缓存目录", target: "~/Library/Caches/memmy", reason: "清掉旧缓存", clear: true }],
          secrets: [],
          summary: "会删除 Memmy 的缓存目录"
        }
      })
    });

    await service.createRequest({
      project: "Memmy 内测反馈",
      member: "王雨",
      title: "清一下缓存后重新复现",
      items: ["删除 ~/Library/Caches/memmy 后重新打开 Memmy"]
    });

    const sent = calls.find((call) => call.path === "/projects/p1/assist/requests");
    expect(sent?.body.safety).toEqual({
      requester: {
        status: "passed",
        summary: "会删除 Memmy 的缓存目录",
        declared: [{ action: "删除缓存目录（~/Library/Caches/memmy）", reason: "清掉旧缓存" }]
      }
    });
  });

  it("still sends the request when the model is not available", async () => {
    const { calls, cloud } = fakeCloud((path) => {
      if (path === "/projects") return { projects: [{ id: "p1", name: "Memmy 内测反馈" }] };
      return request();
    });
    const service = createCollabAssistService({
      cloud,
      homeDirectory: home(),
      projectDirectory: async () => null,
      agents: async () => [],
      runner: recordingRunner(),
      // 模型不可用：reviewRequester 返回 null。
      reviewer: reviewer({})
    });

    await service.createRequest({
      project: "Memmy 内测反馈",
      member: "王雨",
      title: "查日志",
      items: ["看一下日志"]
    });

    const sent = calls.find((call) => call.path === "/projects/p1/assist/requests");
    expect(sent?.body.safety).toEqual({ requester: { status: "unavailable" } });
  });
});

describe("the executor's check decides whether it still runs directly", () => {
  /** 一个等着被自动执行的请求：限时授权仍然有效、执行方是 Codex。 */
  function granted(): Record<string, unknown> {
    return request({
      status: "pending",
      grantAgent: "codex",
      granted: true,
      grantExpiresAt: new Date(Date.now() + 600_000).toISOString(),
      agent: "codex"
    });
  }

  function service(input: {
    inbox: Record<string, unknown>[];
    reviewer: AssistReviewer;
    runner: AssistRunner;
    asksForApproval?: (sourceId: string) => boolean;
  }) {
    const { calls, cloud } = fakeCloud((path, init) => {
      if (path === "/assist/inbox") return { requests: input.inbox };
      if (path === "/assist/outbox") return { requests: [] };
      if (path.endsWith("/review")) return { request: request() };
      if (path.endsWith("/decision")) return { request: request({ status: "running", agent: "codex" }) };
      if (path.endsWith("/progress")) return { ok: true };
      if (path.endsWith("/result")) return { request: request({ status: "done" }) };
      // 详情：已经决定执行的那条按「执行中」返回，execute 才会真正跑起来。
      if (path.includes("/assist/requests/")) return { request: request({ status: "running", agent: "codex" }) };
      if (path.startsWith("/projects/p1/assist/threads")) return { thread: { threadId: "thread-1", requests: [] } };
      return {};
    });
    const created = createCollabAssistService({
      cloud,
      homeDirectory: home(),
      projectDirectory: async () => null,
      agents: async () => [],
      runner: input.runner,
      reviewer: input.reviewer,
      ...(input.asksForApproval ? { agentAsksForApproval: input.asksForApproval } : {})
    });
    return { service: created, calls };
  }

  it("keeps the request in the inbox when her check wants her to confirm", async () => {
    const { service: created, calls } = service({
      inbox: [granted()],
      reviewer: reviewer({
        executor: {
          sensitive: [{ action: "删除缓存目录" }],
          undeclared: ["删除 ~/Library/Caches/memmy"],
          injected: false,
          reason: "会删除 Memmy 的缓存目录"
        }
      }),
      runner: recordingRunner()
    });

    await created.pollNow();

    const review = calls.find((call) => call.path.endsWith("/review"));
    expect(review?.body).toEqual({
      executor: { status: "confirm", reason: "会删除 Memmy 的缓存目录", undeclared: ["删除 ~/Library/Caches/memmy"] }
    });
    expect(calls.some((call) => call.path.endsWith("/decision"))).toBe(false);
  });

  it("runs it directly when the check is clean and the Agent asks for approval", async () => {
    const runner = recordingRunner();
    const { service: created, calls } = service({
      inbox: [granted()],
      reviewer: reviewer({ executor: { sensitive: [], undeclared: [], injected: false, reason: "" } }),
      runner,
      asksForApproval: () => true
    });

    await created.pollNow();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(calls.find((call) => call.path.endsWith("/review"))?.body).toEqual({ executor: { status: "auto" } });
    const decision = calls.find((call) => call.path.endsWith("/decision"));
    expect(decision?.body).toMatchObject({ action: "allow", agent: "codex", scope: "timed" });
    // 自动开始的这次：批准策略是 deny，执行边界里没有允许的敏感操作。
    expect(runner.inputs[0]?.approval).toBe("deny");
    expect(runner.inputs[0]?.prompt).toContain("这次请求允许的敏感操作：无");
  });

  it("reviews a request without a grant just to explain the dialog", async () => {
    const { service: created, calls } = service({
      inbox: [request({ status: "pending" })],
      reviewer: reviewer({ executor: { sensitive: [], undeclared: [], injected: false, reason: "" } }),
      runner: recordingRunner()
    });

    await created.pollNow();

    expect(calls.find((call) => call.path.endsWith("/review"))?.body).toEqual({ executor: { status: "confirm", reason: expect.any(String) } });
    expect(calls.some((call) => call.path.endsWith("/decision"))).toBe(false);
  });

  it("only asks the model once for the same request", async () => {
    const exec = reviewer({ executor: { sensitive: [], undeclared: [], injected: false, reason: "" } });
    const { service: created } = service({
      inbox: [request({ status: "pending" })],
      reviewer: exec,
      runner: recordingRunner()
    });

    await created.pollNow();
    await created.pollNow();

    expect(exec.executorInputs).toHaveLength(1);
  });

  it("never runs directly when the selected Agent does not ask for approval", async () => {
    const { service: created, calls } = service({
      inbox: [granted()],
      reviewer: reviewer({ executor: { sensitive: [], undeclared: [], injected: false, reason: "" } }),
      runner: recordingRunner(),
      asksForApproval: () => false
    });

    await created.pollNow();

    const review = calls.find((call) => call.path.endsWith("/review"));
    expect(review?.body).toMatchObject({ executor: { status: "confirm" } });
    expect(String(review?.body.executor.reason)).toContain("不会请求批准");
    expect(calls.some((call) => call.path.endsWith("/decision"))).toBe(false);
  });
});

describe("the texts the requester sees", () => {
  it("says why her Memmy asked her to confirm", () => {
    const text = pendingText(request({
      autoRun: false,
      safety: { executor: { status: "confirm", reason: "附带的脚本会删除下载目录里的文件" } }
    }));
    expect(text).toContain("王雨的 Memmy 检查后，这次请求需要王雨确认：附带的脚本会删除下载目录里的文件。");
    expect(text).toContain("等待王雨授权");
  });

  it("lists the operations that were skipped, with how to ask again", () => {
    const text = resultText(request({
      status: "done",
      reply: "版本是 15.6。",
      safety: { skipped: [{ title: "删除缓存目录", detail: "rm -rf ~/Library/Caches/foo" }] }
    }));
    expect(text).toContain("以下操作按协助规则没有执行：");
    expect(text).toContain("- 删除缓存目录（rm -rf ~/Library/Caches/foo）");
    expect(text).toContain("assist ask --continue");
    expect(text).toContain("王雨授权后才会执行");
  });

  it("says nothing about skipped operations when there were none", () => {
    expect(resultText(request({ status: "done", reply: "版本是 15.6。" }))).not.toContain("没有执行");
  });
});
