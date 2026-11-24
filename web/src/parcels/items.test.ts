import { describe, expect, it } from "vitest";
import { priceText } from "./ItemList";
import { otherOrderItems } from "./ParcelDetailPage";

const OWN = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000a2";

function item(title: string, parcelId: string | null): { title: string; parcel_id: string | null } {
  return { title, parcel_id: parcelId };
}

describe("the order's other items on a parcel (OP-151)", () => {
  it("lists a second identical item that travels in another parcel", () => {
    const cable = item("Test cable", OWN);
    const parcel = {
      id: OWN,
      items: [cable],
      order: { items: [cable, item("Test cable", OTHER)] },
    };
    expect(otherOrderItems(parcel)).toEqual([item("Test cable", OTHER)]);
  });

  it("matches unlinked items by title", () => {
    const parcel = {
      id: OWN,
      items: [item("Test lamp", OWN)],
      order: { items: [item("Test lamp", null), item("Test plug", null)] },
    };
    expect(otherOrderItems(parcel)).toEqual([item("Test plug", null)]);
  });
});

describe("an item price (OP-151)", () => {
  it("shows a bare number when the currency is unknown, never euros", () => {
    const priced = { title: "Test", image_url: null, url: null, quantity: 1, price: 5 };
    expect(priceText({ ...priced, currency: null })).toBe("5.00");
    expect(priceText({ ...priced, currency: "USD" })).toMatch(/\$|US/);
  });
});
