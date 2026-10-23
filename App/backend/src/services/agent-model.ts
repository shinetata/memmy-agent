/**
 * One call to the person's agent model: the model and quota their Memmy tasks run on, resolved the same way as the
 * onboarding report. Background work such as organizing project items uses it, so it costs the account that runs
 * it and nobody else.
 */
import {
  anthropicMessagesUrl,
  chatCompletionsUrl,
  openAiCompatibleTemperatureFields,
  openAiCompatibleThinkingControlFields,
  type OnboardingInsightAgentTaskModelResolver
} from "./onboarding-insight-service.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TOKENS = 4_000;
/** Reasoning budget when thinking is on; the answer gets `maxTokens` on top where the provider separates them. */
const THINKING_BUDGET_TOKENS = 4_096;

export interface AgentModelRequest {
  system: string;
  user: string;
  maxTokens?: number;
  timeoutMs?: number;
  /** Let the model reason before answering, on providers that can switch it. Off by default, as in the onboarding report. */
  thinking?: boolean;
}

/** The reply's text, or null when the person has no agent model set up. Failures throw. */
export type AgentModelCompleter = (request: AgentModelRequest) => Promise<string | null>;

/**
 * The model answered, but not with something usable: cut off at the output limit, or not the shape asked for.
 * Sending less input usually helps, unlike an HTTP or network failure.
 */
export class AgentModelReplyError extends Error {
  constructor(message: string, readonly truncated = false) {
    super(message);
    this.name = "AgentModelReplyError";
  }
}

export function createAgentModelCompleter(
  resolver: OnboardingInsightAgentTaskModelResolver,
  fetcher: typeof fetch = globalThis.fetch
): AgentModelCompleter {
  return async (request) => {
    const config = await resolver.getAgentTaskModel();
    if (!config) return null;
    const maxTokens = request.maxTokens ?? DEFAULT_MAX_TOKENS;
    const signal = AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const naming = { providerName: config.providerName, baseUrl: config.apiBase, model: config.model };

    if (config.providerName === "anthropic") {
      const response = await fetcher(anthropicMessagesUrl(config.apiBase), {
        method: "POST",
        signal,
        headers: {
          "x-api-key": config.apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
          ...(config.extraHeaders ?? {})
        },
        body: JSON.stringify({
          model: config.model,
          system: request.system,
          messages: [{ role: "user", content: request.user }],
          // Extended thinking requires the default temperature and counts its budget inside max_tokens.
          ...(request.thinking
            ? { thinking: { type: "enabled", budget_tokens: THINKING_BUDGET_TOKENS }, max_tokens: maxTokens + THINKING_BUDGET_TOKENS }
            : { temperature: 0.2, max_tokens: maxTokens }),
          ...(config.extraBody ?? {})
        })
      });
      const raw = await response.text();
      if (!response.ok) throw new Error(`agent model returned HTTP ${response.status}${failureOf(raw)}`);
      const payload = readPayload<{ stop_reason?: string; content?: Array<{ type?: string; text?: string }> }>(raw);
      if (payload.stop_reason === "max_tokens") throw new AgentModelReplyError("agent model reply was cut off at the output limit", true);
      return (payload.content ?? []).filter((part) => !part.type || part.type === "text").map((part) => part.text ?? "").join("");
    }

    // Every other provider, the Memmy account included, speaks chat completions here.
    const response = await fetcher(chatCompletionsUrl(config.apiBase), {
      method: "POST",
      signal,
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
        ...(config.extraHeaders ?? {})
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user }
        ],
        ...openAiCompatibleTemperatureFields(naming, 0.2),
        max_tokens: maxTokens,
        stream: false,
        ...thinkingFields(naming, request.thinking === true),
        ...(config.extraBody ?? {})
      })
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`agent model returned HTTP ${response.status}${failureOf(raw)}`);
    const payload = readPayload<{ choices?: Array<{ finish_reason?: string; message?: { content?: unknown } }> }>(raw);
    const choice = payload.choices?.[0];
    if (choice?.finish_reason === "length") throw new AgentModelReplyError("agent model reply was cut off at the output limit", true);
    const content = choice?.message?.content;
    return typeof content === "string" ? content : "";
  };
}

/**
 * A gateway can answer 200 and still refuse the call: the account quota one reports the reason in a code and message
 * instead of choices. Read as an empty reply, that failure looks like the model said nothing, and the person who can
 * fix it (top up, switch model) is told the wrong thing.
 */
function readPayload<T>(raw: string): T {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error(`agent model returned a body that is not JSON: ${clip(raw, 160)}`);
  }
  const record = (payload ?? {}) as Record<string, unknown>;
  const answered = Array.isArray(record.choices) || Array.isArray(record.content);
  const failure = failureOf(raw);
  if (!answered && failure) throw new Error(failure.replace(/^：/u, ""));
  return payload as T;
}

/** The reason a refused call gives, as `：message`, or an empty string when the body carries none. */
function failureOf(raw: string): string {
  try {
    const record = JSON.parse(raw) as { code?: unknown; message?: unknown; error?: { message?: unknown } };
    const message = typeof record.message === "string" ? record.message : typeof record.error?.message === "string" ? record.error.message : "";
    if (message) return `：${clip(message, 200)}`;
    if (typeof record.code === "number" && record.code !== 0) return `：code ${record.code}`;
  } catch {
    // Not JSON: the caller's own message is the useful one.
  }
  return "";
}

function clip(value: string, limit: number): string {
  const oneLine = value.replace(/\s+/gu, " ").trim();
  return oneLine.length > limit ? `${oneLine.slice(0, limit)}…` : oneLine;
}

/**
 * The provider's own switch, turned the way the request asks. The off switch is the one the onboarding report sends;
 * the on switch mirrors it, with a budget where the provider takes one, as the Memory service does.
 */
function thinkingFields(naming: { providerName: string; baseUrl: string; model: string }, on: boolean): Record<string, unknown> {
  const off = openAiCompatibleThinkingControlFields(naming);
  if (!on) return off;
  if ("enable_thinking" in off) return { enable_thinking: true, thinking_budget: THINKING_BUDGET_TOKENS };
  if ("thinking" in off) return { thinking: { type: "enabled" } };
  return {};
}

/** The first JSON object in a reply, tolerating a Markdown fence or a sentence around it. */
export function parseJsonObject(reply: string): Record<string, unknown> {
  const unfenced = reply.replace(/```(?:json)?/giu, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end <= start) throw new AgentModelReplyError("agent model reply has no JSON object");
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced.slice(start, end + 1));
  } catch (error) {
    throw new AgentModelReplyError(`agent model reply is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new AgentModelReplyError("agent model reply is not a JSON object");
  return parsed as Record<string, unknown>;
}
