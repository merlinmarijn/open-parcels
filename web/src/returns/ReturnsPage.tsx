/** Returns from shop accounts and return mails: still going on, finished, or all. */
import { Undo2 } from "lucide-react";
import type { ReactNode } from "react";
import { useReturns } from "../api/queries";
import type { ReturnView } from "../api/types";
import { ErrorNotice, Spinner } from "../components/ui";
import { pickOne, useUrlParam } from "../lib/urlState";
import { ReturnCard } from "./parts";

const TABS: readonly { readonly view: ReturnView; readonly label: string }[] = [
  { view: "open", label: "Open" },
  { view: "closed", label: "Closed" },
  { view: "all", label: "All" },
];

const VIEWS: readonly ReturnView[] = TABS.map((tab) => tab.view);

const EMPTY: Readonly<Record<ReturnView, string>> = {
  open: "No open returns. A return you start at a shop shows up here once its account or a return email reports it.",
  closed: "No refunded, rejected, cancelled or expired returns.",
  all: "No returns yet.",
};

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
          <h1 id="returns-title">Returns</h1>
          <span className="page-count">{returns.data?.length ?? 0}</span>
        </div>
        <fieldset className="segmented">
          <legend className="visually-hidden">Show</legend>
          {TABS.map((tab) => (
            <label key={tab.view} className={view === tab.view ? "selected" : undefined}>
              <input
                type="radio"
                name="return-view"
                value={tab.view}
                checked={view === tab.view}
                onChange={() => {
                  setViewParam(tab.view === "open" ? null : tab.view);
                }}
              />
              {tab.label}
            </label>
          ))}
        </fieldset>
      </div>
      <ErrorNotice error={returns.error} />
      {returns.data === undefined ? (
        returns.isPending ? (
          <Spinner />
        ) : null
      ) : returns.data.length === 0 ? (
        <div className="glass-panel empty-state">
          <Undo2 size={32} aria-hidden="true" />
          <p>{EMPTY[view]}</p>
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
