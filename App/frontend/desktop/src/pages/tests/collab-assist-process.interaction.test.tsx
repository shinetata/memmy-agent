// @vitest-environment happy-dom

/**
 * 任务会话里的「执行过程」：不管对方用哪个 Agent，发起方在任务里就能展开看每一步。
 *
 * 三件必须成立的事：默认收起（排在会话里，展开着会把模型正文挤下去）；折叠着不发请求；点开才读。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistRequest, CollabClient } from "../../api/collab-client.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { AssistProcessBlock } from "../collab-assist-process.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TRANSCRIPT = [
  { kind: "text" as const, text: "先确认版本，再查日志。" },
  {
    kind: "tool" as const,
    name: "运行命令 sw_vers",
    input: "sw_vers",
    output: "ProductVersion:\t15.6",
    status: "done" as const
  }
];

function request(overrides: Partial<AssistRequest> = {}): AssistRequest {
  return {
    id: "r-1",
    projectId: "p-1",
    threadId: "th-1",
    status: "running",
    ...overrides
  } as unknown as AssistRequest;
}

function collab(transcript = TRANSCRIPT): CollabClient & { detail: ReturnType<typeof vi.fn> } {
  const detail = vi.fn(async (_projectId: string, _threadId: string) => ({
    thread: { requests: [{ id: "r-1", transcript }] },
    serverTime: null
  }));
  return { assistThread: detail, detail } as unknown as CollabClient & { detail: ReturnType<typeof vi.fn> };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
  }
}

describe("the assist process inside a task", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function render(client: CollabClient, assistRequest: AssistRequest): Promise<void> {
    root = createRoot(container);
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <AssistProcessBlock collab={client} request={assistRequest} />
        </I18nProvider>
      );
    });
    await flush();
  }

  it("stays folded while it is running, then shows what the other side did once opened", async () => {
    const client = collab();
    await render(client, request({ status: "running" }));
    const toggle = container.querySelector<HTMLElement>("[data-collab-assist-process-toggle]");
    // 排进会话里时默认收起：模型正文就在它下面，不能一上来就被挡住。
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(client.detail).not.toHaveBeenCalled();

    await act(async () => toggle!.click());
    await flush();
    expect(client.detail).toHaveBeenCalledWith("p-1", "th-1");
    expect(container.textContent).toContain("运行命令 sw_vers");
    expect(container.textContent).toContain("2 步");
  });

  it("names the member and the agent that ran it, so it does not read as local steps", async () => {
    // 这一段紧跟发起方自己的「执行了 N 步」：只写「执行过程」会被读成本机做的。
    const client = collab();
    await render(client, request({
      status: "done",
      agent: "memmy",
      executor: { userId: "u-2", name: "孙起", mine: false }
    } as Partial<AssistRequest>));
    expect(container.textContent).toContain("孙起的 Memmy 执行过程");
  });

  it("falls back to the plain title when the request has no executor", async () => {
    const client = collab();
    await render(client, request({ status: "done", agent: "memmy" }));
    expect(container.textContent).toContain("执行过程");
    expect(container.textContent).not.toContain("undefined");
  });

  it("does not offer the entry before it starts running, and reads nothing", async () => {
    const client = collab();
    await render(client, request({ status: "pending" }));
    expect(container.querySelector("[data-collab-assist-process-toggle]")).toBeNull();
    expect(client.detail).not.toHaveBeenCalled();
  });

  it("reads the steps only when the person opens it after the request finished", async () => {
    const client = collab();
    await render(client, request({ status: "done" }));
    expect(client.detail).not.toHaveBeenCalled();
    const toggle = container.querySelector<HTMLElement>("[data-collab-assist-process-toggle]")!;
    await act(async () => toggle.click());
    await flush();
    expect(client.detail).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("运行命令 sw_vers");
  });

  it("keeps the entry when the other side left nothing behind", async () => {
    const client = collab([]);
    await render(client, request({ status: "done" }));
    const toggle = container.querySelector<HTMLElement>("[data-collab-assist-process-toggle]")!;
    await act(async () => toggle.click());
    await flush();
    expect(container.textContent).toContain("这次没有留下执行过程");
  });
});
