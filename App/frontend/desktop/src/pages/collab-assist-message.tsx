/**
 * 成员协助在消息流里的两张卡片。
 *
 * 协助相关的两条消息由 Memmy 自己写进任务，正文包在标签里：
 * - `<memmy_assist_request>`：执行方任务的第一条消息（及同一次排查的后续请求），显示成请求卡片——
 *   谁的哪个 Agent 请求、第几次、背景、要做的事。交给模型的格式要求不在这条消息里。
 * - `<memmy_assist_result>`：结果回来后送回发起方任务的那条消息，显示成结果卡片。
 *
 * 模型读到的是完整原文；界面只把它换成卡片，不改写消息本身。
 */
import { useState, type ReactNode } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, CircleAlert } from "lucide-react";
import type { AssistRequest } from "../api/collab-client.js";
import type { MessageKey } from "../i18n/messages.js";
import { useTranslation } from "../i18n/use-translation.js";
import { AssistAgentLogo, assistAgentName, assistClock, assistDuration, grantDurationLabel } from "./collab-assist-view.js";
import { AssistItems } from "./collab-assist-items.js";
import { readAssistRequestBody, readAssistResultBody, type AssistEnvelope } from "./collab-assist-protocol.js";

export { parseAssistEnvelope, type AssistEnvelope } from "./collab-assist-protocol.js";
import styles from "./collab-assist-task.module.css";

/**
 * 结果卡片额外要的东西：这一次请求本身（算「用时」与授权方式）与执行过程（由调用方建好传进来，
 * 因为执行过程要读协助详情，只有任务页知道客户端）。
 */
type Translate = (key: MessageKey, values?: Record<string, string>) => string;

export interface AssistResultExtra {
  request: AssistRequest;
  process?: ReactNode;
}

export function AssistMessageCard(props: { envelope: AssistEnvelope; result?: AssistResultExtra | null }) {
  return props.envelope.kind === "request"
    ? <AssistRequestMessage envelope={props.envelope} />
    : <AssistResultMessage envelope={props.envelope} result={props.result ?? null} />;
}

/**
 * 接收方看到的那条协助请求：不再画卡片，换成一段可以直接放进标准会话气泡的 Markdown。
 * 输入框上方的胶囊已经写着「谁的哪个 Agent 请求」，气泡里只留请求本身：背景与要做的事。
 */
export function assistRequestBubbleText(envelope: AssistEnvelope, t: Translate): string {
  const { attrs, lines } = envelope;
  const body = readAssistRequestBody(lines);
  const name = attrs.from ?? "";
  const attempt = Number.parseInt(attrs.attempt ?? "1", 10) || 1;
  const parts: string[] = [];
  parts.push(attempt > 1
    ? t("collab.assist.bubbleTitleAgain", { name, attempt: String(attempt) })
    : t("collab.assist.bubbleTitle", { name }));
  if (body.reason) parts.push("", `${t("collab.assist.bubbleReason")}${body.reason}`);
  parts.push("", t("collab.assist.cardTodo"));
  if (body.title) parts.push(body.title);
  body.items.forEach((item, index) => parts.push(`${index + 1}. ${item}`));
  return parts.join("\n");
}

function AssistRequestMessage(props: { envelope: AssistEnvelope }) {
  const { t } = useTranslation();
  const { attrs, lines } = props.envelope;
  const body = readAssistRequestBody(lines);
  const name = attrs.from ?? "";
  const attempt = Number.parseInt(attrs.attempt ?? "1", 10) || 1;
  return (
    <div className={styles.request} data-collab-assist-request="">
      <div className={styles.requestHead}>
        <span className={styles.avatar} style={{ background: "var(--color-action-sky, #5cbfae)" }}>{Array.from(name)[0] ?? ""}</span>
        <strong>{t("collab.assist.requestFrom", { name, via: attrs.via ?? "Memmy" })}</strong>
        {attempt > 1 ? <span>· {t("collab.assist.attemptLabel", { attempt: String(attempt) })}</span> : null}
      </div>
      <div className={styles.requestBody}>
        {body.reason ? (
          <p className={styles.requestReason}>
            <span className={styles.requestReasonKey}>{t("collab.assist.reasonKey")}</span>
            {body.reason}
          </p>
        ) : null}
        <div className={styles.requestKey}>{t("collab.assist.cardTodo")}</div>
        {body.title ? <p>{body.title}</p> : null}
        <AssistItems items={body.items} />
      </div>
    </div>
  );
}

/** 正文超过这么多字时先收起：逐项结果已经给出要点，正文按需展开。 */
const REPLY_PREVIEW_CHARS = 280;

function AssistResultMessage(props: { envelope: AssistEnvelope; result: AssistResultExtra | null }) {
  const { t } = useTranslation();
  // 正文太长时先收起；整张卡片另外可以整体收起（段头那一下）。
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const { attrs, lines } = props.envelope;
  const done = attrs.status === "done";
  const body = readAssistResultBody(lines);
  const name = attrs.from ?? "";
  const agent = attrs.agent ?? "";
  const sourceId = agentSourceIdOf(agent);
  // 「用时 9 秒 · 30 分钟内直接执行（到 15:50）」：这一段原来写在请求卡片底部，结果回写后归到结果这一侧。
  const ran = props.result ? runMeta(props.result.request, t) : "";
  return (
    <div className={styles.request} data-collab-assist-result="">
      <button
        type="button"
        className={styles.requestHead}
        aria-expanded={expanded}
        data-collab-assist-toggle=""
        onClick={() => setExpanded((value) => !value)}
      >
        {done ? <CheckCircle2 size={14} aria-hidden="true" /> : <CircleAlert size={14} aria-hidden="true" />}
        {agent ? (
          <AssistAgentLogo agent={sourceId} name={agent} className={styles.agentLogo} markClassName={styles.agentMark} />
        ) : null}
        <strong>
          {done
            ? t("collab.assist.resultDone", { name, agent: agent || assistAgentName(null, t("collab.assist.executorFallback")) })
            : t("collab.assist.resultNotDone", { name })}
        </strong>
        <span className={styles.grow} />
        <span>{attrs.title}</span>
        {expanded ? <ChevronDown size={13} aria-hidden="true" className={styles.headCaret} />
          : <ChevronRight size={13} aria-hidden="true" className={styles.headCaret} />}
      </button>
      {expanded ? (
      <div className={styles.requestBody}>
        {body.reply ? (
          <p className={styles.resultText}>
            {open || body.reply.length <= REPLY_PREVIEW_CHARS ? body.reply : `${body.reply.slice(0, REPLY_PREVIEW_CHARS)}…`}
            {body.reply.length > REPLY_PREVIEW_CHARS ? (
              <button type="button" className={styles.inlineToggle} onClick={() => setOpen((value) => !value)}>
                {open ? t("collab.assist.collapse") : t("collab.assist.detail.expand")}
              </button>
            ) : null}
          </p>
        ) : null}
        {body.items.length ? (
          <dl className={styles.resultRows}>
            {body.items.map((item) => (
              <div key={`${item.key}-${item.value}`}>
                <dt>{item.key}</dt>
                <dd>{item.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {done ? <div className={styles.requestKey}>{t("collab.assist.resultSource", { name })}</div> : null}
        {ran ? <p className={styles.ran} data-collab-assist-ran="">{ran}</p> : null}
        {props.result?.process}
      </div>
      ) : null}
    </div>
  );
}

/**
 * 这次执行的时间：用时与授权方式。「30 分钟内直接执行（到 15:50）」按当时给的授权算，
 * 不随授权过期变成「已结束」——它记的是这一次怎么跑的。
 */
function runMeta(request: AssistRequest, t: Translate): string {
  const parts: string[] = [];
  const took = assistDuration(request, t);
  if (took) parts.push(t("collab.assist.ranFor", { took }));
  if (request.scope === "timed" && request.decidedMinutes && request.decidedAt) {
    const until = new Date(Date.parse(request.decidedAt) + request.decidedMinutes * 60_000).toISOString();
    parts.push(t("collab.assist.grantTimed", {
      duration: grantDurationLabel(request.decidedMinutes, t),
      time: assistClock(until, true)
    }));
  }
  return parts.join(" · ");
}

/** 结果里写的是 Agent 的名字：换回标识以便取图标。 */
export function agentSourceIdOf(name: string): string | null {
  const ids: Record<string, string> = {
    Memmy: "memmy",
    "Claude Code": "claude_code",
    Codex: "codex",
    Cursor: "cursor",
    OpenCode: "opencode",
    OpenClaw: "openclaw",
    Hermes: "hermes",
    WorkBuddy: "workbuddy",
    QwenWork: "qwenwork",
    "DeepSeek Harness": "deepseek_harness",
    Pi: "pi"
  };
  return ids[name] ?? null;
}
