/**
 * Reads a session whose only surviving copy is the agent's compressed archive.
 *
 * <p>Codex compresses a rollout into `rollout-*.jsonl.zst` once it has been idle for a week, and keeps only that
 * file. The scan path never sees it (discovery lists `.jsonl`), so a listing can name the task but not read it.
 * Association only needs the ones a person actually picked, so the file is decompressed here, at read time: a few
 * milliseconds for a typical session and well under a second for the largest one on this machine.</p>
 *
 * <p>The archive is written to a temp file under its plain name and parsed by the agent's own rollout reader, so a
 * session reads exactly the same way whether it was compressed or not. The temp file never touches the agent's
 * store: a plain file written beside the archive would hide it from Codex and change what that agent sees.</p>
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { decompress } from "fzstd";
import { readCodexRollout } from "@memmy/agent-source-readers/adapters/codex/rollout-reader";
import { redactSecrets } from "@memmy/agent-source-readers/adapters/secret-redactor";
import type { ConversationMessage, SourceAdapter } from "@memmy/agent-source-readers/adapters/types";
import { appendMessage, finishSession, type SessionBuilder } from "./session-shape.js";
import type { SessionGrouper } from "./session-group.js";
import type { LocalSession } from "./local-session-reader.js";

/** Sources whose archives this reader can decompress; only Codex compresses its store today. */
const ARCHIVED_SOURCES = new Set(["codex"]);

/** Whether an archive of this source can be read back at all. */
export function canReadArchive(sourceId: string): boolean {
  return ARCHIVED_SOURCES.has(sourceId);
}

/**
 * Reads one compressed session file and returns it as a normal session.
 *
 * @throws when the archive cannot be decompressed or holds nothing a person asked, so the caller can fall back to
 * telling the user its content is unreadable rather than pretending the task is gone.
 */
export async function readArchivedSession(
  adapter: SourceAdapter,
  grouper: SessionGrouper,
  conversationId: string,
  filePath: string,
  workspacePath: string | null = null
): Promise<LocalSession> {
  if (!canReadArchive(adapter.descriptor.sourceId)) {
    throw new Error(`Cannot read an archived session of ${adapter.descriptor.sourceId}`);
  }
  const workingDirectory = await mkdtemp(join(tmpdir(), "memmy-archive-"));
  try {
    // 文件名就是会话的 id 来源之一：保留去掉压缩后缀的原名，解析器才能把它当成同一份会话。
    const plainPath = join(workingDirectory, basename(filePath).replace(/\.(?:zst|zstd)$/iu, ""));
    await writeFile(plainPath, decompress(await readFile(filePath)));
    const builder: SessionBuilder = { workspacePath, updatedAt: "", turns: [], nativeTitle: "" };
    for await (const message of readCodexRollout(plainPath)) {
      appendMessage(builder, toConversationMessage(adapter, message));
    }
    const session = finishSession(adapter, grouper, conversationId, builder);
    if (!session) {
      throw new Error(`Archived session holds no question: ${conversationId}`);
    }
    return session;
  } finally {
    await rm(workingDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** What the scan path would have emitted for the same row, so both paths feed the same builder rules. */
function toConversationMessage(adapter: SourceAdapter, message: {
  messageId: string;
  conversationId: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  createdAt: string;
  ordinal: number;
  rawMeta: Readonly<Record<string, unknown>>;
  sessionTitle?: string;
}): ConversationMessage {
  return {
    messageId: message.messageId,
    sourceId: adapter.descriptor.sourceId,
    conversationId: message.conversationId,
    role: message.role,
    content: redactSecrets(message.content),
    createdAt: message.createdAt,
    workspacePath: null,
    gitRoot: null,
    ordinal: message.ordinal,
    rawMeta: message.rawMeta,
    ...(message.sessionTitle ? { sessionTitle: message.sessionTitle } : {})
  };
}
