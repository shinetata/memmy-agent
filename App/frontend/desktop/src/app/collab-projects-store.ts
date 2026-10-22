/**
 * Online projects shared between the sidebar and the project board. The sidebar lists them next to local
 * projects and the board reads the same list, so one store keeps a single selected project and a single fetch.
 */
import type { CollabClient, CollabProject } from "../api/collab-client.js";

export interface CollabProjectsSnapshot {
  /** Null until the first load finishes, so the sidebar can tell "none" from "not loaded yet". */
  projects: CollabProject[] | null;
  selectedId: string | null;
  loading: boolean;
  error: string | null;
  /** Set when the sidebar asks for the new-project dialog; the board opens it once and clears the flag. */
  createPending: boolean;
}

let snapshot: CollabProjectsSnapshot = {
  projects: null,
  selectedId: null,
  loading: false,
  error: null,
  createPending: false
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

/** Loads the list once; a second caller while a load runs joins the running one. */
export async function loadCollabProjects(client: CollabClient): Promise<void> {
  if (snapshot.loading) return;
  update({ loading: true, error: null });
  try {
    const projects = await client.listProjects();
    const selectedId = snapshot.selectedId && projects.some((project) => project.id === snapshot.selectedId)
      ? snapshot.selectedId
      : projects[0]?.id ?? null;
    update({ projects, selectedId, loading: false, error: null });
  } catch (cause) {
    update({ projects: [], loading: false, error: messageOf(cause) });
  }
}

export function selectCollabProject(projectId: string | null): void {
  if (snapshot.selectedId === projectId) return;
  update({ selectedId: projectId });
}

/** After creating a project: it leads the list and opens. */
export function addCollabProject(project: CollabProject): void {
  const rest = (snapshot.projects ?? []).filter((current) => current.id !== project.id);
  update({ projects: [project, ...rest], selectedId: project.id });
}

/** Keeps the sidebar name and member count current after the board reloads a project. */
export function replaceCollabProject(project: CollabProject): void {
  if (!snapshot.projects) return;
  update({ projects: snapshot.projects.map((current) => (current.id === project.id ? project : current)) });
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

export function requestCreateCollabProject(): void {
  update({ createPending: true });
}

/** Clears the request the board just acted on, so navigating back does not reopen the dialog. */
export function consumeCreateCollabProjectRequest(): void {
  if (snapshot.createPending) update({ createPending: false });
}

/** Test seam: drops every listener and returns the store to its first state. */
export function resetCollabProjectsStore(): void {
  snapshot = { projects: null, selectedId: null, loading: false, error: null, createPending: false };
  listeners.clear();
}

function messageOf(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message.trim() : String(cause).trim();
  // Schema validation prints its whole issue list; leave it to the page's readable fallback.
  if (!raw || raw.startsWith("[") || raw.startsWith("{")) return "";
  return raw;
}
