/**
 * 成员协助的授权弹窗。
 *
 * 默认选中上次为该成员使用的可用 Agent，授权范围默认为仅这一次。
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AlertCircle, ChevronDown, X } from "lucide-react";
import type {
  AssistAgent,
  AssistGrantMinutes,
  AssistInboxItem,
  AssistRequest,
  AssistSafety,
  AssistScope,
  CollabClient
} from "../api/collab-client.js";
import { Button } from "../components/button.js";
import { Modal } from "../components/modal.js";
import { Select } from "../components/Select.js";
import { useTranslation } from "../i18n/use-translation.js";
import { agentSourceSquareLogoUrl } from "./agent-source-logos.js";
import { AssistAttachments } from "./collab-assist-attachments.js";
import { AssistItems } from "./collab-assist-items.js";
import { DEFAULT_GRANT_MINUTES, GrantDurationPicker, assistReviewLine, assistWaitedText, grantDurationLabel } from "./collab-assist-view.js";
import projectStyles from "./collab-page.module.css";
import styles from "./collab-assist-dialog.module.css";

export function CollabAssistDialog(props: {
  open: boolean;
  /** 收到的那条请求：谁发的、要做的事、来自哪个项目。 */
  request: AssistInboxItem | null;
  /**
   * 这条请求最新的安全检查：宿主每次轮询收件箱都传进来。审查在弹窗打开之后才完成时，
   * 原因行靠它出现；`request` 对象保持不变，她在这里做的选择不会被重置。
   */
  safety?: AssistSafety | null;
  collab: CollabClient | null;
  /** 她做完选择：允许时带上 Agent 与授权方式（限时带时长），拒绝时只有 action。 */
  onDecided: (decision: { action: "allow" | "reject"; agent?: string; scope?: AssistScope; minutes?: AssistGrantMinutes }) => Promise<void> | void;
  /** 新手引导的演示中：弹窗是亮区、「允许」是描边目标，弹窗自己的遮罩让给引导遮罩。 */
  demoAnchor?: boolean;
  /** 关闭弹窗，等于这次先不做选择：请求仍在收件箱里等她。 */
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const scopeId = useId();
  const [agents, setAgents] = useState<AssistAgent[] | null>(null);
  const [agent, setAgent] = useState<string | null>(null);
  const [scope, setScope] = useState<AssistScope>("once");
  const [minutes, setMinutes] = useState<AssistGrantMinutes>(DEFAULT_GRANT_MINUTES);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 收件箱不带附件正文：拿到带正文的详情后替换显示用的请求。 */
  const [detail, setDetail] = useState<AssistRequest | null>(null);
  const durationRef = useRef<HTMLDivElement | null>(null);
  const { collab, open, request } = props;
  const options = useMemo(() => (agents ?? []).map((item) => {
    const logo = agentSourceSquareLogoUrl(item.sourceId);
    return {
      value: item.sourceId,
      label: item.name,
      icon: logo
        ? <img className={styles.agentLogo} src={logo} alt="" />
        : <span className={styles.agentMark}>{Array.from(item.name)[0] ?? "A"}</span>
    };
  }), [agents]);

  // 短窗口中，把新展开的时长滚进可见区域。
  useEffect(() => {
    if (scope === "timed") durationRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [scope]);

  useEffect(() => {
    if (!open || !collab || !request) return;
    let cancelled = false;
    setAgents(null);
    setAgent(null);
    setScope("once");
    setMinutes(DEFAULT_GRANT_MINUTES);
    setBusy(false);
    setError(null);
    void collab.assistAgents(request.projectId, request.requester.userId)
      .then((choice) => {
        if (cancelled) return;
        const usable = choice.agents.filter((item) => item.available);
        setAgents(usable);
        const preferred = usable.find((item) => item.sourceId === choice.defaultAgent) ?? usable[0] ?? null;
        setAgent(preferred?.sourceId ?? null);
      })
      .catch(() => {
        if (!cancelled) setAgents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [collab, open, request]);

  // 收件箱里的请求不带附件正文：弹窗打开时按需拉一次详情。拉不到就不显示附件区，不弹错误打扰她。
  useEffect(() => {
    setDetail(null);
    if (!open || !collab || !request || request.attachments !== null) return;
    let cancelled = false;
    void collab.assistRequest(request.id, { withAttachments: true })
      .then((full) => {
        if (!cancelled) setDetail(full);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [collab, open, request]);

  if (!request) return null;
  const shown = detail && detail.id === request.id ? detail : request;
  const attachments = shown.attachments ?? [];
  const requester = request.requester.name;
  const title = t("collab.assist.title", { name: requester });
  const chosen = agents?.find((item) => item.sourceId === agent) ?? null;
  const agentName = chosen?.name ?? t("collab.assist.executorFallback");
  const waited = assistWaitedText(request.waitingSeconds, t);
  // 宿主传进来的是最新的一份，详情是为附件拉的、可能比收件箱晚一步：哪份有结论就用哪份。
  const safety = props.safety?.executor ? props.safety : shown.safety;
  const reviewLine = assistReviewLine({ safety }, t);
  const detailsLabel = attachments.length
    ? shown.reason ? t("collab.assist.dialog.backgroundAndAttachments") : t("collab.assist.dialog.viewAttachments")
    : t("collab.assist.dialog.background");

  async function submit(action: "allow" | "reject") {
    if (busy) return;
    if (action === "allow" && !agent) return;
    setBusy(true);
    setError(null);
    try {
      await props.onDecided({
        action,
        ...(action === "allow" && agent ? { agent, scope, ...(scope === "timed" ? { minutes } : {}) } : {})
      });
    } catch {
      setError(t("collab.assist.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title={title}
      showHeader={false}
      onClose={busy ? undefined : props.onClose}
      closeLabel={t("common.close")}
      className={styles.dialog}
      bodyClassName={styles.body}
      footerClassName={styles.footer}
      backdropClassName={props.demoAnchor ? `${styles.backdrop} ${styles.backdropYield}` : styles.backdrop}
      demoGuideAnchor={props.demoAnchor ? "assist-dialog" : undefined}
      footer={(
        <div className={projectStyles.footerButtons}>
          <Button
            variant="ghost"
            className={projectStyles.simpleCreateFooterButton}
            disabled={busy}
            onClick={() => void submit("reject")}
          >
            {t("collab.assist.reject")}
          </Button>
          <Button
            variant="primary"
            className={projectStyles.simpleCreateFooterButton}
            disabled={busy || !agent}
            data-demo-guide={props.demoAnchor ? "assist-allow" : undefined}
            onClick={() => void submit("allow")}
          >
            {scope === "timed"
              ? t("collab.assist.dialog.allowTimed", { duration: grantDurationLabel(minutes, t) })
              : t("collab.assist.dialog.allowOnce")}
          </Button>
        </div>
      )}
    >
      <header className={styles.header}>
        <span className={styles.avatar} aria-hidden="true">{Array.from(requester)[0]}</span>
        <div className={styles.requester}>
          <h2>{title}</h2>
          <p>{waited ? t("collab.assist.dialog.projectWaited", { project: request.projectName, waited }) : request.projectName}</p>
        </div>
        <button type="button" className={styles.close} onClick={props.onClose} disabled={busy} aria-label={t("collab.assist.dialog.postpone")}>
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      {reviewLine && (
        <p className={styles.review}>
          <AlertCircle size={16} aria-hidden="true" />
          <span>{reviewLine}</span>
        </p>
      )}
      <div className={styles.scroll}>
        <div className={styles.request} key={shown.id}>
          {shown.title && <h3>{shown.title}</h3>}
          <AssistItems items={shown.items} showSummary={false} />
          {(shown.reason || attachments.length > 0) && (
            <details className={styles.details}>
              <summary>
                <ChevronDown size={14} aria-hidden="true" />
                {detailsLabel}
                {attachments.length > 0 && (
                  <span className={styles.attachmentCount}>
                    · {t("collab.assist.dialog.attachmentCount", { count: String(attachments.length) })}
                  </span>
                )}
              </summary>
              <div className={styles.detailsBody}>
                {shown.reason && <p>{shown.reason}</p>}
                <AssistAttachments attachments={attachments} />
              </div>
            </details>
          )}
        </div>
        <div className={styles.settings}>
          <Select
            label={t("collab.assist.dialog.executor")}
            placeholder={t(agents === null ? "collab.assist.dialog.loading" : "collab.assist.dialog.noAgents")}
            value={agent ?? ""}
            options={options}
            onValueChange={setAgent}
            disabled={busy || options.length === 0}
            labelClassName={styles.fieldLabel}
            buttonClassName={styles.selectButton}
            menuClassName={styles.selectMenu}
          />
          <div>
            <span className={styles.fieldLabel} id={scopeId}>{t("collab.assist.dialog.scope")}</span>
            <div className={styles.scopes} role="radiogroup" aria-labelledby={scopeId}>
              <label>
                <input type="radio" name={scopeId} checked={scope === "once"} onChange={() => setScope("once")} disabled={busy} />
                <span>{t("collab.assist.scopeOnce")}</span>
              </label>
              <label>
                <input type="radio" name={scopeId} checked={scope === "timed"} onChange={() => setScope("timed")} disabled={busy} />
                <span>{t("collab.assist.dialog.timed")}</span>
              </label>
            </div>
          </div>
          {scope === "timed" && (
            <div className={styles.timed} ref={durationRef}>
              <div className={styles.duration}>
                <span>{t("collab.assist.dialog.duration")}</span>
                <GrantDurationPicker value={minutes} onChange={setMinutes} disabled={busy} />
              </div>
              <p>{t("collab.assist.dialog.timedDescription", { name: requester, agent: agentName })}</p>
            </div>
          )}
        </div>
        {error && <p className={styles.error} role="alert">{error}</p>}
      </div>
    </Modal>
  );
}
