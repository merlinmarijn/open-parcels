import {
  asObject,
  findCarrier,
  isoTime,
  loadRules,
  num,
  objects,
  snapshot,
  text,
  type Json,
  type ParcelSnapshot,
  type SnapshotItem,
} from "../../provider/api.js";

const LOCAL = { naive: { zone: "Europe/Amsterdam" }, epoch: "ms" } as const;

export function orderItem(item: Json): SnapshotItem {
  const offer = asObject(item["offerInformation"]);
  const image = objects(asObject(item["assets"])["assets"])[0];
  return {
    title: text(offer["productTitle"]) ?? "",
    externalId: text(item["id"]),
    quantity: num(item["quantity"]),
    price: num(asObject(asObject(offer["listPrice"])["priceInclVat"])["amount"]),
    currency: "EUR",
    url: productUrl(text(asObject(offer["product"])["url"])),
    imageUrl: text(objects(image?.["renditions"])[0]?.["url"]),
  };
}

function productUrl(path: string | null): string | null {
  if (path === null) return null;
  try {
    const url = new URL(path, "https://www.bol.com");
    return url.origin === "https://www.bol.com" ? url.href : null;
  } catch {
    return null;
  }
}

function carrierOf(transport: Json): string | null {
  const rules = loadRules();
  const name = text(transport["deliveryCarrierName"]);
  return name === null
    ? null
    : (findCarrier(rules, name)?.id ?? findCarrier(rules, name.split(" ")[0] ?? "")?.id ?? null);
}

export function orderSnapshots(data: Json, orderItems: readonly SnapshotItem[]): ParcelSnapshot[] {
  const orderNumber = text(data["orderReference"]);
  if (orderNumber === null) return [];
  const allItems = objects(data["shopOrderItems"]);
  const snapshots: ParcelSnapshot[] = [];
  for (const item of allItems) {
    const id = text(item["id"]);
    if (id === null) continue;
    const lines = objects(asObject(item["status"])["lines"]);
    for (const line of lines.length > 0 ? lines : [{}]) {
      const shipment = asObject(line["shipment"]);
      const transport = asObject(shipment["transport"]);
      const barcode = text(transport["trackTraceCode"]);
      const carrier = carrierOf(transport);
      const deliveredAt = isoTime(
        asObject(transport["eventDateTimes"])["successfullyDeliveredDateTime"],
        LOCAL,
      );
      const rawStatus = text(line["shortTranslatedStatus"]);
      snapshots.push(
        snapshot({
          carrier: "bol",
          trackingNumber: barcode ?? `${orderNumber}-${id}`,
          externalRef: id,
          status: deliveredAt === null ? null : "delivered",
          rawStatus,
          deliveredAt,
          sender:
            text(asObject(asObject(item["offerInformation"])["retailer"])["name"]) ?? "bol.com",
          url: productUrl(text(item["url"])),
          items: [
            {
              ...orderItem(item),
              quantity:
                num(
                  objects(shipment["lines"]).find((entry) => entry["shopOrderItemId"] === id)?.[
                    "quantity"
                  ],
                ) ?? num(item["quantity"]),
            },
          ],
          orderItems,
          order: {
            shop: "bol.com",
            orderNumber,
            placedAt: isoTime(data["creationDateTime"], LOCAL),
            returnUntil: text(asObject(item["returnOption"])["returnableUntilDate"]),
          },
          handoff:
            barcode !== null && carrier !== null ? { carrier, trackingNumber: barcode } : null,
          raw: { orderNumber, itemId: id, rawStatus },
        }),
      );
    }
  }
  return snapshots;
}
