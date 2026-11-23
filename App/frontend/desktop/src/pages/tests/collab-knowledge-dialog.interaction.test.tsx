// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { ProjectKnowledgeDialog } from "../collab-knowledge-dialog.js";
import { listKnowledgeBases } from "../../api/knowledge-bases-client.js";
import type { CollabKnowledgeView } from "../../api/collab-client.js";

vi.mock("../../api/knowledge-bases-client.js", () => ({ listKnowledgeBases: vi.fn() }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 本人可访问的全部知识库；已关联的也会出现在这里，弹窗按关联状态合并成一份列表。 */
const options = [
  { id: "product", name: "MemOS产品" },
  { id: "team", name: "团队规范", shared: true, sharedByMe: false, ownerName: "小林" },
  { id: "linked", name: "已关联资料" },
  { id: "theirs", name: "别人的资料" }
];
const view: CollabKnowledgeView = {
  bases: [
    { id: "linked", name: "已关联资料", mine: true },
    { id: "theirs", name: "别人的资料", mine: false }
  ],
  maxBases: 10,
  canManage: false
};
let root: Root;
let container: HTMLDivElement;
const onAdd = vi.fn();
const onRemove = vi.fn();
const onClose = vi.fn();

async function render(knowledge: CollabKnowledgeView | null = view) {
  await act(async () => {
    root.render(
      <I18nProvider language="zh-CN">
        <ProjectKnowledgeDialog
          open
          knowledge={knowledge}
          config={{} as never}
          onAdd={onAdd}
          onRemove={onRemove}
          onClose={onClose}
        />
      </I18nProvider>
    );
  });
}

function checkbox(name: string) {
  return document.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!;
}
function done() {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.trim() === "完成")!;
}
async function search(value: string) {
  const input = document.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listKnowledgeBases).mockResolvedValue(options);
  onAdd.mockResolvedValue(undefined);
  onRemove.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("project knowledge dialog", () => {
  it("lists linked bases first and makes the checkbox itself the link state", async () => {
    await render();
    // 只有一个弹窗，已关联的和可关联的在同一份列表里：勾着的是已关联。
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.body.textContent).toContain("已关联 2 个知识库");
    expect(document.body.textContent).toContain("还可关联 8 个");
    expect(checkbox("已关联资料").checked).toBe(true);
    expect(checkbox("别人的资料").checked).toBe(true);
    expect(checkbox("MemOS产品").checked).toBe(false);
    const names = Array.from(document.querySelectorAll('input[type="checkbox"]')).map((input) => input.getAttribute("aria-label"));
    expect(names.slice(0, 2)).toEqual(["已关联资料", "别人的资料"]);

    await act(async () => checkbox("MemOS产品").closest("label")!.click());
    expect(onAdd).toHaveBeenCalledExactlyOnceWith("product");
    expect(onRemove).not.toHaveBeenCalled();

    await act(async () => checkbox("已关联资料").closest("label")!.click());
    expect(onRemove).toHaveBeenCalledExactlyOnceWith("linked");
  });

  it("keeps a base linked by another member read-only unless this person can manage the project", async () => {
    await render({ ...view, canManage: false });
    expect(checkbox("别人的资料").checked).toBe(true);
    expect(checkbox("别人的资料").disabled).toBe(true);
    // 旧云端不返回昵称时退回不点名的说法。
    expect(document.body.textContent).toContain("由其他成员关联");

    await act(async () => checkbox("别人的资料").closest("label")!.click());
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("says which member linked a base this person cannot unlink", async () => {
    const named: CollabKnowledgeView = {
      bases: [{ id: "theirs", name: "别人的资料", mine: false, addedByName: "丰盈锦鲤" }],
      maxBases: 10,
      canManage: false
    };
    await render(named);
    expect(checkbox("别人的资料").disabled).toBe(true);
    // 昵称与两侧文字之间各留一个空格。
    expect(document.body.textContent).toContain("由 丰盈锦鲤 关联，仅所有者可解除");
    expect(document.body.textContent).not.toContain("由其他成员关联");
  });

  it("lets an owner unlink a base another member added", async () => {
    const managed: CollabKnowledgeView = { ...view, maxBases: 20, canManage: true };
    await render(managed);
    expect(checkbox("别人的资料").disabled).toBe(false);
    await act(async () => checkbox("别人的资料").closest("label")!.click());
    expect(onRemove).toHaveBeenCalledExactlyOnceWith("theirs");
  });

  it("stops linking new bases at the capacity but still allows unlinking", async () => {
    const full: CollabKnowledgeView = {
      bases: [{ id: "linked", name: "已关联资料", mine: true }, { id: "theirs", name: "别人的资料", mine: true }],
      maxBases: 2,
      canManage: false
    };
    await render(full);
    expect(document.body.textContent).toContain("还可关联 0 个");
    expect(checkbox("MemOS产品").disabled).toBe(true);
    expect(checkbox("已关联资料").disabled).toBe(false);
  });

  it("distinguishes search misses from an empty library", async () => {
    await render();
    expect(document.body.textContent).toContain("来自 小林");
    await search("不存在");
    expect(document.body.textContent).toContain("未找到相关知识库");
    expect(document.body.textContent).toContain("尝试更换关键词");
    expect(document.body.textContent).not.toContain("暂无可关联的知识库");
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="清除搜索"]')!.click());
    expect(document.querySelector<HTMLInputElement>('input[type="search"]')!.value).toBe("");
    expect(checkbox("MemOS产品")).toBeTruthy();

    vi.mocked(listKnowledgeBases).mockResolvedValue([]);
    await render({ bases: [], maxBases: 10, canManage: false });
    expect(document.body.textContent).toContain("暂无可关联的知识库");
    expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
  });

  it("locks the list and dismissal while a change is in flight and reports the failure", async () => {
    let reject!: (cause: Error) => void;
    onAdd.mockImplementation(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
    await render();
    await act(async () => checkbox("MemOS产品").closest("label")!.click());
    expect(checkbox("MemOS产品").disabled).toBe(true);
    expect(checkbox("已关联资料").disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!.disabled).toBe(true);
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => reject(new Error("网络不可用")));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("网络不可用");
    expect(checkbox("MemOS产品").disabled).toBe(false);
    expect(checkbox("MemOS产品").checked).toBe(false);
  });

  it("closes with 完成 and does not open another dialog", async () => {
    await render();
    expect(document.body.textContent).not.toContain("管理知识库");
    await act(async () => done().click());
    expect(onClose).toHaveBeenCalledOnce();
  });
});
