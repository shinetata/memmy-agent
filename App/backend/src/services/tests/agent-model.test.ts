import { describe, expect, it } from "vitest";
import { AgentModelReplyError, createAgentModelCompleter } from "../agent-model.js";

const REQUEST = { system: "system", user: "user" };

/** A resolver that always answers with this one chat-completions model. */
function resolverFor(providerName = "memmy_account") {
  return {
    async getAgentTaskModel() {
      return {
        providerName,
        model: "agent_chat",
        apiBase: "https://gateway.test/api",
        apiKey: "test-key",
        apiType: "chatCompletions" as const
      };
    }
  };
}

function replyWith(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe("createAgentModelCompleter", () => {
  it("returns the text of a normal reply", async () => {
    const complete = createAgentModelCompleter(resolverFor(), replyWith({
      choices: [{ finish_reason: "stop", message: { content: "完成" } }]
    }));
    expect(await complete(REQUEST)).toBe("完成");
  });

  // The account gateway answers 200 with its own envelope when the quota is gone; read as an empty reply, that
  // failure looked like "the model answered nothing", which points the person at the wrong cause.
  it("reports the reason a gateway gives in a 200 envelope instead of returning an empty reply", async () => {
    const complete = createAgentModelCompleter(resolverFor(), replyWith({
      code: 40308,
      data: { quota_scene: "agent_chat" },
      message: "agent_chat token 用量不足，请申请更多额度后再试。"
    }));
    await expect(complete(REQUEST)).rejects.toThrow("agent_chat token 用量不足，请申请更多额度后再试。");
  });

  it("keeps a refusal's code when the envelope carries no message", async () => {
    const complete = createAgentModelCompleter(resolverFor(), replyWith({ code: 50001 }));
    await expect(complete(REQUEST)).rejects.toThrow("code 50001");
  });

  it("reports the message a failed HTTP response carries", async () => {
    const complete = createAgentModelCompleter(resolverFor(), replyWith({ message: "upstream is down" }, 503));
    await expect(complete(REQUEST)).rejects.toThrow("agent model returned HTTP 503：upstream is down");
  });

  it("does not pass a non-JSON body off as an empty reply", async () => {
    const complete = createAgentModelCompleter(resolverFor(), replyWith("<html>gateway</html>"));
    await expect(complete(REQUEST)).rejects.toThrow("not JSON");
  });

  it("reads an Anthropic refusal the same way", async () => {
    const complete = createAgentModelCompleter(
      resolverFor("anthropic"),
      replyWith({ type: "error", error: { type: "invalid_request_error", message: "credit balance is too low" } }, 400)
    );
    await expect(complete(REQUEST)).rejects.toThrow("credit balance is too low");
  });

  it("still flags a reply that was cut off at the output limit", async () => {
    const complete = createAgentModelCompleter(resolverFor(), replyWith({
      choices: [{ finish_reason: "length", message: { content: "半句" } }]
    }));
    await expect(complete(REQUEST)).rejects.toBeInstanceOf(AgentModelReplyError);
  });

  it("returns null when the person has no agent model", async () => {
    const complete = createAgentModelCompleter({ async getAgentTaskModel() { return null; } }, replyWith({}));
    expect(await complete(REQUEST)).toBeNull();
  });
});
