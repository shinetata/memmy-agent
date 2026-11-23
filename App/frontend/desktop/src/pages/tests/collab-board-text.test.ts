/**
 * 看板文字的纯函数：任务摘要要能识别出 Agent 写进会话的通知轮。
 */
import { describe, expect, it } from "vitest";
import { readableSummary } from "../collab-board-text.js";

describe("readableSummary", () => {
  it("keeps a normal question as it is", () => {
    expect(readableSummary("日志里还有 Codex login 的记录，怎么清掉")).toBe("日志里还有 Codex login 的记录，怎么清掉");
    expect(readableSummary("  云端还没升级  ")).toBe("云端还没升级");
  });

  it("drops the notification turns Cursor and Codex append to a session", () => {
    // 旧记录里云端把最后一轮当成摘要存了下来，桌面端不再把标签显示给成员。
    expect(readableSummary("<timestamp>Friday, Oct 30, 2026, 12:08 PM (UTC+8)</timestamp> <task>finished</task>")).toBe("");
    expect(readableSummary("  <system_notification>任务已完成</system_notification>")).toBe("");
    expect(readableSummary("<TASK>finished</TASK>")).toBe("");
  });

  it("returns an empty string for an empty summary", () => {
    expect(readableSummary("")).toBe("");
    expect(readableSummary("   ")).toBe("");
  });
});
