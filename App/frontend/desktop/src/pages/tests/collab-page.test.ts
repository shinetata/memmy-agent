import { describe, expect, it } from "vitest";
import type { CollabLinks, LocalAgentSession } from "../../api/collab-client.js";
import {
  agentHasLinks,
  formatSessionTime,
  groupAgentSessions,
  groupCheckState,
  groupingKind,
  isSessionChecked,
  itemBodyMarkdown,
  itemStatusKey,
  localSessionKey,
  toggleGroupLink,
  toggleSessionLink
} from "../collab-page.js";

function session(sourceId: string, conversationId: string, title: string, groupId: string | null, updatedAt = "2026-10-21T13:30:00.000Z"): LocalAgentSession {
  return {
    sourceId,
    agentName: sourceId === "codex" ? "Codex" : "Claude Code",
    conversationId,
    title,
    lastQuestion: "",
    workspacePath: groupId,
    group: groupId ? { id: groupId, label: groupId.split("/").pop() ?? groupId, path: groupId } : null,
    updatedAt,
    turnCount: 3
  };
}

const none: CollabLinks = { groups: [], sessions: [] };

describe("collab page helpers", () => {
  const sessions = [
    session("claude_code", "a", "Memmy 中转 Claude Code 会话", "/w/memmy-agent", "2026-10-21T10:00:00.000Z"),
    session("claude_code", "b", "分享弹窗", "/w/memmy-agent", "2026-10-21T12:00:00.000Z"),
    session("claude_code", "c", "PRD 修订", "/w/Product_Doc", "2026-10-21T11:00:00.000Z"),
    session("claude_code", "d", "临时提问", null),
    session("codex", "e", "MemOS 社区周报", "p-1")
  ];

  it("names groups the way each agent organizes sessions", () => {
    expect(["claude_code", "codex", "cursor", "workbuddy", "hermes"].map(groupingKind)).toEqual(["directory", "project", "workspace", "workbuddy", "directory"]);
  });

  it("groups one agent's sessions, most recent group first, and searches titles and group names", () => {
    const all = groupAgentSessions(sessions, "claude_code", "");
    expect(all.groups.map((view) => [view.group.label, view.sessions.map((item) => item.conversationId)])).toEqual([
      ["memmy-agent", ["b", "a"]],
      ["Product_Doc", ["c"]]
    ]);
    expect(all.ungrouped.map((item) => item.conversationId)).toEqual(["d"]);
    expect(groupAgentSessions(sessions, "claude_code", "分享").groups.map((view) => view.sessions.length)).toEqual([1]);
    expect(groupAgentSessions(sessions, "claude_code", "product").groups[0]?.sessions.map((item) => item.conversationId)).toEqual(["c"]);
  });

  it("links a whole group, excludes a session inside it, and unlinks the group again", () => {
    const view = groupAgentSessions(sessions, "claude_code", "").groups[0]!;
    let links = toggleSessionLink(none, sessions[0]!);
    expect(groupCheckState(links, "claude_code", view)).toBe("mixed");

    links = toggleGroupLink(links, "claude_code", view);
    expect(links).toEqual({ groups: [{ sourceId: "claude_code", groupId: "/w/memmy-agent", excluded: [] }], sessions: [] });
    expect(groupCheckState(links, "claude_code", view)).toBe("checked");

    links = toggleSessionLink(links, sessions[1]!);
    expect(isSessionChecked(links, sessions[1]!)).toBe(false);
    expect(isSessionChecked(links, sessions[0]!)).toBe(true);
    expect(groupCheckState(links, "claude_code", view)).toBe("checked");
    expect(agentHasLinks(links, "claude_code")).toBe(true);
    expect(agentHasLinks(links, "codex")).toBe(false);

    links = toggleGroupLink(links, "claude_code", view);
    expect(links).toEqual(none);
  });

  it("keys sessions by agent and conversation so equal IDs from two agents stay distinct", () => {
    expect(localSessionKey({ sourceId: "codex", conversationId: "x" })).not.toBe(localSessionKey({ sourceId: "cursor", conversationId: "x" }));
  });

  it("formats the last activity compactly and leaves unknown times empty", () => {
    expect(formatSessionTime(null)).toBe("");
    expect(formatSessionTime("not a date")).toBe("");
    expect(formatSessionTime("2026-10-21T13:30:00.000Z")).toMatch(/^10\/2[12] \d{2}:30$/u);
  });

  it("labels an item by its state in project memory and drops its title from the body", () => {
    expect(["PROCESSING", "AVAILABLE", "FAILED"].map((status) => itemStatusKey(status as "PROCESSING"))).toEqual([
      "collab.items.status.processing",
      "collab.items.status.available",
      "collab.items.status.failed"
    ]);
    expect(itemBodyMarkdown("# 知识库分享\n\n**摘要**：分享\n\n## 演变轨迹\n- 10/23 上线\n")).toBe("**摘要**：分享\n\n## 演变轨迹\n- 10/23 上线");
  });
});
