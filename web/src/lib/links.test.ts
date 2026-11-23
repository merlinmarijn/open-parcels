import { describe, expect, it } from "vitest";
import { safeHref } from "./links";

describe("safeHref (OP-145)", () => {
  it("keeps web addresses and refuses every other scheme", () => {
    expect(safeHref("https://shop.example.invalid/item")).toBe("https://shop.example.invalid/item");
    expect(safeHref("http://shop.example.invalid/")).toBe("http://shop.example.invalid/");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,<b>x</b>")).toBeNull();
    expect(safeHref("dhllogin://callback")).toBeNull();
    expect(safeHref("/relative")).toBeNull();
    expect(safeHref(null)).toBeNull();
    expect(safeHref("http://shop.example.invalid/", ["https:"])).toBeNull();
  });
});
