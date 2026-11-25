/**
 * Lists local sessions from their stores' metadata instead of from every message they hold.
 *
 * <p>The association picker shows a title, the last question, the directory and a time. Reading a session whole to
 * fill those four fields costs seconds per agent, because an agent's history is mostly tool output. Each source that
 * can answer from the ends of its store does so here; the rest, and anything this path cannot read, keeps the scan
 * path in local-session-reader, which stays the source of truth every field is compared against.</p>
 */
import type { SourceAdapter } from "@memmy/agent-source-readers/adapters/types";
import type { LocalSession } from "../local-session-reader.js";
import { listCodexIndexSessions } from "./codex-index.js";
import { listCursorSessions, planCursorSessions } from "./cursor-facts.js";
import { createSessionScanCaches, type SessionScanCaches } from "./file-facts-cache.js";
import { listJsonlSessions } from "./jsonl-facts.js";
import { planJsonlSessions } from "./jsonl-sources.js";

/** How wide the recent window is, in files, as the scan path computes it. */
export interface MetadataListOptions {
  limit: number;
  /** Files one source may look at, from `recentScanWindow`. */
  window: number;
  /** 上次扫描的结论；不传时用本线程共享的那一份。 */
  cache?: SessionScanCaches;
}

/**
 * 本线程共享的文件事实缓存。
 *
 * <p>同一份文件会被反复列出（一分钟一次的同步、每次打开弹窗），而它只会被追加。缓存放在这里而不是调用方，
 * 是因为工作线程也要用：扫描实际发生在那里，每个线程各自一份，互不影响。</p>
 */
const sharedCaches = createSessionScanCaches();

/**
 * The most recent sessions of one source, read from its store's metadata.
 *
 * @returns The sessions, or `null` when this source has no metadata path or it could not read the store.
 */
export async function readRecentSessionsFromMetadata(adapter: SourceAdapter, options: MetadataListOptions): Promise<LocalSession[] | null> {
  try {
    // Codex 的索引库一次查询就有全部字段，不必读会话文件；读不到时下面照旧走文件扫描。
    const indexed = adapter.descriptor.sourceId === "codex"
      ? await listCodexIndexSessions(adapter, options.limit)
      : null;
    if (indexed) {
      return indexed;
    }
    const caches = options.cache ?? sharedCaches;
    const jsonl = await planJsonlSessions(adapter, options.window, caches.titles);
    if (jsonl && jsonl.files.length) {
      const listed = await listJsonlSessions(adapter, jsonl.source, jsonl.files, options.limit, caches.facts);
      // 一个会话也没读出来，可能是这份存储的格式对不上：交给完整扫描，宁可慢也不漏。
      if (listed.length) {
        return listed;
      }
    }
    const cursor = await planCursorSessions(adapter, options.window);
    if (cursor) {
      return await listCursorSessions(adapter, cursor, options);
    }
    return null;
  } catch {
    // 读不出来就交给完整扫描：这条路慢，但结果一定对。
    return null;
  }
}