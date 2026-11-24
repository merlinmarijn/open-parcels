import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeWorld, fakePost } from "../fakes/carriers.js";
import { createTestContext, type TestContext } from "../helpers.js";

/* Regressions found by a live end-to-end run: clients learn of new, renamed and idle connections.
 * Every code and label is made up. */

let context: TestContext;
let post: FakeWorld;

beforeEach(async () => {
  post = new FakeWorld();
  context = await createTestContext({ providers: [fakePost(post)] });
});
afterEach(async () => {
  await context.close();
});

async function outbox(type: string): Promise<Record<string, unknown>[]> {
  const rows = await context.services.db
    .selectFrom("outbox")
    .select("payload")
    .where("type", "=", type)
    .orderBy("seq")
    .execute();
  return rows.map((row) => JSON.parse(row.payload) as Record<string, unknown>);
}

const addTracking = (label: string) =>
  context.services.connections.create({
    provider: "fakepost",
    kind: "tracking",
    label,
    config: {},
    secret: null,
  });

describe("connection.added", () => {
  it("fires when the user adds a connection, before any run", async () => {
    const connection = await addTracking("Made-up tracking");
    expect(await outbox("connection.added")).toEqual([
      {
        connection: {
          id: connection.id,
          provider: "fakepost",
          label: "Made-up tracking",
          kind: "tracking",
        },
        state: "ok",
        detail: "Not run yet.",
      },
    ]);
  });

  it("fires when the app makes a tracking connection for a code added by hand", async () => {
    const parcel = await context.services.parcels.create({
      carrier: "fakepost",
      trackingNumber: "FP8001",
      direction: "receiving",
      label: null,
    });
    const [added] = await outbox("connection.added");
    expect(added?.["connection"]).toMatchObject({
      id: parcel.connections[0]?.connection_id,
      kind: "tracking",
    });
  });
});

describe("connection.updated", () => {
  it("fires with the new label on a rename, and not for an unchanged save", async () => {
    const connection = await addTracking("Old made-up name");
    await context.services.connections.updateSettings(connection.id, { label: "Old made-up name" });
    expect(await outbox("connection.updated")).toEqual([]);
    await context.services.connections.updateSettings(connection.id, { label: "New made-up name" });
    const updated = await outbox("connection.updated");
    expect(updated).toHaveLength(1);
    expect(updated[0]?.["connection"]).toMatchObject({
      id: connection.id,
      label: "New made-up name",
    });
  });
});

describe("a run the provider skips on purpose", () => {
  it("claims no success and says why", async () => {
    const parcel = await context.services.parcels.create({
      carrier: "fakepost",
      trackingNumber: "FP8002",
      direction: "receiving",
      label: null,
    });
    const connectionId = parcel.connections[0]?.connection_id ?? "";
    const before = await context.services.parcels.repository.get(parcel.id);
    post.idle = "Public tracking off: nothing to look up.";
    await context.services.connections.requestRun(connectionId);
    await context.services.scheduler.runDue();

    const connection = await context.services.connections.get(connectionId);
    expect(connection).toMatchObject({
      state: "idle",
      stateDetail: "Public tracking off: nothing to look up.",
      lastOkAt: null,
    });
    expect(connection?.lastRunAt).not.toBeNull();
    // Nothing was asked, so the parcel is not judged unknown to the carrier.
    expect(await context.services.parcels.repository.get(parcel.id)).toEqual(before);
    const [finished] = await outbox("connection.run_finished");
    expect(finished).toMatchObject({
      ok: true,
      state: "idle",
      detail: "Public tracking off: nothing to look up.",
    });

    // An idle connection stays scheduled; once it does something again it is OK, the detail clears
    // and the success counts.
    post.idle = undefined;
    await context.services.connections.requestRun(connectionId);
    expect(await context.services.scheduler.runDue()).toBe(1);
    expect(await context.services.connections.get(connectionId)).toMatchObject({
      state: "ok",
      stateDetail: null,
    });
    expect((await context.services.connections.get(connectionId))?.lastOkAt).not.toBeNull();
  });
});
