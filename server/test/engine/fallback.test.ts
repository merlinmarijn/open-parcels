import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { App } from "../../src/api/app.js";
import { FakeWorld, fakeFallback, fakePost, snapshot } from "../fakes/carriers.js";
import { createTestContext, signIn, type TestContext } from "../helpers.js";

const DAY = 24 * 60 * 60 * 1000;

let context: TestContext;
let post: FakeWorld;
let first: FakeWorld;
let second: FakeWorld;

beforeEach(async () => {
  post = new FakeWorld();
  post.complete = false;
  first = new FakeWorld();
  second = new FakeWorld();
  context = await createTestContext({
    providers: [
      fakePost(post),
      fakeFallback("lookup_one", first),
      fakeFallback("lookup_two", second),
    ],
  });
});
afterEach(async () => {
  await context.close();
});

async function addFallback(provider: string): Promise<string> {
  const connection = await context.services.connections.create({
    provider,
    kind: "tracking",
    label: provider,
    config: {},
    secret: null,
  });
  context.clock.advance(1000);
  return connection.id;
}

async function track(trackingNumber: string): Promise<string> {
  const parcel = await context.services.parcels.create({
    carrier: "fakepost",
    trackingNumber,
    direction: "receiving",
    label: null,
  });
  return parcel.id;
}

/** Runs the carrier's connection now, then everything that became due. */
async function runCarrier(): Promise<void> {
  const carrier = (await context.services.connections.list()).find(
    (connection) => connection.provider === "fakepost",
  );
  await context.services.connections.requestRun(carrier?.id ?? "");
  await context.services.scheduler.runDue();
  await context.services.scheduler.runDue();
}

const listed = (trackingNumber: string) =>
  snapshot({ carrier: "fakepost", trackingNumber, status: "in_transit", rawStatus: "Moving" });

describe("fallback tracking services", () => {
  it("are asked about a parcel only after its carrier has not found it for a day", async () => {
    await addFallback("lookup_one");
    const id = await track("FP2001");
    first.listing = [listed("FP2001")];
    await runCarrier();
    expect(first.trackCalls).toEqual([]);

    context.clock.advance(DAY);
    await runCarrier();
    expect(first.trackCalls).toEqual([["FP2001"]]);
    const parcel = await context.services.parcels.repository.get(id);
    // Filed under the parcel's own carrier: one parcel, found, moving.
    expect(parcel).toMatchObject({ carrier: "fakepost", status: "in_transit" });
    expect(parcel?.lookup.state).toBe("found");
    const all = await context.services.db.selectFrom("parcels").select("id").execute();
    expect(all).toHaveLength(1);

    // The carrier's "not found" no longer overrides what the fallback found.
    await runCarrier();
    expect((await context.services.parcels.repository.get(id))?.lookup.state).toBe("found");
  });

  it("asks the next service only when the first has not found it for a day either", async () => {
    await addFallback("lookup_two");
    await addFallback("lookup_one");
    await track("FP2002");
    second.listing = [listed("FP2002")];
    await runCarrier();
    context.clock.advance(DAY);
    await runCarrier();
    // Both are unknown providers to the fixed order, so the one added first is asked first.
    expect(second.trackCalls).toEqual([["FP2002"]]);
    expect(first.trackCalls).toEqual([]);
  });

  it("escalates from one service to the next after a day without an answer", async () => {
    await addFallback("lookup_one");
    await addFallback("lookup_two");
    const id = await track("FP2003");
    second.listing = [listed("FP2003")];
    await runCarrier();
    context.clock.advance(DAY);
    await runCarrier();
    expect(first.trackCalls).toEqual([["FP2003"]]);
    expect(second.trackCalls).toEqual([]);
    context.clock.advance(DAY);
    await runCarrier();
    expect(second.trackCalls).toEqual([["FP2003"]]);
    expect((await context.services.parcels.repository.get(id))?.status).toBe("in_transit");
  });

  it("are never asked while the carrier finds the parcel", async () => {
    await addFallback("lookup_one");
    await track("FP2004");
    post.listing = [listed("FP2004")];
    await runCarrier();
    context.clock.advance(2 * DAY);
    await runCarrier();
    expect(first.trackCalls).toEqual([]);
  });
});

describe("adding a code no carrier recognises", () => {
  let app: App;
  let headers: Record<string, string>;

  beforeEach(async () => {
    app = await context.app();
    const session = await signIn(context, app);
    headers = { cookie: session.cookie, "x-csrf-token": session.csrf };
  });

  const add = () =>
    app.inject({
      method: "POST",
      url: "/api/v1/parcels",
      headers,
      payload: { tracking_number: "QQ-NOT-A-KNOWN-CODE" },
    });

  it("is refused without a fallback service and filed under it with one", async () => {
    expect((await add()).statusCode).toBe(400);
    await addFallback("lookup_one");
    const response = await add();
    expect(response.statusCode).toBe(201);
    expect(response.json<{ carrier: string }>().carrier).toBe("lookup_one");
  });
});
