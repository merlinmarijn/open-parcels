import { loadRules, parseMail } from "open-parcels-rules";
import { describe, expect, it } from "vitest";
import { createMailInterpreter } from "../../src/mail/interpret.js";
import { createReturnInterpreter } from "../../src/mail/returns.js";

const rules = loadRules();
const mail = {
  messageId: null,
  from: "Temu <temu@orders.temu.com>",
  subject: "Your order PO-076-01234567890123456 was delivered",
  text: null,
  html: "<p>Order PO-076-01234567890123456 has been delivered.</p>",
  date: new Date("2026-11-20T10:00:00Z"),
};

describe("order emails without a parcel (rules 2.0.0-dev.11)", () => {
  it("leave an order_delivered email alone: no parcel and no return", () => {
    // The rules read it as an order event; the server does not act on order events yet.
    expect(
      parseMail(rules, { from: mail.from, subject: mail.subject, html: mail.html }).map(
        (result) => [result.kind, result.event],
      ),
    ).toEqual([["order", "order_delivered"]]);
    expect(createMailInterpreter(rules, "Europe/Berlin")(mail)).toEqual([]);
    expect(createReturnInterpreter(rules, "Europe/Berlin")(mail)).toEqual([]);
  });
});
