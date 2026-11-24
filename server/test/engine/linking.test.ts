import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_CARRIERS } from "../../src/engine/builtin-carriers.js";
import { acceptsEmptyConfig } from "../../src/engine/linking.js";
import { createTestContext, type TestContext } from "../helpers.js";

/* Linking parcels to their carrier's tracking connection. Every code is made up. */

let context: TestContext;

beforeEach(async () => {
  context = await createTestContext({ providers: BUILTIN_CARRIERS });
});
afterEach(async () => {
  await context.close();
});

async function insertParcel(carrier: string, trackingNumber: string): Promise<string> {
  const id = crypto.randomUUID();
  const now = context.clock.now().toISOString();
  await context.services.db
    .insertInto("parcels")
    .values({
      id,
      carrier,
      tracking_number: trackingNumber,
      direction: "receiving",
      status: "registered",
      raw_status: null,
      delivered: 0,
      pickup: 0,
      label: null,
      first_seen_at: now,
      last_seen_at: now,
      updated_at: now,
    })
    .execute();
  return id;
}

describe("linking untracked parcels", () => {
  it("links a parcel of every built-in carrier without throwing", async () => {
    const carriers = context.services.registry.list();
    for (const [index, provider] of carriers.entries()) {
      await insertParcel(provider.info.id, `TEST${String(index).padStart(6, "0")}`);
    }
    const result = await context.services.connections.linkUntracked();

    for (const provider of carriers) {
      const connection = await context.services.db
        .selectFrom("connections")
        .select("id")
        .where("provider", "=", provider.info.id)
        .where("kind", "=", "tracking")
        .executeTakeFirst();
      const creatable = provider.canTrack && acceptsEmptyConfig(provider);
      expect(connection !== undefined, provider.info.id).toBe(creatable);
      expect(result.unlinkedCarriers.has(provider.info.id), provider.info.id).toBe(!creatable);
    }
    // The carriers whose settings need a postcode or a country are among those left waiting.
    expect(result.unlinkedCarriers.has("gls")).toBe(true);
    expect(result.unlinkedCarriers.has("evri")).toBe(true);
  });

  it("links a waiting parcel once the user adds the carrier's connection", async () => {
    const parcelId = await insertParcel("gls", "TESTGLS000001");
    expect((await context.services.connections.linkUntracked()).parcels).toBe(0);
    const connection = await context.services.connections.create({
      provider: "gls",
      kind: "tracking",
      label: "GLS",
      config: { country: "NL", postalCode: "1234 AB" },
      secret: null,
    });
    expect((await context.services.connections.linkUntracked()).parcels).toBe(1);
    const link = await context.services.db
      .selectFrom("parcel_connections")
      .select("connection_id")
      .where("parcel_id", "=", parcelId)
      .executeTakeFirst();
    expect(link?.connection_id).toBe(connection.id);
  });

  it("stores a code added by hand for a carrier that needs settings, unlinked", async () => {
    const parcel = await context.services.parcels.create({
      carrier: "gls",
      trackingNumber: "TESTGLS000002",
      direction: "receiving",
      label: null,
    });
    expect(parcel.connections).toEqual([]);
  });
});
