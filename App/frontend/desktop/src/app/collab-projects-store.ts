/**
 * Cloud sharing state for projects. A project is a local Memmy project; a cloud project is attached to it and
 * names the project's shared record. The sidebar lists local projects and the board reads the same store, so one
 * store keeps a single open project — named by the local project id — and a single fetch of the cloud list.
 */
import type { CollabApplication, CollabClient, CollabProject } from "../api/collab-client.js";

export interface CollabProjectsSnapshot {
  /** Null until the first load finishes, so the sidebar can tell "none" from "not loaded yet". */
  projects: CollabProject[] | null;
  /** 已提交、尚未通过的加入申请。云端没返回这个字段时保持上次的值。 */
  applications: CollabApplication[];
  /** The local project whose board is open; the cloud project, if any, is derived from it. */
  selectedId: string | null;
  loading: boolean;
  error: string | null;
  /** Set when the sidebar asks for the new-project dialog; the frame opens it once and clears the flag. */
  createPending: boolean;
  /**
   * A local project whose Memmy sessions should be chosen right after sharing started. The board opens that picker
   * once and clears the flag, so a project that was just shared asks which of its own sessions go to the cloud.
   */
  taskPickerFor: string | null;
  /**
   * 看板顶部的一次性提示文案（已本地化）：例如新建项目时勾了共享但云端不可用。看板显示几秒后自行清除。
   */
  notice: string | null;
}

let snapshot: CollabProjectsSnapshot = {
  projects: null,
  applications: [],
  selectedId: null,
  loading: false,
  error: null,
  createPending: false,
  taskPickerFor: null,
  notice: null
};
const listeners = new Set<() => void>();

function update(patch: Partial<CollabProjectsSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

export function subscribeCollabProjects(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getCollabProjectsSnapshot(): CollabProjectsSnapshot {
  return snapshot;
}

/** The cloud project a local project is shared through, or null while it is only on this computer. */
export function sharedProjectFor(
  projects: CollabProject[] | null | undefined,
  localProjectId: string | null | undefined
): CollabProject | null {
  if (!projects || !localProjectId) return null;
  return projects.find((project) => project.localProjectId === localProjectId) ?? null;
}

/** The load in flight, so a caller that arrives during one waits for it instead of reading a stale list. */
let inFlight: Promise<void> | null = null;

/**
 * Reloads the shared list. A second caller while a load runs waits for it and then loads again: dropping that
 * reload is what left the sidebar showing a project whose cloud record had already been deleted.
 */
export async function loadCollabProjects(client: CollabClient): Promise<void> {
  if (inFlight) await inFlight.catch(() => undefined);
  const run = (async () => {
    update({ loading: true, error: null });
    try {
      const listed = normalizeProjectList(await client.listProjects());
      // The open project is local, so a reload must not move the board: only a vanished project clears it.
      // 云端没带申请列表时保留本机刚记下的申请；已经是成员的项目不再显示「申请中」。
      const joined = new Set(listed.projects.map((project) => project.id));
      const applications = (listed.applications ?? snapshot.applications)
        .filter((application) => !joined.has(application.projectId));
      update({ projects: listed.projects, applications, loading: false, error: null });
    } catch (cause) {
      // 云端不可用时保留已有列表：项目就在本机，云端只决定能不能看共享内容。
      update({ loading: false, error: messageOf(cause) });
    }
  })();
  inFlight = run;
  try {
    await run;
  } finally {
    if (inFlight === run) inFlight = null;
  }
}

/** 在看板顶部显示一次性提示（传入已本地化的文案），由看板在几秒后清除。 */
export function showCollabNotice(message: string): void {
  update({ notice: message });
}

/** 清除看板顶部的一次性提示。 */
export function dismissCollabNotice(): void {
  if (snapshot.notice !== null) update({ notice: null });
}

/** Opens one project's board, named by its local project id. */
export function selectCollabProject(localProjectId: string | null): void {
  if (snapshot.selectedId === localProjectId) return;
  update({ selectedId: localProjectId });
}

/** 申请刚提交时先记到侧边栏，随后的列表刷新会用云端结果替换。 */
export function addPendingApplication(application: CollabApplication): void {
  const rest = snapshot.applications.filter((current) => current.projectId !== application.projectId);
  update({ applications: [application, ...rest] });
}

/** After sharing a project: its cloud record leads the list. Opening the board is the caller's decision. */
export function addCollabProject(project: CollabProject): void {
  const rest = (snapshot.projects ?? []).filter((current) => current.id !== project.id);
  update({ projects: [project, ...rest] });
}

/** Keeps the sidebar name and member count current after the board reloads a project. */
export function replaceCollabProject(project: CollabProject): void {
  if (!snapshot.projects) return;
  update({ projects: snapshot.projects.map((current) => (current.id === project.id ? project : current)) });
}

/** Drops a project's cloud record after sharing was turned off; the local project stays. */
export function removeCollabProject(projectId: string): void {
  if (!snapshot.projects) return;
  update({ projects: snapshot.projects.filter((project) => project.id !== projectId) });
}

/**
 * Records the local Memmy project an online project runs tasks in, so the sidebar can list its sessions right
 * after creation instead of waiting for the next full load.
 */
export function markCollabProjectBound(projectId: string, localProjectId: string): void {
  if (!snapshot.projects) return;
  update({
    projects: snapshot.projects.map((project) => (
      project.id === projectId ? { ...project, localProjectId } : project
    ))
  });
}

export function requestCreateProject(): void {
  update({ createPending: true });
}

/** Clears the request the frame just acted on, so navigating back does not reopen the dialog. */
export function consumeCreateProjectRequest(): void {
  if (snapshot.createPending) update({ createPending: false });
}

/** Asks the board to open the project-session picker for a project whose sharing just started. */
export function requestTaskPicker(localProjectId: string): void {
  update({ taskPickerFor: localProjectId });
}

/** Clears the picker request the board just acted on. */
export function consumeTaskPickerRequest(): void {
  if (snapshot.taskPickerFor) update({ taskPickerFor: null });
}

/** Test seam: drops every listener and returns the store to its first state. */
export function resetCollabProjectsStore(): void {
  inFlight = null;
  snapshot = {
    projects: null,
    applications: [],
    selectedId: null,
    loading: false,
    error: null,
    createPending: false,
    taskPickerFor: null,
    notice: null
  };
  listeners.clear();
}

/**
 * 测试里有的客户端仍直接返回项目数组。正式客户端返回 `{ projects, applications? }`，
 * `applications` 缺省表示云端还没有这份列表。
 */
function normalizeProjectList(
  listed: { projects: CollabProject[]; applications?: CollabApplication[] } | CollabProject[]
): { projects: CollabProject[]; applications?: CollabApplication[] } {
  if (Array.isArray(listed)) return { projects: listed };
  return listed;
}

function messageOf(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message.trim() : String(cause).trim();
  // Schema validation prints its whole issue list; leave it to the page's readable fallback.
  if (!raw || raw.startsWith("[") || raw.startsWith("{")) return "";
  return raw;
}
