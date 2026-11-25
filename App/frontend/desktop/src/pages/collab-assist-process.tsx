/**
 * 任务会话里的「执行过程」：不管对方用的是哪个 Agent，发起方在自己的 Memmy 任务里就能展开看对方执行的每一步，
 * 不必切到项目看板的协助记录。
 *
 * 数据只有一次协助的详情里才有（transcript 不在列表、收件箱与轮询里给），所以这里按需读、按次缓存：
 * 展开时才读，执行中每 3 秒重读一次，结束后读一次就够（结果回传时会把最后的过程一起写进去）。
 * 这一段只进界面、不进任务消息，模型读到的仍是结果那一条。
 */
import { ChevronRight, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { AssistRequest, AssistTranscriptItem, CollabClient } from "../api/collab-client.js";
import { useTranslation } from "../i18n/use-translation.js";
import { assistAgentName } from "./collab-assist-view.js";
import { TranscriptLine } from "./collab-assist-conversation.js";
import styles from "./collab-assist-task.module.css";

/** 执行中多久重读一次过程：与协助面板同一个节奏。 */
export const ASSIST_PROCESS_POLL_MS = 3_000;

/** 还在推进的状态：过程会继续变长，需要重读。 */
const LIVE_STATUS: ReadonlySet<AssistRequest["status"]> = new Set(["pending", "confirm", "running"]);

/**
 * 读一次请求的完整执行过程。`enabled` 为假时不发请求：折叠着的卡片不占带宽。
 * 读失败保留上一次的结果，只在界面上说明这一次没读到。
 */
export function useAssistTranscript(props: {
  collab: CollabClient | null;
  request: Pick<AssistRequest, "id" | "projectId" | "threadId" | "status">;
  enabled: boolean;
}): { items: AssistTranscriptItem[]; loading: boolean; failed: boolean } {
  const { collab, enabled } = props;
  const { id, projectId, threadId, status } = props.request;
  const live = LIVE_STATUS.has(status);
  const [items, setItems] = useState<AssistTranscriptItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const read = useCallback(async (): Promise<AssistTranscriptItem[] | null> => {
    if (!collab) return null;
    try {
      const detail = await collab.assistThread(projectId, threadId);
      const found = detail.thread.requests.find((item) => item.id === id);
      setFailed(false);
      return found?.transcript ?? [];
    } catch {
      setFailed(true);
      return null;
    }
  }, [collab, id, projectId, threadId]);

  useEffect(() => {
    if (!enabled || !collab) return;
    let cancelled = false;
    const load = async () => {
      const next = await read();
      if (cancelled) return;
      if (next !== null) setItems(next);
      setLoading(false);
    };
    setLoading(true);
    void load();
    if (!live) {
      return () => { cancelled = true; };
    }
    const timer = setInterval(() => {
      // 窗口不在前台时不刷新：与任务页其他轮询同一取舍。
      if (document.visibilityState === "visible") void load();
    }, ASSIST_PROCESS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [collab, enabled, live, read]);

  return { items, loading, failed };
}

/** 有过程可看的状态：等待受理的阶段不摆入口，免得展开后是一句「还没有」。 */
const PROCESS_STATUS: ReadonlySet<AssistRequest["status"]> = new Set(["running", "done", "failed", "stopped"]);

/**
 * 卡片里的执行过程：一行入口写着有几步，展开后按发生顺序列出说明、思考与工具调用。
 * 默认收起：它排在会话里，展开着会把模型正文挤到下面看不见；想看时点一下。
 */
export function AssistProcessBlock(props: { collab: CollabClient | null; request: AssistRequest; inline?: boolean }) {
  const { t } = useTranslation();
  const available = PROCESS_STATUS.has(props.request.status);
  /*
   * 标题写清「谁、用哪个 Agent」：这一段紧跟在发起方自己的「执行了 N 步」下面，
   * 只说「执行过程」会被读成发起方本机做的。成员名与 Agent 名都来自这次请求本身；
   * 对方还没选执行 Agent 时（执行前）退回通用说法，不显示成空白。
   */
  const executorName = props.request.executor?.name?.trim() ?? "";
  const executorAgent = assistAgentName(
    props.request.grant?.agent ?? props.request.agent,
    t("collab.assist.executorFallback")
  );
  const processTitle = executorName
    ? t("collab.assist.process.titleOnTheirMachine", { name: executorName, agent: executorAgent })
    : t("collab.assist.process.title");
  const running = props.request.status === "running";
  const [open, setOpen] = useState(false);
  const { items, loading, failed } = useAssistTranscript({
    collab: props.collab,
    request: props.request,
    enabled: open && available
  });

  if (!available) return null;

  return (
    <div className={`${styles.process} ${props.inline ? styles.processInline : ""}`} data-collab-assist-process="">
      <button
        type="button"
        className={styles.processToggle}
        aria-expanded={open}
        data-collab-assist-process-toggle=""
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight size={12} aria-hidden="true" className={open ? styles.processChevronOpen : styles.processChevron} />
        <span>{processTitle}</span>
        {items.length ? <span className={styles.processCount}>· {t("collab.assist.process.count", { count: String(items.length) })}</span> : null}
      </button>
      {open ? (
        <div className={styles.processBody}>
          {loading ? (
            <p className={styles.processNote}>
              <Loader2 size={12} aria-hidden="true" className={styles.processSpin} />
              {t("collab.assist.process.loading")}
            </p>
          ) : failed ? (
            <p className={styles.processNote}>{t("collab.assist.process.failed")}</p>
          ) : items.length ? (
            <>{items.map((item, index) => <TranscriptLine key={index} item={item} t={t} />)}</>
          ) : running ? (
            <p className={styles.processNote}>
              <Loader2 size={12} aria-hidden="true" className={styles.processSpin} />
              {t("collab.assist.conv.running")}
            </p>
          ) : (
            <p className={styles.processNote}>{t("collab.assist.process.empty")}</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
