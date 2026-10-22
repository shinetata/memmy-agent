/**
 * Local session reference module. Lists the sessions a local project may reference and renders one
 * into a Markdown file an agent can read. Candidates come from the project's associations only, so a
 * reference never exposes a session the person did not put in the project.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { MemoryServiceError } from "../../utils/error.js";
import type { SourceRegistry } from "../adapters/source-registry.js";
import type { ConversationMessage, SourceAdapter } from "../adapters/types.js";
import { renderLocalSessionMarkdown } from "./local-session-markdown.js";
import type { LocalProject, LocalProjectSession, LocalProjectStore } from "./local-project-store.js";
import { rankLocalSessions } from "./local-session-rank.js";

const DEFAULT_SESSIONS_PER_SOURCE = 30;
/** A wider window used only when an associated session is older than the recent list. */
const WIDE_SESSIONS_PER_SOURCE = 200;
const DEFAULT_SNAPSHOT_TTL_MS = 15_000;
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 20;
const TITLE_MAX_CHARS = 40;

/** One question and everything the agent did until the next question. */
export interface LocalSessionTurn {
  question: string;
  reply: string;
  steps: string[];
  startedAt: string;
}

/** A local agent session reduced to what a reference needs. */
export interface LocalSession {
  sourceId: string;
  agentName: string;
  conversationId: string;
  title: string;
  lastQuestion: string;
  workspacePath: string | null;
  updatedAt: string;
  turns: LocalSessionTurn[];
}

/** Contract for local session candidate. */
export interface LocalSessionCandidate {
  sourceId: string;
  agentName: string;
  conversationId: string;
  title: string;
  lastQuestion: string;
  workspacePath: string | null;
  updatedAt: string;
  turnCount: number;
}

/** Contract for local session search input. */
export interface LocalSessionSearchInput {
  query?: string;
  /** Working directory of the asking conversation; the project containing it scopes the candidates. */
  cwd?: string | null;
  /** Only sessions of these agents, e.g. ["workbuddy"]; all agents when absent. */
  sourceIds?: readonly string[];
  excludeConversationIds?: readonly string[];
  limit?: number;
}

/** Why a search returned nothing, so the caller can tell "nothing related" from "nothing associated". */
export type LocalSessionSearchReason = "no_project" | "no_association" | "no_match";

/** Contract for local session search result. */
export interface LocalSessionSearchResult {
  sessions: LocalSessionCandidate[];
  /** The local project the asking directory belongs to, when there is one. */
  project: { id: string; name: string; rootPath: string } | null;
  reason?: LocalSessionSearchReason;
}

/** Contract for the candidate pool the association picker chooses from. */
export interface LocalSessionAvailableInput {
  query?: string;
  cwd?: string | null;
  sourceIds?: readonly string[];
  excludeConversationIds?: readonly string[];
  limit?: number;
}

/** Contract for local session reference. */
export interface LocalSessionReference extends LocalSessionCandidate {
  path: string;
  markdown: string;
}

/** Contract for local session reference service. */
export interface LocalSessionReferenceService {
  /** Associated sessions only: what `/memmy-ref` and the Memmy mention list may offer. */
  search(input: LocalSessionSearchInput): Promise<LocalSessionSearchResult>;
  /** Live scan of the agents' own stores: the pool an association picks from. Not referenceable as-is. */
  available(input: LocalSessionAvailableInput): Promise<LocalSessionCandidate[]>;
  /** Reads one session so an association can snapshot its title and last activity without a full scan. */
  describe(input: { sourceId: string; conversationId: string }): Promise<LocalSessionCandidate>;
  reference(input: { sourceId: string; conversationId: string }): Promise<LocalSessionReference>;
}

export interface CreateLocalSessionReferenceServiceDeps {
  registry: SourceRegistry;
  projects: LocalProjectStore;
  /** Directory for rendered reference files. Never a project directory. */
  cacheDir?: string;
  sessionsPerSource?: number;
  snapshotTtlMs?: number;
  now?: () => number;
}

/** Resolves the directory that holds rendered reference files. */
export function defaultLocalSessionReferenceDir(): string {
  return join(process.env.MEMMY_HOME?.trim() || join(homedir(), ".memmy"), "session-references", "local");
}

/** Creates the local session reference service. */
export function createLocalSessionReferenceService(deps: CreateLocalSessionReferenceServiceDeps): LocalSessionReferenceService {
  const cacheDir = deps.cacheDir ?? defaultLocalSessionReferenceDir();
  const sessionsPerSource = deps.sessionsPerSource ?? DEFAULT_SESSIONS_PER_SOURCE;
  const snapshotTtlMs = deps.snapshotTtlMs ?? DEFAULT_SNAPSHOT_TTL_MS;
  const now = deps.now ?? Date.now;
  let snapshot: { loadedAt: number; sessions: LocalSession[] } | null = null;
  let loading: Promise<LocalSession[]> | null = null;

  /** Live reads of the agents' stores, shared by every request inside the time to live. */
  async function allSessions(): Promise<LocalSession[]> {
    if (snapshot && now() - snapshot.loadedAt < snapshotTtlMs) {
      return snapshot.sessions;
    }
    loading ??= Promise.all(deps.registry.list().map((adapter) => readRecentSessions(adapter, sessionsPerSource)))
      .then((perSource) => {
        const sessions = perSource.flat();
        snapshot = { loadedAt: now(), sessions };
        return sessions;
      })
      .finally(() => {
        loading = null;
      });
    return loading;
  }

  return {
    async search(input) {
      const project = input.cwd ? await deps.projects.findByPath(input.cwd) : null;
      // A conversation that reports a directory must live in a project for anything to be offered;
      // only a caller with no directory (the Memmy mention list) sees every project's associations.
      const owners = project ? [project] : input.cwd ? [] : await deps.projects.list();
      const excluded = new Set(input.excludeConversationIds ?? []);
      const sources = input.sourceIds?.length ? new Set(input.sourceIds) : null;
      const limit = Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.trunc(input.limit ?? DEFAULT_SEARCH_LIMIT)));
      const candidates = owners
        .flatMap((owner) => owner.sessions.map((session) => fromSnapshot(owner, session)))
        .filter((session) => !excluded.has(session.conversationId) && (!sources || sources.has(session.sourceId)));
      const sessions = rankLocalSessions(candidates, { query: input.query?.trim() ?? "", cwd: input.cwd ?? null })
        .slice(0, limit)
        .map(toCandidate);
      // Three empty cases mean different things to the person, so the caller can say which to fix:
      // no project for this directory, a project with nothing linked, or keywords that matched nothing.
      const associated = owners.reduce((total, owner) => total + owner.sessions.length, 0);
      const reason: LocalSessionSearchReason | undefined = sessions.length > 0
        ? undefined
        : input.cwd && !project
          ? "no_project"
          : associated === 0
            ? "no_association"
            : "no_match";
      return {
        sessions,
        project: project ? { id: project.id, name: project.name, rootPath: project.rootPath } : null,
        ...(reason === undefined ? {} : { reason })
      };
    },

    async available(input) {
      const excluded = new Set(input.excludeConversationIds ?? []);
      const sources = input.sourceIds?.length ? new Set(input.sourceIds) : null;
      const limit = Math.min(MAX_SEARCH_LIMIT * 10, Math.max(1, Math.trunc(input.limit ?? DEFAULT_SEARCH_LIMIT)));
      const sessions = (await allSessions()).filter((session) =>
        !excluded.has(session.conversationId) && (!sources || sources.has(session.sourceId)));
      return rankLocalSessions(sessions, { query: input.query?.trim() ?? "", cwd: input.cwd ?? null })
        .slice(0, limit)
        .map(toCandidate);
    },

    async describe(input) {
      const adapter = deps.registry.get(input.sourceId);
      if (!adapter) {
        throw new MemoryServiceError("not_found", `Unknown agent source: ${input.sourceId}`);
      }
      const session = await readOneSession(adapter, input.conversationId, sessionsPerSource);
      if (!session) {
        throw new MemoryServiceError("not_found", `Session not found: ${input.sourceId}/${input.conversationId}`);
      }
      return toCandidate(session);
    },

    async reference(input) {
      const adapter = deps.registry.get(input.sourceId);
      if (!adapter) {
        throw new MemoryServiceError("not_found", `Unknown agent source: ${input.sourceId}`);
      }
      const owners = (await deps.projects.list())
        .filter((project) => project.sessions.some((session) => sameKey(session, input)));
      if (!owners.length) {
        throw new MemoryServiceError(
          "not_found",
          `Session is not associated with a local project: ${input.sourceId}/${input.conversationId}`
        );
      }
      // Reread the source so a session still in progress is referenced with its latest turns.
      const session = await readOneSession(adapter, input.conversationId, sessionsPerSource);
      if (!session) {
        throw new MemoryServiceError("not_found", `Session not found: ${input.sourceId}/${input.conversationId}`);
      }
      const markdown = renderLocalSessionMarkdown(session, new Date(now()));
      await mkdir(cacheDir, { recursive: true });
      const path = join(cacheDir, `${safeFileSegment(session.sourceId)}-${safeFileSegment(session.conversationId)}.md`);
      await writeFile(path, markdown, "utf8");
      // Reading refreshed the title and last activity, so keep the association snapshot in step.
      for (const owner of owners) {
        await deps.projects.addSessions(owner.id, [toSnapshot(session)]);
      }
      return { ...toCandidate(session), path, markdown };
    }
  };
}

/** Reads the most recent sessions of one source; a broken or missing source yields none. */
export async function readRecentSessions(adapter: SourceAdapter, limit: number): Promise<LocalSession[]> {
  try {
    if (!(await adapter.detect())) {
      return [];
    }
    const builders = new Map<string, SessionBuilder>();
    for await (const message of adapter.scan({ order: "recent_first", maxScanTargets: limit, maxConversations: limit, fullHistory: true })) {
      let builder = builders.get(message.conversationId);
      if (!builder) {
        builder = { workspacePath: null, updatedAt: "", turns: [] };
        builders.set(message.conversationId, builder);
      }
      appendMessage(builder, message);
    }
    return [...builders.entries()]
      .map(([conversationId, builder]) => finishSession(adapter, conversationId, builder))
      .filter((session): session is LocalSession => session !== null);
  } catch {
    return [];
  }
}

/** Reads one conversation, widening the window once when it is older than the recent list. */
async function readOneSession(adapter: SourceAdapter, conversationId: string, recentLimit: number): Promise<LocalSession | null> {
  try {
    if (!(await adapter.detect())) {
      return null;
    }
    for (const limit of [recentLimit, WIDE_SESSIONS_PER_SOURCE]) {
      const builder: SessionBuilder = { workspacePath: null, updatedAt: "", turns: [] };
      let seen = false;
      for await (const message of adapter.scan({ order: "recent_first", maxScanTargets: limit, maxConversations: limit, fullHistory: true })) {
        if (message.conversationId !== conversationId) {
          continue;
        }
        seen = true;
        appendMessage(builder, message);
      }
      if (seen) {
        return finishSession(adapter, conversationId, builder);
      }
    }
    return null;
  } catch {
    return null;
  }
}

interface SessionBuilder {
  workspacePath: string | null;
  updatedAt: string;
  turns: LocalSessionTurn[];
}

function appendMessage(builder: SessionBuilder, message: ConversationMessage): void {
  builder.workspacePath ??= message.workspacePath;
  if (message.createdAt > builder.updatedAt) {
    builder.updatedAt = message.createdAt;
  }
  if (message.role === "system") {
    return;
  }
  if (message.role === "user") {
    builder.turns.push({ question: stripInjectedContext(message.content), reply: "", steps: [], startedAt: message.createdAt });
    return;
  }
  let turn = builder.turns.at(-1);
  if (!turn) {
    turn = { question: "", reply: "", steps: [], startedAt: message.createdAt };
    builder.turns.push(turn);
  }
  if (message.role === "assistant") {
    const text = message.content.trim();
    if (text) {
      turn.reply = turn.reply ? `${turn.reply}\n\n${text}` : text;
    }
    return;
  }
  turn.steps.push(toolName(message));
}

function finishSession(adapter: SourceAdapter, conversationId: string, builder: SessionBuilder): LocalSession | null {
  const asked = builder.turns.filter((turn) => turn.question);
  if (!asked.length) {
    return null;
  }
  const questions = asked.map((turn) => cleanQuestion(turn.question)).filter((text) => text.length > 0);
  return {
    sourceId: adapter.descriptor.sourceId,
    agentName: adapter.descriptor.displayName,
    conversationId,
    title: pickTitle(questions, adapter, builder.workspacePath, builder.updatedAt),
    lastQuestion: oneLine(questions.at(-1) ?? asked.at(-1)!.question, 120),
    workspacePath: builder.workspacePath,
    updatedAt: builder.updatedAt,
    turns: builder.turns
  };
}

/**
 * 会话的第一条用户消息常常是宿主注入的上下文（AGENTS.md、推荐插件、环境说明、文件清单），
 * 直接拿来当标题会出现大量重复且无意义的条目。这里把它剥掉，留下人真正问的那句。
 */
export function cleanQuestion(text: string): string {
  let value = text;
  // 宿主注入的整块内容：已知标签 + 任意带属性/无属性的成对标签
  value = value.replace(/<(recommended_plugins|environment_context|user_instructions|system[_-]reminder|pasted_content|local-command-[a-z]+)(?:\s[^>]*)?>[\s\S]*?<\/\1>/giu, " ");
  // 自动任务：只保留任务名，去掉 ID 与 memory 路径
  const automation = /^Automation:\s*([^\n]+?)\s*(?:Automation ID|$)/iu.exec(value.trim());
  if (automation) {
    value = automation[1] ?? value;
  }
  const lines = value
    .split("\n")
    // markdown 标题式的文件说明、文件清单头、代码围栏
    .filter((line) => {
      const trimmed = line.trim();
      if (/^```/u.test(trimmed)) return false;
      if (/^#\s*(AGENTS\.md|CLAUDE\.md|Files mentioned by the user|Relevant code)/iu.test(trimmed)) return false;
      if (/^<\/?[a-z_-]+>/iu.test(trimmed)) return false;
      return true;
    })
    .join(" ");
  return value === text ? collapse(lines) : collapse(lines);
}

/** 判断一段用户消息像不像人真的问的问题，而不是宿主或自动化塞进来的模板。 */
export function isHumanQuestion(text: string): boolean {
  if (text.length < 4 || !/[\p{L}\p{N}]/u.test(text)) {
    return false;
  }
  // 纯链接、纯路径
  if (/^(https?:\/\/\S+|\/\S+|@\S+)$/u.test(text)) {
    return false;
  }
  // 常见注入模板的开头
  if (/^(你现在的任务是|你的任务是|You are an? (AI|assistant)|Your task is|You MUST follow|Please follow these steps|Target file this round|Current (file|working))/iu.test(text)) {
    return false;
  }
  // 文档标题、残留标签、以链接开头的消息：都不是「人问的那句话」
  if (/^#/u.test(text) || /^<\/?[a-z]/iu.test(text) || /^https?:\/\//iu.test(text)) {
    return false;
  }
  // 以标点或代码围栏开头的碎片
  if (/^[.。,、:：\-–—]\s*/u.test(text) && !/[\u4e00-\u9fa5]/u.test(text.slice(0, 4))) {
    return false;
  }
  // 链接占了大半内容
  const urlChars = text.match(/https?:\/\/\S+/gu)?.join("").length ?? 0;
  if (urlChars > 0 && urlChars / text.length > 0.6) {
    return false;
  }
  // 一大段文件清单式的 markdown
  if ((text.match(/\n#/gu)?.length ?? 0) >= 2) {
    return false;
  }
  return true;
}

function collapse(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** 选一个能代表会话的标题：优先人问的第一句，否则退回到目录或时间。 */
function pickTitle(
  questions: readonly string[],
  adapter: SourceAdapter,
  workspacePath: string | null,
  updatedAt: string
): string {
  const usable = questions.find((question) => isHumanQuestion(question.trim()));
  if (usable) {
    return oneLine(usable, TITLE_MAX_CHARS);
  }
  const folder = (workspacePath ?? "").replace(/\/+$/u, "").split("/").filter(Boolean).pop();
  const date = Number.isNaN(Date.parse(updatedAt))
    ? ""
    : new Date(updatedAt).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
  return oneLine([folder || adapter.descriptor.displayName, date].filter(Boolean).join(" · "), TITLE_MAX_CHARS);
}

/** Turns an association snapshot back into a rankable session; the questions are what matching needs. */
function fromSnapshot(project: LocalProject, session: LocalProjectSession): LocalSession {
  const questions = [session.lastQuestion, session.title].filter((text) => text.trim().length > 0);
  return {
    sourceId: session.sourceId,
    agentName: session.agentName,
    conversationId: session.conversationId,
    title: session.title || project.name,
    lastQuestion: session.lastQuestion,
    workspacePath: session.workspacePath,
    updatedAt: session.updatedAt,
    turns: questions.map((question) => ({ question, reply: "", steps: [], startedAt: session.updatedAt }))
  };
}

function toSnapshot(session: LocalSession): LocalProjectSession & { turnCount: number } {
  return {
    sourceId: session.sourceId,
    conversationId: session.conversationId,
    agentName: session.agentName,
    title: session.title,
    lastQuestion: session.lastQuestion,
    workspacePath: session.workspacePath,
    updatedAt: session.updatedAt,
    turnCount: session.turns.length,
    addedAt: new Date().toISOString()
  };
}

function toCandidate(session: LocalSession): LocalSessionCandidate {
  return {
    sourceId: session.sourceId,
    agentName: session.agentName,
    conversationId: session.conversationId,
    title: session.title,
    lastQuestion: session.lastQuestion,
    workspacePath: session.workspacePath,
    updatedAt: session.updatedAt,
    turnCount: session.turns.length
  };
}

function sameKey(left: { sourceId: string; conversationId: string }, right: { sourceId: string; conversationId: string }): boolean {
  return left.sourceId === right.sourceId && left.conversationId === right.conversationId;
}

function toolName(message: ConversationMessage): string {
  const fromMeta = message.rawMeta?.toolName;
  if (typeof fromMeta === "string" && fromMeta.trim()) {
    return fromMeta.trim();
  }
  return /^Tool:\s*(\S+)/u.exec(message.content)?.[1] ?? "tool";
}

/** Drops context that memory plugins and hosts inject into the prompt, keeping what the person typed. */
function stripInjectedContext(text: string): string {
  return text
    .replace(/<(system[_-]reminder|[a-z_]*memory_context|memmy_reference)\b[^>]*>[\s\S]*?<\/\1>/giu, "")
    .trim();
}

function oneLine(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars - 1)}…` : collapsed;
}

function safeFileSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/gu, "_").slice(0, 120);
}
