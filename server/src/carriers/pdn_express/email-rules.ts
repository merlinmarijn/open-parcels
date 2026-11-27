import type { EmailRuleDefinition } from "../../provider/api.js";

/**
 * Email rules (format: open-parcels-rules `schema/mail-rule.schema.json`), read by the core's
 * rule engine for the emails routed to this provider. Each rule's `tests` run against the fixtures
 * in `server/test/fixtures/email/` (`server/test/carriers/email-rules.test.ts`).
 */
export const PDN_EXPRESS_EMAIL_RULES: readonly EmailRuleDefinition[] = [
  {
    id: "parcel-pdn-express-nl",
    name: "PDN Express Netherlands parcel notifications",
    kind: "parcel",
    senders: { domains: ["pdn.express"] },
    carrier: "pdn_express",
    extract: {
      tracking_number: [
        {
          pattern: "(?:volgnummer|bestelling)\\s*#\\s*(?<tracking_number>PDN\\d{8,14})\\b",
          in: ["subject", "text"],
        },
      ],
    },
    status_keywords: [
      { status: "delivered", patterns: ["is bezorgd"], in: ["subject"] },
      { status: "out_for_delivery", patterns: ["vandaag|onderweg"], in: ["subject"] },
    ],
    default_status: "in_transit",
    require: ["tracking_number"],
    tests: [
      {
        fixture: "pdn-nl-delivered.eml",
        expect: [
          {
            ruleId: "parcel-pdn-express-nl",
            kind: "parcel",
            carrier: "pdn_express",
            trackingNumbers: ["PDN0012345678"],
            status: "delivered",
          },
        ],
      },
    ],
  },
];
