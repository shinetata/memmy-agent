// @vitest-environment happy-dom

/**
 * 看板的任务列表按成员分区：本人第一段，其余成员各一段；段内默认五条，多的就地展开。
 * 行里只留时间，成员信息只在段头出现一次；没有任务的成员不占位。
 */
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetCollabProjectsStore } from "../../app/collab-projects-store.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { CollabPage } from "../collab-page.js";
import { ASSIST_PANEL_WIDTH_STORAGE_KEY, READER_PANEL_WIDTH_STORAGE_KEY } from "../collab-reader-resize.js";

const mocks = vi.hoisted(() => ({
  listProjects: vi.fn(),
  // 已关联的其他 Agent：这些用例不涉及，空列表即可。
  listAddedAgents: vi.fn().mockResolvedValue([]),
  listSessions: vi.fn(),
  getSyncProgress: vi.fn(),
  syncSessions: vi.fn(),
  knowledge: vi.fn(),
  getLinks: vi.fn(),
  listProjectTasks: vi.fn(),
  readSessionDetail: vi.fn(),
  listLocalSessions: vi.fn(),
  listMembers: vi.fn(),
  /** 侧栏/看板用的本机任务列表与 dispatch：点开本人任务时要落到会话页。 */
  tasks: [] as Array<{ sessionKey: string; projectId: string | null; title: string; archived?: boolean; updatedAt?: string }>,
  dispatch: vi.fn()
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
        tasks: mocks.tasks
      }
    },
    dispatch: mocks.dispatch
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

/** 成员分段的段头：按段键找（`me` 或 `member:<昵称>`）。段头是 button 角色的容器，里面还挂着「请求协助」。 */
function groupHead(name: string): HTMLElement {
  const section = groupSection(name);
  const head = section.querySelector<HTMLElement>("[data-collab-member-toggle]");
  if (!head) throw new Error(`段落「${name}」没有段头`);
  return head;
}

/** 某一位成员的整段。本人在数据里记作 `me`，其余按昵称。 */
function groupSection(name: string): HTMLElement {
  const wanted = name === "me" ? "me" : `member:${name}`;
  const section = document.querySelector<HTMLElement>(`[data-collab-member-group="${wanted}"]`)
    ?? [...document.querySelectorAll<HTMLElement>("[data-collab-member-group]")]
      .find((node) => node.querySelector("[data-collab-member-name]")?.textContent === name);
  if (!section) throw new Error(`看板里没有「${name}」这一段`);
  return section;
}

/** 页面里的段落顺序：读段头写的昵称（本人那一段也写自己的昵称）。 */
function groupNames(): string[] {
  return [...document.querySelectorAll<HTMLElement>("[data-collab-member-group]")]
    .map((node) => node.querySelector("[data-collab-member-name]")?.textContent?.trim() ?? "");
}

/** 某一段里的任务标题。 */
function titlesIn(name: string): string[] {
  const section = groupSection(name);
  return [...section.querySelectorAll<HTMLElement>("li")]
    .map((node) => node.querySelector<HTMLElement>("[data-collab-row-title]")?.textContent?.trim() ?? "")
    .filter(Boolean);
}

/** 在搜索框里输入并回车，发起一次搜索。 */
async function typeSearch(text: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>("input[aria-label='搜索任务标题、问题或成员']")!;
  await act(async () => input.dispatchEvent(new Event("input", { bubbles: true })));
  // React 的受控输入要经过原生 setter 才会更新 state。
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

/**
 * 筛选空的说明卡片：标题、说明与图标。lucide 只加一个公共的 lucide 类，
 * 所以按 svg 内部形状分三种：搜索是 cx=11 的圆，单人是一条路径，成员是多条路径。
 */
function filterEmptyCard(): { kind?: string; title: string; body: string; iconKind: string } {
  const card = document.querySelector<HTMLElement>("[data-collab-filter-empty]");
  if (!card) throw new Error("没有筛选空的说明卡片");
  const icon = card.querySelector("svg");
  if (!icon) throw new Error("说明卡片没有图标");
  const firstPath = icon.querySelector("path")?.getAttribute("d") ?? "";
  const title = card.querySelector("b");
  return {
    kind: card.dataset.collabFilterEmpty,
    title: title?.textContent ?? "",
    // 说明就在标题后面那一行 span 里（图标也是 span，按标题找更稳）。
    body: title?.nextElementSibling?.textContent ?? "",
    iconKind: icon.querySelector("circle[cx='11']") ? "search" : firstPath.startsWith("M19 21") ? "user" : "users"
  };
}

describe("collab task list", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tasks = [];
    resetCollabProjectsStore();
    mocks.listProjects.mockResolvedValue([CLOUD_PROJECT]);
    mocks.listSessions.mockResolvedValue({ project: CLOUD_PROJECT, sessions: SESSIONS, total: SESSIONS.length });
    mocks.getSyncProgress.mockResolvedValue({ running: false, total: 0, completed: 0, failed: 0 });
    mocks.syncSessions.mockResolvedValue({ uploaded: 0, removed: 0, failed: 0 });
    mocks.knowledge.mockResolvedValue({ bases: [], maxBases: 10, canManage: false });
    mocks.getLinks.mockResolvedValue({ groups: [], sessions: [] });
    mocks.listProjectTasks.mockResolvedValue([]);
    mocks.readSessionDetail.mockResolvedValue({ session: SESSIONS[2], turns: [] });
    // 空态里的「关联任务」会打开关联弹窗，它先读本机其他 Agent 的任务。
    mocks.listLocalSessions.mockResolvedValue({ sessions: [], refreshing: false });
    // 默认没有待审核的申请：看板开着的轮询不该改到其它用例的界面。
    mocks.listMembers.mockResolvedValue({
      project: CLOUD_PROJECT,
      joinMode: "approval",
      canManage: true,
      members: [],
      requests: []
    });

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
  it("splits the board into one section per member, with your own section first", async () => {
    await renderBoard();
    // 林晓（本人）在前，陈墨在后；段头写名字与数量。
    expect(groupNames()).toEqual(["林晓", "陈墨"]);
    expect(container.querySelectorAll("li")).toHaveLength(3);
    expect(titlesIn("林晓")).toEqual(["事项页的视觉重做", "删除成员权重"]);
    expect(titlesIn("陈墨")).toEqual(["任务按额度滚动保留"]);
    // 分页器没有了：整份列表一次给完。
    expect(document.body.textContent).not.toContain("下一页");
    expect(document.body.textContent).not.toContain("共 3 个任务");
  });

  it("writes the member once in the section head and only the time on each row", async () => {
    await renderBoard();
    const row = [...container.querySelectorAll<HTMLElement>("li")]
      .find((node) => node.textContent?.includes("事项页的视觉重做"))!;
    // 行里不再重复昵称，也没有头像；时间还在。
    expect(row.textContent).not.toContain("林晓 ·");
    expect(row.querySelector("img, span[aria-hidden='true'].avatar")).toBeNull();
    expect(row.textContent).toMatch(/\d{2}:\d{2}/);
    // 段头一次：名字 + 数量 + 头像。
    expect(groupHead("林晓").textContent).toContain("林晓");
    expect(groupHead("林晓").textContent).toContain("2 个任务");
  });

  it("shows five rows per member and expands the rest in place", async () => {
    const many = Array.from({ length: 8 }, (_, index) => ({
      ...SESSIONS[0]!,
      id: `mine-${index}`,
      title: `我的任务 ${index + 1}`,
      lastActiveAt: daysBack(0, 9 + index, 0)
    }));
    mocks.listSessions.mockResolvedValue({ project: CLOUD_PROJECT, sessions: many, total: many.length });
    await renderBoard();

    expect(container.querySelectorAll("li")).toHaveLength(5);
    expect(document.body.textContent).toContain("展开其余 3 个");

    const more = [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((node) => node.textContent?.trim().startsWith("展开其余"))!;
    await act(async () => more.click());
    expect(container.querySelectorAll("li")).toHaveLength(8);
    expect(document.body.textContent).toContain("收起");
  });

  it("collapses a whole section to its head and back", async () => {
    await renderBoard();
    expect(titlesIn("陈墨")).toHaveLength(1);

    await act(async () => groupHead("陈墨").click());
    expect(titlesIn("陈墨")).toHaveLength(0);
    expect(groupHead("陈墨").getAttribute("aria-expanded")).toBe("false");
    // 段头本身还在，数量和名字都看得到。
    expect(groupHead("陈墨").textContent).toContain("1 个任务");

    await act(async () => groupHead("陈墨").click());
    expect(titlesIn("陈墨")).toHaveLength(1);
  });

  it("does not reserve a section for a member without tasks", async () => {
    // 云端列出了三位成员，但只有两人有任务：没有任务的许知不占段落，也不在末尾收成一行。
    mocks.listMembers.mockResolvedValue({
      project: CLOUD_PROJECT,
      joinMode: "approval",
      canManage: true,
      members: [
        { userId: "1", name: "林晓", role: "owner", mine: true },
        { userId: "2", name: "陈墨", role: "member", mine: false },
        { userId: "3", name: "许知", role: "member", mine: false }
      ],
      requests: []
    });
    await renderBoard();

    expect(groupNames()).toEqual(["林晓", "陈墨"]);
    expect(document.body.textContent).not.toContain("许知 还没有任务");
    expect(document.body.textContent).not.toContain("还没有任务");
  });

  it("hides a summary that stopped on an agent's task notification", async () => {
    // Cursor 把 shell 完成通知写成了一轮，旧记录里摘要就停在这串标签上；任务行只留标题。
    const notified = session(9, {
      title: "Codex login record removal",
      lastQuestion: "<timestamp>Friday, Oct 30, 2026, 12:08 PM (UTC+8)</timestamp> <system_notification> The following task has finished.",
      mine: true,
      lastActiveAt: daysBack(0, 12, 8)
    });
    mocks.listSessions.mockResolvedValue({ project: CLOUD_PROJECT, sessions: [notified], total: 1 });
    await renderBoard();

    expect(container.textContent).toContain("Codex login record removal");
    expect(container.textContent).not.toContain("<timestamp>");
    expect(container.textContent).not.toContain("system_notification");
  });

  it("shows the join requests waiting on the invite button, without opening the dialog", async () => {
    mocks.listMembers.mockResolvedValue({
      project: CLOUD_PROJECT,
      joinMode: "approval",
      canManage: true,
      members: [],
      requests: [
        { userId: "10", name: "苏禾", inviterName: "林晓", createdAt: null },
        { userId: "11", name: "许一", inviterName: "林晓", createdAt: null }
      ]
    });
    await renderBoard();
    const invite = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find((element) => element.textContent?.includes("邀请"));
    expect(invite, "看板头部应有「邀请」入口").toBeTruthy();
    expect(invite!.title).toBe("2 个加入申请待审核");
    expect(invite!.textContent).toContain("2");
  });

  it("keeps only the members whose tasks match the search, and counts the matches", async () => {
    const matched = [
      session(11, { title: "退款回调重试", lastQuestion: "重试三次后放弃。", mine: true, lastActiveAt: daysBack(0, 10, 0) }),
      session(12, { title: "退款回调的日志", lastQuestion: "把请求体和响应都记下来。", mine: false, lastActiveAt: daysBack(1, 10, 0) })
    ];
    mocks.listSessions.mockImplementation(async (_project, options) => {
      // 云端按查询词过滤：这里模拟同一条查询只回命中项。
      const hits = options?.query ? matched : SESSIONS;
      return { project: CLOUD_PROJECT, sessions: hits, total: hits.length };
    });
    await renderBoard();

    await typeSearch("退款");
    await flush();

    expect(groupNames()).toEqual(["林晓", "陈墨"]);
    // 段头改说命中数，不再说总数。
    expect(groupHead("林晓").textContent).toContain("命中 1 个");
    expect(groupHead("陈墨").textContent).toContain("命中 1 个");
    // 搜索跨所有成员：本机筛选一次、云端查询一次，之后不再带成员参数。
    expect(mocks.listSessions).toHaveBeenLastCalledWith(CLOUD_PROJECT.id, { query: "退款" });
  });

  it("explains an empty result under the search box, with the query in the title", async () => {
    mocks.listSessions.mockResolvedValue({ project: CLOUD_PROJECT, sessions: [], total: 0 });
    await renderBoard();

    await typeSearch("退款回调");
    await flush();

    const card = filterEmptyCard();
    expect(card.kind).toBe("search");
    expect(card.iconKind).toBe("search");
    expect(card.title).toBe("没有匹配「退款回调」的任务");
    expect(card.body).toBe("换个关键词试试，或清除搜索。");
    // 空结果不画任何段头。
    expect(groupNames()).toEqual([]);
  });

  it("keeps the search out of the way while selecting", async () => {
    await renderBoard();
    const selectButton = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find((entry) => entry.textContent?.trim() === label)!;

    await act(async () => selectButton("多选").click());
    expect(document.querySelector("input[aria-label='搜索任务标题、问题或成员']")).toBeNull();
    await act(async () => selectButton("取消").click());
    expect(document.querySelector("input[aria-label='搜索任务标题、问题或成员']")).not.toBeNull();
  });

  it("selects and clears only your own tasks across every section", async () => {
    await renderBoard();
    const button = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find((entry) => entry.textContent?.trim() === label);

    await act(async () => button("多选")!.click());
    const checks = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    // 只有本人的两条可选，他人的任务没有勾选框。
    expect(checks).toHaveLength(2);
    await act(async () => checks[0]!.click());
    expect(document.body.textContent).toContain("已选 1 个");
    expect(button("全选")).toBeTruthy();

    await act(async () => button("全选")!.click());
    expect(checks.every((check) => check.checked)).toBe(true);
    expect(document.body.textContent).toContain("已选 2 个");
    expect(button("取消全选")).toBeTruthy();
    await act(async () => button("取消全选")!.click());
    expect(checks.every((check) => !check.checked)).toBe(true);
    expect(button("全选")).toBeTruthy();
  });

  it("opens the member's own Memmy task in its conversation page instead of the read-only panel", async () => {
    // 本人在 Memmy 里建的任务正文就在本机：点开直接进会话页，不必先给一个只读面板。
    const own = { ...SESSIONS[1]!, source: "memmy", conversationId: "chat-7" };
    mocks.listSessions.mockResolvedValue({ project: CLOUD_PROJECT, sessions: [own], total: 1 });
    mocks.tasks = [{ sessionKey: "websocket:chat-7", projectId: "local-1", title: own.title }];
    await renderBoard();

    const title = Array.from(document.querySelectorAll<HTMLElement>("span"))
      .find((element) => element.textContent?.trim() === own.title);
    expect(title, "列表应显示这条任务").toBeTruthy();
    await act(async () => title!.click());
    await flush();

    expect(mocks.readSessionDetail).not.toHaveBeenCalled();
    expect(document.querySelector("[data-collab-reader]")).toBeNull();
    // 没有可用的 Agent 客户端时只切页面，但切换确实发生了。
    expect(mocks.dispatch).toHaveBeenCalled();
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

    // 左边缘往左拖可以拉宽：宽度记在本机，与协助会话各记各的。
    const handle = panel!.querySelector<HTMLElement>("[role='separator']")!;
    expect(handle.getAttribute("aria-label")).toBe("调整任务面板宽度");
    expect(panel!.style.width).toBe("520px");
    await act(async () => {
      handle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 600 }));
    });
    await act(async () => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 500 }));
      window.dispatchEvent(new PointerEvent("pointerup", { clientX: 500 }));
    });
    expect(panel!.style.width).toBe("620px");
    expect(window.localStorage.getItem(READER_PANEL_WIDTH_STORAGE_KEY)).toBe("620");
    // 协助会话的宽度不跟着变。
    expect(window.localStorage.getItem(ASSIST_PANEL_WIDTH_STORAGE_KEY)).not.toBe("620");
    window.localStorage.removeItem(READER_PANEL_WIDTH_STORAGE_KEY);

    // Esc 关闭，面板回到看板
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    await flush();
    expect(document.querySelector("[data-collab-reader]")).toBeNull();
  });
});
