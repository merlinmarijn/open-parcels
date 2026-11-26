import { Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
// The one copy of the guide; the server serves the same file as /llms.txt.
import guide from "../../../server/agent-guide.md?raw";
import { t } from "../i18n";
import { Markdown } from "./markdown";

/** "For AI agents": the guide an agent reads at /llms.txt, for the owner to read and hand over. */
export function AgentPage(): ReactNode {
  const [copied, setCopied] = useState<string | null>(null);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(guide);
      setCopied(t.admin.agents.copied);
    } catch {
      // No clipboard over plain HTTP on the LAN: the address works as well.
      setCopied(t.admin.agents.copyUnavailable);
    }
  }

  return (
    <section aria-labelledby="agents-title" className="stack">
      <div className="page-header">
        <h1 id="agents-title">{t.admin.agents.title}</h1>
        <button
          type="button"
          className="button"
          onClick={() => {
            void copy();
          }}
        >
          {t.admin.agents.copy}
        </button>
      </div>
      <div className="card stack">
        <p>
          {t.admin.agents.intro} <a href="llms.txt">{t.admin.agents.address}</a>
          {t.admin.agents.introEnd}
        </p>
        <p>
          {t.admin.agents.tokenBefore} <Link to="/tokens">{t.admin.agents.tokenLink}</Link>
          {t.admin.agents.tokenAfter}
        </p>
        {copied === null ? null : <p role="status">{copied}</p>}
      </div>
      <article className="card">
        <Markdown text={guide} />
      </article>
    </section>
  );
}
