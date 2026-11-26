import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LOOKUP_DIRS,
  findExecutable,
  joinPathList,
  lookupDirs,
  resetDesktopEngineCache,
  shellLaunch,
  splitCommandLine,
  splitPathList
} from "../assist/executables.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** 一个只放了给定命令的 PATH 目录。 */
function binWith(...commands: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "memmy-assist-exec-"));
  roots.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  for (const command of commands) {
    const file = join(bin, command);
    writeFileSync(file, "#!/bin/sh\n");
    chmodSync(file, 0o755);
  }
  return bin;
}

/** 一个「存在的文件」集合：Windows 的路径在别的平台上打不开，用注入代替文件系统。 */
function existsIn(files: readonly string[]): (path: string) => boolean {
  const set = new Set(files);
  return (path) => set.has(path);
}

describe("findExecutable", () => {
  it("looks through the PATH directories and the usual places", () => {
    // 命令名里没有目录，只能靠在 PATH 与常见目录里找。
    const bin = binWith("memmy-only-here");
    expect(findExecutable("memmy-only-here", { PATH: bin } as NodeJS.ProcessEnv)).toBe(join(bin, "memmy-only-here"));
  });

  it("takes a path as a path instead of joining it to every PATH directory", () => {
    const bin = binWith("memmy-by-path");
    const file = join(bin, "memmy-by-path");
    // 绝对路径只判断存在性；同一份透传给别的目录拼一遍会得到一个不存在的路径。
    expect(findExecutable(file, { PATH: "/nonexistent" } as NodeJS.ProcessEnv)).toBe(file);
    expect(findExecutable(join(bin, "missing"), { PATH: "/nonexistent" } as NodeJS.ProcessEnv)).toBeNull();
    // 带目录的相对写法按路径处理，不去 PATH 上拼。
    expect(findExecutable("./bin/memmy-by-path", { PATH: bin } as NodeJS.ProcessEnv)).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(findExecutable("memmy-nowhere", { PATH: binWith() } as NodeJS.ProcessEnv, {
      // 常见目录里可能有同名的东西，这里只认注入进来的那一份。
      exists: () => false
    })).toBeNull();
  });

  it("splits PATH with semicolons on Windows and finds the .cmd behind the command name", () => {
    // Windows 的 PATH 用 `;` 分隔，命令名不带后缀，实际文件是 `.cmd`。
    const exists = existsIn(["C:\\tools\\cursor-agent.cmd"]);
    const found = findExecutable(
      "cursor-agent",
      { PATH: "C:\\Windows;C:\\tools", PATHEXT: ".COM;.EXE;.BAT;.CMD" } as NodeJS.ProcessEnv,
      { platform: "win32", exists }
    );
    expect(found).toBe("C:\\tools\\cursor-agent.cmd");
  });

  it("does not split a Windows PATH with colons", () => {
    // 用 `:` 切会把两段拼成一个不存在的目录：这条用例防的就是只改分隔符漏改这一处的情况。
    const exists = existsIn(["C:\\tools\\cursor-agent.cmd"]);
    expect(findExecutable(
      "cursor-agent",
      { PATH: "C:\\Windows:C:\\tools" } as NodeJS.ProcessEnv,
      { platform: "win32", exists }
    )).toBeNull();
  });

  it("falls back to the default PATHEXT when the environment has none", () => {
    // 打包后的环境可能没有 PATHEXT，默认的那四个后缀仍要能命中。
    const exists = existsIn(["C:\\Windows\\npm.EXE"]);
    expect(findExecutable("npm", { PATH: "C:\\Windows" } as NodeJS.ProcessEnv, {
      platform: "win32",
      exists
    })).toBe("C:\\Windows\\npm.EXE");
  });

  it("honours a custom PATHEXT", () => {
    const exists = existsIn(["C:\\tools\\my-tool.ps1"]);
    expect(findExecutable("my-tool", { PATH: "C:\\tools", PATHEXT: ".PS1" } as NodeJS.ProcessEnv, {
      platform: "win32",
      exists
    })).toBe("C:\\tools\\my-tool.ps1");
  });

  it("only looks at PATHEXT on Windows", () => {
    // macOS / Linux 上命令本身就是文件名，不应该自己去拼后缀。
    const bin = binWith("memmy-no-suffix");
    const exists = existsIn([join(bin, "memmy-no-suffix.cmd")]);
    expect(findExecutable("memmy-no-suffix", { PATH: bin, PATHEXT: ".CMD" } as NodeJS.ProcessEnv, { exists })).toBeNull();
  });

  it("treats a Windows absolute path as a path", () => {
    const exists = existsIn(["C:\\Program Files\\App\\engine.exe"]);
    expect(findExecutable("C:\\Program Files\\App\\engine.exe", {} as NodeJS.ProcessEnv, {
      platform: "win32",
      exists
    })).toBe("C:\\Program Files\\App\\engine.exe");
  });

  it("reads the environment block's `Path` spelling", () => {
    // Windows 的环境块里写的是 `Path`；`{...process.env}` 复制成普通对象后没有大小写不敏感的代理，
    // 只认 env.PATH 会真的读不到。
    const exists = existsIn(["C:\\tools\\opencode.cmd"]);
    expect(findExecutable("opencode", { Path: "C:\\tools" } as NodeJS.ProcessEnv, {
      platform: "win32",
      exists
    })).toBe("C:\\tools\\opencode.cmd");
  });

  it("prefers the .cmd over the extensionless sh shim npm writes beside it", () => {
    // npm 的 bin-links 在 Windows 上给每个命令同时写三份：无后缀的 sh 脚本、`.cmd`、`.ps1`。
    // 无后缀那份是给 posix shell 的，spawn 会 ENOENT；先试它就会选中一个「存在但跑不了」的文件。
    const exists = existsIn(["C:\\tools\\opencode", "C:\\tools\\opencode.cmd"]);
    expect(findExecutable("opencode", { PATH: "C:\\tools", PATHEXT: ".COM;.EXE;.BAT;.CMD" } as NodeJS.ProcessEnv, {
      platform: "win32",
      exists
    })).toBe("C:\\tools\\opencode.cmd");
  });

  it("still falls back to an extensionless file when no suffixed one exists", () => {
    // 确实是 PE 可执行文件时仍要能认出来：无后缀候选只是排到最后，不是被删掉。
    const exists = existsIn(["C:\\tools\\native-tool"]);
    expect(findExecutable("native-tool", { PATH: "C:\\tools", PATHEXT: ".EXE" } as NodeJS.ProcessEnv, {
      platform: "win32",
      exists
    })).toBe("C:\\tools\\native-tool");
  });

  it("also looks in the Windows usual places", () => {
    const env = {
      PATH: "",
      APPDATA: "C:\\Users\\q sun\\AppData\\Roaming"
    } as NodeJS.ProcessEnv;
    const exists = existsIn(["C:\\Users\\q sun\\AppData\\Roaming\\npm\\pi-acp.cmd"]);
    expect(findExecutable("pi-acp", env, { platform: "win32", exists }))
      .toBe("C:\\Users\\q sun\\AppData\\Roaming\\npm\\pi-acp.cmd");
  });
});

describe("splitPathList / joinPathList", () => {
  it("keeps POSIX directories as they are", () => {
    // 目录名里可能有空格，posix 上不做 trim。
    expect(splitPathList("/usr/bin:/Users/a b/bin::/bin")).toEqual(["/usr/bin", "/Users/a b/bin", "/bin"]);
    expect(joinPathList(["/usr/bin", "/bin"])).toBe("/usr/bin:/bin");
  });

  it("strips the stray spaces and quotes Windows PATH entries often carry", () => {
    expect(splitPathList(' C:\\Windows ; "C:\\Program Files\\App";;C:\\tools ', "win32"))
      .toEqual(["C:\\Windows", "C:\\Program Files\\App", "C:\\tools"]);
    expect(joinPathList(["C:\\Windows", "C:\\tools"], "win32")).toBe("C:\\Windows;C:\\tools");
  });
});

describe("lookupDirs", () => {
  it("gives the Windows places on Windows", () => {
    const dirs = lookupDirs("win32", {
      LOCALAPPDATA: "C:\\Users\\q sun\\AppData\\Local",
      APPDATA: "C:\\Users\\q sun\\AppData\\Roaming",
      USERPROFILE: "C:\\Users\\q sun",
      ProgramFiles: "C:\\Program Files"
    } as NodeJS.ProcessEnv);
    expect(dirs).toContain("C:\\Users\\q sun\\AppData\\Local\\Programs");
    expect(dirs).toContain("C:\\Users\\q sun\\AppData\\Local\\Microsoft\\WindowsApps");
    expect(dirs).toContain("C:\\Users\\q sun\\AppData\\Roaming\\npm");
    expect(dirs).toContain("C:\\Program Files");
    // macOS 的目录在 Windows 上没有意义。
    expect(dirs).not.toContain("/opt/homebrew/bin");
  });

  it("keeps the macOS / Linux places elsewhere", () => {
    const dirs = lookupDirs("darwin");
    expect(dirs).toContain("/opt/homebrew/bin");
    expect(LOOKUP_DIRS).toContain("/usr/local/bin");
  });
});

describe("shellLaunch", () => {
  it("starts normally on macOS / Linux", () => {
    const spec = shellLaunch("/opt/homebrew/bin/cursor-agent", ["acp"], { platform: "darwin" });
    expect(spec).toEqual({ command: "/opt/homebrew/bin/cursor-agent", args: ["acp"] });
  });

  it("leaves an .exe alone on Windows", () => {
    const spec = shellLaunch("C:\\tools\\agent.exe", ["acp"], { platform: "win32" });
    expect(spec).toEqual({ command: "C:\\tools\\agent.exe", args: ["acp"] });
  });

  it("hands a .cmd to cmd.exe and quotes every part of the command line", () => {
    // `.cmd` 是批处理脚本，Node 直接 spawn 会 ENOENT；带空格的目录也不能在空格处断开。
    const spec = shellLaunch(
      "C:\\Users\\q sun\\AppData\\Roaming\\npm\\npm.cmd",
      ["install", "--prefix", "C:\\Users\\q sun\\.memmy\\assist\\adapters", "pkg@^1.0.0"],
      { platform: "win32", env: { ComSpec: "C:\\Windows\\system32\\cmd.exe" } as NodeJS.ProcessEnv }
    );
    expect(spec.command).toBe("C:\\Windows\\system32\\cmd.exe");
    expect(spec.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    // 整条命令再包一层引号：cmd 的 `/s` 会去掉最外层那一对，剩下的正好是排好引号的命令。
    expect(spec.args[3]).toBe(
      '""C:\\Users\\q sun\\AppData\\Roaming\\npm\\npm.cmd" "install" "--prefix" '
      + '"C:\\Users\\q sun\\.memmy\\assist\\adapters" "pkg@^1.0.0""'
    );
    expect(spec.windowsVerbatimArguments).toBe(true);
  });

  it("switches an extensionless command to the .cmd beside it", () => {
    // 拿到无后缀路径时不包装就 spawn，Windows 上会 ENOENT；同名 `.cmd` 在就改走它。
    const spec = shellLaunch("C:\\tools\\opencode", ["acp"], {
      platform: "win32",
      env: { ComSpec: "C:\\Windows\\system32\\cmd.exe" } as NodeJS.ProcessEnv,
      exists: (path) => path === "C:\\tools\\opencode.cmd"
    });
    expect(spec.command).toBe("C:\\Windows\\system32\\cmd.exe");
    expect(spec.args[3]).toContain("opencode.cmd");
  });

  it("hands a bare command to cmd.exe when the caller asks for it", () => {
    // npm 装的命令行程序在 PATH 上只有不带后缀的名字，靠 cmd 自己的 PATHEXT 解析。
    const spec = shellLaunch("npm", ["install"], { platform: "win32", always: true, env: {} as NodeJS.ProcessEnv });
    expect(spec.command).toBe("cmd.exe");
    expect(spec.args).toEqual(["/d", "/s", "/c", '""npm" "install""']);
  });

  it("does not wrap a bare command on Windows unless asked", () => {
    expect(shellLaunch("agent", [], { platform: "win32" })).toEqual({ command: "agent", args: [] });
  });
});

describe("desktop app engines on Windows", () => {
  /**
   * 已安装包仓库的查询：真实安装上是一次 `reg query <仓库> /f <包名前缀> /k`，
   * 再对每个包 `reg query <仓库>\<包名> /v PackageRootFolder`。
   */
  const REPOSITORY = "HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages";
  const HIVE = "HKEY_CURRENT_USER\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages";

  function registryReader(packages: readonly string[], roots: Record<string, string>) {
    const queries: string[] = [];
    const readRegistry = (args: readonly string[]): string | null => {
      queries.push(args.join(" "));
      if (args[0] === "query" && args[1] === REPOSITORY && args[2] === "/f") {
        const matched = packages.filter((name) => name.startsWith(args[3]!));
        return matched.length ? matched.map((name) => `${HIVE}\\${name}`).join("\r\n") : null;
      }
      if (args[0] === "query" && args[2] === "/v" && args[3] === "PackageRootFolder") {
        const root = roots[args[1]!.slice(REPOSITORY.length + 1)];
        return root ? `    PackageRootFolder    REG_SZ    ${root}\r\n` : null;
      }
      return null;
    };
    return { readRegistry, queries };
  }

  /** 只有列出来的路径算存在：真实 Windows 路径在 macOS 上打不开，必须注入。 */
  function onlyThese(paths: readonly string[]) {
    const present = new Set(paths.map((path) => path.toLowerCase()));
    return (candidate: string) => present.has(candidate.toLowerCase());
  }

  const WINDOWS_ENV = {
    ProgramFiles: "C:\\Program Files",
    LOCALAPPDATA: "C:\\Users\\someone\\AppData\\Local",
    USERPROFILE: "C:\\Users\\someone",
    PATH: "C:\\Windows\\System32",
    PATHEXT: ".COM;.EXE;.BAT;.CMD"
  } as NodeJS.ProcessEnv;

  afterEach(() => {
    resetDesktopEngineCache();
  });

  it("finds the engine inside the ChatGPT desktop package", () => {
    // 官网下载与 Store 渠道是同一个 MSIX 包；目录不能枚举，但精确路径可执行。
    const name = "OpenAI.Codex_26.1120.6357.0_arm64__2p2nqsd0c76g0";
    const root = `C:\\Program Files\\WindowsApps\\${name}`;
    const engine = `${root}\\app\\resources\\codex.exe`;
    const { readRegistry } = registryReader([name], { [name]: root });

    expect(findExecutable("codex", WINDOWS_ENV, {
      platform: "win32",
      exists: onlyThese([engine]),
      readRegistry
    })).toBe(engine);
  });

  it("skips a package that has no engine and keeps looking", () => {
    // 同一台机器上还有 CodexPrimaryRuntime 这种不含引擎的运行时包，且它版本更高。
    const runtime = "OpenAI.CodexPrimaryRuntime.v26-1123-915-0_26.1123.915.0_arm64__3k8sg7r9htsxt";
    const app = "OpenAI.Codex_26.1120.6357.0_arm64__2p2nqsd0c76g0";
    const runtimeRoot = `C:\\Program Files\\WindowsApps\\${runtime}`;
    const appRoot = `C:\\Program Files\\WindowsApps\\${app}`;
    const engine = `${appRoot}\\app\\resources\\codex.exe`;
    const { readRegistry } = registryReader([runtime, app], { [runtime]: runtimeRoot, [app]: appRoot });

    expect(findExecutable("codex", WINDOWS_ENV, {
      platform: "win32",
      exists: onlyThese([engine]),
      readRegistry
    })).toBe(engine);
  });

  it("prefers the newest package when an old version is still installed", () => {
    const older = "OpenAI.Codex_26.1000.1.0_arm64__aaaaaaaaaaaaaaaa";
    const newer = "OpenAI.Codex_26.2000.1.0_arm64__bbbbbbbbbbbbbbbb";
    const roots = {
      [older]: `C:\\Program Files\\WindowsApps\\${older}`,
      [newer]: `C:\\Program Files\\WindowsApps\\${newer}`
    };
    const { readRegistry } = registryReader([older, newer], roots);

    expect(findExecutable("codex", WINDOWS_ENV, {
      platform: "win32",
      exists: onlyThese([
        `${roots[older]}\\app\\resources\\codex.exe`,
        `${roots[newer]}\\app\\resources\\codex.exe`
      ]),
      readRegistry
    })).toBe(`${roots[newer]}\\app\\resources\\codex.exe`);
  });

  it("uses the registry-recorded location when the package is not on the system drive", () => {
    const name = "OpenAI.Codex_26.1120.6357.0_x64__2p2nqsd0c76g0";
    const root = `D:\\WindowsApps\\${name}`;
    const engine = `${root}\\app\\resources\\codex.exe`;
    const { readRegistry } = registryReader([name], { [name]: root });

    expect(findExecutable("codex", WINDOWS_ENV, {
      platform: "win32",
      exists: onlyThese([engine]),
      readRegistry
    })).toBe(engine);
  });

  it("does not touch the registry on other platforms", () => {
    let queried = false;
    const readRegistry = () => {
      queried = true;
      return null;
    };
    expect(findExecutable("codex", { PATH: "/usr/bin" } as NodeJS.ProcessEnv, {
      platform: "darwin",
      exists: () => false,
      readRegistry
    })).toBeNull();
    expect(queried).toBe(false);
  });

  it("queries the registry once while the answer stands", () => {
    const name = "OpenAI.Codex_26.1120.6357.0_arm64__2p2nqsd0c76g0";
    const root = `C:\\Program Files\\WindowsApps\\${name}`;
    const engine = `${root}\\app\\resources\\codex.exe`;
    const { readRegistry, queries } = registryReader([name], { [name]: root });
    const options = { platform: "win32" as const, exists: onlyThese([engine]), readRegistry };

    expect(findExecutable("codex", WINDOWS_ENV, options)).toBe(engine);
    const afterFirst = queries.length;
    expect(findExecutable("codex", WINDOWS_ENV, options)).toBe(engine);
    // 第二次直接命中缓存：协助面板每次刷新都会问一遍能不能用，不该每次起一个 reg.exe。
    expect(queries.length).toBe(afterFirst);
  });

  it("looks again once the cached engine is gone", () => {
    // App 自动更新后包目录换了名字，旧路径不见了：不能一直返回那个已经不存在的路径。
    const oldName = "OpenAI.Codex_26.1120.6357.0_arm64__2p2nqsd0c76g0";
    const newName = "OpenAI.Codex_26.3000.1.0_arm64__cccccccccccccccc";
    const oldEngine = `C:\\Program Files\\WindowsApps\\${oldName}\\app\\resources\\codex.exe`;
    const newEngine = `C:\\Program Files\\WindowsApps\\${newName}\\app\\resources\\codex.exe`;

    const first = registryReader([oldName], { [oldName]: `C:\\Program Files\\WindowsApps\\${oldName}` });
    expect(findExecutable("codex", WINDOWS_ENV, {
      platform: "win32",
      exists: onlyThese([oldEngine]),
      readRegistry: first.readRegistry
    })).toBe(oldEngine);

    const second = registryReader([newName], { [newName]: `C:\\Program Files\\WindowsApps\\${newName}` });
    expect(findExecutable("codex", WINDOWS_ENV, {
      platform: "win32",
      exists: onlyThese([newEngine]),
      readRegistry: second.readRegistry
    })).toBe(newEngine);
  });
});

describe("splitCommandLine", () => {
  it("keeps a quoted Windows path in one piece", () => {
    // 覆盖值的用法就是这样：Windows 默认安装路径自带空格，按空白切会把命令切成 `C:\Program`。
    expect(splitCommandLine('"C:\\Program Files\\WindowsApps\\OpenAI.Codex\\codex.exe" app-server'))
      .toEqual(["C:\\Program Files\\WindowsApps\\OpenAI.Codex\\codex.exe", "app-server"]);
  });

  it("accepts single quotes and drops them", () => {
    expect(splitCommandLine("'/opt/my agents/codex' --profile acp"))
      .toEqual(["/opt/my agents/codex", "--profile", "acp"]);
  });

  it("splits plain values exactly like splitting on whitespace", () => {
    expect(splitCommandLine("  codex   app-server  ")).toEqual(["codex", "app-server"]);
    expect(splitCommandLine("codex")).toEqual(["codex"]);
    expect(splitCommandLine("   ")).toEqual([]);
  });
});
