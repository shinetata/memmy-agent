/**
 * Local-only store for which agent sessions a local project may reference.
 * Nothing here is uploaded: the file lives beside the memory service data on this machine.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const STORE_VERSION = 1;

/** One associated session, snapshotted so listing never needs to rescan the agent stores. */
export interface LocalProjectSession {
  sourceId: string;
  conversationId: string;
  agentName: string;
  title: string;
  lastQuestion: string;
  workspacePath: string | null;
  /** Last activity of the conversation when this snapshot was written. */
  updatedAt: string;
  /** Turns counted when the snapshot was written, so a candidate can show its size without rescanning. */
  turnCount: number;
  addedAt: string;
}

/** A local project and the sessions it may reference. */
export interface LocalProject {
  id: string;
  name: string;
  /** Absolute directory the project maps to; the asking conversation must run inside it. */
  rootPath: string;
  sessions: LocalProjectSession[];
  updatedAt: string;
}

/** Association input for a single session. */
export interface LocalProjectSessionInput {
  sourceId: string;
  conversationId: string;
  agentName?: string;
  title?: string;
  lastQuestion?: string;
  workspacePath?: string | null;
  updatedAt?: string;
  turnCount?: number;
}

export interface LocalProjectStore {
  list(): Promise<LocalProject[]>;
  get(id: string): Promise<LocalProject | null>;
  /** The project whose directory contains `cwd`; the deepest match wins. */
  findByPath(cwd: string): Promise<LocalProject | null>;
  createOrUpdate(input: { id?: string; name: string; rootPath: string }): Promise<LocalProject>;
  addSessions(id: string, sessions: readonly LocalProjectSessionInput[]): Promise<LocalProject>;
  removeSessions(id: string, keys: readonly { sourceId: string; conversationId: string }[]): Promise<LocalProject>;
  remove(id: string): Promise<void>;
}

interface StoreFile {
  version: number;
  projects: LocalProject[];
}

/** Creates the association store backed by one JSON file. */
export function createLocalProjectStore(input: { filePath: string; now?: () => string; idFactory?: () => string }): LocalProjectStore {
  const now = input.now ?? (() => new Date().toISOString());
  const idFactory = input.idFactory ?? (() => `lp_${randomUUID().replace(/-/gu, "").slice(0, 12)}`);
  let queue: Promise<unknown> = Promise.resolve();

  /** Serialises read-modify-write so two concurrent requests cannot drop each other's change. */
  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = queue.then(operation, operation);
    queue = next.catch(() => undefined);
    return next;
  }

  async function read(): Promise<StoreFile> {
    try {
      const parsed = JSON.parse(await readFile(input.filePath, "utf8")) as Partial<StoreFile>;
      return {
        version: typeof parsed.version === "number" ? parsed.version : STORE_VERSION,
        projects: Array.isArray(parsed.projects) ? parsed.projects.map(normalizeProject) : []
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: STORE_VERSION, projects: [] };
      }
      throw error;
    }
  }

  async function write(store: StoreFile): Promise<void> {
    await mkdir(dirname(input.filePath), { recursive: true });
    const temporary = `${input.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    await rename(temporary, input.filePath);
  }

  return {
    async list() {
      return (await read()).projects;
    },

    async get(id) {
      return (await read()).projects.find((project) => project.id === id) ?? null;
    },

    async findByPath(cwd) {
      const target = normalizeRoot(cwd);
      if (!target) {
        return null;
      }
      const matches = (await read()).projects.filter((project) => isInside(target, project.rootPath));
      // A project inside another project owns its own directory.
      return matches.sort((left, right) => right.rootPath.length - left.rootPath.length)[0] ?? null;
    },

    createOrUpdate({ id, name, rootPath }) {
      return exclusive(async () => {
        const store = await read();
        const normalizedRoot = normalizeRoot(rootPath);
        const existing = store.projects.find((project) => project.id === id || (!id && project.rootPath === normalizedRoot));
        if (existing) {
          existing.name = name;
          existing.rootPath = normalizedRoot;
          existing.updatedAt = now();
          await write(store);
          return existing;
        }
        const created: LocalProject = {
          id: id ?? idFactory(),
          name,
          rootPath: normalizedRoot,
          sessions: [],
          updatedAt: now()
        };
        store.projects.push(created);
        await write(store);
        return created;
      });
    },

    addSessions(id, sessions) {
      return exclusive(async () => {
        const store = await read();
        const project = requireProject(store, id);
        for (const session of sessions) {
          const next = {
            sourceId: session.sourceId,
            conversationId: session.conversationId,
            agentName: session.agentName ?? session.sourceId,
            title: session.title ?? "",
            lastQuestion: session.lastQuestion ?? "",
            workspacePath: session.workspacePath ?? null,
            updatedAt: session.updatedAt ?? "",
            turnCount: session.turnCount ?? 0,
            addedAt: now()
          };
          const index = project.sessions.findIndex((item) => sameKey(item, next));
          if (index >= 0) {
            // Re-associating refreshes the snapshot but keeps the original add time.
            project.sessions[index] = { ...next, addedAt: project.sessions[index]!.addedAt };
          } else {
            project.sessions.push(next);
          }
        }
        project.updatedAt = now();
        await write(store);
        return project;
      });
    },

    removeSessions(id, keys) {
      return exclusive(async () => {
        const store = await read();
        const project = requireProject(store, id);
        project.sessions = project.sessions.filter((session) => !keys.some((key) => sameKey(session, key)));
        project.updatedAt = now();
        await write(store);
        return project;
      });
    },

    remove(id) {
      return exclusive(async () => {
        const store = await read();
        store.projects = store.projects.filter((project) => project.id !== id);
        await write(store);
      });
    }
  };
}

/** Refreshes the snapshot of one associated session after its content was read. */
export function withRefreshedSession(
  project: LocalProject,
  session: { sourceId: string; conversationId: string; agentName: string; title: string; lastQuestion: string; workspacePath: string | null; updatedAt: string }
): LocalProject {
  return {
    ...project,
    sessions: project.sessions.map((item) => (sameKey(item, session) ? { ...item, ...session } : item))
  };
}

function requireProject(store: StoreFile, id: string): LocalProject {
  const project = store.projects.find((item) => item.id === id);
  if (!project) {
    throw new Error(`Unknown local project: ${id}`);
  }
  return project;
}

function sameKey(left: { sourceId: string; conversationId: string }, right: { sourceId: string; conversationId: string }): boolean {
  return left.sourceId === right.sourceId && left.conversationId === right.conversationId;
}

function normalizeProject(project: LocalProject): LocalProject {
  return {
    ...project,
    rootPath: normalizeRoot(project.rootPath),
    sessions: Array.isArray(project.sessions) ? project.sessions : []
  };
}

/** Compares directory paths without trailing slashes; empty input yields an empty string. */
export function normalizeRoot(value: string | null | undefined): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/\/+$/u, "") || "/";
}

/** True when `target` is the project directory or lives inside it. */
export function isInside(target: string, root: string): boolean {
  const base = normalizeRoot(root);
  if (!base) {
    return false;
  }
  if (target === base) {
    return true;
  }
  return base === "/" ? target.startsWith("/") : target.startsWith(`${base}/`);
}
