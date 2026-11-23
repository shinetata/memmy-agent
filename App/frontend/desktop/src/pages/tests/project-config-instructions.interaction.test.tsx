// @vitest-environment happy-dom

/**
 * 看板右侧的项目配置：背景与规范卡片显示当前内容，所有者与管理员可以编辑，成员只读。
 * 仅在本机的项目写本机，协作项目写云端并同步回本机。
 */
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCollabProjects, resetCollabProjectsStore } from "../../app/collab-projects-store.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { CollabPage } from "../collab-page.js";

const mocks = vi.hoisted(() => ({
  listProjects: vi.fn(),
  // 已关联的其他 Agent：这些用例不涉及，空列表即可。
  listAddedAgents: vi.fn().mockResolvedValue([]),
  // 项目配置会读关联的知识库；这一层不关心内容，给空列表即可。
  knowledge: vi.fn(),
  addKnowledge: vi.fn(),
  removeKnowledge: vi.fn(),
  listSessions: vi.fn(),
  getSyncProgress: vi.fn(),
  syncSessions: vi.fn(),
  listLocalSessions: vi.fn(),
  getLinks: vi.fn(),
  listProjectTasks: vi.fn(),
  setInstructions: vi.fn()
}));

const instructionMocks = vi.hoisted(() => ({
  readProjectInstructions: vi.fn(),
  saveProjectInstructions: vi.fn()
}));

vi.mock("../../api/collab-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/collab-client.js")>();
  return { ...actual, createHttpCollabClient: () => mocks };
});

const kbMocks = vi.hoisted(() => ({ listKnowledgeBases: vi.fn() }));

vi.mock("../../api/knowledge-bases-client.js", () => ({ listKnowledgeBases: kbMocks.listKnowledgeBases }));

vi.mock("../../api/projects-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/projects-client.js")>();
  return { ...actual, ...instructionMocks };
});

vi.mock("../../app/providers.js", () => ({
  useApiClients: () => ({
    clients: { runtimeConfig: { baseUrl: "http://127.0.0.1:1", localToken: "token" }, memmyAgent: null },
    setClients: vi.fn()
  })
}));

vi.mock("../app-frame.js", () => ({
  AppFrame: (props: { children: ReactNode }) => <div>{props.children}</div>
}));

const PROJECT = {
  id: "local-1",
  name: "MemOS产品",
  rootPath: "/Users/me/MemOS-WorkSpace",
  pinned: false,
  createdAt: "2026-10-21T03:00:00.000Z"
};

const CLOUD_PROJECT = {
  id: "cloud-1",
  name: PROJECT.name,
  role: "owner",
  memberCount: 2,
  sessionCount: 0,
  createdAt: "2026-10-23T03:00:00.000Z",
  localProjectId: PROJECT.id,
  instructions: ""
};

vi.mock("../../state/app-state.js", () => ({
  useOptionalAppState: () => ({
    state: { agent: { projects: [PROJECT], tasks: [] } },
    dispatch: vi.fn()
  })
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
  }
}

const EMPTY = { text: "", origin: null, cloudProjectId: null, updatedAt: null };

describe("project board configuration", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    resetCollabProjectsStore();
    mocks.listProjects.mockResolvedValue([]);
    mocks.knowledge.mockResolvedValue({ bases: [], maxBases: 10, canManage: false });
    kbMocks.listKnowledgeBases.mockResolvedValue([]);
    mocks.listSessions.mockResolvedValue({ project: CLOUD_PROJECT, sessions: [], total: 0 });
    mocks.getSyncProgress.mockResolvedValue({ running: false, total: 0, completed: 0, failed: 0 });
    mocks.syncSessions.mockResolvedValue({ uploaded: 0, removed: 0, failed: 0 });
    mocks.listLocalSessions.mockResolvedValue({ sessions: [], refreshing: false });
    mocks.getLinks.mockResolvedValue({ groups: [], sessions: [] });
    mocks.listProjectTasks.mockResolvedValue([]);
    instructionMocks.readProjectInstructions.mockResolvedValue(EMPTY);
    instructionMocks.saveProjectInstructions.mockResolvedValue({
      text: "本项目负责 Memmy 桌面端的研发。",
      origin: "local",
      cloudProjectId: null,
      updatedAt: "2026-10-24T12:00:00.000Z"
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

  async function renderBoard(shared: typeof CLOUD_PROJECT | null = null) {
    if (shared) mocks.listProjects.mockResolvedValue([shared]);
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <CollabPage />
        </I18nProvider>
      );
    });
    await flush();
    if (shared) {
      await act(async () => {
        await loadCollabProjects(mocks as never);
      });
      await flush();
    }
  }

  function byText(label: string): HTMLElement {
    const found = Array.from(document.querySelectorAll<HTMLElement>("button"))
      .find((element) => element.textContent?.trim() === label);
    expect(found, `按钮「${label}」应已渲染`).toBeTruthy();
    return found!;
  }

  function iconButton(label: string): HTMLElement {
    const found = document.querySelector<HTMLElement>(`button[aria-label="${label}"]`);
    expect(found, `按钮「${label}」应已渲染`).toBeTruthy();
    return found!;
  }

  /** 知识库列表里的一行：勾选状态就是关联状态。 */
  function knowledgeCheckbox(name: string): HTMLInputElement {
    const found = document.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`);
    expect(found, `知识库「${name}」应已渲染`).toBeTruthy();
    return found!;
  }

  it("shows the instruction card of a project that is only on this computer", async () => {
    await renderBoard();
    expect(document.body.textContent).toContain("项目配置");
    expect(document.body.textContent).toContain("背景与规范");
    // 未设定时给出说明，而不是空白卡片。
    expect(document.body.textContent).toContain("设定项目的背景与规范");
    expect(instructionMocks.readProjectInstructions).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "http://127.0.0.1:1" }),
      PROJECT.rootPath
    );
  });

  it("saves a local project's instructions and shows them on the card", async () => {
    await renderBoard();
    await act(async () => iconButton("编辑背景与规范").click());

    const editor = document.querySelector<HTMLTextAreaElement>("textarea");
    expect(editor).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(editor!, "本项目负责 Memmy 桌面端的研发。");
      editor!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => byText("保存").click());
    await flush();

    expect(instructionMocks.saveProjectInstructions).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "http://127.0.0.1:1" }),
      PROJECT.rootPath,
      "本项目负责 Memmy 桌面端的研发。"
    );
    // 保存成功关掉弹窗，卡片上能看到刚写下的指令。
    expect(document.querySelector("textarea")).toBeNull();
    expect(document.body.textContent).toContain("本项目负责 Memmy 桌面端的研发。");
    expect(document.body.textContent).toContain("已保存");
  });

  it("lets an owner edit a shared project's instructions in the cloud", async () => {
    mocks.setInstructions.mockResolvedValue({
      ...CLOUD_PROJECT,
      instructions: "对外文案使用书面语。"
    });
    await renderBoard(CLOUD_PROJECT);
    await act(async () => iconButton("编辑背景与规范").click());
    const editor = document.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(editor, "对外文案使用书面语。");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => byText("保存").click());
    await flush();

    // 协作项目的指令以云端为准，看板不再去读本机项目指令（那是另一套存储）。
    expect(mocks.setInstructions).toHaveBeenCalledWith(CLOUD_PROJECT.id, "对外文案使用书面语。");
    // 保存不落本机项目指令文件。
    expect(instructionMocks.saveProjectInstructions).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("对外文案使用书面语。");
  });

  it("shows a member the instructions read only", async () => {
    await renderBoard({ ...CLOUD_PROJECT, role: "member", instructions: "前端代码遵循《前端代码规范》。" });
    // 成员看不到编辑按钮。
    expect(document.querySelector('button[aria-label="编辑背景与规范"]')).toBeNull();

    // 点指令卡片本身打开只读弹窗（aside 的第一个按钮是收起）。
    const card = Array.from(document.querySelectorAll<HTMLElement>("aside button"))
      .find((element) => element.textContent?.includes("前端代码遵循"));
    expect(card).toBeTruthy();
    await act(async () => card!.click());
    await flush();
    expect(document.body.textContent).toContain("仅创建者可编辑");
    expect(document.body.textContent).toContain("前端代码遵循《前端代码规范》。");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("links and unlinks knowledge in one dialog and shows the result on the card", async () => {
    const linkedBase = { id: "19", name: "资料 20", mine: true };
    const addedBase = { id: "two", name: "团队资料", mine: true };
    mocks.knowledge.mockResolvedValue({ bases: [linkedBase], maxBases: 20, canManage: false });
    kbMocks.listKnowledgeBases.mockResolvedValue([{ id: "two", name: "团队资料", shared: false }, { id: "19", name: "资料 20", shared: false }]);
    mocks.addKnowledge.mockResolvedValue({ bases: [linkedBase, addedBase], maxBases: 20, canManage: false });
    mocks.removeKnowledge.mockResolvedValue({ bases: [addedBase], maxBases: 20, canManage: false });
    await renderBoard(CLOUD_PROJECT);
    const sidebar = document.querySelector("aside")!;
    expect(sidebar.textContent).toContain("知识库1");
    expect(sidebar.textContent).toContain("资料 20");

    await act(async () => iconButton("添加知识库").click());
    await flush();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("已关联 1 个知识库");
    expect(document.body.textContent).toContain("还可关联 19 个");
    expect(knowledgeCheckbox("资料 20").checked).toBe(true);

    await act(async () => knowledgeCheckbox("团队资料").closest("label")!.click());
    await flush();
    expect(mocks.addKnowledge).toHaveBeenCalledWith("cloud-1", "two");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("已关联 2 个知识库");

    await act(async () => knowledgeCheckbox("资料 20").closest("label")!.click());
    await flush();
    expect(mocks.removeKnowledge).toHaveBeenCalledWith("cloud-1", "19");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("已关联 1 个知识库");

    // 关掉就结束：不会再冒出另一个知识库弹窗。
    await act(async () => byText("完成").click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(sidebar.textContent).toContain("知识库1");
    expect(sidebar.textContent).toContain("团队资料");
  });

  it("keeps the checkbox as it was and explains a failed unlink", async () => {
    mocks.knowledge.mockResolvedValue({ bases: [{ id: "one", name: "团队资料", mine: true }], maxBases: 10, canManage: false });
    mocks.removeKnowledge.mockRejectedValue(new Error("网络不可用"));
    await renderBoard(CLOUD_PROJECT);
    await act(async () => iconButton("添加知识库").click());
    await flush();
    await act(async () => knowledgeCheckbox("团队资料").closest("label")!.click());
    await flush();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("网络不可用");
    expect(knowledgeCheckbox("团队资料").checked).toBe(true);
    expect(document.body.textContent).toContain("团队资料");
  });

  it("keeps one entry: the plus and the card body open the same dialog", async () => {
    mocks.knowledge.mockResolvedValue({ bases: [{ id: "one", name: "团队资料", mine: true }], maxBases: 10, canManage: false });
    await renderBoard(CLOUD_PROJECT);
    // 卡片上只有加号，不再有与它作用相同的「管理」。
    expect(document.querySelector("aside")!.textContent).not.toContain("管理");

    await act(async () => iconButton("添加知识库").click());
    await flush();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("关联知识库");
    await act(async () => byText("完成").click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => byText("团队资料").click());
    await flush();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("已关联 1 个知识库");
  });

  it("offers direct addition when no knowledge is linked", async () => {
    await renderBoard(CLOUD_PROJECT);
    expect(document.querySelector("aside")?.textContent).toContain("尚未关联知识库");
    // 入口是卡片右上角的加号：卡片里不再有「添加知识库」这行文字。
    await act(async () => iconButton("添加知识库").click());
    await flush();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("关联知识库");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("已关联 0 个知识库");
    await act(async () => byText("完成").click());
    // 卡片的正文本身也可点：整块都是加号的等价入口。
    await act(async () => byText("尚未关联知识库").click());
    await flush();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("关联知识库");
  });

  it("keeps one control for the panel: collapse inside it, expand in the header", async () => {
    await renderBoard();
    expect(document.body.textContent).toContain("设定项目的背景与规范");
    // 展开时只有面板标题栏里的收起入口，页头不再放一个作用相同的按钮。
    expect(document.querySelector('button[aria-label="展开项目配置"]')).toBeNull();

    await act(async () => iconButton("收起项目配置").click());
    expect(document.body.textContent).not.toContain("设定项目的背景与规范");
    // 收起后展开入口出现在页头，且面板里的收起入口随之消失。
    expect(document.querySelector('button[aria-label="收起项目配置"]')).toBeNull();
    await act(async () => iconButton("展开项目配置").click());
    expect(document.body.textContent).toContain("设定项目的背景与规范");
    expect(document.querySelector('button[aria-label="展开项目配置"]')).toBeNull();
  });

  it("collapses project configuration on a narrow board until the user chooses", async () => {
    const observers: ResizeObserverCallback[] = [];
    const original = globalThis.ResizeObserver;
    class FakeResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        observers.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
    try {
      await renderBoard();
      expect(document.body.textContent).toContain("设定项目的背景与规范");
      const notify = (width: number) => {
        const callback = observers.at(-1);
        expect(callback, "应已观察看板宽度").toBeTruthy();
        callback!([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver);
      };

      await act(async () => notify(700));
      expect(document.body.textContent).not.toContain("设定项目的背景与规范");
      expect(document.querySelector('button[aria-label="展开项目配置"]')).toBeTruthy();

      await act(async () => notify(1200));
      expect(document.body.textContent).toContain("设定项目的背景与规范");

      await act(async () => iconButton("收起项目配置").click());
      await act(async () => notify(1200));
      expect(document.querySelector('button[aria-label="展开项目配置"]')).toBeTruthy();
      expect(document.body.textContent).not.toContain("设定项目的背景与规范");
    } finally {
      globalThis.ResizeObserver = original;
    }
  });
});
