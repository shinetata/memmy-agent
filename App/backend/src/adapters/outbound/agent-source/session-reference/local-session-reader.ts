/**
 * Local session reader. Lists this machine's agent sessions so a person can pick which ones to associate with an
 * online project, and reads one session's turns so they can be uploaded to it. It runs in the desktop backend on
 * the backend's own agent adapters, so online projects do not depend on the Memory service.
 */
import { statSync } from "node:fs";
import type { SourceRegistry } from "@memmy/agent-source-readers/adapters/source-registry";
import type { SourceAdapter } from "@memmy/agent-source-readers/adapters/types";
import { rankLocalSessions } from "./local-session-rank.js";
import { canReadArchive, readArchivedSession } from "./archived-rollout.js";
import { readRecentSessionsFromMetadata } from "./session-metadata/index.js";
import { createSessionGrouper, type LocalSessionGroup, type SessionGrouper } from "./session-group.js";
import { appendMessage, finishSession, type SessionBuilder } from "./session-shape.js";
import { createStoreDigest, type StoreDigest } from "./store-digest.js";

export type { LocalSessionGroup } from "./session-group.js";
export { cleanQuestion, isHumanQuestion, isInternalUserMessage, stripInjectedContext } from "./session-shape.js";

/**
 * 每个 Agent 最多列出多少个最近任务。
 *
 * <p>这个数字同时决定扫描窗口（`recentScanWindow`）：窗口是它的四倍、封顶 200 个文件。提到 100 不会把窗口再放大
 * （30 的窗口已经是 120 个文件，100 的窗口是 200），所以多出来的只有「返回更多条」，不是「多读文件」。
 * 一台机器上会话文件本来就没有那么多时（本机 Claude Code 共 122 个），代价完全不变。</p>
 */
const DEFAULT_SESSIONS_PER_SOURCE = 100;
/**
 * 列表要的是任务数，而窗口按文件算：空记录、后台派生的记录不出现在列表里。凑不满时向前扩大窗口，
 * 直到拿到要求数量的任务或到达这个上限。
 */
const RECENT_SCAN_FACTORS = [1, 2, 4] as const;
/** A wider window used only when the recent list comes up short. */
const WIDE_SESSIONS_PER_SOURCE = 200;
/**
 * 快照多久算旧。它现在只决定「多久拿摘要核对一次」——核对是几毫秒的 stat，不用再读盘，所以保持在 15 秒：
 * 弹窗拿到的列表依旧不会超过这个时长，而每分钟的后台同步也不会因此重新扫一遍。
 */
const DEFAULT_SNAPSHOT_TTL_MS = 15_000;
const DEFAULT_AVAILABLE_LIMIT = 50;
const MAX_AVAILABLE_LIMIT = 500;
/** Sessions one batch read may ask for; their turns all travel in one response. */
export const MAX_READ_MANY = 50;

/** One question and everything the agent did until the next question. */
export interface LocalSessionTurn {
  question: string;
  reply: string;
  steps: string[];
  startedAt: string;
}

/** A local agent session reduced to what association and reading need. */
export interface LocalSession {
  sourceId: string;
  agentName: string;
  conversationId: string;
  title: string;
  lastQuestion: string;
  workspacePath: string | null;
  /** The agent's project or workspace, or the directory; null outside every unit. */
  group: LocalSessionGroup | null;
  updatedAt: string;
  turns: LocalSessionTurn[];
  /** 会话只留下了压缩存档：列表照常列出，读正文时解压（解不开才报读不出内容）。 */
  archived?: boolean;
}

/** A session as listed in the association picker, without its turns. */
export interface LocalSessionCandidate {
  sourceId: string;
  agentName: string;
  conversationId: string;
  title: string;
  lastQuestion: string;
  workspacePath: string | null;
  group: LocalSessionGroup | null;
  updatedAt: string;
  turnCount: number;
  /** 会话只留下了压缩存档：照样列出、照样可关联，读取时由后端解压。 */
  archived?: boolean;
}

/** The candidate pool, and whether a newer scan is running behind it. */
export interface LocalSessionListing {
  sessions: LocalSessionCandidate[];
  /** True when these came from the previous scan; asking again with `fresh` returns the newer one. */
  refreshing: boolean;
}

/** Contract for the candidate pool the association picker chooses from. */
export interface LocalSessionAvailableInput {
  query?: string;
  /** Sessions in this directory rank first. */
  cwd?: string | null;
  /** Only sessions of these agents, e.g. ["workbuddy"]; all agents when absent. */
  sourceIds?: readonly string[];
  limit?: number;
  /** Waits for a current scan instead of answering from the previous one. */
  fresh?: boolean;
}

/** Contract for local session reader. */
export interface LocalSessionReader {
  /** The agents' sessions, most relevant first; answers from the last scan while a newer one runs. */
  available(input: LocalSessionAvailableInput): Promise<LocalSessionListing>;
  /** Rereads one session so an upload carries its latest turns. */
  read(input: { sourceId: string; conversationId: string }): Promise<LocalSession>;
  /**
   * Rereads several sessions of one agent with one pass over its store. Reading them one by one costs a pass each,
   * since a store is only read whole; `missing` lists the requested sessions it no longer has, and `archived` the
   * ones the agent has compressed into an archive the store cannot read back.
   */
  readMany(input: { sourceId: string; conversationIds: readonly string[] }): Promise<LocalSessionBatch>;
}

/** What one batch read found: the sessions, the ones gone, and the ones only an archive still holds. */
export interface LocalSessionBatch {
  sessions: LocalSession[];
  missing: string[];
  /** 会话被 Agent 压成了存档（Codex 的 `.jsonl.zst`）却解不开：列表里看得到，这次读不出正文。 */
  archived: string[];
}

/**
 * A read the caller can explain: an unknown agent or session, a batch larger than one read allows, or a session
 * whose text only survives in an archive.
 */
export class LocalSessionReadError extends Error {
  constructor(readonly code: "not_found" | "invalid_argument" | "toolkit_unsupported", message: string) {
    super(message);
    this.name = "LocalSessionReadError";
  }
}

/**
 * 存档解不开时给用户的话：说清是什么、为什么、还能做什么。
 *
 * <p>正常情况下存档会被解压读出（见 {@link readArchivedSession}），只有解压或解析失败才提示这一句。</p>
 */
export const ARCHIVED_SESSION_TEXT = "这个任务只留下了压缩存档，这次没能解开它的内容。在 Codex 里重新打开它之后可以正常关联。";

/** 一个会话的文件：路径，它是不是压缩存档（只有存档时读不出正文），以及索引记的目录。 */
export interface LocatedSessionFile {
  path: string;
  archived: boolean;
  /** 索引记的工作目录；解压读取时用它把任务放回原来的分组，否则只能落在「未记录目录」。 */
  workspacePath?: string | null;
}

/**
 * 索引说这份会话只有存档、而现在磁盘上也确实还是存档。
 *
 * <p>不能只看索引：在 Codex 里重新打开一个旧会话，它会写下新的明文 rollout，那份就能正常读了。所以再确认一次
 * 磁盘上的状态，把「已经能读了」的情况让回扫描路径。</p>
 */
function stillArchived(located: LocatedSessionFile): boolean {
  if (!located.archived) return false;
  try {
    return statSync(located.path).isFile();
  } catch {
    // 索引里有、磁盘上找不到：仍然不是能读的正文。
    return true;
  }
}

/** One agent store a scan should read, and the store it must read it from. */
export interface LocalSessionScanRequest {
  sourceId: string;
  /** The store this source was seen at; a reader that only has the source id must refuse a store it does not own. */
  dataPath: string;
  /** How many of that source's most recent sessions to read. */
  limit: number;
}

/**
 * Reads the given stores somewhere else and answers with what it read, keyed by source id.
 *
 * <p>A source it does not answer for is read on this thread as usual, so a reader that cannot keep up leaves the
 * result unchanged and only gives back the responsiveness it was meant to save.</p>
 */
export type LocalSessionScanOffload = (
  requests: readonly LocalSessionScanRequest[]
) => Promise<ReadonlyMap<string, readonly LocalSession[]>>;

export interface CreateLocalSessionReaderDeps {
  registry: SourceRegistry;
  /** When set, each scan reads this list instead of `registry.list()`, so added agents can be loaded from disk. */
  adapters?: () => Promise<readonly SourceAdapter[]>;
  sessionsPerSource?: number;
  snapshotTtlMs?: number;
  now?: () => number;
  /** 判断某份存储有没有变的廉价摘要；默认浅层 stat 一遍，测试里可以换成假的。 */
  storeDigest?: StoreDigest;
  /**
   * 把读盘交给别的线程。读一份存储是几秒的同步解析，留在调用方线程上会把同时到达的请求一起堵住；
   * 没交出去、或者交出去没读成的源，照旧在本线程读。
   */
  offloadScan?: LocalSessionScanOffload;
  /**
   * 某个会话的会话文件，索引已知时由它给出，并说明它是不是压缩存档。
   *
   * <p>索引（Codex 的索引库、Cursor 的库）本来就知道文件在哪，因此不必为一条会话扫一遍整份历史。只剩压缩存档
   * （`.jsonl.zst`）的会话要按这个位置解压，它也让「读不了」与「不存在」两种失败分得开。</p>
   */
  locateSessionFile?: (sourceId: string, conversationId: string) => Promise<LocatedSessionFile | null>;
}

/** Creates the local session reader. */
export function createLocalSessionReader(deps: CreateLocalSessionReaderDeps): LocalSessionReader {
  const sessionsPerSource = deps.sessionsPerSource ?? DEFAULT_SESSIONS_PER_SOURCE;
  const snapshotTtlMs = deps.snapshotTtlMs ?? DEFAULT_SNAPSHOT_TTL_MS;
  const now = deps.now ?? Date.now;
  const storeDigest = deps.storeDigest ?? createStoreDigest();
  /** 每份存储上次扫描时的摘要与结果：摘要没变就不用再读一遍。 */
  const perSource = new Map<string, { digest: string | null; sessions: LocalSession[] }>();
  /** 快照里装的是哪几个 Agent，权限变了会变。 */
  let snapshotSources = "";
  let snapshot: { loadedAt: number; sessions: LocalSession[] } | null = null;
  let loading: Promise<LocalSession[]> | null = null;

  /** One live read of the agents' stores at a time, shared by every caller waiting on it. */
  async function adapters(): Promise<readonly SourceAdapter[]> {
    return deps.adapters ? deps.adapters() : deps.registry.list();
  }

  /**
   * 扫描前先取各份存储的摘要：摘要对不上的才真去读盘。摘要比扫描早一步拿到，所以扫描期间刚写进来的内容
   * 会让下次摘要对不上、多扫一遍，不会反过来漏掉。
   */
  async function currentDigests(list: readonly SourceAdapter[]): Promise<Map<string, string | null>> {
    const digests = new Map<string, string | null>();
    // 一个个来：一份摘要只值几毫秒，串行做占不满 I/O 线程池，也不跟真正的请求抢。
    for (const adapter of list) {
      digests.set(adapter.descriptor.sourceId, await storeDigest(adapter.descriptor.dataPath));
    }
    return digests;
  }

  /** 摘要变了，或者压根说不清有没有变的存储。 */
  function staleSources(list: readonly SourceAdapter[], digests: Map<string, string | null>): SourceAdapter[] {
    return list.filter((adapter) => {
      const cached = perSource.get(adapter.descriptor.sourceId);
      const digest = digests.get(adapter.descriptor.sourceId) ?? null;
      return !cached || digest === null || cached.digest !== digest;
    });
  }

  function sourceKey(list: readonly SourceAdapter[]): string {
    return list.map((adapter) => adapter.descriptor.sourceId).join(",");
  }

  /**
   * 读这几份存储：先问别的线程能不能代读，回来的用它，没回来的在本线程读。
   *
   * <p>代读没答的源不能当成「读了但一个会话也没有」：前者要自己补读，后者就是空列表。</p>
   */
  async function readStores(list: readonly SourceAdapter[]): Promise<ReadonlyMap<string, readonly LocalSession[]>> {
    if (!list.length || !deps.offloadScan) {
      return new Map();
    }
    try {
      return await deps.offloadScan(list.map((adapter) => ({
        sourceId: adapter.descriptor.sourceId,
        dataPath: adapter.descriptor.dataPath,
        limit: sessionsPerSource
      })));
    } catch {
      // 代读整段挂了就全留在本线程：结果一样，只是慢回原来的样子。
      return new Map();
    }
  }

  function scan(list: readonly SourceAdapter[], digests: Map<string, string | null>): Promise<LocalSession[]> {
    loading ??= (async () => {
      /** 摘要对得上、已经在上次扫描里的源不必再读。 */
      const pending: SourceAdapter[] = [];
      for (const adapter of list) {
        const sourceId = adapter.descriptor.sourceId;
        const digest = digests.get(sourceId) ?? null;
        const cached = perSource.get(sourceId);
        if (!cached || digest === null || cached.digest !== digest) {
          pending.push(adapter);
        }
      }
      const offloaded = await readStores(pending);
      for (const adapter of pending) {
        const sourceId = adapter.descriptor.sourceId;
        const sessions = offloaded.get(sourceId) ?? await readRecentSessions(adapter, sessionsPerSource);
        perSource.set(sourceId, { digest: digests.get(sourceId) ?? null, sessions: [...sessions] });
      }
      // 掉出扫描范围的 Agent 不留旧数据：关掉的 Agent 再打开时应该从头读一遍。
      const visible = new Set(list.map((adapter) => adapter.descriptor.sourceId));
      for (const sourceId of perSource.keys()) {
        if (!visible.has(sourceId)) perSource.delete(sourceId);
      }
      const sessions = list.flatMap((adapter) => perSource.get(adapter.descriptor.sourceId)?.sessions ?? []);
      snapshot = { loadedAt: now(), sessions };
      snapshotSources = sourceKey(list);
      return sessions;
    })().finally(() => {
      loading = null;
    });
    return loading;
  }

  /**
   * Scanning every agent takes seconds, so an expired snapshot is still answered at once while a new scan runs
   * behind it. Only the first request, or one that asks for `fresh`, waits for the scan.
   *
   * 过期之后先花几毫秒比对摘要：本机什么都没变就当这份快照刚校验过，一次盘都不用读。
   */
  async function allSessions(fresh: boolean): Promise<{ sessions: LocalSession[]; refreshing: boolean }> {
    if (snapshot && now() - snapshot.loadedAt < snapshotTtlMs) {
      return { sessions: snapshot.sessions, refreshing: false };
    }
    const list = await adapters();
    const digests = await currentDigests(list);
    if (snapshot && snapshotSources === sourceKey(list) && !staleSources(list, digests).length) {
      snapshot.loadedAt = now();
      return { sessions: snapshot.sessions, refreshing: false };
    }
    if (snapshot && !fresh) {
      void scan(list, digests);
      return { sessions: snapshot.sessions, refreshing: true };
    }
    return { sessions: await scan(list, digests), refreshing: false };
  }

  /** 该源自己的文件定位；没配置时就是「不知道」，调用方按扫描的结果算。 */
  async function locateOne(adapter: SourceAdapter, conversationId: string): Promise<LocatedSessionFile | null> {
    const locate = deps.locateSessionFile;
    if (!locate) return null;
    return locate(adapter.descriptor.sourceId, conversationId).catch(() => null);
  }

  return {
    async available(input) {
      const sources = input.sourceIds?.length ? new Set(input.sourceIds) : null;
      const limit = Math.min(MAX_AVAILABLE_LIMIT, Math.max(1, Math.trunc(input.limit ?? DEFAULT_AVAILABLE_LIMIT)));
      const { sessions: all, refreshing } = await allSessions(input.fresh === true);
      const sessions = all.filter((session) => !sources || sources.has(session.sourceId));
      return {
        sessions: rankLocalSessions(sessions, { query: input.query?.trim() ?? "", cwd: input.cwd ?? null })
          .slice(0, limit)
          .map(toCandidate),
        refreshing
      };
    },

    async read(input) {
      const adapter = (await adapters()).find((item) => item.descriptor.sourceId === input.sourceId);
      if (!adapter) {
        throw new LocalSessionReadError("not_found", `Unknown agent source: ${input.sourceId}`);
      }
      // 先看索引怎么说：会话只留了压缩存档时，扫描永远读不到它，要把它解压出来单独读。
      const located = await locateOne(adapter, input.conversationId);
      if (located && stillArchived(located)) {
        const archived = await readArchive(adapter, input.conversationId, located);
        if (archived) return archived;
        throw new LocalSessionReadError("toolkit_unsupported", ARCHIVED_SESSION_TEXT);
      }
      const [session] = (await readSessions(adapter, [input.conversationId], sessionsPerSource)).sessions;
      if (!session) {
        throw new LocalSessionReadError("not_found", `Session not found: ${input.sourceId}/${input.conversationId}`);
      }
      return session;
    },

    async readMany(input) {
      const adapter = (await adapters()).find((item) => item.descriptor.sourceId === input.sourceId);
      if (!adapter) {
        throw new LocalSessionReadError("not_found", `Unknown agent source: ${input.sourceId}`);
      }
      const wanted = [...new Set(input.conversationIds)];
      if (wanted.length > MAX_READ_MANY) {
        throw new LocalSessionReadError("invalid_argument", `At most ${MAX_READ_MANY} sessions per read`);
      }
      // 索引说是压缩存档的那些不必进扫描（扫描永远读不到它们），按需逐个解压；解不开的才单列成读不出内容。
      const archived: string[] = [];
      const readable: string[] = [];
      const decompressed: LocalSession[] = [];
      for (const conversationId of wanted) {
        const located = await locateOne(adapter, conversationId);
        if (!located || !stillArchived(located)) {
          readable.push(conversationId);
          continue;
        }
        const session = await readArchive(adapter, conversationId, located);
        if (session) decompressed.push(session);
        else archived.push(conversationId);
      }
      const outcome = await readSessions(adapter, readable, sessionsPerSource);
      return { sessions: [...outcome.sessions, ...decompressed], missing: outcome.missing, archived };
    }
  };

  /** 解压一份存档并读出正文；解不开时给 null，由调用方按「读不出内容」告知用户。 */
  async function readArchive(
    adapter: SourceAdapter,
    conversationId: string,
    located: LocatedSessionFile
  ): Promise<LocalSession | null> {
    if (!canReadArchive(adapter.descriptor.sourceId)) return null;
    try {
      // 索引记着目录时按它归组：压缩文件里没有扫描路径那样现成的目录信息。
      return await readArchivedSession(adapter, createSessionGrouper(adapter), conversationId, located.path, located.workspacePath ?? null);
    } catch {
      return null;
    }
  }
}

/** How one listing reads the stores: through the metadata path, or the full scan it replaces. */
export interface ReadRecentSessionsOptions {
  /**
   * 走不走元数据路径。列表只要四个字段，读会话两端就够了；上传要正文，仍走完整扫描。
   * 关掉它就走原来的扫描路径，用于对照与兜底。
   */
  preferMetadata?: boolean;
}

/** Reads the most recent sessions of one source; a broken or missing source yields none. */
export async function readRecentSessions(
  adapter: SourceAdapter,
  limit: number,
  options: ReadRecentSessionsOptions = {}
): Promise<LocalSession[]> {
  try {
    if (!(await adapter.detect())) {
      return [];
    }
    if (options.preferMetadata !== false) {
      const listed = await readRecentSessionsFromMetadata(adapter, { limit, window: recentScanWindow(limit) });
      if (listed) {
        return listed;
      }
    }
    const grouper = createSessionGrouper(adapter);
    const window = recentScanWindow(limit);
    const builders = new Map<string, SessionBuilder>();
    for await (const message of adapter.scan({ order: "recent_first", maxScanTargets: window, maxConversations: window, fullHistory: true })) {
      let builder = builders.get(message.conversationId);
      if (!builder) {
        builder = { workspacePath: null, updatedAt: "", turns: [], nativeTitle: "" };
        builders.set(message.conversationId, builder);
      }
      appendMessage(builder, message);
    }
    const sessions = [...builders.entries()]
      .map(([conversationId, builder]) => finishSession(adapter, grouper, conversationId, builder))
      .filter((session): session is LocalSession => session !== null);
    // 扫描按最近优先返回，多出来的都是更早的任务。
    return sessions.slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * 一次读取用的窗口：就是原先逐级扩大能到达的最宽一档。
 *
 * <p>窗口按文件算而列表按任务算，空记录与后台派生的记录占窗口却不进列表，所以窗口要比 `limit` 大。
 * 原先的做法是扫一遍、凑不满就从零再扫一个更大的窗口，前一遍的结果全部作废——同一份存储被读了两三遍。
 * 现在只用最宽那一档扫一遍：会话按最近优先排列，更宽窗口的前若干个正是窄窗口能拿到的那些，
 * 而原先每一遍的结果本来就只有最后一遍会被返回，所以结果集合与顺序不变。</p>
 */
function recentScanWindow(limit: number): number {
  return Math.min(WIDE_SESSIONS_PER_SOURCE, limit * RECENT_SCAN_FACTORS[RECENT_SCAN_FACTORS.length - 1]!);
}

/**
 * Reads the requested conversations in one pass over the recent window, then one wider pass for any that are older.
 * Only requested conversations are built; the others in the window are skipped as they stream past.
 */
/**
 * Reads the given conversations: first those whose file is already known, then the rest by walking the recent window.
 *
 * @param locate Answers with a conversation's file when an index knows it; the file is then read on its own.
 */
async function readSessions(
  adapter: SourceAdapter,
  conversationIds: readonly string[],
  recentLimit: number
): Promise<LocalSessionBatch> {
  try {
    if (!(await adapter.detect())) {
      return { sessions: [], missing: [...conversationIds], archived: [] };
    }
    const grouper = createSessionGrouper(adapter);
    const found: LocalSession[] = [];
    let remaining = new Set(conversationIds);
    for (const limit of [recentLimit, WIDE_SESSIONS_PER_SOURCE]) {
      if (!remaining.size) break;
      const builders = new Map<string, SessionBuilder>();
      for await (const message of adapter.scan({ order: "recent_first", maxScanTargets: limit, maxConversations: limit, fullHistory: true })) {
        if (!remaining.has(message.conversationId)) {
          continue;
        }
        let builder = builders.get(message.conversationId);
        if (!builder) {
          builder = { workspacePath: null, updatedAt: "", turns: [], nativeTitle: "" };
          builders.set(message.conversationId, builder);
        }
        appendMessage(builder, message);
      }
      for (const [conversationId, builder] of builders) {
        const session = finishSession(adapter, grouper, conversationId, builder);
        if (session) found.push(session);
      }
      remaining = new Set([...remaining].filter((id) => !builders.has(id)));
    }
    return { sessions: found, missing: [...remaining], archived: [] };
  } catch {
    return { sessions: [], missing: [...conversationIds], archived: [] };
  }
}

function toCandidate(session: LocalSession): LocalSessionCandidate {
  return {
    sourceId: session.sourceId,
    agentName: session.agentName,
    conversationId: session.conversationId,
    title: session.title,
    lastQuestion: session.lastQuestion,
    workspacePath: session.workspacePath,
    group: session.group,
    updatedAt: session.updatedAt,
    turnCount: session.turns.length,
    ...(session.archived ? { archived: true } : {})
  };
}

