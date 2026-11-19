// @vitest-environment happy-dom

/**
 * 看板在没有项目时不该停在空状态页：那里没有任何可讲的内容，
 * 人删掉最后一个项目后应当直接回到新会话页面。
 * 断言落在「有没有要求导航到 /main」，不落在样式上。
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
  listAddedAgents: vi.fn().mockResolvedValue([]),
  knowledge: vi.fn().mockResolvedValue({ bases: [], maxBases: 10 }),
  listSessions: vi.fn().mockResolvedValue([]),
  readSessionDetail: vi.fn(),
  readReference: vi.fn(),
  removeSession: vi.fn(),
  syncSessions: vi.fn(),
  getSyncProgress: vi.fn(),
  dispatch: vi.fn()
}));

/** 本机没有任何项目：删除最后一个之后的状态。 */
const projects: unknown[] = [];

vi.mock("../../api/collab-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/collab-client.js")>();
  return { ...actual, createHttpCollabClient: () => mocks };
});

vi.mock("../../app/providers.js", () => ({
  useApiClients: () => ({ clients: { runtimeConfig: {} }, setClients: vi.fn() })
}));

vi.mock("../../state/app-state.js", () => ({
  useOptionalAppState: () => ({
    state: { agent: { projects, tasks: [] } },
    dispatch: mocks.dispatch
  })
}));

vi.mock("../app-frame.js", () => ({
  AppFrame: (props: { children: ReactNode }) => <div>{props.children}</div>
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("the board without any project", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetCollabProjectsStore();
    mocks.dispatch.mockClear();
    mocks.listProjects.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetCollabProjectsStore();
  });

  it("goes back to the new session page once the shared list is loaded", async () => {
    mocks.listProjects.mockResolvedValue({ projects: [] });
    act(() => {
      root.render(
        <I18nProvider language="zh-CN">
          <CollabPage />
        </I18nProvider>
      );
    });

    // 共享列表还没回来时不跳：启动瞬间本机项目可能只是还没读出来。
    expect(mocks.dispatch).not.toHaveBeenCalledWith({ type: "navigate", path: "/main" });

    await act(async () => {
      await loadCollabProjects(mocks as never);
    });

    expect(mocks.dispatch).toHaveBeenCalledWith(expect.objectContaining({ path: "/main" }));
  });

  it("no longer renders the empty state page", async () => {
    mocks.listProjects.mockResolvedValue({ projects: [] });
    act(() => {
      root.render(
        <I18nProvider language="zh-CN">
          <CollabPage />
        </I18nProvider>
      );
    });
    await act(async () => {
      await loadCollabProjects(mocks as never);
    });

    expect(container.textContent).not.toContain("还没有协作项目");
    expect(container.textContent).not.toContain("新建项目");
  });
});
