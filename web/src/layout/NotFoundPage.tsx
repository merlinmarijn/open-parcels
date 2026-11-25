import { Link } from "@tanstack/react-router";
import { PackageX } from "lucide-react";
import type { ReactNode } from "react";
import { t } from "../i18n";

/** Shown for any address the app does not know, inside the usual frame, with a way back. */
export function NotFoundPage(): ReactNode {
  return (
    <section aria-labelledby="not-found-title" className="stack">
      <div className="glass-panel panel not-found">
        <div className="empty-state">
          <PackageX size={48} aria-hidden="true" />
          <h1 id="not-found-title">{t.shell.notFoundTitle}</h1>
          <p className="muted">{t.shell.notFoundText}</p>
          <Link to="/" className="button primary">
            {t.shell.notFoundBack}
          </Link>
        </div>
      </div>
    </section>
  );
}
