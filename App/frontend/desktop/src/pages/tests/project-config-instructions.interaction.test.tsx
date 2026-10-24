// @vitest-environment happy-dom

/**
 * 看板右侧的项目配置：指令卡片显示当前指令，所有者与管理员可以编辑，成员只读。
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

  it("shows the instruction card of a project that is only on this computer", async () => {
    await renderBoard();
    expect(document.body.textContent).toContain("项目配置");
    expect(document.body.textContent).toContain("指令");
    // 未设定时给出说明，而不是空白卡片。
    expect(document.body.textContent).toContain("设定项目的背景与规范");
    expect(instructionMocks.readProjectInstructions).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "http://127.0.0.1:1" }),
      PROJECT.rootPath
    );
  });

  it("saves a local project's instructions and shows them on the card", async () => {
    await renderBoard();
    await act(async () => iconButton("编辑项目指令").click());

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
    await act(async () => iconButton("编辑项目指令").click());
    const editor = document.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(editor, "对外文案使用书面语。");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => byText("保存").click());
    await flush();

    // 协作项目的指令以云端为准：带上本机目录，让后端把云端内容同步到一起。
    expect(mocks.setInstructions).toHaveBeenCalledWith(CLOUD_PROJECT.id, "对外文案使用书面语。", PROJECT.rootPath);
    expect(instructionMocks.saveProjectInstructions).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("对外文案使用书面语。");
  });

  it("shows a member the instructions read only", async () => {
    await renderBoard({ ...CLOUD_PROJECT, role: "member", instructions: "前端代码遵循《前端代码规范》。" });
    // 成员看不到编辑按钮。
    expect(document.querySelector('button[aria-label="编辑项目指令"]')).toBeNull();

    // 点指令卡片本身打开只读弹窗（aside 的第一个按钮是收起）。
    const card = Array.from(document.querySelectorAll<HTMLElement>("aside button"))
      .find((element) => element.textContent?.includes("前端代码遵循"));
    expect(card).toBeTruthy();
    await act(async () => card!.click());
    await flush();
    expect(document.body.textContent).toContain("仅所有者与管理员可编辑");
    expect(document.body.textContent).toContain("前端代码遵循《前端代码规范》。");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("collapses the configuration panel from the board header", async () => {
    await renderBoard();
    expect(document.body.textContent).toContain("设定项目的背景与规范");
    await act(async () => iconButton("收起项目配置").click());
    expect(document.body.textContent).not.toContain("设定项目的背景与规范");
    // 收起后页头给出展开入口。
    expect(iconButton("展开项目配置")).toBeTruthy();
  });
});
