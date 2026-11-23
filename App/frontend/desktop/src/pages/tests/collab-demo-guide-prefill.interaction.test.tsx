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
    askSeen: false,
    askDelivered: false,
    askTurnEnded: false,
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
