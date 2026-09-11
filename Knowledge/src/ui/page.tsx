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
  const selected =
    settings?.bases.filter((base) => base.selected).map((base) => base.id) ??
    [];
  return (
    <section className="memmy-knowledge">
      <style>{styles}</style>
      <header>
        <div>
          <h1>{t("知识库", "Knowledge")}</h1>
          <p>
            {t(
              "管理资料，让 Memmy 在任务对话中检索并使用它们。",
              "Manage documents for Memmy to retrieve in your task conversations.",
            )}
          </p>
        </div>
        <span className={`mk-badge ${settings?.enabled ? "mk-on" : ""}`}>
          {settings?.enabled
            ? t("召回已开启", "Recall on")
            : t("召回已关闭", "Recall off")}
        </span>
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
          <div className="mk-card mk-recall">
            <div>
              <h2>
                {t(
                  "在 Agent 对话中使用知识库",
                  "Use knowledge in Agent conversations",
                )}
              </h2>
              <p>
                {t(
                  "默认关闭。开启后，从下方勾选的知识库中召回相关资料。",
                  "Off by default. Enable to retrieve from the knowledge bases selected below.",
                )}
              </p>
            </div>
            <label className="mk-toggle">
              <input
                type="checkbox"
                role="switch"
                checked={settings.enabled}
                disabled={
                  !settings.enabled &&
                  (!settings.serviceAvailable || !selected.length)
                }
                onChange={(event) =>
                  void run(async () => save({ enabled: event.target.checked }))
                }
                aria-label={t("知识库召回", "Knowledge recall")}
              />
              {settings.enabled ? t("开启", "On") : t("关闭", "Off")}
            </label>
          </div>
          <div className="mk-columns">
            <aside className="mk-card">
              <h2>{t("我的知识库", "My knowledge bases")}</h2>
              {!settings.bases.length && (
                <p className="mk-empty">
                  {t(
                    "创建知识库，上传你希望 Memmy 使用的资料。",
                    "Create a knowledge base and upload documents for Memmy to use.",
                  )}
                </p>
              )}
              {settings.bases.map((base) => (
                <div
                  className={`mk-base ${base.id === activeId ? "mk-active" : ""}`}
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
                    }}
                  >
                    {base.name}{base.shared ? ` · ${t("共享给我的", "Shared with me")}` : ""}
                  </button>
                </div>
              ))}
              <details className="mk-add">
                <summary className="mk-primary">
                  {t("添加知识库", "Add knowledge base")}
                </summary>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run(async () => {
                      acceptSettings(
                        await api<KnowledgeSettings>("/bases", "POST", {
                          name,
                        }),
                      );
                      setName("");
                    });
                  }}
                >
                  <label>
                    {t("名称", "Name")}
                    <input
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      maxLength={200}
                      required
                    />
                  </label>
                  <button
                    className="mk-primary"
                    type="submit"
                    disabled={!settings.serviceAvailable}
                  >
                    {t("添加", "Add")}
                  </button>
                </form>
              </details>
            </aside>
            <main className="mk-card">
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
                      <small>{active.id}</small>
                    </div>
                    {!active.shared && <details className="mk-share">
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
        </fieldset>
      )}
      {busy && <p role="status">{t("正在处理…", "Working…")}</p>}
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
@media(max-width:850px){.mk-columns{grid-template-columns:1fr}.memmy-knowledge{padding:24px 16px}.mk-recall{align-items:flex-start}.mk-file-header{flex-wrap:wrap}}
`;
