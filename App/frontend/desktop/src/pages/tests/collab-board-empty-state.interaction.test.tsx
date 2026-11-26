// @vitest-environment happy-dom

/**
 * 看板「任务」的空状态：一句话里嵌着可点的操作，不摆图标、不加按钮。
 * 本机项目没有可关联的对象，只讲新建任务；共享给成员（协作项目）两种操作都讲。
 * 断言落在「哪几个词出现在这句话里」，与样式无关。
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
  listMembers: vi.fn(),
  readSessionDetail: vi.fn(),
  readReference: vi.fn(),
  removeSession: vi.fn(),
  syncSessions: vi.fn(),
  getSyncProgress: vi.fn(),
  dispatch: vi.fn()
}));

vi.mock("../../api/collab-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/collab-client.js")>();
  return { ...actual, createHttpCollabClient: () => mocks };
});

vi.mock("../../app/providers.js", () => ({
  useApiClients: () => ({ clients: { runtimeConfig: {} }, setClients: vi.fn() })
}));

/** 本机项目列表由用例决定：一个本机项目，或一个已经共享出去的项目。 */
let localProjects: unknown[] = [];

vi.mock("../../state/app-state.js", () => ({
  useOptionalAppState: () => ({
    state: {
      agent: {
        projects: localProjects,
        tasks: [],
        blankDraftActive: false,
        newChatRequestId: 1,
        composerDraftsByScope: {},
        composerPendingAttachmentsByScope: {},
        composerMentionsByScope: {}
      }
    },
    dispatch: mocks.dispatch
  })
}));

vi.mock("../app-frame.js", () => ({
  AppFrame: (props: { children: ReactNode }) => <div>{props.children}</div>
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const localProject = {
  id: "local-1",
  name: "Memmy 内测反馈",
  rootPath: "/tmp/memmy",
  pinned: false,
  createdAt: "2026-11-19T03:00:00.000Z"
};

const sharedProject = {
  id: "p-1",
  name: "Memmy 内测反馈",
  role: "owner",
  memberCount: 2,
  sessionCount: 0,
  createdAt: "2026-11-19T03:00:00.000Z",
  localProjectId: localProject.id
};

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
  }
}

describe("the project board with no tasks", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetCollabProjectsStore();
    mocks.listProjects.mockReset();
    mocks.knowledge.mockResolvedValue({ bases: [], maxBases: 10 });
    // 共享项目会去读它的任务列表：空列表表示这个项目还没有任务。
    mocks.listSessions.mockResolvedValue({ project: sharedProject, sessions: [], total: 0 });
    mocks.getSyncProgress.mockResolvedValue({ running: false, total: 0, completed: 0, failed: 0 });
    // 成员名单：本人加一位还没共享任务的成员。0 任务时看板靠它铺出成员分段。
    mocks.listMembers.mockResolvedValue({
      canManage: true,
      requests: [],
      members: [
        { userId: "u-me", name: "孙起", mine: true },
        { userId: "u-2", name: "小饭团", mine: false }
      ]
    });
    mocks.syncSessions.mockResolvedValue({ uploaded: 0, removed: 0, failed: 0 });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetCollabProjectsStore();
  });

  async function render(language: "zh-CN" | "en-US"): Promise<void> {
    await act(async () => {
      root.render(
        <I18nProvider language={language}>
          <CollabPage />
        </I18nProvider>
      );
    });
    await flush();
  }

  it("only offers a new task on a local project", async () => {
    localProjects = [localProject];
    mocks.listProjects.mockResolvedValue({ projects: [] });
    await render("zh-CN");

    const text = container.textContent ?? "";
    expect(text).toContain("项目中还没有任务，可以");
    expect(text).toContain("新建任务");
    // 本机项目没有可关联的东西：不讲「关联任务」。
    expect(text).not.toContain("关联任务");
    expect(container.querySelector('button[aria-label="协作项目使用指南"]')).toBeNull();
  });

  it("lays out the members instead of the sentence on a shared project without tasks", async () => {
    localProjects = [localProject];
    mocks.listProjects.mockResolvedValue({ projects: [sharedProject] });
    await render("zh-CN");

    const text = container.textContent ?? "";
    // 还有别人时这一屏回答的是「这里都有谁、能找谁」：只留成员分段，不再重讲工具条上的两个动作。
    expect(text).not.toContain("项目中还没有任务，可以");
    const groups = [...container.querySelectorAll("[data-collab-member-group]")];
    expect(groups.map((group) => group.getAttribute("data-collab-member-group"))).toEqual(["me", "member:小饭团"]);
    expect(groups[0]?.querySelector("[data-collab-member-name]")?.textContent).toBe("孙起");
    for (const group of groups) {
      expect(group.querySelector("[data-collab-member-count]")?.textContent).toBe("暂无任务");
    }
  });

  it("keeps the sentence when nobody else has joined yet", async () => {
    localProjects = [localProject];
    mocks.listProjects.mockResolvedValue({ projects: [{ ...sharedProject, memberCount: 1 }] });
    mocks.listSessions.mockResolvedValue({ project: { ...sharedProject, memberCount: 1 }, sessions: [], total: 0 });
    mocks.listMembers.mockResolvedValue({
      canManage: true,
      requests: [],
      members: [{ userId: "u-me", name: "孙起", mine: true }]
    });
    await render("zh-CN");

    const text = container.textContent ?? "";
    expect(text).toContain("项目中还没有任务，可以");
    expect(container.querySelector("[data-collab-member-group]")).toBeNull();
  });

  it("opens the shared project guide only on click and restores focus when closed", async () => {
    localProjects = [localProject];
    mocks.listProjects.mockResolvedValue({ projects: [sharedProject] });
    await render("zh-CN");

    const badge = container.querySelector('[data-demo-guide="board-members"]');
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="协作项目使用指南"]')!;
    expect(badge?.textContent).toBe("2 位成员");
    expect(badge?.nextElementSibling).toBe(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    act(() => trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    const tooltip = document.querySelector('#app-tooltip-singleton[aria-hidden="false"]');
    expect(tooltip?.textContent).toBe("查看使用指南");
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    act(() => trigger.click());
    const guide = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(tooltip?.getAttribute("aria-hidden")).toBe("true");
    const selected = guide.querySelector('button[aria-pressed="true"]');
    expect(document.activeElement).toBe(selected);
    expect(selected?.textContent).toBe("查找与接续");
    const contexts = [...guide.querySelectorAll("section:has(h3)")];
    expect(guide.textContent).not.toContain("在 Memmy 中");
    expect(contexts[0]?.querySelector("h3")?.textContent).toBe("复制任务链接");
    expect(contexts[0]?.textContent).toContain("用 @ 引用任务");
    expect(contexts[1]?.querySelector("h3")?.textContent).toBe("在已接入的 Agent 中");
    expect(contexts[1]?.textContent).toContain("按内容搜索会话");
    expect(contexts[1]?.textContent).toContain(`搜一下 Memmy 的『${sharedProject.name}』项目中关于【关键词】的内容`);
    expect(contexts[1]?.textContent).toContain("通过链接读取任务");
    expect(contexts[1]?.textContent).toContain("把链接粘贴到对话里");

    act(() => guide.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
    expect(tooltip?.getAttribute("aria-hidden")).toBe("true");
  });

  it("switches between guide topics in English and separates setup from agent usage", async () => {
    localProjects = [localProject];
    mocks.listProjects.mockResolvedValue({ projects: [sharedProject] });
    await render("en-US");

    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Shared project guide"]')!;
    act(() => trigger.click());
    const guide = document.querySelector('[role="dialog"]')!;
    expect(guide.querySelector("h2")?.textContent).toBe("Shared project guide");
    expect(guide.textContent).toContain("Copy a task link");
    expect(guide.textContent).toContain("Search conversations by content");
    expect(guide.textContent).toContain(`Search the Memmy project ‘${sharedProject.name}’ for content about [topic]`);

    function selectTopic(name: string) {
      const tab = [...guide.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")]
        .find((button) => button.textContent === name)!;
      act(() => tab.click());
      expect(tab.getAttribute("aria-pressed")).toBe("true");
      expect(guide.querySelectorAll('button[aria-pressed="true"]')).toHaveLength(1);
    }

    selectTopic("Share & invite");
    expect(guide.textContent).toContain("Invite members");
    expect(guide.textContent).not.toContain("Copy a task link");
    expect(guide.textContent).not.toContain("In a connected agent");

    selectTopic("Access & setup");
    const contexts = [...guide.querySelectorAll("section:has(h3)")];
    expect(contexts[0]?.textContent).toContain("Give other agents access");
    expect(contexts[1]?.textContent).toContain("In a connected agent");
    expect(contexts[1]?.textContent).toContain(`Add this task to ‘${sharedProject.name}’`);

    selectTopic("Teammate help");
    expect(guide.textContent).toContain("Review assist history");

    act(() => guide.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("starts the new task when the words are clicked", async () => {
    localProjects = [localProject];
    mocks.listProjects.mockResolvedValue({ projects: [] });
    await render("zh-CN");

    const start = [...container.querySelectorAll<HTMLElement>("button")]
      .find((node) => node.textContent?.trim() === "新建任务");
    expect(start).toBeDefined();
    await act(async () => start!.click());
    // 走的是与侧栏「＋」同一条路径：先建草稿，再切到对话页。
    expect(mocks.dispatch).toHaveBeenCalledWith(expect.objectContaining({ path: "/main" }));
  });

  it("says the same thing in English", async () => {
    localProjects = [localProject];
    mocks.listProjects.mockResolvedValue({ projects: [] });
    await render("en-US");

    const text = container.textContent ?? "";
    expect(text).toContain("No tasks yet — you can");
    expect(text).toContain("start a task");
    expect(text).not.toContain("link sessions");
  });
});
