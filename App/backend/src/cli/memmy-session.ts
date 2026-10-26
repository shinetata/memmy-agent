#!/usr/bin/env node
/**
 * `memmy-session`: lets an agent find and read the sessions of the person's shared Memmy projects. The desktop app
 * holds the account and reads the sessions from the cloud, so every command goes through its local API, found via
 * ~/.memmy/runtime.json. Nothing is cached on this computer and nothing here touches memory.
 *
 * Only Node built-ins are imported: the desktop build copies this one file next to its launcher.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const RUNTIME_TOKEN_HEADER = "x-memmy-local-token";
const REQUEST_TIMEOUT_MS = 90_000;
const DESKTOP_NOT_RUNNING = "无法连接 Memmy，请打开 Memmy 后重试。";
// The agent's sandbox refused the connection before it reached Memmy, so opening Memmy would not help; running the
// command outside the sandbox does.
const SANDBOX_BLOCKED = "当前环境不允许连接本机的 Memmy，通常是 Agent 的沙箱（sandbox）关闭了网络访问，Memmy 本身可能正常运行。请用沙箱外权限重新运行这条命令，不需要重新打开 Memmy。";
const NO_MATCH = "没有匹配的任务。可以换更短的关键词，或去掉 --member、--since 后重试；任务也可能还没有共享到项目。";
const USAGE = [
  "Usage:",
  "  memmy-session search <keywords> [--member <name>] [--project <project name>] [--since 30d] [--limit <n>]",
  "  memmy-session read <link|id> [--turns <from>-<to> | --around <turn> | --find \"<sentence>\" | --all]",
  "",
  "Finds and reads sessions of your shared Memmy projects. Memmy must be running."
].join("\n");

export interface MemmySessionDeps {
  fetch?: typeof fetch;
  runtimeConfigPath?: string;
}

export interface ParsedArgs {
  positionals: string[];
  options: Record<string, string | true>;
}

/** `--name value`, `--name=value`, or a bare `--name`; everything else is a positional word. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const options: Record<string, string | true> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (token === "-h") {
      options.help = true;
      continue;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const raw = token.slice(2);
    const equals = raw.indexOf("=");
    if (equals >= 0) {
      options[raw.slice(0, equals)] = raw.slice(equals + 1);
      continue;
    }
    const next = argv[index + 1];
    options[raw] = next !== undefined && !next.startsWith("--") ? argv[++index] ?? "" : true;
  }
  return { positionals, options };
}

/** Runs `read <link-or-id> [--turns|--around|--find|--all]` or `search <keywords> [--member] [--project] [--since] [--limit]`. */
export async function runMemmySession(argv: readonly string[], deps: MemmySessionDeps = {}): Promise<string> {
  const parsed = parseArgs(argv);
  const [action, ...rest] = parsed.positionals;
  if (!action || action === "help" || parsed.options.help) {
    return USAGE;
  }
  if (action === "read") {
    const reference = rest.join(" ").trim();
    if (!reference) {
      throw new Error("read 需要 Memmy 任务链接或任务 ID");
    }
    const result = await localApi(deps, "POST", "/api/collab/sessions/read", { reference, view: readView(parsed) });
    return typeof result.text === "string" ? result.text : "";
  }
  if (action === "search") {
    // Memmy turns the words into keywords, merges a session shared to several projects and applies --since.
    const params = new URLSearchParams({ q: rest.join(" ").trim() });
    for (const name of ["member", "project", "since", "limit"] as const) {
      const value = optionString(parsed, name);
      if (value) params.set(name, value);
    }
    const result = await localApi(deps, "GET", `/api/collab/sessions/search?${params.toString()}`);
    const sessions = Array.isArray(result.sessions) ? result.sessions.filter(isRecord) : [];
    if (!sessions.length) {
      return NO_MATCH;
    }
    return sessions.map(formatSearchLine).join("\n");
  }
  throw new Error(`未知命令：${action}\n\n${USAGE}`);
}

/** What `read` prints inline; no flag is the overview. At most one range, since each answers a different need. */
function readView(parsed: ParsedArgs): Record<string, unknown> {
  const around = optionString(parsed, "around");
  const turns = optionString(parsed, "turns");
  const find = optionString(parsed, "find");
  const all = parsed.options.all === true || parsed.options.all === "true";
  if ([around, turns, find].filter((value) => value !== undefined).length + (all ? 1 : 0) > 1) {
    throw new Error("只能指定一种读取范围：--around、--turns、--find 或 --all");
  }
  if (all) return { all: true };
  if (find !== undefined) {
    if (!find.trim()) throw new Error("--find 需要任务中的一句原话");
    return { find: find.trim() };
  }
  if (around !== undefined) {
    return { around: turnNumber(around, "--around") };
  }
  if (turns !== undefined) {
    const match = /^(\d+)(?:-(\d+))?$/u.exec(turns.trim());
    if (!match) throw new Error("--turns 的写法如 3-8 或 5");
    const from = turnNumber(match[1] ?? "", "--turns");
    const to = match[2] === undefined ? from : turnNumber(match[2], "--turns");
    return { turns: { from: Math.min(from, to), to: Math.max(from, to) } };
  }
  return {};
}

function turnNumber(value: string, flag: string): number {
  const number = Number.parseInt(value, 10);
  if (!/^\d+$/u.test(value.trim()) || number < 1) throw new Error(`${flag} 需要从 1 开始的轮次`);
  return number;
}

function optionString(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.options[name];
  return typeof value === "string" ? value : undefined;
}

/** One line per session: ID, title, then every project it is shared to · member · last activity. */
function formatSearchLine(session: Record<string, unknown>): string {
  const member = text(session.memberName) || (session.mine === true ? "你" : "");
  const activity = formatTime(text(session.lastActiveAt));
  const projects = Array.isArray(session.projectNames) ? session.projectNames.filter((name) => typeof name === "string") : [];
  const meta = [projects.length ? projects.join("、") : text(session.projectName), member, activity].filter(Boolean).join(" · ");
  return `${text(session.id)}  ${text(session.title)}  ${meta}`;
}

async function localApi(
  deps: MemmySessionDeps,
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<Record<string, unknown>> {
  const runtime = await readRuntimeConfig(deps.runtimeConfigPath ?? defaultRuntimeConfigPath());
  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(new URL(path, runtime.baseUrl), {
      method,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        [RUNTIME_TOKEN_HEADER]: runtime.localToken,
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch (error) {
    throw new Error(connectFailureMessage(error));
  }
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const error = isRecord(payload.error) ? payload.error : {};
    throw new Error(text(error.message) || `Memmy request failed (${response.status})`);
  }
  return payload;
}

/**
 * Why the local API could not be reached. `fetch` rejects with a TypeError whose `cause` is the socket error:
 * `ECONNREFUSED` when nothing listens on the port (Memmy quit and left runtime.json behind), `EPERM` when a sandbox
 * such as Codex's denies the connection before it is made.
 */
function connectFailureMessage(error: unknown): string {
  const cause = isRecord(error) && isRecord(error.cause) ? error.cause : {};
  if (cause.code === "EPERM" || cause.code === "EACCES") {
    // The raw socket error lets an agent such as Codex recognise the sandbox denial on its own.
    return `${SANDBOX_BLOCKED}\n原始错误：${text(cause.message)}`;
  }
  return DESKTOP_NOT_RUNNING;
}

function defaultRuntimeConfigPath(): string {
  return join(process.env.MEMMY_HOME?.trim() || join(homedir(), ".memmy"), "runtime.json");
}

async function readRuntimeConfig(path: string): Promise<{ baseUrl: string; localToken: string }> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    if (typeof parsed.baseUrl === "string" && typeof parsed.localToken === "string") {
      return { baseUrl: parsed.baseUrl, localToken: parsed.localToken };
    }
  } catch {
    // A missing or partial file means the desktop app has not started.
  }
  throw new Error(DESKTOP_NOT_RUNNING);
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return "";
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${date.getMonth() + 1}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function main(): Promise<void> {
  try {
    process.stdout.write(`${await runMemmySession(process.argv.slice(2))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main();
}
