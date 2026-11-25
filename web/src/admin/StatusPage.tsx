import type { ReactNode } from "react";
import type { GetApiV1Status200, GetApiV1Status200ConnectionsItem } from "../api/generated";
import { useDiagnostics, useStatus } from "../api/queries";
import { useIsAdmin } from "../auth/session";
import { ErrorNotice, ReadOnlyHint, Spinner } from "../components/ui";
import { formatDateTime, formatRelative } from "../lib/format";
import { ConnectionStateBadge } from "../parcels/badges";

type CheckState = GetApiV1Status200["status"];
type CheckName = keyof GetApiV1Status200["checks"];

const STATE_LABELS: Readonly<Record<CheckState, string>> = {
  ok: "OK",
  degraded: "Needs attention",
  unavailable: "Unavailable",
};

const CHECK_LABELS: Readonly<Record<CheckName, string>> = {
  database: "Database",
  connections: "Connections",
  inboxes: "Inboxes",
  scheduler: "Scheduler",
  event_stream: "Live event stream",
  backups: "Backups",
};

function download(data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `open-parcels-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function CheckBadge({ state }: { readonly state: CheckState }): ReactNode {
  return <span className={`badge check-${state}`}>{STATE_LABELS[state]}</span>;
}

function ConnectionLine(props: {
  readonly connection: GetApiV1Status200ConnectionsItem;
  readonly extra?: string;
}): ReactNode {
  const { connection } = props;
  return (
    <li>
      <ConnectionStateBadge state={connection.state} lastOkAt={connection.last_ok_at} />{" "}
      <strong>{connection.label}</strong>{" "}
      <span className="muted">
        {props.extra === undefined ? "" : `${props.extra}, `}last run{" "}
        {formatRelative(connection.last_run_at)}, last success{" "}
        {formatRelative(connection.last_ok_at)}
        {connection.backoff_until === null
          ? ""
          : `, paused by the carrier until ${formatDateTime(connection.backoff_until)}`}
      </span>
      {connection.detail === null ? null : <div className="muted">{connection.detail}</div>}
    </li>
  );
}

function Overview({ status }: { readonly status: GetApiV1Status200 }): ReactNode {
  return (
    <section className="card" aria-labelledby="health-title">
      <h2 id="health-title">Service</h2>
      <p role="status">
        <CheckBadge state={status.status} />{" "}
        <span className="muted">
          Version {status.version}, running since {formatDateTime(status.started_at)}
        </span>
      </p>
      <ul className="plain-list">
        {(Object.keys(CHECK_LABELS) as CheckName[]).map((name) => (
          <li key={name}>
            <CheckBadge state={status.checks[name]} /> {CHECK_LABELS[name]}
          </li>
        ))}
      </ul>
      {status.database.detail === null ? null : (
        <p className="muted">Database: {status.database.detail}</p>
      )}
    </section>
  );
}

function Background({ status }: { readonly status: GetApiV1Status200 }): ReactNode {
  const { scheduler, event_stream: stream, backups } = status;
  return (
    <section className="card" aria-labelledby="background-title">
      <h2 id="background-title">Background work</h2>
      <ul className="plain-list">
        <li>
          <CheckBadge state={status.checks.scheduler} /> <strong>Scheduler</strong>{" "}
          <span className="muted">
            {scheduler.running ? "running" : "stopped"}, {String(scheduler.in_flight)} runs in
            progress, last pass {formatRelative(scheduler.last_cycle_at)}, next run{" "}
            {formatRelative(scheduler.next_run_at)}
          </span>
          {scheduler.last_error === null ? null : (
            <div className="muted">{scheduler.last_error}</div>
          )}
        </li>
        <li>
          <CheckBadge state={status.checks.event_stream} /> <strong>Live event stream</strong>{" "}
          <span className="muted">
            {String(stream.clients)} clients connected, {String(stream.stored)} events kept for
            replay, {String(stream.live_sessions)} couriers followed live
          </span>
        </li>
        <li>
          <CheckBadge state={status.checks.backups} /> <strong>Backups</strong>{" "}
          <span className="muted">
            {backups.enabled ? `next ${formatRelative(backups.next_at)}` : "automatic backups off"}
            {backups.last_at === null
              ? ", none yet"
              : `, last ${formatRelative(backups.last_at)} (${backups.last_ok === true ? "succeeded" : "failed"})`}
          </span>
          {backups.last_error === null ? null : <div className="muted">{backups.last_error}</div>}
        </li>
      </ul>
    </section>
  );
}

export function StatusPage(): ReactNode {
  const status = useStatus();
  const admin = useIsAdmin();
  const data = status.data;

  return (
    <section aria-labelledby="status-title">
      <div className="page-header">
        <h1 id="status-title">Status</h1>
      </div>
      <ErrorNotice error={status.error} />
      {data === undefined ? (
        <Spinner />
      ) : (
        <>
          <Overview status={data} />
          <section className="card" aria-labelledby="connections-status-title">
            <h2 id="connections-status-title">Connections</h2>
            {data.connections.length === 0 ? <p className="muted">None yet.</p> : null}
            <ul className="plain-list">
              {data.connections.map((connection) => (
                <ConnectionLine key={connection.id} connection={connection} />
              ))}
            </ul>
          </section>
          <section className="card" aria-labelledby="inboxes-status-title">
            <h2 id="inboxes-status-title">Inboxes</h2>
            {data.inboxes.length === 0 ? <p className="muted">None yet.</p> : null}
            <ul className="plain-list">
              {data.inboxes.map((inbox) => (
                <ConnectionLine
                  key={inbox.id}
                  connection={inbox}
                  extra={
                    inbox.connected
                      ? "watching for new email"
                      : inbox.reconnect_at === null
                        ? "not connected"
                        : `reconnecting ${formatRelative(inbox.reconnect_at)}`
                  }
                />
              ))}
            </ul>
          </section>
          <Background status={data} />
        </>
      )}
      <section className="card" aria-labelledby="diag-title">
        <h2 id="diag-title">Diagnostics</h2>
        {admin ? <Diagnostics /> : <ReadOnlyHint>Diagnostics are for the admin only.</ReadOnlyHint>}
      </section>
    </section>
  );
}

/** Only mounted for the admin, so readers do not ask for what they may not see. */
function Diagnostics(): ReactNode {
  const diagnostics = useDiagnostics();
  return (
    <>
      <p className="muted">
        Redacted on the server: no tracking numbers, addresses or sign-in data.
      </p>
      <ErrorNotice error={diagnostics.error} />
      <div className="actions">
        <button
          type="button"
          className="button"
          disabled={diagnostics.data === undefined}
          onClick={() => {
            download(diagnostics.data);
          }}
        >
          Download diagnostics
        </button>
      </div>
      {diagnostics.data === undefined ? null : (
        <details>
          <summary>Show</summary>
          <pre className="diagnostics">{JSON.stringify(diagnostics.data, null, 2)}</pre>
        </details>
      )}
    </>
  );
}
