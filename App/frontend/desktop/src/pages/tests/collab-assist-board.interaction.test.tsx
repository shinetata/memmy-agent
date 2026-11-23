// @vitest-environment happy-dom

/**
 * 项目协作里的协助怎么摆：看板只列任务，协助的发起在成员段头上（悬停出现的「请求协助」），
 * 等你处理的请求提示在任务列表上方，历史记录在项目设置里。
 *
 * 三处的共同前提是「协助只有发起人和执行人看得到」，所以都不该混进成员分区。
 */
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistRequest, AssistThread } from "../../api/collab-client.js";
import { consumeAssistFocus, getAssistFocus, requestAssistFocus } from "../../app/collab-assist-focus.js";
import { resetCollabProjectsStore } from "../../app/collab-projects-store.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { CollabPage } from "../collab-page.js";

const mocks = vi.hoisted(() => ({
  listProjects: vi.fn(),
  listAddedAgents: vi.fn().mockResolvedValue([]),
  listSessions: vi.fn(),
  listMembers: vi.fn(),
  knowledge: vi.fn(),
  getSyncProgress: vi.fn(),
  syncSessions: vi.fn(),
  getLinks: vi.fn(),
  listProjectTasks: vi.fn(),
  readSessionDetail: vi.fn(),
  assistThreads: vi.fn(),
  assistThread: vi.fn(),
  hideAssistThread: vi.fn(),
  stopAssist: vi.fn(),
  assistAgents: vi.fn().mockResolvedValue({ agents: [], defaultAgent: null }),
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
  useOptionalAppState: () => ({
    state: {
      agent: {
        projects: [{ id: "local-1", name: "Memmy 内测反馈", rootPath: "/tmp/feedback", pinned: false, createdAt: "2026-10-21T03:00:00.000Z" }],
        tasks: [],
        // 成员段头上的「请求协助」会开一条新任务：建草稿的判定要读这几项。
        blankDraftActive: false,
        newChatRequestId: 1,
        composerDraftsByScope: {},
        composerPendingAttachmentsByScope: {}
      }
    },
    dispatch: mocks.dispatch
  })
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const project = {
  id: "p-1",
  name: "Memmy 内测反馈",
  role: "member",
  memberCount: 2,
  sessionCount: 1,
  createdAt: "2026-10-21T03:00:00.000Z",
  localProjectId: "local-1"
};

const REQUESTER = { userId: "7", name: "孙起", mine: false };
const ME = { userId: "8", name: "王雨", mine: true };

const session = {
  id: "s-1",
  projectId: project.id,
  projectName: project.name,
  title: "分享弹窗的排查记录",
  lastQuestion: "分享弹窗点两次会报错",
  memberName: "孙起",
  mine: false,
  source: "memmy",
  turnCount: 2,
  lastActiveAt: "2026-11-05T04:08:00.000Z",
  link: "https://memmy.test/s/s-1",
  shareText: "【Memmy】分享弹窗的排查记录"
};

function request(id: string, status: AssistRequest["status"], overrides: Partial<AssistRequest> = {}): AssistRequest {
  return {
    id, projectId: project.id, projectName: project.name, threadId: `t-${id}`, attempt: 1, via: "DeepSeek Harness",
    title: `协助 ${id}`, reason: "", items: ["看版本"], attachments: null, status, agent: status === "done" ? "memmy" : null, scope: null, grant: null,
    steps: [], reply: "", resultItems: [], files: [], failure: null, requester: REQUESTER, executor: ME, mine: false,
    createdAt: "2026-11-05T04:00:00.000Z", decidedAt: null, finishedAt: status === "done" ? "2026-11-05T04:02:00.000Z" : null,
    sourceTask: null, autoRun: false, decidedMinutes: null, deliveredAt: null,
    ...overrides
  };
}

function thread(latest: AssistRequest, overrides: Partial<AssistThread> = {}): AssistThread {
  return {
    threadId: latest.threadId, projectId: project.id, title: latest.title, via: latest.via, agent: latest.agent,
    scope: latest.scope, grant: latest.grant, status: latest.status, attempt: latest.attempt,
    requester: REQUESTER, executor: ME, mine: false, createdAt: latest.createdAt, lastActiveAt: latest.createdAt,
    requests: [latest], conversationId: null,
    ...overrides
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
  }
}

function clickText(text: string): void {
  const target = [...document.querySelectorAll<HTMLElement>("button")].find((node) => node.textContent?.trim() === text);
  if (!target) throw new Error(`没有找到按钮「${text}」`);
  act(() => target.click());
}

function clickTextIn(scope: string, text: string): void {
  const container = [...document.querySelectorAll(scope)].at(-1);
  const target = container ? [...container.querySelectorAll<HTMLElement>("button")].find((node) => node.textContent?.trim() === text) : null;
  if (!target) throw new Error(`没有在 ${scope} 里找到按钮「${text}」`);
  act(() => target.click());
}

/** 打开项目设置里的「协助记录」。设置与记录是两个弹窗，前一个会先收起。 */
async function openRecords(): Promise<void> {
  act(() => {
    const settings = document.querySelector<HTMLElement>("[data-demo-guide='board-settings']");
    settings?.click();
  });
  await flush();
  const row = document.querySelector<HTMLElement>("[data-collab-assist-records-row]");
  if (!row) throw new Error("项目设置里没有「协助记录」这一行");
  act(() => row.click());
  await flush();
}

function records(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[data-collab-assist-row]")];
}

describe("assists on the project board", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    resetCollabProjectsStore();
    window.localStorage.clear();
    mocks.listProjects.mockResolvedValue([project]);
    mocks.knowledge.mockResolvedValue({ bases: [], maxBases: 10, canManage: false });
    mocks.getSyncProgress.mockResolvedValue({ running: false, total: 0, completed: 0, failed: 0 });
    mocks.syncSessions.mockResolvedValue({ uploaded: 0, removed: 0, failed: 0 });
    mocks.getLinks.mockResolvedValue({ groups: [], sessions: [] });
    mocks.listProjectTasks.mockResolvedValue([]);
    mocks.listMembers.mockResolvedValue({ project, joinMode: "approval", canManage: false, members: [], requests: [] });
    mocks.listSessions.mockResolvedValue({ project, sessions: [session], total: 1 });
    mocks.readSessionDetail.mockResolvedValue({ session, turns: [] });

    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    resetCollabProjectsStore();
    window.localStorage.clear();
  });

  async function renderBoard(threads: AssistThread[], limit: { maxThreads: number | null; prunedAt: string | null } = { maxThreads: 100, prunedAt: null }): Promise<void> {
    mocks.assistThreads.mockResolvedValue({ threads, open: 0, retentionDays: 30, ...limit });
    mocks.assistThread.mockImplementation(async (_projectId: string, threadId: string) => ({
      thread: { ...threads.find((item) => item.threadId === threadId)!, sourceTask: null },
      serverTime: new Date().toISOString()
    }));
    root = createRoot(container);
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <CollabPage />
        </I18nProvider>
      );
    });
    await flush();
  }

  it("keeps assists out of the task list and only raises the one waiting for you", async () => {
    const waiting = thread(request("w1", "pending"), { title: "看一下 ~/.memmy 的大小" });
    const done = thread(request("d1", "done"));
    await renderBoard([waiting, done]);

    // 看板只有任务列表：没有 tab 行，也没有协助行。
    expect(document.querySelector("[role='tablist']")).toBeNull();
    expect(document.body.textContent).toContain("分享弹窗的排查记录");
    expect(records()).toHaveLength(0);
    // 等你授权的那一条提示在列表上方；已完成的不提示。
    const banner = document.querySelector("[data-collab-assist-waiting]");
    expect(banner?.textContent).toContain("孙起请你协助「看一下 ~/.memmy 的大小」，等你处理");

    // 只有一条时「去处理」直接展开这一条，不再换页。
    clickText("去处理");
    await flush();
    expect(document.querySelector("[data-collab-assist-conversation]")?.textContent).toContain("看一下 ~/.memmy 的大小");
  });

  it("opens the assist records when several are waiting, without opening a thread", async () => {
    const first = thread(request("w1", "pending"), { title: "看一下 ~/.memmy 的大小" });
    const second = thread(request("w2", "confirm"), { title: "另一个要确认的请求" });
    await renderBoard([first, second]);

    clickText("去处理");
    await flush();

    expect(document.querySelector("[data-collab-assist-conversation]")).toBeNull();
    const titles = records().map((row) => row.textContent ?? "");
    expect(titles[0]).toContain("看一下 ~/.memmy 的大小");
    expect(titles[1]).toContain("另一个要确认的请求");
  });

  it("does not raise an assist that a timed grant will run on its own", async () => {
    const autoRun = thread(request("a1", "pending", { autoRun: true }));
    await renderBoard([autoRun]);
    expect(document.querySelector("[data-collab-assist-waiting]")).toBeNull();
  });

  it("keeps assists waiting for you first in the records, then running, then finished", async () => {
    const waiting = thread(request("w1", "pending"), { title: "等你授权", lastActiveAt: "2026-10-30T00:00:00.000Z" });
    const running = thread(request("x1", "running", { agent: "memmy" }), { title: "正在执行", lastActiveAt: "2026-11-02T00:00:00.000Z" });
    const finishedOld = thread(request("d1", "done"), { title: "较早结束", lastActiveAt: "2026-11-01T00:00:00.000Z" });
    const finishedNew = thread(request("d2", "done"), { title: "最近结束", lastActiveAt: "2026-11-05T00:00:00.000Z" });
    await renderBoard([finishedOld, waiting, finishedNew, running]);

    await openRecords();

    const titles = records().map((row) => ["等你授权", "正在执行", "最近结束", "较早结束"].find((title) => row.textContent?.includes(title)));
    expect(titles).toEqual(["等你授权", "正在执行", "最近结束", "较早结束"]);
  });

  it("folds requests that never ran and notes when older assists were cleared", async () => {
    const done = thread(request("d1", "done"), { title: "查版本" });
    const rejected = thread(request("r1", "rejected"), { title: "被拒绝的请求" });
    const expired = thread(request("e1", "expired"), { title: "过期的请求" });
    await renderBoard([done, rejected, expired], { maxThreads: 100, prunedAt: "2026-11-05T03:00:00Z" });

    await openRecords();
    expect(records()).toHaveLength(1);
    expect(document.body.textContent).toContain("较早的协助已按项目上限清理（每个项目最多保留 100 次）");

    clickText("另有 2 条没有执行的请求（未允许、已撤回或已过期）");
    expect(records()).toHaveLength(3);
    clickText("收起没有执行的请求");
    expect(records()).toHaveLength(1);
  });

  it("says there is no assist yet, and where to start one", async () => {
    await renderBoard([]);
    await openRecords();

    expect(records()).toHaveLength(0);
    expect(document.body.textContent).toContain("还没有协助");
    expect(document.body.textContent).toContain("在任务面板的成员一行上点「请求协助」");
  });

  it("deletes a finished assist from the row menu, which offers nothing else", async () => {
    const done = thread(request("d1", "done"), { title: "查版本" });
    const running = thread(request("x1", "running", { agent: "memmy" }), { title: "还在跑" });
    await renderBoard([done, running]);
    mocks.hideAssistThread.mockResolvedValue({ threadId: done.threadId, removed: "deleted" });
    await openRecords();

    const rows = records();
    // 还没结束的那一行没有菜单。
    expect(rows.find((row) => row.textContent?.includes("还在跑"))!.querySelector("[aria-label='更多']")).toBeNull();
    const row = rows.find((item) => item.textContent?.includes("查版本"))!;
    act(() => row.querySelector<HTMLElement>("[aria-label='更多']")!.click());
    const items = [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].map((node) => node.textContent);
    expect(items).toEqual(["删除"]);
    clickTextIn("[role='menu']", "删除");
    expect(document.body.textContent).toContain("「查版本」将从你的列表中移除，孙起仍能看到；你们都移除后，记录会被删除。");
    mocks.assistThreads.mockResolvedValue({ threads: [running], open: 1, retentionDays: 30, maxThreads: 100, prunedAt: null });
    clickTextIn("[role='dialog']", "删除");
    await flush();

    expect(mocks.hideAssistThread).toHaveBeenCalledWith("p-1", done.threadId);
    expect(document.body.textContent).toContain("你们都已移除，这次协助的记录已删除");
    expect(records()).toHaveLength(1);
  });

  it("opens a thread from the records and removes it only from my own list", async () => {
    const done = thread(request("d1", "done"), { title: "查版本" });
    await renderBoard([done]);
    mocks.hideAssistThread.mockResolvedValue({ threadId: done.threadId, removed: "hidden" });

    await openRecords();
    act(() => records()[0]!.click());
    await flush();

    // 记录弹窗让位给详情：不叠两层。
    expect(records()).toHaveLength(0);
    const panel = () => document.querySelector<HTMLElement>("[data-collab-assist-conversation]");
    expect(panel()?.textContent).toContain("查版本");
    act(() => [...panel()!.querySelectorAll<HTMLElement>("button")].find((node) => node.textContent === "删除")!.click());
    expect(document.querySelector("[data-assist-remove-confirm]")?.textContent)
      .toContain("移除后你不再看到这次协助，孙起仍能看到；你们都移除后，记录会被删除。");
    mocks.assistThreads.mockResolvedValue({ threads: [], open: 0, retentionDays: 30, maxThreads: 100, prunedAt: null });
    act(() => [...document.querySelector("[data-assist-remove-confirm]")!.querySelectorAll<HTMLElement>("button")]
      .find((node) => node.textContent === "删除")!.click());
    await flush();

    expect(mocks.hideAssistThread).toHaveBeenCalledWith("p-1", done.threadId);
    expect(panel()).toBeNull();
    expect(document.body.textContent).toContain("已从你的列表中移除");
  });

  it("counts the assists I took part in on the settings row", async () => {
    await renderBoard([thread(request("d1", "done")), thread(request("w1", "pending"))]);
    act(() => document.querySelector<HTMLElement>("[data-demo-guide='board-settings']")!.click());
    await flush();

    const row = document.querySelector<HTMLElement>("[data-collab-assist-records-row]")!;
    expect(row.textContent).toContain("2");
  });

  it("opens the thread directly when a notification brings you to it", async () => {
    const done = thread(request("d1", "done"), { title: "查版本" });
    requestAssistFocus({ projectId: project.id, threadId: done.threadId });
    await renderBoard([done]);
    await flush();

    // 不再有 tab 可以切：详情直接叠在任务列表上。
    expect(document.querySelector("[data-collab-assist-conversation]")?.textContent).toContain("查版本");
    expect(document.querySelector("[role='tablist']")).toBeNull();
    expect(getAssistFocus()).toBeNull();
    consumeAssistFocus();
  });

  /** 某位成员的段头：按段键找，`me` 或 `member:<昵称>`。 */
  function memberHead(key: string): HTMLElement {
    const head = document.querySelector<HTMLElement>(`[data-collab-member-toggle='${key}']`);
    if (!head) throw new Error(`没有找到段头「${key}」`);
    return head;
  }

  function askButton(key: string): HTMLElement | null {
    return memberHead(key).querySelector<HTMLElement>("[data-collab-ask-member]");
  }

  it("puts a request-help button on the row of a member who takes requests, and takes you into a session for her", async () => {
    // 云端只在项目列表里给出开了「接收协助请求」的成员；本人即使也开了，也不会在自己的行上出现。
    mocks.listProjects.mockResolvedValue([
      { ...project, assistReceivers: [ME, { userId: "9", name: "孙起", mine: false }] }
    ]);
    // 本人也留一条任务：这样两段都在，才能说明按钮只挂在别人那一行上。
    mocks.listSessions.mockResolvedValue({
      project,
      sessions: [session, { ...session, id: "s-2", title: "我自己的任务", memberName: "王雨", mine: true }],
      total: 2
    });
    await renderBoard([]);

    // 任务列表按成员分区：孙起有一条任务，所以有她这一段；本人这一段没有按钮可请。
    expect(askButton("member:孙起")?.textContent).toBe("请求协助");
    expect(askButton("me")).toBeNull();

    act(() => askButton("member:孙起")!.click());
    await flush();

    // 建草稿、指定项目、带上这次请谁，然后回会话页；不再多一层确认。
    expect(mocks.dispatch).toHaveBeenCalledWith({ type: "agent/newChatRequested" });
    expect(mocks.dispatch).toHaveBeenCalledWith({
      type: "agent/draftTargetUpdated",
      scopeKey: expect.any(String),
      target: { kind: "project", projectId: "local-1" }
    });
    expect(mocks.dispatch).toHaveBeenCalledWith({
      type: "agent/assistTargetUpdated",
      scopeKey: expect.any(String),
      target: { userId: "9", name: "孙起", projectName: project.name }
    });
  });

  it("keeps the request-help button off the rows when nobody is taking assist requests", async () => {
    await renderBoard([]);
    expect(document.querySelector("[data-collab-ask-member]")).toBeNull();
  });

  it("folds and unfolds a member's section from the row itself", async () => {
    await renderBoard([]);
    const head = memberHead("member:孙起");
    expect(head.getAttribute("aria-expanded")).toBe("true");

    act(() => head.click());
    await flush();
    expect(memberHead("member:孙起").getAttribute("aria-expanded")).toBe("false");
    expect(document.body.textContent).not.toContain("分享弹窗的排查记录");
  });
});
