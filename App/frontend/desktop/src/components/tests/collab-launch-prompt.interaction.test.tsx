// @vitest-environment happy-dom
/**
 * The one-time project-collaboration announcement: it appears once per computer on the first workspace visit, explains
 * the problem with one example, and asks for the agent authorization in place before opening the new-project dialog
 * with sharing already on.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollabAgentAccessView, CollabAgentInstallResult, CollabClient } from "../../api/collab-client.js";
import {
  claimCollabLaunchPrompt,
  COLLAB_LAUNCH_PROMPT_STORAGE_KEY,
  hasCollabLaunchPromptClaimedThisRun,
  markCollabLaunchPromptSeen,
  resetCollabLaunchPromptRuntime,
  setCollabLaunchPromptOpen
} from "../../app/collab-launch-prompt-state.js";
import { getCollabProjectsSnapshot, resetCollabProjectsStore } from "../../app/collab-projects-store.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { CollabLaunchDialog } from "../collab-launch-dialog.js";
import { CollabLaunchPromptHost } from "../collab-launch-prompt-host.js";
import { GithubStarPromptHost } from "../github-star-prompt-host.js";

const mocks = vi.hoisted(() => ({
  guidanceDone: true,
  state: {
    startup: { status: "ready" },
    navigation: { currentPath: "/main", windowVisible: true },
    bootstrap: {
      app: { userMode: "account" as "account" | "byok" | "unset" },
      onboarding: { completed: true }
    },
    account: { userId: "user-1" as string | null },
    agent: { lastTaskCompletion: { at: 7 } as { at: number } | null }
  }
}));

vi.mock("../../state/app-state.js", () => ({
  useAppState: () => ({ state: mocks.state, dispatch: vi.fn() })
}));

vi.mock("../../app/use-guidance-progress.js", () => ({
  useGuidanceDone: () => mocks.guidanceDone
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class MemoryStorage implements Storage {
  private readonly data = new Map<string, string>();

  get length() {
    return this.data.size;
  }

  clear() {
    this.data.clear();
  }

  getItem(key: string) {
    return this.data.get(key) ?? null;
  }

  key(index: number) {
    return [...this.data.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.data.delete(key);
  }

  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
}

function resetStorage(name: "localStorage" | "sessionStorage"): void {
  const current = window[name];
  if (typeof current?.clear === "function") {
    current.clear();
    return;
  }
  Object.defineProperty(window, name, { configurable: true, value: new MemoryStorage() });
}

/** The new-project dialog is mounted by AppFrame, so the store flag is what this host hands over. */
function createProjectRequested(): { createPending: boolean; createShareDefault: boolean } {
  const snapshot = getCollabProjectsSnapshot();
  return { createPending: snapshot.createPending, createShareDefault: snapshot.createShareDefault };
}

const AGENTS: CollabAgentAccessView["agents"] = [
  { sourceId: "claude_code", name: "Claude Code", available: true, enabled: true, installed: false, added: false },
  { sourceId: "codex", name: "Codex", available: true, enabled: true, installed: false, added: false },
  { sourceId: "cursor", name: "Cursor", available: true, enabled: false, installed: false, added: false }
];

function installResults(ok: (sourceId: string) => boolean = () => true): CollabAgentInstallResult[] {
  return AGENTS.filter((agent) => agent.enabled).map((agent) => ({
    sourceId: agent.sourceId,
    name: agent.name,
    ok: ok(agent.sourceId)
  }));
}

/** A client that only answers the authorization calls this card makes. */
function fakeCollab(options: {
  granted?: boolean;
  agents?: CollabAgentAccessView["agents"];
  grant?: () => Promise<{ view: CollabAgentAccessView; results: CollabAgentInstallResult[] }>;
  retry?: (ids: readonly string[]) => Promise<{ view: CollabAgentAccessView; results: CollabAgentInstallResult[] }>;
} = {}): CollabClient {
  const agents = options.agents ?? AGENTS;
  const view: CollabAgentAccessView = { granted: options.granted ?? false, askedInProject: false, agents };
  return {
    getAgentAccess: async () => view,
    setAgentAccess: async () => options.grant?.() ?? { view: { ...view, granted: true }, results: installResults() },
    installAgentAccess: async (ids?: readonly string[]) =>
      options.retry?.(ids ?? []) ?? { view: { ...view, granted: true }, results: installResults() },
    markAgentAccessAsked: async () => view
  } as unknown as CollabClient;
}

describe("collab launch prompt", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetStorage("localStorage");
    resetStorage("sessionStorage");
    resetCollabLaunchPromptRuntime();
    resetCollabProjectsStore();
    mocks.guidanceDone = true;
    mocks.state.startup.status = "ready";
    mocks.state.navigation.currentPath = "/main";
    mocks.state.navigation.windowVisible = true;
    mocks.state.bootstrap.app.userMode = "account";
    mocks.state.bootstrap.onboarding.completed = true;
    mocks.state.account.userId = "user-1";
    mocks.state.agent.lastTaskCompletion = { at: 7 };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    setCollabLaunchPromptOpen(false);
    resetCollabLaunchPromptRuntime();
    resetCollabProjectsStore();
    document.body.replaceChildren();
  });

  const renderHost = async (node = <CollabLaunchPromptHost />, language = "zh-CN") => act(async () => {
    root.render(<I18nProvider language={language}>{node}</I18nProvider>);
  });

  const dialog = () => document.querySelector<HTMLElement>(".collab-launch-dialog");
  const title = () => document.querySelector("#collab-launch-title")?.textContent?.trim();
  const subtitle = () => document.querySelector(".collab-launch-copy h3")?.textContent?.trim();
  const primary = () => document.querySelector<HTMLButtonElement>(".collab-launch-primary");
  const footnote = () => document.querySelector("#collab-launch-footnote")?.textContent?.trim();
  const click = async (element: Element | null) => act(async () => {
    (element as HTMLElement).click();
  });

  it("opens on the first workspace visit and records it right away", async () => {
    await renderHost();

    expect(dialog()).not.toBeNull();
    expect(window.localStorage.getItem(COLLAB_LAUNCH_PROMPT_STORAGE_KEY)).toBe("1");
  });

  it("shows one page with the example and no paging controls", async () => {
    await renderHost();

    expect(title()).toBe("项目协作");
    expect(subtitle()).toBe("接着成员的任务继续做");
    expect(document.querySelector(".collab-launch-count")).toBeNull();
    expect(document.querySelector(".collab-launch-dots")).toBeNull();
    expect(document.querySelector(".collab-launch-prev")).toBeNull();
    expect(document.querySelector(".collab-launch-chat__user")?.textContent?.trim())
      .toBe("接着成员在 Codex 里做的退款接口，把测试补上");
    expect(document.querySelector(".collab-launch-visual__caption")?.textContent?.trim())
      .toBe("成员做到哪，你的 Agent 直接接着做");
  });

  it("uses the English copy in English", async () => {
    await renderHost(<CollabLaunchPromptHost />, "en-US");

    expect(title()).toBe("Shared projects");
    expect(subtitle()).toBe("Pick up a member's task and keep going");
    expect(document.querySelector(".collab-launch-visual__caption")?.textContent?.trim())
      .toBe("Where a member stopped, your Agent starts");
  });

  it("only offers the project when no client is available, and opens the new-project dialog with sharing on", async () => {
    await renderHost();

    // No providers in this environment: the card cannot authorize, so it goes straight to the project.
    expect(primary()?.textContent?.trim()).toBe("新建项目");
    expect(footnote()).toContain("Memmy 会读取本机 Agent 的任务");

    await click(primary());

    expect(dialog()).toBeNull();
    expect(createProjectRequested()).toEqual({ createPending: true, createShareDefault: true });
    // The run's one announcement is spent, so the other large prompts wait for the next launch.
    expect(hasCollabLaunchPromptClaimedThisRun()).toBe(true);
  });

  it("closes on Escape without opening the new-project dialog", async () => {
    await renderHost();
    expect(dialog()).not.toBeNull();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(dialog()).toBeNull();
    expect(createProjectRequested().createPending).toBe(false);
  });

  it("closes when the backdrop is clicked", async () => {
    await renderHost();

    await click(document.querySelector(".collab-launch-backdrop"));
    expect(dialog()).toBeNull();
  });

  it("stays away on the next launch once this computer saw it", async () => {
    markCollabLaunchPromptSeen(window.localStorage);
    await renderHost();

    expect(dialog()).toBeNull();
    expect(hasCollabLaunchPromptClaimedThisRun()).toBe(false);
  });

  it("shows up again after closing once the record is gone", async () => {
    await renderHost();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(dialog()).toBeNull();

    window.localStorage.removeItem(COLLAB_LAUNCH_PROMPT_STORAGE_KEY);
    await act(async () => root.unmount());
    root = createRoot(container);
    await renderHost();

    expect(dialog()).not.toBeNull();
  });

  it("does not offer it in API Key mode, and records nothing", async () => {
    mocks.state.bootstrap.app.userMode = "byok";
    await renderHost();

    expect(dialog()).toBeNull();
    expect(window.localStorage.getItem(COLLAB_LAUNCH_PROMPT_STORAGE_KEY)).toBeNull();
  });

  it("waits for a signed-in account", async () => {
    mocks.state.account.userId = null;
    await renderHost();

    expect(dialog()).toBeNull();
    expect(window.localStorage.getItem(COLLAB_LAUNCH_PROMPT_STORAGE_KEY)).toBeNull();
  });

  it("waits until the new-user guidance is done", async () => {
    mocks.guidanceDone = false;
    await renderHost();

    expect(dialog()).toBeNull();
    expect(window.localStorage.getItem(COLLAB_LAUNCH_PROMPT_STORAGE_KEY)).toBeNull();
  });

  it("waits for a workspace route", async () => {
    mocks.state.navigation.currentPath = "/welcome";
    await renderHost();

    expect(dialog()).toBeNull();
  });

  it("holds the GitHub star card back while this run's announcement is claimed", async () => {
    claimCollabLaunchPrompt();
    await renderHost(<GithubStarPromptHost />);

    expect(document.querySelector(".github-star-prompt")).toBeNull();
  });

  it("leaves the GitHub star card alone on a run that never claimed the slot", async () => {
    await renderHost(<GithubStarPromptHost />);

    expect(document.querySelector(".github-star-prompt")).not.toBeNull();
  });
});

describe("collab launch authorization", () => {
  let container: HTMLDivElement;
  let root: Root;
  const close = vi.fn();
  const createProject = vi.fn();

  beforeEach(() => {
    close.mockClear();
    createProject.mockClear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  const render = async (collab: CollabClient | null, language = "zh-CN") => act(async () => {
    root.render(
      <I18nProvider language={language}>
        <CollabLaunchDialog collab={collab} onClose={close} onCreateProject={createProject} />
      </I18nProvider>
    );
  });

  const primary = () => document.querySelector<HTMLButtonElement>(".collab-launch-primary");
  const retry = () => document.querySelector<HTMLButtonElement>(".collab-launch-retry");
  const status = () => document.querySelector(".collab-launch-status")?.textContent?.trim();
  const footnote = () => document.querySelector("#collab-launch-footnote")?.textContent?.trim();
  const click = async (element: Element | null) => act(async () => {
    (element as HTMLElement).click();
  });

  it("asks for the authorization, lists the enabled agents, and switches to the project button", async () => {
    const setAgentAccess = vi.fn(async () => ({
      view: { granted: true, askedInProject: false, agents: AGENTS },
      results: installResults()
    }));
    await render({ ...fakeCollab(), setAgentAccess } as unknown as CollabClient);

    expect(primary()?.textContent?.trim()).toBe("授权并开始");
    // Only the enabled agents are named; the disabled one is left out.
    expect(footnote()).toContain("Claude Code、Codex");
    expect(footnote()).not.toContain("Cursor");

    await click(primary());

    expect(setAgentAccess).toHaveBeenCalledWith(true);
    expect(status()).toBe("已在 2 个 Agent 中安装");
    expect(primary()?.textContent?.trim()).toBe("新建项目");
    expect(footnote()).toContain("已授权");

    await click(primary());
    expect(createProject).toHaveBeenCalledTimes(1);
  });

  it("shows the installing state while the authorization runs", async () => {
    let resolve: ((value: { view: CollabAgentAccessView; results: CollabAgentInstallResult[] }) => void) | undefined;
    const pending = new Promise<{ view: CollabAgentAccessView; results: CollabAgentInstallResult[] }>((done) => {
      resolve = done;
    });
    await render(fakeCollab({ grant: () => pending }));

    await act(async () => {
      primary()?.click();
    });

    expect(primary()?.textContent?.trim()).toBe("正在安装…");
    expect(primary()?.disabled).toBe(true);

    await act(async () => {
      resolve?.({ view: { granted: true, askedInProject: false, agents: AGENTS }, results: installResults() });
      await pending;
    });

    expect(primary()?.textContent?.trim()).toBe("新建项目");
  });

  it("goes straight to the project button when this computer already authorized", async () => {
    await render(fakeCollab({ granted: true }));

    expect(primary()?.textContent?.trim()).toBe("新建项目");
    expect(footnote()).toContain("已授权");
    expect(status()).toBeUndefined();

    await click(primary());
    expect(createProject).toHaveBeenCalledTimes(1);
  });

  it("reports a failed authorization and lets the person try again", async () => {
    let attempt = 0;
    const collab = fakeCollab({
      grant: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("boom");
        return { view: { granted: true, askedInProject: false, agents: AGENTS }, results: installResults() };
      }
    });
    await render(collab);

    await click(primary());
    expect(status()).toBe("没有完成授权，请重试。");
    expect(primary()?.textContent?.trim()).toBe("授权并开始");
    expect(createProject).not.toHaveBeenCalled();

    await click(primary());
    expect(status()).toBe("已在 2 个 Agent 中安装");
    expect(primary()?.textContent?.trim()).toBe("新建项目");
  });

  it("names the agents that did not install and retries only those", async () => {
    const installAgentAccess = vi.fn(async (ids?: readonly string[]) => ({
      view: { granted: true, askedInProject: false, agents: AGENTS },
      results: (ids ?? []).map((sourceId) => ({
        sourceId,
        name: AGENTS.find((agent) => agent.sourceId === sourceId)?.name ?? sourceId,
        ok: true
      }))
    }));
    const collab = {
      ...fakeCollab({ grant: async () => ({
        view: { granted: true, askedInProject: false, agents: AGENTS },
        results: installResults((sourceId) => sourceId !== "codex")
      }) }),
      installAgentAccess
    } as unknown as CollabClient;
    await render(collab);

    await click(primary());

    expect(status()).toBe("已在 1 个 Agent 中安装，Codex 未成功");
    expect(retry()).not.toBeNull();

    await click(retry());

    expect(installAgentAccess).toHaveBeenCalledWith(["codex"]);
    expect(status()).toBe("已在 2 个 Agent 中安装");
    expect(retry()).toBeNull();
  });

  it("still allows authorizing when no agent is available on this computer", async () => {
    const setAgentAccess = vi.fn(async () => ({
      view: { granted: true, askedInProject: false, agents: [] },
      results: []
    }));
    await render({ ...fakeCollab({ agents: [] }), setAgentAccess } as unknown as CollabClient);

    expect(primary()?.textContent?.trim()).toBe("授权并开始");
    expect(footnote()).toContain("本机还没有可用的 Agent");

    await click(primary());
    expect(setAgentAccess).toHaveBeenCalledWith(true);
    expect(primary()?.textContent?.trim()).toBe("新建项目");
    expect(footnote()).toContain("已授权");
  });

  it("names the agents in English with commas", async () => {
    await render(fakeCollab(), "en-US");

    expect(primary()?.textContent?.trim()).toBe("Authorize and start");
    expect(footnote()).toContain("Claude Code, Codex");
  });
});
