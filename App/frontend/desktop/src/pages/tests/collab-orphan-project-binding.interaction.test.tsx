// @vitest-environment happy-dom

/**
 * 云端项目绑着的本机项目被移除之后，那个协作项目要能自己回来。
 *
 * 移除本机项目只删本机注册表与本机任务，不会回头改云端那份记录，云端记着的是一个已经不存在的本机项目。
 * 自愈原先只认「云端说没绑过」，于是这种项目两头都不认：侧栏没有行可挂，它再也不会出现。
 */
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppClients } from "../../api/client-types.js";
import { getCollabProjectsSnapshot, loadCollabProjects, resetCollabProjectsStore } from "../../app/collab-projects-store.js";
import { ApiClientsContext } from "../../app/providers.js";
import { NotificationCenterProvider } from "../../components/notification-center.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { TaskBusProvider } from "../../lib/task-bus.js";
import { agentActions, appActions } from "../../state/app-actions.js";
import { AppStateProvider, useAppState } from "../../state/app-state.js";
import { AppFrame } from "../app-frame.js";
import { mockBootstrap } from "./fixtures/bootstrap.js";

const mocks = vi.hoisted(() => ({
  listProjects: vi.fn(),
  ensureWorkingDirectory: vi.fn(),
  bindLocalProject: vi.fn(),
  createProject: vi.fn(),
  deleteProject: vi.fn(),
  mutateProject: vi.fn(),
  refreshTaskState: vi.fn()
}));

vi.mock("../../api/collab-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/collab-client.js")>();
  return { ...actual, createHttpCollabClient: () => mocks };
});

// 自愈要建一个本机项目、再把云端记录接过去：这两步都走运行时协调器与云端客户端。
vi.mock("../../app/agent-runtime-bridge.js", () => ({
  useOptionalAgentRuntimeBridge: () => ({
    taskStateCoordinator: {
      mutateProject: mocks.mutateProject,
      refreshTaskState: mocks.refreshTaskState
    }
  })
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const clients = {
  runtimeConfig: { baseUrl: "http://127.0.0.1:1", localToken: "token" },
  // 删除项目要经本机接口；这里只用到会话 key 的换算。
  memmyAgent: { sessionKeyToChatId: (key: string) => key }
} as unknown as AppClients;

/** 这台电脑上还在的本机项目。 */
const ALIVE_PROJECT = {
  id: "local-alive",
  name: "Memmy项目协作开发",
  rootPath: "/Users/me/MemOS-WorkSpace",
  pinned: false,
  createdAt: "2026-11-19T00:00:00.000Z"
};

/** 云端还记着一个已经被移除的本机项目。 */
const ORPHAN_PROJECT = {
  id: "cloud-orphan",
  name: "项目协作体验",
  role: "member" as const,
  memberCount: 2,
  sessionCount: 2,
  createdAt: "2026-11-19T05:00:00.000Z",
  localProjectId: "local-removed"
};

/** 云端这一侧的记录：绑定接口会改写它，重新读回来的就是改写后的样子。 */
let cloudProjects: (typeof ORPHAN_PROJECT)[] = [];

function Shell() {
  const { state, dispatch } = useAppState();
  const sidebarState = state.agent.sidebarState;
  useEffect(() => {
    dispatch(appActions.accountUpdated({ userId: "account-1" }));
    dispatch(appActions.bootstrapLoaded({ ...mockBootstrap, app: { ...mockBootstrap.app, userMode: "account" } }, "/main"));
    // 本机清单读到了：从这一刻起，云端绑着哪个本机项目能被核对。
    dispatch(agentActions.sessionSnapshotApplied({
      sessions: [],
      projects: [ALIVE_PROJECT],
      projectRegistryState: "ready",
      sidebarState
    }));
  }, [dispatch, sidebarState]);
  return (
    <AppFrame title="项目">
      <div>工作区</div>
    </AppFrame>
  );
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
  }
}

describe("a cloud project whose local project was removed", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    resetCollabProjectsStore();
    cloudProjects = [ORPHAN_PROJECT];
    mocks.listProjects.mockImplementation(async () => cloudProjects);
    mocks.ensureWorkingDirectory.mockResolvedValue({ localDirectory: "/Users/me/orphan", chosen: false });
    mocks.bindLocalProject.mockImplementation(async (projectId: string, localProjectId: string) => {
      cloudProjects = cloudProjects.map((project) => (
        project.id === projectId ? { ...project, localProjectId } : project
      ));
      return { ok: true };
    });
    mocks.mutateProject.mockResolvedValue({
      status: "committed",
      project: { id: "local-new", name: ORPHAN_PROJECT.name, rootPath: "/Users/me/orphan", pinned: false, createdAt: null },
      deletedSessionKeys: []
    });
    Object.defineProperty(window, "memmy", {
      configurable: true,
      value: { platform: "darwin", getLogLevel: () => Promise.resolve("info") }
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

  it("gets a local project back and stays bound to it", async () => {
    await act(async () => {
      root.render(
        <AppStateProvider>
          <ApiClientsContext.Provider value={{ clients, setClients: () => undefined }}>
            <TaskBusProvider>
              <I18nProvider language="zh-CN">
                <NotificationCenterProvider>
                  <Shell />
                </NotificationCenterProvider>
              </I18nProvider>
            </TaskBusProvider>
          </ApiClientsContext.Provider>
        </AppStateProvider>
      );
    });
    await flush();
    await act(async () => {
      await loadCollabProjects(mocks as never);
    });
    await flush();

    // 绑到空处的那个项目和「从来没绑过」一样，要补一个本机项目。
    expect(mocks.mutateProject).toHaveBeenCalledWith({
      kind: "create",
      input: {
        mode: "existing",
        path: "/Users/me/orphan",
        name: ORPHAN_PROJECT.name,
        allowShared: true
      }
    });
    // 补好就把云端记录接到新项目上，旧的那条绑定被覆盖，不会留下第二个孤儿。
    expect(mocks.bindLocalProject).toHaveBeenCalledWith(ORPHAN_PROJECT.id, "local-new");
    expect(getCollabProjectsSnapshot().projects?.[0]?.localProjectId).toBe("local-new");
  });

  it("tells the person why removing a project failed instead of doing nothing", async () => {
    // 看板上没有显示操作错误的地方：删除失败时若不另发通知，人看到的只是「点了没反应」。
    mocks.mutateProject.mockResolvedValue({ status: "rejected", code: "project_shared_elsewhere" });

    await act(async () => {
      root.render(
        <AppStateProvider>
          <ApiClientsContext.Provider value={{ clients, setClients: () => undefined }}>
            <TaskBusProvider>
              <I18nProvider language="zh-CN">
                <NotificationCenterProvider>
                  <Shell />
                </NotificationCenterProvider>
              </I18nProvider>
            </TaskBusProvider>
          </ApiClientsContext.Provider>
        </AppStateProvider>
      );
    });
    await flush();

    // 侧栏项目行右键打开菜单，再确认移除。
    // 右键处理器挂在行内的 __main 上，事件不会往下传给子元素。
    const row = document.querySelector<HTMLElement>(".app-frame-project-row__main");
    expect(row, "侧栏应已渲染项目行").toBeTruthy();
    await act(async () => {
      row!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 40, clientY: 300 }));
    });
    await flush();
    const removeItem = Array.from(document.querySelectorAll<HTMLElement>("button"))
      .find((element) => element.textContent?.trim() === "移除项目");
    expect(removeItem, "菜单里应有「移除项目」").toBeTruthy();
    await act(async () => removeItem!.click());
    await flush();
    const confirmButton = Array.from(document.querySelectorAll<HTMLElement>("button"))
      .find((element) => element.textContent?.trim() === "移除");
    expect(confirmButton, "确认弹窗里应有「移除」").toBeTruthy();
    await act(async () => confirmButton!.click());
    await flush();

    expect(mocks.mutateProject).toHaveBeenCalledWith({ kind: "delete", projectId: ALIVE_PROJECT.id });
    // 理由就近写在确认弹窗里，弹窗本身不关：人已经确认过一次，不该被推回原页面又去别处找原因。
    expect(document.body.textContent).toContain("先在共享它的账号里停止共享");
    expect(document.body.textContent).toContain("磁盘上的文件夹不会被删除");
    expect(document.querySelector(".confirm-dialog__error")?.textContent).toBe(
      "这个项目还关联着协作项目，先在共享它的账号里停止共享"
    );
  });

  it("leaves a project alone while its local project is still there", async () => {
    cloudProjects = [{ ...ORPHAN_PROJECT, localProjectId: ALIVE_PROJECT.id }];

    await act(async () => {
      root.render(
        <AppStateProvider>
          <ApiClientsContext.Provider value={{ clients, setClients: () => undefined }}>
            <TaskBusProvider>
              <I18nProvider language="zh-CN">
                <NotificationCenterProvider>
                  <Shell />
                </NotificationCenterProvider>
              </I18nProvider>
            </TaskBusProvider>
          </ApiClientsContext.Provider>
        </AppStateProvider>
      );
    });
    await flush();
    await act(async () => {
      await loadCollabProjects(mocks as never);
    });
    await flush();

    expect(mocks.ensureWorkingDirectory).not.toHaveBeenCalled();
    // 只关心自愈：不建也不绑。名字跟着云端同步是另一件事（owner 改过名），这里不作为判据。
    const kinds = mocks.mutateProject.mock.calls.map(([operation]) => (operation as { kind: string }).kind);
    expect(kinds).not.toContain("create");
    expect(kinds).not.toContain("delete");
    expect(mocks.bindLocalProject).not.toHaveBeenCalled();
  });
});
