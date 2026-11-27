import type { EmailRuleDefinition } from "../../provider/api.js";

/**
 * Email rules (format: open-parcels-rules `schema/mail-rule.schema.json`), read by the core's
 * rule engine for the emails routed to this provider. Each rule's `tests` run against the fixtures
 * in `server/test/fixtures/email/` (`server/test/carriers/email-rules.test.ts`).
 */
export const GOFO_EMAIL_RULES: readonly EmailRuleDefinition[] = [
  {
    id: "parcel-gofo-nl",
    name: "GOFO Netherlands parcel notifications",
    kind: "parcel",
    senders: { domains: ["nlconnect.gofo.com"] },
    carrier: "gofo",
    extract: {
      tracking_number: [
        {
          pattern: "pakket\\s+(?<tracking_number>GF[A-Z]{2}[A-Z0-9]{8,30})\\b",
          in: ["text"],
        },
      ],
    },
    status_keywords: [
      { status: "delivered", patterns: ["is (?:succesvol )?bezorgd"], in: ["subject"] },
      { status: "out_for_delivery", patterns: ["vandaag bezorgd|is onderweg"], in: ["subject"] },
    ],
    default_status: "in_transit",
    require: ["tracking_number"],
    tests: [
      {
        fixture: "gofo-nl-soon.eml",
        expect: [
          {
            ruleId: "parcel-gofo-nl",
            kind: "parcel",
            carrier: "gofo",
            trackingNumbers: ["GFNL12345678901234"],
            status: "in_transit",
          },
        ],
      },
      {
        fixture: "gofo-nl-delivered.eml",
        expect: [
          {
            ruleId: "parcel-gofo-nl",
            trackingNumbers: ["GFNL12345678901234"],
            status: "delivered",
          },
        ],
      },
    ],
  },
];
