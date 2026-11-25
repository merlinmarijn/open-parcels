import { z } from "zod";
import { orderSchema } from "../../domain/order-lifecycle.js";
import { historyEntrySchema, parcelSchema } from "../../domain/parcel.js";
import { returnSchema } from "../../domain/return.js";
import { SYNC_ENTITIES } from "../../sync/service.js";
import type { Services } from "../../services.js";
import type { TypedApp } from "../app.js";
import { requireScope } from "../auth-plugin.js";
import { ApiError, errorBodySchema } from "../errors.js";
import { connectionSchema, toBody } from "./connections.js";

const SYNC_PAGE_DEFAULT = 500;
const SYNC_PAGE_MAX = 1000;

const syncEventSchema = historyEntrySchema.extend({
  id: z.string(),
  parcel_id: z.uuid(),
  updated_at: z.string(),
});

const syncPageSchema = z.object({
  cursor: z.string().describe("Pass as `since` on the next call. Opaque: never compute with it."),
  more: z.boolean().describe("Another page follows at once: call again with `cursor`."),
  parcels: z.array(parcelSchema.omit({ history: true })),
  events: z.array(syncEventSchema),
  orders: z.array(orderSchema),
  returns: z.array(returnSchema),
  connections: z.array(connectionSchema),
  deleted: z
    .array(z.object({ type: z.enum(SYNC_ENTITIES), id: z.string() }))
    .describe("Deleted, or no longer shown (every connection that reported it is disabled)."),
});

export function registerSyncRoutes(app: TypedApp, services: Services): void {
  app.get(
    "/api/v1/sync",
    {
      preHandler: requireScope("read"),
      schema: {
        tags: ["sync"],
        summary: "Everything that changed after a cursor, deletions included (docs/sync.md).",
        description:
          "Without `since` (or with `0`) the first page of everything. Each answer carries `cursor`; " +
          "while `more` is true, call again at once with it, then later to pick up new changes. " +
          "Parcels come without `history`: their events are listed under `events`. " +
          "`410 sync_expired`: the cursor is older than the kept deletions (90 days) or newer " +
          "than the server's data (restored from a backup); drop the copy and sync from the start.",
        querystring: z.object({
          since: z
            .string()
            .regex(/^\d{1,15}$/)
            .optional(),
          limit: z.coerce.number().int().min(1).max(SYNC_PAGE_MAX).optional(),
        }),
        response: { 200: syncPageSchema, 410: errorBodySchema },
      },
    },
    async (request) => {
      const page = await services.sync.changes(
        Number(request.query.since ?? "0"),
        request.query.limit ?? SYNC_PAGE_DEFAULT,
      );
      if (page === "expired") {
        throw new ApiError(
          410,
          "sync_expired",
          "The cursor can no longer be continued. Drop the local copy and sync from the start.",
        );
      }
      return { ...page, connections: page.connections.map(toBody) };
    },
  );
}
