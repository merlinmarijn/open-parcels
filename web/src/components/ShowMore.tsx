import { useState, type ReactNode } from "react";
import { t } from "../i18n";

/**
 * How many rows or cards a long list draws at first and adds per click. A history import brings
 * thousands of parcels and orders; drawing them all at once makes the page slow to open, while
 * search, sorting and counts still work on the whole list.
 */
const LIST_STEP = 200;

/**
 * The first `shown` entries of a list and a button for the next step. `reset` (for example the
 * search text) starts over at one step whenever it changes.
 */
export function useShowMore<T>(
  list: readonly T[],
  reset: string,
): { readonly visible: readonly T[]; readonly more: ReactNode } {
  const [state, setState] = useState({ reset, shown: LIST_STEP });
  const shown = state.reset === reset ? state.shown : LIST_STEP;
  const rest = list.length - shown;
  return {
    visible: rest > 0 ? list.slice(0, shown) : list,
    more:
      rest > 0 ? (
        <button
          type="button"
          className="button show-more"
          onClick={() => {
            setState({ reset, shown: shown + LIST_STEP });
          }}
        >
          {t.common.showMore(Math.min(rest, LIST_STEP))}
        </button>
      ) : null,
  };
}
