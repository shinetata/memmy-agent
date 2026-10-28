// @vitest-environment happy-dom

/**
 * The board's task list, as the prototype draws it: a segmented member filter, day headings
 * (今天 / 昨天 / 本周 / 更早), and rows whose right side is the member and the moment.
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
  listSessions: vi.fn(),
  getSyncProgress: vi.fn(),
  syncSessions: vi.fn(),
  knowledge: vi.fn(),
  getLinks: vi.fn(),
  listProjectTasks: vi.fn(),
  readSessionDetail: vi.fn()
}));

vi.mock("../../api/collab-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/collab-client.js")>();
  return { ...actual, createHttpCollabClient: () => mocks };
});

vi.mock("../../app/providers.js", () => ({
  useApiClients: () => ({ clients: { runtimeConfig: {}, memmyAgent: null }, setClients: vi.fn() })
}));

vi.mock("../app-frame.js", () => ({
  AppFrame: (props: { children: ReactNode }) => <div>{props.children}</div>
}));

vi.mock("../../state/app-state.js", () => ({
  // 内联在工厂里：vi.mock 会被提升到模块顶部，引用模块级常量会先在初始化前取到。
  useOptionalAppState: () => ({
    state: {
      agent: {
        projects: [{ id: "local-1", name: "Memmy 开发", rootPath: "/Users/me/Memmy", pinned: false, createdAt: "2026-10-21T03:00:00.000Z" }],
        tasks: []
      }
    },
    dispatch: vi.fn()
  })
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CLOUD_PROJECT = {
  id: "cloud-1",
  name: "Memmy 开发",
  role: "owner",
  memberCount: 2,
  sessionCount: 3,
  createdAt: "2026-10-23T03:00:00.000Z",
  localProjectId: "local-1"
};

/* 看板属于本机的项目，共享是它上面的一层；云端项目通过 localProjectId 挂到该项目上（见上面的 mock）。 */

/** A moment today, yesterday, or `daysAgo` days back, so the day headings are stable whatever the hour. */
function daysBack(days: number, hour: number, minute: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
}

function session(index: number, input: { title: string; lastQuestion: string; mine: boolean; lastActiveAt: string }) {
  return {
    id: `s-${index}`,
    projectId: CLOUD_PROJECT.id,
    projectName: CLOUD_PROJECT.name,
    title: input.title,
    lastQuestion: input.lastQuestion,
    memberName: input.mine ? "林晓" : "陈墨",
    mine: input.mine,
    source: "claude_code",
    turnCount: 4,
    lastActiveAt: input.lastActiveAt,
    link: `https://memmy.test/s/s-${index}`,
    shareText: `【Memmy】${input.title}`
  };
}

const SESSIONS = [
  session(1, { title: "事项页的视觉重做", lastQuestion: "C 端产品，高级简约最重要。", mine: true, lastActiveAt: daysBack(0, 9, 5) }),
  session(2, { title: "删除成员权重", lastQuestion: "权重相关的字段和文案都去掉。", mine: true, lastActiveAt: daysBack(1, 14, 20) }),
  session(3, { title: "任务按额度滚动保留", lastQuestion: "每人每项目保留多少个合适？", mine: false, lastActiveAt: daysBack(12, 11, 0) })
];

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
  }
}

describe("collab task list", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    resetCollabProjectsStore();
    mocks.listProjects.mockResolvedValue([CLOUD_PROJECT]);
    mocks.listSessions.mockResolvedValue({ project: CLOUD_PROJECT, sessions: SESSIONS, total: SESSIONS.length });
    mocks.getSyncProgress.mockResolvedValue({ running: false, total: 0, completed: 0, failed: 0 });
    mocks.syncSessions.mockResolvedValue({ uploaded: 0, removed: 0, failed: 0 });
    mocks.knowledge.mockResolvedValue({ bases: [], maxBases: 10, canManage: false });
    mocks.getLinks.mockResolvedValue({ groups: [], sessions: [] });
    mocks.listProjectTasks.mockResolvedValue([]);
    mocks.readSessionDetail.mockResolvedValue({ session: SESSIONS[2], turns: [] });

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    resetCollabProjectsStore();
  });

  async function renderBoard(): Promise<void> {
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <CollabPage />
        </I18nProvider>
      );
    });
    await flush();
  }

  function groupButtons(): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>("h2 button"));
  }

  /** 「今天 1」这样的标题文字：分组名后面跟着这一组的条数。 */
  function headings(): string[] {
    return groupButtons().map((element) => element.textContent?.trim() ?? "");
  }

  async function toggleGroup(label: string): Promise<void> {
    const found = groupButtons().find((element) => element.textContent?.trim().startsWith(label));
    expect(found, `分组「${label}」应已渲染`).toBeTruthy();
    await act(async () => found!.click());
    await flush();
  }

  it("splits the rows into 今天 / 昨天 / 更早 headings, with their counts", async () => {
    await renderBoard();
    // 本周内没有任务时不出现「本周」，避免空标题。
    expect(headings()).toEqual(["今天1", "昨天1", "更早1"]);
  });

  it("opens only the newest group until another one is opened", async () => {
    await renderBoard();
    // 默认只展开最近的一组：一屏不铺开十几条。
    expect(document.querySelectorAll("li")).toHaveLength(1);
    expect(document.body.textContent).toContain("你 · 09:05");
    expect(document.body.textContent).not.toContain("你 · 昨天");

    await toggleGroup("昨天");
    expect(document.querySelectorAll("li")).toHaveLength(2);
    expect(document.body.textContent).toContain("你 · 昨天");

    // 点过之后按点过的算：再点一次收起
    await toggleGroup("昨天");
    expect(document.querySelectorAll("li")).toHaveLength(1);
    expect(groupButtons()[1]?.getAttribute("aria-expanded")).toBe("false");
  });

  it("puts the member and the moment on the right of each row", async () => {
    await renderBoard();
    await toggleGroup("昨天");
    await toggleGroup("更早");
    expect(document.querySelectorAll("li")).toHaveLength(3);
    expect(document.body.textContent).toContain("你 · 09:05");
    expect(document.body.textContent).toContain("你 · 昨天");
    // 更早的任务写日期：月日跟着本机时区走，只断言格式。
    expect(document.body.textContent).toMatch(/陈墨 · \d{1,2}月\d{1,2}日/);
  });

  it("filters by member from the segmented control", async () => {
    await renderBoard();
    const segment = Array.from(document.querySelectorAll<HTMLElement>("button"))
      .find((element) => element.textContent?.trim() === "我的");
    expect(segment, "筛选胶囊里应有「我的」").toBeTruthy();
    expect(segment!.getAttribute("aria-pressed")).toBe("false");

    await act(async () => segment!.click());
    await flush();

    expect(mocks.listSessions).toHaveBeenLastCalledWith(CLOUD_PROJECT.id, expect.objectContaining({ member: "me" }));
  });

  it("opens someone else's session as a floating panel, not a dialog", async () => {
    // 云端里别人的任务用右侧浮起的面板读：看板留在原处，不是抽屉也不是居中弹窗。
    mocks.readSessionDetail.mockResolvedValue({
      session: SESSIONS[2],
      turns: [
        { question: "每人每项目保留多少个？", reply: "先按 20 个滚动保留。", steps: ["Bash"], startedAt: "2026-10-26T15:11:00.000Z" },
        { question: "超出的怎么处理？", reply: "丢弃最早的一轮。", steps: [], startedAt: "2026-10-26T15:20:00.000Z" }
      ]
    });
    await renderBoard();
    // 同一天一组默认只展开「今天」，别人这条在「更早」里，先展开再点。
    const earlier = Array.from(document.querySelectorAll<HTMLElement>("button"))
      .find((element) => element.textContent?.trim().startsWith("更早"));
    expect(earlier, "应有「更早」分组").toBeTruthy();
    await act(async () => earlier!.click());
    await flush();

    const title = Array.from(document.querySelectorAll<HTMLElement>("span"))
      .find((element) => element.textContent?.trim() === SESSIONS[2]!.title);
    expect(title, "列表应显示这条任务").toBeTruthy();

    await act(async () => title!.click());
    await flush();

    const panel = document.querySelector<HTMLElement>("[data-collab-reader]");
    expect(panel, "读取视图应作为浮起的面板出现").toBeTruthy();
    // 面板浮在页面上，不接管整屏：没有 .modal，也不声明成模态
    expect(document.querySelector(".modal")).toBeNull();
    expect(panel!.getAttribute("aria-modal")).toBe("false");
    expect(panel!.querySelector("h2")?.textContent).toBe(SESSIONS[2]!.title);
    expect(panel!.textContent).toContain("仅供查看");
    // 轮次照旧：提问一条、回复一条，工具步骤不出现
    expect(panel!.querySelectorAll('[data-collab-role="user"]')).toHaveLength(2);
    expect(panel!.querySelectorAll('[data-collab-role="agent"]')).toHaveLength(2);
    expect(panel!.textContent).toContain("第 1 轮");
    expect(panel!.textContent).not.toContain("Bash");
    // 一个任务只标一次 Agent 名
    expect(panel!.textContent?.match(/Claude Code/g) ?? []).toHaveLength(1);

    // Esc 关闭，面板回到看板
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    await flush();
    expect(document.querySelector("[data-collab-reader]")).toBeNull();
  });
});
