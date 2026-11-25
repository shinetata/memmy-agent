/**
 * 发起方的协助请求卡片：请谁做了什么、现在到哪一步、结果是什么。
 *
 * 卡片只读：状态与结果都来自云端，本机不做二次加工。结果对发起方的 Agent 是数据而不是指令，
 * 展示时也按「结果」这一栏排，不拼进对话正文。
 */
import { AlertCircle, ChevronDown, ChevronRight, FileText, HandHelping, X, WifiOff } from "lucide-react";
import { useState } from "react";
import type { AssistRequest, CollabClient } from "../api/collab-client.js";
import { useTranslation } from "../i18n/use-translation.js";
import styles from "./collab-assist-card.module.css";
import { assistClock, assistStopText, grantSummary } from "./collab-assist-view.js";

/**
 * 发起方的协助请求卡片。
 *
 * 两种用法：`dock`（输入框上方的固定位置，旧的用法）与 `flow`（排在会话里，与结果卡片前后相接）。
 * `flow` 下不再重复结果——结果由会话里那张结果卡片负责，这里只说请求本身与执行过程。
 */
export function CollabAssistRequestCard(props: {
  request: AssistRequest;
  collab: CollabClient | null;
  onChanged?: (request: AssistRequest) => void;
  variant?: "dock" | "flow";
}) {
  const { t } = useTranslation();
  const { request } = props;
  const [busy, setBusy] = useState(false);
  // 整张卡片可收起：会话里一次协助连着请求、结果与执行过程，全部摊开会把正文挤走。
  const [open, setOpen] = useState(true);
  const executor = request.executor.name;
  const agentName = agentLabel(request.agent, t("collab.assist.executorFallback"));
  const status = request.status;
  // 对方给了限时授权：与看板详情同一句「1 小时内直接执行（到 08:45）」，让发起方知道这段时间里的请求不再等她授权。
  const grantNote = request.scope === "timed" && request.grant ? ` · ${grantSummary(request.grant, t)}` : "";

  const pill = status === "done" ? { className: styles.pillOk, label: t("collab.assist.statusDone") }
    : status === "running" ? { className: styles.pillRun, label: t("collab.assist.statusRunning") }
    : status === "confirm" ? { className: styles.pillWarn, label: t("collab.assist.statusConfirm", { name: executor }) }
    : status === "rejected" ? { className: styles.pillErr, label: t("collab.assist.statusRejected", { name: executor }) }
    : status === "failed" ? { className: styles.pillErr, label: t("collab.assist.statusFailed") }
    // 停下与失败分开说：本人或对方主动停下的，写「已停止」而不是「没有完成」。
    : status === "stopped" ? { className: styles.pillErr, label: t("collab.assist.state.stopped") }
    : status === "cancelled" || status === "expired" ? { className: styles.pillWait, label: t("collab.assist.statusClosed") }
    // 她的限时授权还在：不是在等她授权，她的 Memmy 会直接开始。
    : request.autoRun ? { className: styles.pillRun, label: t("collab.assist.state.autoRun") }
    : { className: styles.pillWait, label: t("collab.assist.statusWaiting", { name: executor }) };
  const plannedAgent = agentLabel(request.grant?.agent ?? request.agent, t("collab.assist.executorFallback"));

  async function cancel() {
    if (!props.collab || busy) return;
    setBusy(true);
    try {
      const next = await props.collab.cancelAssist(request.id).catch(() => null);
      // 已经结束（对方刚好跑完）：不报错，读取最新的一次让卡片自己回到终态。
      const latest = next ?? await props.collab.assistRequest(request.id).catch(() => null);
      if (latest) props.onChanged?.(latest);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={`${styles.card} ${props.variant === "flow" ? styles.cardFlow : ""} ${status === "confirm" ? styles.cardWarning : ""}`}
      data-collab-assist-flow-request={props.variant === "flow" ? "" : undefined}
    >
      {/*
       * 排在过程里时与其它过程行同一种排法：图标 + 动词 + 一行说明 + chevron，
       * 用的是过程行自己的 class（`agent-activity-timeline-item`），字号、颜色、行高都跟着它走。
       */}
      <button
        type="button"
        className={props.variant === "flow" ? "agent-activity-tool-details__summary" : styles.head}
        aria-expanded={open}
        data-collab-assist-toggle=""
        onClick={() => setOpen((value) => !value)}
      >
        {props.variant === "flow" ? (
          <HandHelping size={13} aria-hidden="true" className="agent-activity-timeline-item__icon" />
        ) : (
          <span className={styles.avatar} style={{ background: memberColor(request.executor.userId) }}>
            {Array.from(executor)[0] ?? ""}
          </span>
        )}
        {props.variant === "flow" ? (
          <div className="agent-activity-timeline-item__body">
            <p className="agent-activity-timeline-item__line">
              <span className="agent-activity-timeline-item__verb">{t("collab.assist.cardTitle", { name: executor })}</span>
              <span className="agent-activity-timeline-item__detail" data-collab-assist-state={status}>{pill.label}</span>
            </p>
          </div>
        ) : (
          <>
            <span className={styles.title}>{t("collab.assist.cardTitle", { name: executor })}</span>
            <span className={styles.project}>{request.projectName}</span>
            <span className={styles.grow} />
            <span className={styles.stateText} data-collab-assist-state={status}>{pill.label}</span>
          </>
        )}
        {props.variant === "flow" ? (
          <ChevronRight
            size={12}
            aria-hidden="true"
            className={`agent-activity-tool-details__chevron${open ? " agent-activity-tool-details__chevron--open" : ""}`}
          />
        ) : open ? <ChevronDown size={13} aria-hidden="true" className={styles.headCaret} />
          : <ChevronRight size={13} aria-hidden="true" className={styles.headCaret} />}
      </button>

      {open ? (
      <div className={props.variant === "flow" ? `agent-activity-tool-card ${styles.flowCard}` : styles.body}>
        <div className={props.variant === "flow" ? "agent-activity-tool-card__section" : undefined}>
        {request.reason ? (
          <p className={styles.reason}>
            <span className={styles.reasonKey}>{t("collab.assist.reasonKey")}</span>
            {request.reason}
          </p>
        ) : null}
        <div className={styles.key}>{t("collab.assist.cardTodo")}</div>
        <ol>
          {request.items.map((item) => <li key={item}>{item}</li>)}
        </ol>
        {status === "done" && props.variant !== "flow" ? (
          <>
            <div className={styles.key}>{t("collab.assist.cardResult")}</div>
            <div className={styles.results}>
              {request.resultItems.length ? request.resultItems.map((item) => (
                <div className={styles.resultRow} key={item.key}>
                  <span className={styles.resultKey}>{item.key}</span>
                  <span className={styles.resultValue}>{item.value}</span>
                </div>
              )) : (
                <div className={styles.resultRow}>
                  <span className={styles.resultValue}>{request.reply}</span>
                </div>
              )}
            </div>
            {/* 执行时按协助规则跳过的操作：与逐项结果同一套列表样式，写在结果下面。 */}
            {request.safety?.skipped?.length ? (
              <>
                <div className={styles.key}>{t("collab.assist.skippedTitle")}</div>
                <ul className={styles.skipped}>
                  {request.safety.skipped.map((item) => (
                    <li key={`${item.title}-${item.detail ?? ""}`}>
                      {item.title}
                      {item.detail ? <span className={styles.skippedDetail}>{item.detail}</span> : null}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {request.files.length ? (
              <div className={styles.files}>
                {request.files.map((file) => (
                  <span className={styles.fileChip} key={file.name}>
                    <FileText size={12} aria-hidden="true" />
                    {file.name}
                    <span className={styles.fileSize}>{file.size}</span>
                  </span>
                ))}
              </div>
            ) : null}
          </>
        ) : null}
        </div>
      </div>
      ) : null}

      {open && status !== "done" ? (
      <div className={styles.footer}>
        {status === "pending" ? (
          <>
            <span className={styles.spin} />
            {/* 她不在线时不写「已通知」：她打开 Memmy 之前看不到，按限时授权也要等她上线后才执行。
                她的 Memmy 检查后要求她确认时，说明为什么——不要写成「会直接执行」。 */}
            {!request.autoRun && request.safety?.executor && request.safety.executor.status !== "auto" ? (
              t("collab.assist.footerReviewConfirm", {
                name: executor,
                reason: request.safety.executor.reason ?? t("collab.assist.reviewUnavailable")
              })
            ) : request.autoRun && request.grant
              ? t(request.executorOffline ? "collab.assist.footerAutoRunOffline" : "collab.assist.footerAutoRun",
                { name: executor, agent: plannedAgent, time: assistClock(request.grant.expiresAt, true) })
              : t(request.executorOffline ? "collab.assist.footerOffline" : "collab.assist.footerWaiting", { name: executor })}
            <span className={styles.grow} />
            <button type="button" className={`${styles.linkButton} ${styles.linkMuted}`} disabled={busy} onClick={() => void cancel()}>
              {t("collab.assist.withdraw")}
            </button>
          </>
        ) : status === "running" ? (
          <>
            <span className={styles.spin} />
            {/*
             * 不摆执行 Agent 的图标：这行已经写着「孙起的 Memmy 正在执行」，图标是同一件事的重复；
             * 同一张卡片上的组头、结果里都有它，多摆一处只是噪音。
             */}
            <span className={styles.byline}>
              {t("collab.assist.footerRunning", { name: executor, agent: agentName })}{grantNote}
            </span>
            {/* 执行中也能自己停下：同位置同样式，不另弹确认。 */}
            <span className={styles.grow} />
            <button type="button" className={`${styles.linkButton} ${styles.linkMuted}`} disabled={busy} onClick={() => void cancel()}>
              {t("collab.assist.stop")}
            </button>
          </>
        ) : status === "confirm" ? (
          <>
            <AlertCircle size={13} aria-hidden="true" />
            {t(request.executorOffline ? "collab.assist.footerConfirmOffline" : "collab.assist.footerConfirm", { name: executor })}
            <span className={styles.grow} />
            <button type="button" className={`${styles.linkButton} ${styles.linkMuted}`} disabled={busy} onClick={() => void cancel()}>
              {t("collab.assist.withdraw")}
            </button>
          </>
        ) : status === "rejected" ? (
          <>
            <X size={13} aria-hidden="true" />
            {/* 她关闭了接收协助请求时，等待中的请求以这个原因结束：照原因说。 */}
            {request.failure ?? t("collab.assist.footerRejected", { name: executor })}
          </>
        ) : status === "stopped" ? (
          <>
            <WifiOff size={13} aria-hidden="true" />
            {/* 谁停的都写清楚：本人停的就是「你停止了这次执行」。 */}
            {assistStopText(request, t)}
          </>
        ) : (
          <>
            <WifiOff size={13} aria-hidden="true" />
            {request.failure ?? (status === "expired"
              ? t("collab.assist.footerExpired", { name: executor })
              : t("collab.assist.footerClosed"))}
          </>
        )}
      </div>
      ) : null}
    </div>
  );
}

/** 执行方标识换成名字：卡片上只显示名字，标识留在接口里。 */
export function agentLabel(sourceId: string | null, fallback: string): string {
  const names: Record<string, string> = {
    memmy: "Memmy",
    claude_code: "Claude Code",
    codex: "Codex",
    cursor: "Cursor",
    opencode: "OpenCode",
    openclaw: "OpenClaw",
    hermes: "Hermes",
    workbuddy: "WorkBuddy",
    qwenwork: "QwenWork",
    deepseek_harness: "DeepSeek Harness",
    pi: "Pi"
  };
  return sourceId ? names[sourceId] ?? sourceId : fallback;
}

function memberColor(userId: string): string {
  const palette = ["#3aa893", "#e08a5a", "#7a8ee0", "#c98ac0", "#58a6c9", "#c9a227"];
  let sum = 0;
  for (const char of userId) sum += char.charCodeAt(0);
  return palette[sum % palette.length]!;
}