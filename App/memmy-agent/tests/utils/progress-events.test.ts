import { describe, expect, it, vi } from "vitest";
import {
  buildToolEventStartPayload,
  buildToolEventFinishPayloads,
  onProgressAcceptsFileEditEvents,
  onProgressAcceptsReasoning,
  onProgressAcceptsToolEvents,
  sanitizeToolEventResult,
  withProgressCapabilities,
} from "../../src/utils/progress-events.js";

describe("progress event payloads", () => {
  it("carries the assist request marker through to the UI event", () => {
    // 抬到界面的工具事件是白名单字段拼出来的：发出协助请求的标记必须显式透传，
    // 否则界面拿不到，只能退回去猜命令文本。
    const [finish] = buildToolEventFinishPayloads({
      toolCalls: [{ id: "call-1", name: "exec", arguments: { command: "memmy-project assist ask" } }],
      toolResults: ["已发送协助请求 8DCD3A。"],
      toolEvents: [{ status: "ok", assist_request_id: "8dcd3a2c-5cbd" }],
    });

    expect(finish.assist_request_id).toBe("8dcd3a2c-5cbd");
    // 普通调用不会多出这个字段。
    const [plain] = buildToolEventFinishPayloads({
      toolCalls: [{ id: "call-2", name: "exec", arguments: { command: "ls" } }],
      toolResults: ["a.txt"],
      toolEvents: [{ status: "ok" }],
    });
    expect(plain).not.toHaveProperty("assist_request_id");
  });
});

describe("progress event capabilities", () => {
  it("does not infer structured support from callback arity", () => {
    const zeroArg = vi.fn();
    const twoArg = (_content: string, _opts?: Record<string, any>) => {};

    expect(onProgressAcceptsToolEvents(zeroArg)).toBe(false);
    expect(onProgressAcceptsFileEditEvents(twoArg)).toBe(false);
    expect(onProgressAcceptsReasoning(twoArg)).toBe(false);
  });

  it("uses explicit capability markers", () => {
    const callback = withProgressCapabilities(vi.fn(), {
      toolEvents: true,
      fileEditEvents: true,
      reasoning: true,
    });

    expect(onProgressAcceptsToolEvents(callback)).toBe(true);
    expect(onProgressAcceptsFileEditEvents(callback)).toBe(true);
    expect(onProgressAcceptsReasoning(callback)).toBe(true);
  });
});

describe("tool progress result sanitization", () => {
  it("uses one UI identity without changing the protocol call id", () => {
    const call = { id: "provider-call-1", name: "write_file", arguments: { path: "a.ts" } };
    const start = buildToolEventStartPayload(call);
    const [finish] = buildToolEventFinishPayloads({
      toolCalls: [call],
      toolResults: ["ok"],
      toolEvents: [{ status: "ok" }],
    });

    expect(start.call_id).toBe("provider-call-1");
    expect(finish.call_id).toBe("provider-call-1");
    expect(start.ui_tool_call_id).toEqual(expect.any(String));
    expect(finish.ui_tool_call_id).toBe(start.ui_tool_call_id);
    expect(call).toEqual({ id: "provider-call-1", name: "write_file", arguments: { path: "a.ts" } });
  });

  it("replaces inline images with saved artifact references", () => {
    const sanitized = sanitizeToolEventResult([
      { type: "text", text: "page screenshot" },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,secret", detail: "auto" },
        meta: { path: "/tmp/tool-results/screenshot.png" },
      },
    ]);

    expect(sanitized).toEqual({
      result: [
        { type: "text", text: "page screenshot" },
        { type: "text", text: "[image: /tmp/tool-results/screenshot.png]" },
      ],
      files: ["/tmp/tool-results/screenshot.png"],
    });
    expect(JSON.stringify(sanitized)).not.toContain("base64");
  });

  it("keeps the model result separate from the sanitized frontend trace", () => {
    const original = [
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,abc", detail: "auto" },
        meta: { path: "/tmp/screenshot.png" },
      },
    ];

    const [payload] = buildToolEventFinishPayloads({
      toolCalls: [{ id: "call-1", name: "browser_take_screenshot", arguments: {} }],
      toolResults: [original],
      toolEvents: [{ status: "ok" }],
    });

    expect(payload.result).toEqual([
      { type: "text", text: "[image: /tmp/screenshot.png]" },
    ]);
    expect(payload.files).toEqual(["/tmp/screenshot.png"]);
    expect(original[0].image_url.url).toContain("base64,abc");
  });
});
