import { Cloud, Folder, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createHttpCollabClient, type CollabClient, type CollabProject } from "../api/collab-client.js";
import { prepareProjectDirectory } from "../api/projects-client.js";
import { useOptionalAgentRuntimeBridge } from "../app/agent-runtime-bridge.js";
import { useOptionalApiClients } from "../app/providers.js";
import { Button } from "../components/button.js";
import { Modal } from "../components/modal.js";
import { useTranslation } from "../i18n/use-translation.js";
import styles from "./collab-page.module.css";

const MAX_PROJECT_NAME_CHARS = 20;

/** One dialog for the whole app, so creating a project never needs to change the page behind it. */
export function CollabCreateProjectDialog(props: {
  open: boolean;
  onClose: () => void;
  /** The project exists on this computer; the caller opens its board. */
  onCreated: (localProjectId: string) => void;
  /** The project's cloud record was created and is about to be bound. */
  onShared: (project: CollabProject) => void;
  onBound: (projectId: string, localProjectId: string) => void;
  onBindFailed: (reason: string) => void;
  /** The local project exists but sharing did not start; it opens without sharing. */
  onShareFailed: (reason: string) => void;
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
  onCreated: (localProjectId: string) => void;
  onShared: (project: CollabProject) => void;
  onBound: (projectId: string, localProjectId: string) => void;
  onBindFailed: (reason: string) => void;
  onShareFailed: (reason: string) => void;
}) {
  const { t } = useTranslation();
  const bridge = useOptionalAgentRuntimeBridge();
  const { clients } = useOptionalApiClients();
  const [name, setName] = useState("");
  const [directory, setDirectory] = useState<string | null>(null);
  /** Off by default: a project stays on this computer unless the person asks for members to see it. */
  const [share, setShare] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const trimmed = name.trim();
  const valid = trimmed.length > 0 && Array.from(trimmed).length <= MAX_PROJECT_NAME_CHARS;

  useEffect(() => {
    if (props.open) {
      setName("");
      setDirectory(null);
      setShare(false);
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
    const chosenDirectory = directory;
    // The project always needs a working directory; without a picked folder a managed one is created for it.
    let workingDirectory = chosenDirectory;
    let localProjectId: string | null = null;
    try {
      if (!workingDirectory) {
        if (!clients) throw new Error(t("collab.create.localFailed"));
        workingDirectory = await prepareProjectDirectory(clients.runtimeConfig, trimmed);
      }
      const outcome = await bridge?.taskStateCoordinator.mutateProject({
        kind: "create",
        input: {
          // Always its own record: sharing a folder with an existing project must not merge the two.
          mode: chosenDirectory ? "existing" : "blank",
          path: workingDirectory,
          name: trimmed,
          allowShared: true
        }
      });
      localProjectId = outcome?.status === "committed" ? outcome.project?.id ?? null : null;
      if (!localProjectId) throw new Error(t("collab.create.localFailed"));
    } catch (cause) {
      setError(messageOf(cause) || t("collab.create.localFailed"));
      setBusy(false);
      return;
    }

    if (!share) {
      setBusy(false);
      props.onCreated(localProjectId);
      return;
    }

    const createdLocalProjectId = localProjectId;
    try {
      // The cloud record points at the folder the project already runs in, so both keep the same directory.
      const created = await props.collab.createProject(trimmed, workingDirectory);
      props.onShared(created.project);
      try {
        await props.collab.bindLocalProject(created.project.id, createdLocalProjectId);
        props.onBound(created.project.id, createdLocalProjectId);
      } catch (cause) {
        // Sharing works without the binding; the next launch retries it, so this is not worth blocking on.
        props.onBindFailed(messageOf(cause));
      }
    } catch (cause) {
      // The project exists locally; only sharing did not start, and the board can retry it.
      props.onShareFailed(messageOf(cause));
    } finally {
      setBusy(false);
    }
    props.onCreated(createdLocalProjectId);
  }

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
      <label className={styles.shareField}>
        <input
          type="checkbox"
          checked={share}
          onChange={(event) => setShare(event.target.checked)}
        />
        <span className={styles.shareText}>
          <span className={styles.shareLabel}>
            <Cloud size={13} aria-hidden="true" />
            {t("collab.create.share")}
          </span>
          <small className={styles.fieldHint}>{t("collab.create.shareHint")}</small>
        </span>
      </label>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
    </Modal>
  );
}

function messageOf(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message.trim() : String(cause).trim();
  return raw.startsWith("[") || raw.startsWith("{") ? "" : raw;
}
