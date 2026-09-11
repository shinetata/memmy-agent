import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type KnowledgeFiles, type KnowledgeMember, type KnowledgeSettings } from "../types.js";

import {
  DOCUMENT_EXTENSIONS,
  uploadDocuments,
  type UploadResult,
} from "./upload.js";

export interface KnowledgePageProps {
  connection: { baseUrl: string; localToken: string };
  language?: string;
  onSignIn?: () => void;
}
export function KnowledgePage({
  connection,
  language = "zh",
  onSignIn,
}: KnowledgePageProps) {
  const zh = language.startsWith("zh");
  const t = (cn: string, en: string) => (zh ? cn : en);
  const [settings, setSettings] = useState<KnowledgeSettings | null>(null);
  const [name, setName] = useState("");
  const [activeId, setActiveId] = useState("");
  const [view, setView] = useState<"all" | "mine" | "sharedByMe" | "sharedWithMe">("all");
  const [detailOpen, setDetailOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [listing, setListing] = useState<KnowledgeFiles | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [refresh, setRefresh] = useState(0);
  const uploadInput = useRef<HTMLInputElement>(null);
  const [uploadResults, setUploadResults] = useState<UploadResult[]>([]);
  const [shareUserId, setShareUserId] = useState("");
  const [members, setMembers] = useState<KnowledgeMember[]>([]);
  const api = useMemo(
    () =>
      async <T,>(
        path: string,
        method = "GET",
        body?: unknown,
        signal?: AbortSignal,
      ): Promise<T> => {
        const response = await fetch(
          new URL(`/api/knowledge${path}`, connection.baseUrl),
          {
            method,
            signal,
            headers: {
              "x-memmy-local-token": connection.localToken,
              ...(body === undefined
                ? {}
                : { "Content-Type": "application/json" }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          },
        );
        const data = await response.json();
        if (!response.ok)
          throw new Error(
            typeof data.error === "string"
              ? data.error
              : `HTTP ${response.status}`,
          );
        return data as T;
      },
    [connection.baseUrl, connection.localToken],
  );
  const acceptSettings = useCallback((value: KnowledgeSettings) => {
    setSettings(value);
    setActiveId((current) =>
      value.bases.some((base) => base.id === current)
        ? current
        : (value.bases[0]?.id ?? ""),
    );
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void api<KnowledgeSettings>(
      "/settings",
      "GET",
      undefined,
      controller.signal,
    )
      .then(acceptSettings)
      .catch((error) => {
        if (!controller.signal.aborted) setError(String(error.message));
      });
    return () => controller.abort();
  }, [api, acceptSettings]);
  useEffect(() => {
    setUploadResults([]);
  }, [activeId]);
  useEffect(() => {
    setMembers([]);
    if (!activeId || settings?.bases.find((base) => base.id === activeId)?.shared) return;
    void api<{ members: KnowledgeMember[] }>(`/bases/${encodeURIComponent(activeId)}/members`).then((value) => setMembers(value.members ?? [])).catch(() => setMembers([]));
  }, [activeId, settings, api]);
  useEffect(() => {
    setListing(null);
    if (!activeId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;
    const load = async () => {
      try {
        const value = await api<KnowledgeFiles>(
          `/bases/${encodeURIComponent(activeId)}/files?page=${page}`,
          "GET",
          undefined,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setListing(value);
        // Refresh processing files and freshly uploaded files without resetting the management form.
        if (
          value.files.some((file) =>
            /处理中|上传中|pending|running|processing|uploading/i.test(
              file.status,
            ),
          ) ||
          (refresh > 0 && polls++ < 6)
        )
          timer = setTimeout(() => void load(), 5000);
      } catch (error) {
        if (!controller.signal.aborted) setError((error as Error).message);
      }
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [activeId, page, api, refresh]);
  async function run(operation: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save(patch: unknown) {
    acceptSettings(await api<KnowledgeSettings>("/settings", "PUT", patch));
  }
  const active = settings?.bases.find((base) => base.id === activeId);
  const ownedBases = settings?.bases.filter((base) => !base.shared) ?? [];
  const sharedBases = settings?.bases.filter((base) => base.shared) ?? [];
  const visibleBases = settings?.bases.filter((base) =>
    view === "sharedWithMe" ? Boolean(base.shared) : view === "sharedByMe" ? false : !base.shared,
  ) ?? [];
  const selected =
    settings?.bases.filter((base) => base.selected).map((base) => base.id) ??
    [];
  return (
    <section className="memmy-knowledge">
      <style>{styles}</style>
      <div className="mk-library-content">
        <header className="mk-page-header">
          <div>
            <h1>{t("知识库", "Knowledge")}</h1>
            <p>{t("最近访问的知识库", "Recently accessed knowledge bases")}</p>
        </div>
        <div className="mk-header-actions"><span className={`mk-badge ${settings?.enabled ? "mk-on" : ""}`}>
          {settings?.enabled
            ? t("召回已开启", "Recall on")
            : t("召回已关闭", "Recall off")}
        </span><div className="mk-header-actions"><button type="button" className="mk-secondary" onClick={() => setShareOpen(true)}>{t("共享知识库", "Share knowledge base")}</button><button type="button" className="mk-primary" onClick={() => setCreateOpen(true)}>{t("＋ 新建知识库", "＋ New knowledge base")}</button></div></div>
      </header>
      {error && (
        <div className="mk-error" role="alert">
          {error}
          <button
            type="button"
            onClick={() => {
              setError("");
              setRefresh((value) => value + 1);
              void run(async () =>
                acceptSettings(await api<KnowledgeSettings>("/settings")),
              );
            }}
          >
            {t("重试", "Retry")}
          </button>
        </div>
      )}
      {notice && (
        <p className="mk-notice" role="status">
          {notice}
        </p>
      )}
      {!settings ? (
        <p aria-live="polite">
          {t("正在读取知识库配置…", "Loading knowledge settings…")}
        </p>
      ) : (
        <fieldset disabled={busy}>
          {!settings.serviceAvailable && (
            <p className="mk-notice" role="status">
              {t(
                settings.authenticated
                  ? "知识库服务暂未就绪，请稍后重试。"
                  : "登录 Memmy 后即可使用知识库，无需配置其他服务。",
                settings.authenticated
                  ? "Knowledge service is not ready. Please try again later."
                  : "Sign in to Memmy to use knowledge. No additional service setup is needed.",
              )}
              {!settings.authenticated && onSignIn && (
                <button type="button" onClick={onSignIn}>
                  {t("登录 Memmy", "Sign in to Memmy")}
                </button>
              )}
            </p>
          )}
          <div className="mk-view-tabs" role="tablist" aria-label={t("知识库分类", "Knowledge base categories")}>
            {([["all", t("全部", "All")], ["mine", t("我的", "Mine")], ["sharedByMe", t("我分享的", "Shared by me")], ["sharedWithMe", t("与我共享", "Shared with me")]] as const).map(([key, label]) => <button key={key} className={view === key ? "mk-view-active" : ""} onClick={() => setView(key)} role="tab" aria-selected={view === key}>{label}<span>{key === "all" ? settings.bases.length : key === "sharedWithMe" || key === "sharedByMe" ? 0 : ownedBases.length}</span></button>)}
          </div>
          <div className="mk-columns">
            <aside className="mk-card mk-base-panel">
              <div className="mk-section-heading"><h2>{t("最近", "Recent")}</h2><span>{visibleBases.length}</span></div>
              <div className="mk-table-head"><span>{t("名称", "Name")}</span><span>{t("所有者", "Owner")}</span><span>{t("最近更新", "Last updated")}</span></div>
              {!settings.bases.length && (
                <p className="mk-empty">
                  {t(
                    "创建知识库，上传你希望 Memmy 使用的资料。",
                    "Create a knowledge base and upload documents for Memmy to use.",
                  )}
                </p>
              )}
              {visibleBases.map((base) => (
                <div
                  className={`mk-base mk-table-row ${base.id === activeId ? "mk-active" : ""}`}
                  key={base.id}
                >
                  <input
                    type="checkbox"
                    aria-label={`${t("参与召回", "Use for recall")}: ${base.name}`}
                    checked={base.selected}
                    onChange={(event) => {
                      const ids = event.target.checked
                        ? [...selected, base.id]
                        : selected.filter((id) => id !== base.id);
                      void run(async () =>
                        save({
                          selectedIds: ids,
                          ...(!ids.length ? { enabled: false } : {}),
                        }),
                      );
                    }}
                  />
                  <button
                    className="mk-base-name"
                    type="button"
                    onClick={() => {
                      setActiveId(base.id);
                      setPage(1);
                      setDetailOpen(true);
                    }}
                  >
                    {base.name}
                  </button>
                  <span>{base.shared ? (base.ownerName || t("其他用户", "Another user")) : t("我", "You")}</span><span>{t("最近更新", "Recently updated")}</span>
                </div>
              ))}
            </aside>
            <main className={`mk-card mk-detail-modal ${detailOpen ? "mk-detail-open" : "mk-detail-closed"}`} role="dialog" aria-modal="true" aria-label={active?.name}>
              {!active ? (
                <div className="mk-empty">
                  {t(
                    "选择知识库后，可上传文档并查看处理状态。",
                    "Select a knowledge base to upload documents and view processing status.",
                  )}
                </div>
              ) : (
                <>
                  <div className="mk-file-header">
                    <div>
                      <h2>{active.name}</h2>
                    </div>
                    <button type="button" className="mk-close" onClick={() => setDetailOpen(false)} aria-label={t("关闭", "Close")}>×</button>
                    {!active.shared && <details className="mk-share" hidden>
                      <summary>{t("共享知识库", "Share knowledge base")}</summary>
                      <form onSubmit={(event) => { event.preventDefault(); void run(async () => { await api(`/bases/${encodeURIComponent(active.id)}/members`, "POST", { userId: shareUserId.trim() }); setShareUserId(""); setNotice(t("共享成功，用户刷新后即可看到该知识库。", "Shared. The user will see it after refreshing.")); const value = await api<{ members: KnowledgeMember[] }>(`/bases/${encodeURIComponent(active.id)}/members`); setMembers(value.members ?? []); }); }}>
                        <label>{t("Memmy 用户 ID", "Memmy user ID")}<input value={shareUserId} onChange={(event) => setShareUserId(event.target.value)} placeholder={t("输入对方的用户 ID", "Enter the other user's ID")} required /></label>
                        <button className="mk-primary" type="submit">{t("确认共享", "Share")}</button>
                      </form>
                      {members.length > 0 && <ul className="mk-members">{members.filter((member) => member.status === "ACTIVE").map((member) => <li key={member.userId}><span>{member.name} · {member.userId}</span><button type="button" onClick={() => void run(async () => { await api(`/bases/${encodeURIComponent(active.id)}/members/${encodeURIComponent(member.userId)}`, "DELETE"); setMembers((current) => current.filter((item) => item.userId !== member.userId)); })}>{t("撤销", "Revoke")}</button></li>)}</ul>}
                    </details>}
                    <button
                      type="button"
                      disabled={active.shared}
                      onClick={() => {
                        if (
                          !window.confirm(
                            t(
                              "彻底删除此知识库及全部文件？这会同时删除 MemOS 中的数据并解除所有项目关联，删除后无法恢复。",
                              "Permanently delete this knowledge base and all its files? This also deletes the data in MemOS and removes all project associations. This cannot be undone.",
                            ),
                          )
                        )
                          return;
                        void run(async () => {
                          acceptSettings(
                            await api<KnowledgeSettings>(
                              `/bases/${encodeURIComponent(active.id)}`,
                              "DELETE",
                            ),
                          );
                          setPage(1);
                        });
                      }}
                    >
                      {t("删除知识库", "Delete knowledge base")}
                    </button>
                  </div>
                  {active.shared && <p className="mk-notice">{t(`来自 ${active.ownerName || "其他用户"} 的共享知识库，仅可查看和参与召回。`, `Shared by ${active.ownerName || "another user"}. View and recall only.`)}</p>}
                  <div className="mk-detail-recall"><span>{t("在 Agent 对话中使用知识库", "Use in Agent conversations")}</span><label className="mk-toggle"><input type="checkbox" role="switch" checked={settings.enabled} disabled={!settings.serviceAvailable} onChange={(event) => void run(async () => save({ enabled: event.target.checked, ...(event.target.checked && !selected.includes(active.id) ? { selectedIds: [...selected, active.id] } : {}) }))} aria-label={t("知识库召回", "Knowledge recall")} />{settings.enabled ? t("开启", "On") : t("关闭", "Off")}</label></div>
                  <div className="mk-upload" hidden={active.shared}>
                    <div className="mk-upload-picker">
                      <input
                        ref={uploadInput}
                        type="file"
                        hidden
                        multiple
                        accept={DOCUMENT_EXTENSIONS}
                        aria-label={t(
                          "选择上传文件",
                          "Select documents to upload",
                        )}
                        onChange={(event) => {
                          const files = Array.from(event.target.files ?? []);
                          event.target.value = "";
                          if (!files.length) return;
                          const id = active.id;
                          void run(async () => {
                            setUploadResults([]);
                            const results = await uploadDocuments(
                              files,
                              (file, content) =>
                                api(
                                  `/bases/${encodeURIComponent(id)}/files`,
                                  "POST",
                                  { name: file.name, content },
                                ),
                              (completed, total, name) =>
                                setNotice(
                                  t(
                                    `正在上传 ${completed + 1}/${total}：${name}`,
                                    `Uploading ${completed + 1}/${total}: ${name}`,
                                  ),
                                ),
                              zh,
                            );
                            setUploadResults(results);
                            const succeeded = results.filter(
                              (result) => result.ok,
                            ).length;
                            const failed = results.length - succeeded;
                            setNotice(
                              t(
                                `上传完成：成功 ${succeeded} 个，失败 ${failed} 个。${succeeded ? "云端处理完成后即可参与召回。" : ""}`,
                                `Upload complete: ${succeeded} succeeded, ${failed} failed.${succeeded ? " Documents become searchable after cloud processing." : ""}`,
                              ),
                            );
                            if (succeeded) {
                              setPage(1);
                              setRefresh((value) => value + 1);
                            }
                          });
                        }}
                      />
                      <button
                        className="mk-primary"
                        type="button"
                        onClick={() => uploadInput.current?.click()}
                        aria-describedby="mk-upload-hint"
                      >
                        {t("选择文件", "Choose files")}
                      </button>
                      <span id="mk-upload-hint">
                        {t(
                          "上传文档（每个文件最多 20 MB）",
                          "Upload documents (up to 20 MB each)",
                        )}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setRefresh((value) => value + 1)}
                    >
                      {t("刷新", "Refresh")}
                    </button>
                  </div>
                  {uploadResults.some((result) => !result.ok) && (
                    <ul
                      className="mk-upload-failures"
                      aria-label={t("上传失败的文件", "Failed uploads")}
                    >
                      {uploadResults
                        .filter((result) => !result.ok)
                        .map((result, index) => (
                          <li key={index}>
                            {result.name}：{result.error}
                          </li>
                        ))}
                    </ul>
                  )}
                  {!listing ? (
                    <p>{t("正在读取文件…", "Loading files…")}</p>
                  ) : !listing.files.length ? (
                    <p className="mk-empty">
                      {t("还没有文档。", "No documents yet.")}
                    </p>
                  ) : (
                    <ul className="mk-files">
                      {listing.files.map((file) => (
                        <li key={file.id}>
                          <div>
                            <strong>{file.name}</strong>
                            <small>
                              {file.status}
                              {file.message ? ` · ${file.message}` : ""}
                            </small>
                          </div>
                          <button
                            type="button"
                            disabled={active.shared}
                            onClick={() => {
                              if (
                                !window.confirm(
                                  t(
                                    `从云端删除“${file.name}”？此操作也会影响该知识库的其他使用方。`,
                                    `Delete “${file.name}” from the cloud? This also affects other users of this knowledge base.`,
                                  ),
                                )
                              )
                                return;
                              void run(async () => {
                                await api(
                                  `/bases/${encodeURIComponent(active.id)}/files/${encodeURIComponent(file.id)}`,
                                  "DELETE",
                                  { page },
                                );
                                setRefresh((value) => value + 1);
                              });
                            }}
                          >
                            {t("删除", "Delete")}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {listing && (
                    <div className="mk-pagination">
                      <span>
                        {t(
                          `共 ${listing.total} 个文件`,
                          `${listing.total} files`,
                        )}
                      </span>
                      <button
                        type="button"
                        disabled={page <= 1}
                        onClick={() => setPage((value) => value - 1)}
                      >
                        {t("上一页", "Previous")}
                      </button>
                      <span>{page}</span>
                      <button
                        type="button"
                        disabled={page * 20 >= listing.total}
                        onClick={() => setPage((value) => value + 1)}
                      >
                        {t("下一页", "Next")}
                      </button>
                    </div>
                  )}
                </>
              )}
            </main>
          </div>
          {createOpen && <div className="mk-modal-backdrop"><div className="mk-action-modal" role="dialog" aria-modal="true"><button className="mk-modal-close" onClick={() => setCreateOpen(false)}>×</button><h2>{t("新建知识库", "New knowledge base")}</h2><p>{t("创建一个新的个人知识库。", "Create a personal knowledge base.")}</p><form onSubmit={(event) => { event.preventDefault(); void run(async () => { acceptSettings(await api<KnowledgeSettings>("/bases", "POST", { name })); setName(""); setCreateOpen(false); }); }}><label>{t("名称", "Name")}<input value={name} onChange={(event) => setName(event.target.value)} maxLength={200} required autoFocus /></label><div className="mk-modal-actions"><button type="button" onClick={() => setCreateOpen(false)}>{t("取消", "Cancel")}</button><button className="mk-primary" type="submit" disabled={!settings.serviceAvailable}>{t("创建", "Create")}</button></div></form></div></div>}
          {shareOpen && <div className="mk-modal-backdrop"><div className="mk-action-modal" role="dialog" aria-modal="true"><button className="mk-modal-close" onClick={() => setShareOpen(false)}>×</button><h2>{t("共享知识库", "Share knowledge base")}</h2><p>{t("选择知识库并输入对方的 Memmy 用户 ID。", "Choose a knowledge base and enter the other Memmy user's ID.")}</p><form onSubmit={(event) => { event.preventDefault(); const target = active ?? ownedBases[0]; if (!target) return; void run(async () => { await api(`/bases/${encodeURIComponent(target.id)}/members`, "POST", { userId: shareUserId.trim() }); setShareUserId(""); setShareOpen(false); setNotice(t("共享成功。", "Shared successfully.")); }); }}><label>{t("知识库", "Knowledge base")}<select value={activeId} onChange={(event) => setActiveId(event.target.value)}>{ownedBases.map((base) => <option value={base.id} key={base.id}>{base.name}</option>)}</select></label><label>{t("Memmy 用户 ID", "Memmy user ID")}<input value={shareUserId} onChange={(event) => setShareUserId(event.target.value)} placeholder={t("输入用户 ID", "Enter user ID")} required /></label><div className="mk-modal-actions"><button type="button" onClick={() => setShareOpen(false)}>{t("取消", "Cancel")}</button><button className="mk-primary" type="submit">{t("确认共享", "Share")}</button></div></form></div></div>}
        </fieldset>
      )}
      {busy && <p role="status">{t("正在处理…", "Working…")}</p>}
      </div>
    </section>
  );
}
const styles = `
.memmy-knowledge{max-width:1160px;margin:0 auto;padding:32px 28px;color:inherit;font-size:14px;width:100%;box-sizing:border-box}
.memmy-knowledge header,.mk-recall,.mk-file-header,.mk-upload,.mk-pagination,.mk-actions{display:flex;align-items:center;justify-content:space-between;gap:16px}
.memmy-knowledge h1{font-size:26px;font-weight:600;margin:0 0 8px}.memmy-knowledge h2{font-size:16px;font-weight:600;margin:0 0 8px}.memmy-knowledge p{margin:6px 0;opacity:.72;line-height:1.65}
.memmy-knowledge fieldset{border:0;padding:0;margin:24px 0;min-width:0}.mk-card{border:1px solid #8883;border-radius:14px;padding:20px;margin-bottom:18px;min-width:0}.mk-badge{white-space:nowrap;padding:6px 12px;background:#8881;border-radius:20px;font-size:12px}.mk-on{background:#3a956422;color:#3c9567}
.memmy-knowledge summary{cursor:pointer;font-weight:500}.memmy-knowledge summary span{float:right;opacity:.55;font-size:12px}.memmy-knowledge form{display:grid;gap:12px;margin-top:18px}.memmy-knowledge label{display:grid;gap:7px;font-size:13px}
.memmy-knowledge input:not([type=checkbox]),.memmy-knowledge select{border:1px solid #8884;border-radius:7px;padding:9px 10px;background:transparent;color:inherit;min-width:0;width:100%;box-sizing:border-box}.memmy-knowledge input[type=checkbox]{accent-color:#3c9567;width:16px;height:16px;flex-shrink:0}
.memmy-knowledge button{border:1px solid #8883;border-radius:7px;padding:7px 11px;background:transparent;color:inherit;cursor:pointer;white-space:nowrap}.memmy-knowledge button:hover{background:#8881}.memmy-knowledge button:disabled,.memmy-knowledge fieldset:disabled{opacity:.55;cursor:default}.memmy-knowledge :focus-visible{outline:2px solid #3c9567;outline-offset:2px}.memmy-knowledge .mk-toggle{display:flex;align-items:center;white-space:nowrap}
.mk-columns{display:grid;grid-template-columns:270px minmax(0,1fr);gap:18px}.mk-base{display:flex;align-items:center;gap:10px;padding:6px;border-radius:8px}.mk-active{background:#3a956413}.memmy-knowledge .mk-base-name{border:0;text-align:left;white-space:normal;overflow-wrap:anywhere;flex:1}.mk-add{border-top:1px solid #8883;margin-top:20px;padding-top:16px}.mk-empty{padding:30px 0;text-align:center;opacity:.6;line-height:1.7}
.mk-file-header small{opacity:.5;overflow-wrap:anywhere}.mk-upload{margin:20px 0;padding:16px;border:1px dashed #8884;border-radius:9px}.mk-files{list-style:none;padding:0;margin:0}.mk-files li{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 0;border-top:1px solid #8882}.mk-files strong{font-weight:500;overflow-wrap:anywhere}.mk-files small{display:block;opacity:.6;margin-top:6px}.mk-pagination{justify-content:flex-end;margin-top:18px;font-size:12px}.mk-pagination>span:first-child{margin-right:auto}.mk-error{padding:12px 16px;margin-top:18px;border:1px solid #bf555566;border-radius:8px;color:#bb5555;display:flex;align-items:center;justify-content:space-between;gap:12px}.mk-notice{padding:12px;background:#3a956413;border-radius:8px}.mk-help{font-size:12px}.mk-actions{justify-content:flex-start}

.memmy-knowledge .mk-primary{background:var(--color-action-sky,#5cbfae);color:white;border:0;border-radius:7px;padding:8px 12px;cursor:pointer}.memmy-knowledge .mk-primary:hover{background:var(--color-action-sky-hover,#3aa893)}.memmy-knowledge .mk-add>summary{width:fit-content}
.mk-upload-picker{display:flex;align-items:center;gap:12px;flex-wrap:wrap;min-width:0}.mk-upload-picker span{font-size:13px;line-height:1.5}.mk-upload-failures{font-size:13px;color:#bb5555;overflow-wrap:anywhere;padding-left:20px}.mk-upload>button{flex-shrink:0}
.mk-page-header{padding-bottom:4px}.mk-header-actions{display:flex;align-items:center;gap:10px}.mk-add-top{border:0;margin:0;padding:0}.mk-add-top form{position:absolute;right:28px;z-index:2;background:var(--background-primary,#fff);border:1px solid #8883;border-radius:10px;padding:14px;width:230px}.mk-view-tabs{display:flex;gap:4px;margin:26px 0 18px;border-bottom:1px solid #8882}.mk-view-tabs button{border:0;border-radius:8px 8px 0 0;padding:10px 14px;background:transparent;color:inherit;opacity:.62}.mk-view-tabs button span{font-size:11px;margin-left:7px;opacity:.55}.mk-view-tabs .mk-view-active{opacity:1;background:#8882;font-weight:600}.mk-overview-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:0 0 20px}.mk-overview-card{border-radius:12px;padding:17px 18px;position:relative;overflow:hidden}.mk-overview-card span,.mk-overview-card small{display:block;font-size:12px;opacity:.7}.mk-overview-card strong{display:block;font-size:27px;margin:9px 0 3px}.mk-overview-mine{background:#edf4ff}.mk-overview-shared{background:#f2effc}.mk-base-panel{padding:18px}.mk-section-heading{display:flex;justify-content:space-between;align-items:center;margin-bottom:9px}.mk-section-heading h2{margin:0}.mk-section-heading span{font-size:11px;opacity:.5}.mk-base-panel .mk-add{margin-top:16px}
.mk-secondary{border:1px solid #8884!important;background:transparent!important}.mk-detail-closed{display:none}.mk-close{font-size:23px!important;border:0!important;padding:0!important;line-height:1;opacity:.65}.mk-detail-modal{position:fixed;z-index:20;top:9vh;right:6vw;width:min(720px,calc(100vw - 48px));max-height:82vh;overflow:auto;background:var(--background-primary,#fff);border-radius:16px;padding:24px;box-shadow:0 16px 60px #18212b35}.mk-detail-modal:before{content:"";position:fixed;inset:0;background:#18212b30;z-index:-1}.mk-detail-modal .mk-file-header{align-items:flex-start}.mk-detail-modal .mk-file-header>div:first-child{flex:1}
.mk-view-tabs{margin-top:34px;gap:0;border:0}.mk-view-tabs button{padding:8px 14px;background:transparent;border-radius:7px}.mk-view-tabs .mk-view-active{background:#e7e7e7}.mk-overview-grid{display:none}.mk-columns{display:block}.mk-base-panel{border:0;padding:0;margin:0}.mk-section-heading{display:none}.mk-table-head,.mk-table-row{display:grid;grid-template-columns:minmax(280px,2fr) minmax(150px,1fr) 150px;align-items:center;column-gap:18px}.mk-table-head{padding:0 12px 10px;color:#999;font-size:12px;border-bottom:1px solid #eee}.mk-table-row{padding:13px 12px;border-bottom:1px solid #eee;border-radius:0}.mk-table-row:hover{background:transparent}.mk-table-row .mk-base-name:hover{text-decoration:underline;text-underline-offset:3px}.mk-table-row>span{font-size:12px;color:#999;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mk-table-row .mk-base-name{font-size:13px;padding:0;text-decoration:none}.mk-table-row input{grid-column:1;position:absolute;opacity:0}.mk-table-row .mk-base-name{grid-column:1}.mk-detail-recall{display:flex;justify-content:space-between;align-items:center;border-top:1px solid #eee;border-bottom:1px solid #eee;padding:14px 0;margin:18px 0}.mk-detail-recall .mk-toggle{display:flex;gap:8px;align-items:center;font-size:12px}.mk-page-header h1{font-size:25px}.mk-page-header p{font-size:13px}
.memmy-knowledge{display:block;max-width:none;padding:0;min-height:100%;position:relative}.mk-library-nav{width:190px;flex:0 0 190px;background:#f7f8fa;border-right:1px solid #8882;padding:25px 12px}.mk-library-nav-title{font-size:18px;font-weight:600;padding:0 12px 22px}.mk-library-nav button{display:block;width:100%;border:0;text-align:left;padding:9px 12px;border-radius:7px;background:transparent;color:inherit;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mk-library-nav button:hover{background:#e9ecef}.mk-library-nav .mk-library-nav-active{background:#e1e5e9;font-weight:600}.mk-library-group{font-size:11px;opacity:.55;padding:22px 12px 7px}.mk-library-content{min-width:0;padding:32px 42px}.mk-detail-modal{position:absolute!important;right:0;top:0;width:min(650px,70%);height:100%;max-height:none;border-radius:0;box-shadow:-10px 0 35px #18212b18}.mk-detail-modal:before{display:none}.mk-modal-backdrop{position:fixed;inset:0;background:rgba(20,27,35,.12);z-index:40;display:grid;place-items:center}.mk-action-modal{box-shadow:0 14px 45px #18212b24}
.mk-modal-backdrop{position:fixed;inset:0;background:rgba(20,27,35,.16);z-index:40;display:grid;place-items:center}.mk-action-modal{position:relative;width:390px;background:var(--background-primary,#fff);border:1px solid #8883;border-radius:12px;padding:25px}.mk-action-modal h2{font-size:18px;margin:0 0 8px}.mk-action-modal p{font-size:12px;opacity:.65;margin-bottom:20px}.mk-modal-close{position:absolute;right:15px;top:13px;border:0!important;font-size:22px!important;padding:0!important;opacity:.6}.mk-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:20px}.mk-action-modal select{border:1px solid #8884;border-radius:7px;padding:9px;background:transparent;color:inherit}
.mk-detail-modal .mk-file-header{position:relative;padding-top:48px}.mk-detail-modal .mk-close{position:absolute;left:0;top:12px;width:38px;height:38px;display:flex;align-items:center;justify-content:flex-start;z-index:5;cursor:pointer;pointer-events:auto}
@media(max-width:850px){.mk-columns{grid-template-columns:1fr}.memmy-knowledge{padding:24px 16px}.mk-recall{align-items:flex-start}.mk-file-header{flex-wrap:wrap}}
`;
