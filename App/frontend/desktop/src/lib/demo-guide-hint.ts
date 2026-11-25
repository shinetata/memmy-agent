/**
 * 新手引导第二步的「执行提示」不该出现在任何读得到文字的地方。
 *
 * 从前引导会让 Agent 去调 `memmy-project assist ask`，那句话发送时后面会追加一段给 Agent 的执行提示。
 * 现在第二步由引导直接发请求、不再拼提示，但历史里已经发出去的那几条仍然带着它：提示对人没有意义，
 * 它写的是命令行、参数与「不要先反问」这类给模型的叮嘱，出现在自己的气泡、任务摘要或成员看到的
 * 只读副本里都不像话。
 *
 * 会话记录与云端副本里仍是原文，只在显示时去掉：这样历史里那几条也会一起变干净，不必等用户重发。
 */

/** 提示的开头，按语言分别认：句子后面跟两个换行，然后是这段。 */
const HINT_MARKERS = ["（执行提示：", "(Execution note:"];

/**
 * 去掉正文末尾的执行提示，只留人自己写（或引导预填）的那句话。
 *
 * 只在标记之前还有内容时才截断：整条消息就是提示的话返回空串，调用方据此不画气泡。
 * 标记出现在中间时也截到标记为止——提示总是追加在最后，后面再出现别的内容说明这条消息被人手工改过，
 * 那时保留后半段更容易看出他写了什么。
 */
export function withoutDemoGuideHint(text: string): string {
  if (!text) return text;
  let cut = -1;
  for (const marker of HINT_MARKERS) {
    const at = text.indexOf(marker);
    if (at >= 0 && (cut < 0 || at < cut)) cut = at;
  }
  if (cut < 0) return text;
  return text.slice(0, cut).trimEnd();
}

/** 这条消息是不是只有执行提示（剥掉之后什么都不剩）：这种消息不画气泡。 */
export function isOnlyDemoGuideHint(text: string): boolean {
  return text.trim().length > 0 && withoutDemoGuideHint(text).trim().length === 0;
}
