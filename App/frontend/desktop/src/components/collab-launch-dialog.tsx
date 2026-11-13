/**
 * The one-time project-collaboration announcement: one page with the same shell and layout as the History
 * announcement, using a CSS conversation instead of an illustration. The primary button asks for the agent
 * authorization right here, so nobody has to go through the separate access dialog, and then opens the new-project
 * dialog with sharing already on.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { CollabAgentAccessView, CollabAgentInstallResult, CollabClient } from "../api/collab-client.js";
import { useTranslation } from "../i18n/use-translation.js";
import { agentSourceDisplayName, agentSourceLogoUrl } from "../pages/agent-source-logos.js";
import "./collab-launch-dialog.css";

/** The agent the example conversation happens in. */
const EXAMPLE_AGENT_SOURCE = "claude_code";

export interface CollabLaunchDialogProps {
  onClose(): void;
  /** Once authorization is settled: close the announcement and open the new-project dialog with sharing on. */
  onCreateProject(): void;
  /**
   * Authorizes and installs the collaboration components into the local agents. Absent in tests and previews without
   * providers: the card then only offers the new-project button.
   */
  collab?: CollabClient | null;
}

export function CollabLaunchDialog(props: CollabLaunchDialogProps) {
  const { t, language } = useTranslation();
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef(props.onClose);
  closeRef.current = props.onClose;
  const collab = props.collab ?? null;

  const [access, setAccess] = useState<CollabAgentAccessView | null>(null);
  const [loading, setLoading] = useState(collab !== null);
  const [installing, setInstalling] = useState(false);
  const [results, setResults] = useState<CollabAgentInstallResult[]>([]);
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current();
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", onKey, true);
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  // Reads the current authorization once: it decides whether the card offers the authorization or the project.
  useEffect(() => {
    if (!collab) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    collab.getAgentAccess()
      .then((view) => {
        if (cancelled) return;
        setAccess(view);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [collab]);

  const granted = access?.granted === true;
  const canAuthorize = collab !== null;
  const failed = results.filter((item) => !item.ok);
  const doneCount = results.filter((item) => item.ok).length;
  const nameSeparator = language === "en-US" ? ", " : "、";

  async function grant() {
    if (!collab || installing) return;
    setInstalling(true);
    setError(null);
    try {
      const result = await collab.setAgentAccess(true);
      setAccess(result.view);
      setResults(result.results);
    } catch {
      setError(t("collabLaunch.failed"));
    } finally {
      setInstalling(false);
    }
  }

  async function retry() {
    if (!collab || installing) return;
    const pending = failed.map((item) => item.sourceId);
    setInstalling(true);
    setError(null);
    try {
      const result = await collab.installAgentAccess(pending);
      setResults((current) => [...current.filter((item) => !pending.includes(item.sourceId)), ...result.results]);
      setAccess(result.view);
    } catch {
      setError(t("collabLaunch.failed"));
    } finally {
      setInstalling(false);
    }
  }

  /** The agents the authorization currently covers: enabled and available on this computer. */
  const names = (access?.agents ?? [])
    .filter((agent) => agent.available && agent.enabled)
    .map((agent) => agent.name);
  const nameList = names.join(nameSeparator);

  const primaryLabel = !granted && canAuthorize
    ? installing ? t("collabLaunch.authorizing") : t("collabLaunch.authorize")
    : t("collabLaunch.create");

  const footnote = granted
    ? nameList
      ? t("collabLaunch.footnoteGranted", { names: nameList })
      : t("collabLaunch.footnoteGrantedPlain")
    : access !== null && names.length === 0
      ? t("collabLaunch.footnoteEmpty")
      : nameList
        ? t("collabLaunch.footnoteAgents", { names: nameList })
        : t("collabLaunch.footnotePlain");

  if (typeof document === "undefined") return null;

  const logo = agentSourceLogoUrl(EXAMPLE_AGENT_SOURCE);
  const exampleAgent = agentSourceDisplayName(EXAMPLE_AGENT_SOURCE);

  return createPortal(
    <div
      className="collab-launch-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="collab-launch-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="collab-launch-title"
        aria-describedby="collab-launch-footnote"
        tabIndex={-1}
        onKeyDown={trapFocus}
      >
        <button className="collab-launch-close" type="button" aria-label={t("common.close")} onClick={props.onClose}>
          <X size={18} aria-hidden="true" />
        </button>
        <p className="collab-launch-eyebrow">{t("collabLaunch.eyebrow")}</p>
        <h2 id="collab-launch-title">{t("collabLaunch.title")}</h2>
        <div className="collab-launch-card">
          <div className="collab-launch-copy">
            <h3>{t("collabLaunch.subtitle")}</h3>
            <p id="collab-launch-body" className="collab-launch-text">{t("collabLaunch.description")}</p>
            <p className="collab-launch-text">{t("collabLaunch.benefit")}</p>
            <div className="collab-launch-actions">
              <button
                className="collab-launch-primary"
                type="button"
                disabled={installing || (canAuthorize && loading)}
                onClick={() => {
                  if (!granted && canAuthorize) {
                    void grant();
                    return;
                  }
                  props.onCreateProject();
                }}
              >
                {primaryLabel}
              </button>
              {failed.length && !installing ? (
                <button className="collab-launch-retry" type="button" onClick={() => void retry()}>
                  {t("collabLaunch.retry")}
                </button>
              ) : null}
            </div>
            {error ? (
              <p className="collab-launch-status collab-launch-status--error" role="alert">{error}</p>
            ) : granted && results.length ? (
              <p className="collab-launch-status" role="status">
                {failed.length
                  ? t("collabLaunch.partial", { done: String(doneCount), names: failed.map((item) => item.name).join(nameSeparator) })
                  : t("collabLaunch.installed", { count: String(doneCount) })}
              </p>
            ) : null}
          </div>
          <div className="collab-launch-visual" aria-hidden="true">
            <div className="collab-launch-visual__glow" />
            <div className="collab-launch-example">
              <div className="collab-launch-example__head">
                {logo ? <img className="collab-launch-example__logo" src={logo} alt="" /> : null}
                <span>{exampleAgent}</span>
              </div>
              <p className="collab-launch-chat__user">{t("collabLaunch.visualUser")}</p>
              <p className="collab-launch-chat__agent">{t("collabLaunch.visualAgent")}</p>
            </div>
            <div className="collab-launch-visual__caption">{t("collabLaunch.visualCaption")}</div>
          </div>
        </div>
        <p id="collab-launch-footnote" className="collab-launch-footnote">{footnote}</p>
      </section>
    </div>,
    document.body
  );
}

/** Keeps Tab and Shift+Tab inside the dialog, the same way the History announcement does. */
function trapFocus(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "Tab") return;
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], [tabindex="0"]'));
  const first = items[0];
  const last = items.at(-1);
  if (!first || !last) {
    event.preventDefault();
  } else if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === event.currentTarget)) {
    first.focus();
  }
}
