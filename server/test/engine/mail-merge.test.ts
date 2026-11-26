import { loadRules, withEmailRules } from "open-parcels-rules";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HERMES_EMAIL_RULES } from "../../src/carriers/hermes/email-rules.js";
import { healState, mergeParcel, type ParcelState } from "../../src/engine/merge.js";
import { maskIdentifiers } from "../../src/engine/vocab.js";
import { createMailInterpreter } from "../../src/mail/interpret.js";
import type { MailInput } from "../../src/mail/types.js";
import { snapshot, type ParcelSnapshot, type SnapshotEvent } from "../../src/provider/snapshot.js";
import { createTestContext, type TestContext } from "../helpers.js";

// A made-up version of a Hermes parcel seen live: the carrier says delivered, and a few seconds
// later its delivery mail arrives twice with wording the old rules did not map.
const TRACKING_NUMBER = "H1000012000000109999";
const OUT_FOR_DELIVERY: SnapshotEvent = {
  at: "2026-11-18T07:30:00.000Z",
  status: "out_for_delivery",
  rawStatus: "Die Sendung wurde ins Zustellfahrzeug geladen.",
  location: null,
};
const CARRIER_DELIVERED: SnapshotEvent = {
  at: "2026-11-18T14:28:12.000Z",
  status: "delivered",
  rawStatus: "Die Sendung wurde an der Empfangsadresse zugestellt.",
  location: null,
};
const SUBJECT = "Erfolgreiche Haustürzustellung";

function hermesSnapshot(): ParcelSnapshot {
  return snapshot({
    carrier: "hermes",
    trackingNumber: TRACKING_NUMBER,
    status: "delivered",
    rawStatus: "DELIVERED_HOMEDELIVERY",
    delivered: true,
    history: [OUT_FOR_DELIVERY, CARRIER_DELIVERED],
  });
}

function mailEntry(at: string, id?: string): SnapshotEvent {
  return {
    at,
    status: null,
    rawStatus: SUBJECT,
    location: null,
    ...(id === undefined ? {} : { id }),
  };
}

/** The delivery mail as the old rules read it: no status at all. */
function statuslessMail(at: string, id?: string): ParcelSnapshot {
  return snapshot({
    carrier: "hermes",
    trackingNumber: TRACKING_NUMBER,
    status: null,
    rawStatus: SUBJECT,
    history: [mailEntry(at, id)],
  });
}

function mail(date: string): MailInput {
  return {
    messageId: "<made-up-1@example.invalid>",
    from: "Hermes <noreply@paketankuendigung.myhermes.de>",
    subject: SUBJECT,
    text: `Ihre Sendung ${TRACKING_NUMBER} haben wir heute an Ihrer Haustür übergeben.`,
    html: null,
    authentication: null,
    date: new Date(date),
  };
}

describe("merging a statusless mail into a delivered parcel", () => {
  it("never lets the mail override the carrier's mapped status", () => {
    const delivered = mergeParcel(null, hermesSnapshot(), "carrier");
    expect(delivered).toMatchObject({ status: "delivered", delivered: true });
    expect(delivered.deliveredAt).not.toBeNull();

    const after = mergeParcel(delivered, statuslessMail("2026-11-18T14:28:16.000Z"), "secondary", [
      OUT_FOR_DELIVERY,
      CARRIER_DELIVERED,
    ]);
    expect(after).toMatchObject({
      status: "delivered",
      delivered: true,
      deliveredAt: delivered.deliveredAt,
      rawStatus: "DELIVERED_HOMEDELIVERY",
    });
  });

  it("falls back to the newest mapped entry of the merged history", () => {
    const stored: ParcelState = {
      ...mergeParcel(null, statuslessMail("2026-11-18T14:28:15.000Z"), "secondary"),
    };
    expect(stored.status).toBe("unknown");
    const after = mergeParcel(stored, statuslessMail("2026-11-18T14:28:16.000Z"), "secondary", [
      OUT_FOR_DELIVERY,
      CARRIER_DELIVERED,
    ]);
    expect(after).toMatchObject({
      status: "delivered",
      delivered: true,
      deliveredAt: CARRIER_DELIVERED.at,
      rawStatus: CARRIER_DELIVERED.rawStatus,
    });
  });

  it("treats a carrier's delivered flag as delivered even without a mapped code", () => {
    const flagged = snapshot({
      ...hermesSnapshot(),
      status: null,
      rawStatus: "SOME_NEW_CODE",
      delivered: true,
      history: [],
    });
    expect(mergeParcel(null, flagged, "carrier")).toMatchObject({
      status: "delivered",
      delivered: true,
    });
  });

  it("repairs a parcel stored the old way, once", () => {
    const broken: ParcelState = {
      ...mergeParcel(null, statuslessMail("2026-11-18T14:28:16.000Z"), "secondary"),
      rawStatus: SUBJECT,
    };
    const history = [OUT_FOR_DELIVERY, CARRIER_DELIVERED, mailEntry("2026-11-18T14:28:16.000Z")];
    const healed = healState(broken, history);
    expect(healed).toMatchObject({ status: "delivered", delivered: true });
    expect(healed?.deliveredAt).toBe(CARRIER_DELIVERED.at);
    expect(healed === null ? "unhealed" : healState(healed, history)).toBeNull();
  });
});

describe("the Hermes delivery mail", () => {
  // Read with the Hermes provider's email rules, as the inbox routes it.
  const interpret = createMailInterpreter(
    withEmailRules(loadRules(), HERMES_EMAIL_RULES),
    "Europe/Berlin",
  );

  it("maps to delivered through the Hermes provider's rules", () => {
    const [found] = interpret(mail("2026-11-18T14:28:16Z"));
    expect(found).toMatchObject({ carrier: "hermes", status: "delivered", delivered: true });
    expect(found?.history[0]?.status).toBe("delivered");
  });

  it("gives the same entry id when the mail is read twice", () => {
    const first = interpret(mail("2026-11-18T14:28:15Z"))[0]?.history[0]?.id;
    const second = interpret(mail("2026-11-18T14:28:16Z"))[0]?.history[0]?.id;
    expect(first).toBeDefined();
    expect(second).toBe(first);
  });
});

describe("masking identifiers in recorded mail subjects", () => {
  it("keeps the wording and drops numbers", () => {
    expect(maskIdentifiers(`Ihre Sendung ${TRACKING_NUMBER} kommt`)).toBe("Ihre Sendung # kommt");
    expect(maskIdentifiers(SUBJECT)).toBe(SUBJECT);
  });
});

describe("the reconciler with a carrier and a mail connection", () => {
  let context: TestContext;

  beforeEach(async () => {
    context = await createTestContext();
  });
  afterEach(async () => {
    await context.close();
  });

  async function addConnection(id: string, kind: "tracking" | "mail"): Promise<void> {
    const now = "2026-11-18T00:00:00.000Z";
    await context.services.db
      .insertInto("connections")
      .values({
        id,
        provider: kind === "mail" ? "imap" : "hermes",
        kind,
        label: id,
        config: "{}",
        secret_blob: null,
        session_blob: null,
        state: "ok",
        state_reason: null,
        carrier_message: null,
        backoff_until: null,
        next_run_at: null,
        last_run_at: null,
        last_ok_at: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
  }

  async function parcelRow() {
    return context.services.db
      .selectFrom("parcels")
      .selectAll()
      .where("tracking_number", "=", TRACKING_NUMBER)
      .executeTakeFirstOrThrow();
  }

  it("keeps the parcel delivered, stores one entry per mail and records unmapped wording", async () => {
    await addConnection("carrier", "tracking");
    await addConnection("mailbox", "mail");
    const { reconciler, db } = context.services;
    await reconciler.ingest("carrier", { snapshots: [hermesSnapshot()], complete: false });
    const duplicate = (at: string): ParcelSnapshot =>
      statuslessMail(at, "mail:<made-up-1@example.invalid>");
    await reconciler.ingest("mailbox", {
      snapshots: [duplicate("2026-11-18T14:28:15.000Z"), duplicate("2026-11-18T14:28:16.000Z")],
      complete: false,
    });

    const row = await parcelRow();
    expect(row).toMatchObject({ status: "delivered", delivered: 1 });
    expect(row.delivered_at).not.toBeNull();
    const events = await db
      .selectFrom("parcel_events")
      .select("raw_status")
      .where("parcel_id", "=", row.id)
      .execute();
    expect(events.filter((event) => event.raw_status === SUBJECT)).toHaveLength(1);
    const vocab = await db.selectFrom("unknown_vocab").selectAll().execute();
    expect(vocab).toMatchObject([{ provider: "hermes", kind: "mail_subject", key: SUBJECT }]);
  });

  it("repairs a parcel already stored as unknown, idempotently", async () => {
    await addConnection("carrier", "tracking");
    await addConnection("mailbox", "mail");
    const { reconciler, db } = context.services;
    await reconciler.ingest("carrier", { snapshots: [hermesSnapshot()], complete: false });
    const stored = await parcelRow();
    // Put the parcel back the way the old merge left it.
    await db
      .updateTable("parcels")
      .set({ status: "unknown", raw_status: SUBJECT, delivered: 0, delivered_at: null })
      .where("id", "=", stored.id)
      .execute();

    expect(await reconciler.repair()).toBe(1);
    const healed = await parcelRow();
    expect(healed).toMatchObject({
      status: "delivered",
      delivered: 1,
      delivered_at: CARRIER_DELIVERED.at,
    });
    expect(await reconciler.repair()).toBe(0);
  });

  it("heals an unknown parcel on its next reconcile", async () => {
    await addConnection("carrier", "tracking");
    await addConnection("mailbox", "mail");
    const { reconciler, db } = context.services;
    await reconciler.ingest("carrier", { snapshots: [hermesSnapshot()], complete: false });
    const stored = await parcelRow();
    await db
      .updateTable("parcels")
      .set({ status: "unknown", delivered: 0, delivered_at: null })
      .where("id", "=", stored.id)
      .execute();
    await reconciler.ingest("mailbox", {
      snapshots: [statuslessMail("2026-11-18T14:28:20.000Z")],
      complete: false,
    });
    expect(await parcelRow()).toMatchObject({ status: "delivered", delivered: 1 });
  });
});

describe("an expected delivery the carrier withdrew", () => {
  it("is cleared when the carrier states the whole truth, kept otherwise (OP-022)", () => {
    const planned = mergeParcel(
      null,
      snapshot({
        carrier: "hermes",
        trackingNumber: TRACKING_NUMBER,
        status: "out_for_delivery",
        rawStatus: "Out",
        expectedFrom: "2026-11-18T09:00:00.000Z",
        expectedTo: "2026-11-18T11:00:00.000Z",
        history: [OUT_FOR_DELIVERY],
      }),
      "carrier",
    );
    const missed = (historyComplete: boolean) =>
      mergeParcel(
        planned,
        snapshot({
          carrier: "hermes",
          trackingNumber: TRACKING_NUMBER,
          status: "in_transit",
          rawStatus: "Missed",
          historyComplete,
          history: [OUT_FOR_DELIVERY, { ...OUT_FOR_DELIVERY, at: "2026-11-18T12:00:00.000Z" }],
        }),
        "carrier",
      );
    expect(missed(true)).toMatchObject({ expectedFrom: null, expectedTo: null });
    expect(missed(false)).toMatchObject({ expectedFrom: "2026-11-18T09:00:00.000Z" });
  });
});
