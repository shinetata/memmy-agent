/**
 * 新手引导第二步的发请求：首次发送与「再试一次」共用同一条路。
 *
 * 这一步不再经过用户的 Agent 与 `memmy-project` CLI：一句话说完就直接调本机接口建一条协助请求，
 * 云端把内容换成剧本并回放结果，结果经 `sourceTask` 回到那条任务，用户的 Agent 再接着回一轮。
 * 两处调用（任务输入框的发送、卡片上的「再试一次」）都走 {@link startDemoGuideAsk}，
 * 「挂在哪条任务上」「先撤回上一条」这些规则只写一份。
 */
import type { CollabClient } from "../api/collab-client.js";
import { dispatchDemoGuide, getDemoGuideState } from "./collab-demo-guide-store.js";

/** 请求还在进行中：既没结果，也不算结束。 */
export function demoAskStatusIsOpen(status: string | undefined): boolean {
  return status === "pending" || status === "running" || status === "confirm";
}

/**
 * 引导第二步要用到的页面能力。
 *
 * 引导自己不知道界面在哪个页面，也不该自己拼新建任务的那一整套：由应用根部（`app-frame`）注册，
 * 任务输入框的发送与卡片上的重试都从这里取。
 */
export interface DemoAskSurface {
  /**
   * 打开某条任务（已经在它上面时什么都不做）：输入框、请求卡片与结果都得在它里面。
   *
   * @returns 真的换了任务时为 true：换任务会把已经填好的句子收回去，调用方据此再填一次。
   */
  openTask(chatId: string): Promise<boolean> | boolean;
  /** 在演示项目里开一张新建任务的草稿：第一步被跳过时，第二步没有现成的任务可挂。 */
  openDraft(localProjectId: string): void;
  /**
   * 在演示项目里新建一条任务（首条消息是那句话，标题也是它），并打开它。
   *
   * @returns 新任务的会话 id；建不出来时为 null。
   */
  createTask(input: { localProjectId: string; text: string }): Promise<string | null>;
}

/**
 * 已经注册的页面能力。可能同时有两个应用外壳（保活挂载的那份也会渲染根部），
 * 所以按栈记：最后注册的那个最接近用户正在看的界面，退订时只摘掉自己。
 */
const surfaces: DemoAskSurface[] = [];

/** 注册页面能力，返回退订函数。 */
export function registerDemoAskSurface(surface: DemoAskSurface): () => void {
  surfaces.push(surface);
  return () => {
    const index = surfaces.indexOf(surface);
    if (index >= 0) surfaces.splice(index, 1);
  };
}

function currentSurface(): DemoAskSurface | null {
  return surfaces[surfaces.length - 1] ?? null;
}

/**
 * 进入第二步时把要发那句话的那条任务打开。
 *
 * 第一步做过就用它的任务（已经在上面时什么也不做）；第一步被跳过时没有现成的任务，
 * 先开一张属于演示项目的新任务草稿，发送时再真的建出这条任务。
 *
 * @returns 换了页面（打开了另一条任务或另一张草稿）时为 true。
 */
export async function openDemoAskTask(input: { taskChatId: string | null; localProjectId: string | null }): Promise<boolean> {
  const surface = currentSurface();
  if (!surface) return false;
  if (input.taskChatId) return Boolean(await surface.openTask(input.taskChatId));
  if (!input.localProjectId) return false;
  surface.openDraft(input.localProjectId);
  return true;
}

export interface StartDemoGuideAskInput {
  client: CollabClient;
  /** 输入框里那句话：请求的标题与条目，云端会换成剧本。 */
  sentence: string;
  /** 发起失败时卡片上那句话（由调用方按当前语言给）。 */
  failureReason: string;
}

/** 发起期间挡住重复点击：连点两下不该在云端建出两条请求。 */
let starting = false;

/**
 * 发出第二步的请求。
 *
 * 步骤：确定挂在哪条任务上（第一步那条，或新开的那条）→ 撤回上一条还在执行的 →
 * 新建一条带 `sourceTask` 的请求 → 记进引导状态进入等结果。
 * 失败时把原因交给卡片（「这一步没有完成」+「再试一次」），已经确定的任务照旧记着，
 * 重试时不必再建一条。
 *
 * @returns 请求建出来了。
 */
export async function startDemoGuideAsk(input: StartDemoGuideAskInput): Promise<boolean> {
  if (starting) return false;
  const state = getDemoGuideState();
  if (state.status !== "active") return false;
  if (state.phase !== "ask-compose" && state.phase !== "ask-waiting") return false;
  if (!state.projectId || !state.memberUserId) return false;
  starting = true;
  try {
    const surface = currentSurface();
    // 重试沿用上一次记下的任务；第一次发时用第一步留下的那条（第一步被跳过时两者都为空，下面新建）。
    let sourceTask = state.askSourceTask ?? state.taskChatId;
    if (!sourceTask) {
      if (!state.localProjectId || !surface) {
        dispatchDemoGuide({ type: "fail", reason: input.failureReason });
        return false;
      }
      sourceTask = await surface.createTask({ localProjectId: state.localProjectId, text: input.sentence });
      if (!sourceTask) {
        dispatchDemoGuide({ type: "fail", reason: input.failureReason });
        return false;
      }
      // 任务先记进状态：建请求失败时「再试一次」还得挂回这一条，不能又开一条任务。
      dispatchDemoGuide({ type: "ask-task", chatId: sourceTask });
    } else {
      // 已经在别的任务上时把它打开：卡片与结果都在这条任务里。
      await surface?.openTask(sourceTask);
    }
    // 上一条可能还挂在执行中：云端不允许同时开两条，先撤掉。撤不回来照常往下走，
    // 新请求会以现有的「只配合一次」被拒，那时卡片报「这一步没有完成」。
    await cancelDemoAskRequest(input.client, state.projectId, state.memberUserId);
    try {
      const created = await input.client.createAssistRequest({
        project: state.projectId,
        member: state.memberUserId,
        title: input.sentence,
        items: [input.sentence],
        sourceTask
      });
      dispatchDemoGuide({
        type: "ask-sent",
        requestId: created.request.id,
        threadId: created.threadId,
        sourceTask
      });
      return true;
    } catch {
      dispatchDemoGuide({ type: "fail", reason: input.failureReason });
      return false;
    }
  } finally {
    starting = false;
  }
}

/**
 * 撤回第二步已经发出去的那条协助请求。
 *
 * 返回 false 表示没撤回来（已经跑完、本机接口不通，或云端不允许撤）：那时界面要说「已经发出去了」，
 * 不能当作撤回成功。根本没建出请求也算收回成功：没有东西留在云端。
 */
export async function cancelDemoAskRequest(
  client: CollabClient,
  projectId: string,
  memberUserId: string
): Promise<boolean> {
  let requestId: string;
  try {
    const listing = await client.assistThreads(projectId);
    // 撤「还在进行」的那一条：更早的（被撤回的、上一次失败的）已经结束了，不必再撤。
    const open = listing.threads.find((item) => (
      item.requester.mine && item.executor.userId === memberUserId && demoAskStatusIsOpen(item.requests[0]?.status)
    ));
    const latest = open?.requests[0];
    if (!latest) return true;
    requestId = latest.id;
  } catch {
    // 读不到就没法确认它跑到哪了：按没撤回来处理，让人知道可能已经发出去了。
    return false;
  }
  try {
    await client.cancelAssist(requestId);
    return true;
  } catch {
    return false;
  }
}

/** 预览与测试用：清掉注册的页面能力。 */
export function resetDemoAskSurfaceForTest(): void {
  surfaces.length = 0;
  starting = false;
}
