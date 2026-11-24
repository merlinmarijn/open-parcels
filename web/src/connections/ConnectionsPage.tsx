import { Eraser, Mail, Pause, Pencil, Play, Trash2 } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import {
  connectionDataCounts,
  useCarriers,
  useClearConnection,
  useDeleteConnection,
  useParcels,
  useConnections,
  useSyncConnection,
  useUpdateConnection,
} from "../api/queries";
import type { Carrier, Parcel, Connection } from "../api/types";
import { CarrierLogo } from "../components/CarrierLogo";
import { useIsAdmin } from "../auth/session";
import { ErrorNotice, ReadOnlyHint, Spinner } from "../components/ui";
import { formatRelative } from "../lib/format";
import { ConnectionStateBadge } from "../parcels/badges";
import { INBOX_PROVIDER } from "./inbox";
import { SignInDialog } from "./SignInDialog";
import { ConnectionDialog } from "./ConnectionDialog";

type Editing =
  { readonly mode: "add" } | { readonly mode: "edit"; readonly connection: Connection } | null;

/**
 * False when every sign-in flow the connection's provider offers for its kind needs nothing (type
 * `none`), so a "Sign in" button would lead nowhere. Inboxes always sign in; unknown providers
 * and a connection the server says needs a sign-in keep the button.
 */
export function canSignIn(
  connection: Connection,
  carriers: readonly Carrier[] | undefined,
): boolean {
  if (connection.provider === INBOX_PROVIDER || connection.state === "needs_sign_in") return true;
  const carrier = carriers?.find((c) => c.id === connection.provider);
  if (carrier === undefined) return true;
  return carrier.sign_in_flows.some(
    (flow) => flow.type !== "none" && (flow.kinds as readonly string[]).includes(connection.kind),
  );
}

export interface ConnectionStats {
  readonly active: number;
  readonly delivered: number;
  readonly total: number;
}

const NO_STATS: ConnectionStats = { active: 0, delivered: 0, total: 0 };

/** Parcels per connection (archived included): on the way, delivered, and all it has found. */
export function statsByConnection(
  parcels: readonly Parcel[],
): ReadonlyMap<string, ConnectionStats> {
  const stats = new Map<string, ConnectionStats>();
  for (const parcel of parcels) {
    for (const ref of new Set(parcel.connections.map((entry) => entry.connection_id))) {
      const current = stats.get(ref) ?? NO_STATS;
      stats.set(ref, {
        active: current.active + (parcel.delivered || parcel.archived_at !== null ? 0 : 1),
        delivered: current.delivered + (parcel.delivered ? 1 : 0),
        total: current.total + 1,
      });
    }
  }
  return stats;
}

function Stat(props: { readonly label: string; readonly value: number | string }): ReactNode {
  return (
    <div className="connection-stat">
      <span className="connection-stat-value">{props.value}</span>
      <span className="connection-stat-label">{props.label}</span>
    </div>
  );
}

function ConnectionRow(props: {
  readonly connection: Connection;
  readonly stats: ConnectionStats | undefined;
  readonly signIn: boolean;
  /** Readers see the card without its actions. */
  readonly admin: boolean;
  readonly onEdit: () => void;
  readonly onSignIn: () => void;
}): ReactNode {
  const { connection } = props;
  const stats = props.stats ?? NO_STATS;
  return (
    <li className="card connection-card">
      <div className="connection-head">
        {connection.provider === INBOX_PROVIDER ? (
          <span className="connection-mail-icon" aria-hidden="true">
            <Mail size={18} />
          </span>
        ) : (
          <CarrierLogo carrier={connection.provider} size={32} />
        )}
        <div className="connection-title">
          <h2 title={connection.label}>{connection.label}</h2>
          <span className="muted">
            {connection.provider} · {connection.kind}
          </span>
        </div>
        <ConnectionStateBadge state={connection.state} lastOkAt={connection.last_ok_at} />
      </div>
      {connection.state_detail === null ? null : (
        <p className="muted connection-detail">{connection.state_detail}</p>
      )}
      <div className="connection-stats">
        <Stat label="on the way" value={stats.active} />
        <Stat label="delivered" value={stats.delivered} />
        <Stat label="parcels found" value={stats.total} />
      </div>
      <dl className="connection-times">
        <dt>Last run</dt>
        <dd>{formatRelative(connection.last_run_at)}</dd>
        <dt>Last success</dt>
        <dd>{formatRelative(connection.last_ok_at)}</dd>
        <dt>Next run</dt>
        <dd>{connection.next_run_at === null ? "—" : formatRelative(connection.next_run_at)}</dd>
      </dl>
      {props.admin ? <ConnectionActions {...props} /> : null}
    </li>
  );
}

/** Sign in, sync, edit, pause and remove: the admin's controls on a connection card. */
function ConnectionActions(props: {
  readonly connection: Connection;
  readonly signIn: boolean;
  readonly onEdit: () => void;
  readonly onSignIn: () => void;
}): ReactNode {
  const { connection } = props;
  const sync = useSyncConnection();
  const update = useUpdateConnection();
  const remove = useDeleteConnection();
  const clear = useClearConnection();
  const [counting, setCounting] = useState(false);
  const enabled = connection.state !== "disabled";
  return (
    <>
      <ErrorNotice error={sync.error ?? update.error ?? remove.error ?? clear.error} />
      <div className="actions">
        {/* A disabled connection neither runs nor signs in; enabling it comes first. */}
        {enabled && props.signIn ? (
          <button
            type="button"
            className={
              connection.state === "needs_sign_in" ? "button small primary" : "button small"
            }
            onClick={props.onSignIn}
          >
            {connection.has_secret ? "Sign in again" : "Sign in"}
          </button>
        ) : null}
        {enabled ? (
          <button
            type="button"
            className="button small"
            disabled={sync.isPending}
            onClick={() => {
              sync.mutate(connection.id);
            }}
          >
            {sync.isPending ? "Syncing…" : "Sync now"}
          </button>
        ) : null}
        <span className="connection-icon-actions">
          <button
            type="button"
            className="icon-button"
            aria-label="Edit"
            title="Edit"
            onClick={props.onEdit}
          >
            <Pencil size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={enabled ? "Disable" : "Enable"}
            title={enabled ? "Disable" : "Enable"}
            aria-pressed={!enabled}
            onClick={() => {
              update.mutate({ id: connection.id, body: { enabled: !enabled } });
            }}
          >
            {enabled ? (
              <Pause size={16} aria-hidden="true" />
            ) : (
              <Play size={16} aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Clear data"
            title="Clear data: remove what this connection imported, so it syncs again from scratch"
            disabled={counting || clear.isPending}
            onClick={() => {
              setCounting(true);
              void connectionDataCounts(connection.id)
                .then((counts) => {
                  const shared =
                    counts.shared > 0
                      ? ` ${String(counts.shared)} that other connections also reported stay.`
                      : "";
                  const question =
                    `Clear the data of “${connection.label}”? This deletes ${String(counts.parcels)} ` +
                    `parcels and ${String(counts.orders)} orders only it reported.${shared} The ` +
                    "connection and its sign-in stay, and it syncs again from scratch.";
                  if (window.confirm(question)) {
                    clear.mutate(connection.id);
                  }
                })
                .finally(() => {
                  setCounting(false);
                });
            }}
          >
            <Eraser size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button danger"
            aria-label="Remove"
            title="Remove"
            onClick={() => {
              if (window.confirm(`Remove “${connection.label}” and its stored sign-in?`)) {
                remove.mutate(connection.id);
              }
            }}
          >
            <Trash2 size={16} aria-hidden="true" />
          </button>
        </span>
      </div>
    </>
  );
}

export function ConnectionsPage(): ReactNode {
  const admin = useIsAdmin();
  const connections = useConnections();
  const carriers = useCarriers();
  const parcels = useParcels(true);
  const stats = useMemo(() => statsByConnection(parcels.data ?? []), [parcels.data]);
  const list = connections.data ?? [];
  const working = list.filter(
    (connection) => connection.state === "ok" || connection.state === "idle",
  ).length;
  const attention = list.filter(
    (connection) =>
      connection.state !== "ok" && connection.state !== "idle" && connection.state !== "disabled",
  ).length;
  const [editing, setEditing] = useState<Editing>(null);
  const [signingIn, setSigningIn] = useState<Connection | null>(null);

  return (
    <section aria-labelledby="connections-title">
      <div className="page-header">
        <h1 id="connections-title">Connections</h1>
        {list.length === 0 ? null : (
          <div className="connection-summary">
            <Stat label="connections" value={list.length} />
            <Stat label="working" value={working} />
            <Stat label="need attention" value={attention} />
            <Stat
              label="parcels on the way"
              value={
                parcels.data?.filter((p) => !p.delivered && p.archived_at === null).length ?? "…"
              }
            />
          </div>
        )}
        {admin ? (
          <button
            type="button"
            className="button primary"
            onClick={() => {
              setEditing({ mode: "add" });
            }}
          >
            Add a connection
          </button>
        ) : null}
      </div>
      {admin ? null : <ReadOnlyHint />}
      <ErrorNotice error={connections.error} />
      {connections.data === undefined ? (
        connections.isPending ? (
          <Spinner />
        ) : null
      ) : connections.data.length === 0 ? (
        <p className="muted">No connections yet. Add a carrier account, a shop or an inbox.</p>
      ) : (
        <ul className="plain-list connection-grid">
          {connections.data.map((connection) => (
            <ConnectionRow
              key={connection.id}
              connection={connection}
              stats={stats.get(connection.id)}
              signIn={canSignIn(connection, carriers.data)}
              admin={admin}
              onEdit={() => {
                setEditing({ mode: "edit", connection });
              }}
              onSignIn={() => {
                setSigningIn(connection);
              }}
            />
          ))}
        </ul>
      )}
      {editing === null ? null : (
        <ConnectionDialog
          key={editing.mode === "edit" ? editing.connection.id : "add"}
          open
          editing={editing.mode === "edit" ? editing.connection : null}
          onClose={() => {
            setEditing(null);
          }}
          onCreated={(connection) => {
            setEditing(null);
            // A new connection that signs in and has nothing stored goes straight to its sign-in.
            if (!connection.has_secret && canSignIn(connection, carriers.data)) {
              setSigningIn(connection);
            }
          }}
        />
      )}
      <SignInDialog
        key={signingIn?.id ?? "none"}
        connection={signingIn}
        onClose={() => {
          setSigningIn(null);
        }}
      />
    </section>
  );
}
