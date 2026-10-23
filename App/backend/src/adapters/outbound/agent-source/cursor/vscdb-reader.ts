/** Vscdb reader module. */
import { DatabaseSync } from "node:sqlite";
import {
  readCursorComposer,
  type CursorVscdbSource,
  type RawSourceMessage
} from "@memmy/agent-source-core";

/** Contract for raw cursor message. */
export type RawCursorMessage = RawSourceMessage;

/**
 * Reads Cursor conversations as staged native turns. The hook reads the same rows through
 * the same shared parser, so both channels resolve one turn to one identity.
 */
export async function* readCursorVscdb(path: string, signal?: AbortSignal): AsyncIterable<RawCursorMessage> {
  yield* streamCursorVscdb(path, signal);
}

/** Streams without materialising a database-wide message array; `recentLimit` keeps the most recently updated chats. */
export async function* streamCursorVscdb(
  path: string,
  signal?: AbortSignal,
  recentLimit?: number
): AsyncIterable<RawCursorMessage> {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    yield* readComposers(createSource(db, recentLimit), signal);
  } finally {
    db.close();
  }
}

async function* readComposers(source: CursorVscdbSource | null, signal?: AbortSignal): AsyncIterable<RawCursorMessage> {
  if (!source) return;
  for (const composerId of source.mainComposerIds()) {
    signal?.throwIfAborted();
    // Cursor names a chat in its composer data; that name is what the chat list shows.
    const sessionTitle = composerTitle(source.composerData(composerId));
    for await (const message of readCursorComposer(source, composerId, signal)) {
      yield sessionTitle ? { ...message, sessionTitle } : message;
    }
  }
}

/** `composerData.name` holds the generated chat name; it is blank until Cursor has named the chat. */
function composerTitle(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const name = (data as { name?: unknown }).name;
  if (typeof name !== "string") return null;
  const title = name.replace(/\s+/gu, " ").trim();
  return title.length > 0 ? title : null;
}

/** A workspace database without the chat tables is not a conversation store. */
function createSource(db: DatabaseSync, recentLimit?: number): CursorVscdbSource | null {
  if (!hasTable(db, "composerHeaders") || !hasTable(db, "cursorDiskKV")) return null;
  const mainComposerQuery = "SELECT composerId FROM composerHeaders WHERE isSubagent = 0 AND composerId IS NOT NULL";
  const mainComposers = recentLimit === undefined
    ? db.prepare(mainComposerQuery)
    : db.prepare(`${mainComposerQuery} ORDER BY lastUpdatedAt DESC LIMIT ${Math.max(1, Math.trunc(recentLimit))}`);
  const diskValue = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?");
  const parse = (key: string): unknown => {
    const row = diskValue.get(key) as { value?: unknown } | undefined;
    if (typeof row?.value !== "string") return undefined;
    try {
      return JSON.parse(row.value);
    } catch {
      return undefined;
    }
  };
  return {
    mainComposerIds: () => (mainComposers.all() as Array<{ composerId: string }>).map((row) => row.composerId),
    composerData: (composerId) => parse(`composerData:${composerId}`),
    bubble: (composerId, bubbleId) => parse(`bubbleId:${composerId}:${bubbleId}`)
  };
}

function hasTable(db: DatabaseSync, tableName: string): boolean {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));
}
