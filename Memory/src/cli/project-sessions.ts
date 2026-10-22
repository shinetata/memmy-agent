/**
 * `sessions read|search`: lets an agent read or find sessions of the person's online projects. The desktop app
 * holds the account, so these commands go through its local API, found via ~/.memmy/runtime.json.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { optionString, type ParsedArgs } from "./args.js";

const RUNTIME_TOKEN_HEADER = "x-memmy-local-token";
const REQUEST_TIMEOUT_MS = 90_000;
const DESKTOP_NOT_RUNNING = "无法连接 Memmy，请打开 Memmy 后重试。";

export interface ProjectSessionsDeps {
  fetch?: typeof fetch;
  runtimeConfigPath?: string;
}

/** Runs `sessions read <link-or-id>` or `sessions search <keywords> [--member] [--project] [--limit]`. */
export async function runProjectSessionsCommand(words: string[], parsed: ParsedArgs, deps: ProjectSessionsDeps = {}): Promise<string> {
  const [action, ...rest] = words;
  if (action === "read") {
    const reference = rest.join(" ").trim();
    if (!reference) {
      throw new Error("sessions read requires a Memmy session link or session ID");
    }
    const result = await localApi(deps, "POST", "/api/collab/sessions/read", { reference });
    return typeof result.text === "string" ? result.text : "";
  }
  if (action === "search") {
    const params = new URLSearchParams({ q: rest.join(" ").trim() });
    for (const name of ["member", "project", "limit"] as const) {
      const value = optionString(parsed.options, name);
      if (value) params.set(name, value);
    }
    const result = await localApi(deps, "GET", `/api/collab/sessions/search?${params.toString()}`);
    const sessions = Array.isArray(result.sessions) ? result.sessions.filter(isRecord) : [];
    if (!sessions.length) {
      return "没有匹配的会话。";
    }
    return sessions.map(formatSearchLine).join("\n");
  }
  throw new Error("sessions requires read or search");
}

/** One line per session: ID, title, then project · member · last activity. */
function formatSearchLine(session: Record<string, unknown>): string {
  const member = text(session.memberName) || (session.mine === true ? "你" : "");
  const activity = formatTime(text(session.lastActiveAt));
  const meta = [text(session.projectName), member, activity].filter(Boolean).join(" · ");
  return `${text(session.id)}  ${text(session.title)}  ${meta}`;
}

async function localApi(
  deps: ProjectSessionsDeps,
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<Record<string, unknown>> {
  const runtime = await readRuntimeConfig(deps.runtimeConfigPath ?? join(homedir(), ".memmy", "runtime.json"));
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
  } catch {
    throw new Error(DESKTOP_NOT_RUNNING);
  }
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const error = isRecord(payload.error) ? payload.error : {};
    throw new Error(text(error.message) || `Memmy request failed (${response.status})`);
  }
  return payload;
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
