/**
 * 看板上与「人」有关的文字：任务行的摘要。
 *
 * 摘要的问题来自 Cursor / Codex：它们把「任务完成」这类通知当成一轮写进会话，云端早先按最后一轮存摘要，
 * 任务行于是显示成一串 `<timestamp>`、`<system_notification>` 标签。云端现在生成摘要时跳过这些轮次，
 * 这里兜住升级前上传的旧记录：识别到通知就返回空串，调用方退回标题或干脆不显示。
 */
import { withoutDemoGuideHint } from "../lib/demo-guide-hint.js";

const NOTIFICATION_TURN_PREFIXES = ["<timestamp>", "<system_notification>", "<task>"];

/** 可读的任务摘要；整条都是 Agent 通知时返回空串。 */
export function readableSummary(lastQuestion: string): string {
  // 新手引导第二步发出去的那句话带着一段给 Agent 的执行提示：摘要里只留人自己那句话。
  const text = withoutDemoGuideHint(lastQuestion).trim();

  if (!text) return "";
  const head = text.toLowerCase();

  return NOTIFICATION_TURN_PREFIXES.some((prefix) => head.startsWith(prefix)) ? "" : text;
}
