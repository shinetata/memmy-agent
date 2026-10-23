import { Folder, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createHttpCollabClient, type CollabClient, type CollabProject } from "../api/collab-client.js";
import { useOptionalAgentRuntimeBridge } from "../app/agent-runtime-bridge.js";
import { useOptionalApiClients } from "../app/providers.js";
import { Button } from "../components/button.js";
import { Modal } from "../components/modal.js";
import { useTranslation } from "../i18n/use-translation.js";
import styles from "./collab-page.module.css";

const MAX_PROJECT_NAME_CHARS = 20;

/** One dialog for the whole app, so creating a shared project never needs to change the page behind it. */
export function CollabCreateProjectDialog(props: {
  open: boolean;
  onClose: () => void;
  onCreated: (project: CollabProject) => void;
  onBound: (projectId: string, localProjectId: string) => void;
  onBindFailed: (reason: string) => void;
}) {
  // Rendered by AppFrame, which also runs in tests and error states without providers.
  const { clients } = useOptionalApiClients();
  const collab = useMemo(
    () => (clients ? createHttpCollabClient(clients.runtimeConfig) : null),
    [clients]
  );
  if (!collab) return null;
  return <CreateProjectModal {...props} collab={collab} />;
}

export function CreateProjectModal(props: {
  open: boolean;
  collab: CollabClient;
  onClose: () => void;
  onCreated: (project: CollabProject) => void;
  onBound: (projectId: string, localProjectId: string) => void;
  onBindFailed: (reason: string) => void;
}) {
  const { t } = useTranslation();
  const bridge = useOptionalAgentRuntimeBridge();
  const [name, setName] = useState("");
  const [directory, setDirectory] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const trimmed = name.trim();
  const valid = trimmed.length > 0 && Array.from(trimmed).length <= MAX_PROJECT_NAME_CHARS;

  useEffect(() => {
    if (props.open) {
      setName("");
      setDirectory(null);
      setError(null);
    }
  }, [props.open]);

  async function chooseDirectory() {
    // Any existing folder is fine here: the project's tasks run in it, it does not have to be empty.
    const picked = await window.memmy?.selectProjectDirectory?.().catch(() => null);
    if (picked && !picked.canceled) setDirectory(picked.path);
  }

  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await props.collab.createProject(trimmed, directory ?? undefined);
      // The project exists in the cloud now, so it opens whether or not the local part succeeds.
      props.onCreated(created.project);
      if (!created.localDirectory) {
        // An older backend does not prepare a working directory; tasks could not run in the project.
        props.onBindFailed(t("collab.create.needsRestart"));
        return;
      }
      try {
        const outcome = await bridge?.taskStateCoordinator.mutateProject({
          kind: "create",
          // Always its own record: sharing a folder with an existing local project must not merge the two,
          // because their sessions have to stay apart.
          input: { mode: directory ? "existing" : "blank", path: created.localDirectory, name: trimmed, allowShared: true }
        });
        const localProjectId = outcome?.status === "committed" ? outcome.project?.id : undefined;
        if (!localProjectId) throw new Error(t("collab.create.bindFailed"));
        await props.collab.bindLocalProject(created.project.id, localProjectId);
        props.onBound(created.project.id, localProjectId);
      } catch (cause) {
        // Without the local project the board still works; tasks and the sidebar list stay empty.
        props.onBindFailed(messageOf(cause));
      }
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  // The entry already says "online project", so the dialog only asks for what a project still needs.
  return (
    <Modal
      open={props.open}
      title={t("collab.create.title")}
      subtitle={t("collab.create.subtitle")}
      onClose={props.onClose}
      closeLabel={t("common.close")}
      closeContent={<X size={16} aria-hidden="true" />}
      initialFocusRef={inputRef}
      className={styles.createModal}
      backdropClassName={styles.backdrop}
      footer={(
        <>
          <span />
          <span className={styles.footerButtons}>
            <Button variant="ghost" onClick={props.onClose}>{t("collab.cancel")}</Button>
            <Button variant="primary" disabled={!valid || busy} onClick={() => void submit()}>
              {t("collab.create.submit")}
            </Button>
          </span>
        </>
      )}
    >
      <label className={styles.field}>
        <span>{t("collab.create.name")}</span>
        <input
          ref={inputRef}
          value={name}
          maxLength={40}
          placeholder={t("collab.create.namePlaceholder")}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void submit();
          }}
        />
      </label>
      <div className={styles.field}>
        <span>{t("collab.create.dirOptional")}</span>
        <div className={styles.dirField}>
          <Folder size={15} aria-hidden="true" className={styles.dirIcon} />
          <span className={`${styles.dirPath} ${directory ? "" : styles.dirPlaceholder}`}>
            {directory ?? t("collab.create.dirUnset")}
          </span>
          <Button size="sm" variant="ghost" onClick={() => void chooseDirectory()}>
            {directory ? t("collab.create.dirChange") : t("collab.create.dirPick")}
          </Button>
        </div>
        <small className={styles.fieldHint}>{t("collab.create.dirHint")}</small>
      </div>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
    </Modal>
  );
}


function messageOf(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message.trim() : String(cause).trim();
  return raw.startsWith("[") || raw.startsWith("{") ? "" : raw;
}
