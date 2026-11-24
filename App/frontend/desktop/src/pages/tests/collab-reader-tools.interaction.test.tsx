// @vitest-environment happy-dom

/**
 * 任务阅读面板里的工具步骤。
 *
 * 改动后一轮可能有一两百步（例如一轮 163 次调用全部保留），面板要让人一眼看出做了多少事、哪里失败，
 * 又不能被几百行刷屏：标题先给步数与失败数，同名连续成功调用折成一组，失败的一步单独摊开。
 */
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetCollabProjectsStore } from "../../app/collab-projects-store.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { CollabPage } from "../collab-page.js";

const mocks = vi.hoisted(() => ({
  listProjects: vi.fn(),
  listAddedAgents: vi.fn().mockResolvedValue([]),
  knowledge: vi.fn(),
  listSessions: vi.fn(),
  readSessionDetail: vi.fn(),
  removeSession: vi.fn(),
  syncSessions: vi.fn(),
  getSyncProgress: vi.fn(),
  writeText: vi.fn()
}));

vi.mock("../../api/collab-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/collab-client.js")>();
  return { ...actual, createHttpCollabClient: () => mocks };
});

vi.mock("../../app/providers.js", () => ({
  useApiClients: () => ({ clients: { runtimeConfig: {} }, setClients: vi.fn() })
}));

vi.mock("../../state/app-state.js", () => ({
  useOptionalAppState: () => ({
    state: {
      agent: {
        projects: [{ id: "local-1", name: "Memmy项目协作记忆", rootPath: "/tmp/memmy", pinned: false, createdAt: "2026-10-21T03:00:00.000Z" }],
        tasks: []
      }
    },
    dispatch: vi.fn()
  })
}));

vi.mock("../app-frame.js", () => ({
  AppFrame: (props: { children: ReactNode }) => <div>{props.children}</div>
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const project = {
  id: "p-1",
  name: "Memmy项目协作记忆",
  role: "owner",
  memberCount: 2,
  sessionCount: 1,
  createdAt: "2026-10-21T03:00:00.000Z",
  localProjectId: "local-1"
};

const session = {
  id: "s-1",
  projectId: project.id,
  projectName: project.name,
  title: "长任务的工具调用",
  lastQuestion: "部署到哪里",
  memberName: "快乐团子",
  mine: true,
  source: "claude_code",
  turnCount: 2,
  lastActiveAt: "2026-10-23T03:11:00.000Z",
  link: "memmy://collab/p-1/s-1",
  shareText: "Memmy 协作会话：长任务的工具调用"
};

/** 第一轮：三步同名 Read 连在一起，Bash 之后是失败的 Write，再一个单独的 Read，最后是被丢弃的调用。 */
const TURNS = [
  {
    question: "部署到哪里",
    reply: "先看下文件再跑测试。",
    steps: [
      { name: "Read", input: "src/a.ts", output: "export const a = 1;" },
      { name: "Read", input: "src/b.ts", output: "export const b = 2;" },
      { name: "Read", input: "src/c.ts", output: "export const c = 3;" },
      { name: "Bash", input: "npm test", output: "1 passed\n2 skipped\nDone in 1.2s" },
      {
        name: "Write",
        input: "src/d.ts",
        output: "Error: ENOENT: no such file or directory\n  at write (src/d.ts:1:1)\n  1 failed",
        failed: true
      },
      { name: "Read", input: "src/e.ts", output: "export const e = 5;" },
      { name: "", input: "", output: "[... 1 tool calls omitted ...]" }
    ],
    startedAt: "2026-10-26T15:11:00.000Z"
  },
  {
    question: "再确认一下",
    reply: "改完了。",
    steps: [{ name: "", input: "", output: "[... 1 tool calls omitted ...]" }],
    startedAt: "2026-10-26T15:20:00.000Z",
    omittedBefore: 1
  }
];

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
  }
}

describe("collab reader tool steps", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    resetCollabProjectsStore();
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText: mocks.writeText },
      configurable: true
    });
    mocks.listProjects.mockResolvedValue([project]);
    mocks.knowledge.mockResolvedValue({ bases: [], maxBases: 10, canManage: false });
    mocks.listSessions.mockResolvedValue({ project, sessions: [session], total: 1 });
    mocks.getSyncProgress.mockResolvedValue({ running: false, total: 0, completed: 0, failed: 0 });
    mocks.syncSessions.mockResolvedValue({ uploaded: 0, removed: 0, failed: 0 });
    mocks.readSessionDetail.mockResolvedValue({ session, turns: TURNS });
    mocks.writeText.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    resetCollabProjectsStore();
  });

  async function openReader(language: "zh-CN" | "en-US" = "zh-CN"): Promise<HTMLElement> {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <I18nProvider language={language}>
          <CollabPage />
        </I18nProvider>
      );
    });
    await flush();

    const title = Array.from(container.querySelectorAll<HTMLElement>("span"))
      .find((entry) => entry.textContent?.trim() === session.title);
    expect(title, "任务行应已渲染").toBeTruthy();
    await act(async () => title!.click());
    await flush();

    const panel = document.querySelector<HTMLElement>("[data-collab-reader]");
    expect(panel, "应打开阅读面板").toBeTruthy();
    return panel!;
  }

  /** 一轮的折叠区：标题（步数与失败数）加下面的步骤列表。 */
  function turnFold(panel: HTMLElement, index: number): { summary: string; list: HTMLOListElement } {
    const turns = [...panel.querySelectorAll<HTMLElement>("article")];
    const fold = turns[index]!.querySelector<HTMLDetailsElement>(":scope > details");
    expect(fold, `第 ${index + 1} 轮应有工具步骤折叠区`).toBeTruthy();
    return {
      summary: fold!.querySelector("summary")?.textContent ?? "",
      list: fold!.querySelector<HTMLOListElement>("ol")!
    };
  }

  it("says how many calls a turn made and how many of them failed", async () => {
    const panel = await openReader();
    // 六次列出来的调用加一次被丢弃的调用；其中一次写文件失败。
    expect(turnFold(panel, 0).summary).toContain("执行了 7 步");
    expect(turnFold(panel, 0).summary).toContain("，1 步失败");
    // 只有占位说明的一轮不报步数，直接说略去了几次调用。
    expect(turnFold(panel, 1).summary).toContain("已略去 1 次工具调用");
    expect(turnFold(panel, 1).summary).not.toContain("失败");
  });

  it("folds a run of same-name successful calls into one row that expands", async () => {
    const panel = await openReader();
    const rows = [...turnFold(panel, 0).list.querySelectorAll<HTMLElement>(":scope > li")];
    // 三步 Read 合成一行；Bash、失败的 Write、单步 Read、占位说明各占一行。
    expect(rows).toHaveLength(5);

    const group = rows[0]!;
    const summary = group.querySelector("summary");
    expect(summary?.textContent).toContain("Read ×3");
    // 后面跟第一步的入参，方便认出这批读的是什么。
    expect(summary?.textContent).toContain("src/a.ts");

    const details = group.querySelector<HTMLDetailsElement>("details")!;
    expect(details.open, "分组默认收起").toBe(false);
    expect(details.querySelectorAll("li")).toHaveLength(3);
    expect(details.textContent).toContain("src/c.ts");

    await act(async () => summary!.click());
    expect(details.open, "点一下展开组内每一步").toBe(true);
  });

  it("keeps a failed step out of the group and shows its output without another click", async () => {
    const panel = await openReader();
    const rows = [...turnFold(panel, 0).list.querySelectorAll<HTMLElement>(":scope > li")];

    // 失败的一步打断分组：它既不在 Read 组里，也不和后面那个 Read 合成组。
    expect(rows[0]!.textContent).not.toContain("src/d.ts");
    expect(rows[3]!.textContent).toContain("src/e.ts");
    expect(rows[3]!.querySelector("summary")?.textContent).toContain("src/e.ts");

    const failed = rows[2]!;
    expect(failed.textContent).toContain("Write");
    expect(failed.textContent).toContain("失败");
    const details = failed.querySelector<HTMLDetailsElement>("details")!;
    expect(details.open, "失败的步骤默认展开").toBe(true);
    expect(details.querySelector("pre")?.textContent).toContain("ENOENT");
    expect(details.querySelector("pre")?.textContent).toContain("1 failed");
  });

  it("expands one step to its whole stored output", async () => {
    const panel = await openReader();
    const rows = [...turnFold(panel, 0).list.querySelectorAll<HTMLElement>(":scope > li")];
    const bash = rows[1]!;
    const details = bash.querySelector<HTMLDetailsElement>("details")!;
    expect(bash.querySelector("summary")?.textContent).toContain("npm test");
    expect(details.open).toBe(false);
    expect(details.querySelector("pre")?.textContent).toBe("1 passed\n2 skipped\nDone in 1.2s");

    await act(async () => bash.querySelector("summary")!.click());
    expect(details.open, "点一下这一步就展开完整输出").toBe(true);
  });

  it("keeps the omitted-call row and the omitted-turn note", async () => {
    const panel = await openReader();
    const rows = [...turnFold(panel, 0).list.querySelectorAll<HTMLElement>(":scope > li")];
    expect(rows[4]!.textContent).toContain("已略去 1 次工具调用");
    expect(panel.textContent).toContain("已略去 1 轮");
  });

  it("uses singular English counts for one step, one failure and one omitted call", async () => {
    const panel = await openReader("en-US");
    expect(turnFold(panel, 0).summary).toContain("Ran 7 steps");
    expect(turnFold(panel, 0).summary).toContain(", 1 step failed");
    expect(turnFold(panel, 1).summary).toContain("Omitted 1 tool call");
    expect(turnFold(panel, 1).summary).not.toContain("tool calls");
    expect(panel.textContent).toContain("Omitted 1 turn");
    expect(panel.textContent).not.toContain("1 turns");
    expect(turnFold(panel, 0).list.textContent).toContain("Read ×3");
  });
});
