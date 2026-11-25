/**
 * Codex 的列表读索引库（`state_<N>.sqlite` 的 `threads` 表），不读会话文件。
 *
 * <p>这些用例锁住三件事：读出来的字段与文件扫描一致（标题、目录、分组、最后活动时间）、Codex 自己发起的记录
 * 不进列表、以及会话文件被压成 `.jsonl.zst` 之后仍然能找到它。</p>
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { SourceAdapter } from "@memmy/agent-source-readers/adapters/types";
import { codexSessionFileFor, listCodexIndexSessions } from "../session-metadata/codex-index.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

interface ThreadSeed {
  id: string;
  name?: string | null;
  title?: string;
  firstUserMessage?: string;
  cwd?: string | null;
  updatedAt?: number;
  threadSource?: string;
  archived?: number;
  rolloutPath?: string;
}

describe("codex index listing", () => {
  it("lists people's own threads with the title Codex gave them and the project they ran in", async () => {
    const { adapter } = setup({
      threads: [
        thread({ id: "t-1", name: "评估项目追加文件夹需求", firstUserMessage: "帮我看下追加文件夹怎么做", cwd: "/repo/App", updatedAt: 1_795_514_529 }),
        thread({ id: "t-2", name: null, firstUserMessage: "没有起名的一问", cwd: "/repo/App", updatedAt: 1_795_500_000 })
      ],
      projectRoots: [["p-1", "Memmy", "/repo"]]
    });

    const sessions = await listCodexIndexSessions(adapter, 100);

    expect(sessions?.map((session) => session.conversationId)).toEqual(["t-1", "t-2"]);
    // 名字是 Codex 自己生成的标题；没起名的用它记录的第一句。
    expect(sessions?.[0]?.title).toBe("评估项目追加文件夹需求");
    expect(sessions?.[0]?.lastQuestion).toBe("帮我看下追加文件夹怎么做");
    expect(sessions?.[1]?.title).toBe("没有起名的一问");
    // 目录落在 Codex 项目的 root 下就归入那个项目，与文件扫描的分组同一套规则。
    expect(sessions?.[0]?.group).toEqual({ id: "p-1", label: "Memmy", path: null });
    expect(sessions?.[0]?.updatedAt).toBe(new Date(1_795_514_529_000).toISOString());
  });

  it("leaves out archived threads and the ones Codex started itself", async () => {
    const { adapter } = setup({
      threads: [
        thread({ id: "mine", name: "我的任务", cwd: "/repo" }),
        thread({ id: "archived", name: "归档的", cwd: "/repo", archived: 1 }),
        thread({ id: "review", name: "Guardian review", cwd: "/repo", threadSource: "guardian_review" }),
        thread({ id: "sub", name: "子 Agent 的记录", cwd: "/repo", threadSource: "subagent" })
      ]
    });

    const sessions = await listCodexIndexSessions(adapter, 100);

    expect(sessions?.map((session) => session.conversationId)).toEqual(["mine"]);
  });

  it("finds a session file Codex compressed, and forgets one it removed", async () => {
    const { adapter, root } = setup({
      threads: [
        thread({ id: "compressed", name: "压过的会话", cwd: "/repo", rolloutPath: join("sessions", "2026", "11", "24", "rollout-old.jsonl") }),
        thread({ id: "gone", name: "文件不见了", cwd: "/repo", rolloutPath: join("sessions", "2026", "11", "24", "rollout-gone.jsonl") })
      ]
    });
    // Codex 写完之后把 rollout 压成 `.jsonl.zst`，索引里记的还是 `.jsonl`。
    writeFileSync(join(root, "sessions", "2026", "11", "24", "rollout-old.jsonl.zst"), Buffer.from("KLUv/QRogQAAeyJhIjoxfQp7ImIiOjJ9ChNHTEg=", "base64"));

    const sessions = await listCodexIndexSessions(adapter, 100);

    // 存档仍然能列出来（标题、时间都在索引里），但读正文时要知道它是存档而不是「不存在」。
    expect(sessions?.map((session) => session.conversationId)).toEqual(["compressed"]);
    await expect(codexSessionFileFor(adapter, "compressed")).resolves.toEqual({
      path: join(root, "sessions", "2026", "11", "24", "rollout-old.jsonl.zst"),
      archived: true
    });
    await expect(codexSessionFileFor(adapter, "gone")).resolves.toBeNull();
  });

  it("answers null when this Codex keeps no index, so the caller can scan the files instead", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "codex-index-"));
    const sessionsRoot = join(tempDir, "sessions");
    mkdirSync(sessionsRoot, { recursive: true });
    const adapter = codexAdapter(sessionsRoot);

    await expect(listCodexIndexSessions(adapter, 100)).resolves.toBeNull();
  });
});

function thread(seed: ThreadSeed): ThreadSeed {
  return seed;
}

/** A Codex home with an index database, its session files present, and an adapter pointing at the sessions folder. */
function setup(options: { threads: ThreadSeed[]; projectRoots?: Array<[string, string, string]> }): {
  adapter: SourceAdapter;
  root: string;
} {
  tempDir = mkdtempSync(join(tmpdir(), "codex-index-"));
  const root = tempDir;
  const sessionsRoot = join(root, "sessions");
  const rolloutDir = join(sessionsRoot, "2026", "11", "24");
  mkdirSync(rolloutDir, { recursive: true });

  const database = new DatabaseSync(join(root, "state_5.sqlite"));
  database.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      title TEXT,
      name TEXT,
      first_user_message TEXT,
      cwd TEXT,
      updated_at INTEGER,
      updated_at_ms INTEGER,
      created_at INTEGER,
      thread_source TEXT,
      archived INTEGER DEFAULT 0,
      rollout_path TEXT
    );
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, position INTEGER DEFAULT 0);
    CREATE TABLE project_roots (project_id TEXT, path TEXT, position INTEGER DEFAULT 0);
  `);
  for (const [projectId, name, path] of options.projectRoots ?? []) {
    database.prepare("INSERT INTO projects (id, name) VALUES (?, ?)").run(projectId, name);
    database.prepare("INSERT INTO project_roots (project_id, path) VALUES (?, ?)").run(projectId, path);
  }
  for (const seed of options.threads) {
    const file = seed.rolloutPath === undefined ? join("sessions", "2026", "11", "24", `rollout-${seed.id}.jsonl`) : seed.rolloutPath;
    // 明文的会话文件建出来；压缩的那份由用例自己写，缺文件的那个故意不建。
    if (seed.id !== "gone" && seed.id !== "compressed") {
      writeFileSync(join(root, file), "");
    }
    database.prepare(`
      INSERT INTO threads (id, title, name, first_user_message, cwd, updated_at, updated_at_ms, created_at, thread_source, archived, rollout_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      seed.id,
      seed.title ?? seed.firstUserMessage ?? "",
      seed.name ?? null,
      seed.firstUserMessage ?? seed.title ?? "",
      seed.cwd ?? null,
      seed.updatedAt ?? 1_795_514_529,
      (seed.updatedAt ?? 1_795_514_529) * 1000,
      (seed.updatedAt ?? 1_795_514_529) - 3_600,
      seed.threadSource ?? "user",
      seed.archived ?? 0,
      file
    );
  }
  database.close();

  return { adapter: codexAdapter(sessionsRoot), root };
}

function codexAdapter(sessionsRoot: string): SourceAdapter {
  return {
    descriptor: { sourceId: "codex", displayName: "Codex", builtin: true, dataPath: sessionsRoot },
    detect: async () => true,
    async *scan() {
      return;
    }
  };
}
