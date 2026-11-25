import type { ReactNode } from "react";
import { apiUrl } from "../api/fetcher";
import { formatMoney } from "../lib/format";
import { safeHref } from "../lib/links";

export interface ListedItem {
  readonly title: string;
  readonly image_url: string | null;
  readonly url: string | null;
  readonly quantity: number | null;
  readonly price: number | null;
  readonly currency: string | null;
}

export function priceText(item: ListedItem): string | null {
  return item.price === null ? null : formatMoney(item.price, item.currency);
}

/** Items with picture, quantity, title (linked to the shop's page) and price; `note` per item. */
export function ItemList(props: {
  readonly items: readonly ListedItem[];
  readonly note?: (item: ListedItem, index: number) => ReactNode;
}): ReactNode {
  return (
    <ul className="items">
      {props.items.map((item, index) => {
        const price = priceText(item);
        const note = props.note?.(item, index);
        const href = safeHref(item.url);
        return (
          <li key={`${item.title}-${String(index)}`}>
            {item.image_url === null ? (
              <span className="item-thumb" aria-hidden="true" />
            ) : (
              <img src={apiUrl(item.image_url)} alt="" width={48} height={48} loading="lazy" />
            )}
            <span className="item-text">
              <span>
                {item.quantity !== null && item.quantity > 1 ? `${String(item.quantity)} × ` : ""}
                {href === null ? (
                  item.title
                ) : (
                  <a href={href} target="_blank" rel="noreferrer noopener">
                    {item.title}
                  </a>
                )}
              </span>
              {note === undefined || note === null ? null : (
                <span className="muted item-note">{note}</span>
              )}
            </span>
            {price === null ? null : <span className="item-price">{price}</span>}
          </li>
        );
      })}
    </ul>
  );
}
