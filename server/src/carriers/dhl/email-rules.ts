import type { EmailRuleDefinition } from "../../provider/api.js";

/**
 * Email rules (format: open-parcels-rules `schema/mail-rule.schema.json`), read by the core's
 * rule engine for the emails routed to this provider. Each rule's `tests` run against the fixtures
 * in `server/test/fixtures/email/` (`server/test/carriers/email-rules.test.ts`).
 */
export const DHL_EMAIL_RULES: readonly EmailRuleDefinition[] = [
  {
    id: "parcel-dhl",
    name: "DHL parcel notifications",
    kind: "parcel",
    senders: {
      addresses: ["donotreply_odd@dhl.com", "noreply.odd@dhl.com", "pl.no.reply@dhl.com"],
      domains: ["dhl.de"],
    },
    carrier: "dhl",
    extractors: ["detect_tracking_numbers"],
    extract: {
      tracking_url: [
        {
          pattern: '(?<tracking_url>https://(?:www\\.|nolp\\.)?dhl\\.(?:de|com)/[^\\s"<>]+)',
          in: ["text", "html"],
        },
      ],
      arrival: [
        {
          pattern:
            "(?<arrival>(?:voraussichtlich|zustellung|kommt|ankunft|scheduled for delivery|arriving|delivery)[^\\n]{0,80})",
          in: ["subject", "text"],
        },
      ],
    },
    status_keywords: [
      {
        status: "returning",
        patterns: ["zurück an den absender|rücksendung an|returned to (?:the )?sender"],
      },
      {
        status: "at_pickup_point",
        patterns: [
          "zur abholung bereit|liegt .{0,60}zur abholung|abholbereit|ready for collection|czeka na odbiór",
        ],
      },
      {
        status: "problem",
        patterns: [
          "nicht zugestellt werden|zustellversuch|could not be delivered|delivery attempt",
        ],
      },
      {
        status: "delivered",
        patterns: ["wurden? zugestellt|zugestellt am|ha(?:s|ve) been delivered|została doręczona"],
      },
      {
        status: "out_for_delivery",
        patterns: [
          "komm(?:t|en) heute|(?:wird|werden) heute zugestellt|in zustellung|scheduled for delivery today|zostanie dziś",
        ],
      },
      {
        status: "in_transit",
        patterns: [
          "komm(?:t|en) (?:morgen|bald|am)|(?:ist|sind) unterwegs|paketankündigung|on (?:its|their) way|w drodze",
        ],
      },
    ],
    require: ["tracking_number"],
    tests: [
      {
        fixture: "dhl-de-announcement.eml",
        time_zone: "Europe/Berlin",
        expect: [
          {
            ruleId: "parcel-dhl",
            kind: "parcel",
            carrier: "dhl",
            trackingNumbers: ["00340434123456789012"],
            orderNumbers: [],
            status: "in_transit",
            arrival: {
              from: "2026-11-19T00:00:00+01:00",
              to: "2026-11-20T00:00:00+01:00",
              allDay: true,
            },
            trackingUrl:
              "https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=00340434123456789012",
          },
        ],
      },
      {
        fixture: "dhl-de-today.eml",
        time_zone: "Europe/Berlin",
        expect: [
          {
            ruleId: "parcel-dhl",
            carrier: "dhl",
            trackingNumbers: ["340011223348"],
            status: "out_for_delivery",
            arrival: {
              from: "2026-11-18T14:00:00+01:00",
              to: "2026-11-18T18:00:00+01:00",
              allDay: false,
            },
          },
        ],
      },
      {
        fixture: "dhl-de-packstation.eml",
        time_zone: "Europe/Berlin",
        expect: [
          {
            ruleId: "parcel-dhl",
            trackingNumbers: ["JJD0012345678901"],
            status: "at_pickup_point",
          },
        ],
      },
      {
        fixture: "dhl-com-delivered.eml",
        expect: [
          {
            ruleId: "parcel-dhl",
            trackingNumbers: ["LX123123120DE"],
            status: "delivered",
          },
        ],
      },
      {
        fixture: "dhl-pl-delivered.eml",
        expect: [
          {
            ruleId: "parcel-dhl",
            trackingNumbers: ["00340434987654321012"],
            status: "delivered",
          },
        ],
      },
      {
        fixture: "dhl-de-multiple.eml",
        expect: [
          {
            ruleId: "parcel-dhl",
            carrier: "dhl",
            trackingNumbers: [
              "00340434111111111117",
              "00340434222222222224",
              "00340434333333333331",
              "00340434121212121212",
              "00340434123456789012",
            ],
            status: "in_transit",
          },
        ],
      },
      {
        fixture: "dhl-com-multiple.eml",
        expect: [
          {
            ruleId: "parcel-dhl",
            carrier: "dhl",
            trackingNumbers: ["LX123123120DE", "00340434111111111117", "00340434222222222224"],
            status: "in_transit",
          },
        ],
      },
    ],
  },
  {
    id: "parcel-dhl-nl",
    name: "DHL eCommerce Netherlands parcel notifications",
    kind: "parcel",
    senders: {
      domains: ["dhlecommerce.nl", "dhlparcel.nl"],
    },
    carrier: "dhl",
    extract: {
      // JJD, JVGL and 3S piece ids, in the subject's brackets or after "pakket"/"Zendingsnummer".
      tracking_number: [
        {
          pattern: "\\((?<tracking_number>J[A-Z]{2,3}\\d{14,24}|3S[A-Z0-9]{8,15})\\)",
          in: ["subject"],
        },
        {
          pattern:
            "(?:pakket|zendingsnummer)\\s+(?<tracking_number>J[A-Z]{2,3}\\d{14,24}|3S[A-Z0-9]{8,15})\\b",
          in: ["text"],
        },
      ],
      tracking_url: [
        {
          pattern: '(?<tracking_url>https://my\\.dhlecommerce\\.nl/[^\\s"<>]+)',
          in: ["text", "html"],
        },
      ],
    },
    status_keywords: [
      {
        status: "delivered",
        patterns: ["is bezorgd|is afgeleverd"],
        in: ["subject"],
      },
      {
        status: "at_pickup_point",
        patterns: ["ligt (?:voor je )?klaar|kun je ophalen"],
        in: ["subject"],
      },
      {
        status: "problem",
        patterns: ["niet bezorgd|niet thuis|gemist"],
        in: ["subject"],
      },
      {
        status: "out_for_delivery",
        patterns: [
          "staan (?:vandaag|vanavond|vanmiddag|vanochtend) voor de deur|bezorger is onderweg",
        ],
        in: ["subject"],
      },
    ],
    default_status: "in_transit",
    require: ["tracking_number"],
    tests: [
      {
        fixture: "dhl-nl-announcement.eml",
        expect: [
          {
            ruleId: "parcel-dhl-nl",
            kind: "parcel",
            carrier: "dhl",
            trackingNumbers: ["JJD000012345678901234"],
            status: "in_transit",
          },
        ],
      },
      {
        fixture: "dhl-nl-today.eml",
        expect: [
          {
            ruleId: "parcel-dhl-nl",
            trackingNumbers: ["JVGL0123456789012345678"],
            status: "out_for_delivery",
          },
        ],
      },
      {
        fixture: "dhl-nl-delivered.eml",
        expect: [
          {
            ruleId: "parcel-dhl-nl",
            trackingNumbers: ["JJD000012345678901234"],
            status: "delivered",
            trackingUrl: "https://my.dhlecommerce.nl/go-track-trace?tc=JJD000012345678901234",
          },
        ],
      },
      {
        fixture: "dhl-nl-3s-delivered.eml",
        expect: [
          {
            ruleId: "parcel-dhl-nl",
            carrier: "dhl",
            trackingNumbers: ["3SXXXX012345601"],
            status: "delivered",
          },
        ],
      },
    ],
  },
];
