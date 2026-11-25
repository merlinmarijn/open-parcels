import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "kysely";
import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { HA_INGRESS_ADDRESS, registerAuth } from "../../src/api/auth-plugin.js";
import type { App } from "../../src/api/app.js";
import { hashPassword, sha256Hex } from "../../src/auth/crypto.js";
import { openDatabase } from "../../src/db/database.js";
import {
  createTestContext,
  OWNER_PASSWORD,
  READER_PASSWORD,
  SHORT_PASSWORD,
  signIn,
  WRONG_PASSWORD,
  type TestContext,
  type TestOptions,
  migrateBefore,
} from "../helpers.js";

const NEW_PASSWORD = ["a", "brand", "new", "admin", "secret"].join(" ");
const ENV_ADMIN = ["admin", "from", "the", "environment"].join(" ");
const TRACKING_NUMBER = { carrier: "dhl", tracking_number: "00340434000000000001" };

let context: TestContext | undefined;
afterEach(async () => {
  await context?.close();
  context = undefined;
});

async function start(options: TestOptions = {}): Promise<{ ctx: TestContext; app: App }> {
  const ctx = await createTestContext(options);
  context = ctx;
  return { ctx, app: await ctx.app() };
}

interface Session {
  readonly cookie: string;
  readonly csrf: string;
  readonly role: string;
}

async function signInWith(app: App, password: string): Promise<Session> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/session",
    payload: { password },
  });
  expect(response.statusCode).toBe(200);
  const cookie = response.cookies.find((entry) => entry.name === "op_session");
  const body = response.json<{ csrf_token: string; role: string }>();
  return { cookie: `op_session=${cookie?.value ?? ""}`, csrf: body.csrf_token, role: body.role };
}

const headersOf = (session: Session): Record<string, string> => ({
  cookie: session.cookie,
  "x-csrf-token": session.csrf,
});

async function sessionState(app: App, headers: Record<string, string> = {}): Promise<unknown> {
  return (await app.inject({ url: "/api/v1/session", headers })).json();
}

async function makeToken(app: App, admin: Session, scopes: string[]): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/tokens",
    headers: headersOf(admin),
    payload: { name: scopes.join("+"), scopes },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ token: string }>().token;
}

/** Every documented operation: method and a concrete URL with dummy path parameters. */
async function operations(
  app: App,
  headers: Record<string, string>,
): Promise<{ method: string; url: string; isPublic: boolean }[]> {
  const doc = (await app.inject({ url: "/api/v1/openapi.json", headers })).json<{
    paths: Record<string, Record<string, { security?: unknown[] }>>;
  }>();
  return Object.entries(doc.paths).flatMap(([pathName, methods]) =>
    Object.entries(methods).map(([method, operation]) => ({
      method: method.toUpperCase(),
      url: pathName.replaceAll(/\{[^}]+\}/g, "00000000-0000-4000-8000-000000000000"),
      isPublic: Array.isArray(operation.security) && operation.security.length === 0,
    })),
  );
}

describe("reading without OPENPARCELS_PASSWORD", () => {
  it("is open to anyone, as a reader who may not change anything", async () => {
    const { app } = await start();
    expect((await app.inject("/api/v1/parcels")).statusCode).toBe(200);
    expect((await app.inject("/tiles/osm/1/0/0")).statusCode).not.toBe(401);
    expect(await sessionState(app)).toMatchObject({
      authenticated: false,
      method: "anonymous",
      role: "reader",
      reader_required: false,
    });
    const write = await app.inject({
      method: "POST",
      url: "/api/v1/parcels",
      payload: TRACKING_NUMBER,
    });
    expect(write.statusCode).toBe(401);
    // Admin-only reads stay closed.
    expect((await app.inject("/api/v1/tokens")).statusCode).toBe(403);
  });
});

describe("reading with OPENPARCELS_PASSWORD", () => {
  it("needs a sign-in with the reader or the admin password", async () => {
    const { ctx, app } = await start({ env: { OPENPARCELS_PASSWORD: READER_PASSWORD } });
    await signIn(ctx, app);
    for (const url of [
      "/api/v1/parcels",
      "/api/v1/events",
      "/tiles/osm/1/0/0",
      "/api/v1/calendar",
    ]) {
      expect((await app.inject(url)).statusCode, url).toBe(401);
    }
    expect(await sessionState(app)).toMatchObject({ role: null, reader_required: true });

    const reader = await signInWith(app, READER_PASSWORD);
    expect(reader.role).toBe("reader");
    expect(
      (await app.inject({ url: "/api/v1/parcels", headers: headersOf(reader) })).statusCode,
    ).toBe(200);
    const write = await app.inject({
      method: "POST",
      url: "/api/v1/parcels",
      headers: headersOf(reader),
      payload: TRACKING_NUMBER,
    });
    expect(write.statusCode).toBe(403);
    expect(write.json()).toMatchObject({ error: "admin_required" });

    const admin = await signInWith(app, OWNER_PASSWORD);
    expect(admin.role).toBe("admin");
  });

  it("applies live and signs readers out when it changes", async () => {
    const { ctx, app } = await start({ env: { OPENPARCELS_PASSWORD: READER_PASSWORD } });
    const owner = await signIn(ctx, app);
    const admin = { ...owner, role: "admin" };
    const reader = await signInWith(app, READER_PASSWORD);
    const changed = await app.inject({
      method: "PATCH",
      url: "/api/v1/settings/config",
      headers: headersOf(admin),
      payload: { OPENPARCELS_PASSWORD: "" },
    });
    expect(changed.statusCode).toBe(200);
    // Open now: the old reader session is gone, but reading needs nothing.
    expect(await sessionState(app, headersOf(reader))).toMatchObject({ method: "anonymous" });
    expect(await sessionState(app, headersOf(admin))).toMatchObject({ role: "admin" });
    expect((await app.inject("/api/v1/parcels")).statusCode).toBe(200);
  });

  it("refuses a reader password shorter than the admin minimum (OP-152)", async () => {
    const { ctx, app } = await start({ env: { OPENPARCELS_PASSWORD: READER_PASSWORD } });
    const admin = { ...(await signIn(ctx, app)), role: "admin" };
    const short = await app.inject({
      method: "PATCH",
      url: "/api/v1/settings/config",
      headers: headersOf(admin),
      payload: { OPENPARCELS_PASSWORD: SHORT_PASSWORD },
    });
    expect(short.statusCode).toBe(400);
    expect(await signInWith(app, READER_PASSWORD)).toMatchObject({ role: "reader" });
  });

  it("throttles failed sign-ins", async () => {
    const { ctx, app } = await start({ env: { OPENPARCELS_PASSWORD: READER_PASSWORD } });
    await signIn(ctx, app);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const bad = await app.inject({
        method: "POST",
        url: "/api/v1/session",
        payload: { password: WRONG_PASSWORD },
      });
      expect(bad.statusCode).toBe(401);
    }
    const blocked = await app.inject({
      method: "POST",
      url: "/api/v1/session",
      payload: { password: READER_PASSWORD },
    });
    expect(blocked.statusCode).toBe(429);
  });

  it("throttles each client behind a trusted proxy apart, and everyone together otherwise", async () => {
    const attempt = (app: App, client: string, password: string) =>
      app.inject({
        method: "POST",
        url: "/api/v1/session",
        headers: { "x-forwarded-for": client },
        payload: { password },
      });
    const failFiveTimes = async (app: App): Promise<void> => {
      for (let count = 0; count < 5; count += 1) {
        expect((await attempt(app, "203.0.113.1", WRONG_PASSWORD)).statusCode).toBe(401);
      }
    };

    const trusted = await start({
      env: { OPENPARCELS_PASSWORD: READER_PASSWORD, OPENPARCELS_TRUST_PROXY: "127.0.0.1" },
    });
    await signIn(trusted.ctx, trusted.app);
    await failFiveTimes(trusted.app);
    expect((await attempt(trusted.app, "203.0.113.1", READER_PASSWORD)).statusCode).toBe(429);
    expect((await attempt(trusted.app, "203.0.113.2", READER_PASSWORD)).statusCode).toBe(200);
    await trusted.ctx.close();

    // Without trust the forwarded address is the client's own claim: it must not escape the throttle.
    const untrusted = await start({ env: { OPENPARCELS_PASSWORD: READER_PASSWORD } });
    await signIn(untrusted.ctx, untrusted.app);
    await failFiveTimes(untrusted.app);
    expect((await attempt(untrusted.app, "203.0.113.2", READER_PASSWORD)).statusCode).toBe(429);
  });
});

describe("the notice that reading is open", () => {
  it("shows to the admin until dismissed, for every browser, and never to readers", async () => {
    const { ctx, app } = await start();
    const owner = await signIn(ctx, app);
    const admin = { ...owner, role: "admin" };
    expect(await sessionState(app)).toMatchObject({ reader_password_notice: false });
    expect(await sessionState(app, headersOf(admin))).toMatchObject({
      reader_password_notice: true,
    });
    const dismissed = await app.inject({
      method: "POST",
      url: "/api/v1/session/reader-password-notice/dismiss",
      headers: headersOf(admin),
    });
    expect(dismissed.statusCode).toBe(204);
    expect(await sessionState(app, headersOf(admin))).toMatchObject({
      reader_password_notice: false,
    });
    // Kept on the server: another sign-in (another browser) does not see it again.
    const other = await signInWith(app, OWNER_PASSWORD);
    expect(await sessionState(app, headersOf(other))).toMatchObject({
      reader_password_notice: false,
    });
    await ctx.services.settings.load();
    expect(ctx.services.settings.readerNoticeDismissed).toBe(true);
  });

  it("is not shown while a reader password is set", async () => {
    const { ctx, app } = await start({ env: { OPENPARCELS_PASSWORD: READER_PASSWORD } });
    const owner = await signIn(ctx, app);
    expect(await sessionState(app, headersOf({ ...owner, role: "admin" }))).toMatchObject({
      reader_password_notice: false,
    });
  });
});

describe("session cookies (OP-011)", () => {
  it("are Secure when the request came over HTTPS through a trusted proxy", async () => {
    const { ctx, app } = await start({ env: { OPENPARCELS_TRUST_PROXY: "127.0.0.1" } });
    await signIn(ctx, app);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/session",
      headers: { "x-forwarded-proto": "https" },
      payload: { password: OWNER_PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    expect(response.cookies.find((cookie) => cookie.name === "op_session")?.secure).toBe(true);
    const plain = await app.inject({
      method: "POST",
      url: "/api/v1/session",
      payload: { password: OWNER_PASSWORD },
    });
    expect(plain.cookies.find((cookie) => cookie.name === "op_session")?.secure).toBeUndefined();
  });
});

describe("percent-encoded paths (OP-001)", () => {
  it("reach the access rule like the plain path", async () => {
    const { ctx, app } = await start({ env: { OPENPARCELS_PASSWORD: READER_PASSWORD } });
    await signIn(ctx, app);
    expect((await app.inject("/%61pi/v1/parcels")).statusCode).toBe(401);
    const write = await app.inject({
      method: "POST",
      url: "/%61pi/v1/parcels",
      payload: TRACKING_NUMBER,
    });
    expect(write.statusCode).toBe(401);
  });

  it("guard a route that has no guard of its own", async () => {
    const { ctx } = await start({ env: { OPENPARCELS_PASSWORD: READER_PASSWORD } });
    const bare = Fastify();
    await bare.register(cookie);
    registerAuth(bare, {
      store: ctx.services.auth,
      access: ctx.services.access,
      trustedIngressAddress: undefined,
    });
    bare.get("/api/v1/unguarded", () => ({ ok: true }));
    bare.post("/api/v1/unguarded", () => ({ ok: true }));
    await bare.ready();
    try {
      for (const url of ["/api/v1/unguarded", "/%61pi/v1/unguarded", "/api/v1/%75nguarded"]) {
        expect((await bare.inject(url)).statusCode, url).toBe(401);
        expect((await bare.inject({ method: "POST", url })).statusCode, url).toBe(401);
      }
    } finally {
      await bare.close();
    }
  });
});

describe("writes", () => {
  it("need the admin on every route that is not a sign-in", async () => {
    const { ctx, app } = await start({ env: { OPENPARCELS_PASSWORD: READER_PASSWORD } });
    const owner = await signIn(ctx, app);
    const reader = await signInWith(app, READER_PASSWORD);
    const readToken = await makeToken(app, { ...owner, role: "admin" }, ["read"]);
    const writes = (await operations(app, headersOf(reader))).filter((op) => op.method !== "GET");
    expect(writes.length).toBeGreaterThan(20);
    expect(
      writes
        .filter((op) => op.isPublic)
        .map((op) => `${op.method} ${op.url}`)
        .sort(),
    ).toEqual(["DELETE /api/v1/session", "POST /api/v1/session", "POST /api/v1/setup"]);
    for (const op of writes.filter((candidate) => !candidate.isPublic)) {
      const label = `${op.method} ${op.url}`;
      const method = op.method as "POST" | "PUT" | "PATCH" | "DELETE";
      const anonymous = await app.inject({ method, url: op.url, payload: {} });
      expect(anonymous.statusCode, `${label} anonymous`).toBe(401);
      const asReader = await app.inject({
        method,
        url: op.url,
        headers: headersOf(reader),
        payload: {},
      });
      expect(asReader.statusCode, `${label} reader`).toBe(403);
      const byToken = await app.inject({
        method,
        url: op.url,
        headers: { authorization: `Bearer ${readToken}` },
        payload: {},
      });
      expect(byToken.statusCode, `${label} read token`).toBe(403);
    }
  });

  it("keep requiring the CSRF token from cookie sessions", async () => {
    const { ctx, app } = await start();
    const owner = await signIn(ctx, app);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/parcels",
      headers: { cookie: owner.cookie },
      payload: TRACKING_NUMBER,
    });
    expect(response.json()).toMatchObject({ error: "csrf" });
  });
});

describe("API tokens", () => {
  it("map their scopes onto reader and admin", async () => {
    const { ctx, app } = await start({ env: { OPENPARCELS_PASSWORD: READER_PASSWORD } });
    const admin = { ...(await signIn(ctx, app)), role: "admin" };
    const read = await makeToken(app, admin, ["read"]);
    const write = await makeToken(app, admin, ["read", "write"]);
    const full = await makeToken(app, admin, ["read", "write", "admin"]);
    const bearer = (token: string): Record<string, string> => ({
      authorization: `Bearer ${token}`,
    });

    expect(await sessionState(app, bearer(read))).toMatchObject({ role: "reader" });
    expect(await sessionState(app, bearer(write))).toMatchObject({ role: "admin" });
    expect((await app.inject({ url: "/api/v1/parcels", headers: bearer(read) })).statusCode).toBe(
      200,
    );
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/parcels",
      headers: bearer(write),
      payload: TRACKING_NUMBER,
    });
    expect(created.statusCode).toBe(201);
    // A write token (the Home Assistant integration's) still cannot manage tokens.
    expect((await app.inject({ url: "/api/v1/tokens", headers: bearer(write) })).statusCode).toBe(
      403,
    );
    expect((await app.inject({ url: "/api/v1/tokens", headers: bearer(full) })).statusCode).toBe(
      200,
    );
  });
});

describe("Home Assistant ingress", () => {
  it("is the admin, even with a reader password and without CSRF", async () => {
    const { ctx } = await start({ env: { OPENPARCELS_PASSWORD: READER_PASSWORD } });
    const ingress = await ctx.app({ trustedIngressAddress: HA_INGRESS_ADDRESS });
    expect(await sessionState(ingress, {})).toMatchObject({ method: null });
    const state = (
      await ingress.inject({ url: "/api/v1/session", remoteAddress: HA_INGRESS_ADDRESS })
    ).json<unknown>();
    expect(state).toMatchObject({ method: "ingress", role: "admin" });
    const created = await ingress.inject({
      method: "POST",
      url: "/api/v1/parcels",
      remoteAddress: HA_INGRESS_ADDRESS,
      payload: TRACKING_NUMBER,
    });
    expect(created.statusCode).toBe(201);
  });
});

describe("the admin password", () => {
  async function change(app: App, admin: Session, current: string | null, next: string) {
    return app.inject({
      method: "PUT",
      url: "/api/v1/admin-password",
      headers: headersOf(admin),
      payload: { current, next },
    });
  }

  it("changes with the current one, is stored hashed, and signs everyone out", async () => {
    const { ctx, app } = await start({ env: { OPENPARCELS_PASSWORD: READER_PASSWORD } });
    const admin = { ...(await signIn(ctx, app)), role: "admin" };
    const reader = await signInWith(app, READER_PASSWORD);

    expect((await change(app, admin, WRONG_PASSWORD, NEW_PASSWORD)).statusCode).toBe(400);
    expect((await change(app, admin, null, NEW_PASSWORD)).statusCode).toBe(400);
    expect((await change(app, admin, OWNER_PASSWORD, "short")).statusCode).toBe(400);
    expect((await change(app, admin, OWNER_PASSWORD, NEW_PASSWORD)).statusCode).toBe(204);

    for (const session of [admin, reader]) {
      expect(await sessionState(app, headersOf(session))).toMatchObject({ role: null });
    }
    const failed = await app.inject({
      method: "POST",
      url: "/api/v1/session",
      payload: { password: OWNER_PASSWORD },
    });
    expect(failed.statusCode).toBe(401);
    expect((await signInWith(app, NEW_PASSWORD)).role).toBe("admin");

    const stored = await ctx.services.db.selectFrom("owner").select("password_hash").execute();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.password_hash.startsWith("scrypt$")).toBe(true);
    expect(stored[0]?.password_hash).not.toContain(NEW_PASSWORD);
    const overrides = await ctx.services.db.selectFrom("setting_overrides").selectAll().execute();
    expect(JSON.stringify(overrides)).not.toContain(NEW_PASSWORD);
  });

  it("is listed as a secret setting and cannot be saved through the generic editor", async () => {
    const { ctx, app } = await start();
    const admin = { ...(await signIn(ctx, app)), role: "admin" };
    const list = (
      await app.inject({ url: "/api/v1/settings/config", headers: headersOf(admin) })
    ).json<{ key: string }[]>();
    expect(list.find((s) => s.key === "OPENPARCELS_ADMIN_PASSWORD")).toMatchObject({
      secret: true,
      set: true,
      source: "override",
      value: null,
    });
    const patched = await app.inject({
      method: "PATCH",
      url: "/api/v1/settings/config",
      headers: headersOf(admin),
      payload: { OPENPARCELS_ADMIN_PASSWORD: NEW_PASSWORD },
    });
    expect(patched.statusCode).toBe(400);
  });

  it("resets to the environment's, signing everyone out, and needs one to fall back to", async () => {
    const { ctx, app } = await start({ env: { OPENPARCELS_ADMIN_PASSWORD: ENV_ADMIN } });
    expect(ctx.services.access.setupPending).toBe(false);
    const admin = await signInWith(app, ENV_ADMIN);
    expect((await change(app, admin, ENV_ADMIN, NEW_PASSWORD)).statusCode).toBe(204);
    const second = await signInWith(app, NEW_PASSWORD);
    const reset = await app.inject({
      method: "DELETE",
      url: "/api/v1/admin-password",
      headers: headersOf(second),
    });
    expect(reset.statusCode).toBe(204);
    expect(await sessionState(app, headersOf(second))).toMatchObject({ method: "anonymous" });
    expect((await signInWith(app, ENV_ADMIN)).role).toBe("admin");

    const { ctx: bare, app: bareApp } = await start();
    const owner = { ...(await signIn(bare, bareApp)), role: "admin" };
    const refused = await bareApp.inject({
      method: "DELETE",
      url: "/api/v1/admin-password",
      headers: headersOf(owner),
    });
    expect(refused.statusCode).toBe(409);
    await ctx.close();
  });
});

describe("upgrading from the single owner password", () => {
  it("keeps the owner password as the admin password and the open sessions as admin", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "open-parcels-upgrade-"));
    const { db } = openDatabase(path.join(dataDir, "openparcels.db"));
    const cookieValue = "an-old-session-cookie-value";
    try {
      await migrateBefore(db, "0012");
      const hash = await hashPassword(OWNER_PASSWORD);
      await sql`insert into owner (id, password_hash, created_at, updated_at)
        values (1, ${hash}, 't', 't')`.execute(db);
      await sql`insert into sessions (id_hash, csrf_token, created_at, expires_at, last_seen_at, user_agent)
        values (${sha256Hex(cookieValue)}, 'old-csrf', '2026-11-18T00:00:00.000Z',
          '2026-12-18T00:00:00.000Z', '2026-11-18T12:00:00.000Z', null)`.execute(db);
    } finally {
      await db.destroy();
    }

    const { ctx, app } = await start({ dataDir });
    expect(ctx.services.access.setupPending).toBe(false);
    const headers = { cookie: `op_session=${cookieValue}`, "x-csrf-token": "old-csrf" };
    expect(await sessionState(app, headers)).toMatchObject({ method: "session", role: "admin" });
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/parcels",
      headers,
      payload: TRACKING_NUMBER,
    });
    expect(created.statusCode).toBe(201);
    expect((await signInWith(app, OWNER_PASSWORD)).role).toBe("admin");
  });
});
