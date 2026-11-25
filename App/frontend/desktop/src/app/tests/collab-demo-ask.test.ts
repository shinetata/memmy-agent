/**
 * 引导第二步的发请求：首次发送与「再试一次」共用同一条路。
 *
 * 这里只测那条共用路径本身（挂哪条任务、先撤回、再新建），界面上的按钮与卡片在宿主/页面测试里。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollabClient } from "../../api/collab-client.js";
import {
  registerDemoAskSurface,
  resetDemoAskSurfaceForTest,
  startDemoGuideAsk
} from "../collab-demo-ask.js";
import {
  DEMO_GUIDE_COPY_FALLBACK,
  getDemoGuideState,
  resetDemoGuideStore,
  setDemoGuideStateForTest,
  type DemoGuidePhase,
  type DemoGuideState
} from "../collab-demo-guide-store.js";

const SENTENCE = "请小饭团查一下上次分享会一共来了多少人";

function guideState(phase: DemoGuidePhase, overrides: Partial<DemoGuideState> = {}): DemoGuideState {
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
    taskChatId: null,
    askSeen: false,
    askSourceTask: null,
    askAttempt: 0,
    askRequestId: null,
    askThreadId: null,
    askDelivered: false,
    scan: { status: "idle", count: 0 },
    prefill: null,
    endReason: null,
    cloudEnded: false,
    ...overrides
  };
}

function client(overrides: Partial<CollabClient> = {}): CollabClient {
  return {
    assistThreads: vi.fn().mockResolvedValue({ threads: [] }),
    createAssistRequest: vi.fn().mockResolvedValue({ request: { id: "req-1" }, threadId: "thread-1", text: "" }),
    ...overrides
  } as unknown as CollabClient;
}

describe("the demo guide's assist request", () => {
  beforeEach(() => {
    resetDemoGuideStore();
    resetDemoAskSurfaceForTest();
  });

  afterEach(() => {
    resetDemoGuideStore();
    resetDemoAskSurfaceForTest();
  });

  it("creates a task in the demo project first when the first step left none", async () => {
    // 第一步被跳过：没有现成的任务，先建一条属于演示项目的，再把请求挂在它上面。
    const createTask = vi.fn().mockResolvedValue("chat-new");
    const openTask = vi.fn();
    registerDemoAskSurface({ openTask, openDraft: vi.fn(), createTask });
    const collab = client();
    setDemoGuideStateForTest(guideState("ask-compose"), collab);

    const sent = await startDemoGuideAsk({ client: collab, sentence: SENTENCE, failureReason: "没发出去。" });

    expect(sent).toBe(true);
    expect(createTask).toHaveBeenCalledWith({ localProjectId: "local-1", text: SENTENCE });
    expect(collab.createAssistRequest).toHaveBeenCalledWith({
      project: "cloud-1",
      member: "9001",
      title: SENTENCE,
      items: [SENTENCE],
      sourceTask: "chat-new"
    });
    const state = getDemoGuideState();
    expect(state.phase).toBe("ask-waiting");
    expect(state.askSourceTask).toBe("chat-new");
    expect(state.askRequestId).toBe("req-1");
    expect(state.askThreadId).toBe("thread-1");
    expect(state.askSeen).toBe(true);
    // 任务由建任务那一步打开，这里不必再开一次。
    expect(openTask).not.toHaveBeenCalled();
  });

  it("reuses the task the first step created instead of making another", async () => {
    const createTask = vi.fn().mockResolvedValue("chat-other");
    const openTask = vi.fn();
    registerDemoAskSurface({ openTask, openDraft: vi.fn(), createTask });
    const collab = client();
    setDemoGuideStateForTest(guideState("ask-compose", { taskChatId: "chat-7", askSourceTask: "chat-7" }), collab);

    await startDemoGuideAsk({ client: collab, sentence: SENTENCE, failureReason: "没发出去。" });

    expect(createTask).not.toHaveBeenCalled();
    expect(openTask).toHaveBeenCalledWith("chat-7");
    expect(collab.createAssistRequest).toHaveBeenCalledWith(expect.objectContaining({ sourceTask: "chat-7" }));
  });

  it("hangs the first request on the task the first step sent, before anything recorded a source task", async () => {
    // 真实流程里第一步只记下 taskChatId，askSourceTask 要到请求建出来才有：第一次发送必须认 taskChatId。
    const createTask = vi.fn().mockResolvedValue("chat-other");
    const openTask = vi.fn();
    registerDemoAskSurface({ openTask, openDraft: vi.fn(), createTask });
    const collab = client();
    setDemoGuideStateForTest(guideState("ask-compose", { taskChatId: "chat-7", askSourceTask: null }), collab);

    await startDemoGuideAsk({ client: collab, sentence: SENTENCE, failureReason: "没发出去。" });

    expect(createTask).not.toHaveBeenCalled();
    expect(collab.createAssistRequest).toHaveBeenCalledWith(expect.objectContaining({ sourceTask: "chat-7" }));
  });

  it("withdraws the request still running before sending the next one", async () => {
    // 超时重试时上一条可能还开着：云端不允许同时跑两条，先撤回再新建。
    const order: string[] = [];
    const collab = client({
      assistThreads: vi.fn().mockImplementation(() => {
        order.push("list");
        return Promise.resolve({
          threads: [{
            threadId: "thread-1",
            requester: { userId: "1", name: "我", mine: true },
            executor: { userId: "9001", name: "小饭团", mine: false },
            requests: [{ id: "req-stuck", status: "running" }]
          }]
        });
      }),
      cancelAssist: vi.fn().mockImplementation(() => {
        order.push("cancel");
        return Promise.resolve({ id: "req-stuck", status: "cancelled" });
      }),
      createAssistRequest: vi.fn().mockImplementation(() => {
        order.push("create");
        return Promise.resolve({ request: { id: "req-2" }, threadId: "thread-2", text: "" });
      })
    });
    setDemoGuideStateForTest(
      guideState("ask-waiting", { askSourceTask: "chat-7", askRequestId: "req-stuck", askThreadId: "thread-1", error: "等了太久还没有结果。" }),
      collab
    );

    const sent = await startDemoGuideAsk({ client: collab, sentence: SENTENCE, failureReason: "没发出去。" });

    expect(sent).toBe(true);
    expect(order).toEqual(["list", "cancel", "create"]);
    expect(collab.createAssistRequest).toHaveBeenCalledWith(expect.objectContaining({ sourceTask: "chat-7" }));
    expect(getDemoGuideState().askRequestId).toBe("req-2");
    expect(getDemoGuideState().askAttempt).toBe(1);
  });

  it("keeps the task it made when the request fails, so a retry does not make another", async () => {
    const createTask = vi.fn().mockResolvedValue("chat-new");
    registerDemoAskSurface({ openTask: vi.fn(), openDraft: vi.fn(), createTask });
    const collab = client({ createAssistRequest: vi.fn().mockRejectedValue(new Error("boom")) });
    setDemoGuideStateForTest(guideState("ask-compose"), collab);

    const sent = await startDemoGuideAsk({ client: collab, sentence: SENTENCE, failureReason: "没发出去。" });

    expect(sent).toBe(false);
    const failed = getDemoGuideState();
    expect(failed.phase).toBe("ask-compose");
    expect(failed.error).toBe("没发出去。");
    // 任务记下来了：再点一次只重发请求，不会又开一条任务。
    expect(failed.askSourceTask).toBe("chat-new");

    (collab.createAssistRequest as ReturnType<typeof vi.fn>).mockResolvedValue({ request: { id: "req-2" }, threadId: "thread-2", text: "" });
    await startDemoGuideAsk({ client: collab, sentence: SENTENCE, failureReason: "没发出去。" });
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(getDemoGuideState().phase).toBe("ask-waiting");
  });

  it("does not send two requests when the button is clicked twice", async () => {
    const createAssistRequest = vi.fn().mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve({ request: { id: "req-1" }, threadId: "thread-1", text: "" }), 10);
    }));
    const collab = client({ createAssistRequest });
    setDemoGuideStateForTest(guideState("ask-compose", { askSourceTask: "chat-7" }), collab);

    const [first, second] = await Promise.all([
      startDemoGuideAsk({ client: collab, sentence: SENTENCE, failureReason: "没发出去。" }),
      startDemoGuideAsk({ client: collab, sentence: SENTENCE, failureReason: "没发出去。" })
    ]);

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(createAssistRequest).toHaveBeenCalledTimes(1);
  });

  it("does nothing outside the asking screens", async () => {
    const collab = client();
    setDemoGuideStateForTest(guideState("reply-done"), collab);
    expect(await startDemoGuideAsk({ client: collab, sentence: SENTENCE, failureReason: "没发出去。" })).toBe(false);
    expect(collab.createAssistRequest).not.toHaveBeenCalled();
  });
});
