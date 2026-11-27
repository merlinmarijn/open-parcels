import type { EmailRuleDefinition } from "../../provider/api.js";

/**
 * Email rules (format: open-parcels-rules `schema/mail-rule.schema.json`), read by the core's
 * rule engine for the emails routed to this provider. Each rule's `tests` run against the fixtures
 * in `server/test/fixtures/email/` (`server/test/carriers/email-rules.test.ts`). DPD Germany's
 * and Poland's emails are still read by the shared rules (`docs/rules-split.md`).
 */
export const DPD_EMAIL_RULES: readonly EmailRuleDefinition[] = [
  {
    id: "parcel-dpd-nl",
    name: "DPD Netherlands parcel notifications",
    kind: "parcel",
    senders: { domains: ["dpd.nl"] },
    flags: ["i"],
    carrier: "dpd",
    extract: {
      tracking_number: [
        {
          pattern:
            "(?:pakketnummer|zendingnummer|parcel number):?\\s*(?<tracking_number>\\d{14}[0-9A-Z]?)\\b",
          in: ["subject", "text"],
        },
      ],
      arrival: [
        {
          pattern: "(?<arrival>(?:bezorgtijd|bezorgen|wordt vandaag)[^\\n]{0,60})",
          in: ["subject", "text"],
        },
      ],
    },
    status_keywords: [
      {
        status: "returning",
        patterns: ["retour (?:naar|aan) (?:de )?afzender"],
        in: ["subject", "text"],
      },
      {
        status: "problem",
        patterns: [
          "niet (?:thuis|bezorgd)|bezorgpoging|vertraagd|adres (?:is )?(?:onvolledig|onjuist)",
        ],
        in: ["subject"],
      },
      { status: "delivered", patterns: ["is bezorgd|afgeleverd"], in: ["subject"] },
      { status: "at_pickup_point", patterns: ["pickup|ophalen|ligt klaar"], in: ["subject"] },
      {
        status: "out_for_delivery",
        patterns: ["vandaag .*bezorgd|bezorger is onderweg"],
        in: ["subject"],
      },
    ],
    default_status: "in_transit",
    require: ["tracking_number"],
    tests: [
      {
        fixture: "dpd-nl-received.eml",
        expect: [
          {
            ruleId: "parcel-dpd-nl",
            kind: "parcel",
            carrier: "dpd",
            trackingNumbers: ["05001234567890"],
            status: "in_transit",
          },
        ],
      },
      {
        fixture: "dpd-nl-today.eml",
        time_zone: "Europe/Amsterdam",
        now: "2026-11-10T07:00:00Z",
        expect: [
          {
            ruleId: "parcel-dpd-nl",
            trackingNumbers: ["05001234567890"],
            status: "out_for_delivery",
          },
        ],
      },
      {
        fixture: "dpd-nl-delivered.eml",
        expect: [
          {
            ruleId: "parcel-dpd-nl",
            trackingNumbers: ["05001234567890"],
            status: "delivered",
          },
        ],
      },
    ],
  },
];
