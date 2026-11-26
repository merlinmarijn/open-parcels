import { loadRules, type EmailRuleDefinition } from "open-parcels-rules";
import { describe, expect, it } from "vitest";
import { EmailRuleReader } from "../../src/mail/rule-reader.js";
import type { MailInput } from "../../src/mail/types.js";

/* Made-up sender, numbers and rule only. */

const RULE: EmailRuleDefinition = {
  id: "parcel-unitshop",
  name: "Unit shop",
  kind: "parcel",
  senders: { domains: ["unit-shop.example"] },
  carrier: "dhl",
  extract: { tracking_number: [{ pattern: "Code (?<tracking_number>UNIT\\d{6})" }] },
  require: ["tracking_number"],
  tests: [{ fixture: "unit.eml", expect: [] }],
};

const mail = (from: string, text: string): MailInput => ({
  messageId: null,
  from,
  subject: "Shipped",
  text,
  html: null,
  date: new Date("2026-11-17T10:00:00Z"),
  authentication: null,
});

describe("custom email rules in the rule reader", () => {
  const reader = new EmailRuleReader(loadRules(), "UTC");

  it("adds custom rules to the shared ones, never in their place", () => {
    const own = reader.withCustom([RULE]);
    const shared = own.shared();
    expect(shared.parcels(mail("ship@unit-shop.example", "Code UNIT123456"))).toEqual([
      expect.objectContaining({ carrier: "dhl", trackingNumber: "UNIT123456" }),
    ]);
    expect(reader.shared().parcels(mail("ship@unit-shop.example", "Code UNIT123456"))).toEqual([]);
    expect(own.rulesFor(null).mailRules.length).toBe(reader.rulesFor(null).mailRules.length + 1);
  });

  it("names every problem of candidates by their place in the list", () => {
    const problems = reader.problems(
      [RULE, { ...RULE, id: "x y" }, { ...RULE }, { ...RULE, id: "parcel-taken" }, "nope"],
      new Set(["parcel-taken"]),
    );
    expect(problems.map((problem) => [problem.index, problem.id])).toEqual([
      [1, "x y"],
      [2, "parcel-unitshop"],
      [3, "parcel-taken"],
      [4, null],
    ]);
    expect(problems.every((problem) => problem.message !== "")).toBe(true);
  });
});
