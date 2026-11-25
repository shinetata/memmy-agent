// @vitest-environment happy-dom

/**
 * 引导宿主的两件硬要求：
 *
 * - 授权必须是人自己点的：请求到了、但还没处理时，卡片停在那儿等，不替人允许。
 * - 失败必须说出来：第二步这一轮已经结束、又过了时限仍然没有那一条请求，或者那一条确实被拒/失败，
 *   才切「这一步没有完成」；Agent 还在跑时绝不判失败，请求后来出现也不再卡在失败卡片上。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollabClient } from "../../../api/collab-client.js";
import { DEMO_GUIDE_COPY_FALLBACK, type DemoGuideState } from "../../../app/collab-demo-guide-store.js";
import {
  dispatchDemoGuide,
  getDemoGuideState,
  resetDemoGuideStore,
  setDemoGuideStateForTest
} from "../../../app/collab-demo-guide-store.js";
import { registerDemoAskSurface, resetDemoAskSurfaceForTest } from "../../../app/collab-demo-ask.js";
import { I18nProvider } from "../../../i18n/i18n-provider.js";
import { CollabDemoGuideHost } from "../collab-demo-guide-host.js";

const store = vi.hoisted(() => ({ loadCollabProjects: vi.fn() }));

vi.mock("../../../app/collab-projects-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../app/collab-projects-store.js")>();
  return { ...actual, loadCollabProjects: store.loadCollabProjects };
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MEMBER = { userId: "9001", name: "小饭团", mine: false };
const ME = { userId: "1", name: "孙起", mine: true };

/** 一条从「引导所在的这一步」出发的状态：项目 id 与本机项目 id 都是固定的。 */
function demoState(phase: DemoGuideState["phase"], overrides: Partial<DemoGuideState> = {}): DemoGuideState {
  return {
    status: "active",
    phase,
    projectId: "cloud-1",
    localProjectId: "local-1",
    memberUserId: "9001",
    memberName: "小饭团",
    copy: DEMO_GUIDE_COPY_FALLBACK,
error: null,
    done: { task: false, ask: false, help: false },
    skipped: { task: false, ask: false, help: false },
    taskChatId: "chat-1",
    askSeen: true,
    askSourceTask: "chat-1",
    askAttempt: 1,
    askRequestId: "req-1",
    askThreadId: "thread-ask",
    askDelivered: false,
    scan: { status: "done", count: 0 },
    prefill: null,
    endReason: null,
    cloudEnded: false,
    ...overrides
  };
}

/**
 * 第二步：引导自己发出的那条请求所在的排查。
 *
 * `deliveredAt` 是结果被送回任务的时间：没有它就只是一份写好、还没送回来的结果。
 */
function askThread(
  status: "pending" | "running" | "done" | "failed" | "stopped" | "cancelled",
  options: { requestId?: string; threadId?: string; deliveredAt?: string | null } = {}
) {
  return {
    threadId: options.threadId ?? "thread-ask",
    requester: ME,
    executor: MEMBER,
    projectId: "cloud-1",
    title: "查一下上次分享会来了多少人",
    updatedAt: "2026-11-14T07:00:00.000Z",
    requests: [{
      id: options.requestId ?? "req-1",
      status,
      title: "查一下上次分享会来了多少人",
      deliveredAt: options.deliveredAt ?? null
    }]
  };
}

/** 打开一次排查的回应：`readAskOutcome` 按它认本次那条请求。 */
function askDetail(status: Parameters<typeof askThread>[0], options: Parameters<typeof askThread>[1] = {}) {
  return { thread: askThread(status, options), serverTime: null };
}

/** 第三步：演示成员发来、由我执行的请求。 */
function helpThread(status: "pending" | "running" | "done" | "failed", failure?: string) {
  return {
    threadId: "thread-help",
    requester: MEMBER,
    executor: ME,
    projectId: "cloud-1",
    title: "确认这台电脑的系统版本",
    updatedAt: "2026-11-14T07:00:00.000Z",
    requests: [{ id: "req-2", status, title: "确认这台电脑的系统版本", ...(failure ? { failure } : {}) }]
  };
}

function client(overrides: Partial<CollabClient>): CollabClient {
  return {
    assistThreads: vi.fn().mockResolvedValue({ threads: [], maxThreads: 20 }),
    assistInbox: vi.fn().mockResolvedValue({ requests: [] }),
    ...overrides
  } as unknown as CollabClient;
}

/** 在页面上挂一个 `data-demo-guide` 锚点，位置固定：happy-dom 里量不出布局，只能自己给。 */
function stubAnchor(name: string, box: { left: number; top: number; width: number; height: number }): void {
  const element = document.createElement("button");
  element.setAttribute("data-demo-guide", name);
  element.getBoundingClientRect = (() => ({
    ...box,
    x: box.left,
    y: box.top,
    right: box.left + box.width,
    bottom: box.top + box.height,
    toJSON: () => box
  })) as unknown as typeof element.getBoundingClientRect;
  document.body.append(element);
}

describe("the demo guide host", () => {
  let container: HTMLDivElement;
  let root: Root;
  let unregisterSurface: (() => void) | null = null;

  async function mount(
    collab: CollabClient,
    state: DemoGuideState,
    options: {
      route?: string;
      openBoard?: (localProjectId: string) => void;
      openTaskPage?: () => void;
      onNotice?: (message: string) => void;
      /** 引导第二步要用的页面能力：打开某条任务、开一张演示项目的新任务草稿。 */
      surface?: { openTask?: () => void; openDraft?: () => void; createTask?: () => Promise<string | null> };
    } = {}
  ): Promise<void> {
    // 每挂一次都换一份注册：上一个用例的出口不能留在下一份里。
    unregisterSurface = registerDemoAskSurface({
      openTask: options.surface?.openTask ?? vi.fn(),
      openDraft: options.surface?.openDraft ?? vi.fn(),
      createTask: options.surface?.createTask ?? (async () => null)
    });
    setDemoGuideStateForTest(state, collab);
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <CollabDemoGuideHost
            collab={collab}
            route={options.route ?? "/main"}
            boardProjectId={null}
            openBoard={options.openBoard ?? vi.fn()}
            openTaskPage={options.openTaskPage ?? vi.fn()}
            onNotice={options.onNotice ?? vi.fn()}
          />
        </I18nProvider>
      );
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetDemoGuideStore();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    unregisterSurface?.();
    unregisterSurface = null;
    resetDemoAskSurfaceForTest();
    container.remove();
    for (const element of Array.from(document.querySelectorAll("[data-demo-guide]"))) element.remove();
    resetDemoGuideStore();
    vi.useRealTimers();
  });

  it("reads the request the guide sent, not the latest one in the project", async () => {
    // 请求由引导自己建，id 已知：只认这一条，撤回或做完的那几条不会被当成本次的结果。
    const assistThread = vi.fn().mockResolvedValue(askDetail("running", { requestId: "req-9", threadId: "thread-9" }));
    const collab = client({ assistThread });
    await mount(collab, demoState("ask-waiting", { askRequestId: "req-9", askThreadId: "thread-9" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(assistThread).toHaveBeenCalledWith("cloud-1", "thread-9");
    // 还在跑：不能当成结果已回，也不能报错。
    expect(getDemoGuideState().error).toBeNull();
    expect(getDemoGuideState().askDelivered).toBe(false);
  });

  it("counts a rejected request as a step that did not finish", async () => {
    const assistThread = vi.fn().mockResolvedValue(askDetail("pending"));
    const collab = client({ assistThread });
    await mount(collab, demoState("ask-waiting"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    // 只是一条还在跑的请求：不能当成结果已回。
    expect(getDemoGuideState().error).toBeNull();
    expect(getDemoGuideState().askDelivered).toBe(false);

    assistThread.mockResolvedValue(askDetail("failed"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(getDemoGuideState().error).toBe("协助请求没有发出去。");
    expect(getDemoGuideState().done.ask).toBe(false);
  });

  it("fails the step when the request it sent has disappeared", async () => {
    // 请求被云端删掉（演示结束、清理）：这一步没有可等的结果，不能一直停在「已发出」。
    const assistThread = vi.fn().mockResolvedValue(askDetail("running", { requestId: "req-other" }));
    await mount(client({ assistThread }), demoState("ask-waiting"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(getDemoGuideState().error).toBe("协助请求没有发出去。");
  });

  it("waits for the person to allow the request instead of allowing it for her", async () => {
    const threads = { threads: [helpThread("pending")], maxThreads: 20 };
    const collab = client({ assistThreads: vi.fn().mockResolvedValue(threads) });
    await mount(collab, demoState("help-dialog"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    // 请求到了但还没处理：卡片留在「由你决定」这一步，不替人点允许。
    expect(getDemoGuideState().phase).toBe("help-dialog");

    threads.threads = [helpThread("running")];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(getDemoGuideState().phase).toBe("help-running");
  });

  it("says the assist failed rather than finished", async () => {
    const collab = client({
      assistThreads: vi.fn().mockResolvedValue({ threads: [helpThread("failed", "Agent 没有完成这次执行")], maxThreads: 20 })
    });
    await mount(collab, demoState("help-running"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(getDemoGuideState().phase).toBe("help-running");
    expect(getDemoGuideState().error).toBe("Agent 没有完成这次执行");
    expect(getDemoGuideState().done.help).toBe(false);
  });

  it("opens the walkthrough on the board with the join card and waits for the person", async () => {
    // 加入那一屏走看板蒙版：亮区套住成员徐章，卡片在旁边说这次由小饭团加入。
    stubAnchor("board-members", { left: 640, top: 48, width: 72, height: 26 });
    await mount(client({}), demoState("joined"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
    });
    expect(document.querySelector("[data-demo-join]")).toBeNull();
    expect(document.querySelector("[data-demo-mask]")).not.toBeNull();
    expect(document.body.textContent).toContain("项目里还没有其他成员。这次先由我加入项目，带你完成一次协作。");
    expect(document.body.textContent).not.toContain("跳过这一步");
    expect(getDemoGuideState().phase).toBe("joined");

    const start = Array.from(document.querySelectorAll("button")).find((entry) => entry.textContent?.trim() === "继续");
    await act(async () => start?.click());
    // 点完先进看板导览：第一步的蒙版此时才出现。
    expect(getDemoGuideState().phase).toBe("tour-board");
  });

  it("skips the join entry when the dialog does not show the join button", async () => {
    // API Key 模式下没有「加入项目」：不能把气泡指向空处，直接进「创建项目」。
    await mount(client({}), demoState("join-entry"));
    expect(getDemoGuideState().phase).toBe("create-project");
  });

  it("stays on the join entry while the join button is on screen", async () => {
    stubAnchor("create-join", { left: 320, top: 620, width: 88, height: 30 });
    await mount(client({}), demoState("join-entry"));
    expect(getDemoGuideState().phase).toBe("join-entry");
  });

  it("stays on the board for the whole tour and never pulls the page around", async () => {
    const openBoard = vi.fn();
    const openTaskPage = vi.fn();
    await mount(client({}), demoState("tour-new-task"), { openBoard, openTaskPage, route: "/collab", boardProjectId: "local-1" });
    // 导览全程停在同一个看板上：既不换页，也不把对话页拉回来。
    expect(openBoard).not.toHaveBeenCalled();
    expect(openTaskPage).not.toHaveBeenCalled();
  });

  it("opens the task the first step created when the asking screen starts", async () => {
    // 第二步的输入框、请求卡片与结果都得在第一步那条任务里：只切路由不够，还要真的把它打开。
    const openTask = vi.fn();
    const openDraft = vi.fn();
    await mount(client({}), demoState("ask-compose", { taskChatId: "chat-7" }), {
      route: "/collab",
      surface: { openTask, openDraft }
    });
    expect(openTask).toHaveBeenCalledWith("chat-7");
    expect(openDraft).not.toHaveBeenCalled();
  });

  it("opens a draft in the demo project when the first step was skipped", async () => {
    // 没有现成的任务：不要挂在用户当时打开的其他任务上，而是在演示项目里开一张新任务草稿。
    const openTask = vi.fn();
    const openDraft = vi.fn();
    await mount(client({}), demoState("ask-compose", { taskChatId: null, skipped: { task: true, ask: false, help: false } }), {
      route: "/main",
      surface: { openTask, openDraft }
    });
    expect(openDraft).toHaveBeenCalledWith("local-1");
    expect(openTask).not.toHaveBeenCalled();
  });

  it("drops back on the board once the completion dialog is closed", async () => {
    const openBoard = vi.fn();
    await mount(client({}), demoState("complete", { status: "complete", done: { task: true, ask: true, help: true } }), { openBoard });
    const finish = Array.from(document.querySelectorAll("button")).find((entry) => entry.textContent?.trim() === "完成");
    await act(async () => finish?.click());
    // 第三步是在任务页里做完的：关掉完成弹窗回到这个项目的看板，两条记录留在眼前。
    expect(openBoard).toHaveBeenCalledWith("local-1");
    expect(getDemoGuideState().status).toBe("ended");
  });

  it("rereads the project list the moment the demo ends", async () => {
    const collab = client({});
    await mount(collab, demoState("help-done"));
    store.loadCollabProjects.mockClear();

    await act(async () => {
      dispatchDemoGuide({ type: "end", reason: "exited" });
    });
    // 成员数、任务列表不等下一轮轮询：蒙版一收就重读。
    expect(store.loadCollabProjects).toHaveBeenCalledWith(collab);
  });

  it("cancels the request it already sent when the person goes back", async () => {
    // 第二步已经发出去了：不退回来的话小饭团照样去执行，人重发一次就执行两遍。
    const cancelAssist = vi.fn().mockResolvedValue({ id: "req-1", status: "cancelled" });
    const collab = client({
      assistThreads: vi.fn().mockResolvedValue({ threads: [askThread("pending")] }),
      cancelAssist
    });
    stubAnchor("conversation", { left: 100, top: 60, width: 1000, height: 620 });
    await mount(collab, demoState("ask-waiting"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    const back = Array.from(document.querySelectorAll("button"))
      .find((entry) => entry.textContent?.trim() === "上一步");
    expect(back).toBeTruthy();
    await act(async () => {
      back?.click();
      await Promise.resolve();
    });

    expect(getDemoGuideState().phase).toBe("ask-compose");
    expect(cancelAssist).toHaveBeenCalledWith("req-1");
  });

  it("keeps receiving on when the person goes back out of the third step", async () => {
    // 「接收协助请求」默认开着：退回去不能把它关掉，那等于把人自己的设置改坏了。
    const setAssistReceiving = vi.fn().mockResolvedValue({ enabled: true });
    const collab = client({ setAssistReceiving });
    stubAnchor("board-main", { left: 100, top: 60, width: 1000, height: 620 });
    await mount(collab, demoState("help-waiting"));
    // 等蒙版量到锚点、把卡片画出来（真机上靠每帧重算）。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    const back = Array.from(document.querySelectorAll("button"))
      .find((entry) => entry.textContent?.trim() === "上一步");
    await act(async () => {
      back?.click();
      await Promise.resolve();
    });

    expect(getDemoGuideState().phase).toBe("ask-done");
    // 只补开、不关：退回去时一次 `false` 都不能写。
    expect(setAssistReceiving).not.toHaveBeenCalledWith("cloud-1", false);
  });

  it("refills the sentence when the person backs into the first step's composer", async () => {
    await mount(client({}), demoState("reply-waiting"));
    stubAnchor("conversation", { left: 100, top: 60, width: 1000, height: 620 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    const back = Array.from(document.querySelectorAll("button"))
      .find((entry) => entry.textContent?.trim() === "上一步");
    await act(async () => {
      back?.click();
    });
    // 回到输入框，那句话重新填上（nonce 换一个，输入框才知道要再填一次）。
    expect(getDemoGuideState().phase).toBe("compose");
    expect(getDemoGuideState().prefill?.text).toContain("接着");
    expect(getDemoGuideState().prefill?.nonce).toBeGreaterThan(0);
  });

  it("goes back to the page the previous screen lives on", async () => {
    // 「等小饭团发来请求」那一屏在看板上，上一屏是第二步的结果（「协助请求已返回」）：它在任务里。
    // 不跳回去的话，`conversation` 锚点在看板上根本不存在，蒙版就一片空白（看起来就是引导没了）。
    const openTaskPage = vi.fn();
    const openBoard = vi.fn();
    stubAnchor("board-main", { left: 100, top: 60, width: 1000, height: 620 });
    await mount(client({}), demoState("help-waiting"), { route: "/collab", openTaskPage, openBoard });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    const back = Array.from(document.querySelectorAll("button"))
      .find((entry) => entry.textContent?.trim() === "上一步");
    await act(async () => {
      back?.click();
    });
    expect(getDemoGuideState().phase).toBe("ask-done");
    expect(openTaskPage).toHaveBeenCalledTimes(1);
    expect(openBoard).not.toHaveBeenCalled();
  });

  it("goes back to the board when the previous screen is the read panel", async () => {
    // 输入框那一屏在任务里，上一屏是项目看板上成员任务的只读面板：退回去要先把看板拉回来。
    const openBoard = vi.fn();
    const openTaskPage = vi.fn();
    stubAnchor("composer", { left: 300, top: 600, width: 800, height: 120 });
    stubAnchor("composer-send", { left: 1040, top: 660, width: 36, height: 36 });
    await mount(client({}), demoState("compose"), { route: "/main", openBoard, openTaskPage });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    const back = Array.from(document.querySelectorAll("button"))
      .find((entry) => entry.textContent?.trim() === "上一步");
    await act(async () => {
      back?.click();
    });
    expect(getDemoGuideState().phase).toBe("reader");
    expect(openBoard).toHaveBeenCalledWith("local-1");
    expect(openTaskPage).not.toHaveBeenCalled();
  });

  it("takes back the request when the person skips the asking step", async () => {
    // 跳过这一屏之后云端还在回放：不撤回来，那份结果照样会自己回到任务里。
    const cancelAssist = vi.fn().mockResolvedValue({ id: "req-1", status: "cancelled" });
    const collab = client({
      assistThreads: vi.fn().mockResolvedValue({ threads: [askThread("running")] }),
      cancelAssist
    });
    stubAnchor("conversation", { left: 100, top: 60, width: 1000, height: 620 });
    await mount(collab, demoState("ask-waiting"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    const skip = Array.from(document.querySelectorAll("button"))
      .find((entry) => entry.textContent?.trim() === "跳过这一步");
    expect(skip).toBeTruthy();
    await act(async () => {
      skip?.click();
      await Promise.resolve();
    });

    expect(getDemoGuideState().phase).toBe("help-waiting");
    expect(cancelAssist).toHaveBeenCalledWith("req-1");
  });

  it("says nothing when the skipped request could not be taken back", async () => {
    // 撤不回来（已经跑完、本机接口不通）也不拦人：他已经跳过了，不必再弹一句。
    const onNotice = vi.fn();
    const collab = client({
      assistThreads: vi.fn().mockResolvedValue({ threads: [askThread("running")] }),
      cancelAssist: vi.fn().mockRejectedValue(new Error("boom"))
    });
    stubAnchor("conversation", { left: 100, top: 60, width: 1000, height: 620 });
    await mount(collab, demoState("ask-waiting"), { onNotice });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    const skip = Array.from(document.querySelectorAll("button"))
      .find((entry) => entry.textContent?.trim() === "跳过这一步");
    await act(async () => {
      skip?.click();
      await Promise.resolve();
    });
    expect(getDemoGuideState().phase).toBe("help-waiting");
    expect(onNotice).not.toHaveBeenCalled();
  });

  it("sends a fresh request straight away when the person retries the asking step", async () => {
    // 再走一遍 Agent 只是重复同一段：重试直接新建一次请求，结果送回同一条任务。
    const createAssistRequest = vi.fn().mockResolvedValue({ request: {}, threadId: "thread-new", text: "" });
    const collab = client({ createAssistRequest });
    stubAnchor("conversation", { left: 100, top: 60, width: 1000, height: 620 });
    await mount(collab, demoState("ask-waiting", { error: "协助请求没有发出去。" }));

    const retry = Array.from(document.querySelectorAll("button"))
      .find((entry) => entry.textContent?.trim() === "再试一次");
    expect(retry).toBeTruthy();
    await act(async () => {
      retry?.click();
      await Promise.resolve();
    });

    expect(createAssistRequest).toHaveBeenCalledWith({
      project: "cloud-1",
      member: "9001",
      title: "请小饭团查一下上次分享会一共来了多少人",
      items: ["请小饭团查一下上次分享会一共来了多少人"],
      sourceTask: "chat-1"
    });
    expect(getDemoGuideState().error).toBeNull();
    expect(getDemoGuideState().askAttempt).toBe(2);
  });

  it("retries the first send from the card when it did not go out", async () => {
    // 首次发送失败停在输入框那一屏：卡片给「再试一次」，点了就是同一条路再发一次。
    const createAssistRequest = vi.fn().mockResolvedValue({ request: { id: "req-2" }, threadId: "thread-2", text: "" });
    const collab = client({ createAssistRequest });
    stubAnchor("composer", { left: 300, top: 600, width: 800, height: 120 });
    await mount(collab, demoState("ask-compose", {
      askSourceTask: "chat-1",
      askRequestId: null,
      askThreadId: null,
      error: "协助请求没有发出去。"
    }));

    const retry = Array.from(document.querySelectorAll("button"))
      .find((entry) => entry.textContent?.trim() === "再试一次");
    expect(retry).toBeTruthy();
    await act(async () => {
      retry?.click();
      await Promise.resolve();
    });
    expect(createAssistRequest).toHaveBeenCalledWith(expect.objectContaining({ sourceTask: "chat-1" }));
    expect(getDemoGuideState().phase).toBe("ask-waiting");
    expect(getDemoGuideState().askRequestId).toBe("req-2");
  });

  it("withdraws a request still hanging in running before it sends a fresh one", async () => {
    // 超时时上一条还开着：云端不允许在它还在执行时重发，先撤回再建。
    const order: string[] = [];
    const cancelAssist = vi.fn().mockImplementation(() => {
      order.push("cancel");
      return Promise.resolve({});
    });
    const createAssistRequest = vi.fn().mockImplementation(() => {
      order.push("create");
      return Promise.resolve({ request: {}, threadId: "thread-new", text: "" });
    });
    const collab = client({
      assistThreads: vi.fn().mockResolvedValue({ threads: [askThread("running", { requestId: "req-stuck" })] }),
      assistThread: vi.fn().mockResolvedValue(askDetail("running", { requestId: "req-1" })),
      cancelAssist,
      createAssistRequest
    });
    stubAnchor("conversation", { left: 100, top: 60, width: 1000, height: 620 });
    await mount(collab, demoState("ask-waiting"));
    // 请求一直停在执行中：等过时限，卡片给出「再试一次」。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(63_000);
    });
    expect(getDemoGuideState().error).toBe("等了太久还没有结果。");

    const retry = Array.from(document.querySelectorAll("button"))
      .find((entry) => entry.textContent?.trim() === "再试一次");
    await act(async () => {
      retry?.click();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(cancelAssist).toHaveBeenCalledWith("req-stuck");
    expect(order).toEqual(["cancel", "create"]);
  });

  it("treats a request that was stopped without the guide as unfinished", async () => {
    const assistThread = vi.fn().mockResolvedValue(askDetail("running"));
    const collab = client({ assistThread });
    await mount(collab, demoState("ask-waiting"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(getDemoGuideState().askSeen).toBe(true);

    // 不是引导撤回的、自己停下的：这一步确实没做成，给「再试一次」。
    assistThread.mockResolvedValue(askDetail("stopped"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(getDemoGuideState().error).toBe("这次请求已经停止，没有拿到结果。");
  });

  it("gives up when this attempt's request never finishes", async () => {
    const assistThread = vi.fn().mockResolvedValue(askDetail("running"));
    const collab = client({ assistThread });
    await mount(collab, demoState("ask-waiting"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    // 回放一般十几秒就完：一直跑不完就不再干等。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(getDemoGuideState().error).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(40_000);
    });
    expect(getDemoGuideState().error).toBe("等了太久还没有结果。");
    expect(getDemoGuideState().done.ask).toBe(false);
  });

  it("waits for the result to reach the task before calling the step finished", async () => {
    // 云端写完结果不等于这一步做完了：结果要先送回那条任务（`deliveredAt`），
    // 任务里那一轮 Agent 才开始接着回复。
    const assistThread = vi.fn().mockResolvedValue(askDetail("running"));
    const collab = client({ assistThread });
    stubAnchor("conversation", { left: 100, top: 60, width: 1000, height: 620 });
    await mount(collab, demoState("ask-waiting"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    assistThread.mockResolvedValue(askDetail("done"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(getDemoGuideState().askDelivered).toBe(false);
    expect(getDemoGuideState().phase).toBe("ask-waiting");

    assistThread.mockResolvedValue(askDetail("done", { deliveredAt: "2026-11-14T07:00:05.000Z" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(getDemoGuideState().askDelivered).toBe(true);
    // 送达之后还要等那一轮 Agent 结束：这一屏先留着，别抢在回复写完之前收尾。
    expect(getDemoGuideState().phase).toBe("ask-waiting");

    await act(async () => {
      dispatchDemoGuide({ type: "agent-settled" });
    });
    expect(getDemoGuideState().phase).toBe("ask-done");
    expect(getDemoGuideState().done.ask).toBe(true);
  });
});
