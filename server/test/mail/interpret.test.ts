import { loadRules } from "open-parcels-rules";
import { describe, expect, it } from "vitest";
import { createMailInterpreter, subjectAsStatus } from "../../src/mail/interpret.js";

const interpret = createMailInterpreter(loadRules(), "Europe/Berlin");

describe("mail interpretation with the shared rules", () => {
  it("turns a German DHL shipping notice into a DHL parcel", () => {
    const snapshots = interpret({
      messageId: null,
      from: "DHL Paket <noreply@dhl.de>",
      subject: "Ihr DHL Paket kommt heute",
      text: "Guten Tag, Ihre Sendung 00340434000000000017 wird heute zugestellt.",
      html: null,
      date: new Date("2026-11-18T07:00:00Z"),
    });
    expect(snapshots.map((s) => [s.carrier, s.barcode])).toEqual([["dhl", "00340434000000000017"]]);
  });

  it("ignores mails without a tracking number", () => {
    expect(
      interpret({
        messageId: null,
        from: "news@shop.example.invalid",
        subject: "Sale!",
        text: "Everything 20% off.",
        html: null,
        date: null,
      }),
    ).toEqual([]);
  });
});

describe("mail subjects as status text (OP-131)", () => {
  it("mask addresses, codes and digit runs, and drop a subject that came with a pickup code", () => {
    expect(
      subjectAsStatus("Abholcode 482913 für someone@example.invalid, Sendung 00340434000000000017", false),
    ).toBe("Abholcode … für [email], Sendung 0034…");
    expect(subjectAsStatus("Your parcel is on its way", false)).toBe("Your parcel is on its way");
    expect(subjectAsStatus("Code 482913 opens locker 12", true)).toBeNull();
  });
});
