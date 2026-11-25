import type { ReactNode } from "react";
import { apiUrl } from "../api/fetcher";
import { t } from "../i18n";

interface PicturedItem {
  readonly title: string;
  readonly image_url: string | null;
}

/**
 * Up to `limit` item pictures, the rest counted ("+3"). Small ones sit beside a parcel's name in
 * the table (inside its link, so the markup is phrasing content); large ones on order cards.
 */
export function ItemPictures(props: {
  readonly items: readonly PicturedItem[];
  readonly limit: number;
  readonly size: "small" | "large";
}): ReactNode {
  const pictures = props.items.flatMap((item) =>
    item.image_url === null ? [] : [{ title: item.title, imageUrl: item.image_url }],
  );
  if (pictures.length === 0) return null;
  const shown = pictures.slice(0, props.limit);
  const more = pictures.length - shown.length;
  return (
    <span className={`item-pictures ${props.size}`} role="list" aria-label={t.orders.items}>
      {shown.map((item, index) => (
        <span role="listitem" key={`${item.imageUrl}-${String(index)}`} title={item.title}>
          <img src={apiUrl(item.imageUrl)} alt={item.title} loading="lazy" />
        </span>
      ))}
      {more > 0 ? <span role="listitem">+{more}</span> : null}
    </span>
  );
}
