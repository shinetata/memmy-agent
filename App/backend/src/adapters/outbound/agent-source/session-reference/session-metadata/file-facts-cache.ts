/**
 * 列表扫描的缓存：打开一次弹窗、每分钟一次同步，都不必把同一批文件从头再读一遍。
 *
 * <p>列表要的字段（标题、最后一句提问、目录、最后活动时间）都从会话文件的正文里来，而会话文件只会被追加。
 * 缓存按「文件 + 上次读到的大小与 mtime」记下算出来的结论：文件没变就直接用，变长了只读新追加的那一段，
 * 变小或改了内容才重读。本机 Claude Code 的历史合计 760MB，全文读一遍约 3 秒；命中缓存之后是几次 stat。</p>
 *
 * <p>标题还要单独一份：Claude Code 与 WorkBuddy 把标题写在会话文件末尾的一段记录里，读它要翻最多 1MB，
 * 而它与会话正文的结论一样只在文件变化时才可能变。</p>
 *
 * <p>只在内存里，进程重启就没了：重读一遍的代价与现在一样，不需要落盘，也不必担心磁盘上的旧结论与本机
 * 真实文件不一致。</p>
 */
import { resolve } from "node:path";
import type { FileFacts } from "./jsonl-facts.js";

/** 一份文件的结论，以及它对应的文件状态。 */
export interface FileFactsEntry {
  /** 读到的事实结束在文件第几个字节；下次从这里往后读。 */
  offset: number;
  size: number;
  mtimeMs: number;
  facts: FileFacts;
}

/** 一份文件里读出来的标题，以及它对应的文件状态。 */
export interface FileTitleEntry {
  size: number;
  mtimeMs: number;
  title: string | null;
}

export interface FileFactsCache {
  get(filePath: string): FileFactsEntry | undefined;
  set(filePath: string, entry: FileFactsEntry): void;
  /** 主动作废一份（文件变小、读失败）。 */
  delete(filePath: string): void;
  size(): number;
}

export interface FileTitleCache {
  get(filePath: string): FileTitleEntry | undefined;
  set(filePath: string, entry: FileTitleEntry): void;
  delete(filePath: string): void;
  size(): number;
}

/** 一次扫描用到的两份缓存；同一线程上的重复扫描共用一份。 */
export interface SessionScanCaches {
  facts: FileFactsCache;
  titles: FileTitleCache;
}

/**
 * 有上限的缓存。
 *
 * <p>本机各 Agent 的会话文件合计两三千个，每个条目只存几问与几个时间，几百 KB 量级。超出上限时丢最早
 * 写入的那一条：这些文件在列表里的顺序本来就按最近活动，最久没被读到的正好是最不需要留的。</p>
 */
function boundedMap<T>(maxEntries: number): {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  delete(key: string): void;
  size(): number;
} {
  const entries = new Map<string, T>();
  return {
    get(key) {
      return entries.get(resolve(key));
    },
    set(key, value) {
      const normalized = resolve(key);
      // 重新写入要排到队尾：LRU 的「最近用过」由写入顺序表达，读命中不重排，免得每次列表都改一遍 Map。
      entries.delete(normalized);
      entries.set(normalized, value);
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
    },
    delete(key) {
      entries.delete(resolve(key));
    },
    size() {
      return entries.size;
    }
  };
}

export function createFileFactsCache(maxEntries = 4_000): FileFactsCache {
  return boundedMap<FileFactsEntry>(maxEntries);
}

export function createFileTitleCache(maxEntries = 4_000): FileTitleCache {
  return boundedMap<FileTitleEntry>(maxEntries);
}

export function createSessionScanCaches(): SessionScanCaches {
  return { facts: createFileFactsCache(), titles: createFileTitleCache() };
}
