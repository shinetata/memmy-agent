import { ArrowUpRight, BookOpen, ChevronDown, ChevronRight, Folder, Layers, LifeBuoy, Loader2, ListChecks, MoreHorizontal, PanelRight, PanelRightClose, Plug, Plus, RefreshCw, Search, Settings, Trash2, UserPlus, Users, X } from "lucide-react";
import { memo, useCallback, useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  createHttpCollabClient,
  type AddedAgent,
  type AssistThread,
  type CollabAgentAccessView,
  type CollabClient,
  type CollabInstructionsHandover,
  type CollabKnowledgeView,
  type CollabLinks,
  type CollabProject,
  type CollabProjectSession,
  type CollabProjectTask,
  type CollabSessionPage,
  type CollabSessionTurn,
  type CollabSyncProgress,
  type CollabSyncResult,
  type LocalAgentSession,
  type LocalSessionGroup
} from "../api/collab-client.js";
import {
  addCollabProject,
  consumeTaskPickerRequest,
  dismissCollabNotice,
  getCollabProjectsSnapshot,
  loadCollabProjects,
  markCollabProjectBound,
  removeCollabProject,
  replaceCollabProject,
  requestTaskPicker,
  selectCollabProject,
  sharedProjectFor,
  subscribeCollabProjects
} from "../app/collab-projects-store.js";
import {
  dispatchDemoGuide,
  getDemoGuideState,
  subscribeDemoGuide
} from "../app/collab-demo-guide-store.js";
import {
  consumeDemoGuideInvite,
  demoGuideInvitePending,
  subscribeDemoGuideInvite
} from "../app/collab-demo-guide-invite.js";
import { requestAssistInboxRefresh } from "../app/collab-assist-refresh.js";
import type { MemmyAgentProject } from "../api/memmy-agent-client.js";
import { openAgentTaskInChat } from "../app/open-agent-task.js";
import { Memmy } from "../components/mascot/memmy.js";
import { CollabAgentChips } from "./collab-agent-chips.js";
import { sessionKeyToChatId } from "../api/memmy-agent-client.js";
import { agentActions, appActions } from "../state/app-actions.js";
import { agentChatScopeKey, shouldCreateNewAgentDraft } from "../state/agent-composer-state.js";
import type { AgentTaskView, ComposerMention } from "../state/agent-chat-slice.js";
import { useOptionalAppState, type AppStateContextValue } from "../state/app-state.js";
import { ApiRequestError } from "../api/http.js";
import { ProjectKnowledgeDialog, ProjectKnowledgeManageDialog } from "./collab-knowledge-dialog.js";
import {
  readProjectInstructions,
  saveProjectInstructions,
  type ProjectInstructions
} from "../api/projects-client.js";
import { useOptionalAgentRuntimeBridge } from "../app/agent-runtime-bridge.js";
import { formatWorkspacePath } from "../app/workspace-path.js";
import { useApiClients } from "../app/providers.js";
import { Button } from "../components/button.js";
import { ConfirmDialog } from "../components/confirm-dialog.js";
import { Modal } from "../components/modal.js";
import type { MessageKey, MessageValues } from "../i18n/messages.js";
import { useTranslation } from "../i18n/use-translation.js";
import { isComposingKeyboardEvent } from "../utils/keyboard.js";
import { AgentMessageContent, isLikelyExpensiveAgentMarkdown } from "./agent-message-content.js";
import { readableSummary } from "./collab-board-text.js";
import { agentSourceDisplayName, agentSourceLogoUrl } from "./agent-source-logos.js";
import { collabEnabledFor } from "../app/collab-mode.js";
import { CollabAgentConnectDialog } from "./collab-agent-connect-dialog.js";
import { buildCollabAgentConnectPrompt, resolveCollabConnectProjectId } from "./collab-agent-connect-prompt.js";
import { writePendingFirstEncounterTaskLaunch } from "./first-encounter-task-launch.js";
import { AppFrame } from "./app-frame.js";
import { memberColor } from "./collab-member-color.js";
import { MEMBER_REQUESTS_POLL_MS, ProjectMembersDialog } from "./collab-members-dialog.js";
import styles from "./collab-page.module.css";
import { consumeAssistFocus, getAssistFocus, subscribeAssistFocus } from "../app/collab-assist-focus.js";
import { CollabAssistConversation } from "./collab-assist-conversation.js";
import { READER_PANEL_WIDTH_STORAGE_KEY, useReaderPanelWidth } from "./collab-reader-resize.js";
import { CollabAssistProjectSettings } from "./collab-assist-settings.js";
import { InfoHint } from "./collab-info-hint.js";
import { assistAgentName, assistIsOpen, assistStatusKey } from "./collab-assist-view.js";
import { withoutDemoGuideHint } from "../lib/demo-guide-hint.js";

export { memberColor };

/** 一次性提示（如共享范围已保存）停留时长：文案短，留够看清的时间。 */
const TOAST_MS = 3_000;
/**
 * 每位成员这一段先显示几条。一个人在一个项目内最多保留 20 个任务（`SESSIONS_PER_MEMBER_LIMIT`），
 * 五条是四分之一：最多展开三次就到底；六个人各五条也仍在三屏之内，打开就能看清谁在做什么。
 */
const MEMBER_GROUP_ROWS = 5;
/**
 * 阅读面板首屏同步渲染的轮次数；之后的轮次先占位，滚到附近再展开。
 * 与聊天页的即时渲染条数同一考虑：面板高度内的那几轮必须马上有内容。
 */
const READER_IMMEDIATE_TURNS = 4;
/** 展开后续轮次的起始延迟与递增间隔：让它们分给孩子空闲时段，不扰动正在进行的操作。 */
const READER_DEFERRED_REVEAL_START_MS = 120;
const READER_DEFERRED_REVEAL_STEP_MS = 80;
/** 看板顶部的一次性提示停留时长。 */
const BOARD_NOTICE_MS = 6_000;
/**
 * 看板窄于这个宽度时，项目配置不再占一列。
 * 与 collab-page.module.css 里 `@container collab-board (max-width: 859px)` 一致。
 */
const NARROW_BOARD_PX = 860;

/** How often the board refreshes while an association uploads. */
const PROGRESS_POLL_MS = 1_200;
/** 看板开着时的刷新间隔：别的成员关联了会话，不用改筛选也能看到。 */
const BOARD_POLL_MS = 5_000;
const MAX_PROJECT_NAME_CHARS = 20;
const MAX_LOCAL_SESSIONS = 500;
/**
 * 云端每名成员在每个项目内保留的任务数（`CollabLimits.MAX_SESSIONS_PER_MEMBER`），
 * 新建的 Memmy 任务与关联的 Agent 任务共用。超出后按最近交互自动替换。
 */
const SESSIONS_PER_MEMBER_LIMIT = 20;
const EMPTY_LINKS: CollabLinks = { groups: [], sessions: [] };
/** 还没有设定指令时的空值，看板与弹窗共用。 */
const EMPTY_PROJECT_INSTRUCTIONS: ProjectInstructions = {
  text: "",
  origin: null,
  cloudProjectId: null,
  updatedAt: null
};
/**
 * 看板按成员分区：本人一段，其余成员各一段。任务行不再写昵称——同一段里每一行的成员是同一个。
 * 昵称而不是 userId 作键，与头像取色（`memberColor`）同一口径：同一个名字在段头与 @ 菜单里同色。
 */
interface MemberGroup {
  /** `me` 或 `member:<昵称>`。 */
  key: string;
  /** 段头写的名字；本人段用云端返回的昵称，缺了才退回「你」。 */
  name: string;
  mine: boolean;
  sessions: CollabProjectSession[];
  /** 这一段的最近活动时间：首次打开时按它排成员先后。 */
  latestAt: string;
}

/** 最近活动倒序：云端给的顺序不保证，段内自己排一次。 */
function byRecentActivity(left: CollabProjectSession, right: CollabProjectSession): number {
  return (right.lastActiveAt ?? "").localeCompare(left.lastActiveAt ?? "");
}

/**
 * 把一次读回来的任务按人分段。没有任务的成员不生成空段：空段叠在一起只会把列表拉长，本身没有内容可读。
 * 段的先后在这里不管，由看板按「本人第一、其余按首次出现」定一次。
 */
function groupByMember(sessions: readonly CollabProjectSession[]): MemberGroup[] {
  const mine: CollabProjectSession[] = [];
  const others = new Map<string, CollabProjectSession[]>();
  for (const session of sessions) {
    if (session.mine) {
      mine.push(session);
      continue;
    }
    const name = session.memberName || "";
    const list = others.get(name);
    if (list) list.push(session);
    else others.set(name, [session]);
  }
  const groups: MemberGroup[] = [];
  if (mine.length) {
    const sorted = [...mine].sort(byRecentActivity);
    groups.push({ key: "me", name: sorted[0]!.memberName || "", mine: true, sessions: sorted, latestAt: sorted[0]!.lastActiveAt ?? "" });
  }
  for (const [name, list] of others) {
    const sorted = [...list].sort(byRecentActivity);
    groups.push({ key: `member:${name}`, name, mine: false, sessions: sorted, latestAt: sorted[0]!.lastActiveAt ?? "" });
  }
  return groups;
}

/**
 * 看板只有一个列表：项目共享的任务。协助不在看板上另开一处，发起在成员段头上，记录在项目设置里。
 */

/** 内容没变就保留原数组，看板不必因为每 5 秒的轮询重画。 */
function sameAssistThreads(left: readonly AssistThread[], right: readonly AssistThread[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

const NO_ASSIST_THREADS: AssistThread[] = [];
const NO_ASSIST_LIMIT: { maxThreads: number | null; prunedAt: string | null } = { maxThreads: null, prunedAt: null };

/** 没有执行过的协助：每一次请求都是未允许、已撤回或已过期，只剩一行请求。 */
export function assistNeverRan(thread: AssistThread): boolean {
  return thread.requests.length > 0
    && thread.requests.every((request) => request.status === "rejected" || request.status === "cancelled" || request.status === "expired");
}

/** 等你处理的协助：你是执行人，最近一次请求在等你确认，或在等你授权且没有生效中的限时授权。 */
export function assistWaitsForMe(thread: AssistThread): boolean {
  if (!thread.executor.mine) return false;
  if (thread.status === "confirm") return true;
  return thread.status === "pending" && !thread.requests[0]?.autoRun;
}

/** 一行任务：「协助」已经不在看板上列出，这里只剩任务。 */
type BoardRow = { kind: "session"; at: string; session: CollabProjectSession };

/** How an agent organizes its sessions, which names the groups in the picker. */
export type GroupingKind = "directory" | "project" | "workspace" | "workbuddy";

export function groupingKind(sourceId: string): GroupingKind {
  if (sourceId === "codex") return "project";
  if (sourceId === "cursor") return "workspace";
  if (sourceId === "workbuddy") return "workbuddy";
  return "directory";
}

/** The name the person typed. Built-in agents keep their product name; an internal id is never shown. */
export function pickerAgentName(agent: { sourceId: string; name: string }): string {
  const typed = agent.name.trim();
  const known = agentSourceDisplayName(agent.sourceId);
  if (typed && known === agent.sourceId.trim()) return typed;
  return known || typed;
}

/** A group in the picker with the sessions of it that match the search. */
export interface SessionGroupView {
  group: LocalSessionGroup;
  sessions: LocalAgentSession[];
}

/**
 * One agent's sessions in its groups, the most recently active group first, plus those outside every group.
 * A search keeps sessions matching every keyword, and every session of a group whose name matches.
 */
export function groupAgentSessions(sessions: readonly LocalAgentSession[], sourceId: string, query: string): { groups: SessionGroupView[]; ungrouped: LocalAgentSession[] } {
  const keywords = query.toLowerCase().split(/\s+/u).filter(Boolean);
  const matches = (value: string) => keywords.every((keyword) => value.toLowerCase().includes(keyword));
  const groups = new Map<string, SessionGroupView>();
  const ungrouped: LocalAgentSession[] = [];
  const ordered = sessions
    .filter((session) => session.sourceId === sourceId)
    .sort((left, right) => Date.parse(right.updatedAt || "0") - Date.parse(left.updatedAt || "0"));
  for (const session of ordered) {
    const hit = matches(`${session.title}\n${session.lastQuestion}`);
    if (!session.group) {
      if (hit) ungrouped.push(session);
      continue;
    }
    if (!hit && !matches(session.group.label)) continue;
    const view = groups.get(session.group.id) ?? { group: session.group, sessions: [] };
    view.sessions.push(session);
    groups.set(session.group.id, view);
  }
  return { groups: [...groups.values()], ungrouped };
}

function findGroupLink(links: CollabLinks, sourceId: string, groupId: string) {
  return links.groups.find((link) => link.sourceId === sourceId && link.groupId === groupId);
}

/** Whether the picker shows a session as checked: covered by its whole group and not excluded, or linked on its own. */
export function isSessionChecked(links: CollabLinks, session: LocalAgentSession): boolean {
  const group = session.group ? findGroupLink(links, session.sourceId, session.group.id) : undefined;
  if (group) return !group.excluded.includes(session.conversationId);
  return links.sessions.some((link) => localSessionKey(link) === localSessionKey(session));
}

/** A linked whole group with exclusions is mixed; independent session selections are mixed too. */
export function groupCheckState(links: CollabLinks, sourceId: string, view: SessionGroupView): "checked" | "mixed" | "unchecked" {
  const group = findGroupLink(links, sourceId, view.group.id);
  if (group) return group.excluded.length ? "mixed" : "checked";
  return view.sessions.some((session) => isSessionChecked(links, session)) ? "mixed" : "unchecked";
}

/** Links the whole group, replacing its single-session links, or unlinks it entirely. */
export function toggleGroupLink(links: CollabLinks, sourceId: string, view: SessionGroupView): CollabLinks {
  const inGroup = new Set(view.sessions.map(localSessionKey));
  const sessions = links.sessions.filter((link) => !inGroup.has(localSessionKey(link)));
  const group = findGroupLink(links, sourceId, view.group.id);
  if (group?.excluded.length) {
    // A mixed checkbox selects the entire group on click, just like a partially selected group of sessions.
    return { groups: links.groups.map((link) => link === group ? { ...link, excluded: [] } : link), sessions };
  }
  if (group) {
    return { groups: links.groups.filter((link) => !(link.sourceId === sourceId && link.groupId === view.group.id)), sessions };
  }
  return { groups: [...links.groups, { sourceId, groupId: view.group.id, excluded: [] }], sessions };
}

/** Inside a linked group a session is excluded or included again; elsewhere it is linked on its own. */
export function toggleSessionLink(links: CollabLinks, session: LocalAgentSession): CollabLinks {
  const group = session.group ? findGroupLink(links, session.sourceId, session.group.id) : undefined;
  if (group) {
    const excluded = group.excluded.includes(session.conversationId)
      ? group.excluded.filter((id) => id !== session.conversationId)
      : [...group.excluded, session.conversationId];
    return { ...links, groups: links.groups.map((link) => (link === group ? { ...group, excluded } : link)) };
  }
  const key = localSessionKey(session);
  const linked = links.sessions.some((link) => localSessionKey(link) === key);
  return {
    ...links,
    sessions: linked
      ? links.sessions.filter((link) => localSessionKey(link) !== key)
      : [...links.sessions, { sourceId: session.sourceId, conversationId: session.conversationId }]
  };
}

function linksEqual(left: CollabLinks, right: CollabLinks): boolean {
  const canonical = (links: CollabLinks) => JSON.stringify({
    groups: links.groups.map(({ sourceId, groupId, excluded }) => [sourceId, groupId, [...excluded].sort()] as const)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    sessions: links.sessions.map(({ sourceId, conversationId }) => [sourceId, conversationId] as const)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  });
  return canonical(left) === canonical(right);
}

export function agentHasLinks(links: CollabLinks, sourceId: string): boolean {
  return links.groups.some((link) => link.sourceId === sourceId) || links.sessions.some((link) => link.sourceId === sourceId);
}

/** Month/day hour:minute, or empty when the time is unknown. */
export function formatSessionTime(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${date.getMonth() + 1}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The buckets the task list splits its rows into, newest first. */
export type TaskDayGroup = "today" | "yesterday" | "week" | "earlier";

const DAY_MS = 86_400_000;

/** Midnight of the day the moment falls on, in this computer's time zone. */
function startOfLocalDay(moment: Date): number {
  return new Date(moment.getFullYear(), moment.getMonth(), moment.getDate()).getTime();
}

/** Monday of the week the moment falls in: 本周 starts there, as the list calls it. */
function startOfLocalWeek(moment: Date): number {
  const start = new Date(moment.getFullYear(), moment.getMonth(), moment.getDate());
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return start.getTime();
}

/** Which day the row belongs to: 今天, 昨天, earlier in this week, or 更早. */
export function taskDayGroup(value: string | null, now: Date = new Date()): TaskDayGroup {
  const time = value ? Date.parse(value) : NaN;
  // A row with no usable time is grouped last rather than at the top, where it would look newest.
  if (!Number.isFinite(time)) return "earlier";
  const days = Math.round((startOfLocalDay(now) - startOfLocalDay(new Date(time))) / DAY_MS);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return time >= startOfLocalWeek(now) ? "week" : "earlier";
}

/** What a row shows on the right of its title: the hour today, the day before yesterday, the date after that. */
export type TaskStamp =
  | { kind: "time"; text: string }
  | { kind: "yesterday" }
  | { kind: "date"; month: number; day: number };

export function taskStamp(value: string | null, now: Date = new Date()): TaskStamp | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const group = taskDayGroup(value, now);
  if (group === "today") {
    const pad = (number: number) => String(number).padStart(2, "0");
    return { kind: "time", text: `${pad(date.getHours())}:${pad(date.getMinutes())}` };
  }
  if (group === "yesterday") return { kind: "yesterday" };
  return { kind: "date", month: date.getMonth() + 1, day: date.getDate() };
}

/** The stamp in the current language: 14:32, 昨天, or 10月26日. */
export function stampLabel(stamp: TaskStamp | null, t: (key: MessageKey, values?: MessageValues) => string): string {
  if (!stamp) return "";
  if (stamp.kind === "time") return stamp.text;
  if (stamp.kind === "yesterday") return t("collab.sessions.stamp.yesterday");
  return t("collab.sessions.stamp.date", { month: stamp.month, day: stamp.day });
}

/** Key that identifies a local session across agents. */
export function localSessionKey(session: { sourceId: string; conversationId: string }): string {
  return `${session.sourceId}\u0000${session.conversationId}`;
}

/** 会话行真正用到的字段：这些一样，屏上就没有变化。 */
function sessionSignature(session: CollabProjectSession): string {
  return [
    session.id,
    session.title,
    session.lastQuestion,
    session.memberName,
    session.mine ? "1" : "0",
    session.source,
    String(session.turnCount),
    session.lastActiveAt ?? "",
    session.link,
    session.shareText
  ].join("\u0000");
}

/**
 * 云端每次返回都是新对象，直接写回会让看板白重画一次。内容一致时返回值告诉调用方「不用写」。
 * 只比较画面上真正用到的字段，够用且比整串 JSON 便宜。
 */
function sameSessionPage(current: CollabSessionPage | null, next: CollabSessionPage): boolean {
  if (!current || current.total !== next.total) return false;
  if (current.sessions.length !== next.sessions.length) return false;
  for (let index = 0; index < current.sessions.length; index += 1) {
    const left = current.sessions[index];
    const right = next.sessions[index];
    if (!left || !right || sessionSignature(left) !== sessionSignature(right)) return false;
  }
  return true;
}

/** 上传进度也一样：四个数没变就不必重画进度条。 */
function sameSyncProgress(current: CollabSyncProgress | null, next: CollabSyncProgress | null): boolean {
  if (current === next) return true;
  if (!current || !next) return false;
  return current.running === next.running
    && current.total === next.total
    && current.completed === next.completed
    && current.failed === next.failed;
}

/** 空值常量：wrapper 每次都要读一遍全局状态，不能每次现造空数组把 memo 冲掉。 */
const NO_PROJECTS: MemmyAgentProject[] = [];
const NO_TASKS: AgentTaskView[] = [];
/** 还没关联任何其他 Agent 时的空列表：常量的空数组，不会把看板的 memo 冲掉。 */
const NO_ADDED_AGENTS: AddedAgent[] = [];

/**
 * The page entry: reads the two lists from app state and hands them to the board.
 * 看板只用到这两份数据。全局状态的其余部分（消息流、连接状态、界面开关）每变一次都会换掉 context 的
 * value，所以真正干活的看板是 memo 的：后台有任务输出时，它不该跟着每个事件重画一遍。
 */
export function CollabPage() {
  // 看板只用到这两份数据。全局状态的其余部分（消息流、连接状态、界面开关）每变一次都会换掉 context 的
  // value，所以真正干活的看板必须是 memo 的：后台有任务输出时，它不该跟着每个事件重画一遍。
  const appState = useOptionalAppState();
  const projects = appState?.state.agent.projects ?? NO_PROJECTS;
  const tasks = appState?.state.agent.tasks ?? NO_TASKS;
  /** API Key 模式没有云端账号：看板只显示本机项目与任务，不读共享列表、不出现成员与共享入口。 */
  const collabEnabled = collabEnabledFor(appState?.state.bootstrap?.app.userMode);
  // dispatch 的引用是稳定的，当作 prop 传下去不会把 memo 冲掉。
  const dispatch = appState?.dispatch ?? null;
  // 读最新的 agent 状态靠 ref：把它写进依赖会让回调每次都换新，看板就会跟着后台每条流式输出重画。
  const agentRef = useRef(appState?.state.agent ?? null);
  agentRef.current = appState?.state.agent ?? null;
  /**
   * 继续任务：在同一个项目下开一条新任务，并把被继续的那条任务作为引用带进去。
   * 步骤与侧栏「＋」一致（新建草稿、指定项目目标、切到对话页），只是多带一个引用片；
   * 引用沿用 @ 引用的同一套存储，落地后就是一个可移除的引用，由使用者说明要继续做什么。
   */
  const onContinueTask = useCallback((projectId: string, mention: ComposerMention | null) => {
    const agent = agentRef.current;
    if (!dispatch || !agent) return;
    const createsDraft = shouldCreateNewAgentDraft(agent);
    const nextRequestId = createsDraft ? agent.newChatRequestId + 1 : agent.newChatRequestId;
    const scopeKey = agentChatScopeKey(null, nextRequestId);
    if (createsDraft) {
      dispatch(agentActions.newChatRequested());
    } else if (!agent.blankDraftActive) {
      dispatch(agentActions.blankDraftReopened());
    }
    dispatch(agentActions.draftTargetUpdated(scopeKey, { kind: "project", projectId }));
    if (mention) {
      const existing = agent.composerMentionsByScope[scopeKey] ?? [];
      if (!existing.some((item) => item.id === mention.id)) {
        dispatch(agentActions.composerMentionsUpdated(scopeKey, [...existing, mention]));
      }
    }
    dispatch(appActions.navigate("/main"));
  }, [dispatch]);
  /**
   * 请某位成员协助：与「继续任务」同一条建草稿的路，只多带一个协助目标。
   * 点了头像就是「这次请她」，所以不再中间页确认；输入框左下角的 chip 能拿掉，拿掉就退回给 Memmy 自己。
   */
  const onAskMember = useCallback((projectId: string, member: { userId: string; name: string; projectName: string }) => {
    const agent = agentRef.current;
    if (!dispatch || !agent) return;
    const createsDraft = shouldCreateNewAgentDraft(agent);
    const nextRequestId = createsDraft ? agent.newChatRequestId + 1 : agent.newChatRequestId;
    const scopeKey = agentChatScopeKey(null, nextRequestId);
    if (createsDraft) {
      dispatch(agentActions.newChatRequested());
    } else if (!agent.blankDraftActive) {
      dispatch(agentActions.blankDraftReopened());
    }
    dispatch(agentActions.draftTargetUpdated(scopeKey, { kind: "project", projectId }));
    dispatch(agentActions.assistTargetUpdated(scopeKey, member));
    dispatch(appActions.navigate("/main"));
  }, [dispatch]);
  return (
    <CollabBoard
      dispatch={dispatch}
      projects={projects}
      tasks={tasks}
      collabEnabled={collabEnabled}
      onContinueTask={onContinueTask}
      onAskMember={onAskMember}
    />
  );
}

/**
 * The board of one project: its header and the session list. A project is local; when its sharing switch is on,
 * the sessions come from the cloud and the list also carries members and references.
 */
const CollabBoard = memo(function CollabBoard(props: {
  dispatch: AppStateContextValue["dispatch"] | null;
  projects: MemmyAgentProject[];
  tasks: AgentTaskView[];
  /** API Key 模式为 false：这一台机器上没有协作项目，看板按纯本机项目工作。 */
  collabEnabled: boolean;
  /** 在项目下开一条新任务并带上引用；引用为空时就是普通的「在此项目新建任务」。 */
  onContinueTask: (projectId: string, mention: ComposerMention | null) => void;
  /** 请某位成员协助：开一条新任务并把这位成员作为协助目标带进输入框。 */
  onAskMember: (projectId: string, member: { userId: string; name: string; projectName: string }) => void;
}) {
  const { dispatch, projects, tasks, collabEnabled, onContinueTask, onAskMember } = props;
  const { clients } = useApiClients();
  const { t } = useTranslation();
  const collab = useMemo(() => (clients ? createHttpCollabClient(clients.runtimeConfig) : null), [clients]);
  const snapshot = useSyncExternalStore(subscribeCollabProjects, getCollabProjectsSnapshot, getCollabProjectsSnapshot);
  /** 新手引导：演示正压在这个项目上，项目名、读面板与项目设置都要为它让路。 */
  const demoGuide = useSyncExternalStore(subscribeDemoGuide, getDemoGuideState, getDemoGuideState);
  const demoInvitePending = useSyncExternalStore(subscribeDemoGuideInvite, demoGuideInvitePending, demoGuideInvitePending);
  const [page, setPage] = useState<CollabSessionPage | null>(null);
  /**
   * 每段是否已展到全部；默认只显示 `MEMBER_GROUP_ROWS` 条。
   * `collapsedGroups` 是整段收起，只留段头。两者都按段键记，换项目时清空。
   */
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  /**
   * 段落的先后：本人永远第一，其余按首次出现时的顺序。
   * 每 5 秒的轮询不该重排——别人刚上传一条，你正在看的那一段就被挤走。换项目时重算。
   */
  const groupOrderRef = useRef<{ scope: string | null; order: Map<string, number> }>({ scope: null, order: new Map() });
  /**
   * 当前看的是哪一个项目的任务列表。搜索词、展开的段都归它。
   */
  const [query, setQuery] = useState("");

  const [searchDraft, setSearchDraft] = useState("");
  const [reading, setReading] = useState<{ session: CollabProjectSession; turns: CollabSessionTurn[] } | null>(null);
  /**
   * 项目里的协助：一次排查一行，只有发起人和执行人看得到（云端按本人过滤）。
   * 执行方选了外部 Agent、或发起方点开时，在右侧展开详情；由 Memmy 执行的直接进入那条任务。
   */
  const [assistThreads, setAssistThreads] = useState<AssistThread[]>(NO_ASSIST_THREADS);
  /** 项目上限说明：最近 30 天里因为超过上限清掉过较早的协助时，项目设置里的「协助记录」注明。 */
  const [assistLimit, setAssistLimit] = useState<{ maxThreads: number | null; prunedAt: string | null }>(NO_ASSIST_LIMIT);
  /** 项目设置里的「协助记录」弹窗：列出本项目我参与过的协助，点一条打开右侧详情。 */
  const [assistRecordsOpen, setAssistRecordsOpen] = useState(false);
  const [assistDetailId, setAssistDetailId] = useState<string | null>(null);
  const assistFocus = useSyncExternalStore(subscribeAssistFocus, getAssistFocus, getAssistFocus);
  const [readingId, setReadingId] = useState<string | null>(null);
  const [pickOpen, setPickOpen] = useState(false);
  /**
   * 「在其他 Agent 中使用协作项目」的授权：只在「关联会话」里就地发生，未授权时那个弹窗先给授权说明。
   */
  const [agentAccess, setAgentAccess] = useState<CollabAgentAccessView | null>(null);
  /** Choosing which of the project's own Memmy sessions members may read. */
  const [taskPickerOpen, setTaskPickerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 看板右侧的项目配置：指令等项目的配置项在这里查看与编辑，与侧栏无关。 */
  const [configOpen, setConfigOpen] = useState(true);
  /** 用户手动收起或展开后，不再随宽度自动开关。换项目时清掉。 */
  const configTouchedRef = useRef(false);
  const pageRef = useRef<HTMLDivElement>(null);
  /** 看板当前展示的项目指令：本机项目读本机文件，协作项目用云端列表里的内容。 */
  const [instructions, setInstructions] = useState<ProjectInstructions>(EMPTY_PROJECT_INSTRUCTIONS);
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  /** 项目关联的知识库：只影响本项目的检索，成员都能关联，解除限本人添加或所有者、管理员。 */
  const [knowledge, setKnowledge] = useState<CollabKnowledgeView | null>(null);
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const [knowledgeManageOpen, setKnowledgeManageOpen] = useState(false);
  /** 「邀请」in the header and「项目成员」in the sidebar menu open the same dialog. */
  const [membersOpen, setMembersOpen] = useState(false);
  /** 待审核的加入申请数：弹窗没开时也轮询，别人提交申请后「邀请」入口上直接出现角标。 */
  const [pendingRequests, setPendingRequests] = useState(0);
  const [deleting, setDeleting] = useState<CollabProjectSession | null>(null);
  /** 「协助」里要删除的那一次：删除只是从自己的列表中移除，另一方仍看得到。 */
  const [deletingAssist, setDeletingAssist] = useState<AssistThread | null>(null);
  /** 多选删除：进入选择模式后勾选本人的任务，一次移除。 */
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  /** 「全部停止」：并行执行之后执行方可能同时有多条在跑，确认一次全部停掉。 */
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  /** Upload progress of a queued association; the list grows while it runs. */
  const [progress, setProgress] = useState<CollabSyncProgress | null>(null);
  /** Bumped when an association is queued, so polling starts without waiting for a filter or page change. */
  const [pollKey, setPollKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  /** Projects whose tasks were already uploaded for this opening, so filters do not re-upload them. */
  const syncedProjectRef = useRef<Set<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * 已关联的 Agent：云端只存生成出来的 source id（added-qoder-…），名字要回本机文件拿。
   * 任务记录里没有名字可读，所以读别人的任务时用它把「谁的任务」写成人名而不是编号。
   */
  const [addedAgents, setAddedAgents] = useState<AddedAgent[]>(NO_ADDED_AGENTS);
  useEffect(() => {
    if (!collab || !collabEnabled) {
      setAddedAgents(NO_ADDED_AGENTS);
      return;
    }
    let cancelled = false;
    void collab.listAddedAgents()
      .then((agents) => {
        if (!cancelled) setAddedAgents(agents.length ? agents : NO_ADDED_AGENTS);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [collab, collabEnabled]);
  const addedAgentNames = useMemo(
    () => new Map(addedAgents.map((agent) => [agent.sourceId, agent.name])),
    [addedAgents]
  );
  const resolveAgentName = useCallback(
    (sourceId: string) => addedAgentNames.get(sourceId) ?? agentSourceDisplayName(sourceId),
    [addedAgentNames]
  );

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS);
  }, []);

  /**
   * 写回一页列表。轮询、手动刷新、上传后重读都走这里：内容与屏上一样就保留原对象，
   * 让 React 中途退出渲染，也不去动共享 store（否则侧栏会跟着重画）。
   */
  const applyPage = useCallback((next: CollabSessionPage) => {
    setPage((current) => (sameSessionPage(current, next) ? current : next));
    replaceCollabProject(next.project);
  }, []);

  useEffect(() => {
    if (collab && collabEnabled) void loadCollabProjects(collab);
  }, [collab, collabEnabled]);

  // 收尾弹窗里点了「邀请同事」：打开成员弹窗，那是项目里现有的邀请入口。
  useEffect(() => {
    if (!demoInvitePending) return;
    consumeDemoGuideInvite();
    setMembersOpen(true);
  }, [demoInvitePending]);

  // 一次性提示（如新建时云端不可用）停留几秒后自动消失，不需要用户手动关闭。
  const notice = snapshot.notice;
  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => dismissCollabNotice(), BOARD_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  // The board belongs to a project on this computer. Sharing only adds a cloud record to it.
  const project = projects.find((candidate) => candidate.id === snapshot.selectedId)
    ?? projects[0]
    ?? null;
  useEffect(() => {
    // A reload, or a project opened from a link, has no selection yet: the first project keeps the board usable.
    if (project && snapshot.selectedId !== project.id) selectCollabProject(project.id);
  }, [project, snapshot.selectedId]);
  // 本机模式下共享列表不加载：即便上一次登录的记录还在内存里，这里也不认它。
  const shared = collabEnabled ? sharedProjectFor(snapshot.projects, project?.id) : null;
  const sharedId = shared?.id ?? null;
  /**
   * 「现在就能请的人」：云端只在项目列表里给出开启了「接收协助请求」的成员。
   * 本人即使也开了接收也不列在这里——没人会请自己协助。
   */
  const assistReceivers = useMemo(
    () => (shared?.assistReceivers ?? []).filter((member) => !member.mine),
    [shared]
  );
  const projectId = project?.id ?? null;
  /** 演示是否正压在这个项目上：是的话授权询问、就地面片提示与离开引导都要另走一套。 */
  const demoActive = demoGuide.status === "active" && projectId !== null && demoGuide.localProjectId === projectId;
  /**
   * 演示还占着这个项目的界面：进行中，或者刚走完、完成弹窗还开着。
   * 授权询问要等它彻底收场——点「完成」之后，或「邀请同事」的弹窗关掉之后。
   */
  const demoOwnsProject = demoGuide.status !== "ended" && projectId !== null && demoGuide.localProjectId === projectId;
  const demoMemberName = demoGuide.memberName;
  /** 现在是导览「关联会话」那一站：弹窗要打开，未授权时先展示授权说明。 */
  const demoPickPhase = demoActive && demoGuide.phase === "tour-associate-pick";

  /** 读一次授权状态：看板要据此决定「关联任务」是列任务还是给授权说明。 */
  const refreshAgentAccess = useCallback(async () => {
    if (!collab || !collabEnabled) return;
    // 旧后端/测试替身没有这个接口：拿不到就按已授权处理，行为与升级前一致。
    try {
      const view = await collab.getAgentAccess();
      if (view) setAgentAccess(view);
    } catch {
      // 未授权状态读不出来时不做任何拦截，避免一个接口失败堵住整个看板。
    }
  }, [collab, collabEnabled]);

  useEffect(() => {
    void refreshAgentAccess();
  }, [refreshAgentAccess, sharedId]);

  /**
   * 打开「关联会话」前再读一次授权状态：授权是唯一入口之后，在设置里授权完回来的人
   * 不该再被那张授权说明挡一次。
   */
  useEffect(() => {
    if (pickOpen) void refreshAgentAccess();
  }, [pickOpen, refreshAgentAccess]);

  /**
   * 「关联会话」里就地授权：装完立刻刷新状态，弹窗自己会重新读列表。
   *
   * 个别 Agent 装不上只出一句提醒（原来那张「已在 N 个 Agent 中安装」的结果页已经去掉），
   * 详情与重试仍在「设置 → 偏好 → 协作项目」里。
   */
  const grantAccessInPlace = useCallback(async (): Promise<boolean> => {
    if (!collab) return false;
    try {
      const result = await collab.setAgentAccess(true);
      setAgentAccess(result.view);
      const failed = result.results.filter((item) => !item.ok);
      if (failed.length) {
        showToast(t("collab.pick.gatePartial", { names: failed.map((item) => item.name).join("、") }));
      }
      return result.view.granted;
    } catch {
      return false;
    }
  }, [collab, showToast, t]);

  /**
   * 引导「关联会话」那一站的授权：由看板就地发起，与弹窗里那个「授权并查看」是同一套。
   *
   * 授权完成就通知引导开始扫；没成则退回门帘并报原因，卡片上给「再试一次」与「跳过这一站」。
   * `granting` 就是「正在跑」：跑完之前不会再发一次。
   */
  const demoGranting = demoPickPhase && demoGuide.scan.status === "granting";
  const demoGrantRunRef = useRef(false);
  useEffect(() => {
    if (!demoGranting || demoGrantRunRef.current) return;
    demoGrantRunRef.current = true;
    void (async () => {
      const granted = await grantAccessInPlace();
      dispatchDemoGuide(granted
        ? { type: "grant-settled" }
        : { type: "grant-failed", reason: t("collab.demo.scan.grantFailed") });
      demoGrantRunRef.current = false;
    })();
  }, [demoGranting, grantAccessInPlace, t]);

  // 宽看板默认展开配置；窄到放不下时先收起。用户点过收起或展开之后，以他的选择为准。
  useLayoutEffect(() => {
    configTouchedRef.current = false;
    const page = pageRef.current;
    if (!page) return;
    const apply = (width: number) => {
      if (width <= 0 || configTouchedRef.current) return;
      const open = width >= NARROW_BOARD_PX;
      setConfigOpen((current) => (current === open ? current : open));
    };
    apply(page.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      apply(entries[0]?.contentRect.width ?? 0);
    });
    observer.observe(page);
    return () => observer.disconnect();
  }, [projectId]);

  function chooseConfig(open: boolean) {
    configTouchedRef.current = true;
    setConfigOpen(open);
  }

  // A project that just started sharing asks which of its own sessions go to the cloud.
  useEffect(() => {
    if (!projectId || snapshot.taskPickerFor !== projectId) return;
    consumeTaskPickerRequest();
    setSettingsOpen(false);
    setTaskPickerOpen(true);
  }, [projectId, snapshot.taskPickerFor]);

  /**
   * 项目指令由所有者与管理员维护；仅在本机的项目没有其他成员，本机的人就是所有者。
   * 协作项目的指令以云端为准，注入由协作侧自己的钩子完成，看板只负责展示与保存。
   */
  const canEditInstructions = !shared || shared.role === "owner" || shared.role === "admin";
  const instructionsDirectory = project?.rootPath ?? null;
  const runtimeConfig = clients?.runtimeConfig ?? null;
  /** 云端列表里的指令：协作项目的权威内容。 */
  const sharedInstructions = shared?.instructions ?? "";
  const runtimeBaseUrl = runtimeConfig?.baseUrl ?? null;

  // 协作项目不读本机项目指令：那是另一套按文件夹归属的存储，读它会拿到别人的指令或本机旧镜像。
  // 本机项目照旧读本机文件。依赖都是基本类型，客户端对象每次渲染可能都是新的。
  useEffect(() => {
    if (sharedId) {
      setInstructions({ ...EMPTY_PROJECT_INSTRUCTIONS, text: sharedInstructions, cloudProjectId: sharedId });
      return;
    }
    if (!instructionsDirectory || !runtimeBaseUrl || !runtimeConfig) {
      setInstructions(EMPTY_PROJECT_INSTRUCTIONS);
      return;
    }
    let cancelled = false;
    void readProjectInstructions(runtimeConfig, instructionsDirectory)
      .then((view) => {
        if (!cancelled) setInstructions(view);
      })
      .catch(() => {
        if (!cancelled) setInstructions(EMPTY_PROJECT_INSTRUCTIONS);
      });
    return () => {
      cancelled = true;
    };
    // Depend on the stable address instead of the client object's per-render identity.
  }, [instructionsDirectory, runtimeBaseUrl, sharedId, sharedInstructions]);

  /**
   * 保存指令：协作项目写云端（权限也在云端判定），后端把内容缓存到协作侧自己的文件；
   * 仅在本机的项目直接写本机文件。保存后对此后开始的任务生效。
   */
  async function saveInstructions(text: string): Promise<void> {
    if (sharedId && collab) {
      const updated = await collab.setInstructions(sharedId, text);
      replaceCollabProject(updated);
      setInstructions({ ...EMPTY_PROJECT_INSTRUCTIONS, text: updated.instructions, cloudProjectId: updated.id });
      return;
    }
    if (!instructionsDirectory) return;
    if (!runtimeConfig?.baseUrl) throw new Error(t("collab.instructions.saveFailed"));
    const saved = await saveProjectInstructions(runtimeConfig, instructionsDirectory, text);
    setInstructions(saved);
  }

  /**
   * 项目配置打开时读一次关联的知识库。云端没实现这组接口（旧版本）时按「没有关联」显示，
   * 不影响指令与看板的其它部分。
   */
  useEffect(() => {
    if (!configOpen || !sharedId || !collab) {
      setKnowledge(null);
      return;
    }
    let cancelled = false;
    void collab.knowledge(sharedId)
      .then((view) => {
        if (!cancelled) setKnowledge(view);
      })
      .catch(() => {
        if (!cancelled) setKnowledge(null);
      });
    return () => {
      cancelled = true;
    };
  }, [configOpen, sharedId, collab]);

  /** 关联一个知识库：加入后本项目全体成员的 Agent 都能检索到它。 */
  async function addKnowledge(baseId: string): Promise<void> {
    if (!sharedId || !collab) return;
    const view = await collab.addKnowledge(sharedId, baseId);
    setKnowledge(view);
  }

  /** 解除关联：权限由云端判定，被拒绝时把原因显示出来。 */
  async function removeKnowledge(baseId: string): Promise<void> {
    if (!sharedId || !collab) return;
    setKnowledge(await collab.removeKnowledge(sharedId, baseId));
  }

  // 一次读回整个项目的任务：云端本来就整份返回，分页只会在本机切片，还会把同一段切成两截。
  useEffect(() => {
    if (!collab || !sharedId) {
      setPage(null);
      return;
    }
    let cancelled = false;
    const first = !query;
    if (first) setPage(null);
    const load = async () => {
      try {
        // The list is read first: waiting for an upload that may be queued behind other work is what made the
        // board sit on "loading". The upload starts in parallel and the next poll picks up what it adds. It runs
        // once per board opening and only for this project, so a search never re-uploads.
        if (!syncedProjectRef.current.has(sharedId)) {
          syncedProjectRef.current.add(sharedId);
          void collab.syncSessions({ tasksOnly: true, projectId: sharedId })
            .then(() => refreshAfterUploadRef.current())
            .catch(() => undefined);
        }
        const result = await collab.listSessions(sharedId, {
          ...(query ? { query } : {})
        });
        if (cancelled) return;
        applyPage(result);
      } catch (cause) {
        if (!cancelled) showToast(messageOf(cause));
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [applyPage, collab, sharedId, query, showToast]);

  /**
   * Called once the background upload of this project's own tasks finishes, so a task finished moments ago shows
   * up without the board having waited for it.
   */
  const refreshAfterUploadRef = useRef<() => void>(() => undefined);
  const refreshAfterUpload = useCallback(() => {
    if (!collab || !sharedId) return;
    void collab.listSessions(sharedId, { ...(query ? { query } : {}) })
      .then((result) => applyPage(result))
      .catch(() => undefined);
  }, [applyPage, collab, sharedId, query]);
  refreshAfterUploadRef.current = refreshAfterUpload;

  /** Re-reads the list without blanking it, so rows arrive instead of the board flickering. */
  const refreshSessions = useCallback(async (projectId: string) => {
    if (!collab) return;
    try {
      const result = await collab.listSessions(projectId, { ...(query ? { query } : {}) });
      applyPage(result);
    } catch {
      // A failed refresh keeps the last list; the next poll retries.
    }
  }, [applyPage, collab, query]);

  // While the board is open, keep the list current. An upload polls quickly; otherwise a slower pass picks up
  // a session another member associated, without waiting for a search.
  useEffect(() => {
    if (!collab || !sharedId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    /** 上一次看到的「是否在上传」，窗口隐藏时据此决定回到前台后多久再查。 */
    let uploading = false;

    const schedule = (running: boolean) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void tick(), running ? PROGRESS_POLL_MS : BOARD_POLL_MS);
    };

    const tick = async () => {
      // 窗口在后台就没人看得到这次结果：不查、不写，等着回来那一下补上。
      if (document.hidden) {
        schedule(uploading);
        return;
      }
      const [next, listing] = await Promise.all([
        collab.getSyncProgress(sharedId).catch(() => null),
        collab.listSessions(sharedId, { ...(query ? { query } : {}) }).catch(() => null)
      ]);
      if (cancelled) return;
      if (listing) applyPage(listing);
      setProgress((current) => (sameSyncProgress(current, next) ? current : next));
      uploading = Boolean(next?.running);
      schedule(uploading);
    };

    // 切回窗口时立刻补一次：后台跳过的那几拍不会让人先看到旧列表。
    const refreshNow = () => {
      if (cancelled || document.hidden) return;
      if (timer) clearTimeout(timer);
      void tick();
    };
    document.addEventListener("visibilitychange", refreshNow);

    // Opening the board joins an upload that started earlier, and keeps refreshing after it stops.
    void collab.getSyncProgress(sharedId)
      .then((current) => {
        if (cancelled) return;
        uploading = current.running;
        setProgress((previous) => (sameSyncProgress(previous, current) ? previous : current));
        schedule(current.running);
      })
      .catch(() => {
        if (!cancelled) schedule(false);
      });

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", refreshNow);
      if (timer) clearTimeout(timer);
    };
  }, [applyPage, collab, sharedId, query, pollKey]);

  // 换一个项目就从头算角标，不把上个项目的待审核数带到这个项目上。
  useEffect(() => {
    setPendingRequests(0);
  }, [sharedId]);

  /**
   * 弹窗关着时也读一次待审核的申请：别人在本机之外提交申请后，「邀请」入口上直接出现角标，
   * 不用先打开弹窗才知道。弹窗开着时由弹窗自己轮询，这里让位。
   */
  useEffect(() => {
    if (!collab || !sharedId || membersOpen) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (document.hidden) {
        timer = setTimeout(() => void tick(), MEMBER_REQUESTS_POLL_MS);
        return;
      }
      try {
        const view = await collab.listMembers(sharedId);
        if (cancelled) return;
        setPendingRequests(view.canManage ? view.requests.length : 0);
        // 不是所有者或管理员就没有可审核的申请，学到这一点后本窗口不再查。
        if (!view.canManage) return;
      } catch {
        // 云端暂时不可用：下一轮再试，角标保留上一份结果。
      }
      if (!cancelled) timer = setTimeout(() => void tick(), MEMBER_REQUESTS_POLL_MS);
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [collab, sharedId, membersOpen]);

  /** 读一次项目里的协助；内容没变就不写，看板不跟着轮询重画。 */
  const refreshAssists = useCallback(async () => {
    if (!collab || !sharedId) return;
    try {
      const view = await collab.assistThreads(sharedId);
      setAssistThreads((current) => (sameAssistThreads(current, view.threads) ? current : view.threads.length ? view.threads : NO_ASSIST_THREADS));
      setAssistLimit((current) => (current.maxThreads === view.maxThreads && current.prunedAt === view.prunedAt
        ? current
        : { maxThreads: view.maxThreads, prunedAt: view.prunedAt }));
    } catch {
      // 云端还没有这个接口或暂时不可用：看板照常显示任务，只是没有协助条目。
    }
  }, [collab, sharedId]);

  const refreshBoard = useCallback(async () => {
    if (!sharedId || refreshing) return;
    setRefreshing(true);
    try {
      await refreshSessions(sharedId);
    } finally {
      setRefreshing(false);
    }
  }, [refreshSessions, refreshing, sharedId]);

  // 协助与任务一样随看板轮询：窗口在后台时跳过，切回来立刻补一次。
  useEffect(() => {
    setAssistThreads(NO_ASSIST_THREADS);
    setAssistLimit(NO_ASSIST_LIMIT);
    setAssistRecordsOpen(false);
    setAssistDetailId(null);
    setSelecting(false);
    setSelected(new Set());
    setOpenMenuId(null);
    if (!collab || !sharedId) return;
    void refreshAssists();
    const timer = setInterval(() => {
      if (!document.hidden) void refreshAssists();
    }, BOARD_POLL_MS);
    const refreshNow = () => {
      if (!document.hidden) void refreshAssists();
    };
    document.addEventListener("visibilitychange", refreshNow);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshNow);
    };
  }, [collab, sharedId, refreshAssists]);

  // 从授权弹窗或通知跳过来：在右侧展开那次协助。读到列表之后再展开，列表里还没有就先等下一轮。
  useEffect(() => {
    if (!assistFocus || !sharedId || assistFocus.projectId !== sharedId) return;
    if (!assistThreads.some((thread) => thread.threadId === assistFocus.threadId)) {
      void refreshAssists();
      return;
    }
    consumeAssistFocus();
    // 看板上只剩任务列表，协助详情直接叠在它上面。
    setAssistDetailId(assistFocus.threadId);
  }, [assistFocus, sharedId, assistThreads, refreshAssists]);

  /**
   * 演示在这个项目上收场（完成 / 退出 / 离开 / 心跳超时）：立刻重读任务与协助，不等下一轮轮询。
   * 小饭团离开后成员数变回 1、他的任务消失，而你们之间的那两次协助要留在列表里。
   */
  const demoOwnedProjectRef = useRef(false);
  useEffect(() => {
    const ended = demoOwnedProjectRef.current && !demoOwnsProject;
    demoOwnedProjectRef.current = demoOwnsProject;
    if (!ended || !sharedId) return;
    void refreshSessions(sharedId);
    void refreshAssists();
  }, [demoOwnsProject, sharedId, refreshSessions, refreshAssists]);

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  /**
   * 引导退回上一屏：设置弹窗要跟着关。
   *
   * `settings-open` 那一屏讲的是「去项目设置开一下」——那一屏本来就不该有弹窗。
   * 从第三步退回来时弹窗是演示自己打开的，不关的话人看见蒙版说「点齿轮」，齿轮却在弹窗后面。
   */
  useEffect(() => {
    if (demoActive && demoGuide.phase === "settings-open" && settingsOpen) setSettingsOpen(false);
  }, [demoActive, demoGuide.phase, settingsOpen]);

  /**
   * 导览讲到「关联会话」时，真的把关联弹窗打开。
   *
   * 演示期间人点不了这个弹窗（蒙版遮住整张弹窗）：这里只是把能力摆出来，不勾选、不保存。
   * 关联会话是整条引导里唯一需要授权的地方：还没授权时弹窗只给授权说明（门帘），
   * 卡片的「授权并查看」就地授权，装完这里再真的扫一遍本机记录。
   */
  const demoPickLocked = demoPickPhase && agentAccess !== null && !agentAccess.granted;
  useEffect(() => {
    // 只在还没开始时推一次：正在装、装完在扫、扫完与装失败（还带着原因）都不回退。
    if (!demoPickLocked) return;
    if (demoGuide.scan.status !== "idle" && demoGuide.scan.status !== "scanning") return;
    dispatchDemoGuide({ type: "scan-locked" });
  }, [demoPickLocked, demoGuide.scan.status]);
  /**
   * 弹窗是不是引导打开的那一次。
   *
   * 引导离开这一步（下一步、上一步、跳过、退出、心跳超时）就把它关掉；用户自己点的弹窗不受影响。
   * 没授权时也照开：门帘就是这一站要给人看的东西。
   */
  const demoPickShownRef = useRef(false);
  useEffect(() => {
    const wanted = demoPickPhase;
    if (wanted) {
      demoPickShownRef.current = true;
      setPickOpen(true);
      return;
    }
    if (!demoPickShownRef.current) return;
    demoPickShownRef.current = false;
    setPickOpen(false);
  }, [demoPickPhase]);

  const sessions = page?.sessions ?? null;
  const filtering = Boolean(query);

  /**
   * 引导第一步的只读面板要跟着屏开与关。
   *
   * 点开成员的任务才进 `reader`；退到 `task-row` 时面板必须关掉，否则它盖住那一行，
   * 蒙版亮的却是被盖住的位置。从输入框（`compose`）退回 `reader` 时面板要重新打开：
   * 它不在，`reader-panel` 锚点就没有，蒙版什么也亮不出来（看起来就是引导没了）。
   */
  const demoMemberSession = demoActive && demoMemberName && sessions
    ? sessions.find((session) => !session.mine && (session.memberName || "") === demoMemberName) ?? null
    : null;
  /** 已经为哪一条开过一次读面板：读失败时不至于每次重画都再请求一次。 */
  const demoReaderAttemptRef = useRef<string | null>(null);
  useEffect(() => {
    if (!demoActive) return;
    if (demoGuide.phase === "reader") {
      if (!demoMemberSession || reading !== null || readingId !== null) return;
      if (demoReaderAttemptRef.current === demoMemberSession.id) return;
      demoReaderAttemptRef.current = demoMemberSession.id;
      void openSession(demoMemberSession);
      return;
    }
    // 离开这一屏：下次回来重新读一次，面板开着就关掉。
    demoReaderAttemptRef.current = null;
    if (reading !== null) setReading(null);
  }, [demoActive, demoGuide.phase, demoMemberSession, reading, readingId]);

  /**
   * 搜过之后一条也没命中：一张说明卡片讲清为什么空，并把退路给在句子里。
   * 成员不再是筛选条件（分区里每个人都单独一段），所以空结果只剩「搜不到」一种原因。
   */
  const filterEmpty = useMemo<{ icon: ReactNode; title: string; body: string }>(() => ({
    icon: <Search size={15} />,
    title: t("collab.sessions.filterEmpty.search.title", { query }),
    body: t("collab.sessions.filterEmpty.search.body")
  }), [query, t]);

  /**
   * 协助记录的两组：有执行内容或还在进行的照常列出；没有执行过的（未允许、已撤回、已过期）只剩一行请求。
   * 只给项目设置里的「协助记录」用，看板的列表不受它影响。
   */
  const assistGroups = useMemo(() => ({
    active: assistThreads.filter((thread) => !assistNeverRan(thread)),
    unrun: assistThreads.filter(assistNeverRan)
  }), [assistThreads]);
  /** 等你处理的协助：你是执行人，请求在等你授权或确认（按限时授权会自动执行的不算）。 */
  const waitingAssists = useMemo(() => assistThreads.filter(assistWaitsForMe), [assistThreads]);

  /**
   * 列表里的行：只有项目任务。协助只对两个人可见，混进项目共享的任务列表会让两人看到的列表不一样，
   * 所以它不在列表里出现：发起在成员段头上，记录在项目设置里，等你处理的请求在列表上方单独提示。
   */
  const boardRows = useMemo<BoardRow[] | null>(() => {
    if (sessions === null) return null;
    return sessions.map((session) => ({ kind: "session" as const, at: session.lastActiveAt ?? "", session }));
  }, [sessions]);
  const assistDetail = assistDetailId ? assistThreads.find((thread) => thread.threadId === assistDetailId) ?? null : null;
  /** 多选能勾的：本页本人的任务。 */
  const selectableIds = useMemo(
    () => (page?.sessions ?? []).filter((session) => session.mine).map((session) => session.id),
    [page]
  );
  const allPageSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));

  /**
   * 点开一行协助：双方先在右侧打开这次协助的完整会话。由 Memmy 执行或发起时，会话底部再给出
   * 「在 Memmy 中打开任务」或「打开发起的任务」。
   */
  function openAssist(thread: AssistThread) {
    setAssistDetailId(thread.threadId);
  }

  /** 发起的任务是否还在这台电脑上：详情里的「打开发起的任务」只对还在的任务出现。 */
  const sourceTaskAvailable = useCallback(
    (chatId: string) => tasks.some((task) => task.chatId === chatId || (task.sessionKey && sessionKeyToChatId(task.sessionKey) === chatId)),
    [tasks]
  );

  /**
   * 看板上的成员分段。顺序在这里定一次：本人永远第一，其余按最近活动排。
   * 定过的顺序记在 ref 里，本次停留期间的轮询不重排；新出现的人才追加到末尾。换项目时重算。
   */
  const memberGroups = useMemo<MemberGroup[]>(() => {
    const groups = groupByMember(sessions ?? []);
    const scope = sharedId ?? project?.id ?? "";
    if (groupOrderRef.current.scope !== scope) {
      groupOrderRef.current = { scope, order: new Map() };
    }
    const order = groupOrderRef.current.order;
    const ranked = [...groups].sort((left, right) => Number(right.mine) - Number(left.mine)
      || right.latestAt.localeCompare(left.latestAt));
    for (const group of ranked) {
      if (!order.has(group.key)) order.set(group.key, order.size);
    }
    return ranked.sort((left, right) => (order.get(left.key) ?? 0) - (order.get(right.key) ?? 0));
  }, [project?.id, sessions, sharedId]);

  // Only this project's own tasks: nothing leaves the computer until sharing is on and sessions are chosen.
  const localTasks = useMemo(() => {
    if (!projectId) return [];
    return tasks
      .filter((task) => task.projectId === projectId && !task.archived)
      .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));
  }, [projectId, tasks]);

  async function openSession(session: CollabProjectSession) {
    if (!collab) return;
    setReadingId(session.id);
    try {
      setReading(await collab.readSessionDetail(session.id));
    } catch (cause) {
      showToast(messageOf(cause));
    } finally {
      setReadingId(null);
    }
  }

  /**
   * 点开一条任务。本人在这台电脑上用 Memmy 建的任务直接进会话页——正文就在本机，没必要先给一个只读面板；
   * 别人的任务、以及其他 Agent 的任务仍用只读面板读云端副本。
   */
  function openRow(session: CollabProjectSession) {
    const chatId = session.conversationId;
    const task = chatId
      ? tasks.find((candidate) => candidate.sessionKey && sessionKeyToChatId(candidate.sessionKey) === chatId) ?? null
      : null;
    if (task && dispatch) {
      void openAgentTaskInChat({ memmyAgent: clients?.memmyAgent, dispatch, task });
      return;
    }
    void openSession(session);
  }

  /**
   * 继续一条协作任务：把它的全文作为引用带到项目下的新任务里。
   * 引用文本取不到（网络或权限）时退回任务链接，Agent 仍可凭链接自行读取，不阻断新建。
   */
  async function continueSession(session: CollabProjectSession) {
    // 列表只在有项目时渲染，这里仍取一次 id：闭包里的项目不在这里收窄。
    const localProjectId = project?.id ?? null;
    if (!localProjectId) return;
    let reference = session.shareText;
    try {
      const read = collab ? await collab.readReference(session.shareText || session.link) : null;
      if (read?.text) reference = read.text;
    } catch {
      // 保留链接作为引用，下面的新建照常进行。
    }
    onContinueTask(localProjectId, { id: session.id, title: session.title, reference });
  }

  /**
   * 任务行。分区之后行里不再写昵称：同一段里每一行的成员是同一个，重复写不提供信息；
   * 头像也只在段头出现。行标题的缩进对齐段头昵称，层级靠对齐而不是靠重复标记。
   */
  function renderSessionRow(session: CollabProjectSession) {
    // 旧记录里的摘要可能停在 Agent 的完成通知上，读不出内容就不显示。
    const summary = readableSummary(session.lastQuestion);
    const menuOpen = openMenuId === session.id;
    // 演示里亮起来的就是演示成员那一行：按云端给的昵称认，不认任何写死的账号。
    const demoRow = demoActive && !session.mine && (session.memberName || "") === demoMemberName;
    return (
      <li
        key={session.id}
        data-demo-guide={demoRow ? "board-task-row" : undefined}
        className={`${styles.row} ${selecting ? styles.rowSelecting : styles.rowOpenable} ${menuOpen ? styles.rowMenuOpen : ""} ${selected.has(session.id) ? styles.rowSelected : ""}`}
        onClick={() => {
          if (!selecting) {
            openRow(session);
            if (demoRow) dispatchDemoGuide({ type: "task-opened" });
            return;
          }
          // 选择模式下点击整行就是勾选；他人的任务不可选。
          if (session.mine) toggleSelected(session.id);
        }}
      >
        {selecting && session.mine ? (
          <input
            type="checkbox"
            className={styles.rowCheck}
            checked={selected.has(session.id)}
            aria-label={session.title}
            onClick={(event) => event.stopPropagation()}
            onChange={() => toggleSelected(session.id)}
          />
        ) : null}
        <div className={styles.rowText}>
          <span className={styles.rowTitle} data-collab-row-title="">{session.title}</span>
          {summary ? <span className={styles.rowSummary}>{summary}</span> : null}
        </div>
        <span className={styles.meta}>{stampLabel(taskStamp(session.lastActiveAt), t)}</span>
        {selecting ? null : (
          <button
            type="button"
            className={styles.moreButton}
            aria-label={t("collab.session.more")}
            title={t("collab.session.more")}
            aria-expanded={menuOpen}
            onClick={(event) => {
              event.stopPropagation();
              setOpenMenuId(menuOpen ? null : session.id);
            }}
          >
            <MoreHorizontal size={15} aria-hidden="true" />
          </button>
        )}
        {menuOpen ? (
          <>
            {/*
             * The row itself opens the session reader, so every click that belongs to the menu
             * has to stop here, or a menu choice also opens the session behind it.
             */}
            <button
              type="button"
              className={styles.menuScrim}
              aria-label={t("collab.cancel")}
              onClick={(event) => {
                event.stopPropagation();
                setOpenMenuId(null);
              }}
            />
            <div className={styles.menu} role="menu" onClick={(event) => event.stopPropagation()}>
              {/* 任一行都可用，包括他人的只读任务：只读限制作用于正文，不影响在自己这边开新任务 */}
              <button type="button" role="menuitem" className={styles.menuItem} onClick={() => { setOpenMenuId(null); void continueSession(session); }}>
                {t("collab.session.continue")}
              </button>
              {session.mine ? (
                <>
                  <div className={styles.menuSeparator} role="separator" />
                  <button type="button" role="menuitem" className={`${styles.menuItem} ${styles.menuItemDanger}`} onClick={() => { setOpenMenuId(null); setDeleting(session); }}>
                    {t("collab.session.delete")}
                  </button>
                </>
              ) : null}
            </div>
          </>
        ) : null}
      </li>
    );
  }

  /**
   * 一个成员一段：段头写名字与数量，可整段收起，滚动时吸顶；
   * 段内默认 `MEMBER_GROUP_ROWS` 条，多出来的就地展开。
   * 搜索时不看折叠状态：命中被折叠住，搜索就等于没结果。
   */
  function renderMemberGroup(group: MemberGroup) {
    const collapsed = !query && collapsedGroups.has(group.key);
    const expanded = query ? true : expandedGroups.has(group.key);
    const shown = expanded ? group.sessions : group.sessions.slice(0, MEMBER_GROUP_ROWS);
    const rest = group.sessions.length - shown.length;
    const name = group.name || t("collab.session.you");
    // 能请谁协助：段头只给其他成员、且她此刻确实接收请求时才出现按钮；请自己无从谈起。
    // 演示期间照常渲染：导览讲到协助那一站时，亮区就落在这颗按钮上（蒙版挡着，点不到）。
    const receiver = group.mine
      ? null
      : assistReceivers.find((member) => member.name === group.name) ?? null;
    return (
      <section key={group.key} className={styles.memberGroup} data-collab-member-group={group.key}>
        {/*
         * 段头整行可点：收起或展开这段任务。右侧的「请求协助」是行内的另一个动作，
         * 按下去不收起段，而是带着这位成员进会话页（见 `onAskMember`）。
         */}
        <div
          role="button"
          tabIndex={0}
          className={styles.groupHead}
          aria-expanded={!collapsed}
          aria-label={t("collab.sessions.groupToggle", { name })}
          data-collab-member-toggle={group.key}
          onClick={() => toggleGroupCollapsed(group.key)}
          onKeyDown={(event) => {
            // 只认段头自己的键：里面的「请求协助」是另一个按钮，它的回车不能顺手把这段收起。
            if (event.target !== event.currentTarget) return;
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            toggleGroupCollapsed(group.key);
          }}
        >
          <span
            className={`${styles.avatar} ${styles.avatarSoft} ${styles.groupHeadAvatar}`}
            style={{ "--member": memberColor(name) } as CSSProperties}
            aria-hidden="true"
          >
            {Array.from(name)[0] ?? "?"}
          </span>
          <span className={styles.groupHeadName} data-collab-member-name="">{name}</span>
          <span className={styles.groupHeadCount}>
            {query
              ? t("collab.sessions.groupMatches", { count: String(group.sessions.length) })
              : t("collab.sessions.groupCount", { count: String(group.sessions.length) })}
          </span>
          <span className={styles.grow} />
          {receiver ? (
            <button
              type="button"
              className={styles.groupHeadAsk}
              data-collab-ask-member={receiver.userId}
              data-demo-guide="board-member-ask"
              onClick={(event) => {
                // 这一下不属于收起：不让它冒到段头上。
                event.stopPropagation();
                if (!project) return;
                onAskMember(project.id, {
                  userId: receiver.userId,
                  name: receiver.name,
                  projectName: shared?.name ?? project.name
                });
              }}
            >
              {t("collab.assist.askButton")}
            </button>
          ) : null}
          <ChevronDown
            size={14}
            aria-hidden="true"
            className={`${styles.groupHeadCaret} ${collapsed ? styles.groupHeadCaretShut : ""}`}
          />
        </div>
        {collapsed ? null : (
          <>
            <ul className={`${styles.list} ${styles.stream}`}>{shown.map(renderSessionRow)}</ul>
            {rest > 0 || (expanded && group.sessions.length > MEMBER_GROUP_ROWS) ? (
              <button
                type="button"
                className={styles.groupMore}
                aria-expanded={expanded}
                onClick={() => toggleGroupExpanded(group.key)}
              >
                {rest > 0
                  ? t("collab.sessions.groupMore", { count: String(rest) })
                  : t("collab.sessions.groupLess")}
              </button>
            ) : null}
          </>
        )}
      </section>
    );
  }

  async function confirmDelete() {
    if (!collab || !sharedId || !deleting) return;
    const session = deleting;
    setDeleting(null);
    try {
      await collab.removeSession(sharedId, session.id);
      showToast(t("collab.session.deleted"));
      await refreshSessions(sharedId);
    } catch (cause) {
      showToast(messageOf(cause));
    }
  }

  /** 从自己的列表中移除一次协助；对方也移除过时，云端删除这次记录。 */
  async function confirmDeleteAssist() {
    if (!collab || !sharedId || !deletingAssist) return;
    const thread = deletingAssist;
    setDeletingAssist(null);
    try {
      const result = await collab.hideAssistThread(sharedId, thread.threadId);
      if (assistDetailId === thread.threadId) setAssistDetailId(null);
      showToast(t(result.removed === "deleted" ? "collab.assist.removedDeleted" : "collab.assist.removed"));
      await refreshAssists();
    } catch (cause) {
      showToast(messageOf(cause));
    }
  }

  /** 选择模式只在本人任务上生效：他人的任务只能看，删除也由云端限定为本人。 */
  function toggleSelected(sessionId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }

  function selectAllMine() {
    const ids = selectableIds;
    setSelected((current) => (ids.length > 0 && ids.every((id) => current.has(id)) ? new Set() : new Set(ids)));
  }

  async function deleteSelected() {
    if (!collab || !sharedId || !selected.size) return;
    const ids = [...selected];
    setConfirmBulkDelete(false);
    setBulkDeleting(true);
    let failed = 0;
    for (const id of ids) {
      try {
        await collab.removeSession(sharedId, id);
      } catch {
        failed += 1;
      }
    }
    setBulkDeleting(false);
    setSelected(new Set());
    setSelecting(false);
    const deleted = ids.length - failed;
    showToast(failed
      ? t("collab.sessions.bulkDeletePartial", { deleted: String(deleted), failed: String(failed) })
      : t("collab.sessions.bulkDeleted", { count: String(deleted) }));
    await refreshSessions(sharedId);
  }

  useEffect(() => {
    // 换搜索词或进入/退出选择模式后，旧的勾选不再有效。
    setSelected(new Set());
  }, [query, selecting]);

  /** 展开某一段的其余任务；再点收起。 */
  function toggleGroupExpanded(key: string) {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  /** 整段收起 / 展开：段头一直在，收起后只剩段头一行。 */
  function toggleGroupCollapsed(key: string) {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  /**
   * 看板只有一张表：任务。tab 行随「协助」一起撤掉，只剩一项的 tab 没有意义。
   */

  // 没有项目时看板没有可讲的内容：不摆页面级空状态，直接回到新会话页面。
  // 等共享列表有结果再判断，避免启动瞬间本机项目还没读出来就跳走。
  useEffect(() => {
    if (project || snapshot.projects === null || !dispatch) return;
    dispatch(appActions.navigate("/main"));
  }, [project, snapshot.projects, dispatch]);

  return (
    <AppFrame title={project?.name ?? t("nav.collab")}>
      <div className={styles.page} ref={pageRef} data-demo-guide="board-main">
        {!project ? (
          // 没有项目时只留加载位：上面那条 effect 会把人送回新会话页面。
          <p className={styles.loading}>{t("collab.loading")}</p>
        ) : (
          <>
            {/* 看板与右侧的项目配置并排：配置属于项目，不随任务列表滚动。 */}
            <div className={styles.scroller}>
              <div className={styles.wrap}>
                {notice !== null ? (
                  <div className={styles.cloudNotice} role="alert">
                    <span>{notice}</span>
                  </div>
                ) : null}
                {/* 只有已共享的项目才依赖云端；本地项目不提示云端异常，等开启共享时再报错。 */}
                {shared !== null && snapshot.error !== null ? (
                  <div className={styles.cloudNotice} role="status">
                    <span>{t("collab.cloudUnavailable", { message: snapshot.error })}</span>
                    <Button size="sm" variant="ghost" onClick={() => collab && void loadCollabProjects(collab)}>
                      {t("collab.retry")}
                    </Button>
                  </div>
                ) : null}
                <header className={styles.boardHeader}>
                  <h1 className={styles.boardName}>{project.name}</h1>
                  {/* 新手引导「成员已加入」那一屏的亮区：套住成员数量，告诉人小饭团已经在里面。 */}
                  <span className={styles.boardScope} data-demo-guide="board-members">
                    {shared
                      ? t("collab.members", { count: String(shared.memberCount) })
                      : t("collab.board.localOnly")}
                  </span>
                  <span className={styles.grow} />
                  {/* 头部操作整块给足热区：按钮彼此只隔 4px，鼠标从「邀请」移到设置不会落到空处 */}
                  {/* 上半截落在 46px 窗口拖拽条里，必须挂拖拽排除（见 window-drag-region.tsx），否则那半块点不到 */}
                  <span className={styles.boardActions} data-window-drag-exclusion="collab-board-actions">
                    {shared ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className={styles.boardAction}
                        onClick={() => setMembersOpen(true)}
                        // 有待审核的申请时把数量写进无障碍名称，按钮上也带一个角标。
                        aria-label={pendingRequests > 0 ? t("collab.members.pending", { count: String(pendingRequests) }) : undefined}
                        title={pendingRequests > 0 ? t("collab.members.pending", { count: String(pendingRequests) }) : undefined}
                      >
                        <UserPlus size={15} aria-hidden="true" />
                        {t("collab.members.invite")}
                        {pendingRequests > 0 ? (
                          <span className={styles.requestBadge} aria-hidden="true">{pendingRequests}</span>
                        ) : null}
                      </Button>
                    ) : null}
                    {/* 收起与展开不同时出现：展开时入口在面板标题栏，收起后才回到这里，与 WorkBuddy 一致 */}
                    {configOpen ? null : (
                      <Button
                        size="sm"
                        variant="ghost"
                        className={`${styles.boardAction} ${styles.boardIconAction}`}
                        aria-label={t("collab.config.expand")}
                        title={t("collab.config.expand")}
                        onClick={() => chooseConfig(true)}
                      >
                        <PanelRight size={15} aria-hidden="true" />
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className={`${styles.boardAction} ${styles.boardIconAction}`}
                      aria-label={t("collab.settings.open")}
                      title={t("collab.settings.open")}
                      data-demo-guide="board-settings"
                      onClick={() => {
                        setSettingsOpen(true);
                        if (demoActive) dispatchDemoGuide({ type: "settings-opened" });
                      }}
                    >
                      <Settings size={15} aria-hidden="true" />
                    </Button>
                  </span>
                </header>

                {shared ? (
                  <>
                    {/* 任务工具条与列表：看板上只有这一份内容，协助的入口在成员段头上 */}
                    <div role="tabpanel" aria-label={t("collab.tab.tasks")}>
                      <div className={styles.toolbar}>
                        <>
                            {/* 搜索属于浏览，选择态收起来；已经带着查询时保留，否则列表被筛住却看不到原因 */}
                            {selecting && !query ? null : (
                              <label className={styles.searchBox}>
                                <Search size={14} aria-hidden="true" className={styles.searchIcon} />
                                <input
                                  value={searchDraft}
                                  placeholder={t("collab.sessions.searchPlaceholder")}
                                  aria-label={t("collab.sessions.searchPlaceholder")}
                                  onChange={(event) => {
                                    const next = event.target.value;
                                    setSearchDraft(next);
                                    // Clearing shows everything again at once; typing waits for a pause.
                                    if (!next.trim()) setQuery("");
                                  }}
                                  onKeyDown={(event) => {
                                    // 回车确认输入法候选词时不要发起搜索，否则搜的是半成品拼音。
                                    if (event.key === "Enter" && !isComposingKeyboardEvent(event)) setQuery(searchDraft.trim());
                                    if (event.key === "Escape") {
                                      setSearchDraft("");
                                      setQuery("");
                                    }
                                  }}
                                />
                                {searchDraft && searchDraft !== query ? (
                                  <button type="button" className={styles.searchGo} onClick={() => setQuery(searchDraft.trim())}>
                                    {t("collab.sessions.searchGo")}
                                  </button>
                                ) : null}
                              </label>
                            )}
                            {/*
                             * 成员不再是筛选条件：分区里每个人都单独一段，自己就是第一段。
                             * 所以工具条上只留搜索，搜索的意思也是「在所有人的任务里找」。
                             */}
                            <span className={styles.grow} />
                        </>
                        {selecting ? (
                          /* 选择态只留这一组，整组不换行：否则最后一个「删除」会被挤到下一行单挂 */
                          <span className={styles.selectActions}>
                            <span className={styles.selectCount}>
                              {t("collab.sessions.selectedCount", { count: String(selected.size) })}
                            </span>
                            <Button size="sm" variant="ghost" disabled={!selectableIds.length || bulkDeleting} onClick={selectAllMine}>
                              {t(allPageSelected ? "collab.sessions.deselectAll" : "collab.sessions.selectAll")}
                            </Button>
                            <Button size="sm" variant="ghost" disabled={bulkDeleting} onClick={() => setSelecting(false)}>
                              {t("collab.cancel")}
                            </Button>
                            {/* 破坏性操作保留警示色，但用文字按钮，不在工具条里压一块红底 */}
                            <Button
                              size="sm"
                              variant="ghost"
                              className={styles.dangerGhost}
                              disabled={!selected.size || bulkDeleting}
                              onClick={() => setConfirmBulkDelete(true)}
                            >
                              <Trash2 size={14} aria-hidden="true" />
                              {bulkDeleting ? t("collab.sessions.deleting") : t("collab.session.delete")}
                            </Button>
                          </span>
                        ) : (
                          <>
                            <Button
                              size="sm"
                              variant="ghost"
                              className={styles.iconAction}
                              aria-label={t("collab.sessions.refresh")}
                              title={t("collab.sessions.refresh")}
                              disabled={refreshing}
                              onClick={() => void refreshBoard()}
                            >
                              <RefreshCw size={14} aria-hidden="true" />
                              <span className={styles.actionLabel}>{t("collab.sessions.refresh")}</span>
                            </Button>
                            {/* 多选只对能删的生效：本人的任务；一条都没有时不显示入口 */}
                            {selectableIds.length ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                className={styles.iconAction}
                                aria-label={t("collab.sessions.select")}
                                title={t("collab.sessions.select")}
                                onClick={() => setSelecting(true)}
                              >
                                <ListChecks size={14} aria-hidden="true" />
                                <span className={styles.actionLabel}>{t("collab.sessions.select")}</span>
                              </Button>
                            ) : null}
                            <Button
                              size="sm"
                              variant="primary"
                              onClick={() => onContinueTask(project.id, null)}
                            >
                              {t("collab.sessions.empty.task.title")}
                            </Button>
                            <Button
                              size="sm"
                              variant="primary"
                              data-demo-guide="board-associate"
                              onClick={() => setPickOpen(true)}
                            >
                              {t("collab.associate")}
                            </Button>
                          </>
                        )}
                      </div>

                      {/* 同步进度是关于任务的，成员提示也在这一页上 */}
                      {progress?.running ? (() => {
                        // 云端每人每项目只留最近 20 个，进度也按这个额度显示，不报会超出上限的条数。
                        const cappedTotal = Math.min(progress.total, SESSIONS_PER_MEMBER_LIMIT);
                        const cappedDone = Math.min(progress.completed, cappedTotal);
                        // 超出额度的那几条还在上传：进度已满，用缓慢呼吸说明后台仍在处理。
                        const pending = progress.total > cappedTotal && progress.completed >= cappedTotal;
                        return (
                          <div className={styles.syncStrip} role="status" aria-live="polite">
                            <span className={styles.syncText}>
                              {t("collab.sync.progress", { completed: String(cappedDone), total: String(cappedTotal) })}
                            </span>
                            <span className={styles.syncBar} aria-hidden="true">
                              <span
                                className={`${styles.syncBarFill} ${pending ? styles.syncBarFillPending : ""}`}
                                style={{ width: `${cappedTotal ? Math.round((cappedDone / cappedTotal) * 100) : 0}%` }}
                              />
                            </span>
                          </div>
                        );
                      })() : null}
                      {/* 等你处理的协助直接提示在任务列表上方：看任务的时候也能接住请求。单条直接展开，多条进记录里挑 */}
                      {waitingAssists.length ? (
                        <div className={styles.assistWaiting} role="status" data-collab-assist-waiting="">
                          <span className={styles.assistWaitingIcon} aria-hidden="true"><LifeBuoy size={13} /></span>
                          <span className={styles.assistWaitingText}>
                            {waitingAssists.length === 1
                              ? t("collab.assist.waitingOne", { name: waitingAssists[0]!.requester.name, title: waitingAssists[0]!.title })
                              : t("collab.assist.waitingMany", { count: String(waitingAssists.length) })}
                          </span>
                          <button
                            type="button"
                            className={styles.assistWaitingAction}
                            onClick={() => {
                              if (waitingAssists.length === 1) openAssist(waitingAssists[0]!);
                              else setAssistRecordsOpen(true);
                            }}
                          >
                            {t("collab.assist.waitingAction")}
                          </button>
                        </div>
                      ) : null}
                      {boardRows === null ? (
                        <p className={styles.loading} data-demo-guide="board-list">{t("collab.loading")}</p>
                      ) : boardRows.length === 0 && filtering ? (
                        <div className={styles.filterEmpty} data-collab-filter-empty="search">
                          <span className={styles.guideIcon} aria-hidden="true">{filterEmpty.icon}</span>
                          <div className={styles.guideText}>
                            <b>{filterEmpty.title}</b>
                            <span>{filterEmpty.body}</span>
                          </div>
                        </div>
                      ) : boardRows.length === 0 ? (
                        /* 空项目只留一句说明：操作就嵌在这句话里，不摆图标、不加按钮。
                         * 本机项目没有可关联的东西，只讲新建任务；共享给成员的项目两种都讲。 */
                        <section
                          className={`${styles.guide} ${styles.guideBare}`}
                          aria-label={shared
                            ? t("collab.sessions.empty.title")
                            : `${t("collab.sessions.empty.lineLead")} ${t("collab.sessions.empty.lineStart")}`}
                          data-demo-guide="board-list"
                        >
                          <p className={styles.guideEmptyLine}>
                            {t("collab.sessions.empty.lineLead")}
                            {" "}
                            <button
                              type="button"
                              className={styles.guideEmptyAction}
                              onClick={() => onContinueTask(project.id, null)}
                            >
                              {t("collab.sessions.empty.lineStart")}
                            </button>
                            {shared ? (
                              <>
                                {" "}
                                {t("collab.sessions.empty.lineJoin")}
                                {" "}
                                <button
                                  type="button"
                                  className={styles.guideEmptyAction}
                                  onClick={() => setPickOpen(true)}
                                >
                                  {t("collab.sessions.empty.lineLink")}
                                </button>
                              </>
                            ) : null}
                          </p>
                        </section>
                      ) : (
                        /* 导览第一步框住的就是这一块：成员分段本身，不含上面的 tab 行与工具条。 */
                        <div className={styles.memberBoard} data-demo-guide="board-list">
                          {memberGroups.map(renderMemberGroup)}
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <LocalProjectSessions
                    tasks={localTasks}
                    onOpenTask={(task) => {
                      if (!dispatch) return;
                      void openAgentTaskInChat({ memmyAgent: clients?.memmyAgent, dispatch, task });
                    }}
                    // 本机任务没有云端引用可带：新任务就落在同一个项目目录里，正文不搬。
                    onContinueTask={() => onContinueTask(project.id, null)}
                  />
                )}
              </div>
            </div>
            {configOpen ? (
              <ProjectConfigPanel
                instructions={instructions}
                canEdit={canEditInstructions}
                knowledge={shared ? knowledge : null}
                knowledgeAvailable={Boolean(shared)}
                onEdit={() => setInstructionsOpen(true)}
                onAddKnowledge={() => setKnowledgeOpen(true)}
                onManageKnowledge={() => setKnowledgeManageOpen(true)}
                onCollapse={() => chooseConfig(false)}
              />
            ) : null}
            {configOpen ? (
              <button
                type="button"
                className={styles.configScrim}
                aria-label={t("collab.config.collapse")}
                tabIndex={-1}
                onClick={() => chooseConfig(false)}
              />
            ) : null}
          </>
        )}
      </div>

      {/* Overlays mount on the body, like the app's other menus and dialogs, so the sidebar never covers them. */}
      {typeof document === "undefined" ? null : createPortal(<>
      {project ? (
        <ProjectInstructionsDialog
          open={instructionsOpen}
          instructions={instructions}
          canEdit={canEditInstructions}
          onClose={() => setInstructionsOpen(false)}
          onSave={saveInstructions}
          onSaved={() => showToast(t("collab.instructions.saved"))}
          onFailed={(message) => showToast(message || t("collab.instructions.saveFailed"))}
        />
      ) : null}
      {project ? (
        <ProjectKnowledgeManageDialog
          open={knowledgeManageOpen}
          knowledge={knowledge}
          onClose={() => setKnowledgeManageOpen(false)}
          onAdd={() => { setKnowledgeManageOpen(false); setKnowledgeOpen(true); }}
          onRemove={removeKnowledge}
        />
      ) : null}
      {project ? (
        <ProjectKnowledgeDialog
          open={knowledgeOpen}
          linked={knowledge?.bases ?? []}
          maxBases={knowledge?.maxBases ?? 10}
          config={runtimeConfig}
          onClose={() => { setKnowledgeOpen(false); setKnowledgeManageOpen(true); }}
          onAdd={addKnowledge}
          onAdded={(count) => showToast(t("collab.knowledge.added", { count: String(count) }))}
        />
      ) : null}
      {project ? (
        <ProjectBoardSettingsDialog
          open={settingsOpen}
          project={project}
          shared={shared}
          collab={collab}
          shareAvailable={collabEnabled}
          onClose={() => setSettingsOpen(false)}
          onShared={() => {
            // The board re-reads its own list once sharing exists.
            setSettingsOpen(false);
            setPollKey((key) => key + 1);
          }}
          onUnshared={() => {
            setPage(null);
            setSettingsOpen(false);
            showToast(t("collab.settings.unshared"));
          }}
          onLeft={() => {
            // 退出项目后不再是它的成员：回到项目列表，与其他成员共用过的任务不再显示。
            setPage(null);
            setSettingsOpen(false);
            showToast(t("collab.leave.done"));
          }}
          taskCount={localTasks.length}
          assistCount={assistThreads.length}
          onOpenAssistRecords={() => {
            // 设置先收起再开记录，不叠两层弹窗。
            setSettingsOpen(false);
            setAssistRecordsOpen(true);
          }}
          demoActive={demoActive}
          onDemoReceivingOn={() => {
            if (!demoActive) return;
            // 演示第三步：设置收起，卡片先说「正在发来一个请求」，并立即取一次收件箱，不等下一轮轮询。
            setSettingsOpen(false);
            dispatchDemoGuide({ type: "receiving-on" });
            requestAssistInboxRefresh();
          }}
          onPickSessions={() => {
            setSettingsOpen(false);
            setTaskPickerOpen(true);
          }}
          onNotice={showToast}
          onFailed={showToast}
        />
      ) : null}
      {collab && shared ? (
        <ProjectMembersDialog
          open={membersOpen}
          collab={collab}
          projectId={shared.id}
          onClose={() => setMembersOpen(false)}
          onToast={showToast}
          // The member count in the header and the sidebar follows approvals and removals.
          onProjectChanged={replaceCollabProject}
          // 弹窗关掉后角标沿用弹窗里读到的数，不必再查一次。
          onRequestsChange={setPendingRequests}
        />
      ) : null}
      {collab && shared ? (
        <ProjectTaskPickerDialog
          open={taskPickerOpen}
          collab={collab}
          project={shared}
          onClose={() => setTaskPickerOpen(false)}
          onSaved={(result) => {
            setTaskPickerOpen(false);
            if (result.started) {
              setProgress({ running: true, total: result.started, completed: 0, failed: 0 });
              setPollKey((key) => key + 1);
              showToast(t("collab.tasks.queued", { count: String(result.started) }));
            } else {
              showToast(t("collab.tasks.saved"));
            }
            void refreshSessions(shared.id);
          }}
          onFailed={showToast}
        />
      ) : null}
      {collab && shared ? (
        <AssociateSessionsModal
          open={pickOpen}
          collab={collab}
          project={shared}
          // 未授权时只给授权说明：弹窗自己不会去列本机其他 Agent 的任务。
          accessGranted={agentAccess?.granted ?? true}
          accessAgents={agentAccess?.agents}
          onGrantAccess={grantAccessInPlace}
          onClose={() => setPickOpen(false)}
          // 引导讲解这一步时弹窗只做展示：真实扫描、不给勾选、不给保存，也没有关闭按钮。
          demoGuide={demoActive && demoGuide.phase === "tour-associate-pick"}
          onDemoScanSettled={(count) => dispatchDemoGuide({ type: "scan-settled", count })}
          onLinked={(result) => {
            // The selection is already saved; the upload continues in the background and the board shows it.
            setPickOpen(false);
            if (result.started) {
              setProgress({ running: true, total: result.started, completed: 0, failed: 0 });
              setPollKey((key) => key + 1);
              // 超出云端额度时不报真实条数：最终只会保留最近的 20 个，报数量会让人以为都留下了。
              showToast(result.started > SESSIONS_PER_MEMBER_LIMIT
                ? t("collab.pick.queuedCapped", { limit: String(SESSIONS_PER_MEMBER_LIMIT) })
                : t("collab.pick.queued", { count: String(result.started) }));
            } else {
              showToast(t("collab.pick.done"));
            }
            void refreshSessions(shared.id);
          }}
        />
      ) : null}
      <CollabAssistConversation
        thread={assistDetail}
        collab={collab}
        sourceTaskAvailable={sourceTaskAvailable}
        onOpenTask={(chatId) => {
          setAssistDetailId(null);
          if (dispatch) void openAgentTaskInChat({ memmyAgent: clients?.memmyAgent, dispatch, task: { sessionKey: `websocket:${chatId}` } });
        }}
        onChanged={() => void refreshAssists()}
        onRemoved={(removed) => {
          setAssistDetailId(null);
          void refreshAssists();
          showToast(t(removed === "deleted" ? "collab.assist.removedDeleted" : "collab.assist.removed"));
        }}
        onClose={() => setAssistDetailId(null)}
      />
      <SessionReaderPanel
        session={reading}
        loading={readingId !== null}
        resolveAgentName={resolveAgentName}
        onClose={() => setReading(null)}
        onContinue={(session) => {
          if (demoActive) {
            dispatchDemoGuide({
              type: "task-continued",
              prefill: t("collab.demo.prefill.task", { name: demoMemberName, next: demoGuide.copy.taskNext })
            });
          }
          void continueSession(session);
        }}
      />
      <ConfirmDialog
        open={confirmBulkDelete}
        title={t("collab.sessions.bulkDeleteTitle")}
        message={t("collab.sessions.bulkDeleteMessage", { count: String(selected.size) })}
        cancelLabel={t("collab.cancel")}
        confirmLabel={t("collab.session.delete")}
        confirmVariant="danger"
        icon={null}
        onCancel={() => setConfirmBulkDelete(false)}
        onConfirm={() => void deleteSelected()}
      />
      <AssistRecordsDialog
        open={assistRecordsOpen}
        threads={assistThreads}
        limit={assistLimit}
        onOpenThread={(thread) => {
          setAssistRecordsOpen(false);
          openAssist(thread);
        }}
        onDelete={(thread) => setDeletingAssist(thread)}
        onClose={() => setAssistRecordsOpen(false)}
      />
      <ConfirmDialog
        open={deletingAssist !== null}
        title={t("collab.assist.deleteTitle")}
        message={deletingAssist
          ? t("collab.assist.deleteMessage", {
            title: deletingAssist.title,
            other: deletingAssist.mine ? deletingAssist.executor.name : deletingAssist.requester.name
          })
          : ""}
        cancelLabel={t("collab.cancel")}
        confirmLabel={t("collab.session.delete")}
        confirmVariant="danger"
        icon={null}
        onCancel={() => setDeletingAssist(null)}
        onConfirm={() => void confirmDeleteAssist()}
      />
      <ConfirmDialog
        open={deleting !== null}
        title={t("collab.session.deleteTitle")}
        message={t("collab.session.deleteMessage", { title: deleting?.title ?? "" })}
        cancelLabel={t("collab.cancel")}
        confirmLabel={t("collab.session.delete")}
        confirmVariant="danger"
        icon={null}
        onCancel={() => setDeleting(null)}
        onConfirm={() => void confirmDelete()}
      />
      {toast ? <div className={styles.toast} role="status">{toast}</div> : null}
      </>, document.body)}
    </AppFrame>
  );
});

/**
 * 看板上的一行协助：「协助」标签 + 要做的事，行尾写清谁请谁、由哪个 Agent 执行、现在的状态。
 *
 * 与任务行一样，右侧「…」菜单里可以删除，多选时可以勾选。删除只是从自己的列表中移除，另一方仍看得到；还没结束的协助
 * 不能删（先撤回或停止），没有菜单，多选时也不能勾选。不给 {@code onDelete} 时不出现菜单。
 */
export function AssistBoardRow(props: {
  thread: AssistThread;
  selecting: boolean;
  onOpen: () => void;
  selected?: boolean;
  onToggle?: () => void;
  menuOpen?: boolean;
  onMenu?: (open: boolean) => void;
  onDelete?: () => void;
  /** 新手引导的演示中，这一行就是第三步的亮区。 */
  demoAnchor?: boolean;
}) {
  const { t } = useTranslation();
  const { thread } = props;
  const deletable = !assistIsOpen(thread.status) && Boolean(props.onDelete);
  const menuOpen = Boolean(props.menuOpen) && deletable;
  // 还在等待、按限时授权会直接执行时，执行 Agent 取那份授权指定的。
  const plannedAgent = thread.agent ?? thread.requests[0]?.grant?.agent ?? null;
  const agent = plannedAgent ? assistAgentName(plannedAgent, "") : "";
  const status = t(assistStatusKey(thread));
  const meta = [
    t("collab.assist.boardRoute", { requester: thread.requester.name, executor: thread.executor.name }),
    agent,
    thread.attempt > 1 && assistIsOpen(thread.status)
      ? `${t("collab.assist.attemptLabel", { attempt: String(thread.attempt) })} ${status}`
      : status,
    stampLabel(taskStamp(thread.lastActiveAt), t)
  ].filter(Boolean).join(" · ");
  const summary = thread.requests[0]?.reason ?? "";
  return (
    <li
      className={`${styles.row} ${props.selecting ? styles.rowSelecting : styles.rowOpenable} ${menuOpen ? styles.rowMenuOpen : ""} ${props.selected ? styles.rowSelected : ""}`}
      data-collab-assist-row=""
      data-demo-guide={props.demoAnchor ? "assist-row" : undefined}
      onClick={() => {
        if (!props.selecting) {
          props.onOpen();
          return;
        }
        // 选择模式下点整行就是勾选；还没结束的不可选。
        if (deletable) props.onToggle?.();
      }}
    >
      {props.selecting && deletable ? (
        <input
          type="checkbox"
          className={styles.rowCheck}
          checked={Boolean(props.selected)}
          aria-label={thread.title}
          onClick={(event) => event.stopPropagation()}
          onChange={() => props.onToggle?.()}
        />
      ) : null}
      <span className={`${styles.avatar} ${styles.assistIcon}`} aria-hidden="true">
        <LifeBuoy size={15} />
      </span>
      <div className={styles.rowText}>
        <span className={styles.rowTitle}>
          <span className={styles.assistTag}>{t("collab.assist.tag")}</span>
          {thread.title}
        </span>
        {summary ? <span className={styles.rowSummary}>{summary}</span> : null}
      </div>
      <span className={`${styles.meta} ${assistIsOpen(thread.status) ? styles.assistMetaOpen : ""}`}>{meta}</span>
      {props.selecting || !deletable ? null : (
        <button
          type="button"
          className={styles.moreButton}
          aria-label={t("collab.session.more")}
          title={t("collab.session.more")}
          aria-expanded={menuOpen}
          onClick={(event) => {
            event.stopPropagation();
            props.onMenu?.(!menuOpen);
          }}
        >
          <MoreHorizontal size={15} aria-hidden="true" />
        </button>
      )}
      {menuOpen ? (
        <>
          <button
            type="button"
            className={styles.menuScrim}
            aria-label={t("collab.cancel")}
            onClick={(event) => {
              event.stopPropagation();
              props.onMenu?.(false);
            }}
          />
          <div className={styles.menu} role="menu" onClick={(event) => event.stopPropagation()}>
            <button
              type="button"
              role="menuitem"
              className={`${styles.menuItem} ${styles.menuItemDanger}`}
              onClick={() => {
                props.onMenu?.(false);
                props.onDelete?.();
              }}
            >
              {t("collab.session.delete")}
            </button>
          </div>
        </>
      ) : null}
    </li>
  );
}

/**
 * 项目设置里的「协助记录」：本项目里我参与过的协助（发起或执行），只有双方两个人看得到。
 *
 * 看板不再单开一个「协助」tab——发起在成员段头上，等你处理的请求提示在任务列表上方，
 * 这里是查看历史的地方。排序沿用原来的口径：等你处理的最急，已结束的最靠后；
 * 没有执行过的请求（未允许、已撤回、已过期）默认收起，不占视线。
 */
export function AssistRecordsDialog(props: {
  open: boolean;
  threads: readonly AssistThread[];
  limit: { maxThreads: number | null; prunedAt: string | null };
  onOpenThread: (thread: AssistThread) => void;
  onDelete: (thread: AssistThread) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [showUnrun, setShowUnrun] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const recent = (thread: AssistThread) => thread.lastActiveAt ?? thread.createdAt ?? "";
  const rank = (thread: AssistThread) => (assistWaitsForMe(thread) ? 0 : assistIsOpen(thread.status) ? 1 : 2);
  const active = props.threads.filter((thread) => !assistNeverRan(thread));
  const unrun = props.threads.filter(assistNeverRan);
  const rows = [
    ...[...active].sort((left, right) => rank(left) - rank(right) || recent(right).localeCompare(recent(left))),
    ...(showUnrun ? unrun : [])
  ];

  return (
    <Modal
      open={props.open}
      title={t("collab.assist.recordsTitle")}
      onClose={props.onClose}
      closeLabel={t("common.close")}
      closeContent={<X size={16} aria-hidden="true" />}
      className={`${styles.createModal} ${styles.simpleCreateModal} ${styles.settingsModal}`}
      backdropClassName={styles.backdrop}
      bodyClassName={styles.settingsBody}
    >
      <p className={styles.assistRecordsLead}>{t("collab.assist.recordsLead")}</p>
      {rows.length ? (
        <ul className={`${styles.list} ${styles.stream} ${styles.flatStream}`} data-collab-assist-records="">
          {rows.map((thread) => (
            <AssistBoardRow
              key={`assist-${thread.threadId}`}
              thread={thread}
              selecting={false}
              onOpen={() => props.onOpenThread(thread)}
              menuOpen={openMenuId === thread.threadId}
              onMenu={(open) => setOpenMenuId(open ? thread.threadId : null)}
              onDelete={() => props.onDelete(thread)}
            />
          ))}
        </ul>
      ) : (
        <p className={styles.assistRecordsEmpty}>{t("collab.assist.recordsEmpty")}</p>
      )}
      {unrun.length ? (
        <button
          type="button"
          className={styles.assistFooterToggle}
          aria-expanded={showUnrun}
          onClick={() => setShowUnrun((value) => !value)}
        >
          {showUnrun
            ? t("collab.assist.unrunHide")
            : t("collab.assist.unrunShow", { count: String(unrun.length) })}
        </button>
      ) : null}
      {props.limit.prunedAt ? (
        <p className={styles.assistFooterNote}>
          {props.limit.maxThreads
            ? t("collab.assist.pruned", { max: String(props.limit.maxThreads) })
            : t("collab.assist.prunedShort")}
        </p>
      ) : null}
    </Modal>
  );
}

/**
 * The sessions tab of a project that is not shared: this computer's own tasks for it, nothing more. Sharing is
 * turned on in the project settings, so the list stays a list instead of carrying a reminder.
 */
function LocalProjectSessions(props: {
  tasks: AgentTaskView[];
  onOpenTask: (task: AgentTaskView) => void;
  /** 在这个项目下开一条新任务：本机任务没有云端引用，新任务只是落在同一个项目里。 */
  onContinueTask: () => void;
}) {
  const { t } = useTranslation();
  const [openMenuKey, setOpenMenuKey] = useState<string | null>(null);
  return (
    <>
      {props.tasks.length === 0 ? (
        /* 与共享项目同一句话的口径：只有一句说明，「新建任务」就嵌在里面、点了直接开任务。
         * 本机项目没有可关联的东西，所以只讲新建任务。 */
        <section
          className={`${styles.guide} ${styles.guideBare}`}
          aria-label={`${t("collab.sessions.empty.lineLead")} ${t("collab.sessions.empty.lineStart")}`}
        >
          <p className={styles.guideEmptyLine}>
            {t("collab.sessions.empty.lineLead")}
            {" "}
            <button type="button" className={styles.guideEmptyAction} onClick={props.onContinueTask}>
              {t("collab.sessions.empty.lineStart")}
            </button>
          </p>
        </section>
      ) : (
        // 本机项目没有工具条，列表要自己留出与标题的间距，否则悬停行浮起的外环会贴住项目名。
        <ul className={`${styles.list} ${styles.stream} ${styles.flatStream}`}>
          {props.tasks.map((task) => {
            const menuOpen = openMenuKey === task.sessionKey;
            return (
              <li
                key={task.sessionKey}
                className={`${styles.row} ${styles.rowOpenable} ${menuOpen ? styles.rowMenuOpen : ""}`}
                onClick={() => props.onOpenTask(task)}
              >
                <span className={styles.localIcon} aria-hidden="true"><Folder size={15} /></span>
                <div className={styles.rowText}>
                  <span className={styles.rowTitle}>{task.title}</span>
                  {task.preview ? <span className={styles.rowSummary}>{task.preview}</span> : null}
                </div>
                <span className={styles.meta}>{stampLabel(taskStamp(task.updatedAt), t)}</span>
                <button
                  type="button"
                  className={styles.moreButton}
                  aria-label={t("collab.session.more")}
                  title={t("collab.session.more")}
                  aria-expanded={menuOpen}
                  onClick={(event) => {
                    event.stopPropagation();
                    setOpenMenuKey(menuOpen ? null : task.sessionKey);
                  }}
                >
                  <MoreHorizontal size={15} aria-hidden="true" />
                </button>
                {menuOpen ? (
                  <>
                    <button
                      type="button"
                      className={styles.menuScrim}
                      aria-label={t("collab.cancel")}
                      onClick={(event) => {
                        event.stopPropagation();
                        setOpenMenuKey(null);
                      }}
                    />
                    <div className={styles.menu} role="menu" onClick={(event) => event.stopPropagation()}>
                      <button
                        type="button"
                        role="menuitem"
                        className={styles.menuItem}
                        onClick={() => {
                          setOpenMenuKey(null);
                          props.onContinueTask();
                        }}
                      >
                        {t("collab.session.continue")}
                      </button>
                    </div>
                  </>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

/**
 * Which of the project's own Memmy sessions go to the cloud. A session that already belongs to the project starts
 * checked, so the dialog also works as a way to take one back out.
 */
function ProjectTaskPickerDialog(props: {
  open: boolean;
  collab: CollabClient | null;
  project: CollabProject;
  onClose: () => void;
  onSaved: (result: CollabSyncResult) => void;
  onFailed: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [tasks, setTasks] = useState<CollabProjectTask[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { collab, open, project } = props;

  useEffect(() => {
    if (!open || !collab) return;
    let cancelled = false;
    setTasks(null);
    setError(null);
    collab.listProjectTasks(project.id)
      .then((listing) => {
        if (cancelled) return;
        setTasks(listing);
        setSelected(new Set(listing.filter((task) => task.included).map((task) => task.conversationId)));
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(messageOf(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [collab, open, project.id]);

  const count = tasks?.length ?? 0;
  const allSelected = count > 0 && selected.size === count;

  function toggle(conversationId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(conversationId)) next.delete(conversationId);
      else next.add(conversationId);
      return next;
    });
  }

  async function confirm() {
    if (!collab || busy) return;
    setBusy(true);
    setError(null);
    try {
      props.onSaved(await collab.saveProjectTasks(project.id, [...selected]));
    } catch (cause) {
      setError(messageOf(cause) || t("collab.pick.failed"));
      props.onFailed(messageOf(cause) || t("collab.pick.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={props.open}
      title={t("collab.tasks.title")}
      subtitle={t("collab.tasks.subtitle")}
      onClose={props.onClose}
      closeLabel={t("common.close")}
      closeContent={<X size={16} aria-hidden="true" />}
      className={styles.pickModal}
      backdropClassName={styles.backdrop}
      footer={(
        <>
          <span className={styles.tasksCount}>{t("collab.tasks.selected", { count: String(selected.size) })}</span>
          <span className={styles.footerButtons}>
            <Button variant="ghost" onClick={props.onClose}>{t("collab.cancel")}</Button>
            <Button
              variant="primary"
              disabled={busy || tasks === null || count === 0}
              onClick={() => void confirm()}
            >
              {t("collab.tasks.confirm")}
            </Button>
          </span>
        </>
      )}
    >
      {tasks === null ? (
        <p className={styles.loading}>{error ?? t("collab.loading")}</p>
      ) : (
        // One bordered card holds the select-all row and the sessions, so every box sits on the same left edge.
        <div className={styles.tasksCard}>
          <label className={styles.tasksAll}>
            <input
              type="checkbox"
              checked={allSelected}
              onChange={() => setSelected(allSelected ? new Set() : new Set(tasks.map((task) => task.conversationId)))}
            />
            <span>{t("collab.tasks.selectAll")}</span>
          </label>
          <ul className={styles.tasksList}>
            {tasks.map((task) => {
              const summary = readableSummary(task.lastQuestion);
              return (
              <li
                key={task.conversationId}
                className={`${styles.row} ${styles.rowOpenable}`}
                onClick={() => toggle(task.conversationId)}
              >
                <input
                  type="checkbox"
                  className={styles.tasksCheck}
                  checked={selected.has(task.conversationId)}
                  onChange={() => toggle(task.conversationId)}
                  onClick={(event) => event.stopPropagation()}
                  aria-label={task.title}
                />
                <div className={styles.rowText}>
                  <span className={styles.rowTitle}>{task.title}</span>
                  {summary ? <span className={styles.rowSummary}>{summary}</span> : null}
                </div>
                <span className={styles.meta}>{formatSessionTime(task.updatedAt)}</span>
              </li>
              );
            })}
          </ul>
        </div>
      )}
    </Modal>
  );
}

/** 项目指令的上限，与云端和注入侧一致（1 万字，与 WorkBuddy 相同）：全文注入，长度决定每轮的开销。 */
const MAX_INSTRUCTION_CHARS = 10_000;

/**
 * 看板右侧的项目配置。项目里的配置项放在这里查看：先有指令，知识库与技能随后加入；
 * 所有者与管理员可以直接编辑，成员只读。
 */
function ProjectConfigPanel(props: {
  instructions: ProjectInstructions;
  canEdit: boolean;
  /** 关联的知识库；本机项目没有云端配置，为 null。 */
  knowledge: CollabKnowledgeView | null;
  /** 只有协作项目能关联知识库：本机项目没有项目范围可言。 */
  knowledgeAvailable: boolean;
  onEdit: () => void;
  onAddKnowledge: () => void;
  onManageKnowledge: () => void;
  onCollapse: () => void;
}) {
  const { t } = useTranslation();
  const text = props.instructions.text.trim();
  return (
    <aside className={styles.config} aria-label={t("collab.config.title")}>
      <div className={styles.configHead}>
        <b className={styles.configTitle}>{t("collab.config.title")}</b>
        <button
          type="button"
          className={styles.configIcon}
          aria-label={t("collab.config.collapse")}
          title={t("collab.config.collapse")}
          data-window-drag-exclusion="collab-config-collapse"
          onClick={props.onCollapse}
        >
          <PanelRightClose size={15} aria-hidden="true" />
        </button>
      </div>
      <div className={styles.configCards}>
        <section className={styles.configCard}>
          <div className={styles.configCardHead}>
            <span className={styles.configCardTitle}>{t("collab.config.instructions")}</span>
            {props.canEdit ? (
              <button
                type="button"
                className={styles.configIcon}
                aria-label={t("collab.config.instructionsEdit")}
                title={t("collab.config.instructionsEdit")}
                onClick={props.onEdit}
              >
                <Plus size={14} aria-hidden="true" />
              </button>
            ) : null}
          </div>
          <button type="button" className={styles.configCardBody} onClick={props.onEdit}>
            {text ? (
              <span className={styles.configText}>{text}</span>
            ) : (
              <span className={styles.configEmpty}>{t("collab.config.instructionsEmpty")}</span>
            )}
          </button>
        </section>
        {props.knowledgeAvailable ? (
          <section className={styles.configCard}>
            <div className={styles.configCardHead}>
              <span className={styles.configCardTitle}>
                {t("collab.config.knowledge")}
                {props.knowledge?.bases.length ? <span className={styles.configKnowledgeCount}>{props.knowledge.bases.length}</span> : null}
              </span>
              {props.knowledge?.bases.length ? (
                <button type="button" className={styles.configKnowledgeAction} onClick={props.onManageKnowledge}>
                  {t("collab.config.knowledgeManage")}
                </button>
              ) : (
                <button
                  type="button"
                  className={styles.configIcon}
                  aria-label={t("collab.config.knowledgeAdd")}
                  title={t("collab.config.knowledgeAdd")}
                  onClick={props.onAddKnowledge}
                >
                  <Plus size={14} aria-hidden="true" />
                </button>
              )}
            </div>
            {props.knowledge?.bases.length ? (
              <div className={styles.configCardBody}>
                <ul className={styles.configKnowledgeList}>
                  {props.knowledge.bases.slice(0, 3).map((base) => (
                    <li key={base.id} className={styles.configKnowledgeRow}>
                      <BookOpen size={12} aria-hidden="true" />
                      <span className={styles.configKnowledgeName} title={base.name}>{base.name}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <button type="button" className={styles.configCardBody} onClick={props.onAddKnowledge}>
                <span className={styles.configEmpty}>{t("collab.config.knowledgeEmpty")}</span>
              </button>
            )}
          </section>
        ) : null}
      </div>
    </aside>
  );
}

/**
 * 项目指令的编辑与查看。所有者与管理员保存后对此后开始的任务生效；成员打开时只读。
 */
function ProjectInstructionsDialog(props: {
  open: boolean;
  instructions: ProjectInstructions;
  canEdit: boolean;
  onClose: () => void;
  onSave: (text: string) => Promise<void>;
  onSaved: () => void;
  onFailed: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(props.instructions.text);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 打开时总是从当前生效的指令开始改，取消了不留草稿。 */
  useEffect(() => {
    if (!props.open) return;
    setDraft(props.instructions.text);
    setError(null);
  }, [props.open, props.instructions.text]);

  const used = [...draft.trim()].length;
  const tooLong = used > MAX_INSTRUCTION_CHARS;
  const unchanged = draft.trim() === props.instructions.text.trim();
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (!props.open || !props.canEdit) return;
    editorRef.current?.focus();
  }, [props.open, props.canEdit]);

  async function save() {
    if (saving || tooLong) return;
    setSaving(true);
    setError(null);
    try {
      await props.onSave(draft.trim());
      props.onSaved();
      props.onClose();
    } catch (cause) {
      setError(messageOf(cause) || t("collab.instructions.saveFailed"));
      props.onFailed(messageOf(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={props.open}
      title={t("collab.instructions.title")}
      onClose={props.onClose}
      closeLabel={t("common.close")}
      closeContent={<X size={16} aria-hidden="true" />}
      className={styles.createModal}
      backdropClassName={styles.backdrop}
      footer={(
        <>
          <span />
          <span className={styles.footerButtons}>
            {props.canEdit ? (
              <>
                <Button onClick={props.onClose}>{t("common.cancel")}</Button>
                <Button variant="primary" disabled={saving || tooLong || unchanged} onClick={() => void save()}>
                  {t("collab.instructions.save")}
                </Button>
              </>
            ) : (
              <Button onClick={props.onClose}>{t("collab.instructions.close")}</Button>
            )}
          </span>
        </>
      )}
    >
      <p className={styles.dialogHint}>
        {props.canEdit ? t("collab.instructions.editHint") : t("collab.instructions.readHint")}
      </p>
      {props.canEdit ? (
        <>
          <textarea
            ref={editorRef}
            className={styles.instructionsInput}
            aria-label={t("collab.instructions.title")}
            value={draft}
            maxLength={MAX_INSTRUCTION_CHARS * 2}
            placeholder={t("collab.instructions.placeholder")}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className={styles.instructionsMeta}>
            <span className={tooLong ? styles.instructionsOver : undefined}>
              {t("collab.instructions.counter", { count: String(used), max: String(MAX_INSTRUCTION_CHARS) })}
            </span>
            {error ? <span className={styles.instructionsError} role="alert">{t("collab.instructions.saveFailed")}</span> : null}
          </div>
        </>
      ) : (
        <div className={styles.instructionsReadonly}>
          {props.instructions.text.trim() || t("collab.instructions.empty")}
        </div>
      )}
    </Modal>
  );
}

/**
 * The board's settings, laid out like Codex's project editor: a small label over one rounded group per topic —
 * the folder, then collaboration (shared sessions or "Turn on collaboration", and assist requests). Each row is an
 * icon and a name with its value, switch or arrow on the right; explanations sit behind a question mark. Stopping
 * sharing (or leaving, for a member) is a soft danger button at the bottom left rather than a switch: it removes
 * the cloud project, which cannot be undone. "Done" on the right closes the dialog; every change applies at once.
 */
export function ProjectBoardSettingsDialog(props: {
  open: boolean;
  project: MemmyAgentProject;
  shared: CollabProject | null;
  collab: CollabClient | null;
  /** API Key 模式没有云端账号：共享这一组只说清原因，不给开关。 */
  shareAvailable: boolean;
  onClose: () => void;
  onShared: () => void;
  onUnshared: () => void;
  /** 已经退出这个项目：看板回到项目列表，本机项目与任务都还在。 */
  onLeft: () => void;
  onPickSessions: () => void;
  /** How many of the project's own sessions could be shared, which decides whether choosing them is worth a dialog. */
  taskCount: number;
  /** 我参与过的协助条数：设置里那一行报数量，点开是完整记录。 */
  assistCount: number;
  onOpenAssistRecords: () => void;
  onNotice: (message: string) => void;
  onFailed: (message: string) => void;
  /** 新手引导的演示中：「协作」这一组是亮区，开关是描边目标，打开后关掉设置去等演示成员的请求。 */
  demoActive?: boolean;
  onDemoReceivingOn?: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  /** Which action is running, so a slow cloud says what it is doing instead of only greying the button. */
  const [action, setAction] = useState<"sharing" | "stopping" | "leaving" | null>(null);
  /** Asking again before the cloud project goes away, since members lose access either way. */
  const [confirm, setConfirm] = useState<"stop" | "leave" | null>(null);
  /** How many of the project's own sessions the cloud holds, shown as the sync row's value. */
  const [taskStats, setTaskStats] = useState<{ synced: number; total: number } | null>(null);
  // 本机客户端只在「在文件夹中显示」上用；预览页自己提供一个空的上下文。
  const { clients } = useApiClients();
  const sharedId = props.shared?.id ?? null;
  const isOwner = props.shared?.role === "owner";

  useEffect(() => {
    if (props.open) setConfirm(null);
  }, [props.open, sharedId]);

  // The sync row says what is already there, so opening the settings reads the project's own sessions once.
  useEffect(() => {
    if (!props.open || !sharedId || !props.collab) {
      setTaskStats(null);
      return;
    }
    let cancelled = false;
    props.collab.listProjectTasks(sharedId)
      .then((tasks) => {
        if (cancelled) return;
        setTaskStats({ synced: tasks.filter((task) => task.synced).length, total: tasks.length });
      })
      .catch(() => {
        if (!cancelled) setTaskStats(null);
      });
    return () => {
      cancelled = true;
    };
  }, [props.open, sharedId, props.collab]);

  async function startSharing() {
    if (!props.collab || busy) return;
    setBusy(true);
    setAction("sharing");
    try {
      // 带上本机项目：已经共享过的直接拿回原来那个云端项目，不会再建一个同名项目。
      const created = await props.collab.createProject(props.project.name, props.project.rootPath, {
        localProjectId: props.project.id
      });
      addCollabProject(created.project);
      // 绑定与建项在同一个请求里完成了：这里只是把同一个值再告诉后台一次，失败不影响已经存在的绑定。
      try {
        await props.collab.bindLocalProject(created.project.id, props.project.id);
      } catch (cause) {
        console.warn(`Project binding failed: ${messageOf(cause)}`);
      }
      // 云端已经有这个项目，本机记下它，界面不必等下一次列表刷新才变成「已共享」。
      markCollabProjectBound(created.project.id, props.project.id);
      props.onShared();
      if (props.taskCount > 0) {
        // The project already has sessions: the person picks which of them members may read.
        requestTaskPicker(props.project.id);
      } else {
        // Nothing to choose yet; new sessions sync from now on.
        props.onNotice(t("collab.settings.sharedNoTasks"));
      }
    } catch (cause) {
      props.onFailed(messageOf(cause) || t("collab.settings.shareFailed"));
    } finally {
      setBusy(false);
      setAction(null);
    }
  }

  async function stopSharing() {
    if (!props.collab || !sharedId || busy) return;
    setBusy(true);
    setAction("stopping");
    try {
      let instructions: CollabInstructionsHandover = "none";
      try {
        instructions = (await props.collab.deleteProject(sharedId))?.instructions ?? "none";
      } catch (cause) {
        // Already gone from the cloud: the state the person asked for already holds, so the local record follows.
        if (!(cause instanceof ApiRequestError && cause.status === 404)) throw cause;
      }
      removeCollabProject(sharedId);
      props.onUnshared();
      // 背景与规范留在创建者的本机项目里：以云端为准覆盖本机旧内容。
      if (instructions === "saved") props.onNotice(t("collab.settings.instructionsKept"));
    } catch (cause) {
      props.onFailed(messageOf(cause) || t("collab.settings.unshareFailed"));
    } finally {
      setBusy(false);
      setAction(null);
    }
  }

  /** Leaves a project someone else owns: the local project and its tasks stay, as after the owner stops sharing. */
  async function leaveProject() {
    if (!props.collab || !sharedId || busy) return;
    setBusy(true);
    setAction("leaving");
    try {
      try {
        await props.collab.leaveProject(sharedId);
      } catch (cause) {
        // No longer in it: what the person asked for already holds.
        if (!(cause instanceof ApiRequestError && cause.status === 404)) throw cause;
      }
      removeCollabProject(sharedId);
      await loadCollabProjects(props.collab);
      props.onLeft();
    } catch (cause) {
      props.onFailed(messageOf(cause) || t("collab.leave.failed"));
    } finally {
      setBusy(false);
      setAction(null);
    }
  }

  // 加载中只转圈，读完后是「暂无」或「x / y」。
  const sessionsValue = taskStats === null
    ? null
    : taskStats.total === 0
      ? t("collab.settings.sessionsNone")
      : t("collab.settings.sessionsRatio", { synced: String(taskStats.synced), total: String(taskStats.total) });
  const revealProject = clients?.memmyAgent
    ? () => void clients.memmyAgent?.revealProject(props.project.id, { timeoutMs: 15_000 })
    : null;
  const canLeave = Boolean(sharedId) && props.shareAvailable;
  const dangerLabel = isOwner ? t("appFrame.project.stopSharing") : t("appFrame.project.leave");
  const confirmTitle = confirm === "leave" ? t("collab.leave.title") : t("collab.settings.stopTitle");
  const confirmBody = confirm === "leave"
    ? t("collab.leave.message", { name: props.project.name })
    : t("appFrame.project.stopSharingMessage", { name: props.project.name });
  // 确认块占满页脚；平时左侧是危险操作（或进行中的动作），右侧「完成」。
  const footer = confirm ? (
    <section className={styles.settingsConfirm} role="alertdialog" aria-label={confirmTitle}>
      <b>{confirmTitle}</b>
      <p>{confirmBody}</p>
      <div className={styles.settingsConfirmButtons}>
        <Button
          size="sm"
          variant="secondary"
          className={styles.settingsButton}
          disabled={busy}
          onClick={() => setConfirm(null)}
        >
          {t("collab.cancel")}
        </Button>
        {/* 删除云端项目 / 退出项目都是破坏性操作，和侧栏确认框一致用实心 danger */}
        <Button
          size="sm"
          variant="danger"
          disabled={busy}
          onClick={() => void (confirm === "leave" ? leaveProject() : stopSharing())}
        >
          {dangerLabel}
        </Button>
      </div>
    </section>
  ) : (
    <>
      {action ? (
        <p className={styles.settingsFooterStatus} role="status">
          {action === "sharing"
            ? t("collab.settings.sharing")
            : action === "stopping" ? t("collab.settings.stopping") : t("collab.settings.leaving")}
        </p>
      ) : canLeave ? (
        <button
          type="button"
          className={styles.settingsDangerSoft}
          disabled={busy}
          onClick={() => setConfirm(isOwner ? "stop" : "leave")}
        >
          {dangerLabel}
        </button>
      ) : <span />}
      <Button variant="primary" className={styles.settingsDoneButton} disabled={busy} onClick={props.onClose}>
        {t("collab.settings.done")}
      </Button>
    </>
  );

  return (
    <Modal
      open={props.open}
      title={t("collab.settings.title")}
      onClose={props.onClose}
      closeLabel={t("common.close")}
      closeContent={<X size={16} aria-hidden="true" />}
      className={`${styles.createModal} ${styles.simpleCreateModal} ${styles.settingsModal}`}
      backdropClassName={props.demoActive ? `${styles.backdrop} ${styles.backdropYield}` : styles.backdrop}
      bodyClassName={styles.settingsBody}
      footer={footer}
      footerClassName={styles.settingsFooter}
    >
      {/* 文件夹：一组里只有一行，显示末级目录名，完整路径在悬停提示里；点整行在系统文件管理器中打开 */}
      <div className={styles.settingsSectionLabel}>{t("collab.settings.folder")}</div>
      <div className={styles.settingsGroup}>
        <button
          type="button"
          className={`${styles.settingsRow} ${styles.settingsRowAction}`}
          title={props.project.rootPath}
          aria-label={`${t("collab.settings.reveal")}：${formatWorkspacePath(props.project.rootPath)}`}
          disabled={!revealProject}
          onClick={() => revealProject?.()}
        >
          <Folder size={16} aria-hidden="true" className={styles.settingsRowIcon} />
          <span className={`${styles.settingsRowLabel} ${styles.settingsRowStrong}`}>{folderNameOf(props.project.rootPath)}</span>
          <ArrowUpRight size={15} aria-hidden="true" className={styles.settingsRowTrail} />
        </button>
      </div>

      {/* 协作：与成员有关的设置放在同一组里，一行一项 */}
      <div className={styles.settingsSectionLabel}>{t("collab.settings.sectionCollab")}</div>
      <div className={styles.settingsGroup} data-demo-guide={props.demoActive ? "settings-assist" : undefined}>
        {!props.shareAvailable ? (
          // API Key 模式没有云端账号：只写明需要登录，原因收进问号，不给开关。
          <div className={`${styles.settingsRow} ${styles.settingsRowMuted}`}>
            <Users size={16} aria-hidden="true" className={styles.settingsRowIcon} />
            <span className={styles.settingsRowLabel}>{t("collab.create.shareToggle")}</span>
            <span className={styles.settingsRowHint}>
              <InfoHint
                placement="above"
                label={t("collab.create.shareHelpLabel")}
                text={t("collab.settings.shareByokHint")}
              />
            </span>
            <span className={styles.settingsRowValue}>{t("collab.settings.shareNeedsAccount")}</span>
          </div>
        ) : sharedId ? (
          // 已共享：报共享了几个任务，点整行去选择。停止共享不是开关，在左下角。
          <button
            type="button"
            className={`${styles.settingsRow} ${styles.settingsRowAction}`}
            onClick={props.onPickSessions}
          >
            <Users size={16} aria-hidden="true" className={styles.settingsRowIcon} />
            <span className={styles.settingsRowLabel}>{t("collab.settings.sessionsRow")}</span>
            {sessionsValue === null ? (
              <span className={styles.settingsRowValue} role="status" aria-label={t("collab.loading")}>
                <Loader2 size={13} aria-hidden="true" className={styles.settingsSpinner} />
              </span>
            ) : (
              <span className={styles.settingsRowValue}>{sessionsValue}</span>
            )}
            <ChevronRight size={15} aria-hidden="true" className={styles.settingsRowTrail} />
          </button>
        ) : (
          // 未共享：与创建项目里的「开启项目协作」同一句话，点整行任意位置都能开启（问号除外）。
          <div
            className={`${styles.settingsRow} ${styles.settingsRowAction}`}
            onClick={() => void startSharing()}
          >
            <Users size={16} aria-hidden="true" className={styles.settingsRowIcon} />
            <span className={styles.settingsRowLabel}>{t("collab.create.shareToggle")}</span>
            <span className={styles.settingsRowHint} onClick={(event) => event.stopPropagation()}>
              <InfoHint placement="above" label={t("collab.create.shareHelpLabel")} text={t("collab.settings.shareOffHint")} />
            </span>
            {/* 开关自己不处理点击：点击冒泡到整行只触发一次，键盘的空格 / 回车同样产生点击 */}
            <button
              type="button"
              role="switch"
              aria-checked={false}
              aria-label={t("collab.create.shareToggle")}
              disabled={busy || !props.collab}
              className={`${styles.settingsSwitch} ${styles.settingsRowControl}`}
            />
          </div>
        )}

        {/* 成员协助：本人在这个项目里是否接收协助请求（加入项目时默认开启，可随时关掉），
            开启且有限时授权时列在这一行下面。只在账号模式、已共享的项目里出现。 */}
        {sharedId && props.shareAvailable ? (
          <CollabAssistProjectSettings
            client={props.collab}
            projectId={sharedId}
            demoAnchor={props.demoActive === true}
            // 引导正讲到这一行：只展示默认开启，开关不给拨。
            locked={props.demoActive === true}
            onEnabledChange={(enabled) => {
              if (enabled) props.onDemoReceivingOn?.();
            }}
          />
        ) : null}

        {/* 协助记录：看板不再单开「协助」tab，历史都在这里看；只有发起人与执行人两个人可见。 */}
        {sharedId && props.shareAvailable ? (
          <button
            type="button"
            className={`${styles.settingsRow} ${styles.settingsRowAction}`}
            data-collab-assist-records-row=""
            onClick={props.onOpenAssistRecords}
          >
            <LifeBuoy size={16} aria-hidden="true" className={styles.settingsRowIcon} />
            <span className={styles.settingsRowLabel}>{t("collab.assist.recordsRow")}</span>
            <span className={styles.settingsRowValue}>{props.assistCount}</span>
            <ChevronRight size={15} aria-hidden="true" className={styles.settingsRowTrail} />
          </button>
        ) : null}
      </div>
    </Modal>
  );
}

/** 只显示末级目录名，完整路径留到悬停提示里。 */
function folderNameOf(path: string): string {
  const parts = path.split(/[\\/]/u).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * A cloud session read as a conversation: the person's question, then the Agent's answer.
 * Tool steps stay in the stored transcript and are not drawn here. Members can read each other's
 * sessions, but only the person who shared one can delete it, which the board's row menu already enforces.
 *
 * It floats on the right of the board rather than opening as a dialog: the list stays visible, so reading
 * someone else's task never loses the place it came from.
 */
function SessionReaderPanel(props: {
  session: { session: CollabProjectSession; turns: CollabSessionTurn[] } | null;
  loading: boolean;
  /** 已关联的 Agent 用本机的名字；内置 Agent 用产品名。 */
  resolveAgentName: (sourceId: string) => string;
  onClose: () => void;
  /** 在项目下开一条新任务接着这条做：与任务行「…」菜单里的「继续任务」同一个动作。 */
  onContinue: (session: CollabProjectSession) => void;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const panelRef = useRef<HTMLElement | null>(null);
  const panelWidth = useReaderPanelWidth(READER_PANEL_WIDTH_STORAGE_KEY, t("collab.reader.resize"));
  const data = props.session;
  const open = data !== null;
  const name = data ? data.session.memberName || (data.session.mine ? t("collab.session.you") : "") : "";
  const agentName = data ? props.resolveAgentName(data.session.source) || "Agent" : "";
  const agentLogo = data ? agentSourceLogoUrl(data.session.source) : undefined;

  // Esc closes the panel and focus moves into it while it is open, so a reader who never touches the mouse still
  // ends up in the task they just opened.
  useEffect(() => {
    if (!open) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") props.onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    panelRef.current?.focus();
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, props.onClose]);

  if (!data) return null;

  const spoken = (data.turns.flatMap((turn) => {
    const question = visibleQuestion(turn.question);
    const reply = visibleReply(turn.reply);
    return question || reply ? [{ question, reply, startedAt: turn.startedAt }] : [];
  })).map((turn, index) => ({ ...turn, number: index + 1 }));
  // 一个任务只来自一个 Agent：名字与图标只标一次，回复正文保持干净。
  const firstAgent = spoken.findIndex((turn) => turn.reply);
  const moment = stampLabel(taskStamp(data.session.lastActiveAt), t);
  const when = taskDayGroup(data.session.lastActiveAt) === "today"
    ? `${t("collab.sessions.group.today")} ${moment}`
    : moment;

  return createPortal(
    <div className={styles.readerLayer}>
      {/* 不压暗看板：只铺一层几乎看不出的薄雾，点击面板外即关闭 */}
      <button
        type="button"
        className={styles.readerScrim}
        aria-label={t("common.close")}
        tabIndex={-1}
        onClick={props.onClose}
      />
      <aside
        ref={panelRef}
        data-demo-guide="reader-panel"
        className={styles.readerPanel}
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        data-collab-reader=""
        tabIndex={-1}
        style={panelWidth.style}
      >
        {panelWidth.handle}
        <header className={styles.readerHead}>
          <span
            className={`${styles.avatar} ${styles.avatarSoft} ${styles.readerHeadAvatar}`}
            style={{ "--member": memberColor(name) } as CSSProperties}
            aria-hidden="true"
          >
            {Array.from(name)[0] ?? "?"}
          </span>
          <div className={styles.readerHeadText}>
            <h2 id={titleId} className={styles.readerTitle}>{data.session.title}</h2>
            <div className={styles.readerHeadMeta}>
              <span>{[name, when].filter(Boolean).join(" · ")}</span>
              {data.session.mine ? null : <span className={styles.readerBadge}>{t("collab.reader.readOnly")}</span>}
            </div>
          </div>
          <div className={styles.readerActions}>
            {/* 只读面板的头部也能接着做：入口原来只在任务行的「…」菜单里，读到最后一项时不该先退出去找它。 */}
            <button
              type="button"
              className={styles.readerContinue}
              data-demo-guide="reader-continue"
              onClick={() => props.onContinue(data.session)}
            >
              {t("collab.session.continue")}
            </button>
            <button
              type="button"
              className={styles.readerAction}
              aria-label={t("common.close")}
              title={t("common.close")}
              onClick={props.onClose}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </header>
        <div className={styles.readerBody}>
          {data.session.trimmed ? (
            <p className={styles.readerTrimmed}>{t("collab.reader.trimmed")}</p>
          ) : null}
          {spoken.length === 0 ? (
            <p className={styles.loading}>{t("collab.reader.empty")}</p>
          ) : spoken.map((turn, index) => {
            // 打开面板时只有开头几轮真在屏上：其余的先按估算高度占位，滚到附近再由 AgentMessageContent
            // 自己展开。否则一个长任务的全部 Markdown、代码块会在同一次提交里算完，点击要等几百毫秒。
            const defer = index >= READER_IMMEDIATE_TURNS && Boolean(turn.reply) && isLikelyExpensiveAgentMarkdown(turn.reply);
            return (
              <article key={`${turn.startedAt}-${turn.number}`} className={styles.readerTurn}>
                {spoken.length > 1 ? (
                  <span className={styles.readerTurnIndex}>{t("collab.reader.turn", { index: String(turn.number) })}</span>
                ) : null}
                {turn.question ? (
                  <div className={styles.readerUser} data-collab-role="user">
                    <p className={styles.readerUserBubble}>{turn.question}</p>
                  </div>
                ) : null}
                {turn.reply ? (
                  <div className={styles.readerAgent} data-collab-role="agent">
                    {turn.number === spoken[firstAgent]?.number ? (
                      <div className={styles.readerAgentHead}>
                        {agentLogo ? (
                          <img className={styles.readerAgentLogo} src={agentLogo} alt="" />
                        ) : (
                          <span className={styles.readerAgentMark} aria-hidden="true">{Array.from(agentName)[0] ?? "A"}</span>
                        )}
                        <span>{agentName}</span>
                      </div>
                    ) : null}
                    <AgentMessageContent
                      content={turn.reply}
                      readOnlyFileReferences
                      deferRender={defer}
                      deferredRevealDelayMs={defer
                        ? READER_DEFERRED_REVEAL_START_MS + (index - READER_IMMEDIATE_TURNS) * READER_DEFERRED_REVEAL_STEP_MS
                        : 0}
                    />
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
        <footer className={styles.readerFoot}>{t("collab.reader.hint")}</footer>
      </aside>
    </div>,
    document.body
  );
}

/**
 * Cursor stores the host envelope in the user bubble. The person typed the `<user_query>` body;
 * a bubble that is only a system notification has nothing to show.
 */
export function visibleQuestion(text: string): string {
  const queries = [...text.matchAll(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/giu)]
    .map((match) => match[1]?.trim() ?? "")
    .filter((query) => query.length > 0);
  // 新手引导第二步那句话后面跟着给 Agent 的执行提示（命令行与参数）：成员看到的副本里不该有它。
  return withoutDemoGuideHint(withoutInterruptionMarkers(
    withoutSkillDump(withoutCursorTaskFollowup(stripHostEnvelope(queries.length > 0 ? queries.join("\n\n") : text)))
  ));
}

/**
 * 有些 Agent 把「加载技能」也写成一条用户消息，整段技能正文跟着进来（`Base directory for this skill:` 开头）。
 * 那是 Agent 的内部上下文，不是谁问的问题：从这一行起全部去掉，前面还有真问题时保留。
 * 读取规则已经在写入时剔掉这类记录，这里兜住升级前已经上传的任务。
 */
function withoutSkillDump(text: string): string {
  const marker = text.search(/base directory for this skill:/iu);
  return marker < 0 ? text : text.slice(0, marker).trim();
}

/**
 * Qoder、Claude Code 把「用户打断」也写成一条用户消息（`[Request interrupted by user…]`）。
 * 那不是提问，留着只会多出一轮空的对话。
 */
function withoutInterruptionMarkers(text: string): string {
  return text.replace(/\[Request interrupted by user[^\]]*\]/giu, "").trim();
}

/** Drops a host envelope that leaked into an answer. The answer itself stays. */
export function visibleReply(text: string): string {
  return stripHostEnvelope(text);
}

function stripHostEnvelope(text: string): string {
  return text
    .replace(/<(timestamp|system_notification|system[_-]reminder|image_files|open_and_recently_viewed_files)\b[^>]*>[\s\S]*?<\/\1>/giu, "")
    .trim();
}

/** Cursor writes this into `<user_query>` when a background task ends. It is not something the person typed. */
function withoutCursorTaskFollowup(text: string): string {
  return text
    .replace(/briefly inform the user about the task result and perform any follow-up actions \(if needed\)\.\s*if there['’]s no follow-ups needed, don['’]t explicitly say that\.?/giu, "")
    .trim();
}

/** 新建项目: an online project (default) or a local one, per the prototype. */
export function AssociateSessionsModal(props: {
  open: boolean;
  collab: CollabClient;
  project: CollabProject;
  onClose: () => void;
  onLinked: (result: CollabSyncResult) => void | Promise<void>;
  /** 「在其他 Agent 中使用协作项目」是否已授权；未授权时弹窗只给授权说明，不读本机记录。 */
  accessGranted?: boolean;
  /** 授权说明里列出的 Agent 与其中被关掉的：说明这一屏在讲哪些 Agent。 */
  accessAgents?: ReadonlyArray<{ sourceId: string; name: string; enabled: boolean; available: boolean }>;
  /** 在弹窗内就地授权：成功返回 true，列表随即在当前弹窗里出现。 */
  onGrantAccess?: () => Promise<boolean>;
  /**
   * 新手引导的展示模式：真实扫一遍本机历史会话，但一个也不能勾、也不保存。
   *
   * 引导要讲的是「之后可以在这里选」，所以弹窗照原样摊开给人看：蒙版会盖住整张弹窗，
   * 里面的按钮与勾选框一律不接操作；关闭按钮与 Esc 也收起，避免把人从引导里带出去。
   */
  demoGuide?: boolean;
  /** 展示模式的扫描结束（成功或失败都报）：引导据此才放行「下一步」。 */
  onDemoScanSettled?: (count: number) => void;
}) {
  const { t } = useTranslation();
  const appState = useOptionalAppState();
  const [sessions, setSessions] = useState<LocalAgentSession[] | null>(null);
  const [saved, setSaved] = useState<CollabLinks>(EMPTY_LINKS);
  const [links, setLinks] = useState<CollabLinks>(EMPTY_LINKS);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmUnlinkGroup, setConfirmUnlinkGroup] = useState(false);
  const [addAgentOpen, setAddAgentOpen] = useState(false);
  const [granting, setGranting] = useState(false);
  /** 已添加的 Agent：只用于添加弹窗里的清单，用户添加的 Agent 不进左侧列表。 */
  const [addedAgents, setAddedAgents] = useState<AddedAgent[]>([]);
  const { collab, open, project } = props;
  /** 「在其他 Agent 中使用协作项目」是否已授权：未传按已授权处理，只有涉及授权的页面会传它。 */
  const accessGranted = props.accessGranted ?? true;
  /** 展示模式：只扫不选，互动全部收起。 */
  const demoGuide = props.demoGuide === true;
  /** 回调由看板每次渲染现给，放进 ref 只为了不让它重启扫描。 */
  const demoSettledRef = useRef(props.onDemoScanSettled);
  demoSettledRef.current = props.onDemoScanSettled;
  useEffect(() => {
    if (!open || !demoGuide) return undefined;
    // 还没授权时只给授权说明（门帘），不去读本机记录：读也读不到，反而会把「0 个会话」报给引导。
    // 授权完成后 `accessGranted` 变真，这一段重跑，真的把这台电脑上各个 Agent 的会话读一遍。
    if (!accessGranted) return undefined;
    // 这次是真的扫描：不等上次缓存，直接把这台电脑上各个 Agent 的会话读一遍。
    let cancelled = false;
    setSessions(null);
    setError(null);
    collab.listLocalSessions({ limit: MAX_LOCAL_SESSIONS, fresh: true })
      .then((listing) => {
        if (cancelled) return;
        setSessions(listing.sessions);
        demoSettledRef.current?.(listing.sessions.length);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        // 扫不出来也算有了结果：卡片会说「暂时没有可以关联的会话」，人不会被卡在这儿。
        setSessions([]);
        setError(messageOf(cause));
        demoSettledRef.current?.(0);
      });
    return () => {
      cancelled = true;
    };
  }, [accessGranted, collab, demoGuide, open]);
  /** 授权说明里列出的 Agent：只列可用的，关掉的单独用一句话说明。 */
  const gateAgents = (props.accessAgents ?? []).filter((agent) => agent.available && agent.enabled);
  const gateDisabledNames = (props.accessAgents ?? []).filter((agent) => agent.available && !agent.enabled).map((agent) => agent.name);
  /** 添加弹窗打开时读一次已添加清单，移除后重读；用户添加的 Agent 不进左侧列表。 */
  const reloadAddedAgents = useCallback(async () => {
    if (!collab) return;
    const agents = await collab.listAddedAgents().catch(() => null);
    if (agents) setAddedAgents(agents);
  }, [collab]);
  useEffect(() => {
    if (!open || !addAgentOpen) return;
    void reloadAddedAgents();
  }, [addAgentOpen, open, reloadAddedAgents]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setConfirmUnlinkGroup(false);
    setSessions(null);
    setSaved(EMPTY_LINKS);
    setLinks(EMPTY_LINKS);
    setAgentId(null);
    setQuery("");
    setExpanded(new Set());
    setError(null);
    // 展示模式自己扫一遍（见上面的 demoGuide effect）：这里不再读缓存，否则两份结果会来回盖。
    if (demoGuide) return;
    // 未授权时一个本机记录也不读：弹窗里只有授权说明，授权后这一段会重新跑。
    if (!accessGranted) return;
    // The last scan shows at once; when it is older, the newer list replaces it a few seconds later.
    Promise.all([collab.listLocalSessions({ limit: MAX_LOCAL_SESSIONS }), collab.getLinks(project.id)])
      .then(([listing, current]) => {
        if (cancelled) return;
        setSessions(listing.sessions);
        setSaved(current);
        setLinks(current);
        if (!listing.refreshing) return;
        void collab.listLocalSessions({ limit: MAX_LOCAL_SESSIONS, fresh: true })
          .then((fresh) => {
            if (!cancelled) setSessions(fresh.sessions);
          })
          .catch(() => undefined);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(messageOf(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [accessGranted, collab, demoGuide, open, project.id]);

  /** 就地授权：授权成功后同一个弹窗直接列出任务，不用先关掉再点一次。 */
  async function grantAccess() {
    if (granting || !props.onGrantAccess) return;
    setGranting(true);
    setError(null);
    try {
      if (!(await props.onGrantAccess())) setError(t("collab.access.failed"));
    } catch {
      setError(t("collab.access.failed"));
    } finally {
      setGranting(false);
    }
  }

  /**
   * 左侧只列 Memmy 自己能读到任务的 Agent。用户添加的 Agent 不出现：Memmy 不读它们的记录，
   * 它们的任务要由那个 Agent 自己提交进项目，没有可勾选的历史。
   */
  const agents = useMemo(() => {
    const seen = new Map<string, string>();
    for (const session of sessions ?? []) if (!seen.has(session.sourceId)) seen.set(session.sourceId, session.agentName);
    return [...seen.entries()].map(([sourceId, name]) => ({ sourceId, name }));
  }, [sessions]);

  /**
   * 列表用的 Agent 比导航栏慢一帧：点一下立刻看到选中态，列表的内容跟着补上。
   * 两者在稳定后始终一致，只是渲染优先级不同。
   */
  const shownAgentId = useDeferredValue(agentId);
  const activeAgent = agents.find((agent) => agent.sourceId === shownAgentId) ?? agents.find((agent) => agentHasLinks(links, agent.sourceId)) ?? agents[0] ?? null;
  const kind = activeAgent ? groupingKind(activeAgent.sourceId) : "directory";
  const view = useMemo(
    () => (activeAgent ? groupAgentSessions(sessions ?? [], activeAgent.sourceId, query) : { groups: [], ungrouped: [] }),
    [activeAgent, query, sessions]
  );
  // 每次渲染都把两份勾选树串成 JSON 再排序很浪费：两者都不变时沿用上一次的结果。
  const changed = useMemo(() => !linksEqual(links, saved), [links, saved]);
  /** 当前勾选会关联的任务数，用于在提交前提示云端只保留最近 20 个。 */
  const selectedCount = useMemo(
    () => (sessions ?? []).filter((session) => isSessionChecked(links, session)).length,
    [sessions, links]
  );

  function toggleExpanded(groupId: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }

  async function confirm() {
    if (!changed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await props.onLinked(await collab.saveLinks(project.id, links));
    } catch {
      // A multi-task unlink can have succeeded in part; keep the selection so the person can retry.
      setError(t("collab.pick.saveFailedRetry"));
    } finally {
      setBusy(false);
    }
  }

  function requestSave() {
    if (!changed || busy) return;
    // Only removing a previously saved whole group needs confirmation; exclusions of individual sessions do not.
    const removedGroup = saved.groups.some((group) => !findGroupLink(links, group.sourceId, group.groupId));
    if (removedGroup) setConfirmUnlinkGroup(true);
    else void confirm();
  }

  function sessionRow(session: LocalAgentSession, nested: boolean) {
    const checked = isSessionChecked(links, session);
    const excluded = !checked && Boolean(session.group && findGroupLink(links, session.sourceId, session.group.id));
    const summary = readableSummary(session.lastQuestion);
    return (
      <label key={localSessionKey(session)} className={`${styles.pickRow} ${nested ? styles.pickRowNested : ""}`}>
        <input type="checkbox" checked={checked} onChange={() => setLinks((current) => toggleSessionLink(current, session))} />
        {/* 已关联 Agent 的标题来自它自己的索引，索引没跟上时退回最近一句提问，不显示空行 */}
        <span className={`${styles.pickTitle} ${excluded ? styles.pickTitleExcluded : ""}`} title={summary || session.title}>
          {session.title || summary || t("appFrame.search.untitled")}
        </span>
        <span className={styles.meta}>{excluded ? t("collab.pick.excluded") : formatSessionTime(session.updatedAt)}</span>
      </label>
    );
  }

  /**
   * 列表本体只在数据真的变化时重建。切换 Agent 时导航栏的选中态立刻画出来，
   * 列表的重建留到下一帧（`useDeferredValue`），点击不必等这份渲染完才有反馈。
   */
  const pickerList = useMemo(() => (
        <div className={styles.pickList}>
          {sessions === null && !error ? (
            <p className={styles.loading}>{t("collab.pick.loading")}</p>
          ) : !view.groups.length && !view.ungrouped.length ? (
            <p className={styles.loading}>{t("collab.pick.empty")}</p>
          ) : (
            <>
              {view.groups.length ? <p className={styles.pickSection}>{t(`collab.pick.unit.${kind}` as MessageKey)}</p> : null}
              {view.groups.map((item) => {
                const state = groupCheckState(links, activeAgent!.sourceId, item);
                const isOpen = Boolean(query.trim()) || expanded.has(item.group.id);
                const GroupIcon = kind === "directory" ? Folder : Layers;
                return (
                  <div key={item.group.id} className={styles.groupBlock}>
                    <div className={styles.groupRow}>
                      <input
                        type="checkbox"
                        aria-label={item.group.label}
                        checked={state === "checked"}
                        ref={(element) => {
                          if (element) element.indeterminate = state === "mixed";
                        }}
                        onChange={() => setLinks((current) => {
                          // Search narrows visible rows, not the scope of the whole-group operation.
                          const complete = groupAgentSessions(sessions ?? [], activeAgent!.sourceId, "").groups
                            .find((group) => group.group.id === item.group.id) ?? item;
                          return toggleGroupLink(current, activeAgent!.sourceId, complete);
                        })}
                      />
                      <button type="button" className={styles.groupToggle} aria-expanded={isOpen} title={item.group.path ?? item.group.label} onClick={() => toggleExpanded(item.group.id)}>
                        <span className={styles.groupIcon}><GroupIcon size={15} aria-hidden="true" /></span>
                        <span className={styles.groupText}>
                          <span className={styles.groupName}>{item.group.label}</span>
                          {findGroupLink(links, activeAgent!.sourceId, item.group.id) ? <span className={styles.groupHint}>{t("collab.pick.wholeGroup")}</span> : null}
                        </span>
                        {isOpen ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}
                      </button>
                    </div>
                    {isOpen ? item.sessions.map((session) => sessionRow(session, true)) : null}
                  </div>
                );
              })}
              {view.ungrouped.length ? <p className={styles.pickSection}>{t(`collab.pick.ungrouped.${kind}` as MessageKey)}</p> : null}
              {view.ungrouped.map((session) => sessionRow(session, false))}
            </>
          )}
        </div>
  ), [error, sessions, view, kind, activeAgent, links, expanded, query, t]);

  return (
    <>
    <Modal
      open={props.open}
      title={t("collab.pick.title")}
      subtitle={t("collab.pick.subtitle", { project: project.name })}
      onClose={busy || confirmUnlinkGroup || demoGuide ? undefined : props.onClose}
      closeLabel={t("common.close")}
      closeContent={<X size={16} aria-hidden="true" />}
      // 展示模式把弹窗收窄一点：说明卡才贴得到它左边，不压住刚扫出来的会话列表。
      className={demoGuide ? `${styles.pickModal} ${styles.pickModalDemo}` : styles.pickModal}
      backdropClassName={demoGuide ? `${styles.backdrop} ${styles.backdropYield}` : styles.backdrop}
      demoGuideAnchor={demoGuide ? "associate-pick" : undefined}
      // 展示模式没有底部：不给按钮，也不留任何说明文字，状态由左边的引导卡片说。
      footer={demoGuide ? undefined : (
        <>
          {error ? <span className={styles.error} role="alert">{error}</span> : selectedCount > SESSIONS_PER_MEMBER_LIMIT ? (
            <span className={styles.pickLimit} role="status">
              {t("collab.pick.limitHint", { limit: String(SESSIONS_PER_MEMBER_LIMIT) })}
            </span>
          ) : <span />}
          <span className={styles.footerButtons}>
            <Button variant="ghost" disabled={busy} onClick={props.onClose}>{t("collab.cancel")}</Button>
            {/* 未授权时没有可保存的选择：这一支的按钮是「授权并继续」，点完正文换成任务列表。 */}
            {accessGranted ? (
              <Button variant="primary" disabled={!changed || busy} onClick={requestSave}>
                {busy ? t("collab.pick.saving") : t("collab.pick.save")}
              </Button>
            ) : (
              <Button variant="primary" disabled={granting} onClick={() => void grantAccess()}>
                {granting ? t("collab.access.installing") : t("collab.pick.gateGrant")}
              </Button>
            )}
          </span>
        </>
      )}
    >
      {!accessGranted ? (
        /* 未授权：同一个弹窗只给授权说明，不列出任何本机记录，也不给「保存」。 */
        <div className={styles.pickBody} inert={demoGuide ? true : undefined}>
          <div className={styles.gate}>
            <Memmy pose="shield" size={72} className={styles.gateMascot} />
            <h3 className={styles.gateTitle}>{t("collab.pick.gate")}</h3>
            <p className={styles.gateText}>{t("collab.pick.gateHint", { project: project.name })}</p>
            <CollabAgentChips agents={gateAgents} />
            {gateDisabledNames.length ? (
              <p className={styles.gateOff}>{t("collab.pick.gateDisabled", { names: gateDisabledNames.join("、") })}</p>
            ) : null}
            <p className={styles.gateSmall}>{t("collab.pick.gateNote")}</p>
          </div>
        </div>
      ) : (
      <div className={styles.pickBody} inert={demoGuide ? true : undefined}>
        <div className={styles.agentColumn}>
        <nav className={styles.agentList} aria-label="Agent">
          {agents.map((agent) => {
            const logo = agentSourceLogoUrl(agent.sourceId);
            const active = agent.sourceId === (agentId ?? activeAgent?.sourceId);
            return (
              <button
                key={agent.sourceId}
                type="button"
                aria-pressed={active}
                className={`${styles.agentItem} ${active ? styles.agentItemActive : ""}`}
                onClick={() => {
                  setAgentId(agent.sourceId);
                  setQuery("");
                }}
              >
                <span className={styles.agentLogo}>{logo ? <img src={logo} alt="" /> : <span className={styles.agentMark}>{Array.from(agent.name)[0] ?? "A"}</span>}</span>
                <span className={styles.agentText}>
                  <span className={styles.agentName}>{pickerAgentName(agent)}</span>
                  {/* 第二行只说它按什么分组；是否关联了任务由右侧绿点表示 */}
                  <span className={styles.agentHint}>{t(`collab.pick.groupBy.${groupingKind(agent.sourceId)}` as MessageKey)}</span>
                </span>
                {agentHasLinks(links, agent.sourceId) ? <span className={styles.agentDot} aria-hidden="true" /> : null}
              </button>
            );
          })}
        </nav>
          <button type="button" className={styles.addAgent} title={t("collab.pick.addAgentHint")} onClick={() => { setAddAgentOpen(true); }}>
            <span className={styles.addAgentMark} aria-hidden="true"><Plug size={14} /></span>
            {/* 入口只占一行：第二行的说明收进悬停提示，这一列太窄，两行会被挤断 */}
            <span className={styles.addAgentLabel}>{t("collab.pick.addAgent")}</span>
          </button>
        </div>
        <section className={styles.pickMain}>
          <label className={styles.search}>
            <Search size={14} aria-hidden="true" />
            <input
              value={query}
              placeholder={activeAgent ? t("collab.pick.searchIn", { agent: pickerAgentName(activeAgent) }) : t("collab.pick.search")}
              aria-label={t("collab.pick.search")}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          {pickerList}
        </section>
      </div>
      )}
    </Modal>
    <ConfirmDialog
      open={props.open && confirmUnlinkGroup}
      title={t("collab.pick.unlinkGroupTitle")}
      message={t("collab.pick.unlinkGroupMessage")}
      cancelLabel={t("collab.cancel")}
      confirmLabel={t("collab.pick.unlinkGroupConfirm")}
      confirmVariant="danger"
      icon={null}
      onCancel={() => setConfirmUnlinkGroup(false)}
      onConfirm={() => {
        setConfirmUnlinkGroup(false);
        void confirm();
      }}
    />
    <CollabAgentConnectDialog
      open={props.open && addAgentOpen}
      projectName={props.project.name}
      added={addedAgents}
      collab={collab}
      onRemoved={() => void reloadAddedAgents()}
      onClose={() => setAddAgentOpen(false)}
      onStart={(name, skillDirectory) => {
        // 这一步只建本机任务：技能由那条任务装进目标 Agent，装好之后在那个 Agent 里就能用协作项目。
        if (!appState) return;
        const projectId = resolveCollabConnectProjectId(props.project, appState.state.agent.projects);
        writePendingFirstEncounterTaskLaunch(
          typeof window === "undefined" ? undefined : window.sessionStorage,
          buildCollabAgentConnectPrompt(name, skillDirectory),
          projectId ? { projectId } : {}
        );
        appState.dispatch(agentActions.newChatRequested());
        appState.dispatch(appActions.navigate("/main"));
        setAddAgentOpen(false);
        props.onClose();
      }}
    />
    </>
  );
}

function messageOf(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message.trim() : String(cause).trim();
  return raw.startsWith("[") || raw.startsWith("{") ? "" : raw;
}
