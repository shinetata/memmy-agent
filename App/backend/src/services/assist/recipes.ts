/**
 * 内置 Agent 的启动配方。
 *
 * <p>内置 Agent 大多能走 ACP（Agent Client Protocol）：六个原生支持，另外三个（Claude Code、
 * Codex、Pi）有现成的适配器。配方只描述「用哪个程序、带什么参数、要不要补环境变量」，
 * 协议交互都在 {@link ./acp-client}。</p>
 *
 * <p>这些程序的入口有一半来自桌面端自带的引擎或隐藏参数，对方升级后可能变化；因此每个配方都可以用
 * 环境变量覆盖（见 {@link ASSIST_COMMAND_ENV}），出问题时不必改代码。</p>
 */
import { readdirSync } from "node:fs";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, type posix } from "node:path";

import { adapterFor, bundledAdapterPath, installedAdapterPath } from "./adapters.js";
import type { DeepSeekHarnessOptions } from "./deepseek-harness.js";
import { DEEPSEEK_HARNESS_SOURCE_ID, resolveDeepSeekHarness } from "./deepseek-harness.js";
import { ASSIST_COMMAND_ENV, findExecutable, pathForPlatform, splitCommandLine } from "./executables.js";

// 命令查找与覆盖用的环境变量拆到 ./executables：deepseek-harness 也要用，放在这里会形成环依赖。
export { ASSIST_COMMAND_ENV, findExecutable } from "./executables.js";

/** 一个执行方怎么被拉起来：命令、参数、追加的环境变量。 */
export interface AssistRecipe {
  /** 内置来源的 sourceId，与协作项目「在其他 Agent 中使用协作项目」里的标识一致。 */
  sourceId: string;
  /** 界面上显示的名字。 */
  name: string;
  command: string;
  args: readonly string[];
  /** 需要补的环境变量：有的 Agent 要靠它读取自己的配置。 */
  env?: Readonly<Record<string, string>>;
  /** 工作目录不方便指定时（CLI 固定工作目录），改用 ACP 的 cwd 告知。 */
  cwdHint?: string;
  /** 会话建好后要设的 ACP 会话选项（configId → 值或显示名），见 {@link ./acp-client} 的 sessionConfig。 */
  sessionConfig?: Readonly<Record<string, string>>;
  /**
   * 协助执行时把它设成哪个模式（见 {@link ./acp-client} 的 sessionMode）：为的是让 Agent 自己的「帮我批准」生效，
   * 而不是沿用她平时可能关掉了批准的设置。
   */
  sessionMode?: Readonly<{ configId: string; value: string; fallback?: string }>;
  /**
   * 协助执行时它会不会对危险操作发批准请求（ACP 的 {@code session/request_permission}）。
   * 值为 false 的 Agent 执行时没有「帮我批准」这一层，请求只能由她看过再决定要不要自动执行。
   */
  asksForApproval: boolean;
}

/**
 * 各内置 Agent 的 ACP 入口。按内置来源的 sourceId 索引。
 *
 * <p>取不到配方时不猜，直接作为失败告诉双方（「王雨的 Cursor 未启动」），让人换个 Agent 或去修。</p>
 */
const RECIPES: readonly AssistRecipe[] = [
  // 这三个要适配器把 ACP 翻成它们自己的接口；适配器由 Memmy 在授权后自己装（见 ./adapters）。
  // Claude Code 的适配器有 mode 选项：协助执行时设为 auto（Auto review，有风险的操作请求批准），
  // 模型不支持 auto 时适配器会退到 acceptEdits（改动不再询问），因此设完读回当前值，不是 auto 就改设 default。
  {
    sourceId: "claude_code",
    name: "Claude Code",
    command: "claude-agent-acp",
    args: [],
    sessionMode: { configId: "mode", value: "auto", fallback: "default" },
    asksForApproval: true
  },
  // Codex 的模式由环境变量给出：agent = Auto review（只对判为有风险的操作请求批准，工作区可写、断网沙箱）。
  // 续跑时同样设一次：session/load 接回的是她原来那个会话，模式要跟着协助走。
  {
    sourceId: "codex",
    name: "Codex",
    command: "codex-acp",
    args: [],
    // 新会话靠 INITIAL_AGENT_MODE 进 Auto review；续跑是接回她原来那个会话，模式不跟着来，这里再设一次。
    env: { INITIAL_AGENT_MODE: "agent" },
    sessionMode: { configId: "mode", value: "agent", fallback: "read-only" },
    asksForApproval: true
  },
  // Cursor 的 ACP 入口是隐藏参数：帮助里看不到，但可以直接用。
  // 模型统一用 Auto（ACP 里的值是 `default[]`）：CLI 的模型选择存在 ~/.cursor/cli-config.json，与 IDE 里选的不是一份，
  // 而 Cursor 自家模型与其他模型分开计额度，CLI 里选的模型可能恰好没有额度（2026-11-05 实测：Other Models 用尽时
  // kimi-k3 只回「Upgrade your plan to continue」，Auto 正常）。
  {
    sourceId: "cursor",
    name: "Cursor",
    command: "cursor-agent",
    args: ["acp"],
    sessionConfig: { model: "default[]" },
    asksForApproval: false
  },
  { sourceId: "opencode", name: "OpenCode", command: "opencode", args: ["acp"], asksForApproval: false },
  // OpenClaw 的 CLI 工作目录固定，改由 ACP 的 cwd 指定。
  { sourceId: "openclaw", name: "OpenClaw", command: "openclaw", args: ["acp"], cwdHint: "acp", asksForApproval: false },
  { sourceId: "hermes", name: "Hermes", command: "hermes", args: ["acp"], asksForApproval: false },
  // WorkBuddy 暂不支持执行协助（2026-11-05 下线）：原配方 `codebuddy --acp` 拉起的是另外安装的 CodeBuddy 命令行，
  // 账号、额度都不是 WorkBuddy 的；WorkBuddy 自带的引擎由桌面端带着内部参数与账号拉起，单独走 ACP 没有响应。
  // 等有稳定的调用方式再加回来。
  // QwenWork 用桌面端包内的 Qoder 引擎，ACP 同样是隐藏参数。
  // 引擎不在 PATH 上，装在应用包里（见 {@link qwenWorkEngine}），找不到时由它补上绝对路径。
  { sourceId: "qwenwork", name: "QwenWork", command: "qoderclicn", args: ["--acp"], asksForApproval: false },
  // DeepSeek Harness 的一次性模式不能续跑，协助统一走 ACP。真正的入口与参数由 ./deepseek-harness 解析：
  // 桌面版自带的引擎优先，其次是版本够新的 dsh 命令行，并且要叠上桌面版的模型补丁。
  {
    sourceId: DEEPSEEK_HARNESS_SOURCE_ID,
    name: "DeepSeek Harness",
    command: "dsh",
    args: ["--profile", "acp"],
    asksForApproval: false
  },
  // Pi 的适配器只在扩展弹窗时请求批准，工具执行不请求：协助执行时要她看过再决定（2026-11-13 核实 pi-acp 0.0.34）。
  { sourceId: "pi", name: "Pi", command: "pi-acp", args: [], asksForApproval: false }
];

/** 执行方标识里 Memmy 自己不用 ACP：它在项目下新建一条 Memmy 任务执行（见 {@link ./memmy-runner}）。 */
export const MEMMY_SOURCE_ID = "memmy";

export interface AssistAgentRecipe extends AssistRecipe {
  /** 实际要执行的命令；环境变量覆盖时用覆盖后的值。 */
  resolved: string;
}

/**
 * 取某个 Agent 的配方。命令找不到时先看环境变量覆盖，再在常见目录里找一次；
 * 都没有就返回配方本身（命令仍是原始值），由调用方把「未安装」变成给双方看的失败原因。
 */
export function assistRecipe(sourceId: string, env: NodeJS.ProcessEnv = process.env): AssistAgentRecipe | null {
  const base = RECIPES.find((recipe) => recipe.sourceId === sourceId);
  if (!base) return null;
  const override = env[ASSIST_COMMAND_ENV(sourceId)]?.trim();
  if (override) {
    // 带空格的路径必须包在引号里（Windows 的默认安装位置就带空格），否则会在空格处被拆开。
    const [command, ...args] = splitCommandLine(override);
    if (command) return { ...base, resolved: command, args };
  }
  return { ...base, resolved: base.command };
}

/** 这台电脑上可以拿来执行的 Agent：只列配置了配方且能运行的，界面用它说明「可用」。 */
export function availableAssistAgents(
  env: NodeJS.ProcessEnv = process.env,
  options: AssistRunnableOptions = {}
): AssistAgentRecipe[] {
  return RECIPES.map((recipe) => assistRecipe(recipe.sourceId, env))
    .filter((recipe): recipe is AssistAgentRecipe => recipe !== null && assistRunnable(recipe.sourceId, env, options));
}

/**
 * 靠适配器接入 ACP 的 Agent 里，本体命令行是跑起来的必要条件的那一个：
 * Pi 的适配器驱动的是 {@code pi} 本体，本体不在就装上也跑不起来。
 *
 * <p>Claude Code 与 Codex 不在这里：它们的适配器自带引擎（适配器自己依赖 claude / codex 的可执行包），
 * 只装了 Claude App 或 Codex App（引擎在应用包里）的人命令行上并没有 {@code claude} / {@code codex}，
 * 按本体命令行判断会把他们错判成不可用。这两个看成「适配器已装好，或者能现场装」。</p>
 */
const BODY_COMMANDS: Readonly<Record<string, string>> = Object.freeze({
  pi: "pi"
});

/**
 * 走适配器的那两个 Agent，真正决定「能不能跑」的是引擎：
 * Claude Code 的引擎是 {@code claude}，Codex 的是 {@code codex}。
 * 适配器本身由 Memmy 自己准备（自带或现场装），不看这台电脑有没有 npm / node。
 */
const ADAPTER_ENGINE_COMMANDS: Readonly<Record<string, string>> = Object.freeze({
  claude_code: "claude",
  codex: "codex"
});

/** 判断「能不能运行」时可以让测试注入的位置，正式运行按默认位置找。 */
export interface AssistRunnableOptions extends Pick<DeepSeekHarnessOptions, "appDirs" | "dshHome"> {
  /** 适配器与协助状态目录，默认 {@code MEMMY_HOME} 或 {@code ~/.memmy}。 */
  home?: string;
  /** QwenWork 应用包的位置，按顺序找；测试可注入。 */
  qwenWorkAppDirs?: readonly string[];
  /** 按哪个平台找命令，默认当前进程；测试里用来验证 Windows 的安装位置。 */
  platform?: NodeJS.Platform;
  /** 只在测试里替换「文件在不在」的判断（Windows 的 `C:\…` 在其他平台上打不开）。 */
  exists?: (path: string) => boolean;
}

/**
 * QwenWork 桌面端应用包的默认位置。
 *
 * <p>macOS 是 {@code .app} 包；Windows 是用户级安装器装出来的普通目录
 * {@code %LOCALAPPDATA%\Programs\QwenWorkCN}，应用本体在版本子目录里
 * （形如 {@code QwenWorkCN\2.0.2\QwenWorkCN.exe}），所以这一层只是「根」，
 * 真正找引擎时会再枚举一层版本目录（见 {@link qwenWorkEngine}）。</p>
 */
export function defaultQwenWorkAppDirs(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  if (platform === "win32") {
    const path = pathForPlatform("win32");
    const local = env.LOCALAPPDATA?.trim() || path.join(homedir(), "AppData", "Local");
    return [path.join(local, "Programs", "QwenWorkCN")];
  }
  return ["/Applications/QwenWorkCN.app", join(homedir(), "Applications", "QwenWorkCN.app")];
}

/** 引擎在 macOS 应用包里的位置：{@code Contents/Resources/bin/qoderclicn}。 */
const QWENWORK_ENGINE_MACOS = join("Contents", "Resources", "bin", "qoderclicn");

/** 引擎在 Windows 应用目录里的位置：{@code resources\bin\qoderclicn.exe}。 */
const QWENWORK_ENGINE_WINDOWS = ["resources", "bin", "qoderclicn.exe"];

/** Windows 应用根目录下最多往下看几层版本目录：正常只有一层，留点余量不写死。 */
const QWENWORK_WINDOWS_MAX_DEPTH = 2;

/**
 * QwenWork 的引擎：这个程序既不在 PATH 上，也不在常见命令目录里，只在应用包里。
 * 找不到时返回 null，由调用方把「没装」变成给双方看的失败原因。
 *
 * <p>Windows 上要多走一步：应用本体在版本子目录里（升级后目录名会变），
 * 所以从根目录往下枚举一层，找带 {@code resources\bin\qoderclicn.exe} 的那一层。
 * 不按版本号排序猜路径，是为了升级后不用改代码。</p>
 */
export function qwenWorkEngine(
  env: NodeJS.ProcessEnv = process.env,
  appDirs: readonly string[] = defaultQwenWorkAppDirs(),
  options: Pick<AssistRunnableOptions, "platform" | "exists"> = {}
): string | null {
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const onPath = findExecutable("qoderclicn", env, {
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.exists === undefined ? {} : { exists: options.exists })
  });
  if (onPath) return onPath;
  const path = pathForPlatform(platform);
  for (const appDir of appDirs) {
    const root = appDir.replace(/[\\/]+$/u, "");
    if (platform !== "win32") {
      const engine = path.join(root, QWENWORK_ENGINE_MACOS);
      if (findExecutable(engine, env)) return engine;
      continue;
    }
    // Windows：根目录本身与它下面的版本子目录都看一遍。
    const candidates = qwenWorkEngineCandidates(root, findQwenWorkVersionDirectories(root, exists));
    for (const engine of candidates) {
      if (exists(engine)) return engine;
    }
  }
  return null;
}

/** 应用根目录下的版本子目录名；读不到（目录不存在、权限不足）时给空列表，不猜。 */
function findQwenWorkVersionDirectories(root: string, exists: (path: string) => boolean): string[] {
  if (!exists(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .slice(0, QWENWORK_WINDOWS_MAX_DEPTH * 16);
  } catch {
    return [];
  }
}

/**
 * Windows 上一个 QwenWork 应用根目录里要试的引擎路径：先根目录本身，再各版本子目录。
 *
 * <p>单独抽出来是为了能测：真实目录枚举在 macOS 上读不到 `C:\…`，而这条拼法正是最容易写错的地方。</p>
 */
export function qwenWorkEngineCandidates(root: string, versionDirectories: readonly string[] = []): string[] {
  const path = pathForPlatform("win32");
  const base = root.replace(/[\\/]+$/u, "");
  return [
    path.join(base, ...QWENWORK_ENGINE_WINDOWS),
    ...versionDirectories.map((version) => path.join(base, version, ...QWENWORK_ENGINE_WINDOWS))
  ];
}

/**
 * 这个 Agent 在这台电脑上能不能运行：有环境变量覆盖时看覆盖的命令；需要适配器的看适配器（已装好，
 * 或者有 npm 与 node 能现场装；Pi 另看本体命令行）；QwenWork 看应用包里的引擎；DeepSeek Harness 看
 * 桌面版或够新的命令行；其余看配方里的命令本身。没有配方的（用户自己添加的 Agent）一律不能由 Memmy 拉起。
 *
 * <p>这里不看「有没有登录」：未登录的 Agent 在执行时由 Memmy 代为发起登录（见 ./login），
 * 从候选里剔掉会让只差一次登录的人找不到它。</p>
 */
/** 把测试注入的查找条件传给 {@link findExecutable}。 */
function lookupOptions(options: AssistRunnableOptions): { platform?: NodeJS.Platform; exists?: (path: string) => boolean } {
  return {
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.exists === undefined ? {} : { exists: options.exists })
  };
}

export function assistRunnable(
  sourceId: string,
  env: NodeJS.ProcessEnv = process.env,
  options: AssistRunnableOptions = {}
): boolean {
  if (sourceId === MEMMY_SOURCE_ID) return true;
  const recipe = assistRecipe(sourceId, env);
  if (!recipe) return false;
  if (env[ASSIST_COMMAND_ENV(sourceId)]?.trim()) return findExecutable(recipe.resolved, env, lookupOptions(options)) !== null;
  // DeepSeek Harness 的入口不止 PATH 上一个命令：桌面版自带的引擎能跑就够（见 ./deepseek-harness）。
  if (sourceId === DEEPSEEK_HARNESS_SOURCE_ID) return resolveDeepSeekHarness({ ...options, env }).ok;
  if (sourceId === "qwenwork") {
    // 平台与存在性判断要传下去：否则 qwenWorkEngine 会读 process.platform，Windows 的路径在测试里永远验不到。
    const appDirs = options.qwenWorkAppDirs
      ?? defaultQwenWorkAppDirs(options.platform ?? process.platform, env);
    return qwenWorkEngine(env, appDirs, options) !== null;
  }
  const body = BODY_COMMANDS[sourceId];
  if (body) return findExecutable(body, env, lookupOptions(options)) !== null;
  const adapter = adapterFor(sourceId);
  if (adapter) {
    // 安装包里自带的那份（或之前装好的）：不必联网、也不必等第一次执行。
    if (bundledAdapterPath(adapter, env) !== null) return true;
    if (installedAdapterPath(adapter, options.home) !== null) return true;
    // 适配器由 Memmy 自己准备，用不到对方的 npm / node（见 ./adapters 的 adapterLaunch）。
    // 要判断的是引擎在不在：引擎用这台电脑上已经装好的那一份，没有就真的跑不起来。
    const engine = ADAPTER_ENGINE_COMMANDS[sourceId];
    if (engine) return findExecutable(engine, env, lookupOptions(options)) !== null;
    return false;
  }
  return findExecutable(recipe.command, env, lookupOptions(options)) !== null;
}

/** 已知的 Agent 名：失败原因要说清是哪个 Agent 起不来。下线的也留着名字，旧记录里仍然按名字显示。 */
const RETIRED_NAMES: Readonly<Record<string, string>> = Object.freeze({ workbuddy: "WorkBuddy" });

/**
 * 这个执行方在协助执行时会不会对危险操作发批准请求。Memmy 自己走第五节的那条检查，等同于是；
 * 没有配方或已下线的（用户自己添加的 Agent）一律按不会。
 */
export function assistAsksForApproval(sourceId: string): boolean {
  if (sourceId === MEMMY_SOURCE_ID) return true;
  return RECIPES.find((recipe) => recipe.sourceId === sourceId)?.asksForApproval === true;
}

export function assistAgentName(sourceId: string): string {
  if (sourceId === MEMMY_SOURCE_ID) return "Memmy";
  return RECIPES.find((recipe) => recipe.sourceId === sourceId)?.name ?? RETIRED_NAMES[sourceId] ?? sourceId;
}