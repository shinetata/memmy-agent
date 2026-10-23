// @vitest-environment happy-dom

/**
 * The new-project dialog. A project stays on this computer unless the sharing box is ticked, so the unshared path
 * must not touch the cloud at all; ticking it creates the cloud record and asks which sessions to sync.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCollabProjectsSnapshot, resetCollabProjectsStore } from "../../app/collab-projects-store.js";
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

describe("new project dialog", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onCreated = vi.fn();

  function collab() {
    return {
      createProject: mocks.createProject,
      bindLocalProject: mocks.bindLocalProject
    } as never;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    resetCollabProjectsStore();
    mocks.prepareDirectory.mockResolvedValue("/Users/me/.memmy/local-projects/demo");
    mocks.mutateProject.mockResolvedValue({ status: "committed", project: { id: "local-1" } });
    mocks.createProject.mockResolvedValue({
      project: { id: "cloud-1", name: "demo", role: "owner", memberCount: 1, sessionCount: 0, createdAt: null, localProjectId: null }
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
            collab={collab()}
            onClose={vi.fn()}
            onCreated={onCreated}
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
  });

  // The dialog mounts on the body through a portal, so the page container is not where it lives.
  function nameInput(): HTMLInputElement {
    const input = document.querySelector<HTMLInputElement>(".modal-body input:not([type='checkbox'])");
    expect(input, "名称输入框应已渲染").toBeTruthy();
    return input!;
  }

  /** React owns the input's value, so the native setter has to run before the change event is dispatched. */
  function type(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function shareCheckbox(): HTMLInputElement {
    const input = document.querySelector<HTMLInputElement>("input[type='checkbox']");
    expect(input, "共享勾选框应已渲染").toBeTruthy();
    return input!;
  }

  function submitButton(): HTMLElement {
    const buttons = Array.from(document.querySelectorAll<HTMLElement>("button"));
    const target = buttons.find((button) => button.textContent?.trim() === "创建");
    expect(target, "创建按钮应已渲染").toBeTruthy();
    return target!;
  }

  it("creates only the local project while sharing is off", async () => {
    expect(shareCheckbox().checked).toBe(false);
    await act(async () => type(nameInput(), "demo"));
    await act(async () => submitButton().click());
    await flush();

    // Nothing reaches the cloud: the project is only on this computer.
    expect(mocks.createProject).not.toHaveBeenCalled();
    expect(mocks.bindLocalProject).not.toHaveBeenCalled();
    expect(mocks.prepareDirectory).toHaveBeenCalledWith(expect.anything(), "demo");
    expect(mocks.mutateProject).toHaveBeenCalledWith({
      kind: "create",
      input: {
        mode: "blank",
        path: "/Users/me/.memmy/local-projects/demo",
        name: "demo",
        allowShared: true
      }
    });
    expect(onCreated).toHaveBeenCalledWith("local-1");
    expect(getCollabProjectsSnapshot().taskPickerFor).toBeNull();
  });

  it("creates the cloud record once sharing is ticked", async () => {
    await act(async () => type(nameInput(), "demo"));
    await act(async () => {
      shareCheckbox().click();
    });
    await act(async () => submitButton().click());
    await flush();

    expect(mocks.createProject).toHaveBeenCalledWith("demo", "/Users/me/.memmy/local-projects/demo");
    expect(mocks.bindLocalProject).toHaveBeenCalledWith("cloud-1", "local-1");
    // A brand-new project has no sessions yet, so nothing is asked and nothing pops up over the board.
    expect(getCollabProjectsSnapshot().taskPickerFor).toBeNull();
    expect(onCreated).toHaveBeenCalledWith("local-1");
  });
});
