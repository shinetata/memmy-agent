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

describe("the empty tasks state", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetCollabProjectsStore();
    mocks.listProjects.mockReset();
    mocks.knowledge.mockResolvedValue({ bases: [], maxBases: 10 });
    // 共享项目会去读它的任务列表：空列表表示这个项目还没有任务。
    mocks.listSessions.mockResolvedValue({ project: sharedProject, sessions: [], total: 0 });
    mocks.getSyncProgress.mockResolvedValue({ running: false, total: 0, completed: 0, failed: 0 });
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
  });

  it("offers both a new task and linking sessions on a shared project", async () => {
    localProjects = [localProject];
    mocks.listProjects.mockResolvedValue({ projects: [sharedProject] });
    await render("zh-CN");

    const text = container.textContent ?? "";
    expect(text).toContain("项目中还没有任务，可以");
    expect(text).toContain("新建任务");
    expect(text).toContain("或");
    expect(text).toContain("关联任务");
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
