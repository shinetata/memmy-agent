/**
 * 引导的宿主：挂在应用根部，负责推进引导与调用云端的协作接口。
 *
 * 蒙版与卡片在 {@link CollabDemoGuideOverlay}；这里做四件事：
 * 1. 按当前子状态轮询协助（第二步等结果、第三步等请求与执行结果），不靠定时器猜步骤；
 * 2. 该换页面时换页面（请成员协助前回那条任务、请完回看板的项目设置）；看板导览全程不换页；
 * 3. 演示一停就叫云端结束，并在离开看板或关窗时尽力发送；
 * 4. 完成弹窗关掉后把人放回这个项目的看板「协助」，两条记录都在眼前。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CollabClient } from "../../api/collab-client.js";
import { requestAssistFocus } from "../../app/collab-assist-focus.js";
import {
  cancelDemoAskRequest,
  demoAskStatusIsOpen,
  openDemoAskTask,
  startDemoGuideAsk
} from "../../app/collab-demo-ask.js";
import { requestDemoGuideInvite } from "../../app/collab-demo-guide-invite.js";
import {
  demoGuideBackTarget,
  demoGuideLivesOnTaskPage,
  demoGuideStepNumberOf,
  dispatchDemoGuide,
  endDemoGuide,
  getDemoGuideState,
  isDemoGuideActive,
  subscribeDemoGuide
} from "../../app/collab-demo-guide-store.js";
import { loadCollabProjects } from "../../app/collab-projects-store.js";
import { useTranslation } from "../../i18n/use-translation.js";
import { CollabDemoGuideOverlay } from "./collab-demo-guide-overlay.js";
import styles from "./collab-demo-guide.module.css";

/** 第二步等结果、第三步等请求与执行结果时的轮询间隔：够快，也不至于一直打本机接口。 */
export const DEMO_GUIDE_POLL_MS = 1_500;

/** 等小饭团的请求最多等这么久：超时就按「这一步没有完成」处理，不让人卡在蒙版里。 */
const HELP_REQUEST_TIMEOUT_MS = 30_000;

/**
 * 第二步本次请求建出来之后的时限：这么久还没有结果就不再干等。
 *
 * 云端回放一般十几秒写完，本机每 5 秒送回一次，合起来远不到这里的时限。
 */
export const ASK_FINISH_TIMEOUT_MS = 60_000;


export function CollabDemoGuideHost(props: {
  collab: CollabClient | null;
  /** 当前路由：只在看板与对话页之间时不算离开。 */
  route: string;
  /** 打开某个本机项目的看板。 */
  openBoard: (localProjectId: string) => void;
  /** 回对话页（当前那条任务）：关联任务之后要继续在任务里发消息。 */
  openTaskPage: () => void;
  /** 当前开着的看板是哪个本机项目（不在看板时为空）：换到别的项目就算离开。 */
  boardProjectId: string | null;
  /** 一次性提示（如「体验已结束」）：引导跨页面，提示也由自己显示。 */
  onNotice: (message: string) => void;
}) {
  const { t } = useTranslation();
  const state = useSyncExternalStore(subscribeDemoGuide, getDemoGuideState, getDemoGuideState);
  /** 上层每次渲染都给新的函数：放进 ref，轮询不因此重启。 */
  const openBoardRef = useRef(props.openBoard);
  openBoardRef.current = props.openBoard;
  const openTaskPageRef = useRef(props.openTaskPage);
  openTaskPageRef.current = props.openTaskPage;
  const noticeRef = useRef(props.onNotice);
  noticeRef.current = props.onNotice;
  const collabRef = useRef(props.collab);
  collabRef.current = props.collab;
  /** 第三步那条请求的 id：允许之后去那条任务，完成时回看板要展开的就是它。 */
  const helpThreadRef = useRef<string | null>(null);
  const helpSinceRef = useRef<number | null>(null);
  /** 本次那条请求第一次读到的时间：等够时限还没有结果就不再干等。 */
  const askRequestSinceRef = useRef<{ id: string; at: number } | null>(null);
  /** 演示是否带着一个云端项目：从有到无（完成 / 退出 / 离开 / 心跳超时）要立刻把看板数据重读一遍。 */
  const demoOwnedProjectRef = useRef(false);
  /** 云端说演示已结束时已经提示过，避免每次重画都再提示一次。 */
  const cloudEndedNoticedRef = useRef(false);
  /** 引导自己的一句话提示（如「体验已结束」）：蒙版可能在任何页面，提示不依赖看板。 */
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (notice === null) return undefined;
    const timer = setTimeout(() => setNotice(null), 2_400);
    return () => clearTimeout(timer);
  }, [notice]);

  // 演示期间离开看板与对话页（去了设置、首页等），或者在看板里换到了别的项目：按「离开」结束，小饭团随之退出。
  // 只在演示项目的看板真正打开过之后才判断：刚创建时本机项目还没绑好、页面还停在旧看板或别的页面，
  // 那一小段时间不是「离开」，否则从别的项目看板上新建时演示会在一秒内被结束。
  const demoBoardSeenRef = useRef(false);
  useEffect(() => {
    if (state.status !== "active") {
      demoBoardSeenRef.current = false;
      return;
    }
    if (!demoBoardSeenRef.current) {
      if (props.route === "/collab" && state.localProjectId && props.boardProjectId === state.localProjectId) {
        demoBoardSeenRef.current = true;
      }
      return;
    }
    if (props.route !== "/collab" && props.route !== "/main") {
      void endDemoGuide("left");
      return;
    }
    if (props.route === "/collab" && props.boardProjectId && props.boardProjectId !== state.localProjectId) {
      void endDemoGuide("left");
    }
  }, [props.route, props.boardProjectId, state.status, state.localProjectId]);

  // 关窗或退出 Memmy：尽力发送一次结束，发不出去靠云端的心跳超时兜底。
  useEffect(() => {
    if (state.status !== "active") return undefined;
    const leave = () => {
      void endDemoGuide("left");
    };
    window.addEventListener("beforeunload", leave);
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("beforeunload", leave);
      window.removeEventListener("pagehide", leave);
    };
  }, [state.status]);

  // 第二步要回那条任务里发：第一步留下的任务，或第一步被跳过时新开的一张演示项目草稿。
  // 每个阶段只拉一次：人自己走开一下再回来，不至于被反复拽回去。
  const navigatedPhaseRef = useRef<string | null>(null);
  useEffect(() => {
    if (state.status !== "active") {
      navigatedPhaseRef.current = null;
      return;
    }
    // 第二步的输入框、请求卡片与结果都得在那条任务里：只切路由不够，还要把那条任务真的打开。
    // 换任务会把已经填好的那句话收回去，所以打开之后补填一次。
    if (state.phase === "ask-compose" && navigatedPhaseRef.current !== "ask-compose") {
      navigatedPhaseRef.current = "ask-compose";
      void openDemoAskTask({ taskChatId: state.taskChatId, localProjectId: state.localProjectId })
        .then((opened) => {
          if (opened) dispatchDemoGuide({ type: "refill" });
        });
    }
  }, [state.status, state.phase, state.taskChatId, state.localProjectId]);

  // 第二步（请成员协助）结束后回到看板：第三步那条请求要人在看板上接。
  // 只看「等请求」刚出现的那一拍：人自己走开一下再回来，不至于被反复拽回去。
  const openedBoardForWaitRef = useRef<string | null>(null);
  useEffect(() => {
    if (state.status !== "active" || state.phase !== "help-waiting") {
      openedBoardForWaitRef.current = null;
      return;
    }
    if (!state.localProjectId) return;
    if (openedBoardForWaitRef.current === state.localProjectId) return;
    openedBoardForWaitRef.current = state.localProjectId;
    if (props.route === "/collab") return;
    openBoardRef.current(state.localProjectId);
  }, [state.phase, state.status, state.localProjectId, props.route]);

  // 第二步等结果、第三步等请求：按固定间隔读一次，拿到结果就推进。
  useEffect(() => {
    if (state.status !== "active" || !props.collab) return undefined;
    const phase = state.phase;
    if (phase !== "ask-waiting" && phase !== "help-waiting" && phase !== "help-dialog" && phase !== "help-running") return undefined;
    if (!state.projectId) return undefined;
    const client = props.collab;
    const projectId = state.projectId;
    const memberUserId = state.memberUserId;
    /** 第二步本次发出的那条请求：只认它，不再按「最新的那次排查」猜。 */
    const askRequestId = state.askRequestId;
    const askThreadId = state.askThreadId;
    let cancelled = false;

    /** 第二步：引导自己发出的那条请求跑到哪一步了。 */
    const readAskOutcome = async (requestId: string, threadId: string) => {
      const detail = await client.assistThread(projectId, threadId);
      const latest = detail.thread.requests.find((item) => item.id === requestId);
      if (!latest) {
        // 这条请求找不到了（演示结束、云端清理）：这一步没有可等的结果。
        dispatchDemoGuide({ type: "fail", reason: t("collab.demo.failed.request") });
        return;
      }
      const seen = askRequestSinceRef.current;
      // 本次这条请求第一次被读到：记下时间，时限从这里算。
      const first = seen?.id !== latest.id;
      const since = first ? Date.now() : seen!.at;
      askRequestSinceRef.current = { id: latest.id, at: since };
      if (latest.status === "done") {
        // 写完不算这一步成了：本机每 5 秒把结果送回那条任务，送达之后 `deliveredAt` 才有值，
        // 任务里那一轮 Agent 也才开始接着回复。送达是「结果真的到了」的证据。
        if (latest.deliveredAt) dispatchDemoGuide({ type: "assist-delivered" });
      } else if (!demoAskStatusIsOpen(latest.status)) {
        // 已经结束、却不是带着结果结束的：撤回的、被停下的、被拒的、失败的、过期的，都不是这一步做成了。
        const stopped = latest.status === "stopped" || latest.status === "cancelled";
        dispatchDemoGuide({
          type: "fail",
          reason: t(stopped ? "collab.demo.failed.stopped" : "collab.demo.failed.request")
        });
        return;
      }
      // 回放一般十几秒就完：迟迟没有结果就不再干等，也不把已经送达的那一轮当成超时。
      if (!latest.deliveredAt && Date.now() - since > ASK_FINISH_TIMEOUT_MS) {
        dispatchDemoGuide({ type: "fail", reason: t("collab.demo.failed.timeout") });
      }
    };

    /** 第三步：演示成员发来的那条请求，以及它的执行结果。 */
    const readHelp = async () => {
      const listing = await client.assistThreads(projectId);
      const thread = listing.threads.find((item) => item.executor.mine && item.requester.userId === memberUserId);
      if (!thread) return;
      helpThreadRef.current = thread.threadId;
      const latest = thread.requests[0];
      if (!latest) return;
      if (phase === "help-dialog") {
        if (latest.status === "running" || latest.status === "confirm") {
          dispatchDemoGuide({ type: "help-decided", allow: true });
          // 演示里允许之后要进那条 Memmy 任务（由协助宿主打开，它才知道任务 id）：
          // 这里不再把人按在看板的「协助」上。
          if (isDemoGuideActive()) return;
          // 由外部 Agent 执行时没有 Memmy 任务：回看板展开这一次。
          requestAssistFocus({ projectId, threadId: thread.threadId });
          if (state.localProjectId) openBoardRef.current(state.localProjectId);
          return;
        }
        if (latest.status === "rejected" || latest.status === "expired" || latest.status === "cancelled") {
          dispatchDemoGuide({ type: "help-decided", allow: false });
        }
        return;
      }
      if (phase === "help-running") {
        if (latest.status === "done") {
          dispatchDemoGuide({ type: "help-finished" });
          return;
        }
        if (latest.status === "failed" || latest.status === "stopped") {
          dispatchDemoGuide({ type: "fail", reason: latest.failure || t("collab.demo.failed.help") });
        }
      }
    };

    /** 第三步：等演示成员发来那个请求。 */
    const readHelpRequest = async () => {
      const inbox = await client.assistInbox();
      const found = inbox.requests.some((item) => item.requester.userId === memberUserId);
      if (found) {
        helpSinceRef.current = null;
        dispatchDemoGuide({ type: "help-request-seen" });
        return;
      }
      // 30 秒还没等到：说明这一步没走通，给出重试与跳过，不让人卡在蒙版里。
      const started = helpSinceRef.current ?? Date.now();
      helpSinceRef.current = started;
      if (Date.now() - started > HELP_REQUEST_TIMEOUT_MS) {
        dispatchDemoGuide({ type: "fail", reason: t("collab.demo.failed.noRequest", { name: state.memberName }) });
      }
    };

    const run = async () => {
      try {
        if (phase === "ask-waiting") {
          // 没有记下具体是哪条请求就不猜：请求只由引导自己建，没记到就是还没发出去。
          if (askRequestId && askThreadId) await readAskOutcome(askRequestId, askThreadId);
        } else if (phase === "help-waiting") await readHelpRequest();
        else await readHelp();
      } catch {
        // 本机接口短暂不可用：下一轮再读。
      }
    };

    void run();
    const timer = setInterval(() => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void run();
    }, DEMO_GUIDE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [state.status, state.phase, state.projectId, state.memberUserId, state.localProjectId, state.memberName, state.askRequestId, state.askThreadId, props.collab, t]);

  /**
   * 演示带着一个云端项目、随后收场（完成 / 退出 / 离开 / 心跳超时）：立刻重读项目列表，
   * 成员数与任务列表不必等下一次轮询，蒙版下面不会留着「2 位成员」。
   */
  useEffect(() => {
    const owning = (state.status === "active" || state.status === "complete") && Boolean(state.projectId);
    const ended = demoOwnedProjectRef.current && !owning;
    demoOwnedProjectRef.current = owning;
    if (!ended) return;
    const client = collabRef.current;
    if (client) void loadCollabProjects(client);
  }, [state.status, state.projectId]);

  // 心跳或请求说演示已结束（云端返回 `demo: null`）：直接收场，并告诉用户体验已经结束。
  useEffect(() => {
    if (!state.cloudEnded || cloudEndedNoticedRef.current) return;
    cloudEndedNoticedRef.current = true;
    setNotice(t("collab.demo.ended"));
    noticeRef.current(t("collab.demo.ended"));
  }, [state.cloudEnded, t]);

  // 换了一步就重新计时：第三步从「开启接收」之后算起。
  // 重试（清掉 error）同样重新计一次：不然刚点完重试就立刻又报同一句。
  useEffect(() => {
    helpSinceRef.current = null;
  }, [state.phase, state.error]);

  // 换了这一屏、或第二步又发了一次：上一条请求的出现时间不再算数。
  // 不跟 error 一起清：报了「等了太久」之后每拍还会读到同一条请求，清了就等于从头再等一遍。
  useEffect(() => {
    askRequestSinceRef.current = null;
  }, [state.phase, state.askAttempt]);

  // 第二句只预填用户看到的那一句话：那句话里「请某某做什么」由云端剧本给，不在这边另写一份。
  const askPrefill = () => t("collab.demo.prefill.ask", { name: state.memberName, ask: state.copy.askSentence });

  /** 退回上一屏时要重新填进输入框的那句话：退到哪一屏就给哪一屏的句子，其余屏不带。 */
  const backPrefill = () => {
    const target = demoGuideBackTarget(state);
    if (target === "compose") return t("collab.demo.prefill.task", { name: state.memberName, next: state.copy.taskNext });
    if (target === "ask-compose") return askPrefill();
    return undefined;
  };

  /**
   * 撤回第二步已经发出去的那条请求。
   *
   * @param tellWhenFailed 没撤回来时要不要说一声：人点「上一步」要告诉他可能已经发出去了，
   *   点「跳过这一步」则不必再拦一下。
   */
  const recallAskRequest = async (tellWhenFailed: boolean) => {
    const client = props.collab;
    const projectId = state.projectId;
    const memberUserId = state.memberUserId;
    if (!client || !projectId || !memberUserId) return;
    const cancelled = await cancelDemoAskRequest(client, projectId, memberUserId);
    // 撤不回来（已经跑完、本机接口不通）就实说，不要装作已经收回去了。
    if (!cancelled && tellWhenFailed) setNotice(t("collab.demo.recallFailed"));
  };

  /**
   * 第二步出错后直接重新发起一次请求，与首次发送走同一条路（见 `collab-demo-ask`）。
   *
   * 撤回后的重发本来就是白发的，回放没有成本，所以可以再发一次；任务仍是已经记下的那一条，
   * 结果会送回同一条任务，跟第一次发出去的效果一样。
   */
  const retryAsk = async () => {
    const client = props.collab;
    if (!client) return;
    await startDemoGuideAsk({
      client,
      sentence: askPrefill(),
      failureReason: t("collab.demo.failed.request")
    });
  };

  /**
   * 退回上一屏时把这一步已经做出去的事收回来，并把页面/弹窗恢复到那一屏该有的样子。
   *
   * 先换屏再收回：收回都是异步的，屏幕上不该先闪一句「正在停止」。
   * 换完屏再停那一轮 Agent（在 home-page），它结束时就对不上任何一屏了，不会被当成「做完」或「没完成」。
   */
  const onBack = () => {
    const phase = state.phase;
    const target = demoGuideBackTarget(state);
    dispatchDemoGuide({ type: "back", prefill: backPrefill() });
    // 退回去的那一屏在哪个页面，就先把人放回那个页面：任务里的屏留在看板上、看板上的屏留在任务页，
    // 蒙版都会因为找不到锚点而一片空白（看起来就是「引导消失了」）。
    if (target) {
      if (demoGuideLivesOnTaskPage(target)) {
        if (props.route !== "/main") openTaskPageRef.current();
      } else if (props.route !== "/collab" && state.localProjectId) {
        openBoardRef.current(state.localProjectId);
      }
    }
    // 第二步的请求已经建出来了：撤回来。不撤的话云端照样把结果写回去，人重发一次就多一份。
    if (phase === "ask-waiting") {
      void recallAskRequest(true);
      return;
    }
    // 「接收协助请求」不在这里收回：它默认就是开着的（第三步等请求时会补开一次），
    // 退回去把它关掉才是把人自己的设置改坏了。
  };

  return (
    <>
    <CollabDemoGuideOverlay
      state={state}
      onSkipJoinEntry={() => dispatchDemoGuide({ type: "skip-join-entry" })}
      onBack={onBack}
      onNext={() => {
        dispatchDemoGuide(state.phase === "joined"
          // 加入那一屏的主按钮是「继续」：与旧的「开始体验」同一个事件，进看板导览。
          ? { type: "joined-confirmed" }
          : {
            type: "next",
            // 第一步做完就直接请成员协助：那句话在进入这一步时才填；看板导览段与建项目之前不预填任何东西。
            prefill: state.phase === "reply-done" ? askPrefill() : undefined
          });
      }}
      onSkip={() => {
        const phase = state.phase;
        dispatchDemoGuide(phase === "tour-associate-pick"
          // 「关联会话」不是一步，而是导览里的一站：跳过它只往下一站走，不结束整轮演示。
          ? { type: "pass" }
          : {
            type: "skip",
            // 跳过第一步就直接去请成员协助：那句话要跟着填上。导览段与后两步都不预填。
            prefill: demoGuideStepNumberOf(phase) === 1 ? askPrefill() : undefined
          });
        // 第二步的请求可能已经在云端跑：一并撤回来，不撤的话那份结果还会自己回到任务里。
        // 撤不回来也不必拦人，他已经跳过了。
        if (phase === "ask-compose" || phase === "ask-waiting") void recallAskRequest(false);
      }}
      onGrant={() => dispatchDemoGuide({ type: "grant-access" })}
      onExit={() => void endDemoGuide("exited")}
      onRetry={() => {
        // 第二步出错后直接重发一次请求：与首次发送同一条路，回放没有成本。
        if (state.phase === "ask-compose" || state.phase === "ask-waiting") {
          void retryAsk();
          return;
        }
        dispatchDemoGuide({ type: "retry" });
      }}
      onCloseComplete={() => {
        // 完成弹窗关掉：回这个项目的看板。
        // 不再展开那次协助的详情：演示一收场，小饭团的会话与协助记录都会删掉，
        // 展开一个刚被删掉的东西只会让人看到一片空。
        const localProjectId = state.localProjectId;
        dispatchDemoGuide({ type: "close-complete" });
        if (!localProjectId) return;
        openBoardRef.current(localProjectId);
      }}
      onInvite={() => {
        requestDemoGuideInvite();
        if (state.localProjectId) openBoardRef.current(state.localProjectId);
        dispatchDemoGuide({ type: "close-complete" });
      }}
    />
    {notice ? <div className={styles.notice} role="status">{notice}</div> : null}
    </>
  );
}

/** 演示是否正压在这个项目上：看板据此压住授权询问与就地提示。 */
export function useDemoGuideActiveFor(localProjectId: string | null): boolean {
  const state = useSyncExternalStore(subscribeDemoGuide, getDemoGuideState, getDemoGuideState);
  if (!localProjectId || state.status !== "active") return false;
  return state.localProjectId === localProjectId;
}

/** 全局是否在演示中：其他大卡与提示据此不出现。 */
export function useDemoGuideActive(): boolean {
  const state = useSyncExternalStore(subscribeDemoGuide, getDemoGuideState, getDemoGuideState);
  return state.status === "active";
}

export { isDemoGuideActive };
