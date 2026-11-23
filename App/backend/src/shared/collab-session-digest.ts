/**
 * 协作项目共享会话里的工具调用摘要。
 *
 * <p>成员读到的一条共享任务，原来只有「提问 + 回复 + 工具名」，参数与输出全被丢掉，接着做的人看不出当时
 * 到底跑了什么。这里把一次调用压成「调用什么、参数要点、输出要点」，再按一轮的总预算丢弃中间那些调用
 * ——与 Memory 里 turn.judge 的取舍一致（{@code turnJudgeToolText}），只是输出成结构化的
 * {@link ToolStep}，好让看板和命令各自排版。</p>
 *
 * <p>降级不额外记字段：读者能从数据本身看出被压缩过——单步被截断时 {@code truncated} 为 true 且输出里
 * 有 {@code  …[omitted]… }；整次调用被丢弃时那一步的名称为空、输出是
 * {@code [... N tool calls omitted ...]}；轮次被合并时其后第一轮带 {@code omittedBefore}。</p>
 *
 * <p>放在 shared 而不是 services：读本机会话的出站适配器（session-reference）也要用它，而后端的
 * eslint 边界不允许出站适配器依赖 services 层。</p>
 */

/** 一段输出被掐头去尾时的分隔标记；前后各留一个空格，截断处才不会粘成一个词。 */
export const OUTPUT_TRUNCATION_MARKER = " …[omitted]… ";

/** 一步上传内容：只有摘要，原文仍在来源 Agent 的记录里。 */
export interface ToolStep {
  /** 工具名，至多 100 字；整次调用被丢弃的合并步是空串。 */
  name: string;
  /** 入参摘要，压成一行。 */
  input: string;
  /** 输出摘要，超长时留头尾。 */
  output: string;
  /** 入参或输出被压缩过。 */
  truncated?: boolean;
}

/** 读取阶段拿到的一次调用：入参与输出可能是原文、对象或一段 JSON 文本。 */
export interface RawToolCall {
  name: string;
  input?: unknown;
  output?: unknown;
  /** 原生调用 id，只用于把 call 与 result 配成一条；不上传。 */
  callId?: string;
}

/** 五档降级，云端与客户端用同一张表。 */
export type DigestLevel = "T0" | "T1" | "T2" | "T3" | "T4";

export interface DigestParams {
  /** 输出保留的头、尾各多少字。 */
  outputHalfChars: number;
  /** 一轮的工具段总预算：超出后从中间丢弃整次调用。 */
  windowChars: number;
  /** 入参保留多少字。 */
  inputChars: number;
}

/** T0 是默认档；越往后压得越狠，只在整条任务接近容量上限时才用。 */
export const LEVELS: Readonly<Record<DigestLevel, DigestParams>> = Object.freeze({
  T0: { outputHalfChars: 500, windowChars: 1_600, inputChars: 180 },
  T1: { outputHalfChars: 250, windowChars: 1_600, inputChars: 180 },
  T2: { outputHalfChars: 120, windowChars: 1_600, inputChars: 120 },
  T3: { outputHalfChars: 120, windowChars: 800, inputChars: 120 },
  T4: { outputHalfChars: 60, windowChars: 400, inputChars: 60 }
});

export const DEFAULT_DIGEST_LEVEL: DigestLevel = "T0";

/** 工具名最多留多少字：异常长的名字只会稀释摘要。 */
const MAX_NAME_CHARS = 100;

export interface ParsedRenderedTool {
  name?: string;
  callId?: string;
  status?: string;
  input?: string;
  output?: string;
}

/** 渲染格式里每个字段各占一行，段与段之间空一行；值本身可能是多行。 */
const SECTION_LINE = /^(Tool|Call ID|Status|Input|Output):(.*)$/u;

/**
 * 解析 {@code renderTool} 渲染出来的一条工具消息（Memory/AgentSourceCore 的固定格式）：
 * {@code Tool: <name>}、{@code Call ID: <id>}、{@code Status: <status>}、{@code Input:\n<值>}、
 * {@code Output:\n<值>}，缺哪段就少哪行。各段之间空一行，所以只有空行之后（或消息开头）才可能是新的一段。
 */
export function parseRenderedTool(content: string): ParsedRenderedTool {
  const parsed: ParsedRenderedTool = {};
  const lines = content.split("\n");
  const values: Record<"input" | "output", string[]> = { input: [], output: [] };
  let section: "input" | "output" | null = null;
  for (const [index, line] of lines.entries()) {
    const startsSection = index === 0 || lines[index - 1] === "";
    const match = startsSection ? SECTION_LINE.exec(line) : null;
    if (!match) {
      if (section) values[section].push(line);
      continue;
    }
    const key = match[1]!;
    const rest = (match[2] ?? "").trim();
    section = null;
    if (key === "Tool") {
      parsed.name = rest || undefined;
    } else if (key === "Call ID") {
      parsed.callId = rest || undefined;
    } else if (key === "Status") {
      parsed.status = rest || undefined;
    } else {
      // Input/Output 的值从下一行开始，一直取到下一段的标题。
      section = key === "Input" ? "input" : "output";
      if (rest) values[section].push(rest);
    }
  }
  // 段与段之间的空行会落在上一个值的末尾，去掉；整段为空就当没这段。
  const input = joinLines(values.input);
  const output = joinLines(values.output);
  if (input) parsed.input = input;
  if (output) parsed.output = output;
  return parsed;
}

function joinLines(lines: readonly string[]): string {
  return lines.join("\n").trim();
}

/** 一条待合并的调用：call 消息带入参、result 消息带输出，两条共用同一个 callId。 */
export interface RenderedToolMessage {
  callId?: string;
  name?: string;
  input?: string;
  output?: string;
}

/**
 * 把同一 toolCallId 的 call 与 result 合成一条。原生记录里一次调用会写两条消息，不合并就会算成两步。
 *
 * <p>先把一字不差的重复行去掉（会话续写、请求快照重放），再去配对：id 缺失、或同一 id 去重后仍然多于两条
 * （并行同名调用、同一 id 写了不同内容）时不合并，各自独立成条——位置相近不代表是一对，按位置配对会把
 * 两次调用的入参和别人的输出拼在一起。</p>
 */
export function mergeToolMessages(messages: readonly RenderedToolMessage[]): RawToolCall[] {
  const unique = dropReplays(messages);
  const byId = new Map<string, number[]>();
  for (const [index, message] of unique.entries()) {
    const callId = message.callId?.trim();
    if (!callId) continue;
    const seen = byId.get(callId);
    if (seen) seen.push(index);
    else byId.set(callId, [index]);
  }

  // 只有「一条只带入参、一条只带输出」的两条才配成一对。
  const partner = new Map<number, number>();
  for (const indices of byId.values()) {
    if (indices.length !== 2) continue;
    const [first, second] = indices as [number, number];
    const a = unique[first]!;
    const b = unique[second]!;
    if (hasInput(a) && !hasText(a.output) && !hasInput(b) && hasText(b.output)) partner.set(first, second);
    else if (hasInput(b) && !hasText(b.output) && !hasInput(a) && hasText(a.output)) partner.set(second, first);
  }

  const absorbed = new Set(partner.values());
  const calls: RawToolCall[] = [];
  for (const [index, message] of unique.entries()) {
    if (absorbed.has(index)) continue;
    const mate = partner.get(index);
    if (mate === undefined) {
      calls.push({ ...(message.callId?.trim() ? { callId: message.callId.trim() } : {}), name: message.name ?? "", input: message.input ?? "", output: message.output ?? "" });
      continue;
    }
    const other = unique[mate]!;
    calls.push({
      ...(message.callId?.trim() ? { callId: message.callId.trim() } : {}),
      // call 消息带着工具名，result 消息只有输出；两个都有时取前一个。
      name: firstText(message.name, other.name),
      input: firstText(message.input, other.input),
      output: firstText(message.output, other.output)
    });
  }
  return calls;
}

function hasInput(message: RenderedToolMessage): boolean {
  return message.input !== undefined && message.input.trim() !== "";
}

/**
 * 同一条调用被重复写进记录时（会话续写、请求快照重放），内容一字不差：先去重，否则一次调用会被算成两步以上。
 * 同一个 id 而内容不同的两条不会被去重，它们是不是同一次调用本来就说不准。
 */
function dropReplays(messages: readonly RenderedToolMessage[]): RenderedToolMessage[] {
  const seen = new Set<string>();
  const unique: RenderedToolMessage[] = [];
  for (const message of messages) {
    const callId = message.callId?.trim();
    if (!callId) {
      unique.push(message);
      continue;
    }
    const key = [callId, message.name ?? "", message.input ?? "", message.output ?? ""].join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(message);
  }
  return unique;
}

function hasText(value: string | undefined): boolean {
  return typeof value === "string" && value.trim() !== "";
}

function firstText(primary: string | undefined, fallback: string | undefined): string {
  if (hasText(primary)) return primary!.trim();
  return hasText(fallback) ? fallback!.trim() : "";
}

/**
 * 一个回合攒着的工具原文，等这一轮读完再合并。键是回合对象本身：会话读完就跟着回收，不用手动清理。
 *
 * <p>读取分两步做：先原样攒着，全部读完后由 {@link finalizeTurnSteps} 合成一次。每读到一条就重算会把
 * 一轮的工具重复压缩很多遍，列表页也要为此重复劳动。</p>
 */
const pendingTools = new WeakMap<object, RenderedToolMessage[]>();

/** 读到一条工具消息：原样攒着，等回合读完再合并成一步。 */
export function collectToolMessage(turn: object, message: RenderedToolMessage): void {
  const messages = pendingTools.get(turn);
  if (messages) messages.push(message);
  else pendingTools.set(turn, [message]);
}

/** 回合读完：把攒下的 call 与 result 合并、按 T0 压成步骤。没有工具调用时什么都不改。 */
export function finalizeTurnSteps(turn: { steps: ToolStep[] }): void {
  const messages = pendingTools.get(turn);
  if (!messages) return;
  pendingTools.delete(turn);
  turn.steps = shapeToolSteps(mergeToolMessages(messages));
}

/**
 * 按降级级别把一轮的原始调用压成上传用的步骤：先逐条摘要，再按本轮预算从中间丢弃整次调用。
 * 没有调用时返回空数组，调用方不必单独判断。
 */
export function shapeToolSteps(calls: readonly RawToolCall[], level: DigestLevel = DEFAULT_DIGEST_LEVEL): ToolStep[] {
  const params = LEVELS[level] ?? LEVELS[DEFAULT_DIGEST_LEVEL];
  const steps = calls.map((call) => shapeStep(call, params));
  return fitWindow(steps, params.windowChars);
}

function shapeStep(call: RawToolCall, params: DigestParams): ToolStep {
  const name = clip(collapse(serialize(call.name)), MAX_NAME_CHARS);
  const renderedInput = collapse(serialize(call.input));
  const input = clip(renderedInput, params.inputChars);
  const renderedOutput = serialize(call.output).trim();
  const output = headTail(renderedOutput, params.outputHalfChars);
  const truncated = renderedInput.length > params.inputChars || output !== renderedOutput;
  return { name, input, output, ...(truncated ? { truncated: true } : {}) };
}

/**
 * 一轮的工具段总预算：总长没超两倍预算时全部保留；否则从头、从尾各保留累计不超过预算的若干步，
 * 中间被丢掉的合成一步，好让读者知道这里少了东西，而不是以为当时没调用。
 */
function fitWindow(steps: readonly ToolStep[], windowChars: number): ToolStep[] {
  const rendered = steps.map((step) => `${step.name}(${step.input}) -> ${step.output}`);
  const total = rendered.reduce((sum, text) => sum + text.length, 0);
  if (total <= windowChars * 2) return [...steps];

  const head: number[] = [];
  let headChars = 0;
  let cursor = 0;
  for (; cursor < steps.length; cursor += 1) {
    const length = rendered[cursor]!.length;
    // 第一步无论多长都留着，否则一轮工具特别长时会一步都不剩。
    if (head.length > 0 && headChars + length > windowChars) break;
    head.push(cursor);
    headChars += length;
  }
  const tail: number[] = [];
  let tailChars = 0;
  for (let index = steps.length - 1; index >= cursor; index -= 1) {
    const length = rendered[index]!.length;
    if (tail.length > 0 && tailChars + length > windowChars) break;
    tail.unshift(index);
    tailChars += length;
  }
  const omitted = steps.length - head.length - tail.length;
  return [
    ...head.map((index) => steps[index]!),
    ...(omitted > 0 ? [omittedStep(omitted)] : []),
    ...tail.map((index) => steps[index]!)
  ];
}

/** 整次调用被丢弃时的那一步：没有工具名，只有一句说明。 */
export function omittedStep(count: number): ToolStep {
  return { name: "", input: "", output: `[... ${count} tool calls omitted ...]` };
}

/** 掐头去尾：不超过两倍上限就原样返回。 */
function headTail(text: string, halfChars: number): string {
  if (text.length <= halfChars * 2) return text;
  return `${text.slice(0, halfChars)}${OUTPUT_TRUNCATION_MARKER}${text.slice(-halfChars)}`;
}

/** 字符串原样、其余按 JSON 序列化，和 renderTool 的 format 一致。 */
function serialize(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

/** 入参压成一行：多行 JSON 或代码可以读，但只留一行的长度。 */
function collapse(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function clip(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}
