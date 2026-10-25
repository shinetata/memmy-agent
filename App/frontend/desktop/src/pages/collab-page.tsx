import { ChevronDown, ChevronRight, Cloud, Folder, Layers, Link2, MessageSquarePlus, MoreHorizontal, PanelRight, PanelRightClose, Pencil, Quote, Search, Settings, Trash2, UserPlus, Users, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
  createHttpCollabClient,
  type CollabClient,
  type CollabItem,
  type CollabItemsView,
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
  requestCreateProject,
  requestTaskPicker,
  selectCollabProject,
  sharedProjectFor,
  subscribeCollabProjects
} from "../app/collab-projects-store.js";
import type { MemmyAgentProject } from "../api/memmy-agent-client.js";
import { openAgentTaskInChat } from "../app/open-agent-task.js";
import type { AgentTaskView } from "../state/agent-chat-slice.js";
import { useOptionalAppState } from "../state/app-state.js";
import { ApiRequestError } from "../api/http.js";
import {
  readProjectInstructions,
  saveProjectInstructions,
  type ProjectInstructions
} from "../api/projects-client.js";
import { useOptionalAgentRuntimeBridge } from "../app/agent-runtime-bridge.js";
import { useApiClients } from "../app/providers.js";
import { Button } from "../components/button.js";
import { ConfirmDialog } from "../components/confirm-dialog.js";
import { Modal } from "../components/modal.js";
import type { MessageKey } from "../i18n/messages.js";
import { useTranslation } from "../i18n/use-translation.js";
import { agentSourceDisplayName, agentSourceLogoUrl } from "./agent-source-logos.js";
import { AppFrame } from "./app-frame.js";
import { memberColor } from "./collab-member-color.js";
import { ProjectMembersDialog } from "./collab-members-dialog.js";
import styles from "./collab-page.module.css";
import { MemoryMarkdown } from "./memory/memory-markdown.js";

export { memberColor };

const TOAST_MS = 1_800;
/** The board shows ten sessions at a time, so a long project stays scannable. */
const SESSION_PAGE_SIZE = 10;
/** 看板顶部的一次性提示停留时长。 */
const BOARD_NOTICE_MS = 6_000;

/** How often the board refreshes while an association uploads. */
const PROGRESS_POLL_MS = 1_200;
const MAX_PROJECT_NAME_CHARS = 20;
const MAX_LOCAL_SESSIONS = 500;
const EMPTY_LINKS: CollabLinks = { groups: [], sessions: [] };
/** 还没有设定指令时的空值，看板与弹窗共用。 */
const EMPTY_PROJECT_INSTRUCTIONS: ProjectInstructions = {
  text: "",
  origin: null,
  cloudProjectId: null,
  updatedAt: null
};
/** Member filter: anyone, only me, or only the other members. */
type MemberFilter = "all" | "me" | "others";
type BoardTab = "sessions" | "items";

/** How an agent organizes its sessions, which names the groups in the picker. */
export type GroupingKind = "directory" | "project" | "workspace" | "workbuddy";

export function groupingKind(sourceId: string): GroupingKind {
  if (sourceId === "codex") return "project";
  if (sourceId === "cursor") return "workspace";
  if (sourceId === "workbuddy") return "workbuddy";
  return "directory";
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

/** Checked when the whole group is linked, mixed when only some of its sessions are. */
export function groupCheckState(links: CollabLinks, sourceId: string, view: SessionGroupView): "checked" | "mixed" | "unchecked" {
  if (findGroupLink(links, sourceId, view.group.id)) return "checked";
  return view.sessions.some((session) => isSessionChecked(links, session)) ? "mixed" : "unchecked";
}

/** Links the whole group, replacing its single-session links, or unlinks it entirely. */
export function toggleGroupLink(links: CollabLinks, sourceId: string, view: SessionGroupView): CollabLinks {
  const inGroup = new Set(view.sessions.map(localSessionKey));
  const sessions = links.sessions.filter((link) => !inGroup.has(localSessionKey(link)));
  if (findGroupLink(links, sourceId, view.group.id)) {
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

/** Key that identifies a local session across agents. */
export function localSessionKey(session: { sourceId: string; conversationId: string }): string {
  return `${session.sourceId}\u0000${session.conversationId}`;
}

/**
 * The board of one project: its header, the two tabs, and the session list. A project is local; when its sharing
 * switch is on, the sessions come from the cloud and the list also carries members, references and items.
 */
export function CollabPage() {
  const { clients } = useApiClients();
  // The board belongs to a project on this computer, so it reads the same project list the sidebar does.
  const appState = useOptionalAppState();
  const projects = appState?.state.agent.projects ?? [];
  const tasks = appState?.state.agent.tasks ?? [];
  const { t } = useTranslation();
  const collab = useMemo(() => (clients ? createHttpCollabClient(clients.runtimeConfig) : null), [clients]);
  const snapshot = useSyncExternalStore(subscribeCollabProjects, getCollabProjectsSnapshot, getCollabProjectsSnapshot);
  const [page, setPage] = useState<CollabSessionPage | null>(null);
  const [tab, setTab] = useState<BoardTab>("sessions");
  const [member, setMember] = useState<MemberFilter>("all");
  const [query, setQuery] = useState("");
  const [searchDraft, setSearchDraft] = useState("");
  const [pageIndex, setPageIndex] = useState(0);
  const [reading, setReading] = useState<{ session: CollabProjectSession; turns: CollabSessionTurn[] } | null>(null);
  const [readingId, setReadingId] = useState<string | null>(null);
  const [pickOpen, setPickOpen] = useState(false);
  /** Choosing which of the project's own Memmy sessions members may read. */
  const [taskPickerOpen, setTaskPickerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 看板右侧的项目配置：指令等项目的配置项在这里查看与编辑，与侧栏无关。 */
  const [configOpen, setConfigOpen] = useState(true);
  /** 项目指令：本机项目与协作项目共用同一份，协作项目以云端为准。 */
  const [instructions, setInstructions] = useState<ProjectInstructions>(EMPTY_PROJECT_INSTRUCTIONS);
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  /** 「邀请」in the header and「项目成员」in the sidebar menu open the same dialog. */
  const [membersOpen, setMembersOpen] = useState(false);
  const [deleting, setDeleting] = useState<CollabProjectSession | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  /** Upload progress of a queued association; the list grows while it runs. */
  const [progress, setProgress] = useState<CollabSyncProgress | null>(null);
  /** Bumped when an association is queued, so polling starts without waiting for a filter or page change. */
  const [pollKey, setPollKey] = useState(0);
  /** Projects whose tasks were already uploaded for this opening, so filters do not re-upload them. */
  const syncedProjectRef = useRef<Set<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS);
  }, []);

  useEffect(() => {
    if (collab) void loadCollabProjects(collab);
  }, [collab]);

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
  const shared = sharedProjectFor(snapshot.projects, project?.id);
  const sharedId = shared?.id ?? null;
  const projectId = project?.id ?? null;

  // A project that just started sharing asks which of its own sessions go to the cloud.
  useEffect(() => {
    if (!projectId || snapshot.taskPickerFor !== projectId) return;
    consumeTaskPickerRequest();
    setSettingsOpen(false);
    setTaskPickerOpen(true);
  }, [projectId, snapshot.taskPickerFor]);

  /**
   * 项目指令由所有者与管理员维护；仅在本机的项目没有其他成员，本机的人就是所有者。
   * 指令读取失败时按云端列表里的内容显示，只影响展示，注入仍以本机已同步的为准。
   */
  const canEditInstructions = !shared || shared.role === "owner" || shared.role === "admin";
  const instructionsDirectory = project?.rootPath ?? null;
  const runtimeConfig = clients?.runtimeConfig ?? null;
  /** 云端列表里的指令：本机还没同步到时先按它显示。 */
  const sharedInstructions = shared?.instructions ?? "";
  const runtimeBaseUrl = runtimeConfig?.baseUrl ?? null;

  // 项目一打开就读一次指令；协作项目的指令在读取项目列表时已同步到本机，读不到时退回云端列表里的内容。
  // 依赖都是基本类型：客户端对象每次渲染可能都是新的，用它做依赖会反复触发读接口。
  useEffect(() => {
    if (!instructionsDirectory || !runtimeBaseUrl || !runtimeConfig) {
      setInstructions({ ...EMPTY_PROJECT_INSTRUCTIONS, text: sharedInstructions });
      return;
    }
    let cancelled = false;
    void readProjectInstructions(runtimeConfig, instructionsDirectory)
      .then((view) => {
        if (cancelled) return;
        setInstructions(view.text ? view : { ...view, text: sharedInstructions });
      })
      .catch(() => {
        if (!cancelled) setInstructions({ ...EMPTY_PROJECT_INSTRUCTIONS, text: sharedInstructions });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runtimeConfig 的身份每渲染都可能变化，改看它的地址
  }, [instructionsDirectory, runtimeBaseUrl, shared?.id, sharedInstructions]);

  /**
   * 保存指令：协作项目写云端（权限也在云端判定），再由后端同步回本机；仅在本机的项目直接写本机。
   * 保存后对此后开始的会话生效。
   */
  async function saveInstructions(text: string): Promise<void> {
    if (!instructionsDirectory) return;
    if (sharedId && collab) {
      const updated = await collab.setInstructions(sharedId, text, instructionsDirectory);
      replaceCollabProject(updated);
      setInstructions({ ...instructions, text: updated.instructions, origin: "cloud", cloudProjectId: updated.id });
      return;
    }
    if (!runtimeConfig?.baseUrl) throw new Error(t("collab.instructions.saveFailed"));
    const saved = await saveProjectInstructions(runtimeConfig, instructionsDirectory, text);
    setInstructions(saved);
  }

  // One request builds every page: the query and the member filter decide what `total` counts.
  useEffect(() => {
    if (!collab || !sharedId) {
      setPage(null);
      return;
    }
    let cancelled = false;
    const first = pageIndex === 0 && !query;
    if (first) setPage(null);
    const load = async () => {
      try {
        // The list is read first: waiting for an upload that may be queued behind other work is what made the
        // board sit on "loading". The upload starts in parallel and the next poll picks up what it adds. It runs
        // once per board opening and only for this project, so a search or a page change never re-uploads.
        if (!syncedProjectRef.current.has(sharedId)) {
          syncedProjectRef.current.add(sharedId);
          void collab.syncSessions({ tasksOnly: true, projectId: sharedId })
            .then(() => refreshAfterUploadRef.current())
            .catch(() => undefined);
        }
        const result = await collab.listSessions(sharedId, {
          ...(query ? { query } : {}),
          ...(member === "all" ? {} : { member }),
          offset: pageIndex * SESSION_PAGE_SIZE,
          limit: SESSION_PAGE_SIZE
        });
        if (cancelled) return;
        setPage(result);
        replaceCollabProject(result.project);
      } catch (cause) {
        if (!cancelled) showToast(messageOf(cause));
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [collab, sharedId, query, member, pageIndex, showToast]);

  /**
   * Called once the background upload of this project's own tasks finishes, so a task finished moments ago shows
   * up without the board having waited for it.
   */
  const refreshAfterUploadRef = useRef<() => void>(() => undefined);
  const refreshAfterUpload = useCallback(() => {
    if (!collab || !sharedId) return;
    void collab.listSessions(sharedId, {
      ...(query ? { query } : {}),
      ...(member === "all" ? {} : { member }),
      offset: pageIndex * SESSION_PAGE_SIZE,
      limit: SESSION_PAGE_SIZE
    })
      .then((result) => setPage(result))
      .catch(() => undefined);
  }, [collab, sharedId, query, member, pageIndex]);
  refreshAfterUploadRef.current = refreshAfterUpload;

  /** Re-reads the current page without blanking it, so rows arrive instead of the board flickering. */
  const refreshSessions = useCallback(async (projectId: string) => {
    if (!collab) return;
    try {
      const result = await collab.listSessions(projectId, {
        ...(query ? { query } : {}),
        ...(member === "all" ? {} : { member }),
        offset: pageIndex * SESSION_PAGE_SIZE,
        limit: SESSION_PAGE_SIZE
      });
      setPage(result);
      replaceCollabProject(result.project);
    } catch {
      // A failed refresh keeps the last page; the next poll retries.
    }
  }, [collab, member, pageIndex, query]);

  // While an association uploads in the background, poll its progress and the list so rows arrive one by one.
  useEffect(() => {
    if (!collab || !sharedId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      const [next, listing] = await Promise.all([
        collab.getSyncProgress(sharedId).catch(() => null),
        collab.listSessions(sharedId, { ...(member === "all" ? {} : { member }), ...(query ? { query } : {}), offset: pageIndex * SESSION_PAGE_SIZE, limit: SESSION_PAGE_SIZE }).catch(() => null)
      ]);
      if (cancelled) return;
      if (listing) {
        setPage(listing);
        replaceCollabProject(listing.project);
      }
      setProgress(next);
      if (next?.running) timer = setTimeout(() => void tick(), PROGRESS_POLL_MS);
    };

    // Opening the board also joins an upload that started before it (or before a reload).
    void collab.getSyncProgress(sharedId)
      .then((current) => {
        if (cancelled) return;
        setProgress(current);
        if (current.running) timer = setTimeout(() => void tick(), PROGRESS_POLL_MS);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [collab, sharedId, member, query, pageIndex, pollKey]);

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  const sessions = page?.sessions ?? null;
  const filtering = Boolean(query) || member !== "all";

  function clearFilters() {
    setSearchDraft("");
    setQuery("");
    setMember("all");
  }
  const total = page?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / SESSION_PAGE_SIZE));

  // A new query or member filter starts again from the first page.
  useEffect(() => {
    setPageIndex(0);
  }, [query, member, sharedId]);

  // Keep the page in range when a deletion or a filter change leaves it past the end.
  useEffect(() => {
    if (pageIndex > 0 && pageIndex >= pageCount) setPageIndex(pageCount - 1);
  }, [pageCount, pageIndex]);

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

  async function copyLink(session: CollabProjectSession) {
    try {
      await navigator.clipboard.writeText(session.shareText);
      showToast(t("collab.session.linkCopied"));
    } catch {
      showToast(t("collab.session.copyFailed"));
    }
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

  const memberOptions: { value: MemberFilter; label: string }[] = [
    { value: "all", label: t("collab.filter.all") },
    { value: "me", label: t("collab.filter.you") },
    { value: "others", label: t("collab.filter.others") }
  ];

  return (
    <AppFrame title={project?.name ?? t("nav.collab")}>
      <div className={styles.page}>
        {!project ? (
          snapshot.projects === null ? (
            <p className={styles.loading}>{t("collab.loading")}</p>
          ) : (
            <div className={styles.empty}>
              <b>{t("collab.empty.title")}</b>
              <p>{t("collab.empty.body")}</p>
              <Button variant="primary" size="sm" onClick={() => requestCreateProject()}>{t("home.project.new")}</Button>
            </div>
          )
        ) : (
          <>
            {/* 看板与右侧的项目配置并排：配置属于项目，不随会话列表滚动。 */}
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
                  <span className={styles.boardIcon} aria-hidden="true">
                    {shared ? <Cloud size={22} /> : <Folder size={22} />}
                  </span>
                  <h1 className={styles.boardName}>{project.name}</h1>
                  <span className={styles.boardScope}>
                    {shared
                      ? t("collab.members", { count: String(shared.memberCount) })
                      : t("collab.board.localOnly")}
                  </span>
                  <span className={styles.grow} />
                  {shared ? (
                    <Button size="sm" variant="ghost" onClick={() => setMembersOpen(true)}>
                      <UserPlus size={15} aria-hidden="true" />
                      {t("collab.members.invite")}
                    </Button>
                  ) : null}
                  {/* 收起与展开不同时出现：展开时入口在面板标题栏，收起后才回到这里，与 WorkBuddy 一致 */}
                  {configOpen ? null : (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={t("collab.config.expand")}
                      title={t("collab.config.expand")}
                      onClick={() => setConfigOpen(true)}
                    >
                      <PanelRight size={15} aria-hidden="true" />
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t("collab.settings.open")}
                    title={t("collab.settings.open")}
                    onClick={() => setSettingsOpen(true)}
                  >
                    <Settings size={15} aria-hidden="true" />
                  </Button>
                </header>

                <div className={styles.tabs} role="tablist">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tab === "sessions"}
                    className={`${styles.tab} ${tab === "sessions" ? styles.tabOn : ""}`}
                    onClick={() => setTab("sessions")}
                  >
                    {t("collab.tab.sessions")}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tab === "items"}
                    className={`${styles.tab} ${tab === "items" ? styles.tabOn : ""}`}
                    onClick={() => setTab("items")}
                  >
                    {t("collab.tab.items")}
                  </button>
                </div>

                {tab === "sessions" ? (
                  <>
                    {shared ? (
                      <>
                        <div className={styles.toolbar}>
                          <MemberFilterPicker
                            value={member}
                            options={memberOptions}
                            onChange={setMember}
                          />
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
                                if (event.key === "Enter") setQuery(searchDraft.trim());
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
                          <span className={styles.grow} />
                          <Button size="sm" onClick={() => setPickOpen(true)}>
                            <Link2 size={14} aria-hidden="true" />
                            {t("collab.associate")}
                          </Button>
                        </div>

                        {progress?.running ? (
                          <div className={styles.syncStrip} role="status" aria-live="polite">
                            <span className={styles.syncText}>
                              {t("collab.sync.progress", {
                                completed: String(progress.completed),
                                total: String(progress.total)
                              })}
                            </span>
                            <span className={styles.syncBar} aria-hidden="true">
                              <span
                                className={styles.syncBarFill}
                                style={{ width: `${progress.total ? Math.round((progress.completed / progress.total) * 100) : 0}%` }}
                              />
                            </span>
                          </div>
                        ) : null}
                        {sessions === null ? (
                          <p className={styles.loading}>{t("collab.loading")}</p>
                        ) : sessions.length === 0 && filtering ? (
                          // A filter with no hits is not an empty project: say what was searched and offer a way back.
                          <div className={styles.empty}>
                            <b>{t("collab.sessions.noMatch.title")}</b>
                            <p>
                              {query
                                ? t("collab.sessions.noMatch.body", { query })
                                : t("collab.sessions.noMatch.bodyMember")}
                            </p>
                            <Button size="sm" onClick={clearFilters}>{t("collab.sessions.noMatch.clear")}</Button>
                          </div>
                        ) : sessions.length === 0 ? (
                          // An empty project is the one place to explain the tab: what it collects and what a
                          // member can do with it. New projects start here, so it carries the first-run guidance.
                          <section className={styles.guide} aria-label={t("collab.sessions.empty.title")}>
                            <b className={styles.guideTitle}>{t("collab.sessions.empty.title")}</b>
                            <p className={styles.guideLead}>{t("collab.sessions.empty.lead")}</p>
                            <ul className={styles.guideList}>
                              {([
                                { key: "task", icon: <MessageSquarePlus size={15} aria-hidden="true" /> },
                                { key: "associate", icon: <Link2 size={15} aria-hidden="true" /> },
                                { key: "quote", icon: <Quote size={15} aria-hidden="true" /> },
                                { key: "review", icon: <Users size={15} aria-hidden="true" /> }
                              ] as const).map((item) => (
                                <li key={item.key} className={styles.guideItem}>
                                  <span className={styles.guideIcon} aria-hidden="true">{item.icon}</span>
                                  <div className={styles.guideText}>
                                    <b>{t(`collab.sessions.empty.${item.key}.title` as MessageKey)}</b>
                                    <span>{t(`collab.sessions.empty.${item.key}.body` as MessageKey)}</span>
                                  </div>
                                </li>
                              ))}
                            </ul>
                          </section>
                        ) : (
                          <>
                          <ul className={styles.list}>
                            {sessions.map((session) => {
                              // Members see this person's nickname in their own Memmy, so show the nickname here too.
                              const name = session.memberName || (session.mine ? t("collab.session.you") : "");
                              const menuOpen = openMenuId === session.id;
                              return (
                                <li
                                  key={session.id}
                                  className={`${styles.row} ${styles.rowOpenable} ${menuOpen ? styles.rowMenuOpen : ""}`}
                                  onClick={() => void openSession(session)}
                                >
                                  <span
                                    className={styles.avatar}
                                    style={{ background: memberColor(session.memberName || (session.mine ? t("collab.session.you") : "")) }}
                                    aria-hidden="true"
                                  >
                                    {Array.from(name)[0] ?? "?"}
                                  </span>
                                  <div className={styles.rowText}>
                                    <span className={styles.rowTitle}>{session.title}</span>
                                    {session.lastQuestion ? <span className={styles.rowSummary}>{session.lastQuestion}</span> : null}
                                  </div>
                                  <span className={styles.meta}>
                                    {[name, formatSessionTime(session.lastActiveAt)].filter(Boolean).join(" · ")}
                                  </span>
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
                                  {menuOpen ? (
                                    <>
                                      {/*
                                       * The row itself opens the session reader. Every click that belongs to the menu has to
                                       * stop here, or copying a link also opens the session behind the toast.
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
                                        <button type="button" role="menuitem" className={styles.menuItem} onClick={() => { setOpenMenuId(null); void copyLink(session); }}>
                                          {t("collab.session.copyLink")}
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
                            })}
                          </ul>
                          {total > SESSION_PAGE_SIZE ? (
                            <nav className={styles.pager} aria-label={t("collab.sessions.pager")}>
                              <span className={styles.pagerInfo}>
                                {t("collab.sessions.pageInfo", {
                                  page: String(pageIndex + 1),
                                  pages: String(pageCount),
                                  total: String(total)
                                })}
                              </span>
                              <span className={styles.grow} />
                              <Button size="sm" variant="ghost" disabled={pageIndex === 0} onClick={() => setPageIndex(pageIndex - 1)}>
                                {t("collab.sessions.prevPage")}
                              </Button>
                              <Button size="sm" variant="ghost" disabled={pageIndex >= pageCount - 1} onClick={() => setPageIndex(pageIndex + 1)}>
                                {t("collab.sessions.nextPage")}
                              </Button>
                            </nav>
                          ) : total > 0 ? (
                            <p className={styles.pagerInfo}>{t("collab.sessions.totalOnly", { total: String(total) })}</p>
                          ) : null}
                          </>
                        )}
                      </>
                    ) : (
                      <LocalProjectSessions
                        tasks={localTasks}
                        onOpenTask={(task) => {
                          const dispatch = appState?.dispatch;
                          if (!dispatch) return;
                          void openAgentTaskInChat({ memmyAgent: clients?.memmyAgent, dispatch, task });
                        }}
                      />
                    )}
                  </>
                ) : shared && collab ? (
                  <CollabItemsPanel key={shared.id} collab={collab} projectId={shared.id} onToast={showToast} />
                ) : (
                  // Items come from project memory, which needs sharing; the notice says where to turn it on.
                  <section className={styles.localNotice} aria-label={t("collab.tab.items")}>
                    <b>{t("collab.items.empty.title")}</b>
                    <p>{t("collab.items.empty.notShared")}</p>
                  </section>
                )}
              </div>
            </div>
            {configOpen ? (
              <ProjectConfigPanel
                instructions={instructions}
                canEdit={canEditInstructions}
                onEdit={() => setInstructionsOpen(true)}
                onCollapse={() => setConfigOpen(false)}
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
        <ProjectBoardSettingsDialog
          open={settingsOpen}
          project={project}
          shared={shared}
          collab={collab}
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
          taskCount={localTasks.length}
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
          onClose={() => setPickOpen(false)}
          onLinked={(result) => {
            // The selection is already saved; the upload continues in the background and the board shows it.
            setPickOpen(false);
            if (result.started) {
              setProgress({ running: true, total: result.started, completed: 0, failed: 0 });
              setPollKey((key) => key + 1);
              showToast(t("collab.pick.queued", { count: String(result.started) }));
            } else {
              showToast(t("collab.pick.done"));
            }
            void refreshSessions(shared.id);
          }}
        />
      ) : null}
      <SessionReaderModal
        session={reading}
        loading={readingId !== null}
        onClose={() => setReading(null)}
        onCopy={(session) => void copyLink(session)}
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
}

/**
 * The sessions tab of a project that is not shared: this computer's own tasks for it, nothing more. Sharing is
 * turned on in the project settings, so the list stays a list instead of carrying a reminder.
 */
function LocalProjectSessions(props: {
  tasks: AgentTaskView[];
  onOpenTask: (task: AgentTaskView) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {props.tasks.length === 0 ? (
        <p className={styles.localEmpty}>{t("collab.board.noTasks")}</p>
      ) : (
        <ul className={styles.list}>
          {props.tasks.map((task) => (
            <li
              key={task.sessionKey}
              className={`${styles.row} ${styles.rowOpenable}`}
              onClick={() => props.onOpenTask(task)}
            >
              <span className={styles.localIcon} aria-hidden="true"><Folder size={15} /></span>
              <div className={styles.rowText}>
                <span className={styles.rowTitle}>{task.title}</span>
                {task.preview ? <span className={styles.rowSummary}>{task.preview}</span> : null}
              </div>
              <span className={styles.meta}>{formatSessionTime(task.updatedAt)}</span>
            </li>
          ))}
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
      ) : count === 0 ? (
        <p className={styles.localEmpty}>{t("collab.tasks.empty")}</p>
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
            {tasks.map((task) => (
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
                  {task.lastQuestion ? <span className={styles.rowSummary}>{task.lastQuestion}</span> : null}
                </div>
                <span className={styles.meta}>{formatSessionTime(task.updatedAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Modal>
  );
}

/** 项目指令的上限，与云端和注入侧一致（1 万字，与 WorkBuddy 相同）：全文注入，长度决定每轮的开销。 */
const MAX_INSTRUCTION_CHARS = 10_000;

/**
 * 看板右侧的项目配置。项目里的配置项放在这里查看：先有指令，知识库、技能与外部资料随后加入；
 * 所有者与管理员可以直接编辑，成员只读。
 */
function ProjectConfigPanel(props: {
  instructions: ProjectInstructions;
  canEdit: boolean;
  onEdit: () => void;
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
                <Pencil size={13} aria-hidden="true" />
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
      </div>
    </aside>
  );
}

/**
 * 项目指令的编辑与查看。所有者与管理员保存后对此后开始的会话生效；成员打开时只读。
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
 * The board's settings: the one switch that decides whether this project's sessions leave the computer, and the
 * entry to choosing which of them members can read.
 */
function ProjectBoardSettingsDialog(props: {
  open: boolean;
  project: MemmyAgentProject;
  shared: CollabProject | null;
  collab: CollabClient | null;
  onClose: () => void;
  onShared: () => void;
  onUnshared: () => void;
  onPickSessions: () => void;
  /** How many of the project's own sessions could be shared, which decides whether choosing them is worth a dialog. */
  taskCount: number;
  onNotice: (message: string) => void;
  onFailed: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  /** Which switch is running, so a slow cloud says what it is doing instead of only greying the box. */
  const [action, setAction] = useState<"sharing" | "stopping" | null>(null);
  /** Asking again before a shared project leaves the cloud, since members lose access. */
  const [confirmStop, setConfirmStop] = useState(false);
  /** How many of the project's own sessions the cloud holds, shown as the sync row's detail. */
  const [taskStats, setTaskStats] = useState<{ synced: number; total: number } | null>(null);
  const { clients } = useApiClients();
  const sharedId = props.shared?.id ?? null;
  const ownedByOther = Boolean(props.shared && props.shared.role !== "owner");

  useEffect(() => {
    if (props.open) setConfirmStop(false);
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
      const created = await props.collab.createProject(props.project.name, props.project.rootPath);
      addCollabProject(created.project);
      try {
        await props.collab.bindLocalProject(created.project.id, props.project.id);
        markCollabProjectBound(created.project.id, props.project.id);
      } catch (cause) {
        // Ok either way: the next launch retries the binding, and reads still go through the same folder.
        console.warn(`Project binding failed: ${messageOf(cause)}`);
      }
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
      try {
        await props.collab.deleteProject(sharedId);
      } catch (cause) {
        // Already gone from the cloud: the switch is off either way, so the local record follows.
        if (!(cause instanceof ApiRequestError && cause.status === 404)) throw cause;
      }
      removeCollabProject(sharedId);
      props.onUnshared();
    } catch (cause) {
      props.onFailed(messageOf(cause) || t("collab.settings.unshareFailed"));
    } finally {
      setBusy(false);
      setAction(null);
    }
  }

  return (
    <Modal
      open={props.open}
      title={t("collab.settings.title")}
      onClose={props.onClose}
      closeLabel={t("common.close")}
      closeContent={<X size={16} aria-hidden="true" />}
      className={styles.createModal}
      backdropClassName={styles.backdrop}
      footer={(
        <>
          <span />
          <span className={styles.footerButtons}>
            {/* 开关改动即时生效，没有可取消的东西 */}
            <Button onClick={props.onClose}>{t("common.close")}</Button>
          </span>
        </>
      )}
    >
      {/* 行式列表：左侧标题与说明，右侧控件，行间细线；与设置页同一套排布 */}
      <div className={styles.settingsRows}>
        <div className={styles.settingsRow}>
          <div className={styles.settingsRowText}>
            <div className={styles.settingsRowTitle}>{props.project.name}</div>
            <div className={`${styles.settingsRowDesc} ${styles.settingsRowPath}`} title={props.project.rootPath}>
              {props.project.rootPath}
            </div>
          </div>
          <div className={styles.settingsRowControl}>
            <Button
              size="sm"
              disabled={!clients?.memmyAgent}
              onClick={() => void clients?.memmyAgent?.revealProject(props.project.id, { timeoutMs: 15_000 })}
            >
              {t("collab.settings.reveal")}
            </Button>
          </div>
        </div>

        <div className={styles.settingsRow}>
          <div className={styles.settingsRowText}>
            <div className={styles.settingsRowTitle}>{t("collab.create.share")}</div>
            <div className={styles.settingsRowDesc}>
              {ownedByOther
                ? t("collab.settings.memberHint")
                : sharedId ? t("collab.settings.shareOnHint") : t("collab.settings.shareOffHint")}
            </div>
          </div>
          <div className={styles.settingsRowControl}>
            <button
              type="button"
              role="switch"
              aria-checked={Boolean(sharedId)}
              aria-label={t("collab.create.share")}
              // Turning sharing off deletes the cloud project, which only its owner may do.
              disabled={busy || ownedByOther || (!sharedId && !props.collab)}
              onClick={() => {
                if (sharedId) setConfirmStop(true);
                else void startSharing();
              }}
              className={`${styles.settingsSwitch}${sharedId ? ` ${styles.settingsSwitchOn}` : ""}`}
            />
          </div>
        </div>

        {sharedId ? (
          <div className={styles.settingsRow}>
            <div className={styles.settingsRowText}>
              <div className={styles.settingsRowTitle}>{t("collab.settings.sessionsRow")}</div>
              <div className={styles.settingsRowDesc}>
                {taskStats === null
                  ? t("collab.settings.sessionsFallback")
                  : taskStats.total === 0
                    ? t("collab.settings.sessionsEmpty")
                    : t("collab.settings.sessionsHint", {
                      synced: String(taskStats.synced),
                      total: String(taskStats.total)
                    })}
              </div>
            </div>
            <div className={styles.settingsRowControl}>
              <Button size="sm" onClick={props.onPickSessions}>{t("collab.settings.pickSessions")}</Button>
            </div>
          </div>
        ) : null}
      </div>
      {action ? (
        <p className={styles.settingsBusy} role="status">
          {action === "sharing" ? t("collab.settings.sharing") : t("collab.settings.stopping")}
        </p>
      ) : null}
      {confirmStop && sharedId ? (
        <section className={styles.stopSharing} role="alertdialog" aria-label={t("collab.settings.stopTitle")}>
          <b>{t("collab.settings.stopTitle")}</b>
          <p>{t("appFrame.project.stopSharingMessage", { name: props.project.name })}</p>
          <div className={styles.footerButtons}>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmStop(false)}>
              {t("collab.cancel")}
            </Button>
            {/* 删除云端项目是破坏性操作，和侧栏确认框一致用 danger */}
            <Button size="sm" variant="danger" disabled={busy} onClick={() => void stopSharing()}>
              {t("appFrame.project.stopSharing")}
            </Button>
          </div>
        </section>
      ) : null}
    </Modal>
  );
}

/** How often the 事项 tab rereads items while MemOS is still processing one. */
const ITEM_STATUS_POLL_MS = 3_000;
/** How often an idle 事项 tab rereads, so a background pass shows up without the reader doing anything. */
const ITEMS_REFRESH_MS = 60_000;

/** The label of an item's state in project memory: 处理中, 已生效, 失败. */
export function itemStatusKey(status: CollabItem["status"]): MessageKey {
  if (status === "PROCESSING") return "collab.items.status.processing";
  if (status === "FAILED") return "collab.items.status.failed";
  return "collab.items.status.available";
}

/** The item's Markdown without its title, which the row already shows. */
export function itemBodyMarkdown(markdown: string): string {
  return markdown.replace(/^\s*#\s+[^\n]*\n?/u, "").trim();
}

/**
 * The 事项 tab: one Markdown file per item in the project's knowledge base. Everyone reads them; owners and admins
 * edit them; the owner's Memmy organizes sessions into them and can run a pass now instead of waiting for one.
 */
function CollabItemsPanel(props: { collab: CollabClient; projectId: string; onToast: (message: string) => void }) {
  const { collab, projectId, onToast } = props;
  const { t } = useTranslation();
  const [view, setView] = useState<CollabItemsView | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setView(await collab.listItems(projectId));
      setFailed(null);
    } catch (cause) {
      setFailed(messageOf(cause));
    }
  }, [collab, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  // A saved item reads 处理中 until MemOS has parsed the new version; keep rereading until it settles.
  const processing = view?.items.some((item) => item.status === "PROCESSING") ?? false;
  useEffect(() => {
    if (!processing) return undefined;
    const timer = setInterval(() => void load(), ITEM_STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [processing, load]);

  // Organizing happens on its own timer, so an open board also rereads now and then to show what changed. Not while
  // an item is being edited, so a refresh never competes with typing.
  const editing = editingId !== null;
  useEffect(() => {
    if (processing || editing) return undefined;
    const timer = setInterval(() => void load(), ITEMS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [processing, editing, load]);

  function saved(item: CollabItem, changed: boolean) {
    setView((current) => current && { ...current, items: current.items.map((entry) => (entry.id === item.id ? item : entry)) });
    setEditingId(null);
    onToast(changed ? t("collab.items.edit.saved") : t("collab.items.edit.unchanged"));
  }

  if (failed !== null && view === null) {
    return (
      <div className={styles.empty} role="alert">
        <p>{failed}</p>
        <Button size="sm" onClick={() => void load()}>{t("collab.retry")}</Button>
      </div>
    );
  }
  if (view === null) return <p className={styles.loading}>{t("collab.loading")}</p>;

  return (
    <>
      <div className={styles.toolbar}>
        <span className={styles.itemsStatus}>
          {view.organizedAt
            ? t("collab.items.organizedAt", { time: formatSessionTime(view.organizedAt) })
            : t("collab.items.neverOrganized")}
          {view.pendingSessions ? ` · ${t("collab.items.pending", { count: String(view.pendingSessions) })}` : ""}
        </span>
      </div>
      {view.lastError ? (
        <p className={styles.itemsError} role="status">{t("collab.items.lastError", { message: view.lastError })}</p>
      ) : null}
      {view.items.length === 0 ? (
        <div className={styles.empty}>
          <b>{t("collab.items.empty.title")}</b>
          <p>{view.canOrganize ? t("collab.items.empty.owner") : t("collab.items.empty.member")}</p>
        </div>
      ) : (
        <ul className={styles.list}>
          {view.items.map((item) => {
            const open = openId === item.id;
            return (
              <li key={item.id} className={styles.itemBlock}>
                <button
                  type="button"
                  className={`${styles.row} ${styles.rowOpenable} ${styles.itemRow}`}
                  aria-expanded={open}
                  onClick={() => {
                    setOpenId(open ? null : item.id);
                    if (open) setEditingId(null);
                  }}
                >
                  {open ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}
                  <div className={styles.rowText}>
                    <span className={styles.rowTitle}>{item.name}</span>
                    {item.summary ? <span className={styles.rowSummary}>{item.summary}</span> : null}
                    {item.latest ? <span className={styles.itemLatest}>{t("collab.items.latest", { text: item.latest })}</span> : null}
                  </div>
                  <ItemStatusBadge item={item} />
                  <span className={styles.meta}>{formatSessionTime(item.updatedAt)}</span>
                </button>
                {open && editingId === item.id ? (
                  <CollabItemEditor
                    collab={collab}
                    projectId={projectId}
                    itemId={item.id}
                    onCancel={() => setEditingId(null)}
                    onSaved={saved}
                  />
                ) : open ? (
                  <CollabItemDetail item={item} canEdit={view.canEdit} onEdit={() => setEditingId(item.id)} />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function ItemStatusBadge(props: { item: CollabItem }) {
  const { item } = props;
  const { t } = useTranslation();
  const tone = item.status === "PROCESSING" ? styles.itemStatusProcessing : item.status === "FAILED" ? styles.itemStatusFailed : styles.itemStatusAvailable;
  return (
    <span className={`${styles.itemStatus} ${tone}`} title={item.statusMessage ?? undefined}>
      {t(itemStatusKey(item.status))}
    </span>
  );
}

function CollabItemDetail(props: { item: CollabItem; canEdit: boolean; onEdit: () => void }) {
  const { item, canEdit, onEdit } = props;
  const { t } = useTranslation();
  const time = formatSessionTime(item.updatedAt);
  const byline = item.updatedBy?.kind === "edit"
    ? t("collab.items.updatedBy.edit", { time, name: item.updatedBy.name })
    : t("collab.items.updatedBy.organize", { time });
  return (
    <div className={styles.itemDetail}>
      {item.status === "FAILED" && item.statusMessage ? (
        <p className={styles.itemsError} role="status">{t("collab.items.failedReason", { message: item.statusMessage })}</p>
      ) : null}
      <MemoryMarkdown text={itemBodyMarkdown(item.markdown)} />
      <div className={styles.itemFooter}>
        <span className={styles.itemMeta}>{byline}</span>
        <span className={styles.grow} />
        {canEdit ? (
          <Button size="sm" onClick={onEdit}>
            <Pencil size={13} aria-hidden="true" />
            {t("collab.items.edit")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Edits one item's Markdown. It opens the latest version and saves on top of it; when someone saved in between,
 * the editor switches to their version and keeps the unsaved draft beside it.
 */
function CollabItemEditor(props: {
  collab: CollabClient;
  projectId: string;
  itemId: string;
  onCancel: () => void;
  onSaved: (item: CollabItem, changed: boolean) => void;
}) {
  const { collab, projectId, itemId, onCancel, onSaved } = props;
  const { t } = useTranslation();
  const [base, setBase] = useState<CollabItem | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The draft that lost to a newer version, kept so nothing typed is lost. */
  const [lostDraft, setLostDraft] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    collab.readItem(projectId, itemId).then((latest) => {
      if (cancelled) return;
      setBase(latest);
      setDraft(latest.markdown);
    }, (cause: unknown) => {
      if (!cancelled) setError(messageOf(cause));
    });
    return () => {
      cancelled = true;
    };
  }, [collab, projectId, itemId]);

  async function confirm() {
    if (!base) return;
    setSaving(true);
    setError(null);
    try {
      const result = await collab.saveItem(projectId, base.id, { markdown: draft, baseVersion: base.version });
      onSaved(result.item, result.changed);
    } catch (cause) {
      if (cause instanceof ApiRequestError && cause.code === "conflict") {
        const latest = await collab.readItem(projectId, base.id).catch(() => null);
        if (latest) {
          setLostDraft(draft);
          setBase(latest);
          setDraft(latest.markdown);
          return;
        }
      }
      setError(messageOf(cause) || t("collab.items.edit.failed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.itemDetail}>
      {lostDraft !== null ? (
        <div className={styles.itemsError} role="alert">
          <p className={styles.itemConflict}>{t("collab.items.edit.conflict")}</p>
          <details>
            <summary>{t("collab.items.edit.yourDraft")}</summary>
            <pre className={styles.itemDraft}>{lostDraft}</pre>
          </details>
        </div>
      ) : null}
      {error ? <p className={styles.itemsError} role="alert">{error}</p> : null}
      {base ? (
        <textarea
          className={styles.itemTextarea}
          value={draft}
          spellCheck={false}
          aria-label={t("collab.items.edit.label")}
          onChange={(event) => setDraft(event.target.value)}
        />
      ) : error ? null : <p className={styles.loading}>{t("collab.loading")}</p>}
      <div className={styles.itemFooter}>
        <span className={styles.itemMeta}>{t("collab.items.edit.hint")}</span>
        <span className={styles.grow} />
        <Button size="sm" variant="ghost" disabled={saving} onClick={onCancel}>{t("collab.items.edit.cancel")}</Button>
        <Button size="sm" variant="primary" disabled={saving || !base || !draft.trim()} onClick={() => void confirm()}>
          {saving ? t("collab.items.edit.saving") : t("collab.items.edit.confirm")}
        </Button>
      </div>
    </div>
  );
}

/** 「全部成员 / 你 / 其他成员」, matching the prototype's compact picker. */
function MemberFilterPicker(props: {
  value: MemberFilter;
  options: { value: MemberFilter; label: string }[];
  onChange: (value: MemberFilter) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = props.options.find((option) => option.value === props.value) ?? props.options[0]!;
  return (
    <div className={styles.pickerWrap}>
      <button
        type="button"
        className={styles.picker}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Users size={15} aria-hidden="true" />
        <span className={styles.pickerLabel}>{current.label}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open ? (
        <>
          <button type="button" className={styles.menuScrim} aria-label="close" onClick={() => setOpen(false)} />
          <div className={styles.pickerMenu} role="listbox">
            {props.options.map((option) => (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={option.value === props.value}
                className={styles.menuItem}
                onClick={() => {
                  props.onChange(option.value);
                  setOpen(false);
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * A session's questions, replies and execution steps, read-only. Members can read each other's sessions but only
 * the person who shared one can delete it, which the board's row menu already enforces.
 */
function SessionReaderModal(props: {
  session: { session: CollabProjectSession; turns: CollabSessionTurn[] } | null;
  loading: boolean;
  onClose: () => void;
  onCopy: (session: CollabProjectSession) => void;
}) {
  const { t } = useTranslation();
  const data = props.session;
  const name = data ? data.session.memberName || (data.session.mine ? t("collab.session.you") : "") : "";
  return (
    <Modal
      open={data !== null}
      title={data?.session.title ?? ""}
      subtitle={data ? (
        <span className={styles.readerMeta}>
          <span className={styles.readerAvatar} style={{ background: memberColor(name) }} aria-hidden="true">
            {Array.from(name)[0] ?? "?"}
          </span>
          {[name, formatSessionTime(data.session.lastActiveAt)].filter(Boolean).join(" · ")}
          {data.session.mine ? "" : ` · ${t("collab.reader.readOnly")}`}
        </span>
      ) : undefined}
      onClose={props.onClose}
      closeLabel={t("common.close")}
      closeContent={<X size={16} aria-hidden="true" />}
      className={styles.readerModal}
      footer={(
        <>
          <span className={styles.readerFoot}>{t("collab.reader.hint")}</span>
          <span className={styles.footerButtons}>
            {data ? (
              <Button size="sm" onClick={() => props.onCopy(data.session)}>
                <Link2 size={14} aria-hidden="true" />
                {t("collab.session.copyLink")}
              </Button>
            ) : null}
            <Button variant="ghost" onClick={props.onClose}>{t("common.close")}</Button>
          </span>
        </>
      )}
    >
      {data ? (
        <div className={styles.readerBody}>
          {data.turns.length === 0 ? (
            <p className={styles.loading}>{t("collab.reader.empty")}</p>
          ) : data.turns.map((turn, index) => (
            <article key={`${turn.startedAt}-${index}`} className={styles.readerTurn}>
              <b className={styles.readerTurnIndex}>{t("collab.reader.turn", { index: String(index + 1) })}</b>
              {turn.question ? (
                <div className={styles.readerQuestion}>
                  <span className={styles.readerSpeaker}>{name}</span>
                  <p>{turn.question}</p>
                </div>
              ) : null}
              {turn.reply ? (
                <div className={styles.readerReply}>
                  <span className={styles.readerSpeaker}>{t("collab.reader.reply")}</span>
                  <p>{turn.reply}</p>
                </div>
              ) : null}
              {turn.steps.length ? (
                <p className={styles.readerSteps}>{t("collab.reader.steps")}: {summarizeSteps(turn.steps)}</p>
              ) : null}
            </article>
          ))}
        </div>
      ) : props.loading ? (
        <p className={styles.loading}>{t("collab.loading")}</p>
      ) : null}
    </Modal>
  );
}

/**
 * The same「Bash ×3、Edit」summary the reference file uses, so the app and the file read alike.
 */
export function summarizeSteps(steps: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const step of steps) counts.set(step, (counts.get(step) ?? 0) + 1);
  return [...counts.entries()].map(([step, count]) => (count > 1 ? `${step} ×${count}` : step)).join("、");
}

/** 新建项目: an online project (default) or a local one, per the prototype. */
function AssociateSessionsModal(props: {
  open: boolean;
  collab: CollabClient;
  project: CollabProject;
  onClose: () => void;
  onLinked: (result: CollabSyncResult) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<LocalAgentSession[] | null>(null);
  const [saved, setSaved] = useState<CollabLinks>(EMPTY_LINKS);
  const [links, setLinks] = useState<CollabLinks>(EMPTY_LINKS);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { collab, open, project } = props;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSessions(null);
    setSaved(EMPTY_LINKS);
    setLinks(EMPTY_LINKS);
    setAgentId(null);
    setQuery("");
    setExpanded(new Set());
    setError(null);
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
  }, [collab, open, project.id]);

  const agents = useMemo(() => {
    const seen = new Map<string, string>();
    for (const session of sessions ?? []) if (!seen.has(session.sourceId)) seen.set(session.sourceId, session.agentName);
    return [...seen.entries()].map(([sourceId, name]) => ({ sourceId, name }));
  }, [sessions]);
  const activeAgent = agents.find((agent) => agent.sourceId === agentId) ?? agents.find((agent) => agentHasLinks(links, agent.sourceId)) ?? agents[0] ?? null;
  const kind = activeAgent ? groupingKind(activeAgent.sourceId) : "directory";
  const view = activeAgent ? groupAgentSessions(sessions ?? [], activeAgent.sourceId, query) : { groups: [], ungrouped: [] };
  const changed = JSON.stringify(links) !== JSON.stringify(saved);

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
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  function sessionRow(session: LocalAgentSession, nested: boolean) {
    const checked = isSessionChecked(links, session);
    const excluded = !checked && Boolean(session.group && findGroupLink(links, session.sourceId, session.group.id));
    return (
      <label key={localSessionKey(session)} className={`${styles.pickRow} ${nested ? styles.pickRowNested : ""}`}>
        <input type="checkbox" checked={checked} onChange={() => setLinks((current) => toggleSessionLink(current, session))} />
        <span className={`${styles.pickTitle} ${excluded ? styles.pickTitleExcluded : ""}`} title={session.lastQuestion || session.title}>{session.title}</span>
        <span className={styles.meta}>{excluded ? t("collab.pick.excluded") : formatSessionTime(session.updatedAt)}</span>
      </label>
    );
  }

  return (
    <Modal
      open={props.open}
      title={t("collab.pick.title")}
      subtitle={t("collab.pick.subtitle", { project: project.name })}
      onClose={busy ? undefined : props.onClose}
      closeLabel={t("common.close")}
      closeContent={<X size={16} aria-hidden="true" />}
      className={styles.pickModal}
      backdropClassName={styles.backdrop}
      footer={(
        <>
          {error ? <span className={styles.error} role="alert">{error}</span> : <span />}
          <span className={styles.footerButtons}>
            <Button variant="ghost" disabled={busy} onClick={props.onClose}>{t("collab.cancel")}</Button>
            <Button variant="primary" disabled={!changed || busy} onClick={() => void confirm()}>
              {busy ? t("collab.pick.saving") : t("collab.pick.start")}
            </Button>
          </span>
        </>
      )}
    >
      <div className={styles.pickBody}>
        <nav className={styles.agentList} aria-label="Agent">
          {agents.map((agent) => {
            const logo = agentSourceLogoUrl(agent.sourceId);
            const active = agent.sourceId === activeAgent?.sourceId;
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
                <span className={styles.agentLogo}>{logo ? <img src={logo} alt="" /> : null}</span>
                <span className={styles.agentText}>
                  <span className={styles.agentName}>{agentSourceDisplayName(agent.sourceId) || agent.name}</span>
                  <span className={styles.agentHint}>{t(`collab.pick.groupBy.${groupingKind(agent.sourceId)}` as MessageKey)}</span>
                </span>
                {agentHasLinks(links, agent.sourceId) ? <span className={styles.agentDot} aria-hidden="true" /> : null}
              </button>
            );
          })}
        </nav>
        <section className={styles.pickMain}>
          <label className={styles.search}>
            <Search size={14} aria-hidden="true" />
            <input
              value={query}
              placeholder={activeAgent ? t("collab.pick.searchIn", { agent: agentSourceDisplayName(activeAgent.sourceId) || activeAgent.name }) : t("collab.pick.search")}
              aria-label={t("collab.pick.search")}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
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
                          onChange={() => setLinks((current) => toggleGroupLink(current, activeAgent!.sourceId, item))}
                        />
                        <button type="button" className={styles.groupToggle} aria-expanded={isOpen} title={item.group.path ?? item.group.label} onClick={() => toggleExpanded(item.group.id)}>
                          <span className={styles.groupIcon}><GroupIcon size={15} aria-hidden="true" /></span>
                          <span className={styles.groupText}>
                            <span className={styles.groupName}>{item.group.label}</span>
                            {state === "checked" ? <span className={styles.groupHint}>{t("collab.pick.wholeGroup")}</span> : null}
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
        </section>
      </div>
    </Modal>
  );
}

function messageOf(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message.trim() : String(cause).trim();
  return raw.startsWith("[") || raw.startsWith("{") ? "" : raw;
}
