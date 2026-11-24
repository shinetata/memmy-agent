/**
 * 一次性结果卡：加入成功、申请未通过、申请已提交。顶部水平居中、图标 + 主行 + 副行。
 *
 * 与右上角的通知栈分工不同：通知栈留给需要人处理的事（协助请求、操作失败），
 * 这里只报一个已经发生、看完就走的结果，所以放在视线正上方、给足停留时间，也不带动作。
 */
import { AlertTriangle, CheckCircle2, X } from "lucide-react";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "../i18n/use-translation.js";

export type CollabResultTone = "success" | "warning";

export interface CollabResult {
  tone: CollabResultTone;
  /** 主行：一句话说清结果。 */
  title: string;
  /** 副行：接下来会发生什么，或下一步能做什么。 */
  body?: string;
}

/** 结果卡停留时间：比操作提示长，读完一句主行加一句副行不需要抢。 */
export const COLLAB_RESULT_MS = 5_000;

const TONE_ICONS = {
  success: CheckCircle2,
  warning: AlertTriangle
} as const;

export function CollabResultToast(props: {
  result: CollabResult;
  onDismiss: () => void;
  durationMs?: number;
}) {
  const { t } = useTranslation();
  const durationMs = props.durationMs ?? COLLAB_RESULT_MS;
  const Icon = TONE_ICONS[props.result.tone];

  useEffect(() => {
    const timer = window.setTimeout(props.onDismiss, durationMs);
    return () => window.clearTimeout(timer);
  }, [durationMs, props.onDismiss, props.result.title, props.result.body]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className={`collab-result-toast collab-result-toast--${props.result.tone}`}
      role="status"
      aria-live="polite"
    >
      <span className="collab-result-toast__badge" aria-hidden="true">
        <Icon size={16} strokeWidth={2.2} />
      </span>
      <div className="collab-result-toast__content">
        <p className="collab-result-toast__title">{props.result.title}</p>
        {props.result.body ? <p className="collab-result-toast__body">{props.result.body}</p> : null}
      </div>
      <button
        type="button"
        className="collab-result-toast__close"
        aria-label={t("common.close")}
        onClick={props.onDismiss}
      >
        <X size={14} strokeWidth={2.2} aria-hidden="true" />
      </button>
    </div>,
    document.body
  );
}
