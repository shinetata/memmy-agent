import { ChevronDown, ChevronRight, Cloud, Folder, Layers, Link2, MessageSquarePlus, MoreHorizontal, Quote, Search, Trash2, Users, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
  createHttpCollabClient,
  type CollabClient,
  type CollabLinks,
  type CollabProject,
  type CollabProjectSession,
  type CollabSessionPage,
  type CollabSessionTurn,
  type CollabSyncProgress,
  type CollabSyncResult,
  type LocalAgentSession,
  type LocalSessionGroup
} from "../api/collab-client.js";
import {
  addCollabProject,
  requestCreateCollabProject,
  getCollabProjectsSnapshot,
  loadCollabProjects,
  markCollabProjectBound,
  replaceCollabProject,
  subscribeCollabProjects
} from "../app/collab-projects-store.js";
import { useOptionalAgentRuntimeBridge } from "../app/agent-runtime-bridge.js";
import { useApiClients } from "../app/providers.js";
import { Button } from "../components/button.js";
import { ConfirmDialog } from "../components/confirm-dialog.js";
import { Modal } from "../components/modal.js";
import type { MessageKey } from "../i18n/messages.js";
import { useTranslation } from "../i18n/use-translation.js";
import { agentSourceDisplayName, agentSourceLogoUrl } from "./agent-source-logos.js";
import { AppFrame } from "./app-frame.js";
import styles from "./collab-page.module.css";

const TOAST_MS = 1_800;
/** The board shows ten sessions at a time, so a long project stays scannable. */
const SESSION_PAGE_SIZE = 10;
/** How often the board refreshes while an association uploads. */
const PROGRESS_POLL_MS = 1_200;
const MAX_PROJECT_NAME_CHARS = 20;
const MAX_LOCAL_SESSIONS = 500;
const EMPTY_LINKS: CollabLinks = { groups: [], sessions: [] };
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

/** Avatar tint, stable per member name so a member keeps one colour across the board. */
export function memberColor(name: string): string {
  const palette = ["#7c6bd6", "#4b9fd0", "#d98b4a", "#3f9c8a", "#c2698f", "#5b8f4e", "#b0793f", "#5f7bd0"];
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) % 100_000;
  return palette[hash % palette.length]!;
}

/** The whole board of one online project: the header, the two tabs, the session list and the link dialog. */
export function CollabPage() {
  const { clients } = useApiClients();
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
  const [deleting, setDeleting] = useState<CollabProjectSession | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  /** Upload progress of a queued association; the list grows while it runs. */
  const [progress, setProgress] = useState<CollabSyncProgress | null>(null);
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

  const selectedId = snapshot.selectedId;
  const selected = snapshot.projects?.find((project) => project.id === selectedId) ?? null;

  // One request builds every page: the query and the member filter decide what `total` counts.
  useEffect(() => {
    if (!collab || !selectedId) {
      setPage(null);
      return;
    }
    let cancelled = false;
    const first = pageIndex === 0 && !query;
    if (first) setPage(null);
    const load = async () => {
      try {
        // The list is read first: waiting for an upload that may be queued behind other work is what made the
        // board sit on "loading". The upload starts in parallel and the next poll picks up what it adds.
        if (pageIndex === 0) {
          void collab.syncSessions({ tasksOnly: true }).then(() => refreshAfterUploadRef.current()).catch(() => undefined);
        }
        const result = await collab.listSessions(selectedId, {
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
  }, [collab, selectedId, query, member, pageIndex, showToast]);

  /**
   * Called once the background upload of this project's own tasks finishes, so a task finished moments ago shows
   * up without the board having waited for it.
   */
  const refreshAfterUploadRef = useRef<() => void>(() => undefined);
  const refreshAfterUpload = useCallback(() => {
    if (!collab || !selectedId) return;
    void collab.listSessions(selectedId, {
      ...(query ? { query } : {}),
      ...(member === "all" ? {} : { member }),
      offset: pageIndex * SESSION_PAGE_SIZE,
      limit: SESSION_PAGE_SIZE
    })
      .then((result) => setPage(result))
      .catch(() => undefined);
  }, [collab, selectedId, query, member, pageIndex]);
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
    if (!collab || !selectedId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      const [next, listing] = await Promise.all([
        collab.getSyncProgress(selectedId).catch(() => null),
        collab.listSessions(selectedId, { ...(member === "all" ? {} : { member }), ...(query ? { query } : {}), offset: pageIndex * SESSION_PAGE_SIZE, limit: SESSION_PAGE_SIZE }).catch(() => null)
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
    void collab.getSyncProgress(selectedId)
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
  }, [collab, selectedId, member, query, pageIndex]);

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
  }, [query, member, selectedId]);

  // Keep the page in range when a deletion or a filter change leaves it past the end.
  useEffect(() => {
    if (pageIndex > 0 && pageIndex >= pageCount) setPageIndex(pageCount - 1);
  }, [pageCount, pageIndex]);

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
    if (!collab || !selectedId || !deleting) return;
    const session = deleting;
    setDeleting(null);
    try {
      await collab.removeSession(selectedId, session.id);
      showToast(t("collab.session.deleted"));
      await refreshSessions(selectedId);
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
    <AppFrame title={t("nav.collab")}>
      <div className={styles.page}>
        {snapshot.error !== null ? (
          <div className={styles.empty} role="alert">
            <p>{snapshot.error || t("collab.loadFailed")}</p>
            <Button size="sm" onClick={() => collab && void loadCollabProjects(collab)}>{t("collab.retry")}</Button>
          </div>
        ) : snapshot.projects === null ? (
          <p className={styles.loading}>{t("collab.loading")}</p>
        ) : !selected ? (
          <div className={styles.empty}>
            <b>{t("collab.empty.title")}</b>
            <p>{t("collab.empty.body")}</p>
            <Button variant="primary" size="sm" onClick={() => requestCreateCollabProject()}>{t("collab.newProject")}</Button>
          </div>
        ) : (
          <>
            <div className={styles.scroller}>
              <div className={styles.wrap}>
                <header className={styles.boardHeader}>
                  <span className={styles.boardIcon} aria-hidden="true"><Cloud size={22} /></span>
                  <h1 className={styles.boardName}>{selected.name}</h1>
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
                        {sessions.length === 0 ? (
                          <li className={styles.noMatch}>
                            {query ? t("collab.sessions.noMatch") : t("collab.sessions.empty.title")}
                          </li>
                        ) : sessions.map((session) => {
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
                                  <button type="button" className={styles.menuScrim} aria-label={t("collab.cancel")} onClick={() => setOpenMenuId(null)} />
                                  <div className={styles.menu} role="menu">
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
                  <div className={styles.empty}>
                    <b>{t("collab.items.empty.title")}</b>
                    <p>{t("collab.items.empty.body")}</p>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Overlays mount on the body, like the app's other menus and dialogs, so the sidebar never covers them. */}
      {typeof document === "undefined" ? null : createPortal(<>
      {collab && selected ? (
        <AssociateSessionsModal
          open={pickOpen}
          collab={collab}
          project={selected}
          onClose={() => setPickOpen(false)}
          onLinked={(result) => {
            // The selection is already saved; the upload continues in the background and the board shows it.
            setPickOpen(false);
            if (result.started) {
              setProgress({ running: true, total: result.started, completed: 0, failed: 0 });
              showToast(t("collab.pick.queued", { count: String(result.started) }));
            } else {
              showToast(t("collab.pick.done"));
            }
            void refreshSessions(selected.id);
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
