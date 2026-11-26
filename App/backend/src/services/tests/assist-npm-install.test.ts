import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareVersions,
  extractPackage,
  packageMatchesPlatform,
  pickVersion,
  readTarEntries,
  resolveInstallPlan,
  satisfiesRange
} from "../assist/npm-install.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "memmy-npm-install-"));
  roots.push(root);
  return root;
}

/**
 * 造一个最小 tar：只写 ustar 的固定字段，用于验证解包本身。
 * 真实 npm 包用的是同一套 header，多出来的只有 pax 扩展头（长路径）。
 */
function tarEntry(name: string, body: string, type = "0"): Buffer {
  const content = Buffer.from(body, "utf8");
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "utf8");
  header.write("0000000\0", 108, 8, "utf8");
  header.write("0000000\0", 116, 8, "utf8");
  header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124, 12, "utf8");
  header.write("00000000000\0", 136, 12, "utf8");
  header.write("        ", 148, 8, "utf8");
  header.write(type, 156, 1, "utf8");
  header.write("ustar\0" + "00", 257, 8, "utf8");
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512, 0);
  return Buffer.concat([header, content, padding]);
}

describe("版本范围", () => {
  it("compares three-part versions and puts a prerelease below its release", () => {
    expect(compareVersions("1.2.3", "1.2.4")).toBe(-1);
    expect(compareVersions("2.0.0", "2.0.0")).toBe(0);
    expect(compareVersions("1.0.0-beta", "1.0.0")).toBe(-1);
  });

  it("reads the ranges these adapters actually declare", () => {
    expect(satisfiesRange("4.6.7", "^4.0.0")).toBe(true);
    expect(satisfiesRange("5.0.0", "^4.0.0")).toBe(false);
    expect(satisfiesRange("2.6.9", "~2.6.0")).toBe(true);
    expect(satisfiesRange("2.7.0", "~2.6.0")).toBe(false);
    expect(satisfiesRange("9.0.3", "^9.0.1")).toBe(true);
    expect(satisfiesRange("3.1.1", ">=3.0.0")).toBe(true);
    expect(satisfiesRange("0.0.34", "^0.0.34")).toBe(true);
    expect(satisfiesRange("0.0.35", "^0.0.34")).toBe(false);
  });

  it("picks the highest stable version that satisfies the range", () => {
    const versions = ["4.5.0-beta.1", "4.5.0", "4.6.7", "5.0.0", "4.6.8-rc.1"];
    expect(pickVersion(versions, "^4.0.0")).toBe("4.6.7");
    expect(pickVersion(["1.0.0"], "^2.0.0")).toBeNull();
  });
});

describe("解开 npm 包", () => {
  it("drops the package/ prefix and writes the files under the target", () => {
    const root = tempRoot();
    const archive = Buffer.concat([
      tarEntry("package/", "", "5"),
      tarEntry("package/package.json", JSON.stringify({ name: "x", version: "1.0.0" })),
      tarEntry("package/dist/index.js", "console.log(1);\n")
    ]);
    extractPackage(archive, join(root, "node_modules", "x"));

    // 解出来的必须只是包内容，外层 package/ 不能出现在目标目录里。
    expect(readFileSync(join(root, "node_modules", "x", "package.json"), "utf8")).toContain("\"version\":\"1.0.0\"");
    expect(readFileSync(join(root, "node_modules", "x", "dist", "index.js"), "utf8")).toContain("console.log(1)");
  });

  it("reads the archive the way the registry serves it: gunzip, then read the tar", () => {
    // registry 给的是 .tgz：调用方先 gunzipSync 再解包，这条链路要和真实包一致。
    const compressed = gzipSync(Buffer.concat([tarEntry("package/a.txt", "hello")]));
    const entries = readTarEntries(gunzipSync(compressed));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe("package/a.txt");
    expect(entries[0]?.body.toString("utf8")).toBe("hello");
  });

  it("refuses entries that try to escape the target directory", () => {
    const root = tempRoot();
    const archive = Buffer.concat([tarEntry("package/../../evil.txt", "x")]);
    extractPackage(archive, join(root, "node_modules", "x"));
    expect(() => readFileSync(join(root, "evil.txt"), "utf8")).toThrow();
  });
});

describe("平台相关的可选依赖", () => {
  /** 一份能冒充 npm registry 的 fetch：按 URL 尾巴返回预设元数据。 */
  function fakeRegistry(metadata: Record<string, unknown>): typeof fetch {
    return (async (input: string | URL | Request) => {
      const url = String(input);
      // `/包名` 取版本表，`/包名/版本` 取单个版本的元数据。
      const body = metadata[url];
      if (body === undefined) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
  }

  function version(tarball: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { dist: { tarball, integrity: null }, dependencies: {}, ...extra };
  }

  it("installs the platform package that matches the machine and skips the others", async () => {
    const registry = "https://registry.test";
    const fetchImpl = fakeRegistry({
      [`${registry}/@openai%2fcodex-acp/2.12.0`]: version("https://t/codex-acp.tgz", {
        optionalDependencies: { "@openai/codex-win32-arm64": "0.171.0", "@openai/codex-win32-x64": "0.171.0" }
      }),
      [`${registry}/@openai%2fcodex-win32-arm64/0.171.0`]: version("https://t/arm64.tgz", { os: ["win32"], cpu: ["arm64"] }),
      [`${registry}/@openai%2fcodex-win32-x64/0.171.0`]: version("https://t/x64.tgz", { os: ["win32"], cpu: ["x64"] })
    });

    const plan = await resolveInstallPlan({
      packages: [{ name: "@openai/codex-acp", version: "2.12.0" }],
      registry,
      fetch: fetchImpl,
      platform: "win32",
      arch: "arm64"
    });

    expect(plan.map((item) => item.name)).toEqual(["@openai/codex-acp", "@openai/codex-win32-arm64"]);
  });

  it("never installs a musl build, whose os/cpu look the same as the glibc one", () => {
    // 这两个包声明的 os/cpu 完全相同，只靠名字区分。
    expect(packageMatchesPlatform("@anthropic-ai/claude-agent-sdk-linux-x64-musl", { os: ["linux"], cpu: ["x64"] }, "linux", "x64"))
      .toBe(false);
    expect(packageMatchesPlatform("@anthropic-ai/claude-agent-sdk-linux-x64", { os: ["linux"], cpu: ["x64"] }, "linux", "x64"))
      .toBe(true);
  });

  it("rejects a package whose declared system does not match", async () => {
    const registry = "https://registry.test";
    const fetchImpl = fakeRegistry({
      [`${registry}/native-tool/1.0.0`]: version("https://t/native.tgz", { os: ["linux"], cpu: ["x64"] })
    });

    // 顶层明确要的包对不上要报出来，不能装作装好了。
    await expect(resolveInstallPlan({
      packages: [{ name: "native-tool", version: "1.0.0" }],
      registry,
      fetch: fetchImpl,
      platform: "win32",
      arch: "x64"
    })).rejects.toThrow(/不支持 win32-x64/u);
  });

  it("gives up on a missing platform package instead of failing the whole install", async () => {
    const registry = "https://registry.test";
    const fetchImpl = fakeRegistry({
      [`${registry}/adapter/1.0.0`]: version("https://t/adapter.tgz", {
        optionalDependencies: { "adapter-darwin-arm64": "1.0.0" }
      }),
      [`${registry}/adapter-darwin-arm64/1.0.0`]: version("https://t/mac.tgz", { os: ["darwin"], cpu: ["arm64"] })
    });

    // Windows 上那份 darwin 平台包对不上，跳过即可；适配器本身仍要装上。
    const plan = await resolveInstallPlan({
      packages: [{ name: "adapter", version: "1.0.0" }],
      registry,
      fetch: fetchImpl,
      platform: "win32",
      arch: "x64"
    });
    expect(plan.map((item) => item.name)).toEqual(["adapter"]);
  });
});
