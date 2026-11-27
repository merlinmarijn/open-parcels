import { describe, expect, it } from "vitest";
import { postnl } from "../../src/carriers/postnl/index.js";
import { InvalidConnectionConfigError } from "../../src/engine/registry.js";
import {
  SignInRejectedError,
  TransientError,
  UnexpectedResponseError,
} from "../../src/provider/errors.js";
import { json, onPrefix, World } from "./harness.js";
import { pasted } from "./pasted.js";

// Made-up codes and values only.
const CODE = "3STEST000000001";
const DONE = "3STEST000000002";
const TOKEN = "POST login.postnl.nl/101112a0-4a0f-4bbb-8176-2f1b2d370d7c/login/token";
const GRAPHQL = "POST jouw.postnl.nl/account/api/graphql";
const TNT = "GET jouw.postnl.nl/track-and-trace/api/trackAndTrace/";
const secret = { refreshToken: "rt-0" };
const tokens = (n: number) =>
  json({ access_token: `at-${n}`, refresh_token: `rt-${n}`, expires_in: 600 });

const shipment = (barcode: string, extra: Record<string, unknown> = {}) => ({
  key: `key-${barcode}`,
  barcode,
  title: "Testwinkel",
  delivered: false,
  receiverTitle: "T. Persoon",
  detailsUrl: `https://jouw.postnl.nl/track-and-trace/${barcode}`,
  ...extra,
});

const list = (receiver: unknown[], sender: unknown[] = []) =>
  json({ data: { trackedShipments: { receiverShipments: receiver, senderShipments: sender } } });

const observation = (code: string, at: string) => ({
  observationCode: code,
  observationDate: at,
  description: `Stap ${code}`,
});

const tnt = (barcode: string, codes: [string, string][]) =>
  json({
    colli: {
      [barcode]: {
        statusPhase: { message: "Je pakket wordt vandaag bezorgd" },
        routeInformation: {
          plannedDeliveryTimeWindow: {
            startDateTime: "2026-11-18T13:00:00+01:00",
            endDateTime: "2026-11-18T15:00:00+01:00",
          },
          expectedDeliveryTime: "2026-11-18T13:40:00+01:00",
        },
        details: { dimensions: { weight: 1500 } },
        analyticsInfo: { allObservations: codes.map(([code, at]) => observation(code, at)) },
      },
    },
  });

describe("PostNL sign-in", () => {
  it("builds a PKCE login address and trades the pasted code for a refresh token", async () => {
    const world = new World(postnl, [onPrefix(TOKEN, tokens(1))]);
    const { url, state } = await pasted(world.provider).start({}, world.clock);
    const login = new URL(url);
    expect(login.searchParams.get("code_challenge_method")).toBe("S256");
    const sent = login.searchParams.get("state") ?? "";
    const secretOut = await pasted(world.provider).finish(
      world.base().http,
      world.clock,
      state,
      `https://www.postnl.nl/?code=c-1&state=${sent}`,
    );
    expect(secretOut).toEqual({ refreshToken: "rt-1" });
    expect(world.calls[0]?.body).toContain("code_verifier=");
    await expect(
      pasted(world.provider).finish(
        world.base().http,
        world.clock,
        state,
        "https://www.postnl.nl/?code=c-1&state=other",
      ),
    ).rejects.toBeInstanceOf(SignInRejectedError);
  });
});

describe("PostNL account", () => {
  it("lists the shipments and reads each live one's track & trace", async () => {
    const world = new World(postnl, [
      onPrefix(TOKEN, tokens(1)),
      onPrefix(
        GRAPHQL,
        list([
          shipment(CODE),
          shipment(DONE, { delivered: true, deliveredTimeStamp: "2026-11-17T10:00:00Z" }),
        ]),
      ),
      onPrefix(
        TNT,
        tnt(CODE, [
          ["A03", "2026-11-16T09:00:00Z"],
          ["J01", "2026-11-17T09:00:00Z"],
          ["A19", "2026-11-18T07:00:00Z"],
          ["J05", "2026-11-18T08:00:00Z"],
        ]),
      ),
    ]);
    const result = await world.fetchAccount({}, secret);
    const [live, done] = result.snapshots;
    expect(live).toMatchObject({
      carrier: "postnl",
      trackingNumber: CODE,
      status: "out_for_delivery",
      expectedFrom: "2026-11-18T12:40:00.000Z",
      expectedTo: "2026-11-18T14:00:00.000Z",
      weightKg: 1.5,
      sender: "Testwinkel",
      receiver: "T. Persoon",
    });
    // The ETA notice inherits the stage before it.
    expect(live?.history.map((e) => e.status)).toEqual([
      "out_for_delivery",
      "in_transit",
      "in_transit",
      "registered",
    ]);
    expect(done).toMatchObject({
      status: "delivered",
      delivered: true,
      deliveredAt: "2026-11-17T10:00:00.000Z",
    });
    expect(world.requests().filter((p) => p.startsWith("GET"))).toHaveLength(1);
    expect(world.stored).toMatchObject({ refreshToken: "rt-1", accessToken: "at-1" });
  });

  it("reports an unknown observation code", async () => {
    const world = new World(postnl, [
      onPrefix(TOKEN, tokens(1)),
      onPrefix(GRAPHQL, list([shipment(CODE)])),
      onPrefix(
        TNT,
        tnt(CODE, [
          ["J01", "2026-11-17T09:00:00Z"],
          ["Q99", "2026-11-18T08:00:00Z"],
        ]),
      ),
    ]);
    const [parcel] = (await world.fetchAccount({}, secret)).snapshots;
    expect(parcel?.status).toBe("in_transit");
    expect(world.unknown).toEqual(["observation_code:Q99"]);
  });

  it("treats a refused refresh token as a sign-in problem", async () => {
    const world = new World(postnl, [onPrefix(TOKEN, json({ error: "invalid_grant" }, 400))]);
    await expect(world.fetchAccount({}, secret)).rejects.toBeInstanceOf(SignInRejectedError);
  });

  it("stops on an answer without its shipment lists instead of reading an empty account (OP-083)", async () => {
    const world = new World(postnl, [
      onPrefix(TOKEN, tokens(1)),
      onPrefix(GRAPHQL, json({ data: { trackedShipments: { error: "renamed" } } })),
    ]);
    await expect(world.fetchAccount({}, secret)).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  it("never refreshes again after a network error", async () => {
    const world = new World(postnl, [
      onPrefix(TOKEN, tokens(1)),
      onPrefix(GRAPHQL, new TypeError("offline")),
    ]);
    await expect(world.fetchAccount({}, secret)).rejects.toBeInstanceOf(TransientError);
    expect(world.requests().filter((p) => p === TOKEN)).toHaveLength(1);
  });
});

describe("PostNL public tracking", () => {
  const config = { postalCode: "1234 ab" };

  it("tracks without sign-in using the delivery postcode and default country", async () => {
    const world = new World(postnl, [
      onPrefix(
        TNT,
        tnt(CODE, [
          ["J01", "2026-11-18T07:00:00Z"],
          ["J05", "2026-11-18T08:00:00Z"],
        ]),
      ),
    ]);
    const result = await world.track([CODE], config);
    expect(result.complete).toBe(true);
    expect(result.snapshots[0]).toMatchObject({
      trackingNumber: CODE,
      status: "out_for_delivery",
      weightKg: 1.5,
      expectedFrom: "2026-11-18T12:40:00.000Z",
      url: `https://jouw.postnl.nl/track-and-trace/${CODE}-NL-1234AB?language=nl`,
    });
    expect(result.snapshots[0]?.history).toHaveLength(2);
    expect(world.calls).toHaveLength(1);
    expect(world.calls[0]?.url.pathname).toBe(
      `/track-and-trace/api/trackAndTrace/${CODE}-NL-1234AB`,
    );
    expect(world.calls[0]?.url.searchParams.get("language")).toBe("nl");
    expect(world.calls[0]?.headers.has("authorization")).toBe(false);
    expect(world.provider.signInFlows("tracking", config).map((flow) => flow.type)).toEqual([
      "none",
    ]);
  });

  it("maps delivered public parcels, sender, recipient and ETA", async () => {
    const world = new World(postnl, [
      onPrefix(
        TNT,
        json({
          colli: {
            [CODE]: {
              isDelivered: true,
              deliveryDate: "2026-11-18T12:00:00Z",
              eta: { start: "2026-11-18T10:00:00Z", end: "2026-11-18T14:00:00Z" },
              sender: { names: { companyName: "Testwinkel" } },
              recipient: { names: { personName: "T. Persoon" } },
            },
          },
        }),
      ),
    ]);
    const [parcel] = (await world.track([CODE], { country: "BE", postalCode: "1000" })).snapshots;
    expect(parcel).toMatchObject({
      delivered: true,
      status: "delivered",
      deliveredAt: "2026-11-18T12:00:00.000Z",
      expectedFrom: null,
      expectedTo: null,
      sender: "Testwinkel",
      receiver: "T. Persoon",
    });
    expect(world.calls[0]?.url.pathname).toContain(`${CODE}-BE-1000`);
  });

  it("requires a postcode and skips invalid tracking numbers", async () => {
    const world = new World(postnl);
    await expect(world.track([CODE])).rejects.toBeInstanceOf(InvalidConnectionConfigError);
    expect((await world.track(["invalid/path"], config)).snapshots).toEqual([]);
    expect(world.calls).toHaveLength(0);
  });

  it.each([json({}, 404), json({ colli: {} })])(
    "returns no parcel when not found",
    async (reply) => {
      const world = new World(postnl, [onPrefix(TNT, reply)]);
      expect((await world.track([CODE], config)).snapshots).toEqual([]);
    },
  );

  it.each([json({}, 503), json({ error: "changed response" })])(
    "fails on server errors and malformed responses",
    async (reply) => {
      const world = new World(postnl, [onPrefix(TNT, reply)]);
      await expect(world.track([CODE], config)).rejects.toBeInstanceOf(TransientError);
    },
  );
});
