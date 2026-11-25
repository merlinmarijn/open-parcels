import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mergeDuplicateTrackingConnections } from "../../src/engine/connection-dedup.js";
import { SignInRejectedError, TransientError } from "../../src/provider/api.js";
import { FakeWorld, fakePost, fakeShop, scan, snapshot } from "../fakes/carriers.js";
import { createTestContext, type TestContext } from "../helpers.js";

/* Regressions found by a live end-to-end run. Every code, label and order number is made up. */

let context: TestContext;
let post: FakeWorld;
let shop: FakeWorld;

beforeEach(async () => {
  post = new FakeWorld();
  shop = new FakeWorld();
  context = await createTestContext({ providers: [fakePost(post), fakeShop(shop)] });
});
afterEach(async () => {
  await context.close();
});

async function addConnection(
  provider: "fakepost" | "fakeshop",
  kind: "account" | "shop" | "tracking",
) {
  const secret =
    kind === "account"
      ? { username: "user@example.invalid", password: ["x", "y"].join("-") }
      : null;
  return (
    await context.services.connections.create({ provider, kind, label: kind, config: {}, secret })
  ).id;
}

async function runNow(id: string): Promise<void> {
  await context.services.connections.requestRun(id);
  await context.services.scheduler.runDue();
}

async function outbox(type: string): Promise<Record<string, unknown>[]> {
  const rows = await context.services.db
    .selectFrom("outbox")
    .select("payload")
    .where("type", "=", type)
    .orderBy("seq")
    .execute();
  return rows.map((row) => JSON.parse(row.payload) as Record<string, unknown>);
}

describe("a manual status is the effective status", () => {
  it("drops a parcel delivered by hand from the active list, keeping the carrier's values", async () => {
    const parcel = await context.services.parcels.create({
      carrier: "fakepost",
      trackingNumber: "FP7001",
      direction: "receiving",
      label: null,
    });
    await context.services.parcels.update(parcel.id, { manualStatus: "delivered" });
    const after = await context.services.parcels.repository.get(parcel.id);
    expect(after).toMatchObject({
      status: "delivered",
      delivered: true,
      manual_status: "delivered",
      carrier_status: "registered",
      carrier_delivered: false,
    });
    const repository = context.services.parcels.repository;
    expect(await repository.list({ active: true }, false)).toEqual([]);
    expect((await repository.list({ active: false }, false)).map((p) => p.id)).toEqual([parcel.id]);
    // The event payload carries the effective values too, for Home Assistant's summaries.
    const [delivered] = await outbox("parcel.delivered");
    expect(delivered?.["parcel"]).toMatchObject({ status: "delivered", delivered: true });
  });
});

describe("deletions reach clients", () => {
  it("fires parcel.deleted for a deleted parcel and connection.removed for a deleted connection", async () => {
    const parcel = await context.services.parcels.create({
      carrier: "fakepost",
      trackingNumber: "FP7002",
      direction: "receiving",
      label: null,
    });
    expect(await context.services.parcels.delete(parcel.id)).toBe(true);
    expect(await context.services.parcels.delete(parcel.id)).toBe(false);
    const deleted = await outbox("parcel.deleted");
    expect(deleted).toHaveLength(1);
    expect(deleted[0]?.["parcel"]).toMatchObject({ id: parcel.id });

    const connectionId = await addConnection("fakepost", "tracking");
    expect(await context.services.connections.delete(connectionId)).toBe(true);
    // The first removal is the auto-created tracking connection going with its only parcel.
    const removed = await outbox("connection.removed");
    expect(removed).toHaveLength(2);
    expect(removed[1]).toMatchObject({
      connection: { id: connectionId, provider: "fakepost" },
      merged_into: null,
    });
  });
});

describe("auto-created tracking connections", () => {
  const add = (trackingNumber: string) =>
    context.services.parcels.create({
      carrier: "fakepost",
      trackingNumber,
      direction: "receiving",
      label: null,
    });

  it("go with the last parcel deleted, firing connection.removed", async () => {
    const first = await add("FP7101");
    const second = await add("FP7102");
    const connectionId = first.connections[0]?.connection_id ?? "";
    expect(second.connections[0]?.connection_id).toBe(connectionId);

    await context.services.parcels.delete(first.id);
    expect(await context.services.connections.get(connectionId)).toBeDefined();
    expect(await outbox("connection.removed")).toEqual([]);

    await context.services.parcels.delete(second.id);
    expect(await context.services.connections.get(connectionId)).toBeUndefined();
    expect(await outbox("connection.removed")).toEqual([
      expect.objectContaining({
        connection: expect.objectContaining({ id: connectionId, kind: "tracking" }) as unknown,
        merged_into: null,
      }),
    ]);
    // Needed again: made again.
    const third = await add("FP7103");
    expect(third.connections[0]?.connection_id).toBeDefined();
  });

  it("go with the last parcel even after a run stored session state", async () => {
    const parcel = await add("FP7105");
    const connectionId = parcel.connections[0]?.connection_id ?? "";
    await runNow(connectionId);
    expect(post.trackCalls).toEqual([["FP7105"]]);
    const row = await context.services.db
      .selectFrom("connections")
      .select(["session_blob", "secret_blob"])
      .where("id", "=", connectionId)
      .executeTakeFirstOrThrow();
    expect(row.session_blob).not.toBeNull();
    expect(row.secret_blob).toBeNull();

    await context.services.parcels.delete(parcel.id);
    expect(await context.services.connections.get(connectionId)).toBeUndefined();
    expect(await outbox("connection.removed")).toHaveLength(1);
  });

  it("never remove a tracking connection the user made", async () => {
    const own = await addConnection("fakepost", "tracking");
    const parcel = await add("FP7104");
    expect(parcel.connections[0]?.connection_id).toBe(own);
    await context.services.parcels.delete(parcel.id);
    expect(await context.services.connections.get(own)).toBeDefined();
    expect(await outbox("connection.removed")).toEqual([]);
  });
});

describe("a failed run says what failed", () => {
  it("puts the provider's reason, scrubbed, into the connection's carrier message", async () => {
    const id = await addConnection("fakepost", "account");
    post.failWith = new TransientError(
      "Fake tracking answered HTTP 403 (text/html) for 00340434000000000077, expected 200.",
    );
    await runNow(id);
    const connection = await context.services.connections.get(id);
    expect(connection?.state).toBe("error");
    expect(connection?.stateReason).toBe("update_failed");
    expect(connection?.carrierMessage).toContain("HTTP 403 (text/html)");
    expect(connection?.carrierMessage).not.toContain("00340434000000000077");
  });
});

describe("one code, one parcel across a shop and its carrier", () => {
  const delivered = snapshot({
    carrier: "fakeshop",
    trackingNumber: "FPX12345678",
    status: "delivered",
    rawStatus: "Delivered",
    deliveredAt: "2026-11-17T10:00:00Z",
    history: [scan("2026-11-17T10:00:00Z", "Delivered", "delivered")],
  });

  it("hands a shop's code off to the carrier parcel that already tracks it", async () => {
    await context.services.parcels.create({
      carrier: "fakepost",
      trackingNumber: "FPX12345678",
      direction: "receiving",
      label: null,
    });
    shop.listing = [delivered];
    await runNow(await addConnection("fakeshop", "shop"));
    const parcels = await context.services.parcels.repository.list({}, false);
    expect(parcels).toHaveLength(1);
    expect(parcels[0]).toMatchObject({ carrier: "fakepost", tracking_number: "FPX12345678" });
    expect(parcels[0]?.connections.map((connection) => connection.role).sort()).toEqual([
      "handoff",
      "primary",
    ]);
  });

  it("folds the shop's parcel in when the carrier reports the same code later", async () => {
    shop.listing = [delivered];
    await runNow(await addConnection("fakeshop", "shop"));
    post.listing = [
      snapshot({
        carrier: "fakepost",
        trackingNumber: "FPX12345678",
        status: null,
        rawStatus: null,
      }),
    ];
    await runNow(await addConnection("fakepost", "account"));
    const parcels = await context.services.parcels.repository.list({}, false);
    expect(parcels.map((parcel) => [parcel.carrier, parcel.tracking_number])).toEqual([
      ["fakepost", "FPX12345678"],
    ]);
  });

  it("repairs a stored duplicate on start, idempotently, keeping the shop's history", async () => {
    const shopId = await addConnection("fakeshop", "shop");
    shop.listing = [delivered];
    await runNow(shopId);
    // A duplicate as an earlier version stored it: the carrier's own row, not found.
    const now = context.clock.now().toISOString();
    await context.services.db
      .insertInto("parcels")
      .values({
        id: crypto.randomUUID(),
        carrier: "fakepost",
        tracking_number: "FPX12345678",
        direction: "receiving",
        status: "unknown",
        raw_status: null,
        delivered: 0,
        pickup: 0,
        label: null,
        first_seen_at: now,
        last_seen_at: now,
        updated_at: now,
      })
      .execute();
    expect(await context.services.parcels.repository.list({}, false)).toHaveLength(2);

    await context.services.reconciler.repair();
    await context.services.reconciler.repair();
    const parcels = await context.services.parcels.repository.list({}, true);
    expect(parcels).toHaveLength(1);
    expect(parcels[0]).toMatchObject({ carrier: "fakepost", status: "delivered", delivered: true });
    expect(await outbox("parcel.deleted")).toHaveLength(1);
  });
});

describe("connection states", () => {
  it("says 'not signed in yet' when a connection without any sign-in is refused", async () => {
    const id = await addConnection("fakeshop", "shop");
    shop.failWith = new SignInRejectedError("no session");
    await runNow(id);
    expect(await context.services.connections.get(id)).toMatchObject({
      state: "needs_sign_in",
      stateReason: "not_signed_in_yet",
    });
  });

  it("does not call a never-successful connection OK after it is disabled and enabled", async () => {
    const id = await addConnection("fakeshop", "shop");
    expect((await context.services.connections.get(id))?.stateReason).toBe("not_run_yet");
    await context.services.connections.updateSettings(id, { enabled: false });
    await context.services.connections.updateSettings(id, { enabled: true });
    expect(await context.services.connections.get(id)).toMatchObject({
      state: "ok",
      stateReason: "not_run_yet",
    });
    await runNow(id);
    expect((await context.services.connections.get(id))?.stateReason).toBeNull();
  });

  it("announces every finished run, so open views refresh", async () => {
    const id = await addConnection("fakeshop", "shop");
    await runNow(id);
    await runNow(id);
    expect(await outbox("connection.run_finished")).toHaveLength(2);
  });

  it("merges duplicate keyless tracking connections into the oldest, moving the parcel links", async () => {
    const older = await context.services.connections.ensureTrackingConnection("fakepost");
    context.clock.advance(1000);
    const newer = await addConnection("fakepost", "tracking");
    const parcel = await context.services.parcels.create({
      carrier: "fakepost",
      trackingNumber: "FP7003",
      direction: "receiving",
      label: null,
    });
    await context.services.db
      .updateTable("parcel_connections")
      .set({ connection_id: newer })
      .where("parcel_id", "=", parcel.id)
      .execute();

    expect(await mergeDuplicateTrackingConnections(context.services.db, context.clock)).toBe(1);
    expect(await mergeDuplicateTrackingConnections(context.services.db, context.clock)).toBe(0);
    const connections = await context.services.connections.list();
    expect(
      connections.filter((connection) => connection.kind === "tracking").map((s) => s.id),
    ).toEqual([older]);
    const after = await context.services.parcels.repository.get(parcel.id);
    expect(after?.connections.map((connection) => connection.connection_id)).toEqual([older]);
    expect(await outbox("connection.removed")).toEqual([
      expect.objectContaining({ merged_into: older }),
    ]);
  });

  it("names each connection of a parcel and counts a carrier account listing it as found", async () => {
    post.listing = [
      snapshot({
        carrier: "fakepost",
        trackingNumber: "FP7004",
        status: "in_transit",
        rawStatus: "x",
      }),
    ];
    await runNow(await addConnection("fakepost", "account"));
    const [parcel] = await context.services.parcels.repository.list({}, false);
    context.clock.advance(1000);
    const tracking = await context.services.connections.ensureTrackingConnection("fakepost");
    await context.services.db
      .insertInto("parcel_connections")
      .values({
        parcel_id: parcel?.id ?? "",
        connection_id: tracking,
        external_ref: null,
        role: "primary",
        last_seen_at: context.clock.now().toISOString(),
      })
      .execute();
    // Public tracking did not return it; the account did.
    await context.services.db
      .updateTable("parcels")
      .set({ lookup_state: "not_found", lookup_since: context.clock.now().toISOString() })
      .execute();
    const after = await context.services.parcels.repository.get(parcel?.id ?? "");
    expect(after?.connections.map((connection) => [connection.label, connection.kind])).toEqual([
      ["account", "account"],
      ["Fake Post tracking", "tracking"],
    ]);
    // Found since the account first listed it, never "since never".
    expect(after?.lookup).toMatchObject({ state: "found", since: parcel?.first_seen_at });
    expect(after?.lookup.since).not.toBeNull();
  });

  it("dates a found parcel without a recorded start from when it was first seen", async () => {
    const parcel = await context.services.parcels.create({
      carrier: "fakepost",
      trackingNumber: "FP7005",
      direction: "receiving",
      label: null,
    });
    await context.services.db
      .updateTable("parcels")
      .set({ lookup_state: "found", lookup_since: null })
      .execute();
    const after = await context.services.parcels.repository.get(parcel.id);
    expect(after?.lookup).toMatchObject({ state: "found", since: parcel.first_seen_at });
  });
});
