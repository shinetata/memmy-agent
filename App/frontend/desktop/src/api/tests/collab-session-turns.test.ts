import type { RuntimeConfig } from "@memmy/local-api-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpCollabClient } from "../collab-client.js";

/**
 * 共享副本的轮次里，`steps` 从「只有工具名」的字符串数组变成了对象数组。
 * 已经上传的旧任务仍是字符串，读取时必须照常读出来，不能整份会话解析失败。
 */
const config: RuntimeConfig = { baseUrl: "http://127.0.0.1:18100", localToken: "test-token" };

const session = {
  id: "s-1",
  projectId: "p-1",
  projectName: "项目",
  title: "任务",
  lastQuestion: "问题",
  memberName: "成员",
  mine: true,
  source: "claude_code",
  turnCount: 1,
  lastActiveAt: "2026-11-23T14:00:00.000Z",
  link: "memmy://collab/p-1/s-1",
  shareText: "Memmy 协作会话：任务"
};

afterEach(() => vi.unstubAllGlobals());

function reply(value: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } })));
}

describe("collab session turns", () => {
  it("reads steps uploaded before the summary change as tool names only", async () => {
    reply({
      session,
      turns: [{ question: "问", reply: "答", steps: ["Bash", "Edit"], startedAt: "2026-11-23T14:00:00.000Z" }]
    });
    const detail = await createHttpCollabClient(config).readSessionDetail("s-1");
    expect(detail.turns[0]?.steps).toEqual([
      { name: "Bash", input: "", output: "" },
      { name: "Edit", input: "", output: "" }
    ]);
  });

  it("keeps the tool summaries and the flags that say where the copy was compressed", async () => {
    reply({
      session,
      turns: [{
        question: "问",
        reply: "答",
        steps: [
          { name: "Bash", input: "npm test", output: "1 passed", truncated: true },
          { name: "", input: "", output: "[... 4 tool calls omitted ...]" }
        ],
        startedAt: "2026-11-23T14:00:00.000Z",
        omittedBefore: 3
      }]
    });
    const detail = await createHttpCollabClient(config).readSessionDetail("s-1");
    expect(detail.turns[0]?.steps).toEqual([
      { name: "Bash", input: "npm test", output: "1 passed", truncated: true },
      { name: "", input: "", output: "[... 4 tool calls omitted ...]" }
    ]);
    expect(detail.turns[0]?.omittedBefore).toBe(3);
  });

  it("fills in a step object that has no input or output yet", async () => {
    reply({ session, turns: [{ question: "问", reply: "答", steps: [{ name: "Read" }], startedAt: "2026-11-23T14:00:00.000Z" }] });
    const detail = await createHttpCollabClient(config).readSessionDetail("s-1");
    expect(detail.turns[0]?.steps).toEqual([{ name: "Read", input: "", output: "", truncated: undefined }]);
    expect(detail.turns[0]?.omittedBefore).toBeUndefined();
  });
});
