/**
 * 协作项目共享会话里的工具调用摘要。
 *
 * <p>成员读到的一条共享任务，原来只有「提问 + 回复 + 工具名」，接着做的人看不出当时到底跑了什么。
 * 这里把一次调用压成「调用什么、关键参数」，失败的调用再附一两行原因；成功调用的输出不留。一个回合的每一次
 * 调用都留一步。接手评测里，回复正文已经说清了结论与决定，工具记录补上的多是命令、路径、环境变量
 * 与失败原因，成功调用的回显几乎不起作用，却占了绝大部分体积。整条会话超出上传预算时按字节逐级降级
 * （{@link fitSessionBudget}），正常会话远达不到预算。</p>
 *
 * <p>降级不额外记字段：读者能从数据本身看出被压缩过——降级改过的一步 {@code truncated} 为 true；
 * 整次调用被丢弃时那一步的名称为空、输出是 {@code [... N tool calls omitted ...]}；轮次被合并时
 * 其后第一轮带 {@code omittedBefore}；调用失败时那一步带 {@code failed: true}。</p>
 *
 * <p>放在 shared 而不是 services：读本机会话的出站适配器（session-reference）也要用它，而后端的
 * eslint 边界不允许出站适配器依赖 services 层。</p>
 */

/**
 * 一段输出被掐头去尾时的分隔标记；前后各留一个空格，截断处才不会粘成一个词。客户端已不再生成它，
 * 但云端的防御截断与早先上传的副本里仍会出现。
 */
export const OUTPUT_TRUNCATION_MARKER = " …[omitted]… ";

/** 一步上传内容：只有摘要，原文仍在来源 Agent 的记录里。 */
export interface ToolStep {
  /** 工具名，至多 100 字；整次调用被丢弃的合并步是空串。 */
  name: string;
  /** 入参摘要，压成一行。 */
  input: string;
  /** 成功的调用为空；失败的调用是一两行原因。早先上传的副本里可能是掐过头尾的整段输出。 */
  output: string;
  /** 这一步被降级改过（入参或原因被压短、输出被清空）。 */
  truncated?: boolean;
  /** 这次调用失败；成功或判断不了时没有这个字段。 */
  failed?: true;
}

/** 读取阶段拿到的一次调用：入参与输出可能是原文、对象或一段 JSON 文本。 */
export interface RawToolCall {
  name: string;
  input?: unknown;
  output?: unknown;
  /** 渲染消息里的 {@code Status:} 值，只在来源 Agent 写了状态时才有。 */
  status?: string;
  /** 原生调用 id，只用于把 call 与 result 配成一条；不上传。 */
  callId?: string;
}

/** 一条共享会话的一轮：读取、上传与降级都只认这几个字段。 */
export interface DigestTurn {
  question: string;
  reply: string;
  steps: ToolStep[];
  startedAt: string;
  /** 这一轮之前云端的降级略去了 N 轮。 */
  omittedBefore?: number;
}

/** 工具名最多留多少字：异常长的名字只会稀释摘要。 */
export const MAX_STEP_NAME_CHARS = 100;
/** 入参摘要最多多少字。 */
export const STEP_INPUT_CHARS = 200;
/** 失败原因最多几行、每行多少字：一行报错加一行退出码，够接手的人判断哪里出了问题。 */
export const FAILURE_LINES = 2;
export const FAILURE_LINE_CHARS = 200;
/** 一轮最多几步，超出只说明这一步是防御上限——正常任务一轮几十步。 */
export const MAX_TURN_STEPS = 1_000;
/** 超过这个步数时保留的头部步数（尾部为 {@link MAX_TURN_STEPS} 减它再减一个占位步）。 */
const TURN_HEAD_STEPS = 500;
/** 整条会话上传前的字节预算：给云端的标题等元数据留出余量，云端上限是 2,000,000。 */
export const SESSION_BUDGET_BYTES = 1_800_000;

/**
 * 上传预算的各级降级：先清空成功步骤的输出（只有早先的副本才有），再把失败原因压成一行、入参压到 80 字，
 * 最后才丢步。
 */
type BudgetLevel = "success-output" | "failed-output" | "input" | "steps";

const BUDGET_LEVELS: readonly BudgetLevel[] = ["success-output", "failed-output", "input", "steps"];

/** 降级时失败原因留多少字、入参留多少字、一轮头尾各保留多少步。 */
const LEVEL_FAILED_CHARS = 120;
const LEVEL_INPUT_CHARS = 80;
const LEVEL_TURN_HEAD_STEPS = 10;

/** 渲染消息里的 {@code Status:} 值可能是这些之一，表示这次调用没有正常完成。 */
const FAILED_STATUSES = new Set(["failed", "error", "errored", "cancelled", "canceled", "interrupted", "incomplete"]);

/**
 * 退出码写在输出里的几种格式：Codex 与 Memmy 自己的 exec 用它，Claude Code 的 Bash 也常带。
 * 标签的大小写各来源不一致（WorkBuddy 写 {@code Exit Code:}），所以不区分大小写。
 * Codex 的结果是嵌在 JSON 字符串里的 JSON，引号带反斜杠（{@code \"exit_code\":1}），两种写法都要认。
 */
const EXIT_CODE_PATTERNS: readonly RegExp[] = [
  /(?:^|\n)\s*exit code:\s*(-?\d+)/giu,
  /(?:^|\n)\s*(?:process|command) exited with code\s+(-?\d+)/giu,
  /\\?"(?:exit_code|exitCode)\\?"\s*:\s*(-?\d+)/gu
];

/** 报错的那一行：非空的 Stderr、Error / XxxError / XxxException、fatal、panic、npm ERR!。 */
const ERROR_LINE = /^(?:stderr\s*:\s*\S|[\w.]*(?:error|exception)\b|fatal\b|panic\b|npm err!)/iu;
/** Python 的调用栈：真正的原因在最后一行异常上，不在 Traceback 那一行。 */
const TRACEBACK_LINE = /^traceback\b/iu;
const EXCEPTION_LINE = /^[\w.]*(?:error|exception)\b/iu;
/** 退出码与信号：没有报错正文时，它就是失败的原因（例如超时被 SIGTERM 杀掉）。Proma 写 {@code Command exited with code 1}。 */
const EXIT_LINE = /^(?:exit code|(?:process|command) exited with code|signal)\b\s*:?\s*\S/iu;
/**
 * 不是原因的行：命令回显（WorkBuddy 把命令写在输出第一行）、空的 Stdout / Stderr / Signal、
 * Codex 包在结果外面的说明行，以及 Memmy exec 自己补的提示。
 */
const NOT_A_REASON = new RegExp(
  [
    "^(?:command|cwd|directory)\\s*:",
    "^\\w+\\s*:\\s*\\((?:empty|none)\\)\\s*$",
    "^(?:script completed|wall time\\b|output:\\s*$|total output lines:|warning: truncated output)",
    "^error:\\s*command exited with",
    "^\\[analyze the error"
  ].join("|"),
  "iu"
);
/** 结果对象里可能装着正文的字段，按这个顺序取：报错在前，普通输出在后。 */
const RESULT_TEXT_FIELDS = ["error", "stderr", "output", "text", "content", "stdout", "message"] as const;
/** WorkBuddy 一类输出的分段标签；标签之后没有标签的行仍属于这一段。 */
const SECTION_LABEL = /^(stdout|stderr|command|exit code|signal)\s*:/iu;
/**
 * 说明出了什么问题的词。只用来在失败输出里挑原因行，不用来判断是否失败；标准输出一段里也只有带着它们的行才算，
 * 比如 grep 列出的文件就不是原因，测试工具写在标准输出里的 FAILED 才是。
 */
const FAILURE_WORD = /\b(?:fail(?:ed|ure|s)?|errors?|exception|no such file|not found|denied|cannot|can't|unable|invalid|refused|timed? ?out|killed)\b/iu;

/** 入参里先取哪几个字段当要点；顺序就是一句调用最想看到的东西的先后。 */
const INPUT_KEY_PARAMS = ["command", "cmd", "file_path", "filePath", "path", "notebook_path", "pattern", "query", "url"] as const;

/** 命令开头的 `cd <目录> &&`：只是切目录，读者要看的是后面真正跑的那条。 */
const CD_PREFIX = /^\s*cd\s+(?:"[^"]*"|'[^']*'|[^\s&]+)\s*&&\s*/u;

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
  status?: string;
  input?: string;
  output?: string;
}

/**
 * 把同一 toolCallId 的 call 与 result 合成一条。原生记录里一次调用会写两条消息，不合并就会算成两步。
 *
 * <p>先把一字不差的重复行去掉（会话续写、请求快照重放），再去配对：id 缺失、或同一 id 去重后仍然多于两条
 * （并行同名调用、同一 id 写了不同内容）时不合并，各自独立成条——位置相近不代表是一对，按位置配对会把
 * 两次调用的入参和别人的输出拼在一起。</p>
 *
 * <p>状态跟着合并：call 与 result 任一条说失败，这次调用就是失败的。</p>
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
      calls.push(mergeCall(message, {}));
      continue;
    }
    const other = unique[mate]!;
    calls.push(mergeCall(message, other));
  }
  return calls;
}

/**
 * 一条独立的消息、或一对 call 与 result：工具名优先取前一条。状态先取说失败的那条——Codex 的 call 自带
 * `completed`，失败只写在 result 上，按先后取会把失败的调用当成成功。
 */
function mergeCall(message: RenderedToolMessage, other: RenderedToolMessage): RawToolCall {
  const callId = message.callId?.trim();
  const status = [message.status, other.status].find((value) => isFailedStatus(value)) ?? firstText(message.status, other.status);
  return {
    ...(callId ? { callId } : {}),
    // call 消息带着工具名，result 消息只有输出；两个都有时取前一个。
    name: firstText(message.name, other.name),
    input: firstText(message.input, other.input),
    output: firstText(message.output, other.output),
    ...(status ? { status } : {})
  };
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

/** 回合读完：把攒下的 call 与 result 合并、逐条压成步骤。没有工具调用时什么都不改。 */
export function finalizeTurnSteps(turn: { steps: ToolStep[] }): void {
  const messages = pendingTools.get(turn);
  if (!messages) return;
  pendingTools.delete(turn);
  turn.steps = shapeToolSteps(mergeToolMessages(messages));
}

/** 把一轮的原始调用逐条压成上传用的步骤：每次调用都留一步，不在这里丢。没有调用时返回空数组。 */
export function shapeToolSteps(calls: readonly RawToolCall[]): ToolStep[] {
  return calls.map(shapeStep);
}

/**
 * 一次调用的一步：成功的只留「做了什么」，失败的再附一两行原因。入参与原因本来就是摘要，
 * 裁到上限不算压缩，不标 truncated。
 */
function shapeStep(call: RawToolCall): ToolStep {
  const name = clip(collapse(serialize(call.name)), MAX_STEP_NAME_CHARS);
  const input = clip(inputDigest(call.input), STEP_INPUT_CHARS);
  const output = serialize(call.output);
  const failed = isFailedCall(call.status, output);
  return {
    name,
    input,
    output: failed ? failureExcerpt(output) : "",
    ...(failed ? { failed: true } : {})
  };
}

/**
 * 失败输出里的一两行原因：先找报错行（Python 调用栈取最后一行异常），再补一行退出码或信号；
 * 都没有就取第一行正文。命令回显、空的 Stdout 这类行不算原因。
 * Codex 的结果是嵌套 JSON，先拆开拿到里面的正文与退出码。
 */
export function failureExcerpt(output: string): string {
  const { text, exitCode } = unwrapResult(output);
  const lines = reasonCandidates(text);
  const exitLines = lines.filter((line) => EXIT_LINE.test(line));
  if (!exitLines.length && exitCode !== undefined && exitCode !== 0) exitLines.push(`Exit code: ${exitCode}`);
  // 没有报错正文时，退出码与信号就是原因：137 后面的 SIGTERM 才说明是超时被杀。
  const reason = failureLine(lines, exitLines.length > 0);
  const picked = reason ? [reason, ...exitLines] : exitLines;
  return picked.slice(0, FAILURE_LINES).map((line) => clip(line, FAILURE_LINE_CHARS)).join("\n");
}

/**
 * 可能是原因的行：去掉命令回显、空段与包装说明；标准输出一段里只留提到失败的行。
 * 没有分段标签的输出（Claude Code、Codex）每一行都算。
 */
function reasonCandidates(text: string): string[] {
  const candidates: string[] = [];
  let section = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const label = SECTION_LABEL.exec(line)?.[1]?.toLowerCase();
    if (label) section = label;
    if (NOT_A_REASON.test(line) || section === "command") continue;
    if (section === "stdout" && !FAILURE_WORD.test(line)) continue;
    candidates.push(line);
  }
  return candidates;
}

/** 失败原因的第一行：骨架里跟在失败步骤后面的那一句。早先上传的整段输出也按同一套办法摘。 */
export function failureReason(output: string, maxChars: number): string {
  return clip(failureExcerpt(output).split("\n")[0] ?? "", maxChars);
}

/**
 * 原因行：Python 调用栈取最后一行异常，再找报错行、带着问题词的行。都没有时，有退出码就只用退出码——
 * 输出的第一行多半是命令的正常输出（一个目录名、一个 0），当成原因反而误导；没有退出码才取第一行。
 */
function failureLine(lines: readonly string[], hasExitLine: boolean): string | undefined {
  const traceback = lines.findIndex((line) => TRACEBACK_LINE.test(line));
  if (traceback >= 0) {
    const raised = lines.slice(traceback + 1).filter((line) => EXCEPTION_LINE.test(line)).at(-1);
    if (raised) return raised;
  }
  const text = lines.filter((line) => !EXIT_LINE.test(line));
  return text.find((line) => ERROR_LINE.test(line))
    ?? text.find((line) => FAILURE_WORD.test(line))
    ?? (hasExitLine ? undefined : text[0]);
}

/**
 * 把结果里嵌着的 JSON 拆成正文：Codex 的一次 exec 是「内容数组 → 文本里的 JSON 对象 → output 字段」，
 * 前面可能还有几行说明。解析不了就按原文处理。
 */
function unwrapResult(output: string): { text: string; exitCode?: number } {
  let exitCode: number | undefined;
  const visit = (value: unknown, depth: number): string => {
    if (depth > 4) return typeof value === "string" ? value : compactJson(value);
    if (typeof value === "string") {
      const at = value.search(/(?:^|\n)\s*[{[]/u);
      if (at < 0) return value;
      try {
        const nested = visit(JSON.parse(value.slice(at)), depth + 1);
        return [value.slice(0, at), nested].filter((part) => part.trim()).join("\n");
      } catch {
        return value;
      }
    }
    if (Array.isArray(value)) return value.map((item) => visit(item, depth + 1)).filter(Boolean).join("\n");
    if (!isRecord(value)) return serialize(value);
    const code = value.exit_code ?? value.exitCode;
    if (typeof code === "number" && exitCode === undefined) exitCode = code;
    const parts = RESULT_TEXT_FIELDS
      .filter((field) => value[field] !== undefined && value[field] !== null && value[field] !== "")
      .map((field) => visit(value[field], depth + 1));
    return parts.length ? parts.join("\n") : compactJson(value);
  };
  return { text: visit(output, 0), ...(exitCode === undefined ? {} : { exitCode }) };
}

/**
 * 这次调用是否失败。只看确定的信号，不从正文里找 error/failed 这类词：一次成功的 grep 也常带这些词。
 * ① 渲染消息的 {@code Status:} 是 failed/error 一类；② 输出里的退出码不为 0。
 */
export function isFailedCall(status: string | undefined, output: string): boolean {
  return isFailedStatus(status) || hasFailedExitCode(output);
}

function isFailedStatus(status: string | undefined): boolean {
  const normalized = status?.trim().toLowerCase();
  return Boolean(normalized && FAILED_STATUSES.has(normalized));
}

function hasFailedExitCode(output: string): boolean {
  if (!output) return false;
  for (const pattern of EXIT_CODE_PATTERNS) {
    for (const match of output.matchAll(pattern)) {
      if (Number.parseInt(match[1] ?? "", 10) !== 0) return true;
    }
  }
  return false;
}

/**
 * 一轮的步数上限：正常任务一轮几十步，超过一千只可能是记录异常。
 * 保留前 {@link TURN_HEAD_STEPS} 步和后 499 步，中间那一次调用换成占位步——读者至少知道这里少了东西，
 * 而不是以为当时没调用。
 */
export function capSteps(steps: readonly ToolStep[], maxSteps: number = MAX_TURN_STEPS): ToolStep[] {
  if (steps.length <= maxSteps) return [...steps];
  const head = Math.min(TURN_HEAD_STEPS, maxSteps - 1);
  const tail = maxSteps - head - 1;
  const omitted = steps.length - head - tail;
  return [...steps.slice(0, head), omittedStep(omitted), ...(tail > 0 ? steps.slice(-tail) : [])];
}

/** 整次调用被丢弃时的那一步：没有工具名，只有一句说明。 */
export function omittedStep(count: number): ToolStep {
  return { name: "", input: "", output: `[... ${count} tool calls omitted ...]` };
}

/** 占位步里的次数；不是占位步时返回 0。 */
export function omittedCount(step: ToolStep): number {
  if (step.name) return 0;
  return Number(/\[\.\.\.\s*(\d+)\s+tool calls omitted\s*\.\.\.\]/iu.exec(step.output)?.[1] ?? 0);
}

/**
 * 整条会话的上传预算：按 {@code JSON.stringify} 后的 UTF-8 字节数计量，超出后逐级降级，
 * 每一级都从最早的轮次往后处理，每处理完一轮重新计量、一不超就停。
 *
 * <p>先清空成功步骤的输出（现在生成的步骤本来就没有，只有早先的副本才有），再把失败原因压成一行、
 * 入参压到 80 字，最后才丢步。{@code question} 与 {@code reply} 永远不动：那是成员真正要读的内容。</p>
 *
 * <p>各级做完还超限就原样返回，交给云端合并轮次。轮次是就地改的，调用方拿到的就是同一份。</p>
 */
export function fitSessionBudget<T extends DigestTurn>(turns: T[], targetBytes: number = SESSION_BUDGET_BYTES): T[] {
  let total = byteLength(turns);
  if (total <= targetBytes) return turns;
  for (const level of BUDGET_LEVELS) {
    for (const turn of turns) {
      const before = byteLength(turn);
      degradeTurn(turn, level);
      const after = byteLength(turn);
      if (after >= before) continue;
      total -= before - after;
      if (total <= targetBytes) return turns;
    }
  }
  return turns;
}

/** 按一级降级处理一轮；没有可改的地方就原样留着。 */
function degradeTurn(turn: DigestTurn, level: BudgetLevel): void {
  if (level === "steps") {
    if (turn.steps.length <= LEVEL_TURN_HEAD_STEPS * 2) return;
    const head = turn.steps.slice(0, LEVEL_TURN_HEAD_STEPS);
    const tail = turn.steps.slice(-LEVEL_TURN_HEAD_STEPS);
    turn.steps = [...head, omittedStep(turn.steps.length - head.length - tail.length), ...tail];
    return;
  }
  turn.steps = turn.steps.map((step) => {
    // 占位步本身就是一句话，没有可压的正文。
    if (!step.name) return step;
    if (level === "success-output") {
      if (step.failed || !step.output) return step;
      return { ...step, output: "", truncated: true };
    }
    if (level === "failed-output") {
      if (!step.failed) return step;
      const output = failureReason(step.output, LEVEL_FAILED_CHARS);
      return output === step.output ? step : { ...step, output, truncated: true };
    }
    const input = clip(step.input, LEVEL_INPUT_CHARS);
    return input === step.input ? step : { ...step, input, truncated: true };
  });
}

/**
 * 入参摘要：先取关键参数（命令、路径、模式这些一眼看出这次调用做了什么），其余字段按 JSON 紧凑序列化
 * 接在后面，压成一行。找不到任何关键参数时就是整个入参的 JSON——总比只有工具名强。
 */
function inputDigest(value: unknown): string {
  const parsed = structuredInput(value);
  if (!isRecord(parsed)) return collapse(serialize(parsed));
  const keyNames = new Set<string>();
  const leading: string[] = [];
  for (const name of INPUT_KEY_PARAMS) {
    if (!Object.hasOwn(parsed, name)) continue;
    keyNames.add(name);
    const part = paramText(parsed[name]);
    if (!part) continue;
    leading.push(name === "command" || name === "cmd" ? part.replace(CD_PREFIX, "") : part);
  }
  const rest = Object.fromEntries(Object.entries(parsed).filter(([name]) => !keyNames.has(name)));
  const restText = Object.keys(rest).length ? compactJson(rest) : "";
  const digest = collapse([leading.join(" "), restText].filter(Boolean).join(" "));
  // 参数都在、但值都是空的（`{}`、`{"command":""}`）：留一句原文，读者才知道当时确实带了参数。
  return digest || compactJson(parsed);
}

/** 一个参数值写成一句：数组用空格拼接，对象按 JSON，其余按原文。 */
function paramText(value: unknown): string {
  if (Array.isArray(value)) return value.map(paramText).filter(Boolean).join(" ");
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return compactJson(value);
  return String(value).trim();
}

/** 入参本身常是一段 JSON 文本（Memmy 的任务记录、各 Agent 的 arguments）：能解析就按对象处理。 */
function structuredInput(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) return trimmed;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

/** 字符串原样、其余按 JSON 序列化，和 renderTool 的 format 一致。 */
function serialize(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return compactJson(value);
}

function compactJson(value: unknown): string {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const encoder = new TextEncoder();

function byteLength(value: unknown): number {
  return encoder.encode(JSON.stringify(value) ?? "").length;
}
