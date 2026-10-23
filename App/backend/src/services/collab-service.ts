/**
 * Online projects. Projects, members and associated sessions live in the Memmy cloud; this service signs those
 * requests with the person's account, reads local agent sessions through the Memory service when they associate
 * one, and saves a session a person references as a Markdown file an agent can read.
 */
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ApiErrorCode } from "./error-envelope.js";

const CLOUD_TIMEOUT_MS = 20_000;
const UPLOAD_TIMEOUT_MS = 60_000;
const MEMORY_TIMEOUT_MS = 30_000;
/** Enough for every agent's recent sessions, so association sees the same pool as the picker. */
const MAX_LOCAL_SESSIONS = 500;
/** How many sessions the @ menu lists before the person types anything. */
const CANDIDATE_LIMIT = 5;
/** The board's page size, so a long project does not render every session at once. */
export const SESSION_PAGE_SIZE = 10;
/**
 * Sessions uploaded in parallel. Reading one session from the Memory service dominates the cost — large agent
 * sessions take seconds — so a bounded pool keeps a bulk association from taking minutes.
 */
const UPLOAD_CONCURRENCY = 4;
const LINKS_FILE = "links.json";
/** Matches the cloud limits so an upload is never rejected for size. */
const MAX_UPLOAD_TURNS = 300;
const MAX_QUESTION_CHARS = 4_000;
const MAX_REPLY_CHARS = 8_000;
const MAX_STEPS_PER_TURN = 40;
const SESSION_ID_PATTERN = /^[A-Za-z0-9-]{1,36}$/u;
/** Marks the sessions of Memmy's own tasks, which are not one of the external agent sources. */
export const MEMMY_SOURCE_ID = "memmy";
/** The ID ends at the path, the query, or whatever the person typed after pasting the link. */
const SESSION_LINK_PATTERN = /\/s\/([A-Za-z0-9-]{1,36})(?=[/?#\s]|$)/u;

export class CollabError extends Error {
  constructor(readonly code: ApiErrorCode, message: string) {
    super(message);
    this.name = "CollabError";
  }
}

export interface CollabAccount {
  accountId: string;
  credential: string;
  /** The signed-in person's nickname, shown on their own sessions instead of a generic "you". */
  memberName?: string;
}

export interface CollabServiceOptions {
  cloudBaseUrl: string;
  getAccount: () => CollabAccount | null;
  /** Local Memory service, which reads this machine's agent sessions. */
  memory: { baseUrl: string; token: string } | null;
  /** Origin of session links; the cloud origin when absent. */
  linkBaseUrl?: string;
  /** Where referenced sessions are saved; ~/.memmy/projects by default. */
  projectsDir?: string;
  /** Memmy's own task sessions; ~/.memmy/workspace/sessions by default. */
  agentSessionsDir?: string;
  fetcher?: typeof fetch;
  now?: () => Date;
}

export interface CollabProject {
  id: string;
  name: string;
  role: string;
  memberCount: number;
  sessionCount: number;
  createdAt: string | null;
  /**
   * The local Memmy project this online project runs tasks in, or null before it is bound. It is what lets an
   * online project behave like a local one: tasks, sessions and the sidebar's expandable task list.
   */
  localProjectId: string | null;
}

export interface CollabProjectSession {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  lastQuestion: string;
  memberName: string;
  mine: boolean;
  source: string;
  turnCount: number;
  lastActiveAt: string | null;
  /** The link a member pastes into another agent. */
  link: string;
  /** What「复制链接」puts on the clipboard. */
  shareText: string;
}

export interface SessionListOptions {
  query?: string;
  /** 「全部成员」/「你」/「其他成员」: who shared the session decides what the page contains. */
  member?: "me" | "others";
  /** Zero-based index of the first session to return. */
  offset?: number;
  /** Page size; the board asks for ten. */
  limit?: number;
}

export interface CollabSessionPage {
  project: CollabProject;
  /** The page only; `total` counts every session matching the query. */
  sessions: CollabProjectSession[];
  total: number;
}

export interface CollabSessionTurn {
  question: string;
  reply: string;
  steps: string[];
  startedAt: string;
}

/** The agent's project or workspace a session belongs to, or its directory. */
export interface LocalSessionGroup {
  id: string;
  label: string;
  path: string | null;
}

export interface LocalAgentSession {
  sourceId: string;
  agentName: string;
  conversationId: string;
  title: string;
  lastQuestion: string;
  workspacePath: string | null;
  group: LocalSessionGroup | null;
  updatedAt: string;
  turnCount: number;
}

/** A whole group associated with a project, sessions that appear in it later included. */
export interface CollabGroupLink {
  sourceId: string;
  groupId: string;
  /** Sessions of the group the person unchecked. */
  excluded: string[];
}

/** A session associated on its own. */
export interface CollabSessionLink {
  sourceId: string;
  conversationId: string;
}

/** What this computer associates with one project. Kept on this computer, since groups are local directories. */
export interface CollabLinks {
  groups: CollabGroupLink[];
  sessions: CollabSessionLink[];
}

/** The fields association rules look at; a session that is no longer listed keeps the group it was uploaded with. */
export interface LinkCandidate {
  sourceId: string;
  conversationId: string;
  groupId: string | null;
}

export interface CollabSyncResult {
  uploaded: number;
  removed: number;
  /** Uploads that failed; the next automatic sync retries them. */
  failed: number;
  /** Sessions queued for upload; the board shows their progress as they arrive. */
  started?: number;
}

/** Upload progress for one project, so the board can show sessions arriving instead of blocking a dialog. */
export interface CollabSyncProgress {
  running: boolean;
  total: number;
  completed: number;
  failed: number;
}

/** What one upload put in the cloud, and when. */
interface SyncedSession {
  cloudSessionId: string;
  updatedAt: string;
  groupId: string | null;
  /**
   * The title the listing reported when this session was uploaded. Absent on records written before titles came
   * from the agent itself, which is what makes the next sync refresh them.
   */
  title?: string;
}

interface StoredLinks extends CollabLinks {
  projectId: string;
  accountId: string;
  /** The local Memmy project bound to this online project, once the person created it. */
  localProjectId: string | null;
  /** Memmy tasks deleted from the project, so the next sync does not upload them again. */
  removedSessions: string[];
  /** Where this project's tasks run when the person picked no folder; named after the project. */
  workingDirectory: string | null;
  /** Last upload of each session, by session key. */
  synced: Record<string, SyncedSession>;
}

export interface CollabSessionReference {
  session: CollabProjectSession;
  path: string;
  /** Source and file path handed to the agent; the same text the Memmy reference uses. */
  text: string;
}

export interface CollabService {
  listProjects(): Promise<{ projects: CollabProject[] }>;
  /**
   * Creates the cloud project and prepares the directory its tasks run in: the person's chosen folder, or a
   * managed folder when none was chosen, so a task always has a working directory.
   */
  createProject(name: string, directory?: string): Promise<{ project: CollabProject; localDirectory: string }>;
  /** Records which local Memmy project runs this online project's tasks. */
  bindLocalProject(projectId: string, localProjectId: string): Promise<{ ok: true }>;
  /**
   * The directory a project's tasks run in, created on demand; lets an older project gain a working project.
   * `name` names the managed folder after the project instead of its generated id.
   */
  ensureWorkingDirectory(projectId: string, name?: string, directory?: string): Promise<{ localDirectory: string }>;
  /**
   * One page of a project's sessions, newest activity first. A `query` keeps the sessions whose title, last
   * question or member name matches any keyword, which is what the board's search box and the @ menu use.
   */
  listSessions(projectId: string, options?: SessionListOptions): Promise<CollabSessionPage>;
  /** A session with its turns, for reading it in the app without downloading a file. */
  readSessionDetail(sessionId: string): Promise<{ session: CollabProjectSession; turns: CollabSessionTurn[] }>;
  /**
   * Sessions the person can reference from a message, limited to one online project: a reference stays inside the
   * project the task belongs to. No query returns the most recent `limit` sessions, which is what the @ menu shows
   * before typing.
   */
  candidateSessions(projectId: string, input?: { query?: string; limit?: number }): Promise<{ sessions: CollabProjectSession[] }>;
  listLocalSessions(input: { query?: string; sourceIds?: string[]; limit?: number; fresh?: boolean }): Promise<{ sessions: LocalAgentSession[]; refreshing: boolean }>;
  getLinks(projectId: string): Promise<CollabLinks>;
  /**
   * Saves what this computer associates and queues the new sessions. It returns before the upload finishes so the
   * person can keep working; `getSyncProgress` reports the rest.
   */
  saveLinks(projectId: string, links: CollabLinks): Promise<CollabSyncResult>;
  /** How far the queued upload for this project has come. */
  getSyncProgress(projectId: string): Promise<CollabSyncProgress>;
  /**
   * Deletes the project in the cloud and drops this computer's binding. The local project is kept, so the tasks
   * that ran in it stay on this computer.
   */
  deleteProject(projectId: string): Promise<{ ok: true }>;
  /** Uploads sessions that appeared in associated groups or changed since their last upload. Never removes any. */
  syncLinkedSessions(): Promise<CollabSyncResult>;
  /**
   * Uploads only this computer's Memmy tasks, which need no agent scan. Opening a board uses this so the list
   * appears at once, even while the Memory service is busy indexing other agents.
   */
  syncProjectTasks(): Promise<CollabSyncResult>;
  removeSession(projectId: string, sessionId: string): Promise<{ ok: true }>;
  searchSessions(input: { query?: string; member?: string; project?: string; limit?: number }): Promise<{ sessions: CollabProjectSession[] }>;
  readSession(reference: string): Promise<CollabSessionReference>;
}

/** Identifies a local session across agents. */
export function sessionKey(session: { sourceId: string; conversationId: string }): string {
  return `${session.sourceId}\u0000${session.conversationId}`;
}

function parseSessionKey(key: string): { sourceId: string; conversationId: string } {
  const separator = key.indexOf("\u0000");
  return { sourceId: key.slice(0, separator), conversationId: key.slice(separator + 1) };
}

/**
 * Which of the candidates the links cover, as session keys. A whole-group link covers every session of that agent's
 * group except the excluded ones; a session link covers that one session.
 */
export function linkedSessionKeys(links: CollabLinks, candidates: readonly LinkCandidate[]): Set<string> {
  const keys = new Set(links.sessions.map(sessionKey));
  for (const candidate of candidates) {
    const group = links.groups.find((link) => link.sourceId === candidate.sourceId && link.groupId === candidate.groupId);
    if (group && !group.excluded.includes(candidate.conversationId)) keys.add(sessionKey(candidate));
  }
  return keys;
}

/** Extracts a session ID from a pasted Memmy session link, the copied share text, or a bare ID. */
export function parseSessionReference(reference: string): string | null {
  const trimmed = reference.trim();
  if (SESSION_ID_PATTERN.test(trimmed)) {
    return trimmed;
  }
  return SESSION_LINK_PATTERN.exec(trimmed)?.[1] ?? null;
}

export function createCollabService(options: CollabServiceOptions): CollabService {
  const fetcher = options.fetcher ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const memmyHome = process.env.MEMMY_HOME?.trim() || join(homedir(), ".memmy");
  const projectsDir = options.projectsDir ?? join(memmyHome, "projects");
  /** Working directories for online projects that did not choose a folder, next to the project cache. */
  const onlineWorkdirRoot = join(dirname(projectsDir), "online-projects");
  const agentSessionsDir = options.agentSessionsDir ?? join(memmyHome, "workspace", "sessions");
  const linkBase = (options.linkBaseUrl?.trim() || safeOrigin(options.cloudBaseUrl)).replace(/\/+$/u, "");

  async function cloud(path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<Record<string, unknown>> {
    const account = requireAccount();
    let response: Response;
    try {
      response = await fetcher(`${options.cloudBaseUrl.replace(/\/+$/u, "")}/api/collab${path}`, {
        method: init.method ?? "GET",
        redirect: "error",
        signal: AbortSignal.timeout(init.timeoutMs ?? CLOUD_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${account.credential}`,
          ...(init.body === undefined ? {} : { "content-type": "application/json" })
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body)
      });
    } catch {
      throw new CollabError("memory_layer_unavailable", "暂时无法连接 Memmy 云端，请稍后重试。");
    }
    const payload = record(await response.json().catch(() => ({})));
    if (!response.ok || (typeof payload.code === "number" && payload.code !== 0)) {
      // The cloud reports some failures with an empty message; the code is what makes them diagnosable.
      const code = typeof payload.code === "number" && payload.code !== 0 ? `云端返回错误码 ${payload.code}` : "";
      throw new CollabError(errorCode(response.status), text(payload.message) || code || "协作项目请求未完成");
    }
    return record(payload.data);
  }

  async function memory(path: string, body: unknown): Promise<Record<string, unknown>> {
    if (!options.memory) {
      throw new CollabError("memory_layer_unavailable", "无法连接 Memmy，请打开 Memmy 后重试。");
    }
    let response: Response;
    try {
      response = await fetcher(`${options.memory.baseUrl.replace(/\/+$/u, "")}${path}`, {
        method: "POST",
        signal: AbortSignal.timeout(MEMORY_TIMEOUT_MS),
        headers: { "content-type": "application/json", authorization: `Bearer ${options.memory.token}` },
        body: JSON.stringify(body)
      });
    } catch {
      throw new CollabError("memory_layer_unavailable", "无法连接 Memmy，请打开 Memmy 后重试。");
    }
    const payload = record(await response.json().catch(() => ({})));
    if (!response.ok) {
      const message = text(record(payload.error).message);
      throw new CollabError(response.status === 404 ? "not_found" : "internal", message || "读取本机会话失败");
    }
    return payload;
  }

  function requireAccount(): CollabAccount {
    const account = options.getAccount();
    if (!account) {
      throw new CollabError("unauthorized", "请先登录 Memmy 后使用协作项目");
    }
    return account;
  }

  /** One page of a project's sessions, shared by the board and the @ menu so both read the same list. */
  async function listSessions(projectId: string, options: SessionListOptions = {}): Promise<CollabSessionPage> {
    const account = requireAccount();
    const data = await cloud(`/projects/${encodeURIComponent(projectId)}/sessions`);
    // The board reuses this project to refresh the sidebar, so the binding has to come with it.
    const stored = await readLinks(projectId, account.accountId);
    return {
      project: { ...toProject(data.project), localProjectId: stored.localProjectId },
      ...pageOf(list(data.sessions).map(withLink), options)
    };
  }

  async function listLocalSessions(input: { query?: string; sourceIds?: string[]; limit?: number; fresh?: boolean }) {
    const data = await memory("/api/v1/agent-sessions/available", {
      query: input.query,
      sourceIds: input.sourceIds,
      limit: input.limit,
      fresh: input.fresh
    });
    return { sessions: list(data.sessions).map(toLocalSession), refreshing: data.refreshing === true };
  }

  /** Upload progress per project, kept in memory: the board polls it while sessions arrive. */
  const syncProgress = new Map<string, CollabSyncProgress>();

  function reportProgress(projectId: string, patch: Partial<CollabSyncProgress>): void {
    const current = syncProgress.get(projectId) ?? { running: false, total: 0, completed: 0, failed: 0 };
    syncProgress.set(projectId, { ...current, ...patch });
  }

  /**
   * Uploads run on their own per-project chain, so saving the next selection never waits for the last upload.
   * One chain per project keeps a session from being uploaded twice.
   */
  const uploadChains = new Map<string, Promise<unknown>>();

  function enqueueUpload(projectId: string, task: () => Promise<void>): void {
    const previous = uploadChains.get(projectId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task).catch(() => undefined);
    uploadChains.set(projectId, next);
  }

  /** Saving links and the periodic sync both write; one at a time keeps the file consistent. */
  let queue: Promise<unknown> = Promise.resolve();
  function exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  }

  /** Uploads covered sessions that were never uploaded or changed since; a failure is retried by the next sync. */
  /** The sessions this project still has to upload: in its scope, not deleted, and changed since the last upload. */
  function sessionsToUpload(stored: StoredLinks, local: readonly LocalAgentSession[]): LocalAgentSession[] {
    const covered = linkedSessionKeys(stored, linkCandidates(stored, local));
    return local.filter((session) => {
      const key = sessionKey(session);
      const synced = stored.synced[key];
      // A Memmy task belongs to the project through its binding, so it needs no session link.
      const inProject = session.sourceId === MEMMY_SOURCE_ID
        ? !stored.removedSessions.includes(session.conversationId)
        : covered.has(key);
      // A retitled session needs a new upload even when its turns did not change: the board shows the title.
      return inProject && (!synced || isNewer(session.updatedAt, synced.updatedAt) || session.title !== synced.title);
    });
  }

  async function uploadPending(
    stored: StoredLinks,
    local: readonly LocalAgentSession[],
    onProgress?: (result: CollabSyncResult) => void
  ): Promise<CollabSyncResult> {
    const result: CollabSyncResult = { uploaded: 0, removed: 0, failed: 0 };
    const pending = sessionsToUpload(stored, local);
    let next = 0;
    let fatal: unknown = null;

    // A small pool: progress stays per-session while four reads overlap.
    const workers = Array.from({ length: Math.min(UPLOAD_CONCURRENCY, pending.length) }, async () => {
      for (;;) {
        if (fatal) return;
        const index = next;
        if (index >= pending.length) return;
        next += 1;
        const session = pending[index]!;
        try {
          const cloudSessionId = await uploadSession(stored.projectId, session);
          stored.synced[sessionKey(session)] = {
            cloudSessionId,
            updatedAt: session.updatedAt,
            groupId: session.group?.id ?? null,
            // The listed title is what the next sync compares against, so a retitled session uploads once more.
            title: session.title
          };
          result.uploaded += 1;
        } catch (error) {
          if (error instanceof CollabError && (error.code === "unauthorized" || error.code === "forbidden")) {
            fatal = error;
            return;
          }
          result.failed += 1;
        }
        onProgress?.(result);
      }
    });
    await Promise.all(workers);
    if (fatal) throw fatal;
    return result;
  }

  /**
   * Uploads whatever this project still owes the cloud. It reads the links again, so a selection saved while an
   * earlier upload was running is picked up too, and its own list is what the progress counts against.
   */
  async function runUpload(projectId: string, accountId: string): Promise<void> {
    const stored = await readLinks(projectId, accountId);
    const { sessions: local } = await listLocalSessions({ limit: MAX_LOCAL_SESSIONS })
      .then((listing) => listing)
      .catch(() => ({ sessions: [] as LocalAgentSession[] }));
    const candidates = [...local, ...await projectTaskSessions(stored)];
    const pending = sessionsToUpload(stored, candidates);
    syncProgress.set(projectId, { running: true, total: pending.length, completed: 0, failed: 0 });

    try {
      const result = await uploadPending(stored, candidates, (progress) => {
        reportProgress(projectId, { completed: progress.uploaded + progress.failed, failed: progress.failed });
      });
      // Merge only what was uploaded: another save may have changed groups or exclusions in the meantime.
      const latest = await readLinks(projectId, accountId);
      Object.assign(latest.synced, stored.synced);
      await writeLinks(latest);
      const remaining = sessionsToUpload(latest, candidates);
      reportProgress(projectId, {
        running: remaining.length > 0,
        total: pending.length,
        completed: result.uploaded + result.failed,
        failed: result.failed
      });
    } catch {
      reportProgress(projectId, { running: false });
    }
  }

  /** Rereads one session so the upload carries its latest turns; one session per request stays inside the cloud's size limit. */
  async function uploadSession(projectId: string, session: { sourceId: string; conversationId: string }): Promise<string> {
    if (session.sourceId === MEMMY_SOURCE_ID) {
      // Memmy's own tasks are not an external agent source; their turns live in this agent's session files.
      const task = await readMemmyTask(session.conversationId);
      return putCloudSession(projectId, MEMMY_SOURCE_ID, session.conversationId, task.title, task.updatedAt, task.turns);
    }
    const local = record((await memory("/api/v1/agent-sessions/read", { sourceId: session.sourceId, conversationId: session.conversationId })).session);
    const turns = list(local.turns).slice(-MAX_UPLOAD_TURNS).map(toUploadTurn);
    return putCloudSession(projectId, session.sourceId, session.conversationId, text(local.title), isoOrNull(local.updatedAt), turns);
  }

  /**
   * Memmy's own tasks that belong to one local project. The agent records the project on each session, so a bound
   * online project can upload exactly its own tasks and nothing else on this computer.
   */
  async function listMemmyTaskSessions(localProjectId: string): Promise<LocalAgentSession[]> {
    const entries = await readdir(agentSessionsDir, { withFileTypes: true }).catch(() => []);
    const sessions: LocalAgentSession[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const path = join(agentSessionsDir, entry.name);
      const records = await readSessionRecords(path);
      if (!records) continue;
      if (records.projectId !== localProjectId) continue;
      sessions.push({
        sourceId: MEMMY_SOURCE_ID,
        agentName: "Memmy",
        conversationId: records.conversationId,
        title: records.title,
        lastQuestion: records.lastQuestion,
        workspacePath: records.workspacePath,
        group: null,
        updatedAt: records.updatedAt,
        turnCount: records.turns.length
      });
    }
    return sessions;
  }

  /** The Memmy tasks of the bound project, when this project has one. */
  async function projectTaskSessions(stored: StoredLinks): Promise<LocalAgentSession[]> {
    return stored.localProjectId ? listMemmyTaskSessions(stored.localProjectId) : [];
  }

  async function readMemmyTask(conversationId: string): Promise<{ title: string; updatedAt: string; turns: CollabSessionTurn[] }> {
    const records = await readSessionRecords(join(agentSessionsDir, `websocket_${conversationId}.jsonl`));
    if (!records) {
      throw new CollabError("not_found", "无法读取该 Memmy 会话");
    }
    return { title: records.title, updatedAt: records.updatedAt, turns: records.turns.slice(-MAX_UPLOAD_TURNS).map(toUploadTurn) };
  }

  async function putCloudSession(
    projectId: string,
    source: string,
    sourceSessionId: string,
    title: string,
    lastActiveAt: string | null,
    turns: CollabSessionTurn[]
  ): Promise<string> {
    const data = await cloud(`/projects/${encodeURIComponent(projectId)}/sessions`, {
      method: "PUT",
      timeoutMs: UPLOAD_TIMEOUT_MS,
      body: { sessions: [{ source, sourceSessionId, title, lastActiveAt, turns }] }
    });
    return text(record(list(data.sessions)[0]).id);
  }

  async function deleteCloudSession(projectId: string, cloudSessionId: string): Promise<void> {
    try {
      await cloud(`/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(cloudSessionId)}`, { method: "DELETE" });
    } catch (error) {
      // Already gone from the project: nothing left to remove.
      if (!(error instanceof CollabError && error.code === "not_found")) throw error;
    }
  }

  function linksPath(projectId: string): string {
    return join(projectsDir, safeSegment(projectId), LINKS_FILE);
  }

  async function readLinks(projectId: string, accountId: string): Promise<StoredLinks> {
    const stored = parseStoredLinks(await readFile(linksPath(projectId), "utf8").catch(() => ""));
    // Links saved by another account on this computer are not this person's.
    return stored && stored.projectId === projectId && stored.accountId === accountId
      ? stored
      : { projectId, accountId, localProjectId: null, removedSessions: [], workingDirectory: null, groups: [], sessions: [], synced: {} };
  }

  async function readAllLinks(accountId: string): Promise<StoredLinks[]> {
    const entries = await readdir(projectsDir, { withFileTypes: true }).catch(() => []);
    const all: StoredLinks[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const stored = parseStoredLinks(await readFile(join(projectsDir, entry.name, LINKS_FILE), "utf8").catch(() => ""));
      // A bound project syncs its Memmy tasks even when no other agent sessions are associated.
      if (stored?.accountId === accountId && (stored.groups.length || stored.sessions.length || stored.localProjectId)) all.push(stored);
    }
    return all;
  }

  async function writeLinks(stored: StoredLinks): Promise<void> {
    const path = linksPath(stored.projectId);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  }

  function withLink(raw: unknown): CollabProjectSession {
    const session = record(raw);
    const id = text(session.id);
    const title = text(session.title);
    const link = `${linkBase}/s/${id}`;
    const mine = session.mine === true;
    return {
      id,
      projectId: text(session.projectId),
      projectName: text(session.projectName),
      title,
      lastQuestion: text(session.lastQuestion),
      // On your own sessions your nickname is what other members see, so show the same name here.
      memberName: (mine ? options.getAccount()?.memberName?.trim() : "") || text(session.memberName),
      mine,
      source: text(session.source),
      turnCount: number(session.turnCount),
      lastActiveAt: nullableText(session.lastActiveAt),
      link,
      shareText: `【Memmy】${title} ${link}`
    };
  }

  return {
    async listProjects() {
      const account = requireAccount();
      const data = await cloud("/projects");
      const projects = list(data.projects).map(toProject);
      // Each project's local working project is recorded on this computer, next to its session links.
      const bound = await Promise.all(projects.map(async (project) => {
        const stored = await readLinks(project.id, account.accountId);
        return { ...project, localProjectId: stored.localProjectId };
      }));
      return { projects: bound };
    },

    async createProject(name, directory) {
      const data = await cloud("/projects", { method: "POST", body: { name } });
      const project = toProject(data.project);
      const localDirectory = await prepareWorkingDirectory(onlineWorkdirRoot, project.id, project.name, directory);
      const account = requireAccount();
      const stored = await readLinks(project.id, account.accountId);
      stored.workingDirectory = localDirectory;
      await writeLinks(stored);
      return { project: { ...project, localProjectId: null }, localDirectory };
    },

    async ensureWorkingDirectory(projectId, name, directory) {
      const account = requireAccount();
      const stored = await readLinks(projectId, account.accountId);
      // A project created earlier keeps the folder it already had, so its tasks stay where they were.
      const existing = directory ? undefined : stored.workingDirectory;
      const localDirectory = existing
        ?? await prepareWorkingDirectory(onlineWorkdirRoot, projectId, name ?? projectId, directory);
      if (!stored.workingDirectory) {
        stored.workingDirectory = localDirectory;
        await writeLinks(stored);
      }
      return { localDirectory };
    },

    async bindLocalProject(projectId, localProjectId) {
      const account = requireAccount();
      const stored = await readLinks(projectId, account.accountId);
      stored.localProjectId = localProjectId;
      await writeLinks(stored);
      return { ok: true };
    },

    listSessions,

    async candidateSessions(projectId, input = {}) {
      // The same page the board reads, so the @ menu can only offer what this project holds.
      const { sessions } = await listSessions(projectId, {
        ...(input.query ? { query: input.query } : {}),
        offset: 0,
        limit: input.limit ?? CANDIDATE_LIMIT
      });
      return { sessions };
    },

    async readSessionDetail(sessionId) {
      // Same payload the reference downloads, minus writing a file: the reader stays a viewer.
      const data = record((await cloud(`/sessions/${encodeURIComponent(sessionId)}`)).session);
      return { session: withLink(data), turns: list(data.turns).map(toTurn) };
    },



    listLocalSessions,

    async getLinks(projectId) {
      const account = requireAccount();
      const stored = await readLinks(projectId, account.accountId);
      return { groups: stored.groups, sessions: stored.sessions };
    },

    saveLinks(projectId, links) {
      const account = requireAccount();
      return exclusive(async () => {
        const stored = await readLinks(projectId, account.accountId);
        const { sessions: local } = await listLocalSessions({ limit: MAX_LOCAL_SESSIONS });
        const tasks = await projectTaskSessions(stored);
        const candidates = linkCandidates(stored, [...local, ...tasks]);
        // Both sides are judged on the same candidates, so only what the person changed is removed.
        const before = linkedSessionKeys(stored, candidates);
        const after = linkedSessionKeys(links, candidates);
        let removed = 0;
        for (const key of before) {
          const synced = stored.synced[key];
          if (after.has(key) || !synced) continue;
          await deleteCloudSession(projectId, synced.cloudSessionId);
          delete stored.synced[key];
          removed += 1;
        }
        stored.groups = links.groups;
        stored.sessions = links.sessions;

        // The selection is saved before any upload, so closing the board or the app never loses it.
        const pending = sessionsToUpload(stored, [...local, ...tasks]);
        await writeLinks(stored);
        if (!pending.length) {
          syncProgress.delete(projectId);
          return { uploaded: 0, removed, failed: 0 };
        }

        syncProgress.set(projectId, { running: true, total: pending.length, completed: 0, failed: 0 });
        enqueueUpload(projectId, () => runUpload(projectId, account.accountId));
        return { uploaded: 0, removed, failed: 0, started: pending.length };
      });
    },

    async getSyncProgress(projectId) {
      return syncProgress.get(projectId) ?? { running: false, total: 0, completed: 0, failed: 0 };
    },

    async deleteProject(projectId) {
      const account = requireAccount();
      await cloud(`/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" });
      syncProgress.delete(projectId);
      // Only the binding goes: the local project and its sessions remain usable as a plain local project.
      const stored = await readLinks(projectId, account.accountId);
      stored.localProjectId = null;
      stored.groups = [];
      stored.sessions = [];
      stored.synced = {};
      stored.removedSessions = [];
      await exclusive(() => writeLinks(stored));
      return { ok: true };
    },

    syncProjectTasks() {
      return exclusive(async () => {
        const account = options.getAccount();
        const total: CollabSyncResult = { uploaded: 0, removed: 0, failed: 0 };
        if (!account) return total;
        const projects = await readAllLinks(account.accountId);
        for (const stored of projects) {
          const tasks = await projectTaskSessions(stored);
          if (!tasks.length) continue;
          const result = await uploadPending(stored, tasks);
          if (result.uploaded || result.failed) await writeLinks(stored);
          total.uploaded += result.uploaded;
          total.failed += result.failed;
        }
        return total;
      });
    },

    syncLinkedSessions() {
      return exclusive(async () => {
        const account = options.getAccount();
        const total: CollabSyncResult = { uploaded: 0, removed: 0, failed: 0 };
        if (!account) return total;
        const projects = await readAllLinks(account.accountId);
        if (!projects.length) return total;
        // The Memory service only holds the other agents' sessions; Memmy's own tasks must still sync without it.
        // A cached list is enough here: forcing a rescan every minute would re-walk every agent's history.
        const local = await listLocalSessions({ limit: MAX_LOCAL_SESSIONS })
          .then((listing) => listing.sessions)
          .catch(() => []);
        for (const stored of projects) {
          const result = await uploadPending(stored, [...local, ...await projectTaskSessions(stored)]);
          if (result.uploaded || result.failed) await writeLinks(stored);
          total.uploaded += result.uploaded;
          total.failed += result.failed;
        }
        return total;
      });
    },

    async removeSession(projectId, sessionId) {
      await cloud(`/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
      const account = options.getAccount();
      if (account) {
        // Otherwise the next sync would upload it again: drop the session link, or exclude it from its group.
        await exclusive(async () => {
          const stored = await readLinks(projectId, account.accountId);
          const entry = Object.entries(stored.synced).find(([, synced]) => synced.cloudSessionId === sessionId);
          if (!entry) return;
          const [key, synced] = entry;
          const { sourceId, conversationId } = parseSessionKey(key);
          delete stored.synced[key];
          if (sourceId === MEMMY_SOURCE_ID && !stored.removedSessions.includes(conversationId)) {
            stored.removedSessions.push(conversationId);
          }
          stored.sessions = stored.sessions.filter((link) => sessionKey(link) !== key);
          const group = stored.groups.find((link) => link.sourceId === sourceId && link.groupId === synced.groupId);
          if (group && !group.excluded.includes(conversationId)) group.excluded.push(conversationId);
          await writeLinks(stored);
        });
      }
      return { ok: true };
    },

    async searchSessions(input) {
      const query = new URLSearchParams();
      query.set("q", input.query ?? "");
      if (input.member) query.set("member", input.member);
      if (input.project) query.set("project", input.project);
      if (input.limit !== undefined) query.set("limit", String(input.limit));
      const data = await cloud(`/sessions/search?${query.toString()}`);
      return { sessions: list(data.sessions).map(withLink) };
    },

    async readSession(reference) {
      const id = parseSessionReference(reference);
      if (!id) {
        throw new CollabError("invalid_argument", "无法识别的会话链接。请从 Memmy 中重新复制链接。");
      }
      // The cloud returns one `session` that also carries this session's `turns`.
      const data = record((await cloud(`/sessions/${encodeURIComponent(id)}`)).session);
      const session = withLink(data);
      const downloadedAt = now();
      const directory = join(projectsDir, safeSegment(session.projectId), "sessions");
      const path = join(directory, `${safeSegment(session.id)}.md`);
      await mkdir(directory, { recursive: true });
      await writeFile(path, renderSessionMarkdown(session, list(data.turns).map(toTurn), downloadedAt), "utf8");
      return { session, path, text: referenceText(session, path, downloadedAt) };
    }
  };
}

/**
 * Filters by keyword, then takes one page. Keywords are matched against what a person would search by: the
 * title, the last question, and the member's name; any keyword matching is enough.
 */
export function pageOf(
  sessions: readonly CollabProjectSession[],
  options: { query?: string; member?: "me" | "others"; offset?: number; limit?: number } = {}
): { sessions: CollabProjectSession[]; total: number } {
  const byMember = options.member
    ? sessions.filter((session) => (options.member === "me" ? session.mine : !session.mine))
    : [...sessions];
  const keywords = (options.query ?? "").toLowerCase().split(/\s+/u).filter(Boolean);
  const matched = keywords.length
    ? byMember.filter((session) => {
      const haystack = `${session.title}\n${session.lastQuestion}\n${session.memberName}`.toLowerCase();
      return keywords.some((keyword) => haystack.includes(keyword));
    })
    : byMember;
  const offset = Math.max(0, options.offset ?? 0);
  const limit = options.limit === undefined ? matched.length : Math.max(0, options.limit);
  return { sessions: matched.slice(offset, offset + limit), total: matched.length };
}

/** The lines handed to an agent after a reference; it reads the file before answering. */
export function referenceText(session: CollabProjectSession, path: string, downloadedAt: Date): string {
  // The member is named, not "you": this text travels in messages and files others may read.
  const owner = session.memberName || (session.mine ? "你" : "");
  const activity = session.lastActiveAt ? `最近交互 ${formatTime(new Date(session.lastActiveAt))}，` : "";
  return [
    `已引用${owner}的会话「${session.title}」（${session.projectName}，${activity}下载于 ${formatTime(downloadedAt)}）。`,
    `完整记录：${path}`,
    "回答与该会话相关的问题前，先读取此文件。"
  ].join("\n");
}

/** Renders a downloaded project session as the file an agent reads. */
export function renderSessionMarkdown(session: CollabProjectSession, turns: CollabSessionTurn[], downloadedAt: Date): string {
  // The file is shared reading: name the member, since "you" means nothing to a later reader.
  const speaker = session.memberName || (session.mine ? "你" : "");
  const lines = [
    `# ${session.title}`,
    "",
    `- 成员：${speaker}`,
    `- 项目：${session.projectName}`,
    ...(session.lastActiveAt ? [`- 最近交互：${formatTime(new Date(session.lastActiveAt))}`] : []),
    `- 下载时间：${formatTime(downloadedAt)}`,
    "",
    `## 会话记录（共 ${session.turnCount || turns.length} 轮${turns.length < session.turnCount ? `，保留最近 ${turns.length} 轮` : ""}）`
  ];
  const offset = Math.max(0, (session.turnCount || turns.length) - turns.length);
  turns.forEach((turn, index) => {
    lines.push("", `### 第 ${offset + index + 1} 轮`);
    if (turn.question) lines.push(`${speaker}：${turn.question}`);
    if (turn.reply) lines.push(`回复：${turn.reply}`);
    if (turn.steps.length) lines.push(`执行步骤：${summarizeSteps(turn.steps)}`);
  });
  return `${lines.join("\n")}\n`;
}

/** Listed sessions with their current group, plus uploaded ones that dropped out of the list with the group they had. */
function linkCandidates(stored: StoredLinks, local: readonly LocalAgentSession[]): LinkCandidate[] {
  const candidates = new Map<string, LinkCandidate>();
  for (const [key, synced] of Object.entries(stored.synced)) {
    candidates.set(key, { ...parseSessionKey(key), groupId: synced.groupId });
  }
  for (const session of local) {
    candidates.set(sessionKey(session), { sourceId: session.sourceId, conversationId: session.conversationId, groupId: session.group?.id ?? null });
  }
  return [...candidates.values()];
}

interface MemmySessionRecords {
  conversationId: string;
  projectId: string;
  title: string;
  lastQuestion: string;
  workspacePath: string | null;
  updatedAt: string;
  turns: CollabSessionTurn[];
}

/**
 * Reads one of Memmy's task session files: a metadata line first, then user, assistant and tool records that
 * group into turns the same way the board shows them.
 */
async function readSessionRecords(path: string): Promise<MemmySessionRecords | null> {
  const content = await readFile(path, "utf8").catch(() => null);
  if (!content) return null;

  let key = "";
  let projectId = "";
  let title = "";
  let workspacePath: string | null = null;
  let updatedAt = "";
  let lastQuestion = "";
  const turns: CollabSessionTurn[] = [];
  let current: CollabSessionTurn | null = null;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let raw: Record<string, unknown>;
    try {
      raw = record(JSON.parse(trimmed));
    } catch {
      continue;
    }
    const timestamp = text(raw.timestamp);
    if (timestamp) updatedAt = timestamp;

    if (text(raw.recordType) === "metadata") {
      key = text(raw.key);
      const metadata = record(raw.metadata);
      projectId = text(metadata.webuiProjectId);
      title = text(metadata.title);
      workspacePath = nullableText(metadata.webuiWorkspaceCwd);
      const metaTime = text(raw.updatedAt);
      if (metaTime && !updatedAt) updatedAt = metaTime;
      continue;
    }

    const role = text(raw.role);
    if (role === "user") {
      if (current) turns.push(current);
      lastQuestion = text(raw.content);
      current = { question: lastQuestion, reply: "", steps: [], startedAt: timestamp };
      continue;
    }
    if (role === "assistant") {
      if (!current) current = { question: "", reply: "", steps: [], startedAt: timestamp };
      current.reply = current.reply ? `${current.reply}\n\n${text(raw.content)}` : text(raw.content);
      continue;
    }
    if (role === "tool" && current) {
      const name = text(raw.name);
      if (name) current.steps.push(name);
    }
  }
  if (current) turns.push(current);
  if (!turns.length && !title) return null;

  const conversationId = key.replace(/^websocket:/u, "") || path.split("/").pop()!.replace(/^websocket_/u, "").replace(/\.jsonl$/u, "");
  return {
    conversationId,
    projectId,
    title: title || lastQuestion,
    lastQuestion,
    workspacePath,
    updatedAt,
    turns
  };
}

function parseStoredLinks(content: string): StoredLinks | null {
  let raw: Record<string, unknown>;
  try {
    raw = record(JSON.parse(content));
  } catch {
    return null;
  }
  const projectId = text(raw.projectId);
  const accountId = text(raw.accountId);
  if (!projectId || !accountId) return null;
  const synced: StoredLinks["synced"] = {};
  for (const [key, value] of Object.entries(record(raw.synced))) {
    const entry = record(value);
    if (text(entry.cloudSessionId)) {
      synced[key] = {
        cloudSessionId: text(entry.cloudSessionId),
        updatedAt: text(entry.updatedAt),
        groupId: nullableText(entry.groupId),
        ...(nullableText(entry.title) === null ? {} : { title: text(entry.title) })
      };
    }
  }
  return {
    projectId,
    accountId,
    localProjectId: nullableText(raw.localProjectId),
    removedSessions: list(raw.removedSessions).filter((id): id is string => typeof id === "string"),
    workingDirectory: nullableText(raw.workingDirectory),
    groups: list(raw.groups).map(record).map((group) => ({
      sourceId: text(group.sourceId),
      groupId: text(group.groupId),
      excluded: list(group.excluded).filter((id): id is string => typeof id === "string")
    })).filter((group) => group.sourceId && group.groupId),
    sessions: list(raw.sessions).map(record).map((session) => ({
      sourceId: text(session.sourceId),
      conversationId: text(session.conversationId)
    })).filter((session) => session.sourceId && session.conversationId),
    synced
  };
}

/** True when the local session changed after the uploaded copy; an unknown time counts as changed. */
function isNewer(updatedAt: string, uploadedAt: string): boolean {
  const local = Date.parse(updatedAt);
  const uploaded = Date.parse(uploadedAt);
  return Number.isNaN(local) || Number.isNaN(uploaded) || local > uploaded;
}

/** `~/…/online-projects/<name>`, suffixed with a short id only when another project already uses that name. */
async function uniqueWorkingDirectory(root: string, name: string, projectId: string): Promise<string> {
  const base = join(root, safeDirectoryName(name));
  if (!(await pathExists(base))) return base;
  return join(root, `${safeDirectoryName(name)}-${safeSegment(projectId).slice(0, 8)}`);
}

/**
 * A folder name people read in a task page and the project picker, so letters in any script survive; only
 * characters a filesystem or a shell would mind are replaced.
 */
function safeDirectoryName(value: string): string {
  const cleaned = value
    .replace(/[/\\:*?"<>|\u0000-\u001f]+/gu, "_")
    .replace(/^\.+/u, "")
    .trim()
    .slice(0, 60);
  return cleaned || "project";
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * The directory an online project's tasks run in: the folder the person picked, or a managed empty folder so a
 * task always has a working directory. Either way it is created before the local project is registered.
 */
async function prepareWorkingDirectory(
  root: string,
  projectId: string,
  name: string,
  directory: string | undefined
): Promise<string> {
  // The folder name is what a task page and the project picker show, so it carries the project name and only
  // falls back to the id when the name is already taken by another project.
  const target = directory?.trim()
    ? directory.trim()
    : await uniqueWorkingDirectory(root, name, projectId);
  try {
    const info = await stat(target);
    if (!info.isDirectory()) throw new Error("not a directory");
  } catch {
    await mkdir(target, { recursive: true });
  }
  return target;
}

function toProject(raw: unknown): CollabProject {
  const project = record(raw);
  return {
    id: text(project.id),
    name: text(project.name),
    role: text(project.role),
    memberCount: number(project.memberCount),
    sessionCount: number(project.sessionCount),
    createdAt: nullableText(project.createdAt),
    // The cloud has no notion of this computer's project; listProjects fills it in from the local store.
    localProjectId: null
  };
}

function toLocalSession(raw: unknown): LocalAgentSession {
  const session = record(raw);
  return {
    sourceId: text(session.sourceId),
    agentName: text(session.agentName),
    conversationId: text(session.conversationId),
    title: text(session.title),
    lastQuestion: text(session.lastQuestion),
    workspacePath: nullableText(session.workspacePath),
    group: toGroup(session.group),
    updatedAt: text(session.updatedAt),
    turnCount: number(session.turnCount)
  };
}

function toGroup(raw: unknown): LocalSessionGroup | null {
  const group = record(raw);
  return text(group.id) ? { id: text(group.id), label: text(group.label) || text(group.id), path: nullableText(group.path) } : null;
}

function toTurn(raw: unknown): CollabSessionTurn {
  const turn = record(raw);
  return {
    question: text(turn.question),
    reply: text(turn.reply),
    steps: list(turn.steps).filter((step): step is string => typeof step === "string"),
    startedAt: text(turn.startedAt)
  };
}

function toUploadTurn(raw: unknown): CollabSessionTurn {
  const turn = toTurn(raw);
  return {
    question: clip(turn.question, MAX_QUESTION_CHARS),
    reply: clip(turn.reply, MAX_REPLY_CHARS),
    steps: turn.steps.slice(0, MAX_STEPS_PER_TURN),
    startedAt: turn.startedAt
  };
}

/** Collapses repeated tool names, e.g. Bash ×3、Edit. */
function summarizeSteps(steps: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const step of steps) counts.set(step, (counts.get(step) ?? 0) + 1);
  return [...counts.entries()].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join("、");
}

function errorCode(status: number): ApiErrorCode {
  if (status === 400 || status === 413) return "invalid_argument";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  return status >= 500 ? "memory_layer_unavailable" : "internal";
}

function formatTime(date: Date): string {
  if (Number.isNaN(date.getTime())) return "未知";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/gu, "_").slice(0, 120) || "_";
}

function isoOrNull(value: unknown): string | null {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function clip(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars - 1)}…` : value;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
