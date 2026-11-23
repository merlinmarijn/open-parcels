import { z } from "zod";
import { backupDatabase, CACHE_NAMES, clearCache, dataSummary } from "../../data/manage.js";
import type { Services } from "../../services.js";
import type { TypedApp } from "../app.js";
import { requireScope } from "../auth-plugin.js";
import { ApiError, errorBodySchema } from "../errors.js";

/** The text the owner types to confirm deleting everything. */
export const EVERYTHING_CONFIRMATION = "DELETE";

const summarySchema = z.object({
  parcels: z.number().int(),
  archived_parcels: z.number().int(),
  orders: z.number().int(),
  scans: z.number().int().describe("Tracking scans (parcel history rows)."),
  raw_payloads: z.number().int().describe("Raw carrier answers kept for diagnosing plug-ins."),
  events: z.number().int().describe("Rows in the replay log for live clients."),
  database_bytes: z.number().int(),
  cache_bytes: z.object({
    images: z.number().int(),
    tiles: z.number().int(),
    collages: z.number().int(),
  }),
});

const clearBody = z.discriminatedUnion("what", [
  z.object({ what: z.literal("archived") }),
  z.object({ what: z.literal("older_than"), before: z.iso.date() }),
  z.object({ what: z.literal("raw_payloads") }),
  z.object({ what: z.literal("archived_scans") }),
  z.object({ what: z.literal("cache"), cache: z.enum(CACHE_NAMES) }),
  z.object({ what: z.literal("everything"), confirm: z.string() }),
]);

const clearedSchema = z.object({
  parcels: z.number().int(),
  orders: z.number().int(),
  rows: z.number().int().describe("Other rows removed (scans, raw payloads)."),
  bytes: z.number().int().describe("Bytes freed from a cache."),
  backup: z.string().nullable().describe("Database backup written before deleting everything."),
});

/** The Data page: what is stored, and the owner's clean-up actions. */
export function registerDataRoutes(app: TypedApp, services: Services): void {
  const admin = requireScope("admin");
  const { config } = services;

  app.get(
    "/api/v1/data",
    {
      preHandler: admin,
      schema: {
        tags: ["data"],
        summary: "Counts and sizes of what is stored.",
        response: { 200: summarySchema },
      },
    },
    () => dataSummary(services.db, config.dataDir, config.databasePath),
  );

  app.post(
    "/api/v1/data/clear",
    {
      preHandler: admin,
      schema: {
        tags: ["data"],
        summary: "Delete stored data on the owner's request.",
        description:
          "`archived`: archived parcels. `older_than`: delivered or archived parcels last seen " +
          "before the date, then orders placed before it with no parcel left. `raw_payloads`, " +
          "`archived_scans`: diagnostic rows. `cache`: an image, tile or collage cache (fetched " +
          `again when needed). \`everything\`: all parcels and orders after a database backup; ` +
          `needs \`confirm: "${EVERYTHING_CONFIRMATION}"\`. Sources, sign-ins and settings stay.`,
        body: clearBody,
        response: { 200: clearedSchema, 400: errorBodySchema },
      },
    },
    async (request) => {
      const body = request.body;
      const cleaner = services.parcels.cleaner();
      const none = { parcels: 0, orders: 0, rows: 0, bytes: 0, backup: null };
      switch (body.what) {
        case "archived":
          return { ...none, ...(await cleaner.archived()) };
        case "older_than":
          return { ...none, ...(await cleaner.olderThan(new Date(`${body.before}T00:00:00Z`))) };
        case "raw_payloads":
          return { ...none, ...(await cleaner.rawPayloads()) };
        case "archived_scans":
          return { ...none, ...(await cleaner.archivedScans()) };
        case "cache":
          return { ...none, bytes: await clearCache(config.dataDir, body.cache) };
        case "everything": {
          if (body.confirm !== EVERYTHING_CONFIRMATION) {
            throw new ApiError(
              400,
              "confirmation_required",
              `Type ${EVERYTHING_CONFIRMATION} to confirm deleting every parcel and order.`,
            );
          }
          const backup = await backupDatabase(services.db, config.dataDir, services.clock);
          return { ...none, ...(await cleaner.everything()), backup };
        }
      }
    },
  );
}
