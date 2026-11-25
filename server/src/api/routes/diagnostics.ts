import { VERSION } from "../../version.js";
import { z } from "zod";
import { redactValue } from "../../log/redact.js";
import type { Services } from "../../services.js";
import type { TypedApp } from "../app.js";
import { requireScope } from "../auth-plugin.js";

const startedAt = new Date();

/**
 * A snapshot of how the service is doing, for the Status page and for bug reports. It contains no
 * configuration values, no sign-in data and no parcel contents; free text passes the redactor.
 */
export function registerDiagnosticsRoutes(app: TypedApp, services: Services): void {
  app.get(
    "/api/v1/diagnostics",
    {
      preHandler: requireScope("admin"),
      schema: {
        tags: ["status"],
        summary:
          "Redacted state of connections, parcels, live tracking and unknown carrier values.",
        response: { 200: z.unknown() },
      },
    },
    async () => {
      const db = services.db;
      const [connections, statusCounts, unknown, outbox, liveSessions] = await Promise.all([
        db
          .selectFrom("connections")
          .select([
            "id",
            "provider",
            "kind",
            "state",
            "state_detail",
            "consecutive_failures",
            "next_run_at",
            "last_run_at",
            "last_ok_at",
          ])
          .orderBy("created_at")
          .execute(),
        db
          .selectFrom("parcels")
          .select(["status", "delivered", (eb) => eb.fn.countAll<number>().as("count")])
          .where("archived_at", "is", null)
          .groupBy(["status", "delivered"])
          .execute(),
        db
          .selectFrom("unknown_vocab")
          .selectAll()
          .orderBy("last_seen_at", "desc")
          .limit(100)
          .execute(),
        db
          .selectFrom("outbox")
          .select((eb) => eb.fn.countAll<number>().as("count"))
          .executeTakeFirst(),
        db
          .selectFrom("live_state")
          .select((eb) => eb.fn.countAll<number>().as("count"))
          .executeTakeFirst(),
      ]);
      return redactValue({
        version: VERSION,
        started_at: startedAt.toISOString(),
        uptime_seconds: Math.round((services.clock.now().getTime() - startedAt.getTime()) / 1000),
        time_zone: services.config.timeZone,
        node: process.version,
        providers: services.registry.list().map((provider) => ({
          id: provider.info.id,
          connection_kinds: provider.info.connectionKinds,
        })),
        connections,
        parcels: statusCounts,
        unknown_values: unknown,
        outbox_events: outbox?.count ?? 0,
        live_sessions: liveSessions?.count ?? 0,
        event_stream_clients: services.bus.subscriberCount,
      });
    },
  );
}
