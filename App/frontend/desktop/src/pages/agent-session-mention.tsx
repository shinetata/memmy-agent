import type { LocalSessionCandidate, LocalSessionReference } from "../api/memory-runtime-client.js";
import { agentSourceLogoUrl } from "./agent-source-logos.js";

export const MAX_VISIBLE_SESSION_MENTIONS = 8;

export interface AgentSessionMentionPaletteProps {
  sessions: LocalSessionCandidate[];
  heading: string;
  selectedIndex: number;
  onSelect: (session: LocalSessionCandidate) => void;
}

/** Returns the keyword after a trailing @ token, or null when the person is not mentioning a session. */
export function sessionMentionQueryFromInput(input: string): string | null {
  const match = /(?:^|\s)@([^\s@]*)$/u.exec(input);
  return match ? match[1]! : null;
}

/** Removes the trailing @ token once a session has been picked. */
export function removeSessionMention(input: string): string {
  return input.replace(/(^|\s)@[^\s@]*$/u, "$1");
}

/** Wraps a referenced session as the Markdown attachment the Memmy agent reads. */
export function sessionReferenceFile(reference: LocalSessionReference): File {
  const name = reference.title.replace(/[\\/:*?"<>|\s]+/gu, " ").trim().slice(0, 40) || reference.agentName;
  return new File([reference.markdown], `${name}.md`, { type: "text/markdown" });
}

export function formatSessionMentionTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${date.getMonth() + 1}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function AgentSessionMentionPalette(props: AgentSessionMentionPaletteProps) {
  if (!props.sessions.length) {
    return null;
  }

  return (
    <div className="w-full rounded-card border border-border-stone/40 bg-background-paper shadow-xl overflow-hidden">
      <div id="agent-session-mention-heading" className="px-3 pt-3 pb-1 text-xs text-text-ink/50">
        {props.heading}
      </div>
      <div
        role="listbox"
        aria-labelledby="agent-session-mention-heading"
        className="px-1.5 pb-1.5 overflow-y-auto"
        style={{ maxHeight: "min(432px, calc(100vh - 260px))" }}
      >
        {props.sessions.map((session, index) => {
          const selected = index === props.selectedIndex;
          const logoUrl = agentSourceLogoUrl(session.sourceId);
          return (
            <button
              key={`${session.sourceId}:${session.conversationId}`}
              type="button"
              role="option"
              aria-selected={selected}
              onClick={() => props.onSelect(session)}
              className={`w-full rounded-btn px-2.5 py-2 text-left cursor-pointer transition-colors flex items-start gap-2.5 ${selected ? "bg-canvas-oat/80" : "hover:bg-canvas-oat/50"}`}
            >
              <span className="mt-0.5 w-8 h-8 shrink-0 inline-flex items-center justify-center rounded-btn bg-canvas-oat/70">
                {logoUrl ? <img src={logoUrl} alt="" className="w-4 h-4" /> : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-semibold text-text-ink">{session.title}</span>
                <span className="mt-0.5 block truncate text-[11px] text-text-ink/50">
                  {`${session.agentName} · ${formatSessionMentionTime(session.updatedAt)}`}
                </span>
                {session.lastQuestion && session.lastQuestion !== session.title ? (
                  <span className="mt-0.5 block truncate text-[11px] text-text-ink/40">{session.lastQuestion}</span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
