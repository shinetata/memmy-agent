import { describe, expect, it } from "vitest";
import {
  DEFAULT_DIGEST_LEVEL,
  LEVELS,
  mergeToolMessages,
  omittedStep,
  parseRenderedTool,
  shapeToolSteps,
  type RawToolCall
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
});

describe("shapeToolSteps", () => {
  const long = (chars: number) => "x".repeat(chars);

  it("collapses a multi-line input to one line and clips it to 180 characters", () => {
    const [step] = shapeToolSteps([{ name: "Bash", input: `{\n  "command": "${long(300)}"\n}` }]);

    expect(step?.input.length).toBe(LEVELS.T0.inputChars);
    expect(step?.input).not.toContain("\n");
    expect(step?.truncated).toBe(true);
  });

  it("keeps an output that fits the head and tail as it is", () => {
    const output = "第一行\n第二行";
    const [step] = shapeToolSteps([{ name: "Bash", output }]);

    expect(step?.output).toBe(output);
    expect(step?.truncated).toBeUndefined();
  });

  it("keeps 500 characters of each end of a long output and marks the cut", () => {
    const [step] = shapeToolSteps([{ name: "Bash", output: `${"A".repeat(800)}${"B".repeat(800)}` }]);

    expect(step?.output).toBe(`${"A".repeat(500)} …[omitted]… ${"B".repeat(500)}`);
    expect(step?.truncated).toBe(true);
  });

  it("returns nothing for a turn without tool calls", () => {
    expect(shapeToolSteps([])).toEqual([]);
  });

  it("keeps every call of a turn that fits the budget", () => {
    const calls: RawToolCall[] = Array.from({ length: 6 }, (_, index) => ({ name: `tool${index}`, input: "{}", output: "ok" }));

    expect(shapeToolSteps(calls)).toHaveLength(6);
  });

  it("drops the calls in the middle of a turn that exceeds the budget", () => {
    const big = long(600);
    const calls: RawToolCall[] = Array.from({ length: 20 }, (_, index) => ({ name: `tool${index}`, input: "{}", output: big }));

    const steps = shapeToolSteps(calls);

    // 每步约 1200 字，四千的预算每侧只装得下几步：其余合成一句话。
    expect(steps.length).toBeLessThan(calls.length);
    const omitted = steps.filter((step) => step.name === "");
    expect(omitted).toHaveLength(1);
    expect(omitted[0]?.output).toMatch(/^\[\.\.\. (\d+) tool calls omitted \.\.\.\]$/u);
    // 保留下来的顺序还是当时的顺序，被丢的正好在中间。
    expect(steps[0]?.name).toBe("tool0");
    expect(steps.at(-1)?.name).toBe("tool19");
  });

  it("counts the calls it dropped", () => {
    const step = omittedStep(7);

    expect(step).toEqual({ name: "", input: "", output: "[... 7 tool calls omitted ...]" });
  });

  it("applies each degradation level's own parameters", () => {
    expect(LEVELS).toEqual({
      T0: { outputHalfChars: 500, windowChars: 4_000, inputChars: 180 },
      T1: { outputHalfChars: 250, windowChars: 4_000, inputChars: 180 },
      T2: { outputHalfChars: 120, windowChars: 4_000, inputChars: 120 },
      T3: { outputHalfChars: 120, windowChars: 800, inputChars: 120 },
      T4: { outputHalfChars: 60, windowChars: 400, inputChars: 60 }
    });
    expect(DEFAULT_DIGEST_LEVEL).toBe("T0");

    const call: RawToolCall = { name: "Bash", input: long(200), output: long(700) };
    const [atT0] = shapeToolSteps([call], "T0");
    const [atT1] = shapeToolSteps([call], "T1");
    const [atT4] = shapeToolSteps([call], "T4");

    // T0 的上下限是 500+500，700 字的输出仍算短；再狠的档位才开始舍。
    expect(atT0?.output).toBe(long(700));
    expect(atT1?.output).toBe(`${long(250)} …[omitted]… ${long(250)}`);
    expect(atT4?.output).toBe(`${long(60)} …[omitted]… ${long(60)}`);
    expect(atT4?.input).toHaveLength(60);
    expect(atT0?.input).toHaveLength(180);
  });

  it("drops more calls at T4 than at T0, since its window is smaller", () => {
    const calls: RawToolCall[] = Array.from({ length: 12 }, (_, index) => ({ name: `tool${index}`, input: "{}", output: long(500) }));

    const atT0 = shapeToolSteps(calls, "T0");
    const atT4 = shapeToolSteps(calls, "T4");
    const omittedOf = (steps: { name: string; output: string }[]) =>
      Number(/\[\.\.\. (\d+) tool calls omitted/u.exec(steps.find((step) => step.name === "")?.output ?? "")?.[1] ?? 0);

    expect(omittedOf(atT4)).toBeGreaterThan(omittedOf(atT0));
  });
});
