import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { App } from "../../src/api/app.js";
import { demoCarrier } from "../../src/carriers/demo/index.js";
import { demoShop } from "../../src/carriers/demo_shop/index.js";
import { registerBuiltin } from "../manifests.js";
import { createTestContext, signIn, type TestContext } from "../helpers.js";

let context: TestContext;
let app: App;
let headers: Record<string, string>;

beforeEach(async () => {
  context = await createTestContext({
    providers: [registerBuiltin(demoCarrier), registerBuiltin(demoShop)],
  });
  app = await context.app();
  const session = await signIn(context, app);
  headers = { cookie: session.cookie, "x-csrf-token": session.csrf };
  const connection = await context.services.connections.create({
    provider: "demo_shop",
    kind: "shop",
    label: "Demo shop",
    config: {},
    secret: null,
  });
  await context.services.runner.run(connection.id);
});
afterEach(async () => {
  await context.close();
});

interface Summary {
  parcels: number;
  archived_parcels: number;
  orders: number;
}
interface Cleared {
  parcels: number;
  orders: number;
  rows: number;
  bytes: number;
  backup: string | null;
}

async function summary(): Promise<Summary> {
  const response = await app.inject({ url: "/api/v1/data", headers });
  expect(response.statusCode).toBe(200);
  return response.json<Summary>();
}

async function clear(payload: Record<string, unknown>): Promise<{ status: number; body: Cleared }> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/data/clear",
    headers,
    payload,
  });
  return { status: response.statusCode, body: response.json<Cleared>() };
}

describe("data page", () => {
  it("summarises what is stored", async () => {
    const data = await summary();
    expect(data.parcels).toBeGreaterThan(0);
    expect(data.orders).toBeGreaterThan(0);
    expect(data.archived_parcels).toBe(0);
  });

  it("deletes archived parcels only", async () => {
    const before = await summary();
    const one = await context.services.db
      .selectFrom("parcels")
      .select("id")
      .executeTakeFirstOrThrow();
    await app.inject({
      method: "PATCH",
      url: `/api/v1/parcels/${one.id}`,
      headers,
      payload: { archived: true },
    });
    const { status, body } = await clear({ what: "archived" });
    expect(status).toBe(200);
    expect(body.parcels).toBe(1);
    expect((await summary()).parcels).toBe(before.parcels - 1);
  });

  it("keeps parcels still on their way when deleting older data", async () => {
    const before = await summary();
    const { body } = await clear({ what: "older_than", before: "2999-01-01" });
    const after = await summary();
    const active = await context.services.db
      .selectFrom("parcels")
      .select("id")
      .where("delivered", "=", 0)
      .where("archived_at", "is", null)
      .execute();
    expect(after.parcels).toBe(active.length);
    expect(body.parcels).toBe(before.parcels - active.length);
  });

  it("deletes everything only when confirmed, after a backup", async () => {
    const refused = await clear({ what: "everything", confirm: "yes" });
    expect(refused.status).toBe(400);
    expect((await summary()).parcels).toBeGreaterThan(0);

    const done = await clear({ what: "everything", confirm: "DELETE" });
    expect(done.status).toBe(200);
    expect(done.body.backup).not.toBeNull();
    expect(existsSync(done.body.backup ?? "")).toBe(true);
    const after = await summary();
    expect(after.parcels).toBe(0);
    expect(after.orders).toBe(0);
    expect(await context.services.db.selectFrom("connections").select("id").execute()).toHaveLength(
      1,
    );
  });

  it("needs the admin", async () => {
    // Without a reader password an anonymous visitor reads, but is not the admin.
    const response = await app.inject({ url: "/api/v1/data" });
    expect(response.statusCode).toBe(403);
    expect((await app.inject({ url: "/api/v1/data/backups" })).statusCode).toBe(403);
  });
});

describe("backups", () => {
  interface Status {
    interval_hours: number;
    keep: number;
    directory: string;
    last: { ok: boolean; file: string | null } | null;
    failing: boolean;
    files: { name: string }[];
  }

  async function status(): Promise<Status> {
    const response = await app.inject({ url: "/api/v1/data/backups", headers });
    expect(response.statusCode).toBe(200);
    return response.json<Status>();
  }

  it("shows the schedule and backs up on demand", async () => {
    expect(await status()).toMatchObject({
      interval_hours: 24,
      keep: 7,
      directory: path.join(context.dataDir, "backups"),
      last: null,
      failing: false,
      files: [],
    });
    const response = await app.inject({ method: "POST", url: "/api/v1/data/backups", headers });
    expect(response.statusCode).toBe(200);
    const result = response.json<{ ok: boolean; reason: string; file: string }>();
    expect(result).toMatchObject({ ok: true, reason: "manual" });
    const after = await status();
    expect(after.last).toMatchObject({ ok: true, file: result.file });
    expect(after.files.map((file) => file.name)).toEqual([result.file]);
  });

  it("deletes nothing when the backup before deleting everything fails", async () => {
    const blocker = path.join(context.dataDir, "blocker");
    writeFileSync(blocker, "");
    expect(
      await context.services.configSettings.patch({ OPENPARCELS_BACKUP_DIR: blocker }),
    ).toMatchObject({ ok: true });
    const before = await summary();
    const done = await clear({ what: "everything", confirm: "DELETE" });
    expect(done.status).toBe(500);
    expect((await summary()).parcels).toBe(before.parcels);
    const manual = await app.inject({ method: "POST", url: "/api/v1/data/backups", headers });
    expect(manual.statusCode).toBe(500);
    expect(manual.json<{ error: string }>().error).toBe("backup_failed");
    expect(manual.json<{ params: unknown }>().params).toEqual({ error: "not_a_folder" });
    expect((await status()).failing).toBe(true);
  });
});
