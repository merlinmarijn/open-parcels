import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reviveTrackingRemovals } from "../../src/engine/tracking-removal-repair.js";
import { createTestContext, type TestContext } from "../helpers.js";

// Made-up codes only.
const NOW = "2026-11-18T00:00:00.000Z";

describe("reviving parcels removed by tracking lookups", () => {
  let context: TestContext;

  beforeEach(async () => {
    context = await createTestContext();
  });
  afterEach(async () => {
    await context.close();
  });

  it("brings the parcel back and tells clients with parcel.registered (OP-130)", async () => {
    const db = context.services.db;
    await db
      .insertInto("connections")
      .values({
        id: "lookup",
        provider: "hermes",
        kind: "tracking",
        label: "lookup",
        config: "{}",
        secret_blob: null,
        session_blob: null,
        state: "ok",
        state_detail: null,
        backoff_until: null,
        next_run_at: null,
        last_run_at: null,
        last_ok_at: null,
        created_at: NOW,
        updated_at: NOW,
      })
      .execute();
    const parcel = await context.services.parcels.create({
      carrier: "hermes",
      trackingNumber: "H1000000000000000001",
      direction: "receiving",
      label: null,
    });
    await db.updateTable("parcels").set({ removed_at: NOW }).where("id", "=", parcel.id).execute();
    await db.deleteFrom("parcel_connections").where("parcel_id", "=", parcel.id).execute();
    await db
      .insertInto("parcel_connections")
      .values({
        parcel_id: parcel.id,
        connection_id: "lookup",
        external_ref: null,
        role: "primary",
        last_seen_at: NOW,
        missing_since: NOW,
      })
      .execute();
    await db.deleteFrom("outbox").execute();

    expect(await reviveTrackingRemovals(db, context.clock)).toBe(1);

    const events = await db.selectFrom("outbox").select(["type", "parcel_id"]).execute();
    expect(events).toEqual([{ type: "parcel.registered", parcel_id: parcel.id }]);
    expect(await reviveTrackingRemovals(db, context.clock)).toBe(0);
  });
});
