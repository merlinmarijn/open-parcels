import type { ReactNode } from "react";
import { useInboxSync } from "../api/queries";
import type { InboxSync } from "../api/types";
import { t } from "../i18n";
import { formatRelative } from "../lib/format";
import { formatNumber } from "../lib/locale";

type Step = InboxSync["steps"][number];
const text = t.connections.inboxSync;

/** One log line: a phase with at most a folder name and a count, never anything from a mail. */
function stepText(step: Step): string {
  const folder = step.folder ?? "";
  const count = step.count ?? 0;
  switch (step.phase) {
    case "searching":
      return text.searching(folder);
    case "reading":
      return step.count === null
        ? text.newIn(folder)
        : text.toRead(count, formatNumber(count), folder);
    case "saving":
      return text.saving(count, formatNumber(count));
    case "done":
      return text.done(count, formatNumber(count));
    case "connecting":
    case "failed":
      return text.phase[step.phase];
  }
}

function nowText(sync: InboxSync): string {
  const folder = sync.folder ?? "";
  if (sync.phase === "searching") return text.searching(folder);
  if (sync.phase !== "reading") return text.phase[sync.phase];
  return sync.total === null
    ? text.readingNew(formatNumber(sync.done), folder)
    : text.reading(formatNumber(sync.done), formatNumber(sync.total), folder);
}

function Activity(props: { readonly steps: InboxSync["steps"] }): ReactNode {
  return (
    <ol className="inbox-sync-log" aria-label={text.activity}>
      {props.steps.map((step, index) => (
        // Steps only ever grow at the end (the oldest drop off), so index and time key them.
        <li key={`${step.at}-${String(index)}`}>
          <time dateTime={step.at}>{new Date(step.at).toLocaleTimeString()}</time> {stepText(step)}
        </li>
      ))}
    </ol>
  );
}

/**
 * An inbox's sync, live: what it does now, how far it is, what it found and its last steps.
 * A finished sync folds into one line, its steps behind "Details".
 */
export function InboxSyncPanel(props: { readonly connectionId: string }): ReactNode {
  const query = useInboxSync(props.connectionId);
  const sync = query.data;
  if (sync === undefined || sync === null) return null;
  const found = text.found(
    formatNumber(sync.parcels),
    formatNumber(sync.orders),
    formatNumber(sync.returns),
    formatNumber(sync.ignored),
  );
  if (sync.phase === "done") {
    return (
      <details className="connection-job inbox-sync">
        <summary>
          {text.last(
            formatRelative(sync.finished_at),
            sync.read,
            formatNumber(sync.read),
            formatNumber(sync.parcels),
          )}
        </summary>
        <p className="muted">{found}</p>
        <Activity steps={sync.steps} />
      </details>
    );
  }
  return (
    <section className="connection-job inbox-sync" aria-label={text.title}>
      <div className="connection-job-head">
        <strong>{text.title}</strong>
        <span className="badge">{text.phase[sync.phase]}</span>
      </div>
      {sync.phase === "failed" ? (
        <p role="alert">{sync.error === null ? text.phase.failed : text.errors[sync.error]}</p>
      ) : (
        <>
          <progress
            aria-label={text.phase[sync.phase]}
            {...(sync.total === null || sync.total === 0
              ? {}
              : { value: sync.done, max: sync.total })}
          />
          <p aria-live="polite">{nowText(sync)}</p>
        </>
      )}
      <p className="muted">{found}</p>
      <Activity steps={sync.steps} />
    </section>
  );
}
