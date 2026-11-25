import type { ReactNode } from "react";
import type { LookupState, ParcelStatus, ConnectionState } from "../api/types";
import { LOOKUP_LABELS, CONNECTION_STATE_LABELS, STATUS_LABELS } from "../lib/format";
import { t } from "../i18n";

export function StatusBadge(props: {
  readonly status: ParcelStatus;
  readonly manual?: boolean;
}): ReactNode {
  return (
    <span className={`badge status-${props.status}`}>
      {STATUS_LABELS[props.status]}
      {props.manual === true ? <span title={t.parcels.setByHand}> ✎</span> : null}
    </span>
  );
}

/** Archived parcels are kept but hidden from the default list. */
export function ArchivedBadge(): ReactNode {
  return <span className="badge archived">{t.parcels.archived}</span>;
}

export function LookupBadge({ state }: { readonly state: LookupState }): ReactNode {
  return <span className={`badge lookup-${state}`}>{LOOKUP_LABELS[state]}</span>;
}

/**
 * A connection the server calls OK but that never had a successful run has not been judged yet: it
 * shows a neutral "Not run yet" rather than claiming OK. An idle connection (it ran but had nothing it
 * could do, e.g. DPD with public tracking off) shows "Idle"; its detail says why.
 */
export function ConnectionStateBadge(props: {
  readonly state: ConnectionState;
  readonly lastOkAt: string | null;
}): ReactNode {
  if (props.state === "idle") {
    return <span className="badge connection-pending">{CONNECTION_STATE_LABELS.idle}</span>;
  }
  if (props.state === "ok" && props.lastOkAt === null) {
    return <span className="badge connection-pending">{t.parcels.notRunYet}</span>;
  }
  return (
    <span className={`badge connection-${props.state}`}>
      {CONNECTION_STATE_LABELS[props.state]}
    </span>
  );
}
