import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useDismissReaderNotice, useSession } from "../auth/session";
import { ErrorNotice } from "../components/ui";

/**
 * Tells the admin, once, that reading is open because OPENPARCELS_PASSWORD is not set. That is a
 * supported read-only mode, so this only informs; "Dismiss" hides it for good in every browser.
 */
export function ReaderNotice(): ReactNode {
  const session = useSession();
  const dismiss = useDismissReaderNotice();
  if (session.data?.reader_password_notice !== true) {
    return null;
  }
  return (
    <div className="notice notice-warning reader-notice" role="status">
      <p>
        No reader password is set (<code>OPENPARCELS_PASSWORD</code>): anyone who can reach this
        server can read your parcels and orders, without changing anything. Set one under{" "}
        <Link to="/settings">Settings → Security</Link> to keep reading private.
      </p>
      <button
        type="button"
        className="button"
        disabled={dismiss.isPending}
        onClick={() => {
          dismiss.mutate();
        }}
      >
        Dismiss
      </button>
      {dismiss.isError ? <ErrorNotice error={dismiss.error} /> : null}
    </div>
  );
}
