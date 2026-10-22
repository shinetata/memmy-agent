import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LocalSessionCandidate } from "../../api/memory-runtime-client.js";
import {
  AgentSessionMentionPalette,
  removeSessionMention,
  sessionMentionQueryFromInput,
  sessionReferenceFile
} from "../agent-session-mention.js";

const session: LocalSessionCandidate = {
  sourceId: "codex",
  agentName: "Codex",
  conversationId: "codex-1",
  title: "分享弹窗重复分享提示",
  lastQuestion: "账号不存在呢？",
  workspacePath: "/repo",
  updatedAt: "2026-10-20T08:05:00.000Z",
  turnCount: 2
};

describe("agent session mention", () => {
  it("opens only for a trailing @ token", () => {
    expect(sessionMentionQueryFromInput("@")).toBe("");
    expect(sessionMentionQueryFromInput("按这个改 @分享")).toBe("分享");
    expect(sessionMentionQueryFromInput("按这个改\n@codex")).toBe("codex");
    expect(sessionMentionQueryFromInput("mail me at a@b.com")).toBeNull();
    expect(sessionMentionQueryFromInput("@分享 后面还有字")).toBeNull();
    expect(sessionMentionQueryFromInput("没有提到")).toBeNull();
  });

  it("removes the @ token and keeps the rest of the draft", () => {
    expect(removeSessionMention("按这个改 @分享")).toBe("按这个改 ");
    expect(removeSessionMention("@")).toBe("");
  });

  it("wraps the reference as a Markdown attachment named after the session", async () => {
    const file = sessionReferenceFile({ ...session, title: "a/b: 分享?", path: "/cache/codex-codex-1.md", markdown: "# 分享" });
    expect(file.name).toBe("a b 分享.md");
    expect(file.type).toBe("text/markdown");
    expect(await file.text()).toBe("# 分享");
  });

  it("lists each session with its agent, time and last question", () => {
    const html = renderToString(
      <AgentSessionMentionPalette sessions={[session]} heading="本机会话" selectedIndex={0} onSelect={() => undefined} />
    );
    expect(html).toContain("本机会话");
    expect(html).toContain("分享弹窗重复分享提示");
    expect(html).toContain("Codex · ");
    expect(html).toContain("账号不存在呢？");
    expect(html).toContain('aria-selected="true"');
  });

  it("renders nothing without sessions", () => {
    expect(renderToString(<AgentSessionMentionPalette sessions={[]} heading="本机会话" selectedIndex={0} onSelect={() => undefined} />)).toBe("");
  });
});
