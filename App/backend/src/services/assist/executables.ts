/**
 * 找可执行文件与启动命令的环境变量覆盖。
 *
 * <p>单独一层是为了避免环依赖：{@link ./recipes} 要用它判断「这个 Agent 能不能跑」，
 * 而 {@link ./deepseek-harness} 既要自己找入口、又要被 recipes 调用。</p>
 *
 * <p>平台差异集中在这里：macOS / Linux 用 `:` 分 PATH、命令就是文件本身；Windows 用 `;` 分 PATH、
 * PATH 上写的是不带后缀的命令名，真正能被执行的却是 `名字.cmd` / `名字.exe`，而 `.cmd` 又不能被 Node
 * 直接拉起。这三件事在下面各有对应函数，调用方不必自己判断平台。</p>
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

/**
 * 覆盖某个 Agent 的启动命令：`MEMMY_ASSIST_COMMAND_<SOURCE_ID>=…`，值按空格切成命令与参数。
 * 用于对方升级后路径变化的临时处置，不改代码。
 */
export function ASSIST_COMMAND_ENV(sourceId: string): string {
  return `MEMMY_ASSIST_COMMAND_${sourceId.toUpperCase().replace(/[^A-Z0-9]/gu, "_")}`;
}

/**
 * 按平台取 `node:path` 的实现。
 *
 * <p>不能直接用导入的 `delimiter` / `isAbsolute` / `join`：那些是**当前进程**平台的语义，
 * 测试里注入 `platform: "win32"`（在 macOS 上跑）时拿到的仍是 `/` 与 `:`，测不出 Windows 的真实行为。</p>
 */
export function pathForPlatform(platform: NodeJS.Platform): typeof posix {
  return platform === "win32" ? win32 : posix;
}

/**
 * 读环境变量：Windows 的变量名不分大小写，注入进来的测试对象却是普通对象，因此两种写法都认。
 *
 * <p>Windows 的环境块里通常写作 {@code Path}，而 `{...process.env}` 复制出来是普通对象、不再有
 * 大小写不敏感的代理——只读 {@code env.PATH} 会真的读不到，PATH 就丢了。</p>
 */
function rawEnvValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = env[name];
  if (direct) return direct;
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

/** 同上，去掉首尾空格：目录列表与单值（ComSpec、PATHEXT）用这一份。 */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return rawEnvValue(env, name)?.trim() || undefined;
}

/** macOS / Linux 的常见位置：PATH、Homebrew、以及各个包管理器的全局 bin。 */
const POSIX_LOOKUP_DIRS: readonly string[] = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  posix.join(homedir(), ".local", "bin"),
  posix.join(homedir(), ".bun", "bin"),
  posix.join(homedir(), ".cargo", "bin"),
  posix.join(homedir(), ".npm-global", "bin")
];

/**
 * 兼容旧的导出：macOS / Linux 的查找目录。
 * 需要按平台取目录时用 {@link lookupDirs}，Windows 有自己的列表。
 */
export const LOOKUP_DIRS: readonly string[] = POSIX_LOOKUP_DIRS;

/**
 * 各 Agent 自己的安装位置：命令行不在 PATH 上，也不在上一层目录里。
 *
 * <p>与 {@link lookupDirs} 的“常见目录”分开：那里是一层目录，这里是一个 App 的具体子目录，
 * 只有协议里认识的 Agent 才需要，不放到通用查找里免得每次找任何命令都多走一串不存在的路径。</p>
 *
 * <p>Windows 上的 Codex 来自官方安装脚本 `install.ps1` 的 `$defaultVisibleBinDir`
 * （`%LOCALAPPDATA%\Programs\OpenAI\Codex\bin`，已经实际下载脚本核对），它同时把这一层加进用户 PATH；
 * 但 Memmy 进程的 PATH 是启动那一刻的快照，装完 Codex 不重启 Memmy 就看不到，所以要显式找一遍。
 * 安装器自己的释放目录结构是 `%USERPROFILE%\.codex\packages\standalone\{releases,current}`（同一份脚本），
 * 没有 shim 时那里也有一份 `bin\codex.exe`。</p>
 *
 * <p>Cursor 的 CLI 由它自己的安装脚本装到 {@code %LOCALAPPDATA%\cursor-agent}（Windows）与
 * {@code ~/.local/bin}（macOS）；IDE 包内的 {@code resources\app\bin} 只有编辑器入口，没有 {@code cursor-agent}。
 * Claude Code 的原生安装器把 `claude` 放到 `~/.local/bin`（已在常见目录里），npm 与旧版本另有 `~/.claude/local`。</p>
 *
 * <p>Codex 还有第三种来源：ChatGPT 桌面版（官网下载与 Store 渠道是同一个 MSIX 包）自带的引擎。
 * 它不在 PATH 上，也不在上面那几个安装器的位置，见 {@link desktopBundledEngine}。</p>
 */
export function agentDirectories(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  if (platform === "win32") {
    const path = pathForPlatform("win32");
    const local = envValue(env, "LOCALAPPDATA") ?? path.join(homedir(), "AppData", "Local");
    const profile = envValue(env, "USERPROFILE") ?? homedir();
    return [
      // Codex 官方 Windows 安装器放 shim 的地方（install.ps1 的 $defaultVisibleBinDir）。
      path.join(local, "Programs", "OpenAI", "Codex", "bin"),
      // 没装 shim 时，安装器把真正的 codex.exe 留在自己的 current 目录里。
      path.join(profile, ".codex", "packages", "standalone", "current", "bin"),
      // ChatGPT 桌面版启动后把包内引擎重定位到这里（Store 版不一定每次都有，见 desktopBundledEngine）。
      path.join(local, "OpenAI", "Codex", "bin"),
      path.join(local, "OpenAI", "ChatGPT", "bin"),
      // 非 Store 的独立安装器把 Electron 资源放在 App 目录下，引擎就在 resources 里。
      path.join(local, "Programs", "ChatGPT", "resources"),
      path.join(local, "Programs", "Codex", "resources"),
      // Cursor 的独立 CLI：官方安装脚本（cursor.com/install）把它装到这里，里面有
      // cursor-agent.cmd / cursor-agent.ps1 / agent.cmd 与 versions\<版本>\node.exe。
      // IDE 包内的 resources\app\bin 只有 cursor.cmd、code.cmd 一类入口，没有 cursor-agent，
      // 所以不能只靠那一条（在 macOS 上能跑是碰巧命中了 ~/.local/bin）。
      path.join(local, "cursor-agent"),
      // Hermes 的官方 Windows 安装器把命令发布到 %LOCALAPPDATA%\hermes\bin 并写进用户 PATH；
      // Memmy 的 PATH 是启动那一刻的快照，装完之后不重启就读不到，因此显式列出来。
      path.join(local, "hermes", "bin")
    ];
  }
  const home = envValue(env, "HOME") ?? homedir();
  return [
    posix.join(home, ".claude", "local"),
    // Cursor 的独立 CLI（官方安装脚本落到 ~/.local/bin，这里给一条备用位置）。
    posix.join(home, ".local", "bin"),
    // Hermes 的 uv / curl 安装器落在 ~/.local/bin（已在常见目录里），另给一条备用位置。
    posix.join(home, ".hermes", "bin")
  ];
}

/**
 * Windows 上的查找目录。
 *
 * <p>Windows 没有 `/usr/bin` 这种统一位置：用户级安装器把程序放在 `%LOCALAPPDATA%\Programs`，
 * 全局 npm 把 `.cmd` 放在 `%APPDATA%\npm`，winget 与商店应用的入口是 `WindowsApps`。
 * 程序名之下的层级因应用而异（例如 `Cursor\resources\app\bin`），这些都是具体 App 的位置，
 * 放在 {@link agentDirectories} 里；这里只列到目录一层。没有装在任何一处时由调用方给出失败原因，不猜。</p>
 */
function windowsLookupDirs(env: NodeJS.ProcessEnv): string[] {
  const path = pathForPlatform("win32");
  const local = envValue(env, "LOCALAPPDATA") ?? path.join(homedir(), "AppData", "Local");
  const roaming = envValue(env, "APPDATA") ?? path.join(homedir(), "AppData", "Roaming");
  const profile = envValue(env, "USERPROFILE") ?? homedir();
  const dirs = [
    // 用户级安装器（Cursor、VS Code、各类 Electron 应用）默认装到这里。
    path.join(local, "Programs"),
    // winget / Microsoft Store 应用的命令入口。
    path.join(local, "Microsoft", "WindowsApps"),
    // 全局 npm 的 bin：npm 在 Windows 上把命令装成这里的 `.cmd`。
    path.join(roaming, "npm"),
    // 其他包管理器的全局 bin，与 macOS 那份列表对应。
    path.join(local, "pnpm"),
    path.join(profile, ".bun", "bin"),
    path.join(profile, ".cargo", "bin"),
    path.join(profile, ".local", "bin")
  ];
  for (const name of ["ProgramFiles", "ProgramFiles(x86)"]) {
    const value = envValue(env, name);
    if (value) dirs.push(value);
  }
  return dirs;
}

/** 按平台取常见目录：Windows 只给 Windows 的，其余保持原来那一份。 */
export function lookupDirs(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  return platform === "win32" ? windowsLookupDirs(env) : [...POSIX_LOOKUP_DIRS];
}

/**
 * 按平台切分 PATH 这类目录列表。
 *
 * <p>POSIX 的目录名里可能有空格，只跳过空串、不做 trim；Windows 的 PATH 经常带多余空格与包起来的引号
 * （注册表里的旧值），不去掉的话拼出来的路径打不开。</p>
 */
export function splitPathList(value: string | undefined, platform: NodeJS.Platform = process.platform): string[] {
  const parts = (value ?? "").split(pathForPlatform(platform).delimiter);
  if (platform !== "win32") return parts.filter(Boolean);
  return parts
    .map((dir) => dir.trim().replace(/^"(.*)"$/u, "$1").trim())
    .filter(Boolean);
}

/** 按平台拼接目录列表。 */
export function joinPathList(dirs: readonly string[], platform: NodeJS.Platform = process.platform): string {
  return dirs.join(pathForPlatform(platform).delimiter);
}

/** Windows 的 `PATHEXT` 缺省值：环境变量缺失时按这一份找。 */
const DEFAULT_PATHEXT = [".COM", ".EXE", ".BAT", ".CMD"];

/** 这台电脑上能被直接执行的后缀。 */
function pathextList(env: NodeJS.ProcessEnv): string[] {
  const raw = envValue(env, "PATHEXT");
  const list = (raw ? raw.split(";") : []).map((ext) => ext.trim()).filter(Boolean);
  return list.length > 0 ? list : DEFAULT_PATHEXT;
}

/**
 * 一个候选路径要试的文件名：Windows 上命令名不带后缀，真正存在的是 `名字.cmd` / `名字.exe`。
 *
 * <p>顺序要跟 cmd 自己一致：先按 {@code PATHEXT} 试后缀，最后才试无后缀的原名。不能反过来——
 * npm 的 bin-links（`cmd-shim`）给每个命令同时写三份：无后缀的 sh 脚本、`.cmd`、`.ps1`。
 * 无后缀那份是给 posix shell 看的，在 Windows 上 spawn 会 ENOENT；先试它就会选中一个"存在但跑不了"
 * 的文件，表现在界面上就是"这个 Agent 还没有安装"（实测确发生过）。</p>
 *
 * <p>原文与小写都试一次：`PATHEXT` 习惯写大写，而 npm 装出来的文件是小写 `npm.cmd`；Windows 的文件系统
 * 不分大小写，两种写法都能命中，在其他平台上跑测试时也不会因为大小写对不上而误判成「找不到」。</p>
 */
function candidatesFor(full: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform !== "win32") return [full];
  const names: string[] = [];
  for (const ext of pathextList(env)) {
    names.push(`${full}${ext}`);
    const lower = ext.toLowerCase();
    if (lower !== ext) names.push(`${full}${lower}`);
  }
  // 原名放最后：它只有在确实是个 PE 可执行文件时才能用，而那种情况极少；
  // 更常见的是 npm 写的 sh 脚本，不能让它抢在 `.cmd` 前面。
  names.push(full);
  return names;
}

/**
 * 桌面版自带的引擎：App 形态安装的 Agent 把引擎放在自己的安装包里，命令行上并没有。
 *
 * <p>Codex 是典型。ChatGPT 桌面版（官网下载与 Store 渠道是同一个 MSIX 包）把引擎放在
 * {@code <包目录>\app\resources\codex.exe}。包目录在 WindowsApps 下，目录本身不允许枚举
 * （ACL 拒绝），但精确路径可以读、可以执行；包全名带版本号、会随 App 自动更新变化，
 * 因此从注册表的已安装包仓库现查，不写死版本。
 *
 * <p>同一台机器上还可能有 {@code OpenAI.CodexPrimaryRuntime…} 这类不含引擎的运行时包，
 * 所以一律以「那个文件在不在」为准，不按包名猜。</p>
 */
const DESKTOP_BUNDLED_PACKAGES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  codex: ["OpenAI.Codex", "OpenAI.ChatGPT"]
});

/** Windows 已安装包（AppX/MSIX）的注册表仓库：普通用户可读。 */
const WINDOWS_PACKAGE_REPOSITORY =
  "HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages";

/** 查到时的缓存时长：包目录只在 App 升级时变，不值得每次刷新都起一个 reg.exe。 */
const MSIX_CACHE_TTL_MS = 5 * 60_000;
/** 查不到时的缓存时长：用户可能正在装桌面版，装完就该能认出来，不能等五分钟。 */
const MSIX_MISS_TTL_MS = 30_000;
const msixEngineCache = new Map<string, { at: number; path: string | null }>();

/** 清掉桌面版引擎的缓存：只在测试里用。 */
export function resetDesktopEngineCache(): void {
  msixEngineCache.clear();
}

/** 读一条注册表命令的输出；只在测试里替换。 */
export type RegistryReader = (args: readonly string[], env: NodeJS.ProcessEnv) => string | null;

/** 执行 reg.exe 并返回输出；读不到（没这个包、注册表被策略锁住）一律当作没有。 */
export function readRegistry(args: readonly string[], env: NodeJS.ProcessEnv = process.env): string | null {
  const win = pathForPlatform("win32");
  const root = envValue(env, "SystemRoot") ?? envValue(env, "windir") ?? "C:\\Windows";
  try {
    return execFileSync(win.join(root, "System32", "reg.exe"), [...args], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
      env
    });
  } catch {
    return null;
  }
}

/**
 * 桌面版自带的引擎在哪里；平台不是 Windows、或这个命令没有对应的桌面版时返回 null。
 */
function desktopBundledEngine(
  command: string,
  env: NodeJS.ProcessEnv,
  options: FindExecutableOptions
): string | null {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return null;
  const prefixes = DESKTOP_BUNDLED_PACKAGES[command];
  if (!prefixes) return null;
  const exists = options.exists ?? existsSync;
  const key = `${platform}:${command}`;
  const cached = msixEngineCache.get(key);
  // 缓存的路径还在就直接用；不在了（App 升级、卸载、换用户）就重新查一次。
  if (cached) {
    const ttl = cached.path === null ? MSIX_MISS_TTL_MS : MSIX_CACHE_TTL_MS;
    if (Date.now() - cached.at < ttl && (cached.path === null || exists(cached.path))) {
      return cached.path;
    }
  }
  const found = findMsixEngine(command, prefixes, env, exists, options.readRegistry ?? readRegistry);
  msixEngineCache.set(key, { at: Date.now(), path: found });
  return found;
}

function findMsixEngine(
  command: string,
  prefixes: readonly string[],
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
  read: RegistryReader
): string | null {
  const win = pathForPlatform("win32");
  const names = new Set<string>();
  for (const prefix of prefixes) {
    const output = read(["query", WINDOWS_PACKAGE_REPOSITORY, "/f", prefix, "/k"], env);
    for (const line of (output ?? "").split(/\r?\n/u)) {
      // 每行是一个包键：`HKEY_CURRENT_USER\…\Packages\<包全名>`。
      const name = /\\Packages\\([^\\]+?)\s*$/u.exec(line.trim())?.[1];
      if (name) names.add(name);
    }
  }
  if (!names.size) return null;
  const programFiles = envValue(env, "ProgramFiles");
  // 多个版本并存时用最新的那一份（App 升级后旧包可能还在）。
  for (const name of [...names].sort((left, right) => comparePackageVersion(right, left))) {
    const roots = [
      // 绝大多数安装就在系统盘的 WindowsApps 下。
      programFiles ? win.join(programFiles, "WindowsApps", name) : null,
      // 装在别的盘、或 WindowsApps 被重定向时，以注册表记的实际位置为准。
      readPackageRoot(name, env, read)
    ];
    for (const root of roots) {
      if (!root) continue;
      const candidate = win.join(root, "app", "resources", `${command}.exe`);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

function readPackageRoot(name: string, env: NodeJS.ProcessEnv, read: RegistryReader): string | null {
  const output = read(["query", `${WINDOWS_PACKAGE_REPOSITORY}\\${name}`, "/v", "PackageRootFolder"], env);
  const value = /PackageRootFolder\s+REG_[A-Z_]+\s+([^\r\n]+)/u.exec(output ?? "")?.[1]?.trim();
  return value || null;
}

/** 包全名里的版本段：`名字_26.1120.6357.0_架构__哈希` 的第二段。 */
function packageVersion(name: string): number[] {
  return (name.split("_")[1] ?? "").split(".").map((part) => Number(part) || 0);
}

function comparePackageVersion(left: string, right: string): number {
  const a = packageVersion(left);
  const b = packageVersion(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export interface FindExecutableOptions {
  platform?: NodeJS.Platform;
  /**
   * 只在测试里替换「文件在不在」的判断。Windows 的路径（`C:\…`）在其他平台上打不开，
   * 不注入就只能猜到别的平台上测不到 PATHEXT 那段。
   */
  exists?: (path: string) => boolean;
  /** 只在测试里替换注册表查询（桌面版自带的引擎要从已安装包仓库里查）。 */
  readRegistry?: RegistryReader;
}

/**
 * 在 PATH 与常见目录里找一个可执行文件；找不到时返回 null。
 *
 * <p>`command` 可以是命令名（`cursor-agent`），也可以是路径（应用包内的引擎）。路径只判断存在性，
 * 不去 PATH 上拼——配方里的引擎装在应用包内，只有绝对路径能表达。</p>
 */
export function findExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  options: FindExecutableOptions = {}
): string | null {
  const platform = options.platform ?? process.platform;
  const path = pathForPlatform(platform);
  const exists = options.exists ?? existsSync;
  // 绝对路径（含 Windows 的 `C:\…` 与 `\\server\share`）只判断在不在。
  if (path.isAbsolute(command)) return exists(command) ? command : null;
  // 带目录的相对写法（`./bin/tool`）也交给文件系统：原来的实现就是按路径处理，不能改成去 PATH 上找。
  if (/[\\/]/u.test(command)) return exists(command) ? command : null;
  // 整条 PATH 不清洗：posix 的目录名里可能有空格，切分那边会处理平台差异。
  const dirs = [
    ...splitPathList(rawEnvValue(env, "PATH"), platform),
    ...lookupDirs(platform, env),
    // Agent 自己的安装位置：命令在 PATH 上找不到时才走这里（Codex 的 Windows 安装器、Cursor 包内的 CLI）。
    ...agentDirectories(platform, env)
  ];
  for (const dir of dirs) {
    const full = path.join(dir, command);
    for (const candidate of candidatesFor(full, platform, env)) {
      if (exists(candidate)) return candidate;
    }
  }
  // 最后才看桌面版自带的引擎（ChatGPT 桌面版里的 Codex）：代价是一次注册表查询，前面几处都没有时才值得花。
  return desktopBundledEngine(command, env, options);
}

/**
 * 把一段命令行拆成命令与参数：按空白切，但引号包起来的部分算一段。
 *
 * <p>环境变量覆盖（`MEMMY_ASSIST_COMMAND_<SOURCE_ID>`）的值就靠它拆。Windows 的默认安装路径
 * 自带空格（`C:\Program Files\…`），一律按空白切会把命令切成 `C:\Program`，
 * 覆盖开关正好在需要它的场景下失效。单引号与双引号都认，引号本身不留在结果里；
 * 没有引号时结果与原来按空白切完全一致。</p>
 */
export function splitCommandLine(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const character of value) {
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (started) {
        parts.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += character;
    started = true;
  }
  if (started) parts.push(current);
  return parts;
}

/** 一条命令实际要交给子进程的样子。 */
export interface AssistLaunchSpec {
  command: string;
  args: string[];
  /** 命令串里的引号已经自己处理过，需要原样交给 cmd.exe（见 {@link shellLaunch}）。 */
  windowsVerbatimArguments?: boolean;
}

export interface ShellLaunchOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /**
   * Windows 上即使命令不带 `.cmd` / `.bat` 也交给 cmd.exe：
   * npm 装的命令行程序在 PATH 上只有不带后缀的名字，要靠 cmd 的 PATHEXT 才能解析出来。
   */
  always?: boolean;
  /** 只在测试里替换「文件在不在」的判断（Windows 的 `C:\…` 在其他平台上打不开）。 */
  exists?: (path: string) => boolean;
}

/** 只能由命令解释器执行的脚本后缀。 */
const WIN_SHELL_SCRIPT = /\.(?:cmd|bat)$/iu;

/** cmd 里的引号：整段加引号，内部的 `"` 写成 `\"`，否则带空格的目录会在空格处被拆开。 */
function winShellQuote(value: string): string {
  return `"${value.replace(/"/gu, '\\"')}"`;
}

/**
 * 把一条命令变成「子进程实际要执行的东西」。
 *
 * <p>Windows 上 npm 装的命令行程序都是 `.cmd`（一个批处理脚本），Node 直接 spawn 会 ENOENT。
 * 这里改成交给 `cmd.exe /d /s /c`：命令串自己加引号，参数里的空格与包名里的 `@`、`^` 都不会被拆开，
 * 并让引号原样透传。不用 `shell: true` 是因为那样 Node 会把命令与参数直接拼成一行，
 * 目录带空格（`C:\Users\Q Sun\…`）时参数就被拆断了。</p>
 *
 * <p>非 Windows 原样返回，macOS / Linux 的行为不变。</p>
 */
export function shellLaunch(
  command: string,
  args: readonly string[],
  options: ShellLaunchOptions = {}
): AssistLaunchSpec {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return { command, args: [...args] };
  // 无后缀的命令在 Windows 上不一定是可执行文件：npm 给每个 bin 都写一份无后缀的 sh 脚本，
  // 同一目录里真正的入口是 `名字.cmd`。拿到无后缀路径时先看同名 `.cmd` 在不在，在就改走它。
  const resolvedCommand = extendWithShellShim(command, options);
  if (!options.always && !WIN_SHELL_SCRIPT.test(resolvedCommand)) return { command: resolvedCommand, args: [...args] };
  const env = options.env ?? process.env;
  const line = [resolvedCommand, ...args].map(winShellQuote).join(" ");
  return {
    command: envValue(env, "ComSpec") ?? "cmd.exe",
    // `/s` 之后 cmd 会去掉最外层的那对引号，剩下的正好是排好引号的命令。
    args: ["/d", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true
  };
}

/** 无后缀的命令旁边有同名 `.cmd` 时改走 `.cmd`：那份才能被 cmd.exe 执行。 */
function extendWithShellShim(command: string, options: ShellLaunchOptions): string {
  // 带 `.cmd` / `.bat` 的已经是批处理，其余带扩展名的（`.exe`、`.js`）不动：
  // 只有「最后一段没有扩展名」的才可能是 npm 写的 sh 脚本。
  if (WIN_SHELL_SCRIPT.test(command)) return command;
  // Windows 路径用反斜杠，但调用方也可能给正斜杠（相对写法）或混用，两种分隔符都算边界。
  const base = command.slice(Math.max(command.lastIndexOf("\\"), command.lastIndexOf("/")) + 1);
  // 以点开头的名字（`.bin`）不是扩展名，仍按无后缀处理。
  if (base.includes(".") && !base.startsWith(".")) return command;
  const exists = options.exists ?? existsSync;
  const shim = `${command}.cmd`;
  return exists(shim) ? shim : command;
}
