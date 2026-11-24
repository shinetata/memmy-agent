import { describe, expect, it } from "vitest";
import {
  MAX_TURN_STEPS,
  SESSION_BUDGET_BYTES,
  capSteps,
  failureExcerpt,
  failureReason,
  fitSessionBudget,
  mergeToolMessages,
  omittedCount,
  omittedStep,
  parseRenderedTool,
  shapeToolSteps,
  type DigestTurn,
  type RawToolCall,
  type ToolStep
} from "../collab-session-digest.js";

/** renderTool 的格式：各段之间空一行，Input/Output 的值从下一行开始。 */
function rendered(parts: { name?: string; callId?: string; status?: string; input?: string; output?: string }): string {
  return [
    parts.name ? `Tool: ${parts.name}` : undefined,
    parts.callId ? `Call ID: ${parts.callId}` : undefined,
    parts.status ? `Status: ${parts.status}` : undefined,
    parts.input !== undefined ? `Input:\n${parts.input}` : undefined,
    parts.output !== undefined ? `Output:\n${parts.output}` : undefined
  ].filter((part): part is string => part !== undefined).join("\n\n");
}

/** 序列化后的字节数：降级预算按它计量。 */
function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function turn(number: number, steps: ToolStep[]): DigestTurn {
  return { question: `第 ${number} 个问题`, reply: `第 ${number} 个回复`, steps, startedAt: `2026-11-24T00:0${number}:00.000Z` };
}

describe("parseRenderedTool", () => {
  it("reads every section of a call message, keeping a multi-line input intact", () => {
    const input = JSON.stringify({ command: "npm test", cwd: "/repo" }, null, 2);
    const parsed = parseRenderedTool(rendered({ name: "Bash", callId: "call_1", status: "completed", input }));

    expect(parsed).toEqual({ name: "Bash", callId: "call_1", status: "completed", input });
  });

  it("reads a result message that only carries output", () => {
    const parsed = parseRenderedTool(rendered({ name: "Bash", callId: "call_1", output: "3 passed\n0 failed" }));

    expect(parsed).toEqual({ name: "Bash", callId: "call_1", output: "3 passed\n0 failed" });
  });

  it("keeps an output whose own lines look like another section", () => {
    // 输出里常出现 `Status: 200` 这类行，但它前面没有空行，不是新的一段。
    const parsed = parseRenderedTool(rendered({ name: "curl", callId: "c2", output: "Status: 200\nOutput:\nhello" }));

    expect(parsed.output).toBe("Status: 200\nOutput:\nhello");
    expect(parsed.status).toBeUndefined();
  });

  it("returns nothing for content that is not a rendered tool message", () => {
    expect(parseRenderedTool("普通回复")).toEqual({});
    expect(parseRenderedTool("")).toEqual({});
  });

  it("drops an empty section instead of reporting an empty string", () => {
    expect(parseRenderedTool("Input:\n\n\nOutput:\n结果")).toEqual({ output: "结果" });
  });
});

describe("mergeToolMessages", () => {
  it("merges the call and the result that share one tool call id", () => {
    const calls = mergeToolMessages([
      { callId: "call_1", name: "Bash", input: "{\"command\":\"ls\"}" },
      { callId: "call_1", name: "Bash", output: "a.txt\nb.txt" }
    ]);

    expect(calls).toEqual([{ callId: "call_1", name: "Bash", input: "{\"command\":\"ls\"}", output: "a.txt\nb.txt" }]);
  });

  it("keeps each message of a repeated id apart instead of pairing by position", () => {
    // 同一 id 出现三次：重放或并行同名调用，配不上就各自成条，免得把别人的输出拼进来。
    const calls = mergeToolMessages([
      { callId: "dup", name: "Bash", input: "ls" },
      { callId: "dup", name: "Bash", output: "第一次" },
      { callId: "dup", name: "Bash", output: "第二次" }
    ]);

    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.output)).toEqual(["", "第一次", "第二次"]);
  });

  it("does not pair two messages that both carry input under the same id", () => {
    const calls = mergeToolMessages([
      { callId: "same", name: "Edit", input: "a" },
      { callId: "same", name: "Edit", input: "b" }
    ]);

    expect(calls).toEqual([
      { callId: "same", name: "Edit", input: "a", output: "" },
      { callId: "same", name: "Edit", input: "b", output: "" }
    ]);
  });

  it("leaves messages without an id independent", () => {
    const calls = mergeToolMessages([
      { name: "Bash", input: "ls" },
      { name: "Bash", output: "a.txt" }
    ]);

    expect(calls).toEqual([
      { name: "Bash", input: "ls", output: "" },
      { name: "Bash", input: "", output: "a.txt" }
    ]);
  });

  it("drops a row that repeats the same call word for word, so a replay is not a second step", () => {
    // 会话续写或请求快照重放时，同一条调用的 call 与 result 会各写两遍：内容相同，仍是一步。
    const calls = mergeToolMessages([
      { callId: "call_r", name: "Read", input: "{\"path\":\"/a\"}" },
      { callId: "call_r", name: "Read", input: "{\"path\":\"/a\"}" },
      { callId: "call_r", name: "Read", output: "文件内容" },
      { callId: "call_r", name: "Read", output: "文件内容" }
    ]);

    expect(calls).toEqual([{ callId: "call_r", name: "Read", input: "{\"path\":\"/a\"}", output: "文件内容" }]);
  });

  it("takes the name from the call when the result only says tool", () => {
    const calls = mergeToolMessages([
      { callId: "call_9", name: "read_file", input: "{\"path\":\"/a\"}" },
      { callId: "call_9", name: "tool", output: "内容" }
    ]);

    expect(calls[0]?.name).toBe("read_file");
  });

  it("carries the status of either message onto the merged call", () => {
    // 状态可能只写在 result 上（WorkBuddy 就只给结果带 status）。
    const fromResult = mergeToolMessages([
      { callId: "c1", name: "Bash", input: "ls" },
      { callId: "c1", name: "Bash", output: "boom", status: "failed" }
    ]);
    const fromCall = mergeToolMessages([{ callId: "c2", name: "Bash", input: "ls", status: "error" }]);

    expect(fromResult[0]?.status).toBe("failed");
    expect(fromCall[0]?.status).toBe("error");
  });

  it("keeps the failure when the call says completed and only the result says failed", () => {
    // Codex 的 function_call 自带 status: completed，失败只写在 output 上；按先后取会把它当成成功。
    const merged = mergeToolMessages([
      { callId: "c3", name: "exec", input: "npm test", status: "completed" },
      { callId: "c3", output: "FAILED", status: "failed" }
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.status).toBe("failed");
    expect(shapeToolSteps(merged)[0]?.failed).toBe(true);
  });
});

describe("shapeToolSteps", () => {
  const long = (chars: number) => "x".repeat(chars);

  it("keeps every call of a long turn, so a run of 163 calls still shows 163 steps", () => {
    // 这正是「163 次调用只留 12 步」的那条会话：一次调用一步，一步都不许丢。
    const calls: RawToolCall[] = Array.from({ length: 163 }, (_, index) => ({
      name: "Bash",
      input: `{"command":"npm test -- --run ${index}"}`,
      output: `第 ${index} 次输出`
    }));

    const steps = shapeToolSteps(calls);

    expect(steps).toHaveLength(163);
    expect(steps.every((step) => step.name === "Bash")).toBe(true);
    expect(steps.some((step) => step.name === "")).toBe(false);
  });

  it("takes the key parameters first and drops a leading cd from the command", () => {
    const [step] = shapeToolSteps([{ name: "Bash", input: "{\"command\":\"cd /Users/sunq/repo && npm test\",\"cwd\":\"/Users/sunq/repo\"}" }]);

    expect(step?.input).toBe("npm test {\"cwd\":\"/Users/sunq/repo\"}");
  });

  it("joins an array parameter with spaces and follows the documented key order", () => {
    const [joined] = shapeToolSteps([{ name: "Bash", input: { command: ["npm", "test"] } }]);
    const [ordered] = shapeToolSteps([{ name: "Grep", input: { pattern: "协作项目", path: "App/backend" } }]);

    expect(joined?.input).toBe("npm test");
    // path 在 pattern 之前：先看在哪里找，再看找什么。
    expect(ordered?.input).toBe("App/backend 协作项目");
  });

  it("falls back to the whole input when no key parameter is present", () => {
    const [step] = shapeToolSteps([{ name: "todo_write", input: { todos: [{ content: "跑测试" }], merge: true } }]);
    const [empty] = shapeToolSteps([{ name: "Edit", input: {} }]);

    expect(step?.input).toBe("{\"todos\":[{\"content\":\"跑测试\"}],\"merge\":true}");
    // 参数都是空的也留一句原文：否则看着像当时什么参数都没带。
    expect(empty?.input).toBe("{}");
  });

  it("reads an input that arrives as a JSON string and collapses it to one line", () => {
    const [step] = shapeToolSteps([{ name: "Read", input: "{\n  \"file_path\": \"/repo/README.md\"\n}" }]);

    expect(step?.input).toBe("/repo/README.md");
    expect(step?.input).not.toContain("\n");
  });

  it("clips the input to 200 characters without calling it compressed", () => {
    const [step] = shapeToolSteps([{ name: "Bash", input: `{"command":"${long(400)}"}` }]);

    expect(step?.input).toHaveLength(200);
    // 入参本来就是摘要：裁到上限不算降级，不标 truncated，界面也就不提示「部分输出已压缩」。
    expect(step).not.toHaveProperty("truncated");
  });

  it("keeps no output for a successful call", () => {
    const [step] = shapeToolSteps([{ name: "Read", input: { file_path: "/repo/a.ts" }, output: long(5_000) }]);

    // 成功调用的回显不上传：接手的人要的是「做了什么」，结果看回复。
    expect(step).toEqual({ name: "Read", input: "/repo/a.ts", output: "" });
  });

  it("keeps one or two lines that explain a failure instead of the whole output", () => {
    const output = `${long(3_000)}\nError: Cannot find module './x'\n${long(3_000)}\nExit code: 1`;
    const [step] = shapeToolSteps([{ name: "Bash", status: "failed", output }]);

    expect(step?.failed).toBe(true);
    expect(step?.output).toBe("Error: Cannot find module './x'\nExit code: 1");
    expect(step).not.toHaveProperty("truncated");
  });

  it("marks a call failed from the rendered status, in any letter case", () => {
    const failed = shapeToolSteps([{ name: "Bash", status: "failed" }])[0];
    const cancelled = shapeToolSteps([{ name: "Bash", status: "CANCELLED" }])[0];
    const completed = shapeToolSteps([{ name: "Bash", status: "completed" }])[0];

    expect(failed?.failed).toBe(true);
    expect(cancelled?.failed).toBe(true);
    // 成功时不带这个字段：数据里出现 `failed: false` 只会让人以为作者漏写了什么。
    expect(completed).not.toHaveProperty("failed");
    expect(Object.keys(completed ?? {})).not.toContain("failed");
  });

  it("marks a call failed when its output carries a non-zero exit code", () => {
    const codex = shapeToolSteps([{ name: "exec", output: "…\nExit code: 1" }])[0];
    const memmy = shapeToolSteps([{ name: "Bash", output: "Process exited with code 2" }])[0];
    const json = shapeToolSteps([{ name: "shell", output: "{\"exit_code\": 127, \"stdout\": \"\"}" }])[0];
    const camel = shapeToolSteps([{ name: "shell", output: "{\"exitCode\": 1}" }])[0];
    // Codex 的结果是 JSON 字符串里再嵌一层 JSON：引号带反斜杠。
    const escaped = shapeToolSteps([{ name: "exec_command", output: "[{\"text\": \"{\\\"exit_code\\\":127}\"}]" }])[0];
    // WorkBuddy 的大写标签与成功时的 0 都按同一套判断。
    const capitalized = shapeToolSteps([{ name: "Bash", output: "Command: npm test\nExit Code: 1" }])[0];
    const ok = shapeToolSteps([{ name: "exec", output: "Exit code: 0\n全部通过" }])[0];

    expect(codex?.failed).toBe(true);
    expect(memmy?.failed).toBe(true);
    expect(json?.failed).toBe(true);
    expect(capitalized?.failed).toBe(true);
    expect(camel?.failed).toBe(true);
    expect(escaped?.failed).toBe(true);
    expect(ok).not.toHaveProperty("failed");
  });

  it("does not treat the words error or failed inside an output as a failure", () => {
    // 一次成功的 grep 也会带这些词：只看状态和退出码，才不会被正文骗。
    const [step] = shapeToolSteps([{ name: "Grep", output: "src/a.ts:12: error handling failed to retry" }]);

    expect(step).not.toHaveProperty("failed");
    expect(step?.output).toBe("");
  });

  it("returns nothing for a turn without tool calls", () => {
    expect(shapeToolSteps([])).toEqual([]);
  });
});

describe("failureExcerpt", () => {
  it("skips the echoed command and empty sections of a WorkBuddy result, keeping the exit code and signal", () => {
    const output = "Command: cd /repo && grep -rn kb .\nStdout: ./a/test_health.py\n./b/test_health.py\nStderr: (empty)\nExit Code: 137\nSignal: SIGTERM";

    // grep 列出的文件不是原因：标准输出里只有提到失败的行才算。
    expect(failureExcerpt(output)).toBe("Exit Code: 137\nSignal: SIGTERM");
  });

  it("prefers the error line, and keeps a failing test that a tool reports on standard output", () => {
    expect(failureExcerpt("Command: npm ci\nStdout: added 3 packages\nStderr: npm ERR! code E404\nExit Code: 1"))
      .toBe("Stderr: npm ERR! code E404\nExit Code: 1");
    expect(failureExcerpt("Command: npx vitest run\nStdout: FAILED src/a.test.ts > keeps order\nStderr: (empty)\nExit Code: 1"))
      .toBe("Stdout: FAILED src/a.test.ts > keeps order\nExit Code: 1");
  });

  it("unwraps the nested JSON of a Codex result to its own output and exit code", () => {
    const inner = JSON.stringify({ chunk_id: "a832d1", exit_code: 127, output: "zsh:1: no such file or directory: .venv/bin/python\n" });
    const output = JSON.stringify([{ type: "input_text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" }, { type: "input_text", text: inner }], null, 2);

    expect(failureExcerpt(output)).toBe("zsh:1: no such file or directory: .venv/bin/python\nExit code: 127");
  });

  it("takes the raised exception at the end of a Python traceback, not the Traceback line", () => {
    const output = "Traceback (most recent call last):\n  File \"main.py\", line 3, in <module>\n    run()\nModuleNotFoundError: No module named 'app'";

    expect(failureExcerpt(output)).toBe("ModuleNotFoundError: No module named 'app'");
  });

  it("gives the exit code instead of a line of ordinary output when nothing explains the failure", () => {
    // Proma 的失败结果：命令的正常输出（一串目录名、一个 0），最后一行才是退出码。
    expect(failureExcerpt("-Users-sunq-GitHub-MemOS\n-Users-sunq-GitHub-Memory\n\nCommand exited with code 1"))
      .toBe("Command exited with code 1");
    expect(failureExcerpt("0\n\n\nCommand exited with code 1")).toBe("Command exited with code 1");
    expect(shapeToolSteps([{ name: "bash", output: "0\n\nCommand exited with code 1" }])[0]?.failed).toBe(true);
  });

  it("drops the notes Memmy's own exec adds around a failure", () => {
    const output = "Error: command exited with 1\nfatal: not a git repository (or any of the parent directories): .git\n\nExit code: 1\n\n[Analyze the error above and try a different approach.]";

    expect(failureExcerpt(output)).toBe("fatal: not a git repository (or any of the parent directories): .git\nExit code: 1");
  });

  it("clips each line and gives nothing for an empty output", () => {
    expect(failureExcerpt(`Error: ${"x".repeat(500)}`)).toHaveLength(200);
    expect(failureExcerpt("")).toBe("");
    expect(failureReason("Stderr: boom\nExit code: 2", 120)).toBe("Stderr: boom");
  });
});

describe("omitted steps", () => {
  it("describes how many calls it stands for", () => {
    const step = omittedStep(7);

    expect(step).toEqual({ name: "", input: "", output: "[... 7 tool calls omitted ...]" });
    expect(omittedCount(step)).toBe(7);
    expect(omittedCount({ name: "Bash", input: "", output: "ok" })).toBe(0);
  });
});

describe("capSteps", () => {
  const steps = (count: number): ToolStep[] =>
    Array.from({ length: count }, (_, index) => ({ name: "Bash", input: `cmd ${index}`, output: "ok" }));

  it("keeps a turn of exactly the limit as it is", () => {
    const all = steps(MAX_TURN_STEPS);

    expect(capSteps(all)).toHaveLength(MAX_TURN_STEPS);
    expect(capSteps(all).at(-1)?.input).toBe(`cmd ${MAX_TURN_STEPS - 1}`);
  });

  it("keeps the first 500 and the last 499 steps of an oversized turn, with one placeholder in between", () => {
    const capped = capSteps(steps(1_200));

    expect(capped).toHaveLength(MAX_TURN_STEPS);
    expect(capped[499]?.input).toBe("cmd 499");
    expect(omittedCount(capped[500]!)).toBe(1_200 - 500 - 499);
    expect(capped[501]?.input).toBe(`cmd ${1_200 - 499}`);
    expect(capped.at(-1)?.input).toBe("cmd 1199");
  });
});

describe("fitSessionBudget", () => {
  const long = (chars: number) => "x".repeat(chars);
  /** 早先上传的副本里，成功调用也带着整段输出。 */
  const legacy = (output: string): ToolStep[] => [{ name: "Bash", input: "npm test", output }];

  it("returns the turns untouched when they already fit", () => {
    const turns = [turn(1, shapeToolSteps([{ name: "Bash", input: { command: "npm test" }, output: long(1_200) }]))];
    const before = JSON.stringify(turns);

    const fitted = fitSessionBudget(turns, SESSION_BUDGET_BYTES);

    expect(JSON.stringify(fitted)).toBe(before);
    expect(fitted[0]!.steps[0]).toEqual({ name: "Bash", input: "npm test", output: "" });
  });

  it("clears a successful output of the earliest turn first, and stops as soon as it fits", () => {
    const turns = [1, 2, 3].map((number) => turn(number, legacy(long(2_000))));
    // 只差两百字节：清掉最早那一轮就够，后两轮不该被动过。
    const fitted = fitSessionBudget(turns, bytes(turns) - 200);

    expect(fitted[0]!.steps[0]!.output).toBe("");
    expect(fitted[0]!.steps[0]!.truncated).toBe(true);
    expect(fitted[1]!.steps[0]!.output).toBe(long(2_000));
    expect(fitted[2]!.steps[0]!.output).toBe(long(2_000));
  });

  it("keeps the failure reason until the successful outputs are gone, then cuts it to one line", () => {
    const failed: ToolStep = { name: "Bash", input: long(200), output: `Error: ${long(190)}\nExit code: 1`, failed: true };
    const fitted = fitSessionBudget([turn(1, [...legacy(long(1_000)), failed])], 1);

    expect(fitted[0]!.steps[0]!.output).toBe("");
    expect(fitted[0]!.steps[1]!.output).toBe(`Error: ${long(113)}`);
    expect(fitted[0]!.steps[1]!.input).toBe(long(80));
    expect(fitted[0]!.steps[1]!.failed).toBe(true);
  });

  it("never touches the question or the reply", () => {
    const turns = [turn(1, legacy(long(6_000)))];
    const fitted = fitSessionBudget(turns, 1);

    expect(fitted[0]!.question).toBe("第 1 个问题");
    expect(fitted[0]!.reply).toBe("第 1 个回复");
  });

  it("drops steps of a turn with more than twenty of them as the last resort", () => {
    const steps = Array.from({ length: 30 }, (_, index) => ({ name: "Bash", input: `cmd ${index}`, output: "" }));
    const fitted = fitSessionBudget([turn(1, steps)], 1);

    expect(fitted[0]!.steps).toHaveLength(21);
    expect(fitted[0]!.steps[0]!.input).toBe("cmd 0");
    expect(omittedCount(fitted[0]!.steps[10]!)).toBe(10);
    expect(fitted[0]!.steps.at(-1)?.input).toBe("cmd 29");
  });

  it("leaves a turn of twenty steps or fewer alone at the last level", () => {
    const steps = Array.from({ length: 20 }, (_, index) => ({ name: "Bash", input: `cmd ${index}`, output: "" }));
    const fitted = fitSessionBudget([turn(1, steps)], 1);

    expect(fitted[0]!.steps).toHaveLength(20);
    expect(fitted[0]!.steps.some((step) => step.name === "")).toBe(false);
  });

  it("never grows a turn while degrading it", () => {
    const turns = [
      turn(1, shapeToolSteps([{ name: "Bash", input: long(150), output: long(700) }])),
      turn(2, shapeToolSteps([{ name: "Bash", status: "failed", output: `Error: ${long(900)}` }]))
    ];

    const fitted = fitSessionBudget(turns, 1);

    expect(bytes(fitted)).toBeLessThanOrEqual(bytes(turns));
  });
});
