import { BookOpen, Search, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { RuntimeConfig } from "@memmy/local-api-contracts";
import { listKnowledgeBases, type KnowledgeBaseOption } from "../api/knowledge-bases-client.js";
import type { CollabKnowledgeView } from "../api/collab-client.js";
import { Button } from "../components/button.js";
import { Modal } from "../components/modal.js";
import { useTranslation } from "../i18n/use-translation.js";
import styles from "./collab-knowledge-dialog.module.css";

/** 一个候选知识库在列表里的状态：已关联的排前面，勾选状态就是关联状态。 */
interface KnowledgeRow {
  id: string;
  name: string;
  linked: boolean;
  /** 已关联但解除关联的权限不在自己手上（关联人本人或所有者、管理员才行）。 */
  removable: boolean;
  detail: string | null;
}

/**
 * 项目知识库的唯一入口：已关联的与可关联的在同一个列表里，勾选即关联、取消勾选即解除。
 *
 * <p>只加引用：原文访问权限仍按知识库自己的共享设置，关联不会带来新的访问权。</p>
 */
export function ProjectKnowledgeDialog(props: {
  open: boolean;
  knowledge: CollabKnowledgeView | null;
  config: RuntimeConfig | null;
  onClose: () => void;
  onAdd: (baseId: string) => Promise<void>;
  onRemove: (baseId: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const hintId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const [options, setOptions] = useState<KnowledgeBaseOption[] | null>(null);
  const [query, setQuery] = useState("");
  // 一次只处理一个改动：请求在途时锁住全部勾选，避免重复提交同一个库。
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!props.open) return;
    setQuery("");
    setError(null);
    if (!props.config) {
      setOptions([]);
      return;
    }
    let cancelled = false;
    setOptions(null);
    void listKnowledgeBases(props.config).then((bases) => {
      if (!cancelled) setOptions(bases);
    });
    return () => { cancelled = true; };
  }, [props.open, props.config]);

  const linked = props.knowledge?.bases ?? [];
  const maxBases = props.knowledge?.maxBases ?? 10;
  const canManage = props.knowledge?.canManage ?? false;
  const remaining = Math.max(0, maxBases - linked.length);
  const loading = options === null;

  const rows = useMemo<KnowledgeRow[]>(() => {
    const optionsById = new Map((options ?? []).map((base) => [base.id, base]));
    const linkedIds = new Set(linked.map((base) => base.id));
    const detailOf = (base: KnowledgeBaseOption): string | null => {
      if (base.shared && base.sharedByMe === false) {
        return base.ownerName
          ? t("collab.knowledge.fromOwner", { name: base.ownerName })
          : t("collab.knowledge.sharedWithMe");
      }
      if (base.sharedByMe) return t("collab.knowledge.sharedByMe");
      if (base.shared === false) return t("collab.knowledge.personal");
      return null;
    };
    return [
      ...linked.map((base) => {
        const option = optionsById.get(base.id);
        const removable = base.mine || canManage;
        return {
          id: base.id,
          name: base.name,
          linked: true,
          removable,
          // 解不掉的库先说明是谁关联的：那才是「为什么我动不了它」的答案。
          detail: removable
            ? (option ? detailOf(option) : null)
            : base.addedByName
              ? t("collab.knowledge.linkedByNamed", { name: base.addedByName })
              : t("collab.knowledge.linkedByOther")
        };
      }),
      ...(options ?? [])
        .filter((base) => !linkedIds.has(base.id))
        .map((base) => ({
          id: base.id,
          name: base.name,
          linked: false,
          removable: true,
          detail: detailOf(base)
        }))
    ];
  }, [linked, options, canManage, t]);

  const visible = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return rows.filter((row) => !keyword || row.name.toLowerCase().includes(keyword));
  }, [rows, query]);

  /** 勾选状态就是关联状态：勾上就关联，取消勾选就解除。 */
  async function toggle(row: KnowledgeRow) {
    if (busy || !props.knowledge) return;
    if (row.linked ? !row.removable : remaining === 0) return;
    setError(null);
    setBusy(true);
    try {
      if (row.linked) await props.onRemove(row.id);
      else await props.onAdd(row.id);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "";
      setError(message || t(row.linked ? "collab.knowledge.removeFailed" : "collab.knowledge.addFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={props.open}
      title={t("collab.knowledge.title")}
      onClose={() => { if (!busy) props.onClose(); }}
      showCloseButton
      closeDisabled={busy}
      closeLabel={t("common.close")}
      closeContent={<X size={16} aria-hidden="true" />}
      initialFocusRef={searchRef}
      ariaDescribedBy={hintId}
      className={styles.dialog}
      backdropClassName={styles.backdrop}
      bodyClassName={styles.body}
      footerClassName={styles.footer}
      footer={(
        <>
          <span className={styles.capacity}>{t("collab.knowledge.remaining", { count: String(remaining) })}</span>
          <span className={styles.actions}>
            <Button variant="primary" disabled={busy} onClick={props.onClose}>{t("collab.knowledge.done")}</Button>
          </span>
        </>
      )}
    >
      <p id={hintId} className={styles.hint}>{t("collab.knowledge.hint")}</p>
      <label className={styles.search}>
        <Search size={16} aria-hidden="true" />
        <input ref={searchRef} type="search" value={query} placeholder={t("collab.knowledge.search")} aria-label={t("collab.knowledge.search")} disabled={busy} onChange={(event) => setQuery(event.target.value)} />
        {query ? <button type="button" className={styles.clearSearch} disabled={busy} aria-label={t("collab.knowledge.clearSearch")} onClick={() => { setQuery(""); searchRef.current?.focus(); }}><X size={14} aria-hidden="true" /></button> : null}
      </label>
      <div className={styles.summary} role="status" aria-live="polite">
        {t("collab.knowledge.linkedCount", { count: String(linked.length) })}
      </div>
      <div className={styles.results} aria-busy={loading || busy}>
        {loading ? (
          <div className={styles.empty} role="status">{t("collab.knowledge.loading")}</div>
        ) : visible.length === 0 ? (
          <div className={styles.empty}>
            {query.trim() ? <Search size={24} aria-hidden="true" /> : <BookOpen size={24} aria-hidden="true" />}
            <span>{t(query.trim() ? "collab.knowledge.noResults" : "collab.knowledge.empty")}</span>
            {query.trim() ? <small>{t("collab.knowledge.searchHelp")}</small> : null}
          </div>
        ) : (
          <ul className={styles.list}>
            {visible.map((row) => {
              const blocked = row.linked ? !row.removable : remaining === 0;
              const disabled = busy || blocked;
              return (
                <li key={row.id}>
                  <label className={styles.row} data-linked={row.linked} data-disabled={disabled} data-busy={busy}>
                    <input
                      type="checkbox"
                      className={styles.checkbox}
                      checked={row.linked}
                      disabled={disabled}
                      aria-label={row.name}
                      onChange={() => void toggle(row)}
                    />
                    <span className={styles.icon}><BookOpen size={19} aria-hidden="true" /></span>
                    <span className={styles.text}>
                      <span className={styles.name} title={row.name}>{row.name}</span>
                      {row.detail ? <span className={styles.detail}>{row.detail}</span> : null}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {error ? <span className={styles.error} role="alert">{error}</span> : null}
    </Modal>
  );
}
