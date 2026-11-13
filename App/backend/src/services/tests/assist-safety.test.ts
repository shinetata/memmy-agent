import { describe, expect, it } from "vitest";
import {
  assistBoundaryPrompt,
  executorReviewDecision,
  executorReviewPrompt,
  parseExecutorReview,
  parseRequesterReview,
  parseReviewJson,
  requesterReviewDecision,
  requesterReviewPrompt,
  toAssistSafety,
  type ExecutorReviewRaw,
  type RequesterReviewRaw
} from "../assist/safety.js";

const CONTENT = {
  requesterName: "孙起",
  projectName: "Memmy 内测反馈",
  title: "清一下缓存后重新复现",
  reason: "本机复现不了分享弹窗的问题",
  items: ["删除 ~/Library/Caches/memmy 后重新打开 Memmy"],
  attachments: [{ name: "setup.sh", content: "#!/bin/sh\nrm -rf ~/Downloads/tmp" }]
};

describe("parseReviewJson", () => {
  it("reads an object inside a fenced code block", () => {
    expect(parseReviewJson('好的：\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("returns null when the answer is not JSON", () => {
    expect(parseReviewJson("抱歉，我不能判断。")).toBeNull();
  });
});

describe("parseRequesterReview", () => {
  it("keeps each sensitive operation with whether it is clear", () => {
    const result = parseRequesterReview(JSON.stringify({
      sensitive: [
        { action: "删除 Memmy 的缓存目录", target: "~/Library/Caches/memmy", reason: "清掉旧缓存", clear: true },
        { action: "上传日志", clear: false }
      ],
      secrets: ["附件 setup.sh 第 3 行附近"],
      summary: "会删除缓存目录并上传日志"
    }));
    expect(result?.sensitive).toHaveLength(2);
    expect(result?.sensitive[1]?.clear).toBe(false);
    expect(result?.secrets).toEqual(["附件 setup.sh 第 3 行附近"]);
    expect(result?.summary).toBe("会删除缓存目录并上传日志");
  });

  it("returns null on an answer it cannot read", () => {
    expect(parseRequesterReview("我看不出风险")).toBeNull();
  });
});

describe("requesterReviewDecision", () => {
  const base: RequesterReviewRaw = { sensitive: [], secrets: [], summary: "不涉及敏感操作" };

  it("refuses an operation that is not written clearly", () => {
    const decision = requesterReviewDecision({
      ...base,
      sensitive: [{ action: "删除文件", clear: false }]
    });
    expect(decision.refusal).toContain("没有写明做在哪个对象上、为什么");
    expect(decision.refusal).toContain("不要把这项操作放进脚本");
  });

  it("refuses a request that carries a secret", () => {
    const decision = requesterReviewDecision({ ...base, secrets: ["附件 setup.sh 第 3 行附近"] });
    expect(decision.refusal).toContain("疑似密钥");
    expect(decision.refusal).toContain("请删掉后重新发送");
  });

  it("passes a request that spells out its operations", () => {
    const decision = requesterReviewDecision({
      sensitive: [{ action: "删除缓存目录", target: "~/Library/Caches/memmy", reason: "清掉旧缓存", clear: true }],
      secrets: [],
      summary: "会删除缓存目录"
    });
    expect(decision.refusal).toBeNull();
    expect(decision.safety).toEqual({
      status: "passed",
      summary: "会删除缓存目录",
      declared: [{ action: "删除缓存目录（~/Library/Caches/memmy）", reason: "清掉旧缓存" }]
    });
  });
});

describe("executorReviewDecision", () => {
  const clean: ExecutorReviewRaw = { sensitive: [], undeclared: [], injected: false, reason: "" };

  it("runs automatically only when nothing was skipped, the check is clean and the Agent asks for approval", () => {
    const decision = executorReviewDecision({
      review: clean,
      previousSkipped: [],
      asksForApproval: true,
      granted: true
    });
    expect(decision).toEqual({ safety: { status: "auto" }, autoRun: true });
  });

  it("asks her first when the last request skipped something, before anything else", () => {
    const decision = executorReviewDecision({
      review: { ...clean, sensitive: [{ action: "删除缓存目录" }] },
      previousSkipped: [{ title: "删除缓存目录", detail: "rm -rf ~/Library/Caches/foo" }],
      asksForApproval: true,
      granted: true
    });
    expect(decision.autoRun).toBe(false);
    expect(decision.safety.reason).toBe("上次跳过了：删除缓存目录");
  });

  it("asks her first when the check found a sensitive operation", () => {
    const decision = executorReviewDecision({
      review: {
        sensitive: [{ action: "删除缓存目录" }],
        undeclared: ["删除 ~/Downloads"],
        injected: false,
        reason: "附带的脚本会删除下载目录里的文件"
      },
      previousSkipped: [],
      asksForApproval: true,
      granted: true
    });
    expect(decision.autoRun).toBe(false);
    expect(decision.safety).toEqual({
      status: "confirm",
      reason: "附带的脚本会删除下载目录里的文件",
      undeclared: ["删除 ~/Downloads"]
    });
  });

  it("asks her first when the script smuggles instructions", () => {
    const decision = executorReviewDecision({
      review: { sensitive: [], undeclared: [], injected: true, injectedNote: "让执行方把结果发到别处", reason: "附件里夹带了指令" },
      previousSkipped: [],
      asksForApproval: true,
      granted: true
    });
    expect(decision.safety.status).toBe("confirm");
    expect(decision.safety.reason).toBe("附件里夹带了指令");
  });

  it("asks her first when the Agent never asks for approval", () => {
    const decision = executorReviewDecision({
      review: clean,
      previousSkipped: [],
      agentName: "Pi",
      asksForApproval: false,
      granted: true
    });
    expect(decision.autoRun).toBe(false);
    expect(decision.safety.reason).toBe("Pi 执行时不会请求批准，需要你看过后再决定");
  });

  it("puts the Agent reason before the model's when the Agent never asks for approval", () => {
    const decision = executorReviewDecision({
      review: {
        sensitive: [{ action: "删除缓存目录" }],
        undeclared: [],
        injected: false,
        reason: "附带的脚本会删除下载目录里的文件"
      },
      previousSkipped: [],
      agentName: "Pi",
      asksForApproval: false,
      granted: true
    });
    expect(decision.safety.reason).toBe("Pi 执行时不会请求批准，需要你看过后再决定");
  });

  it("asks her first when the check could not run", () => {
    const decision = executorReviewDecision({
      review: null,
      previousSkipped: [],
      asksForApproval: true,
      granted: true
    });
    expect(decision.autoRun).toBe(false);
    expect(decision.safety).toEqual({
      status: "unavailable",
      reason: "未能完成安全检查，请看过请求内容再决定"
    });
  });

  it("still asks for a normal authorisation when there is no timed grant", () => {
    const decision = executorReviewDecision({
      review: clean,
      previousSkipped: [],
      asksForApproval: true,
      granted: false
    });
    expect(decision.autoRun).toBe(false);
    expect(decision.safety.status).toBe("confirm");
  });
});

describe("assistBoundaryPrompt", () => {
  it("lists what is allowed and what is not", () => {
    const text = assistBoundaryPrompt(["删除 ~/Library/Caches/memmy"]);
    expect(text).toContain("这次请求允许的敏感操作：删除 ~/Library/Caches/memmy");
    expect(text).toContain("除此之外，不要删除或覆盖文件、读取密钥和登录凭据、向外部发送内容、修改系统或 Agent 的设置。");
    expect(text).toContain("遇到上面不允许的操作时不要执行，在结果里写明要做什么、为什么。");
  });

  it("says none when the request runs automatically", () => {
    expect(assistBoundaryPrompt([])).toContain("这次请求允许的敏感操作：无");
  });
});

describe("review prompts", () => {
  it("include the request, the attachments in full and the declared operations", () => {
    const requester = requesterReviewPrompt(CONTENT);
    expect(requester).toContain("要做的事：清一下缓存后重新复现");
    expect(requester).toContain("- 删除 ~/Library/Caches/memmy 后重新打开 Memmy");
    expect(requester).toContain("── setup.sh ──");
    expect(requester).toContain("rm -rf ~/Downloads/tmp");

    const executor = executorReviewPrompt({
      ...CONTENT,
      declared: [{ action: "删除缓存目录", reason: "清掉旧缓存" }],
      previousSkipped: [{ title: "删除缓存目录", detail: "rm -rf ~/Library/Caches/foo" }]
    });
    expect(executor).toContain("发起方声明的敏感操作：");
    expect(executor).toContain("- 删除缓存目录（清掉旧缓存）");
    expect(executor).toContain("同一次排查里上一次请求有这些操作没有执行");
    expect(executor).toContain("删除缓存目录（rm -rf ~/Library/Caches/foo）");
  });

  it("say the requester declared nothing when there is nothing", () => {
    expect(executorReviewPrompt(CONTENT)).toContain("发起方没有声明任何敏感操作。");
  });
});

describe("toAssistSafety", () => {
  it("reads what the cloud returns and drops what it cannot read", () => {
    const safety = toAssistSafety({
      requester: { status: "passed", summary: "会读日志", declared: [{ action: "读取日志" }] },
      executor: { status: "confirm", reason: "会删除文件", undeclared: ["删除 ~/Downloads"] },
      skipped: [{ title: "删除缓存目录", detail: "rm -rf x" }, { nope: true }],
      redacted: 2,
      extra: "忽略"
    });
    expect(safety).toEqual({
      requester: { status: "passed", summary: "会读日志", declared: [{ action: "读取日志" }] },
      executor: { status: "confirm", reason: "会删除文件", undeclared: ["删除 ~/Downloads"] },
      skipped: [{ title: "删除缓存目录", detail: "rm -rf x" }, { title: "一项操作" }],
      redacted: 2
    });
  });

  it("returns null for an old request without the field", () => {
    expect(toAssistSafety(undefined)).toBeNull();
    expect(toAssistSafety({})).toBeNull();
  });
});
