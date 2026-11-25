import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { App } from "../../src/api/app.js";
import { ACCESS_TTL_MS, REFRESH_TTL_MS } from "../../src/auth/logins.js";
import {
  createTestContext,
  OWNER_PASSWORD,
  READER_PASSWORD,
  signIn,
  WRONG_PASSWORD,
  type TestContext,
  type TestOptions,
} from "../helpers.js";

const NEW_PASSWORD = ["another", "made", "up", "admin", "secret"].join(" ");
const UI_ORIGIN = "https://parcels-ui.example";
const PARCEL = { carrier: "dhl", tracking_number: "00340434000000000002" };

interface Issued {
  access_token: string;
  refresh_token: string;
  login: { id: string; role: string; name: string };
}

let context: TestContext | undefined;
afterEach(async () => {
  await context?.close();
  context = undefined;
});

async function start(options: TestOptions = {}): Promise<{ ctx: TestContext; app: App }> {
  const ctx = await createTestContext(options);
  context = ctx;
  const app = await ctx.app();
  await signIn(ctx, app);
  return { ctx, app };
}

async function logIn(app: App, password: string, role?: string): Promise<Issued> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/logins",
    payload: { password, name: "Made-up phone", ...(role === undefined ? {} : { role }) },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<Issued>();
}

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

async function addParcel(app: App, token: string): Promise<number> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/parcels",
    headers: bearer(token),
    payload: PARCEL,
  });
  return response.statusCode;
}

async function refresh(app: App, refreshToken: string): Promise<{ status: number; body: Issued }> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/logins/refresh",
    payload: { refresh_token: refreshToken },
  });
  return { status: response.statusCode, body: response.json<Issued>() };
}

describe("token logins", () => {
  it("log in with the admin password, change things without a cookie or CSRF token", async () => {
    const { app } = await start();
    const issued = await logIn(app, OWNER_PASSWORD);
    expect(issued.login.role).toBe("admin");
    expect(issued.access_token).toMatch(/^opa_/);
    expect(issued.refresh_token).toMatch(/^opr_/);
    expect(await addParcel(app, issued.access_token)).toBe(201);
    const state = await app.inject({
      url: "/api/v1/session",
      headers: bearer(issued.access_token),
    });
    expect(state.json()).toMatchObject({ method: "login", role: "admin", authenticated: true });
  });

  it("give a reader login for the reader password, or when asked with the admin password", async () => {
    const { app } = await start({ env: { OPENPARCELS_PASSWORD: READER_PASSWORD } });
    for (const issued of [
      await logIn(app, READER_PASSWORD),
      await logIn(app, OWNER_PASSWORD, "reader"),
    ]) {
      expect(issued.login.role).toBe("reader");
      expect(await addParcel(app, issued.access_token)).toBe(403);
      const read = await app.inject({
        url: "/api/v1/parcels",
        headers: bearer(issued.access_token),
      });
      expect(read.statusCode).toBe(200);
    }
    // A reader password never becomes more by asking.
    expect((await logIn(app, READER_PASSWORD, "admin")).login.role).toBe("reader");
  });

  it("refuse a wrong password and count it for the login throttle", async () => {
    const { app } = await start();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/logins",
        payload: { password: WRONG_PASSWORD, name: "Guesser" },
      });
      statuses.push(response.statusCode);
    }
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses[5]).toBe(429);
  });

  it("expire access tokens after 15 minutes; refreshing rotates both tokens", async () => {
    const { ctx, app } = await start();
    const first = await logIn(app, OWNER_PASSWORD);
    ctx.clock.advance(ACCESS_TTL_MS + 1000);
    const expired = await app.inject({
      url: "/api/v1/parcels",
      headers: bearer(first.access_token),
    });
    expect(expired.statusCode).toBe(401);

    const second = await refresh(app, first.refresh_token);
    expect(second.status).toBe(200);
    expect(second.body.access_token).not.toBe(first.access_token);
    expect(second.body.refresh_token).not.toBe(first.refresh_token);
    expect(second.body.login.id).toBe(first.login.id);
    expect(await addParcel(app, second.body.access_token)).toBe(201);
  });

  it("end the login when a replaced refresh token comes back (a copy is in other hands)", async () => {
    const { app } = await start();
    const first = await logIn(app, OWNER_PASSWORD);
    const second = await refresh(app, first.refresh_token);
    expect(second.status).toBe(200);
    const replay = await refresh(app, first.refresh_token);
    expect(replay.status).toBe(401);
    expect(replay.body).toMatchObject({ error: "login_ended" });
    // The legitimate holder is logged out too: both of its tokens stopped working.
    expect((await refresh(app, second.body.refresh_token)).status).toBe(401);
    const read = await app.inject({
      url: "/api/v1/parcels",
      headers: bearer(second.body.access_token),
    });
    expect(read.statusCode).toBe(401);
  });

  it("end after 30 days without a refresh", async () => {
    const { ctx, app } = await start();
    const issued = await logIn(app, OWNER_PASSWORD);
    ctx.clock.advance(REFRESH_TTL_MS + 1000);
    expect((await refresh(app, issued.refresh_token)).status).toBe(401);
    expect(await ctx.services.logins.pruneExpired()).toBe(1);
  });

  it("log out with the refresh token", async () => {
    const { app } = await start();
    const issued = await logIn(app, OWNER_PASSWORD);
    const out = await app.inject({
      method: "POST",
      url: "/api/v1/logins/logout",
      payload: { refresh_token: issued.refresh_token },
    });
    expect(out.statusCode).toBe(204);
    expect(await addParcel(app, issued.access_token)).toBe(401);
    expect((await refresh(app, issued.refresh_token)).status).toBe(401);
  });

  it("are listed on the tokens page and revoked there by the admin only", async () => {
    const { app } = await start({ env: { OPENPARCELS_PASSWORD: READER_PASSWORD } });
    const admin = await logIn(app, OWNER_PASSWORD);
    const reader = await logIn(app, READER_PASSWORD);
    const asReader = await app.inject({
      url: "/api/v1/logins",
      headers: bearer(reader.access_token),
    });
    expect(asReader.statusCode).toBe(403);
    const list = await app.inject({ url: "/api/v1/logins", headers: bearer(admin.access_token) });
    expect(list.statusCode).toBe(200);
    const body = list.json<{ id: string; role: string }[]>();
    expect(body.map((entry) => entry.role).sort()).toEqual(["admin", "reader"]);
    expect(list.body).not.toContain(reader.access_token);
    expect(list.body).not.toContain("refresh");

    const revoke = await app.inject({
      method: "DELETE",
      url: `/api/v1/logins/${reader.login.id}`,
      headers: bearer(admin.access_token),
    });
    expect(revoke.statusCode).toBe(204);
    const gone = await app.inject({ url: "/api/v1/parcels", headers: bearer(reader.access_token) });
    expect(gone.statusCode).toBe(401);
  });

  it("all end when the admin password changes; reader logins when the reader password changes", async () => {
    const { ctx, app } = await start({ env: { OPENPARCELS_PASSWORD: READER_PASSWORD } });
    const admin = await logIn(app, OWNER_PASSWORD);
    const reader = await logIn(app, READER_PASSWORD);
    await ctx.services.access.readerPasswordChanged();
    expect((await refresh(app, reader.refresh_token)).status).toBe(401);
    const stillAdmin = await logIn(app, OWNER_PASSWORD);
    expect((await ctx.services.access.changeAdminPassword(OWNER_PASSWORD, NEW_PASSWORD)).ok).toBe(
      true,
    );
    expect((await refresh(app, admin.refresh_token)).status).toBe(401);
    expect((await refresh(app, stillAdmin.refresh_token)).status).toBe(401);
  });
});

describe("the live event stream with a token login", () => {
  it("accepts the access token in the address, but never a long-lived API token", async () => {
    const { ctx, app } = await start({ env: { OPENPARCELS_PASSWORD: READER_PASSWORD } });
    const issued = await logIn(app, READER_PASSWORD);
    const { token } = await ctx.services.auth.createToken("Made-up client", ["read"], null);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const base = `http://127.0.0.1:${String((app.server.address() as AddressInfo).port)}`;

    const controller = new AbortController();
    const stream = await fetch(`${base}/api/v1/events?access_token=${issued.access_token}`, {
      signal: controller.signal,
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    controller.abort();

    const byApiToken = await fetch(`${base}/api/v1/events?access_token=${token}`);
    expect(byApiToken.status).toBe(401);
    const elsewhere = await app.inject({
      url: `/api/v1/parcels?access_token=${issued.access_token}`,
    });
    expect(elsewhere.statusCode).toBe(401);
  });

  it("ends when the login is revoked", async () => {
    const { ctx, app } = await start();
    const issued = await logIn(app, OWNER_PASSWORD);
    const { credentialCheck } = await import("../../src/api/auth-plugin.js");
    const allowed = credentialCheck(
      {
        auth: { kind: "login", loginId: issued.login.id, role: "admin", scopes: ["read"] },
        headers: {},
        cookies: {},
        url: "/api/v1/events",
      },
      { store: ctx.services.auth, logins: ctx.services.logins, access: ctx.services.access },
    );
    // The stream outlives its 15-minute access token while the login lives.
    ctx.clock.advance(ACCESS_TTL_MS + 1000);
    expect(await allowed()).toBe(true);
    await ctx.services.logins.delete(issued.login.id);
    expect(await allowed()).toBe(false);
  });
});

describe("CORS", () => {
  const preflight = (app: App, origin: string) =>
    app.inject({
      method: "OPTIONS",
      url: "/api/v1/parcels",
      headers: {
        origin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization, content-type",
      },
    });

  it("answers only the listed origins, without credentials", async () => {
    const { app } = await start({
      env: { OPENPARCELS_CORS_ORIGINS: `${UI_ORIGIN}, http://localhost:5173` },
    });
    const allowed = await preflight(app, UI_ORIGIN);
    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers["access-control-allow-origin"]).toBe(UI_ORIGIN);
    expect(allowed.headers["access-control-allow-headers"]).toContain("authorization");
    expect(allowed.headers["access-control-allow-credentials"]).toBeUndefined();

    const other = await preflight(app, "https://evil.example");
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();

    const issued = await logIn(app, OWNER_PASSWORD);
    const list = await app.inject({
      url: "/api/v1/parcels",
      headers: { origin: UI_ORIGIN, ...bearer(issued.access_token) },
    });
    expect(list.statusCode).toBe(200);
    expect(list.headers["access-control-allow-origin"]).toBe(UI_ORIGIN);
    expect(list.headers["access-control-expose-headers"]).toContain("x-next-offset");
    expect(list.headers.vary).toContain("Origin");
  });

  it("sends no CORS headers when no origin is listed", async () => {
    const { app } = await start();
    const response = await preflight(app, UI_ORIGIN);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("applies a change in the settings at once and refuses a wildcard", async () => {
    const { ctx, app } = await start();
    for (const refused of ["*", `${UI_ORIGIN}/path`, "parcels-ui.example"]) {
      const result = await ctx.services.configSettings.patch({ OPENPARCELS_CORS_ORIGINS: refused });
      expect(result.ok, refused).toBe(false);
    }
    const saved = await ctx.services.configSettings.patch({ OPENPARCELS_CORS_ORIGINS: UI_ORIGIN });
    expect(saved.ok).toBe(true);
    expect((await preflight(app, UI_ORIGIN)).headers["access-control-allow-origin"]).toBe(
      UI_ORIGIN,
    );
  });
});
