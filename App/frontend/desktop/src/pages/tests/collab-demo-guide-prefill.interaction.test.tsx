// @vitest-environment happy-dom

/**
 * 引导第二步写进输入框的那句话，只能在「请求成员协助」这一屏里存在。
 *
 * 用户报过：跳过第二步之后点「新建任务」，新的空白输入框里躺着上一句请求——像一条还没发生的请求。
 * 两道关都要挡住：
 * - 离开第二步（跳过、退回、进第三步、演示结束）立刻清掉那句话；
 * - 换了任务时，上一张输入框里那句引导写的话也收回来，新任务是空的。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppClients } from "../../api/client-types.js";
import { AppProviders, useApiClients, type ApiClientsContextValue } from "../../app/providers.js";
import { agentActions, appActions } from "../../state/app-actions.js";
import { useAppState, type AppStateContextValue } from "../../state/app-state.js";
import {
  DEMO_GUIDE_COPY_FALLBACK,
  getDemoGuideState,
  resetDemoGuideStore,
  setDemoGuideStateForTest,
  type DemoGuidePhase,
  type DemoGuideState
} from "../../app/collab-demo-guide-store.js";
import { HomePage } from "../home-page.js";
import { mockBootstrap } from "./fixtures/bootstrap.js";

const runtime = vi.hoisted(() => ({
  connection: {
    getReadyGeneration: vi.fn(() => 1),
    submitMessage: vi.fn(() => Promise.resolve()),
    // 退回上一屏会停掉那一轮 Agent：这里只需要它存在，不必真做。
    stop: vi.fn(),
    newChat: vi.fn(() => Promise.resolve({ chatId: "chat-new", modelPreset: "default" })),
    onStatusResult: vi.fn(() => () => undefined),
    onHistoryDagResult: vi.fn(() => () => undefined),
    onChat: vi.fn(() => () => undefined)
  },
  ensureChatSubscription: vi.fn(),
  taskStateCoordinator: { refreshTaskState: vi.fn(), mutateProject: vi.fn() }
}));

vi.mock("../../app/agent-runtime-bridge.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../app/agent-runtime-bridge.js")>(),
  useAgentRuntimeBridge: () => runtime
}));

/** 第二步的请求直接走本机接口：这里只记下它收到了什么，别真去发 HTTP。 */
const collab = vi.hoisted(() => ({
  createAssistRequest: vi.fn(),
  assistThreads: vi.fn(),
  cancelAssist: vi.fn(),
  setTaskSharing: vi.fn(),
  /** 引导一活动，应用根部就会读这两个列表；这里给空值，免得它去连本机后端。 */
  listProjects: vi.fn(),
  listProjectTasks: vi.fn()
}));

vi.mock("../../api/collab-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/collab-client.js")>();
  return {
    ...actual,
    // 只用得到协助相关的那几个：其余方法给一个什么都不做、也不会炸的实现。
    createHttpCollabClient: () => new Proxy(collab, {
      get: (target, property) => (
        property in target ? target[property as keyof typeof target] : () => Promise.resolve(undefined)
      )
    })
  };
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 第二步那句请求：与 i18n `collab.demo.prefill.ask` 拼出来的一致。 */
const ASK_SENTENCE = "请小饭团查一下上次分享会一共来了多少人";

function guideState(phase: DemoGuidePhase, extra: Partial<DemoGuideState> = {}): DemoGuideState {
  return {
    status: "active",
    phase,
    projectId: "cloud-1",
    localProjectId: "local-1",
    memberUserId: "9001",
    memberName: "小饭团",
    copy: DEMO_GUIDE_COPY_FALLBACK,
    error: null,
    done: { task: true, ask: false, help: false },
    skipped: { task: false, ask: false, help: false },
    taskChatId: "chat-1",
    askSeen: true,
    askSourceTask: "chat-1",
    askAttempt: 1,
    askRequestId: "req-1",
    askThreadId: "thread-1",
    askDelivered: false,
    scan: { status: "idle", count: 0 },
    prefill: null,
    endReason: null,
    cloudEnded: false,
    ...extra
  };
}

describe("the demo guide's prefilled sentence", () => {
  let container: HTMLDivElement;
  let root: Root;
  let app: AppStateContextValue;
  let api: ApiClientsContextValue;

  function ObserveContexts() {
    app = useAppState();
    api = useApiClients();
    return null;
  }

  function composer(): HTMLTextAreaElement {
    const input = container.querySelector<HTMLTextAreaElement>(".home-empty-composer textarea");
    expect(input, "空白页输入框应已渲染").toBeTruthy();
    return input!;
  }

  async function mount(): Promise<void> {
    await act(async () => root.render(<AppProviders><ObserveContexts /><HomePage /></AppProviders>));
    await act(async () => {
      api.setClients({
        runtimeConfig: {},
        memmyAgent: {
          readWorkspaceEnvironment: vi.fn().mockResolvedValue(null),
          listSlashCommands: vi.fn().mockResolvedValue([])
        }
      } as unknown as AppClients);
      app.dispatch(appActions.bootstrapLoaded({
        ...mockBootstrap,
        app: { ...mockBootstrap.app, language: "zh-CN", userMode: "byok" }
      }, "/main"));
      app.dispatch(agentActions.sessionSnapshotApplied({
        projectRegistryState: "ready",
        projects: [],
        sessions: []
      }));
    });
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 40)));
  }

  /** 把引导推到某个状态，并等界面跟着走一遍。 */
  async function step(state: DemoGuideState | null): Promise<void> {
    await act(async () => setDemoGuideStateForTest(state));
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 40)));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    collab.createAssistRequest.mockResolvedValue({ request: { id: "req-new" }, threadId: "thread-new", text: "" });
    collab.assistThreads.mockResolvedValue({ threads: [] });
    collab.listProjects.mockResolvedValue({ projects: [] });
    collab.listProjectTasks.mockResolvedValue([]);
    resetDemoGuideStore();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    resetDemoGuideStore();
    container.remove();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it("fills the sentence on the ask screen and drops it once that step is skipped", async () => {
    await mount();
    // 进入第二步：引导把要发的那句话写好。
    await step(guideState("ask-compose", { prefill: { text: ASK_SENTENCE, nonce: 1 } }));
    expect(composer().value).toBe(ASK_SENTENCE);

    // 跳过第二步：这一屏没了，那句话也不该留在输入框里。
    await step(guideState("help-waiting"));
    expect(composer().value).toBe("");
  });

  it("drops the sentence when the person goes back to the previous step", async () => {
    await mount();
    await step(guideState("ask-compose", { prefill: { text: ASK_SENTENCE, nonce: 1 } }));
    expect(composer().value).toBe(ASK_SENTENCE);

    // 退回上一步（第二步完成那一屏）：那句话还没有发出去，不该跟着回去。
    await step(guideState("reply-done"));
    expect(composer().value).toBe("");
  });

  it("drops the sentence when the walkthrough ends", async () => {
    await mount();
    await step(guideState("ask-compose", { prefill: { text: ASK_SENTENCE, nonce: 1 } }));
    expect(composer().value).toBe(ASK_SENTENCE);

    await step(null);
    expect(composer().value).toBe("");
  });

  it("does not carry the sentence into a new task", async () => {
    await mount();
    await step(guideState("ask-compose", { prefill: { text: ASK_SENTENCE, nonce: 1 } }));
    expect(composer().value).toBe(ASK_SENTENCE);

    // 用户直接点「新建任务」：新的空白输入框必须是空的。
    await act(async () => app.dispatch(agentActions.newChatRequested()));
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 40)));
    expect(composer().value).toBe("");
  });

  /** 连接就绪：发送按钮只在连着的时候可点。 */
  async function connect(): Promise<void> {
    await act(async () => {
      app.dispatch(agentActions.wsEventReceived({ event: "ready", connection_generation: 1 }));
      app.dispatch(agentActions.recoveryFinished(1));
    });
  }

  it("sends the request itself instead of handing the sentence to the agent", async () => {
    // 这一步不再经过用户的 Agent 与 CLI：点发送就是引导直接建一条请求，结果送回这条任务。
    await mount();
    await connect();
    await step(guideState("ask-compose", { prefill: { text: ASK_SENTENCE, nonce: 1 } }));
    const send = container.querySelector<HTMLButtonElement>('[data-demo-guide="composer-send"]');
    expect(send, "发送按钮应已渲染").toBeTruthy();
    expect(send!.disabled).toBe(false);

    await act(async () => {
      send!.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(collab.createAssistRequest).toHaveBeenCalledWith({
      project: "cloud-1",
      member: "9001",
      title: ASK_SENTENCE,
      items: [ASK_SENTENCE],
      sourceTask: "chat-1"
    });
    // 没有把这句话交给 Agent：那一轮模型调用不该发生。
    expect(runtime.connection.submitMessage).not.toHaveBeenCalled();
    // 发出去了，输入框里那句话就清掉。
    expect(composer().value).toBe("");
    expect(getDemoGuideState().phase).toBe("ask-waiting");
  });

  it("keeps the sentence and says so when the request cannot be created", async () => {
    await mount();
    await connect();
    collab.createAssistRequest.mockRejectedValueOnce(new Error("boom"));
    await step(guideState("ask-compose", { prefill: { text: ASK_SENTENCE, nonce: 1 } }));
    const send = container.querySelector<HTMLButtonElement>('[data-demo-guide="composer-send"]');
    await act(async () => {
      send!.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(getDemoGuideState().error).toBe("协助请求没有发出去。");
    // 没发出去那句话还在：人可以直接再点一次发送。
    expect(composer().value).toBe(ASK_SENTENCE);
    expect(runtime.connection.submitMessage).not.toHaveBeenCalled();
  });

  it("locks the composer while the sentence is the request itself", async () => {
    // 那句话由引导写好：改了就与请求、与那条任务的第一句对不上，所以这一屏只留发送可用。
    await mount();
    await step(guideState("ask-compose", { prefill: { text: ASK_SENTENCE, nonce: 1 } }));
    expect(composer().readOnly).toBe(true);

    await step(guideState("reply-done"));
    expect(composer().readOnly).toBe(false);
  });

  it("finishes the asking step once the result is back and the agent stays idle", async () => {
    await mount();
    // 结果已经送回任务、Agent 也没有在写：闲几秒就收尾，卡片不会一直停在「已发出」。
    await step(guideState("ask-waiting", { askSeen: true, askDelivered: true }));
    expect(getDemoGuideState().phase).toBe("ask-waiting");

    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 4_400)));
    expect(getDemoGuideState().phase).toBe("ask-done");
    expect(getDemoGuideState().done.ask).toBe(true);
  });

  it("keeps what the person typed instead of the guide's sentence", async () => {
    await mount();
    await step(guideState("ask-compose", { prefill: { text: ASK_SENTENCE, nonce: 1 } }));
    const input = composer();
    // 人自己改了内容：离开这一屏时不能把他写的东西也清掉。
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(input, "我自己写的一句话");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await step(guideState("help-waiting"));
    expect(composer().value).toBe("我自己写的一句话");
  });
});
