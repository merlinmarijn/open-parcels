import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useDismissReaderNotice, useSession } from "../auth/session";
import { ErrorNotice } from "../components/ui";
import { t } from "../i18n";

/** The environment variable that sets the reader password (a name, not text to translate). */
const PASSWORD_VARIABLE = "OPENPARCELS_PASSWORD";

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
        {t.shell.readerNoticeBefore}
        <code>{PASSWORD_VARIABLE}</code>
        {t.shell.readerNoticeMiddle}
        <Link to="/settings">{t.shell.readerNoticeLink}</Link>
        {t.shell.readerNoticeAfter}
      </p>
      <button
        type="button"
        className="button"
        disabled={dismiss.isPending}
        onClick={() => {
          dismiss.mutate();
        }}
      >
        {t.shell.dismiss}
      </button>
      {dismiss.isError ? <ErrorNotice error={dismiss.error} /> : null}
    </div>
  );
}
