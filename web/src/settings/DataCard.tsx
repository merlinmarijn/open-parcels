import { useState, type ReactNode } from "react";
import type { PostApiV1DataClearBody } from "../api/generated";
import { useClearData, useDataSummary } from "../api/queries";
import { ErrorNotice, Spinner } from "../components/ui";
import { t } from "../i18n";
import { formatBytes } from "../lib/format";

const EVERYTHING_CONFIRMATION = "DELETE";

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
 * deletion is turned on; clearing one connection's data is on its card on the Connections page.
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
          done.parcels > 0 ? t.settings.data.countParcels(done.parcels) : null,
          done.orders > 0 ? t.settings.data.countOrders(done.orders) : null,
          done.rows > 0 ? t.settings.data.countRows(done.rows) : null,
          done.bytes > 0 ? formatBytes(done.bytes) : null,
        ].filter((part): part is string => part !== null);
        setResult(t.settings.data.removed(parts, done.backup));
      },
    });
  }

  const data = summary.data;
  const busy = clear.isPending;
  return (
    <section className="card stack" aria-labelledby="settings-data">
      <h2 id="settings-data">{t.settings.data.title}</h2>
      <p className="muted">{t.settings.data.intro}</p>
      <ErrorNotice error={summary.error ?? clear.error} />
      {result === null ? null : <p role="status">{result}</p>}
      {data === undefined ? (
        <Spinner />
      ) : (
        <div className="card-table-scroll">
          <table className="data-table">
            <tbody>
              <Row
                label={t.settings.data.database}
                value={formatBytes(data.database_bytes)}
                busy={busy}
              />
              <Row label={t.settings.data.parcels} value={String(data.parcels)} busy={busy} />
              <Row
                label={t.settings.data.archivedParcels}
                value={String(data.archived_parcels)}
                action={t.settings.data.delete}
                busy={busy || data.archived_parcels === 0}
                onAction={() => {
                  run({ what: "archived" }, t.settings.data.confirmArchived(data.archived_parcels));
                }}
              />
              <Row label={t.settings.data.orders} value={String(data.orders)} busy={busy} />
              <Row
                label={t.settings.data.events}
                value={String(data.scans)}
                action={t.settings.data.deleteArchivedEvents}
                busy={busy}
                onAction={() => {
                  run({ what: "archived_scans" }, t.settings.data.confirmArchivedEvents);
                }}
              />
              <Row
                label={t.settings.data.rawPayloads}
                value={String(data.raw_payloads)}
                action={t.settings.data.delete}
                busy={busy || data.raw_payloads === 0}
                onAction={() => {
                  run({ what: "raw_payloads" }, t.settings.data.confirmRaw);
                }}
              />
              <Row label={t.settings.data.eventLog} value={String(data.events)} busy={busy} />
              {(["images", "tiles", "collages"] as const).map((name) => (
                <Row
                  key={name}
                  label={t.settings.data.caches[name]}
                  value={formatBytes(data.cache_bytes[name])}
                  action={t.settings.data.clear}
                  busy={busy || data.cache_bytes[name] === 0}
                  onAction={() => {
                    run({ what: "cache", cache: name }, t.settings.data.confirmCache[name]);
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="stack">
        <label className="field">
          <span>{t.settings.data.olderThan}</span>
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
              run({ what: "older_than", before }, t.settings.data.confirmOlder(before));
            }}
          >
            {t.settings.data.deleteOlder}
          </button>
          <button
            type="button"
            className="button small danger"
            disabled={busy}
            onClick={() => {
              const typed = window.prompt(
                t.settings.data.confirmEverything(EVERYTHING_CONFIRMATION),
              );
              if (typed === null) return;
              setResult(null);
              clear.mutate(
                { what: "everything", confirm: typed },
                {
                  onSuccess: (done) => {
                    setResult(
                      t.settings.data.removedEverything(done.parcels, done.orders, done.backup),
                    );
                  },
                },
              );
            }}
          >
            {t.settings.data.deleteEverything}
          </button>
        </div>
      </div>
    </section>
  );
}
