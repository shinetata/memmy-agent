/**
 * 本机会话索引：把各 Agent 的会话元数据（标题、最近提问、时间、轮数）落到一个本地文件里，
 * 让检索变成查表，而不是每次现扫。
 *
 * 默认只索引每个 Agent 最近的若干会话；全量索引需要显式触发，在后台跑。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SourceRegistry } from '../adapters/source-registry.js';
import type { SourceAdapter } from '../adapters/types.js';
import { readRecentSessions, type LocalSession, type LocalSessionCandidate } from './local-session-reference.js';
import { rankLocalSessions } from './local-session-rank.js';

const INDEX_VERSION = 1;
/** 默认索引规模：每个 Agent 最近的会话数。实测全部 Agent 合起来约 2 秒。 */
export const DEFAULT_INDEX_PER_AGENT = 30;
/** 全量索引时单个 Agent 的会话上限，防止异常数据把内存吃满。 */
const FULL_INDEX_MAX_PER_AGENT = 20_000;

/** 索引里的一条会话。 */
export interface IndexedSession {
  sourceId: string;
  agentName: string;
  conversationId: string;
  title: string;
  lastQuestion: string;
  workspacePath: string | null;
  updatedAt: string;
  turnCount: number;
  indexedAt: string;
}

/** 索引的对外状态，供界面显示进度。 */
export interface LocalSessionIndexStatus {
  state: 'idle' | 'running' | 'failed';
  mode: 'recent' | 'full' | null;
  /** 已完成扫描的 Agent 数 / 总数，仅在 running 时有意义。 */
  agentsDone: number;
  agentsTotal: number;
  /** 已写入索引的会话数。 */
  sessions: number;
  updatedAt: string | null;
  startedAt: string | null;
  error: string | null;
}

interface IndexFile {
  version: number;
  updatedAt: string;
  sessions: IndexedSession[];
}

export interface LocalSessionIndex {
  /** 查索引；cwd 给定时优先同目录的会话。 */
  search(input: { query?: string; cwd?: string | null; sourceIds?: readonly string[]; limit?: number }): Promise<{
    sessions: LocalSessionCandidate[];
    status: LocalSessionIndexStatus;
  }>;
  /** 刷新每个 Agent 的最近会话；已有条目按会话 ID 覆盖。 */
  refreshRecent(): Promise<void>;
  /** 全量重建：把各 Agent 的全部会话读一遍，可以在后台跑。 */
  startFullIndex(): 'started' | 'running';
  status(): LocalSessionIndexStatus;
  /** 启动时调用：索引缺失就建一次最小索引，不阻塞服务启动。 */
  warmUp(): void;
}

export interface CreateLocalSessionIndexDeps {
  filePath: string;
  registry: SourceRegistry;
  perAgent?: number;
  now?: () => string;
}

/** 创建本机会话索引。 */
export function createLocalSessionIndex(deps: CreateLocalSessionIndexDeps): LocalSessionIndex {
  const perAgent = deps.perAgent ?? DEFAULT_INDEX_PER_AGENT;
  const now = deps.now ?? (() => new Date().toISOString());
  let sessions: Map<string, IndexedSession> | null = null;
  let updatedAt: string | null = null;
  let status: LocalSessionIndexStatus = {
    state: 'idle',
    mode: null,
    agentsDone: 0,
    agentsTotal: 0,
    sessions: 0,
    updatedAt: null,
    startedAt: null,
    error: null
  };
  let running: Promise<void> | null = null;

  function keyOf(sourceId: string, conversationId: string): string {
    return `${sourceId}/${conversationId}`;
  }

  async function load(): Promise<Map<string, IndexedSession>> {
    if (sessions) {
      return sessions;
    }
    try {
      const parsed = JSON.parse(await readFile(deps.filePath, 'utf8')) as Partial<IndexFile>;
      const list = Array.isArray(parsed.sessions) ? parsed.sessions : [];
      sessions = new Map(list.map((item) => [keyOf(item.sourceId, item.conversationId), item]));
      updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null;
    } catch {
      sessions = new Map();
      updatedAt = null;
    }
    status = { ...status, sessions: sessions.size, updatedAt };
    return sessions;
  }

  /** 标题重复时补上日期，避免列表里一串完全一样的条目。 */
  function disambiguateTitles(map: Map<string, IndexedSession>): void {
    const byTitle = new Map<string, IndexedSession[]>();
    for (const session of map.values()) {
      byTitle.set(session.title, [...(byTitle.get(session.title) ?? []), session]);
    }
    for (const [title, group] of byTitle) {
      if (group.length < 2 || title.includes(' · ')) continue;
      for (const session of group) {
        const time = Date.parse(session.updatedAt);
        if (Number.isNaN(time)) continue;
        const date = new Date(time);
        session.title = `${title} · ${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
      }
    }
  }

  async function persist(): Promise<void> {
    const map = await load();
    disambiguateTitles(map);
    const file: IndexFile = {
      version: INDEX_VERSION,
      updatedAt: now(),
      sessions: [...map.values()]
    };
    await mkdir(dirname(deps.filePath), { recursive: true });
    const temporary = `${deps.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(file)}\n`, 'utf8');
    await rename(temporary, deps.filePath);
    updatedAt = file.updatedAt;
    status = { ...status, sessions: map.size, updatedAt };
  }

  /** 把一次扫描结果写进索引；同一个会话只保留最新一份。 */
  function merge(target: Map<string, IndexedSession>, scanned: LocalSession[]): number {
    const at = now();
    for (const session of scanned) {
      target.set(keyOf(session.sourceId, session.conversationId), {
        sourceId: session.sourceId,
        agentName: session.agentName,
        conversationId: session.conversationId,
        title: session.title,
        lastQuestion: session.lastQuestion,
        workspacePath: session.workspacePath,
        updatedAt: session.updatedAt,
        turnCount: session.turns.length,
        indexedAt: at
      });
    }
    return scanned.length;
  }

  async function scanAdapters(limit: number, onAgent?: (adapter: SourceAdapter, index: number) => void): Promise<number> {
    const adapters = deps.registry.list();
    const map = await load();
    let total = 0;
    let index = 0;
    for (const adapter of adapters) {
      index += 1;
      onAgent?.(adapter, index);
      const scanned = await readRecentSessions(adapter, limit);
      total += merge(map, scanned);
    }
    return total;
  }

  function serialize(session: IndexedSession): LocalSession {
    const questions = [session.lastQuestion, session.title].filter((text) => text.trim().length > 0);
    return {
      sourceId: session.sourceId,
      agentName: session.agentName,
      conversationId: session.conversationId,
      title: session.title,
      lastQuestion: session.lastQuestion,
      workspacePath: session.workspacePath,
      updatedAt: session.updatedAt,
      turns: questions.map((question) => ({ question, reply: '', steps: [], startedAt: session.updatedAt }))
    };
  }

  return {
    async search(input) {
      const map = await load();
      const sources = input.sourceIds?.length ? new Set(input.sourceIds) : null;
      const pool = [...map.values()]
        .filter((session) => !sources || sources.has(session.sourceId))
        .map(serialize);
      // 允许一次取回全部元数据：浮窗在本地做过滤，切 Agent 不必再请求。
      const limit = Math.min(5000, Math.max(1, Math.trunc(input.limit ?? 30)));
      const ranked = rankLocalSessions(pool, { query: input.query?.trim() ?? '', cwd: input.cwd ?? null })
        .slice(0, limit)
        .map((session) => ({
          sourceId: session.sourceId,
          agentName: session.agentName,
          conversationId: session.conversationId,
          title: session.title,
          lastQuestion: session.lastQuestion,
          workspacePath: session.workspacePath,
          updatedAt: session.updatedAt,
          turnCount: session.turns.length
        }));
      return { sessions: ranked, status: this.status() };
    },

    async refreshRecent() {
      if (running) {
        return running;
      }
      running = (async () => {
        status = { ...status, state: 'running', mode: 'recent', startedAt: now(), error: null, agentsDone: 0 };
        try {
          await scanAdapters(perAgent, (_adapter, index) => {
            status = { ...status, agentsDone: index, agentsTotal: deps.registry.list().length };
          });
          await persist();
          status = { ...status, state: 'idle', mode: null, agentsDone: 0, finishedAt: undefined } as LocalSessionIndexStatus;
        } catch (error) {
          status = { ...status, state: 'failed', mode: null, error: String(error) };
        } finally {
          running = null;
        }
      })();
      return running;
    },

    startFullIndex() {
      if (running) {
        return 'running';
      }
      const adapters = deps.registry.list();
      running = (async () => {
        status = {
          ...status,
          state: 'running',
          mode: 'full',
          startedAt: now(),
          error: null,
          agentsDone: 0,
          agentsTotal: adapters.length
        };
        try {
          const rebuilt = new Map<string, IndexedSession>();
          let index = 0;
          for (const adapter of adapters) {
            index += 1;
            const scanned = await readRecentSessions(adapter, FULL_INDEX_MAX_PER_AGENT);
            merge(rebuilt, scanned);
            status = { ...status, agentsDone: index, sessions: rebuilt.size };
            // 每个 Agent 之间让出事件循环：扫描是同步读库，不让路会卡住检索请求。
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
          sessions = rebuilt;
          await persist();
          status = { ...status, state: 'idle', mode: null, agentsDone: 0 };
        } catch (error) {
          status = { ...status, state: 'failed', mode: null, error: String(error) };
        } finally {
          running = null;
        }
      })();
      return 'started';
    },

    status() {
      return { ...status, sessions: sessions?.size ?? status.sessions, updatedAt };
    },

    warmUp() {
      void (async () => {
        const map = await load();
        if (map.size === 0) {
          await this.refreshRecent();
        }
      })();
    }
  };
}
