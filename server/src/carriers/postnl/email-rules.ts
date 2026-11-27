import type { EmailRuleDefinition } from "../../provider/api.js";

/**
 * Email rules (format: open-parcels-rules `schema/mail-rule.schema.json`), read by the core's
 * rule engine for the emails routed to this provider. Each rule's `tests` run against the fixtures
 * in `server/test/fixtures/email/` (`server/test/carriers/email-rules.test.ts`).
 */
export const POSTNL_EMAIL_RULES: readonly EmailRuleDefinition[] = [
  {
    id: "parcel-postnl",
    name: "PostNL parcel notifications",
    kind: "parcel",
    senders: { domains: ["edm.postnl.nl"] },
    carrier: "postnl",
    extract: {
      // "Track & trace-code" or "Barcode", the number sometimes behind its link: 3S codes and
      // international S10 numbers (LR123456789NL).
      tracking_number: [
        {
          pattern:
            "(?:track & trace-code|barcode)(?:\\s|https?://\\S+)*(?<tracking_number>3S[A-Z0-9]{8,15}|[A-Z]{2}\\d{9}[A-Z]{2})\\b",
          in: ["text"],
        },
      ],
    },
    status_keywords: [
      {
        status: "at_pickup_point",
        patterns: ["ligt (?:voor je )?klaar|kunt (?:je|hem|'m) ophalen|ophalen bij"],
        in: ["text"],
      },
      {
        status: "delivered",
        patterns: ["^afgeleverd|hebben je pakket .{0,60}bezorgd|is bezorgd"],
        in: ["subject"],
      },
      {
        status: "returning",
        patterns: ["terug naar (?:de )?afzender|retour"],
        in: ["subject"],
      },
      {
        status: "problem",
        patterns: ["niet bezorgd|niet thuis|gemist"],
        in: ["subject"],
      },
      {
        status: "out_for_delivery",
        patterns: ["^vandaag|^onderweg met je pakket|staan vandaag voor de deur"],
        in: ["subject"],
      },
    ],
    default_status: "in_transit",
    require: ["tracking_number"],
    tests: [
      {
        fixture: "postnl-new.eml",
        expect: [
          {
            ruleId: "parcel-postnl",
            kind: "parcel",
            carrier: "postnl",
            trackingNumbers: ["3SXXXX12345678"],
            status: "in_transit",
          },
        ],
      },
      {
        fixture: "postnl-today.eml",
        expect: [
          {
            ruleId: "parcel-postnl",
            trackingNumbers: ["3SXXXX1234567"],
            status: "out_for_delivery",
          },
        ],
      },
      {
        fixture: "postnl-delivered-s10.eml",
        expect: [
          {
            ruleId: "parcel-postnl",
            trackingNumbers: ["LR123456785NL"],
            status: "delivered",
          },
        ],
      },
      {
        fixture: "postnl-pickup-point.eml",
        expect: [
          {
            ruleId: "parcel-postnl",
            trackingNumbers: ["3SXXXX12345678"],
            status: "at_pickup_point",
          },
        ],
      },
      {
        fixture: "postnl-service-news.eml",
        expect: [],
      },
    ],
  },
];
