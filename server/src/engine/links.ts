import type { ParcelSnapshot } from "../provider/snapshot.js";

/**
 * A link as stored: only absolute `http` and `https` addresses. Anything else (`javascript:`,
 * `data:`, a relative path) is dropped, since links reach the web UI, Home Assistant attributes
 * and calendar feeds, not all of which guard against other schemes.
 */
export function safeUrl(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  try {
    const { protocol } = new URL(trimmed);
    return protocol === "http:" || protocol === "https:" ? trimmed : null;
  } catch {
    return null;
  }
}

function safeItem<T extends { url: string | null; imageUrl: string | null }>(item: T): T {
  return { ...item, url: safeUrl(item.url), imageUrl: safeUrl(item.imageUrl) };
}

/** The snapshot with every link it carries checked: its own, its items' and its order lines'. */
export function withSafeLinks(snapshot: ParcelSnapshot): ParcelSnapshot {
  return {
    ...snapshot,
    url: safeUrl(snapshot.url),
    items: snapshot.items.map(safeItem),
    ...(snapshot.orderItems === undefined ? {} : { orderItems: snapshot.orderItems.map(safeItem) }),
  };
}
