/** Returns from shop accounts and return mails: still going on, finished, or all. */
import { Segmented } from "../components/Segmented";
import { Undo2 } from "lucide-react";
import type { ReactNode } from "react";
import { useReturns } from "../api/queries";
import type { ReturnView } from "../api/types";
import { ErrorNotice, Spinner } from "../components/ui";
import { t } from "../i18n";
import { pickOne, useUrlParam } from "../lib/urlState";
import { ReturnCard } from "./parts";

const TABS: readonly { readonly view: ReturnView; readonly label: string }[] = (
  ["open", "closed", "all"] as const
).map((view) => ({ view, label: t.returns.views[view].label }));

const VIEWS: readonly ReturnView[] = TABS.map((tab) => tab.view);

/** Linkable: `?view=open|closed|all`. */
export function ReturnsPage(): ReactNode {
  const [viewParam, setViewParam] = useUrlParam("view");
  const view = pickOne(viewParam, VIEWS, "open");
  const returns = useReturns(view);
  return (
    <section aria-labelledby="returns-title" className="stack">
      <div className="page-header glass-panel">
        <div className="page-title-row">
          <Undo2 size={22} className="page-icon" aria-hidden="true" />
          <h1 id="returns-title">{t.returns.title}</h1>
          <span className="page-count">{returns.data?.length ?? 0}</span>
        </div>
        <Segmented
          legend={t.returns.show}
          name="return-view"
          options={TABS.map((tab) => ({ value: tab.view, label: tab.label }))}
          value={view}
          onChange={(next) => {
            setViewParam(next === "open" ? null : next);
          }}
        />
      </div>
      <ErrorNotice error={returns.error} />
      {returns.data === undefined ? (
        returns.isPending ? (
          <Spinner />
        ) : null
      ) : returns.data.length === 0 ? (
        <div className="glass-panel empty-state">
          <Undo2 size={32} aria-hidden="true" />
          <p>{t.returns.views[view].empty}</p>
        </div>
      ) : (
        <div className="order-grid">
          {returns.data.map((entry) => (
            <ReturnCard key={entry.id} entry={entry} showOrder />
          ))}
        </div>
      )}
    </section>
  );
}
