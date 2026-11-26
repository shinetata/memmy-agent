import { join, normalize } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveClaudeCodeHomeDirectory,
  resolveClaudeCodeProjectsDirectory,
  resolveCodexHomeDirectory,
  resolveCodexSessionsDirectory,
  resolveCursorDataPaths,
  resolveDeepseekHarnessHomeDirectory,
  resolveDeepseekHarnessSessionsDirectory,
  resolveHermesHomeDirectory,
  resolveOpencodeConfigDirectory,
  resolveOpencodeDataDirectory,
  resolveOpencodeDatabasePath,
  resolveOpenclawConfigPath,
  resolveOpenclawStateDirectory,
  resolvePiAgentDirectory,
  resolvePiSessionsDirectory,
  resolveQwenworkHomeDirectory,
  resolveQwenworkProjectsDirectory,
  resolveWorkbuddyHomeDirectory,
  resolveWorkbuddyProjectsDirectory
} from "../../agent-paths.js";

const ENVIRONMENT_VARIABLES = [
  "APPDATA",
  "CLAUDE_CONFIG_DIR",
  "CODEBUDDY_CONFIG_DIR",
  "CODEX_HOME",
  "DSH_HOME",
  "HERMES_HOME",
  "OPENCODE_CONFIG_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_STATE_DIR",
  "PI_CODING_AGENT_DIR",
  "QWENWORK_CONFIG_DIR",
  "WORKBUDDY_CONFIG_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME"
] as const;
const originalEnvironment = new Map(ENVIRONMENT_VARIABLES.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const [key, value] of originalEnvironment) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("agent paths", () => {
  it("honors each Agent's configured home or state directory", () => {
    process.env.CLAUDE_CONFIG_DIR = "/tmp/claude-home";
    process.env.CODEX_HOME = "/tmp/codex-home";
    process.env.DSH_HOME = "/tmp/dsh-home";
    process.env.HERMES_HOME = "/tmp/hermes-home";
    process.env.OPENCLAW_STATE_DIR = "/tmp/openclaw-state";
    process.env.OPENCLAW_CONFIG_PATH = "/tmp/openclaw-config.json";
    process.env.PI_CODING_AGENT_DIR = "/tmp/pi-agent";
    process.env.QWENWORK_CONFIG_DIR = "/tmp/qwenwork-home";
    process.env.WORKBUDDY_CONFIG_DIR = "/tmp/workbuddy-home";

    expect(resolveClaudeCodeHomeDirectory()).toBe(normalize("/tmp/claude-home"));
    expect(resolveCodexHomeDirectory()).toBe(normalize("/tmp/codex-home"));
    expect(resolveDeepseekHarnessHomeDirectory()).toBe(normalize("/tmp/dsh-home"));
    expect(resolveDeepseekHarnessSessionsDirectory()).toBe(join(normalize("/tmp/dsh-home"), "sessions"));
    expect(resolveHermesHomeDirectory()).toBe(normalize("/tmp/hermes-home"));
    expect(resolveOpenclawStateDirectory()).toBe(normalize("/tmp/openclaw-state"));
    expect(resolveOpenclawConfigPath()).toBe(normalize("/tmp/openclaw-config.json"));
    expect(resolvePiAgentDirectory()).toBe(normalize("/tmp/pi-agent"));
    expect(resolveQwenworkHomeDirectory()).toBe(normalize("/tmp/qwenwork-home"));
    expect(resolveWorkbuddyHomeDirectory()).toBe(normalize("/tmp/workbuddy-home"));
  });

  it("uses WorkBuddy's official config directory variables", () => {
    process.env.WORKBUDDY_CONFIG_DIR = "/tmp/workbuddy-current";
    process.env.CODEBUDDY_CONFIG_DIR = "/tmp/workbuddy-legacy-product-name";

    expect(resolveWorkbuddyHomeDirectory()).toBe(normalize("/tmp/workbuddy-current"));

    process.env.WORKBUDDY_CONFIG_DIR = " ";
    expect(resolveWorkbuddyHomeDirectory()).toBe(normalize("/tmp/workbuddy-legacy-product-name"));
  });

  it("uses OpenCode's custom config directory and XDG data directory", () => {
    process.env.XDG_CONFIG_HOME = "/tmp/xdg-config";
    process.env.XDG_DATA_HOME = "/tmp/xdg-data";
    delete process.env.OPENCODE_CONFIG_DIR;

    expect(resolveOpencodeConfigDirectory()).toBe(join("/tmp/xdg-config", "opencode"));
    expect(resolveOpencodeDataDirectory()).toBe(join("/tmp/xdg-data", "opencode"));

    process.env.OPENCODE_CONFIG_DIR = "/tmp/custom-opencode";
    expect(resolveOpencodeConfigDirectory()).toBe(normalize("/tmp/custom-opencode"));
  });

  it("resolves all ten Agent source paths on macOS", () => {
    const options = {
      platform: "darwin" as const,
      homeDirectory: "/Users/alice",
      environment: {}
    };

    expect({
      cursor: resolveCursorDataPaths(options).workspaceStorageDirectory,
      claudeCode: resolveClaudeCodeProjectsDirectory(options),
      codex: resolveCodexSessionsDirectory(options),
      opencode: resolveOpencodeDatabasePath(options),
      openclaw: resolveOpenclawStateDirectory(options),
      hermes: resolveHermesHomeDirectory(options),
      deepseekHarness: resolveDeepseekHarnessSessionsDirectory(options),
      pi: resolvePiSessionsDirectory(options),
      qwenwork: resolveQwenworkProjectsDirectory(options),
      workbuddy: resolveWorkbuddyProjectsDirectory(options)
    }).toEqual({
      cursor: "/Users/alice/Library/Application Support/Cursor/User/workspaceStorage",
      claudeCode: "/Users/alice/.claude/projects",
      codex: "/Users/alice/.codex/sessions",
      opencode: "/Users/alice/.local/share/opencode/opencode.db",
      openclaw: "/Users/alice/.openclaw",
      hermes: "/Users/alice/.hermes",
      deepseekHarness: "/Users/alice/.dsh/sessions",
      pi: "/Users/alice/.pi/agent/sessions",
      qwenwork: "/Users/alice/.qwenworkcn/projects",
      workbuddy: "/Users/alice/.workbuddy/projects"
    });
  });

  it("resolves all ten Agent source paths on Windows", () => {
    const options = {
      platform: "win32",
      homeDirectory: "C:\\Users\\alice",
      environment: {
        APPDATA: "C:\\Users\\alice\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local"
      }
    } as const;

    expect({
      cursor: resolveCursorDataPaths(options).workspaceStorageDirectory,
      claudeCode: resolveClaudeCodeProjectsDirectory(options),
      codex: resolveCodexSessionsDirectory(options),
      opencode: resolveOpencodeDatabasePath(options),
      openclaw: resolveOpenclawStateDirectory(options),
      hermes: resolveHermesHomeDirectory(options),
      deepseekHarness: resolveDeepseekHarnessSessionsDirectory(options),
      pi: resolvePiSessionsDirectory(options),
      qwenwork: resolveQwenworkProjectsDirectory(options),
      workbuddy: resolveWorkbuddyProjectsDirectory(options)
    }).toEqual({
      cursor: "C:\\Users\\alice\\AppData\\Roaming\\Cursor\\User\\workspaceStorage",
      claudeCode: "C:\\Users\\alice\\.claude\\projects",
      codex: "C:\\Users\\alice\\.codex\\sessions",
      opencode: "C:\\Users\\alice\\.local\\share\\opencode\\opencode.db",
      openclaw: "C:\\Users\\alice\\.openclaw",
      // Hermes 的官方 Windows 安装器用 %LOCALAPPDATA%\\hermes，不是 ~/.hermes。
      hermes: "C:\\Users\\alice\\AppData\\Local\\hermes",
      deepseekHarness: "C:\\Users\\alice\\.dsh\\sessions",
      pi: "C:\\Users\\alice\\.pi\\agent\\sessions",
      qwenwork: "C:\\Users\\alice\\.qwenworkcn\\projects",
      workbuddy: "C:\\Users\\alice\\.workbuddy\\projects"
    });
  });

  it("resolves Cursor's Linux XDG path and Windows fallback path", () => {
    expect(resolveCursorDataPaths({
      platform: "linux",
      homeDirectory: "/home/alice",
      environment: {
        XDG_CONFIG_HOME: "/srv/alice/config"
      }
    }).userDirectory).toBe("/srv/alice/config/Cursor/User");

    expect(resolveCursorDataPaths({
      platform: "win32",
      homeDirectory: "C:\\Users\\alice",
      environment: {}
    }).userDirectory).toBe("C:\\Users\\alice\\AppData\\Roaming\\Cursor\\User");
  });
});

describe("Hermes 主目录的前向兼容", () => {
  const legacy = "C:\\Users\\alice\\.hermes";
  const current = "C:\\Users\\alice\\AppData\\Local\\hermes";
  const options = (taken: readonly string[]) => ({
    platform: "win32" as const,
    homeDirectory: "C:\\Users\\alice",
    environment: { LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local" } as NodeJS.ProcessEnv,
    exists: (path: string) => taken.includes(path)
  });

  it("uses the official Windows location on a fresh machine", () => {
    // 两个都不存在时指向新位置：失败原因里给出的就是官方安装器会用的那个目录。
    expect(resolveHermesHomeDirectory(options([]))).toBe(current);
    expect(resolveHermesHomeDirectory(options([current]))).toBe(current);
  });

  it("keeps the legacy ~/.hermes when that is where the components already are", () => {
    // 升级前 Memmy 把 skill 与 hook 装进 ~/.hermes：新位置没出现时必须沿用旧位置，
    // 否则这批用户的组件会「失联」，被当成没装而重装一份。
    expect(resolveHermesHomeDirectory(options([legacy]))).toBe(legacy);
  });

  it("prefers the official location once it exists on both", () => {
    // 用户后装了官方 Hermes：真实数据在新位置，就改用它（旧目录里的组件留在那里，无害）。
    expect(resolveHermesHomeDirectory(options([legacy, current]))).toBe(current);
  });

  it("still lets HERMES_HOME decide", () => {
    expect(resolveHermesHomeDirectory({
      platform: "win32",
      homeDirectory: "C:\\Users\\alice",
      environment: {
        LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local",
        HERMES_HOME: "D:\\hermes"
      } as NodeJS.ProcessEnv,
      exists: () => true
    })).toBe("D:\\hermes");
  });

  it("leaves macOS and Linux on ~/.hermes", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(resolveHermesHomeDirectory({
        platform,
        homeDirectory: "/Users/alice",
        environment: {} as NodeJS.ProcessEnv,
        exists: () => false
      })).toBe(normalize("/Users/alice/.hermes"));
    }
  });
});
