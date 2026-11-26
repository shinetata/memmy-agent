import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, posix, resolve, win32 } from "node:path";

type AgentPathApi = Pick<typeof posix, "isAbsolute" | "join" | "normalize" | "resolve">;

interface AgentPathRuntime {
  environment: NodeJS.ProcessEnv;
  homeDirectory: string;
  pathApi: AgentPathApi;
}

export interface ResolveAgentPathOptions {
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  environment?: NodeJS.ProcessEnv;
}

export interface CursorDataPaths {
  userDirectory: string;
  workspaceStorageDirectory: string;
  globalStateDbPath: string;
}

export interface ResolveCursorDataPathsOptions extends ResolveAgentPathOptions {
  appDataDirectory?: string;
  xdgConfigDirectory?: string;
}

export function resolveClaudeCodeHomeDirectory(options: ResolveAgentPathOptions = {}): string {
  const runtime = createAgentPathRuntime(options);
  return resolveConfiguredDirectory(
    runtime.environment.CLAUDE_CONFIG_DIR,
    runtime.pathApi.join(runtime.homeDirectory, ".claude"),
    runtime
  );
}

export function resolveClaudeCodeProjectsDirectory(options: ResolveAgentPathOptions = {}): string {
  return createAgentPathRuntime(options).pathApi.join(resolveClaudeCodeHomeDirectory(options), "projects");
}

export function resolveCodexHomeDirectory(options: ResolveAgentPathOptions = {}): string {
  const runtime = createAgentPathRuntime(options);
  return resolveConfiguredDirectory(
    runtime.environment.CODEX_HOME,
    runtime.pathApi.join(runtime.homeDirectory, ".codex"),
    runtime
  );
}

export function resolveCodexSessionsDirectory(options: ResolveAgentPathOptions = {}): string {
  return createAgentPathRuntime(options).pathApi.join(resolveCodexHomeDirectory(options), "sessions");
}

export function resolveOpencodeConfigDirectory(options: ResolveAgentPathOptions = {}): string {
  const runtime = createAgentPathRuntime(options);
  const xdgConfigRoot = resolveConfiguredDirectory(
    runtime.environment.XDG_CONFIG_HOME,
    runtime.pathApi.join(runtime.homeDirectory, ".config"),
    runtime
  );
  return resolveConfiguredDirectory(
    runtime.environment.OPENCODE_CONFIG_DIR,
    runtime.pathApi.join(xdgConfigRoot, "opencode"),
    runtime
  );
}

export function resolveOpencodeDataDirectory(options: ResolveAgentPathOptions = {}): string {
  const runtime = createAgentPathRuntime(options);
  const xdgDataRoot = resolveConfiguredDirectory(
    runtime.environment.XDG_DATA_HOME,
    runtime.pathApi.join(runtime.homeDirectory, ".local", "share"),
    runtime
  );
  return runtime.pathApi.join(xdgDataRoot, "opencode");
}

export function resolveOpencodeDatabasePath(options: ResolveAgentPathOptions = {}): string {
  return createAgentPathRuntime(options).pathApi.join(resolveOpencodeDataDirectory(options), "opencode.db");
}

export function resolveOpenclawStateDirectory(options: ResolveAgentPathOptions = {}): string {
  const runtime = createAgentPathRuntime(options);
  return resolveConfiguredDirectory(
    runtime.environment.OPENCLAW_STATE_DIR,
    runtime.pathApi.join(runtime.homeDirectory, ".openclaw"),
    runtime
  );
}

export function resolveOpenclawConfigPath(
  stateDirectory?: string,
  options: ResolveAgentPathOptions = {}
): string {
  const runtime = createAgentPathRuntime(options);
  return resolveConfiguredDirectory(
    runtime.environment.OPENCLAW_CONFIG_PATH,
    runtime.pathApi.join(stateDirectory ?? resolveOpenclawStateDirectory(options), "openclaw.json"),
    runtime
  );
}

/**
 * Hermes 的主目录。
 *
 * <p>官方 Windows 安装器用 {@code %LOCALAPPDATA%\hermes}（{@code install.ps1} 的
 * {@code $HermesHome} 默认值，命令发布在它下面的 {@code bin}）；macOS / Linux 是 {@code ~/.hermes}。
 * 按 {@code ~/.hermes} 去找，标准装的 Windows 机器上永远是空的，于是「本机有没有 Hermes」被误判成没有。</p>
 *
 * <p>但 Windows 上不能只认新位置：升级前 Memmy 自己把 Hermes 的 skill 与 hook 装进了
 * {@code ~/.hermes}，那批用户的组件还留在那里。所以先看新位置在不在，不在而旧位置在就沿用旧位置，
 * 免得已装的组件突然「失联」、被当成没装而重装一份。两个都不存在时仍指新位置作为提示。
 * {@code HERMES_HOME} 依旧最优先。</p>
 */
export function resolveHermesHomeDirectory(
  options: ResolveAgentPathOptions & { exists?: (path: string) => boolean } = {}
): string {
  const runtime = createAgentPathRuntime(options);
  const configured = runtime.environment.HERMES_HOME;
  if (configured?.trim()) return resolveConfiguredDirectory(configured, configured, runtime);
  const legacy = runtime.pathApi.join(runtime.homeDirectory, ".hermes");
  if ((options.platform ?? process.platform) !== "win32") return legacy;
  const current = runtime.pathApi.join(
    runtime.environment.LOCALAPPDATA?.trim() ||
      runtime.pathApi.join(runtime.homeDirectory, "AppData", "Local"),
    "hermes"
  );
  const exists = options.exists ?? existsSync;
  // 新位置不在、旧位置在：这是升级前装过 Hermes 组件的机器，沿用旧位置。
  if (!exists(current) && exists(legacy)) return legacy;
  return current;
}

export function resolveDeepseekHarnessHomeDirectory(options: ResolveAgentPathOptions = {}): string {
  const runtime = createAgentPathRuntime(options);
  return resolveConfiguredDirectory(
    runtime.environment.DSH_HOME,
    runtime.pathApi.join(runtime.homeDirectory, ".dsh"),
    runtime
  );
}

export function resolveDeepseekHarnessSessionsDirectory(options: ResolveAgentPathOptions = {}): string {
  return createAgentPathRuntime(options).pathApi.join(resolveDeepseekHarnessHomeDirectory(options), "sessions");
}

export function resolveWorkbuddyHomeDirectory(options: ResolveAgentPathOptions = {}): string {
  const runtime = createAgentPathRuntime(options);
  return resolveConfiguredDirectory(
    runtime.environment.WORKBUDDY_CONFIG_DIR?.trim() ||
      runtime.environment.CODEBUDDY_CONFIG_DIR?.trim(),
    runtime.pathApi.join(runtime.homeDirectory, ".workbuddy"),
    runtime
  );
}

export function resolveWorkbuddyProjectsDirectory(options: ResolveAgentPathOptions = {}): string {
  return createAgentPathRuntime(options).pathApi.join(resolveWorkbuddyHomeDirectory(options), "projects");
}

export function resolvePiAgentDirectory(options: ResolveAgentPathOptions = {}): string {
  const runtime = createAgentPathRuntime(options);
  return resolveConfiguredDirectory(
    runtime.environment.PI_CODING_AGENT_DIR,
    runtime.pathApi.join(runtime.homeDirectory, ".pi", "agent"),
    runtime
  );
}

export function resolvePiSessionsDirectory(options: ResolveAgentPathOptions = {}): string {
  return createAgentPathRuntime(options).pathApi.join(resolvePiAgentDirectory(options), "sessions");
}

export function resolveQwenworkHomeDirectory(options: ResolveAgentPathOptions = {}): string {
  const runtime = createAgentPathRuntime(options);
  return resolveConfiguredDirectory(
    runtime.environment.QWENWORK_CONFIG_DIR,
    runtime.pathApi.join(runtime.homeDirectory, ".qwenworkcn"),
    runtime
  );
}

export function resolveQwenworkProjectsDirectory(options: ResolveAgentPathOptions = {}): string {
  return createAgentPathRuntime(options).pathApi.join(resolveQwenworkHomeDirectory(options), "projects");
}

export function resolveCursorDataPaths(options: ResolveCursorDataPathsOptions = {}): CursorDataPaths {
  const runtime = createAgentPathRuntime(options);
  const platform = options.platform ?? process.platform;
  const userDirectory = platform === "win32"
    ? runtime.pathApi.join(
        options.appDataDirectory?.trim() ||
          runtime.environment.APPDATA?.trim() ||
          runtime.pathApi.join(runtime.homeDirectory, "AppData", "Roaming"),
        "Cursor",
        "User"
      )
    : platform === "darwin"
      ? runtime.pathApi.join(runtime.homeDirectory, "Library", "Application Support", "Cursor", "User")
      : runtime.pathApi.join(
          options.xdgConfigDirectory?.trim() ||
            runtime.environment.XDG_CONFIG_HOME?.trim() ||
            runtime.pathApi.join(runtime.homeDirectory, ".config"),
          "Cursor",
          "User"
        );

  return {
    userDirectory,
    workspaceStorageDirectory: runtime.pathApi.join(userDirectory, "workspaceStorage"),
    globalStateDbPath: runtime.pathApi.join(userDirectory, "globalStorage", "state.vscdb")
  };
}

export function resolveAgentPath(value: string): string {
  return resolveAgentPathWithRuntime(value, {
    environment: process.env,
    homeDirectory: homedir(),
    pathApi: { isAbsolute, join, normalize, resolve }
  });
}

function createAgentPathRuntime(options: ResolveAgentPathOptions = {}): AgentPathRuntime {
  const platform = options.platform ?? process.platform;
  return {
    environment: options.environment ?? process.env,
    homeDirectory: options.homeDirectory ?? homedir(),
    pathApi: platform === "win32" ? win32 : posix
  };
}

function resolveConfiguredDirectory(
  value: string | undefined,
  fallback: string,
  runtime: AgentPathRuntime
): string {
  return value?.trim() ? resolveAgentPathWithRuntime(value.trim(), runtime) : fallback;
}

function resolveAgentPathWithRuntime(value: string, runtime: AgentPathRuntime): string {
  const expanded = value === "~"
    ? runtime.homeDirectory
    : value.startsWith("~/") || value.startsWith("~\\")
      ? runtime.pathApi.join(runtime.homeDirectory, value.slice(2))
      : value;
  return runtime.pathApi.isAbsolute(expanded)
    ? runtime.pathApi.normalize(expanded)
    : runtime.pathApi.resolve(expanded);
}
