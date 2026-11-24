// @vitest-environment happy-dom

/** 一次性结果卡：主行、副行、关闭与自动消失。 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollabResultToast } from "../collab-result-toast.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  vi.useRealTimers();
});

function mount(element: React.ReactElement) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(element));
}

describe("CollabResultToast", () => {
  it("shows a titled result with the project name and gets out of the way", () => {
    const onDismiss = vi.fn();
    mount(
      <I18nProvider>
        <CollabResultToast
          result={{ tone: "success", title: "已加入「元气松鼠项目111」", body: "项目已出现在左侧列表中" }}
          onDismiss={onDismiss}
        />
      </I18nProvider>
    );

    const card = document.querySelector(".collab-result-toast");
    expect(card?.className).toContain("collab-result-toast--success");
    // 结果卡在页面根部、正文之上：关掉弹窗后它仍留在屏幕上。
    expect(card?.parentElement).toBe(document.body);
    expect(card?.textContent).toContain("已加入「元气松鼠项目111」");
    expect(card?.textContent).toContain("项目已出现在左侧列表中");
  });

  it("dismisses itself after five seconds and on the close button", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    mount(
      <I18nProvider>
        <CollabResultToast result={{ tone: "success", title: "已提交申请，等待项目成员通过" }} onDismiss={onDismiss} />
      </I18nProvider>
    );

    act(() => vi.advanceTimersByTime(4_999));
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onDismiss).toHaveBeenCalledTimes(1);

    const close = document.querySelector<HTMLButtonElement>(".collab-result-toast__close");
    act(() => close?.click());
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });
});
