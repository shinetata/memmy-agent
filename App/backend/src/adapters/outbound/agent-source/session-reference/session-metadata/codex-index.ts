/**
 * Codex 的会话清单直接读它自己的索引库，而不是扫 `~/.codex/sessions` 下的会话文件。
 *
 * <p>Codex 把一个会话写完就压成 `rollout-*.jsonl.zst`，一台机器上绝大多数历史都是这种形式（本机 700 个
 * 文件里 696 个是压缩的），而压缩流不能随机读：为了列表里的一行标题与目录去解压几十兆不划算。索引库
 * `state_<N>.sqlite` 的 `threads` 表恰好有列表要的全部字段——标题、目录、最后活动时间、会话文件路径——
 * 一次查询就够，实测 100 行 1 ms、200 行 2 ms，与条数几乎无关。</p>
 *
 * <p>表里有几类不是人开的会话：`guardian_review` 是 Codex 自己的自动评审，`subagent` 是子 Agent 派生的
 * 记录（本机 740 行里合计 410 行）。它们和文件扫描里的过滤口径一致，都不出现在列表里。</p>
 *
 * <p>读不到索引（老版本没有这个库、库被占用、没有 `threads` 表）时返回 null，调用方回退到文件扫描：
 * 慢一点，但结果不会漏。</p>
 */
import { statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { isAbsolute, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SourceAdapter } from "@memmy/agent-source-readers/adapters/types";
import { createSessionGrouper } from "../session-group.js";
import { finishSession, type SessionBuilder } from "../session-shape.js";
import type { LocatedSessionFile, LocalSession } from "../local-session-reader.js";

/** 人自己开的会话：这三类（外加语音）以外都是 Codex 自己发起的记录。 */
const HUMAN_THREAD_SOURCES = ["user", "vscode", "automation", "realtime_voice"] as const;

/** 一次列表最多读多少行索引：真要用到 200 以上时再调，查询本身不是瓶颈。 */
const MAX_INDEX_ROWS = 500;

/** 索引库的名字是 `state_<版本号>.sqlite`，版本号大的更新。 */
const STATE_DATABASE = /^state_(\d+)\.sqlite$/iu;

interface ThreadRow {
  id: string;
  title: string;
  name: string;
  firstUserMessage: string;
  cwd: string | null;
  updatedAt: number | null;
  updatedAtMs: number | null;
  createdAt: number | null;
  rolloutPath: string | null;
}

interface OpenIndex {
  database: DatabaseSync;
  /** 这台 Codex 的 `threads` 表实际有哪些列：老版本的库少了后加的几列。 */
  columns: Set<string>;
}

/** 打开最新的索引库；没有可用库时返回 null。 */
async function openIndex(codexHome: string): Promise<OpenIndex | null> {
  let database: DatabaseSync;
  try {
    const file = await newestStateDatabase(codexHome);
    if (!file) return null;
    // 只读打开：绝不在用户的 Codex 库里写任何东西。
    database = new DatabaseSync(file, { readOnly: true });
  } catch {
    return null;
  }
  try {
    const columns = new Set(
      (database.prepare("PRAGMA table_info(threads)").all() as Array<{ name?: unknown }>)
        .map((row) => String(row.name ?? ""))
        .filter(Boolean)
    );
    if (!columns.has("id")) {
      database.close();
      return null;
    }
    return { database, columns };
  } catch {
    database.close();
    return null;
  }
}

/** `state_5.sqlite` 之类里版本号最大的那个；没有时 null。 */
async function newestStateDatabase(codexHome: string): Promise<string | null> {
  const entries = await readdir(codexHome).catch(() => [] as string[]);
  let best: { path: string; version: number } | null = null;
  for (const name of entries) {
    const version = Number(STATE_DATABASE.exec(name)?.[1] ?? Number.NaN);
    if (!Number.isFinite(version)) continue;
    if (!best || version > best.version) best = { path: join(codexHome, name), version };
  }
  return best?.path ?? null;
}

/** 按列是否存在拼一句 SELECT，老库少列时不报错。 */
function selectThreads(index: OpenIndex, limit: number): ThreadRow[] {
  const { database, columns } = index;
  const column = (name: string, fallback: string): string => (columns.has(name) ? `"${name}"` : fallback);
  const ordering = columns.has("updated_at") ? "updated_at" : columns.has("updated_at_ms") ? "updated_at_ms" : "created_at";
  const where: string[] = [];
  if (columns.has("archived")) where.push("COALESCE(archived, 0) = 0");
  if (columns.has("thread_source")) {
    // 老库里这一列可能为空，空的按人开的处理：宁可多列一条，也不要漏掉真任务。
    where.push(`COALESCE(thread_source, 'user') IN (${HUMAN_THREAD_SOURCES.map((value) => `'${value}'`).join(", ")})`);
  }
  const sql = `SELECT ${column("id", "''")} AS id,`
    + ` ${column("title", "''")} AS title,`
    + ` ${column("name", "NULL")} AS name,`
    + ` ${column("first_user_message", "''")} AS first_user_message,`
    + ` ${column("cwd", "NULL")} AS cwd,`
    + ` ${column("updated_at", "NULL")} AS updated_at,`
    + ` ${column("updated_at_ms", "NULL")} AS updated_at_ms,`
    + ` ${column("created_at", "NULL")} AS created_at,`
    + ` ${column("rollout_path", "NULL")} AS rollout_path`
    + " FROM threads"
    + (where.length ? ` WHERE ${where.join(" AND ")}` : "")
    + ` ORDER BY ${ordering} DESC LIMIT ?`;
  const rows = database.prepare(sql).all(Math.min(MAX_INDEX_ROWS, Math.max(1, limit))) as unknown as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: text(row.id) ?? "",
    title: text(row.title) ?? "",
    name: text(row.name) ?? "",
    firstUserMessage: text(row.first_user_message) ?? "",
    cwd: text(row.cwd),
    updatedAt: number(row.updated_at),
    updatedAtMs: number(row.updated_at_ms),
    createdAt: number(row.created_at),
    rolloutPath: text(row.rollout_path)
  })).filter((row) => row.id);
}

/**
 * 本机 Codex 的会话清单，按最后活动时间倒序。
 *
 * <p>只列会话文件还在的那些：文件被归档或删掉之后，列表里留着一条点开就失败，不如不列。这一层探测只对
 * 取出的这一页做（每行一次 stat），不影响查询本身。</p>
 *
 * @returns 会话清单；读不到索引库时为 null，调用方回退到文件扫描。
 */
export async function listCodexIndexSessions(adapter: SourceAdapter, limit: number): Promise<LocalSession[] | null> {
  const sessionsRoot = adapter.descriptor.dataPath;
  const codexHome = dirname(sessionsRoot);
  const index = await openIndex(codexHome);
  if (!index) return null;
  try {
    const rows = selectThreads(index, limit);
    const codexHome = dirname(sessionsRoot);
    const grouper = createSessionGrouper(adapter);
    const sessions: LocalSession[] = [];
    for (const row of rows) {
      if (sessions.length >= limit) break;
      const file = existingSessionFile(codexHome, sessionsRoot, row.rolloutPath);
      if (!file) continue;
      const updatedAt = isoTime(row.updatedAtMs, row.updatedAt);
      // Codex 自己起过名的会话用它的名字（`name`，也就是侧栏里看到的标题）；没起过名的用它记录的首句。
      const typed = oneLine(row.firstUserMessage) || oneLine(row.title);
      const named = oneLine(row.name);
      const question = typed || named;
      if (!question) continue;
      const builder: SessionBuilder = {
        workspacePath: row.cwd,
        updatedAt,
        turns: [{ question, reply: "", steps: [], startedAt: isoTime(row.createdAt === null ? null : row.createdAt * 1000, row.createdAt) }],
        nativeTitle: named || typed
      };
      const session = finishSession(adapter, grouper, row.id, builder);
      // 只有压缩存档的会话列出来，但标成不能关联：正文在存档里读不出来。
      if (session) sessions.push(file.archived ? { ...session, archived: true } : session);
    }
    return sessions;
  } catch {
    return null;
  } finally {
    index.database.close();
  }
}

/**
 * 某个会话的会话文件，以及它是不是压缩存档。
 *
 * <p>索引记的是 `.jsonl`，而 Codex 写完之后把它压成 `.jsonl.zst` 并删掉原文件。压缩的读不出正文，所以这里
 * 把「有文件、但只有存档」单独报出来，调用方才能告诉用户原因，而不是当成任务不存在。</p>
 */
export async function codexSessionFileFor(adapter: SourceAdapter, conversationId: string): Promise<LocatedSessionFile | null> {
  if (!conversationId.trim()) return null;
  const sessionsRoot = adapter.descriptor.dataPath;
  const codexHome = dirname(sessionsRoot);
  const index = await openIndex(codexHome);
  if (!index) return null;
  try {
    if (!index.columns.has("rollout_path")) return null;
    const row = index.database.prepare("SELECT rollout_path FROM threads WHERE id = ? LIMIT 1").get(conversationId) as
      | { rollout_path?: unknown }
      | undefined;
    return existingSessionFile(codexHome, sessionsRoot, text(row?.rollout_path));
  } catch {
    return null;
  } finally {
    index.database.close();
  }
}

/**
 * 会话文件在磁盘上的那一份：先压好的，再原样明文。
 *
 * <p>索引记的路径通常是绝对路径；万一存的是相对的，先按 Codex 的根目录解释（`sessions/...`），再按
 * `sessions` 目录解释。Windows 上两边都由 `path` API 拼接，不吃分隔符的亏。</p>
 */
function existingSessionFile(codexHome: string, sessionsRoot: string, recordedPath: string | null): LocatedSessionFile | null {
  if (!recordedPath) {
    // 索引里没有路径（老库）时按 Codex 自己的文件名规律找不到，只能交给调用方回退。
    return null;
  }
  const bases = isAbsolute(recordedPath) ? [recordedPath] : [resolve(codexHome, recordedPath), resolve(sessionsRoot, recordedPath)];
  for (const base of bases) {
    // 明文优先：Codex 重新打开过一个旧会话时，最新内容是那份新写下的明文。
    for (const [candidate, archived] of [[`${base}.zst`, true], [`${base}.zstd`, true], [base, false]] as const) {
      try {
        if (statSync(candidate).isFile()) return { path: candidate, archived };
      } catch {
        // 试下一个后缀与下一个基准目录。
      }
    }
  }
  return null;
}

/** 秒或毫秒的时间戳写成 ISO；两个都没有时给空串，让 `finishSession` 按没有时间处理。 */
function isoTime(ms: number | null, seconds: number | null): string {
  const value = ms ?? (seconds === null ? null : seconds * 1000);
  if (value === null || !Number.isFinite(value) || value <= 0) return "";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function number(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}
