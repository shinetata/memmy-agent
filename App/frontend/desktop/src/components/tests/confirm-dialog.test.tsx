/** Confirm dialog tests. */
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConfirmDialog } from "../confirm-dialog.js";

describe("ConfirmDialog", () => {
  it("renders the shared titleless confirmation layout", () => {
    const html = renderToString(
      <ConfirmDialog
        open
        message="永久删除已归档对话？"
        cancelLabel="取消"
        confirmLabel="确定"
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('class="modal-backdrop"');
    expect(html).toContain("confirm-dialog");
    expect(html).not.toContain('alt="Memmy"');
    expect(html).toContain("width:360px");
    expect(html).toContain("max-width:calc(100vw - 32px)");
    expect(html).toContain("min-height:180px");
    expect(html).toContain("max-height:max(72px, min(220px, calc(100dvh - 220px)))");
    expect(html).toContain("button button-soft button-sm");
    expect(html).toContain("button button-primary button-sm");
    expect(html).not.toContain("button button-danger button-sm");
    expect(html).toContain("confirm-dialog__footer");
    expect(html).not.toContain("grid grid-cols-2");
    expect(html).toContain("永久删除已归档对话？");
    expect(html).toContain(">取消</button>");
    expect(html).toContain(">确定</button>");
    expect(html).not.toContain("<h1");
    expect(html).not.toContain("<h2");
    expect(html).not.toContain("<h3");
  });

  it("shows why the action failed without closing the dialog", () => {
    // 失败的理由写在正文下面，弹窗本身不关：这一步没做成，人还在这里就能看到原因。
    const html = renderToString(
      <ConfirmDialog
        open
        title="移除项目"
        message="移除“Memmy项目协作开发”并永久删除其中的 2 个任务？"
        cancelLabel="取消"
        confirmLabel="移除"
        error="先停止共享，再移除这个项目"
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("confirm-dialog__error");
    expect(html).toContain("先停止共享，再移除这个项目");
    expect(html).toContain("移除“Memmy项目协作开发”并永久删除其中的 2 个任务？");
  });

  it("keeps the dialog body free of an error element when nothing failed", () => {
    const html = renderToString(
      <ConfirmDialog
        open
        message="永久删除已归档对话？"
        cancelLabel="取消"
        confirmLabel="确定"
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />
    );

    expect(html).not.toContain("confirm-dialog__error");
  });

  it("does not render when closed", () => {
    expect(renderToString(
      <ConfirmDialog
        open={false}
        message="不会显示"
        cancelLabel="取消"
        confirmLabel="确定"
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />
    )).toBe("");
  });

  it("allows callers to configure sizing without changing the shared layout", () => {
    const html = renderToString(
      <ConfirmDialog
        open
        message="较长内容"
        cancelLabel="取消"
        confirmLabel="删除"
        width={288}
        maxWidth="90vw"
        contentMaxHeight={128}
        buttonMinWidth={88}
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />
    );

    expect(html).toContain("max-width:90vw");
    expect(html).toContain("width:288px");
    expect(html).toContain("max-height:128px");
    expect(html).toContain("min-width:88px");
    expect(html).toContain("button button-primary button-sm");
    expect(html).not.toContain("button button-danger button-sm");
  });

  it("allows a themed danger confirm button for destructive actions", () => {
    const html = renderToString(
      <ConfirmDialog
        open
        message="确定要删除已归档会话「测试」吗？"
        cancelLabel="取消"
        confirmLabel="确定"
        confirmVariant="danger"
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />
    );

    expect(html).toContain("button button-danger button-sm");
    expect(html).not.toContain("button button-primary button-sm");
  });

  it("allows required confirmations without a cancel action", () => {
    const html = renderToString(
      <ConfirmDialog
        open
        message="必须更新后才能继续"
        confirmLabel="立即更新"
        onConfirm={() => undefined}
      />
    );

    expect(html).toContain(">立即更新</button>");
    expect(html).toContain("button button-primary button-sm");
    expect(html).not.toContain("button button-soft button-sm");
    expect(html).not.toContain(">取消</button>");
  });

  it("renders a centered optional icon when configured", () => {
    const html = renderToString(
      <ConfirmDialog
        open
        message="带图标内容"
        cancelLabel="取消"
        confirmLabel="确定"
        iconPose="neutral"
        iconContainerSize={44}
        iconSize={36}
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />
    );

    expect(html).toContain('alt="Memmy"');
    expect(html).toContain("confirm-dialog__icon");
    expect(html).toContain("height:44px;width:44px");
    expect(html).toContain("width:36px");
    expect(html).toContain("height:auto");
  });

  it("renders an optional visible title with a header close button and ghost cancel action", () => {
    const html = renderToString(
      <ConfirmDialog
        open
        title="删除已归档对话？"
        message="确定要删除已归档对话「测试」吗？"
        cancelLabel="取消"
        closeLabel="关闭"
        confirmLabel="确定"
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />
    );

    expect(html).toContain("<h2");
    expect(html).toContain("删除已归档对话？");
    expect(html).toContain("确定要删除已归档对话「测试」吗？");
    expect(html).toContain("confirm-dialog--titled");
    expect(html).toContain("min-height:152px");
    expect(html).toContain('aria-label="关闭"');
    expect(html).toContain("button button-ghost button-sm");
    expect(html).not.toContain("button button-soft button-sm");
    expect(html).not.toContain('alt="Memmy"');
  });
});
