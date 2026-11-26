import { Link } from "@tanstack/react-router";
import { ShieldAlert, X } from "lucide-react";
import type { ReactNode } from "react";
import { useDismissReaderNotice, useSession } from "../auth/session";
import { ErrorNotice } from "../components/ui";
import { t } from "../i18n";

/** The environment variable that sets the reader password (a name, not text to translate). */
const PASSWORD_VARIABLE = "OPENPARCELS_PASSWORD";

/**
 * Tells the admin, once, that reading is open because OPENPARCELS_PASSWORD is not set. That is a
 * supported read-only mode, so this only informs, in one slim line; dismissing hides it for good
 * in every browser.
 */
export function ReaderNotice(): ReactNode {
  const session = useSession();
  const dismiss = useDismissReaderNotice();
  if (session.data?.reader_password_notice !== true) {
    return null;
  }
  return (
    <div className="reader-notice" role="status">
      <ShieldAlert size={16} aria-hidden="true" />
      <p title={PASSWORD_VARIABLE}>
        {t.shell.readerNotice}{" "}
        <Link to="/settings" hash="settings-security">
          {t.shell.readerNoticeLink}
        </Link>
      </p>
      <button
        type="button"
        className="icon-button"
        aria-label={t.shell.dismiss}
        title={t.shell.dismiss}
        disabled={dismiss.isPending}
        onClick={() => {
          dismiss.mutate();
        }}
      >
        <X size={16} aria-hidden="true" />
      </button>
      {dismiss.isError ? <ErrorNotice error={dismiss.error} /> : null}
    </div>
  );
}
