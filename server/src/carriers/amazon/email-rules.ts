import type { EmailRuleDefinition } from "../../provider/api.js";

/**
 * Email rules (format: open-parcels-rules `schema/mail-rule.schema.json`), read by the core's
 * rule engine for the emails routed to this provider. Each rule's `tests` run against the fixtures
 * in `server/test/fixtures/email/` (`server/test/carriers/email-rules.test.ts`).
 */
export const AMAZON_EMAIL_RULES: readonly EmailRuleDefinition[] = [
  {
    id: "dunning-amazon",
    name: "Amazon payment reminders",
    kind: "dunning",
    senders: {
      domains: [
        "amazon.de",
        "amazon.com",
        "amazon.co.uk",
        "amazon.it",
        "amazon.pl",
        "amazon.fr",
        "amazon.es",
        "amazon.nl",
        "amazon.ca",
        "amazon.com.au",
        "amazon.in",
      ],
    },
    subject: ["zahlungserinnerung|mahnung|payment reminder|payment overdue|inkasso"],
    extract: {
      order_number: [
        {
          pattern: "(?<order_number>\\b\\d{3}-\\d{7}-\\d{7}\\b)",
        },
      ],
    },
    event_keywords: [
      {
        event: "debt_collection",
        patterns: ["inkasso|collection agency"],
      },
      {
        event: "payment_warning",
        patterns: ["mahnung|overdue|final notice"],
        in: ["subject"],
      },
      {
        event: "payment_reminder",
        patterns: ["zahlungserinnerung|reminder|erinnerung"],
      },
    ],
    tests: [
      {
        fixture: "amazon-de-dunning.eml",
        expect: [
          {
            ruleId: "dunning-amazon",
            kind: "dunning",
            event: "payment_reminder",
            orderNumbers: ["302-1234567-1234567"],
          },
        ],
      },
      {
        fixture: "amazon-de-mahnung.eml",
        expect: [
          {
            ruleId: "dunning-amazon",
            event: "payment_warning",
            orderNumbers: ["028-7654321-7654321"],
          },
        ],
      },
    ],
  },
  {
    id: "order-amazon",
    name: "Amazon order confirmations, shipments and cancellations",
    kind: "order",
    senders: {
      domains: [
        "amazon.de",
        "amazon.com",
        "amazon.co.uk",
        "amazon.it",
        "amazon.pl",
        "amazon.fr",
        "amazon.es",
        "amazon.nl",
        "amazon.ca",
        "amazon.com.au",
        "amazon.in",
      ],
      local_parts: [
        "auto-confirm",
        "bestaetigung",
        "bestellung-aktuell",
        "shipment-tracking",
        "versandbestaetigung",
        "dispatch-confirmation",
        "conferma-ordine",
      ],
    },
    subject: [
      "^(?:versandt|shipped|dispatched|spedito|wysłano|enviado|storniert|cancell?ed)\\b",
      "ihre amazon\\.[a-z.]+[ -]bestellung|your amazon\\.[a-z.]+ order|bestellbestätigung|order confirmation|potwierdzenie zamówienia|conferma (?:del )?ordine",
    ],
    exclude: [
      "zahlungserinnerung|mahnung|zahlungsbestätigung|payment confirmation|conferma di pagamento|kundenkonto|customer account",
    ],
    extract: {
      // What the order costs in total.
      total: [
        {
          pattern:
            "(?:gesamtsumme|order total)\\s*:?\\s*(?<total>(?:[€$£]|EUR|USD|GBP)?[ \\t]?\\d[\\d.,]*(?:[ \\t]?(?:[€$£]|EUR|USD|GBP)){0,2})",
        },
      ],
      order_number: [
        {
          pattern: "(?<order_number>\\b\\d{3}-\\d{7}-\\d{7}\\b)",
        },
      ],
    },
    event_keywords: [
      {
        event: "order_cancelled",
        patterns: ["^(?:storniert|cancell?ed)|wurde storniert|has been cancell?ed"],
      },
      {
        event: "order_shipped",
        patterns: ["^(?:versandt|shipped|dispatched|spedito|wysłano|enviado)"],
        in: ["subject"],
      },
      {
        event: "order_confirmed",
        patterns: ["bestellung|order|bestätigung|zamówieni|ordine"],
        in: ["subject"],
      },
    ],
    require: ["order_number"],
    tests: [
      {
        fixture: "amazon-de-order-confirmed.eml",
        expect: [
          {
            ruleId: "order-amazon",
            total: {
              amount: 24.99,
              currency: "EUR",
            },
            kind: "order",
            event: "order_confirmed",
            orderNumbers: ["302-1234567-1234567"],
            trackingNumbers: [],
          },
        ],
      },
      {
        fixture: "amazon-com-cancelled.eml",
        expect: [
          {
            ruleId: "order-amazon",
            event: "order_cancelled",
            orderNumbers: ["112-9999999-0000001"],
          },
        ],
      },
    ],
  },
  {
    // Amazon.nl sends from its own addresses, with English or Dutch subjects; newer emails carry the
    // order number only in their links. Older ones read "Your Amazon.nl order of …".
    id: "order-amazon-nl",
    name: "Amazon.nl order, shipping, delivery and cancellation updates",
    kind: "order",
    senders: {
      domains: ["amazon.nl"],
      local_parts: ["auto-bevestiging", "verzending-volgen", "update-bestelling", "order-update"],
    },
    subject: [
      "^(?:ordered|besteld|dispatched|shipped|verzonden|out for delivery|onderweg voor bezorging|arriving today|wordt vandaag bezorgd|delivered|bezorgd|item cancell?ed|geannuleerd)",
      "^your amazon\\.nl order of ",
      "^your order has been cancell?ed|^je bestelling is geannuleerd",
    ],
    extract: {
      order_number: [
        {
          pattern: "(?<order_number>\\b\\d{3}-\\d{7}-\\d{7}\\b)",
          in: ["text", "html"],
        },
      ],
    },
    event_keywords: [
      {
        event: "order_cancelled",
        patterns: ["^(?:item cancell?ed|geannuleerd)|has been cancell?ed|is geannuleerd"],
        in: ["subject"],
      },
      {
        event: "order_delivered",
        patterns: ["^(?:delivered|bezorgd)"],
        in: ["subject"],
      },
      {
        event: "order_shipped",
        patterns: [
          "^(?:dispatched|shipped|verzonden|out for delivery|onderweg voor bezorging|arriving today|wordt vandaag bezorgd)|has been dispatched",
        ],
        in: ["subject"],
      },
      {
        event: "order_confirmed",
        patterns: ["^(?:ordered|besteld)|^your amazon\\.nl order of "],
        in: ["subject"],
      },
    ],
    require: ["order_number"],
    tests: [
      {
        fixture: "amazon-nl-ordered.eml",
        expect: [
          {
            ruleId: "order-amazon-nl",
            kind: "order",
            event: "order_confirmed",
            orderNumbers: ["402-1234567-1234567"],
          },
        ],
      },
      {
        fixture: "amazon-nl-dispatched.eml",
        expect: [
          {
            ruleId: "order-amazon-nl",
            event: "order_shipped",
            orderNumbers: ["402-1234567-1234567"],
          },
        ],
      },
      {
        fixture: "amazon-nl-delivered.eml",
        expect: [
          {
            ruleId: "order-amazon-nl",
            event: "order_delivered",
            orderNumbers: ["402-1234567-1234567"],
          },
        ],
      },
      {
        fixture: "amazon-nl-cancelled.eml",
        expect: [
          {
            ruleId: "order-amazon-nl",
            event: "order_cancelled",
            orderNumbers: ["402-7654321-7654321"],
          },
        ],
      },
      {
        fixture: "amazon-nl-onderweg.eml",
        expect: [
          {
            ruleId: "order-amazon-nl",
            event: "order_shipped",
            orderNumbers: ["402-1234567-1234567"],
          },
        ],
      },
      {
        fixture: "amazon-nl-legacy-ordered.eml",
        expect: [
          {
            ruleId: "order-amazon-nl",
            event: "order_confirmed",
            orderNumbers: ["402-1234567-1234567"],
          },
        ],
      },
      {
        fixture: "amazon-nl-legacy-cancelled.eml",
        expect: [
          {
            ruleId: "order-amazon-nl",
            event: "order_cancelled",
            orderNumbers: ["407-7654321-7654321"],
          },
          // `order-update` is also a shipping sender; with no number it gives no parcel.
          { ruleId: "parcel-amazon", trackingNumbers: [] },
        ],
      },
      {
        fixture: "amazon-nl-newsletter.eml",
        expect: [],
      },
    ],
  },
  {
    // Older Amazon.nl dispatch emails name the courier and its tracking number in one sentence.
    id: "parcel-amazon-nl",
    name: "Amazon.nl dispatch emails with a tracking number",
    kind: "parcel",
    senders: {
      domains: ["amazon.nl"],
      local_parts: ["verzending-volgen"],
    },
    carrier_from: "carrier",
    extract: {
      tracking_number: [
        {
          pattern:
            "(?:tracking number is|trackingnummer is):?\\s*(?<tracking_number>[A-Z0-9]{8,30})\\b",
          in: ["text"],
        },
      ],
      carrier: [
        {
          pattern:
            "(?:being sent by|wordt verzonden met|wordt bezorgd door)\\s+(?<carrier>[A-Za-z][A-Za-z .-]{1,30}?)\\s*(?:\\.|,|\\n)",
          in: ["text"],
        },
      ],
      order_number: [
        {
          pattern: "(?<order_number>\\b\\d{3}-\\d{7}-\\d{7}\\b)",
        },
      ],
    },
    status_keywords: [
      {
        status: "out_for_delivery",
        patterns: ["^(?:out for delivery|onderweg voor bezorging|arriving today)"],
        in: ["subject"],
      },
    ],
    default_status: "in_transit",
    require: ["tracking_number"],
    tests: [
      {
        fixture: "amazon-nl-legacy-dispatched-postnl.eml",
        expect: [
          {
            ruleId: "order-amazon-nl",
            event: "order_shipped",
            orderNumbers: ["402-1234567-1234567"],
          },
          {
            ruleId: "parcel-amazon-nl",
            kind: "parcel",
            carrier: "postnl",
            trackingNumbers: ["3SXXXX001234567"],
            orderNumbers: ["402-1234567-1234567"],
            status: "in_transit",
          },
        ],
      },
      {
        fixture: "amazon-nl-legacy-dispatched-amzl.eml",
        expect: [
          {
            ruleId: "order-amazon-nl",
            event: "order_shipped",
          },
          {
            ruleId: "parcel-amazon-nl",
            carrier: "amazon",
            trackingNumbers: ["NL2012345678"],
          },
        ],
      },
    ],
  },
  {
    id: "parcel-amazon",
    name: "Amazon shipping and delivery notifications",
    kind: "parcel",
    senders: {
      domains: [
        "amazon.de",
        "amazon.com",
        "amazon.co.uk",
        "amazon.it",
        "amazon.pl",
        "amazon.fr",
        "amazon.es",
        "amazon.nl",
        "amazon.ca",
        "amazon.com.au",
        "amazon.in",
      ],
      local_parts: [
        "shipment-tracking",
        "order-update",
        "conferma-spedizione",
        "delivering",
        "thehub",
        "versandbestaetigung",
        "dispatch-confirmation",
      ],
    },
    exclude: [
      "^(?:your )?(?:return|refund|rücksendung|rückgabe|erstattung|zwrot)",
      "zahlungserinnerung|mahnung",
    ],
    carrier: "amazon",
    carrier_from: "carrier",
    extractors: ["detect_tracking_numbers"],
    extract: {
      order_number: [
        {
          pattern: "(?<order_number>\\b\\d{3}-\\d{7}-\\d{7}\\b)",
        },
      ],
      carrier: [
        {
          pattern:
            "(?:delivery by|delivered by|zustellung durch|versand durch|versendet mit|carrier):?\\s*(?<carrier>[A-Za-z][A-Za-z .-]{1,30}?)\\s*(?:\\n|$|[.,(])",
          in: ["text"],
        },
      ],
      pickup_code: [
        {
          pattern: "package to pick up\\D{0,40}(?<pickup_code>\\d{6})",
          in: ["subject"],
        },
        {
          pattern:
            "(?:pickup code is|abholcode(?: lautet)?:?|one-time password is|einmalpasswort lautet)\\s*(?<pickup_code>\\d{6})",
          in: ["text"],
        },
      ],
      arrival: [
        {
          pattern:
            "(?<arrival>(?:now arriving|arriving|zustellung|ankunft|arriverà|dostawa)[^\\n]{0,60})",
          in: ["subject", "text"],
        },
      ],
      item: [
        {
          pattern: "^\\s*[•*]\\s*(?<item>[^\\n]{3,80})$",
          flags: ["i", "m"],
          in: ["text"],
        },
      ],
      tracking_url: [
        {
          pattern:
            '(?<tracking_url>https://www\\.amazon\\.[a-z.]+/(?:gp/your-account/ship-track|progress-tracker/package|gp/css/shiptrack)[^\\s"<>]*)',
          in: ["text", "html"],
        },
      ],
    },
    status_keywords: [
      {
        status: "at_pickup_point",
        patterns: ["package to pick up|zur abholung bereit|abholbereit|ready for pickup"],
      },
      {
        status: "delivered",
        patterns: ["^(?:delivered|zugestellt|geliefert|dostarczono|consegna effettuata)"],
        in: ["subject"],
      },
      {
        status: "problem",
        patterns: [
          "running late|verspätet sich|delivery attempt|zustellversuch|could not be delivered",
        ],
      },
      {
        status: "out_for_delivery",
        patterns: ["out for delivery|wird heute zugestellt|zustellung heute|in zustellung"],
      },
    ],
    default_status: "in_transit",
    tests: [
      {
        fixture: "amazon-de-shipped.eml",
        time_zone: "Europe/Berlin",
        expect: [
          // Results come in rule-id order: the order rule reads the same email.
          {
            ruleId: "order-amazon",
            kind: "order",
            event: "order_shipped",
            orderNumbers: ["302-1234567-1234567"],
          },
          {
            ruleId: "parcel-amazon",
            kind: "parcel",
            carrier: "dhl",
            trackingNumbers: ["00340434123456789012"],
            orderNumbers: ["302-1234567-1234567"],
            status: "in_transit",
            items: ["Beispielartikel, schwarz", "Ersatzkabel 2 m"],
            arrival: {
              from: "2026-11-20T00:00:00+01:00",
              to: "2026-11-21T00:00:00+01:00",
              allDay: true,
            },
            trackingUrl:
              "https://www.amazon.de/gp/your-account/ship-track?orderId=302-1234567-1234567&shipmentId=Dx0Ex0Ax0Mx0P",
          },
        ],
      },
      {
        // A placeholder number and an instruction bullet: no tracking number, one real item.
        fixture: "amazon-de-placeholder-dpd.eml",
        time_zone: "Europe/Berlin",
        expect: [
          {
            ruleId: "order-amazon",
          },
          {
            ruleId: "parcel-amazon",
            trackingNumbers: [],
            items: ["Beispielartikel"],
          },
        ],
      },
      {
        fixture: "amazon-com-delivered.eml",
        time_zone: "America/New_York",
        expect: [
          {
            ruleId: "parcel-amazon",
            carrier: "amazon",
            trackingNumbers: ["TBA301234567890"],
            orderNumbers: ["112-7654321-7654321"],
            status: "delivered",
          },
        ],
      },
      {
        fixture: "amazon-locker.eml",
        expect: [
          {
            ruleId: "parcel-amazon",
            status: "at_pickup_point",
            pickupCode: "246810",
            orderNumbers: ["114-1111111-2222222"],
          },
        ],
      },
      {
        fixture: "amazon-uk-late.eml",
        time_zone: "Europe/London",
        expect: [
          {
            ruleId: "parcel-amazon",
            status: "problem",
            orderNumbers: ["203-3333333-4444444"],
            arrival: {
              from: "2026-11-21T00:00:00+00:00",
              to: "2026-11-22T00:00:00+00:00",
              allDay: true,
            },
          },
        ],
      },
      {
        fixture: "amazon-de-today-window.eml",
        time_zone: "Europe/Berlin",
        expect: [
          {
            ruleId: "parcel-amazon",
            carrier: "amazon",
            trackingNumbers: ["DE2001234567"],
            status: "out_for_delivery",
            arrival: {
              from: "2026-11-18T17:00:00+01:00",
              to: "2026-11-18T19:00:00+01:00",
              allDay: false,
            },
          },
        ],
      },
    ],
  },
  {
    id: "return-amazon",
    name: "Amazon returns and refunds",
    kind: "return",
    senders: {
      domains: [
        "amazon.de",
        "amazon.com",
        "amazon.co.uk",
        "amazon.it",
        "amazon.pl",
        "amazon.fr",
        "amazon.es",
        "amazon.nl",
        "amazon.ca",
        "amazon.com.au",
        "amazon.in",
      ],
      local_parts: [
        "order-update",
        "rueckgabe",
        "return",
        "returns",
        "no-reply",
        "payments-messages",
      ],
    },
    subject: [
      "return label|your return|refund|rücksendung|rückgabe|erstattung|zwrot|rimborso|rimborsato",
    ],
    exclude: ["^(?:delivered|out for delivery|dispatched|zugestellt):"],
    carrier_from: "carrier",
    extract: {
      order_number: [
        {
          pattern: "(?<order_number>\\b\\d{3}-\\d{7}-\\d{7}\\b)",
        },
      ],
      carrier: [
        {
          pattern:
            "(?:return carrier|versanddienstleister|mit|with)\\s*:?\\s*(?<carrier>DHL|Hermes|UPS|DPD|GLS|Royal Mail|USPS|InPost)\\b",
          in: ["text"],
        },
      ],
    },
    event_keywords: [
      {
        event: "refund_issued",
        patterns: ["refund|erstattung|zwrot kosztów|rimborsato|rimborso"],
        in: ["subject"],
      },
      {
        event: "return_received",
        patterns: ["(?:return|rücksendung) (?:received|erhalten|ist eingegangen)"],
      },
      {
        event: "return_started",
        patterns: ["return label|your return|rücksendung|rückgabe|zwrot przedmiotu"],
        in: ["subject"],
      },
    ],
    require: ["order_number"],
    tests: [
      {
        fixture: "amazon-de-refund.eml",
        expect: [
          {
            ruleId: "return-amazon",
            kind: "return",
            event: "refund_issued",
            orderNumbers: ["302-1234567-1234567"],
          },
        ],
      },
      {
        fixture: "amazon-de-payments-refund.eml",
        expect: [
          {
            ruleId: "return-amazon",
            kind: "return",
            event: "refund_issued",
            orderNumbers: ["302-7654321-7654321"],
          },
        ],
      },
      {
        fixture: "amazon-uk-return-label.eml",
        expect: [
          {
            ruleId: "return-amazon",
            event: "return_started",
            carrier: "royalmail",
            orderNumbers: ["203-3333333-4444444"],
          },
        ],
      },
    ],
  },
];
