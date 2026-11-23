import { useState, type ReactNode } from "react";
import type { PostApiV1DataClearBody } from "../api/generated";
import { useClearData, useDataSummary } from "../api/queries";
import { ErrorNotice, Spinner } from "../components/ui";

const EVERYTHING_CONFIRMATION = "DELETE";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit] ?? "TB"}`;
}

function Row(props: {
  readonly label: string;
  readonly value: string;
  readonly action?: string;
  readonly busy: boolean;
  readonly onAction?: () => void;
}): ReactNode {
  return (
    <tr>
      <th scope="row">{props.label}</th>
      <td>{props.value}</td>
      <td>
        {props.action === undefined ? null : (
          <button
            type="button"
            className="button small"
            disabled={props.busy}
            onClick={props.onAction}
          >
            {props.action}
          </button>
        )}
      </td>
    </tr>
  );
}

/**
 * What is stored and the owner's clean-up actions. Nothing is deleted on its own unless automatic
 * deletion is turned on; clearing one source's data is on its card on the Sources page.
 */
export function DataCard(): ReactNode {
  const summary = useDataSummary();
  const clear = useClearData();
  const [before, setBefore] = useState("");
  const [result, setResult] = useState<string | null>(null);

  function run(body: PostApiV1DataClearBody, question: string): void {
    if (!window.confirm(question)) return;
    setResult(null);
    clear.mutate(body, {
      onSuccess: (done) => {
        const parts = [
          done.parcels > 0 ? `${String(done.parcels)} parcels` : null,
          done.orders > 0 ? `${String(done.orders)} orders` : null,
          done.rows > 0 ? `${String(done.rows)} rows` : null,
          done.bytes > 0 ? formatBytes(done.bytes) : null,
        ].filter((part): part is string => part !== null);
        const backup = done.backup === null ? "" : ` A backup was saved as ${done.backup}.`;
        setResult(`Removed ${parts.length > 0 ? parts.join(", ") : "nothing"}.${backup}`);
      },
    });
  }

  const data = summary.data;
  const busy = clear.isPending;
  return (
    <section className="card stack" aria-labelledby="settings-data">
      <h2 id="settings-data">Data</h2>
      <p className="muted">
        Everything is kept until you delete it here. To re-import one source, use “Clear data” on
        its card on the Sources page.
      </p>
      <ErrorNotice error={summary.error ?? clear.error} />
      {result === null ? null : <p role="status">{result}</p>}
      {data === undefined ? (
        <Spinner />
      ) : (
        <table className="data-table">
          <tbody>
            <Row label="Database" value={formatBytes(data.database_bytes)} busy={busy} />
            <Row label="Parcels" value={String(data.parcels)} busy={busy} />
            <Row
              label="Archived parcels"
              value={String(data.archived_parcels)}
              action="Delete"
              busy={busy || data.archived_parcels === 0}
              onAction={() => {
                run(
                  { what: "archived" },
                  `Delete ${String(data.archived_parcels)} archived parcels with their history?`,
                );
              }}
            />
            <Row label="Orders" value={String(data.orders)} busy={busy} />
            <Row
              label="Tracking scans"
              value={String(data.scans)}
              action="Delete those of archived parcels"
              busy={busy}
              onAction={() => {
                run(
                  { what: "archived_scans" },
                  "Delete the tracking scans of archived parcels? The parcels stay.",
                );
              }}
            />
            <Row
              label="Raw carrier answers"
              value={String(data.raw_payloads)}
              action="Delete"
              busy={busy || data.raw_payloads === 0}
              onAction={() => {
                run(
                  { what: "raw_payloads" },
                  "Delete the raw carrier answers? They only help diagnosing a plug-in.",
                );
              }}
            />
            <Row label="Live event log" value={String(data.events)} busy={busy} />
            {(["images", "tiles", "collages"] as const).map((name) => (
              <Row
                key={name}
                label={`${name[0]?.toUpperCase() ?? ""}${name.slice(1)} cache`}
                value={formatBytes(data.cache_bytes[name])}
                action="Clear"
                busy={busy || data.cache_bytes[name] === 0}
                onAction={() => {
                  run(
                    { what: "cache", cache: name },
                    `Clear the ${name} cache? It refills itself.`,
                  );
                }}
              />
            ))}
          </tbody>
        </table>
      )}
      <div className="stack">
        <label className="field">
          <span>Delete finished parcels and orders older than</span>
          <input
            type="date"
            value={before}
            onChange={(event) => {
              setBefore(event.target.value);
            }}
          />
        </label>
        <div className="actions">
          <button
            type="button"
            className="button small"
            disabled={busy || before === ""}
            onClick={() => {
              run(
                { what: "older_than", before },
                `Delete delivered or archived parcels last seen before ${before}, and orders placed before it without parcels? Parcels still on their way stay.`,
              );
            }}
          >
            Delete older data
          </button>
          <button
            type="button"
            className="button small danger"
            disabled={busy}
            onClick={() => {
              const typed = window.prompt(
                `Delete every parcel and order? Sources, sign-ins and settings stay, and a database backup is saved first. Type ${EVERYTHING_CONFIRMATION} to confirm.`,
              );
              if (typed === null) return;
              setResult(null);
              clear.mutate(
                { what: "everything", confirm: typed },
                {
                  onSuccess: (done) => {
                    setResult(
                      `Removed ${String(done.parcels)} parcels and ${String(done.orders)} orders. Backup: ${done.backup ?? "none"}.`,
                    );
                  },
                },
              );
            }}
          >
            Delete everything…
          </button>
        </div>
      </div>
    </section>
  );
}
