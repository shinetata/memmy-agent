import type { RuntimeConfig } from "@memmy/local-api-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpCollabClient } from "../collab-client.js";

/**
 * 共享副本的 `steps` 是工具名的字符串数组；开发期间有一版上传的是对象（工具名 + 入参与输出摘要）。
 * 那些副本还在测试环境里，读到时要照常解析成工具名，不能整份会话解析失败。
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
  lastActiveAt: "2026-11-24T06:00:00.000Z",
  link: "memmy://collab/p-1/s-1",
  shareText: "Memmy 协作会话：任务"
};

afterEach(() => vi.unstubAllGlobals());

describe("collab session steps", () => {
  it("reads object steps as tool names and drops the ones without a name", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      session,
      turns: [{
        question: "问",
        reply: "答",
        steps: [
          "Bash",
          { name: "Read", input: "src/a.ts", output: "12 行" },
          { name: "" },
          { input: "没有名字" },
          7,
          null
        ],
        startedAt: "2026-11-24T06:00:00.000Z"
      }]
    }), { headers: { "content-type": "application/json" } })));

    const detail = await createHttpCollabClient(config).readSessionDetail("s-1");
    expect(detail.turns[0]?.steps).toEqual(["Bash", "Read"]);
  });
});
