// @vitest-environment happy-dom

/**
 * 新建项目时是否带上演示标记：只有本人还没有任何在线项目、并且这次要共享时才带。
 * 带上也不代表一定演示——云端会再判断开关、名单与是否已经体验过，返回 `demo.active` 才真的开始。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addCollabProject, getCollabProjectsSnapshot, loadCollabProjects, requestCreateProject, resetCollabProjectsStore } from "../../app/collab-projects-store.js";
import {
  clearDemoGuideDone,
  dispatchDemoGuide,
  markDemoGuideDone,
  setDemoGuideStateForTest,
  startDemoGuideBeforeProject
} from "../../app/collab-demo-guide-store.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { CreateProjectModal } from "../collab-create-project-dialog.js";

const mocks = vi.hoisted(() => ({
  mutateProject: vi.fn(),
  prepareDirectory: vi.fn(),
  createProject: vi.fn(),
  bindLocalProject: vi.fn()
}));

vi.mock("../../app/agent-runtime-bridge.js", () => ({
  useOptionalAgentRuntimeBridge: () => ({ taskStateCoordinator: { mutateProject: mocks.mutateProject } })
}));

vi.mock("../../app/providers.js", () => ({
  useOptionalApiClients: () => ({ clients: { runtimeConfig: { baseUrl: "http://127.0.0.1:1" } } })
}));

vi.mock("../../api/projects-client.js", () => ({
  prepareProjectDirectory: mocks.prepareDirectory
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
  }
}

/**
 * 把云端「这个人现在能不能体验」写成给定值。
 *
 * 项目列表响应里的 `demoEligible` 就是云端 `eligible()` 的结果，新建弹窗要不要走六屏按它判。
 */
async function setDemoEligible(eligible: boolean): Promise<void> {
  await loadCollabProjects({
    listProjects: async () => ({ projects: [], demoEligible: eligible })
  } as never);
}

describe("new project dialog and the demo flag", () => {
  let container: HTMLDivElement;
  let root: Root;

  function nameInput(): HTMLInputElement {
    const input = document.querySelector<HTMLInputElement>(".modal-body input:not([type='checkbox'])");
    expect(input).toBeTruthy();
    return input!;
  }

  function type(input: HTMLInputElement, value: string) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function submitButton(): HTMLElement {
    const target = Array.from(document.querySelectorAll<HTMLElement>("button"))
      .find((button) => button.textContent?.trim() === "创建项目");
    expect(target).toBeTruthy();
    return target!;
  }

  /** 启动引导并一路「下一步」到最后一屏：只有那一屏名称框可输入、「创建项目」可点。 */
  async function advanceToCreateScreen(): Promise<void> {
    // 真实路径里引导由 app-frame 在弹窗打开后启动，这里补上这一步。
    await act(async () => {
      startDemoGuideBeforeProject();
    });
    for (let step = 0; step < 5; step += 1) {
      await act(async () => {
        dispatchDemoGuide({ type: "next" });
      });
    }
  }

  /** 用体验入口的样子打开一次弹窗：名称与协作开关都由引导替人填好。 */
  async function renderDemoDialog(overrides?: {
    shareAvailable?: boolean;
    onJoinProject?: boolean;
    /** 打开后直接推到最后一屏：要真的输入并提交的用例用这个。 */
    advanceToCreate?: boolean;
  }): Promise<void> {
    await act(async () => root.unmount());
    container.remove();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <CreateProjectModal
            open
            defaultShare
            demo
            shareAvailable={overrides?.shareAvailable}
            onJoinProject={overrides?.onJoinProject === false ? undefined : vi.fn()}
            collab={{ createProject: mocks.createProject, bindLocalProject: mocks.bindLocalProject } as never}
            onClose={vi.fn()}
            onCreated={vi.fn()}
            onShared={vi.fn()}
            onBound={vi.fn()}
            onBindFailed={vi.fn()}
            onShareFailed={vi.fn()}
          />
        </I18nProvider>
      );
    });
    await flush();
    if (overrides?.advanceToCreate) await advanceToCreateScreen();
  }

  /** 弹窗上所有的引导锚点。 */
  function anchors(): string[] {
    return Array.from(document.querySelectorAll<HTMLElement>("[data-demo-guide]"))
      .map((element) => element.getAttribute("data-demo-guide") ?? "");
  }

  async function createNamed(name: string): Promise<void> {
    await act(async () => type(nameInput(), name));
    await act(async () => submitButton().click());
    await flush();
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    resetCollabProjectsStore();
    // 本机「已退出过引导」的标记与用例无关，每个用例从干净状态开始。
    clearDemoGuideDone();
    // 默认云端说这个人还能体验：六屏是否真的走由它决定，不能演示的用例自己改成 false。
    await setDemoEligible(true);
    mocks.prepareDirectory.mockResolvedValue("/Users/me/.memmy/local-projects/demo");
    mocks.mutateProject.mockResolvedValue({ status: "committed", project: { id: "local-1" } });
    mocks.createProject.mockResolvedValue({
      project: {
        id: "cloud-1",
        name: "demo",
        role: "owner",
        memberCount: 2,
        sessionCount: 0,
        createdAt: null,
        localProjectId: null,
        demo: { active: true, memberUserId: "9001", memberName: "小饭团", step: "1" }
      }
    });
    mocks.bindLocalProject.mockResolvedValue(undefined);

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <CreateProjectModal
            open
            // 大卡与侧栏第一次新建都会把共享默认打开，演示只在这条路径上出现。
            defaultShare
            collab={{ createProject: mocks.createProject, bindLocalProject: mocks.bindLocalProject } as never}
            onClose={vi.fn()}
            onCreated={vi.fn()}
            onShared={vi.fn()}
            onBound={vi.fn()}
            onBindFailed={vi.fn()}
            onShareFailed={vi.fn()}
          />
        </I18nProvider>
      );
    });
    await flush();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    resetCollabProjectsStore();
    setDemoGuideStateForTest(null);
    clearDemoGuideDone();
  });

  it("opens the walkthrough entrance with the name and sharing already set", async () => {
    await renderDemoDialog();

    // 名字替人填好，用户不用输任何东西。
    expect(nameInput().value).toBe("项目协作体验");
    const shareSwitch = document.querySelector<HTMLElement>("[role='switch']");
    expect(shareSwitch?.getAttribute("aria-checked")).toBe("true");
    // 「创建项目」是引导唯一的亮区：锚点就在这个按钮上。
    expect(submitButton().getAttribute("data-demo-guide")).toBe("create-project-submit");
    // 弹窗自己的暗底让给蒙版，否则会叠两层灰。
    expect(document.querySelector(".modal-backdrop")?.className).toContain("backdropYield");
    // 名称框不抢光标：这一步要点的是「创建项目」。
    expect(document.activeElement).not.toBe(nameInput());
  });

  it("marks every control the walkthrough steps through", async () => {
    await renderDemoDialog();

    // 六屏各一个亮区：整个弹窗、名称、文件夹、协作开关、左下「加入项目」与底部「创建项目」。
    expect(anchors().sort()).toEqual([
      "create-collab",
      "create-dialog",
      "create-folder",
      "create-join",
      "create-name",
      "create-project-submit"
    ]);
    // 亮区之间是嵌套关系：外层框住整个弹窗，里面的四块各框一项。
    const dialog = document.querySelector("[data-demo-guide='create-dialog']");
    expect(dialog?.getAttribute("role")).toBe("dialog");
    for (const inner of ["create-name", "create-folder", "create-collab"]) {
      expect(dialog?.querySelector(`[data-demo-guide='${inner}']`)).toBeTruthy();
    }
  });

  it("skips the join anchor when there is no join button", async () => {
    // API Key 模式没有云端账号可加入：弹窗里整块共享入口都不出现。
    await renderDemoDialog({ shareAvailable: false });
    expect(anchors()).toEqual([]);

    // 协作可用但这次没给「加入项目」的入口：其余锚点都在，唯独没有 create-join，
    // 状态机据此跳过那一步，不会把气泡指向不存在的元素。
    await renderDemoDialog({ onJoinProject: false });
    expect(anchors()).not.toContain("create-join");
    expect(anchors()).toContain("create-project-submit");
  });

  it("asks the cloud for the demo on the first shared project", async () => {
    await createNamed("项目协作体验");
    expect(mocks.createProject).toHaveBeenCalledWith("项目协作体验", "/Users/me/.memmy/local-projects/demo", { demo: true, localProjectId: "local-1" });
  });

  it("leaves an ordinary new project empty and without the anchor", async () => {
    // 侧栏的普通新建：名称留空等人输入，按钮上没有引导锚点，其他地方也一个都不挂。
    expect(nameInput().value).toBe("");
    expect(submitButton().getAttribute("data-demo-guide")).toBeNull();
    expect(anchors()).toEqual([]);
  });

  it("never asks for the demo once an online project exists", async () => {
    await act(async () => {
      addCollabProject({
        id: "p-existing",
        name: "旧的协作项目",
        role: "owner",
        memberCount: 2,
        sessionCount: 1,
        createdAt: null,
        localProjectId: "local-9"
      });
    });
    await createNamed("第二个项目");
    expect(mocks.createProject).toHaveBeenCalledWith("第二个项目", "/Users/me/.memmy/local-projects/demo", { demo: false, localProjectId: "local-1" });
  });

  it("still asks for the demo from the launch card when the person already has one", async () => {
    // 大卡入口已经明确要体验：名下已有协作项目也照旧带标记，由云端按名单与是否体验过决定。
    await act(async () => {
      addCollabProject({
        id: "p-existing",
        name: "旧的协作项目",
        role: "owner",
        memberCount: 2,
        sessionCount: 1,
        createdAt: null,
        localProjectId: "local-9"
      });
    });
    await renderDemoDialog({ advanceToCreate: true });
    await createNamed("项目协作体验");
    expect(mocks.createProject).toHaveBeenCalledWith("项目协作体验", "/Users/me/.memmy/local-projects/demo", { demo: true, localProjectId: "local-1" });
  });
  /**
   * 云端说这个人这次不能演示（已体验过、开关关掉、不在名单）：六屏就不该开。
   *
   * 判断只在打开那一刻做一次（`requestCreateProject`）：弹窗、预填的名称与蒙版因此同一刻到位。
   * 弹窗自己再按 `demoEligible` 重算一遍就会多一个时机差——名单是随列表异步回来的。
   */
  it("opens an ordinary dialog when the cloud cannot demo this person", async () => {
    await act(async () => {
      await setDemoEligible(false);
    });
    await act(async () => {
      requestCreateProject({ share: true, demo: true });
    });

    // 名单说不能演示：这次新建按普通新建打开，弹窗收到的 demo 是 false，预填名称与六个亮区都不会出现。
    expect(getCollabProjectsSnapshot().createDemo).toBe(false);
    // 分享仍按大卡的意图默认打开。
    expect(getCollabProjectsSnapshot().createShareDefault).toBe(true);
  });

  /**
   * 名单晚于弹窗回来：不再补一次蒙版。
   *
   * 补上去就是「弹窗先露出来、人已经在填名称，蒙版才盖上来」：预填的名称被清掉之后，蒙版挡着输入框，
   * 「创建项目」也因为名称为空一直是灰的，两条路都堵住。
   */
  it("never adds the walkthrough to a dialog that is already open", async () => {
    await act(async () => {
      resetCollabProjectsStore();
      requestCreateProject({ share: true, demo: true });
    });
    // 名单还没读过：先按普通新建开，不猜。
    expect(getCollabProjectsSnapshot().createDemo).toBe(false);

    await act(async () => {
      await setDemoEligible(true);
    });
    // 名单回来说可以：这一次也不改，弹窗里人已经动过的东西不能被换掉。
    expect(getCollabProjectsSnapshot().createDemo).toBe(false);
  });

  /**
   * 六屏在弹窗上走的时候，名称框先不接点击。
   *
   * 蒙版要量出锚点位置才画得出来，这几帧里弹窗看上去和普通新建一样；人此时点进名称框把预填的名字删掉，
   * 蒙版一盖上来就既改不回去也点不了创建。
   */
  it("holds the name field and the submit button before the last screen", async () => {
    await act(async () => {
      startDemoGuideBeforeProject();
    });
    await renderDemoDialog();
    expect(document.querySelector<HTMLElement>("[data-demo-guide='create-name']")?.style.pointerEvents).toBe("none");
    // `pointerEvents` 只挡鼠标，键盘 Tab 仍能聚焦输入框并退格删字，所以名称框同时是只读且跳过 Tab。
    expect(nameInput().readOnly).toBe(true);
    expect(nameInput().tabIndex).toBe(-1);
    // 最后一屏之前「创建项目」也不接点击：蒙版还没画出来时点下去，六屏一步都没走就建出了项目。
    expect(submitButton().hasAttribute("disabled")).toBe(true);

    // 引导收起（退出、跳过或云端说结束）：名称框回到可点。
    await act(async () => {
      setDemoGuideStateForTest(null);
    });
    expect(document.querySelector<HTMLElement>("[data-demo-guide='create-name']")?.style.pointerEvents ?? "").toBe("");
    expect(nameInput().readOnly).toBe(false);
  });

  /**
   * 引导还没启动的那一帧也要拦住：弹窗与引导不是同一拍挂上来的，引导由 app-frame 的 effect 启动。
   * 只看「引导是否 active」时首帧漏拦，而那一帧弹窗已经带着预填名称、「创建项目」也是亮的。
   */
  it("holds the fields on the very first frame, before the walkthrough starts", async () => {
    await renderDemoDialog();
    // 这一步没有调用 startDemoGuideBeforeProject：模拟弹窗先渲染、引导晚一拍。
    expect(nameInput().value).toBe("项目协作体验");
    expect(nameInput().readOnly).toBe(true);
    expect(submitButton().hasAttribute("disabled")).toBe(true);
  });

  it("lets the real create button be pressed on the last screen", async () => {
    await act(async () => {
      startDemoGuideBeforeProject();
    });
    await renderDemoDialog();

    // 一路「下一步」到最后一屏：只有这里「创建项目」可点；名称仍然只读，人不需要也不能改名。
    await advanceToCreateScreen();
    expect(nameInput().readOnly).toBe(true);
    expect(nameInput().value).toBe("项目协作体验");
    expect(submitButton().hasAttribute("disabled")).toBe(false);
  });

  it("never asks for the demo once this machine has left the walkthrough", async () => {
    // 用户点过「退出引导」：本机标记已写，之后第一次创建共享项目也不再请求演示。
    markDemoGuideDone();
    await createNamed("我的第一个项目");
    expect(mocks.createProject).toHaveBeenCalledWith("我的第一个项目", "/Users/me/.memmy/local-projects/demo", { demo: false, localProjectId: "local-1" });

    // 大卡入口同样不带：本机已经退出过，就不再带人走一遍。
    await renderDemoDialog();
    await createNamed("项目协作体验");
    expect(mocks.createProject).toHaveBeenLastCalledWith("项目协作体验", "/Users/me/.memmy/local-projects/demo", { demo: false, localProjectId: "local-1" });
  });

  it("still asks for the demo when the person has only joined others' projects", async () => {
    await act(async () => {
      addCollabProject({
        id: "p-joined",
        name: "同事的项目",
        role: "member",
        memberCount: 3,
        sessionCount: 4,
        createdAt: null,
        localProjectId: "local-8"
      });
    });
    await createNamed("我的第一个项目");
    expect(mocks.createProject).toHaveBeenCalledWith("我的第一个项目", "/Users/me/.memmy/local-projects/demo", { demo: true, localProjectId: "local-1" });
  });
});
