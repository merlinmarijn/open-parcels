import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendEvent,
  OUTBOX_MAX_ROWS,
  OUTBOX_RETENTION_MS,
  SHORT_LIVED_RETENTION_MS,
} from "../../src/events/bus.js";
import type { EventType } from "../../src/events/types.js";
import { createTestContext, type TestContext } from "../helpers.js";

let context: TestContext;
beforeEach(async () => {
  context = await createTestContext();
});
afterEach(async () => {
  await context.close();
});

async function add(type: EventType, count = 1): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await appendEvent(context.services.db, context.clock, { type, parcelId: null, payload: {} });
  }
}

async function types(): Promise<string[]> {
  const rows = await context.services.db
    .selectFrom("outbox")
    .select("type")
    .orderBy("seq")
    .execute();
  return rows.map((row) => row.type);
}

describe("outbox pruning", () => {
  it("drops short-lived events after minutes and the rest after a day", async () => {
    await add("source.run_finished");
    await add("parcel.live_updated");
    await add("parcel.status_changed");
    context.clock.advance(SHORT_LIVED_RETENTION_MS + 1);
    await context.services.bus.pruneExpired();
    expect(await types()).toEqual(["parcel.status_changed"]);
    context.clock.advance(OUTBOX_RETENTION_MS);
    await context.services.bus.pruneExpired();
    expect(await types()).toEqual([]);
  });

  it("keeps at most the newest rows, whatever their age", async () => {
    await add("parcel.status_changed", OUTBOX_MAX_ROWS + 5);
    expect(await context.services.bus.pruneExpired()).toBe(5);
    expect((await types()).length).toBe(OUTBOX_MAX_ROWS);
  });
});
