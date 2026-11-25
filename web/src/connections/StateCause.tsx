import type { ReactNode } from "react";
import type { StateReason } from "../api/types";
import { t } from "../i18n";

/**
 * Why a connection is in its state: the server's reason code in the user's language, then what the
 * provider or carrier said, as written.
 */
export function StateCause(props: {
  readonly reason: StateReason | null;
  readonly carrierMessage: string | null;
  /** `p` on the connection cards, `div` inside the Status page's lists. */
  readonly as?: "p" | "div";
}): ReactNode {
  const { reason, carrierMessage } = props;
  if (reason === null && carrierMessage === null) return null;
  const Tag = props.as ?? "p";
  return (
    <Tag className="muted connection-detail">
      {reason === null ? null : t.connections.stateReasons[reason]}
      {reason !== null && carrierMessage !== null ? " " : null}
      {carrierMessage === null ? null : t.connections.carrierMessage(carrierMessage)}
    </Tag>
  );
}
