import { z } from "zod";
import type { Services } from "../../services.js";
import type { TypedApp } from "../app.js";
import { requireScope } from "../auth-plugin.js";
import { errorBodySchema, notFound } from "../errors.js";

const idParams = z.object({ id: z.uuid() });

/** Counting and clearing what a connection imported ("Clear data" on its card). */
export function registerConnectionDataRoutes(app: TypedApp, services: Services): void {
  const admin = requireScope("admin");

  const dataCounts = z.object({
    parcels: z.number().int().describe("Parcels only this connection reported."),
    orders: z.number().int().describe("Orders only this connection reported."),
    shared: z
      .number()
      .int()
      .describe("Parcels and orders other connections also reported; they stay, unlinked from it."),
  });

  app.get(
    "/api/v1/connections/:id/data",
    {
      preHandler: admin,
      schema: {
        tags: ["connections"],
        summary: "Count what clearing a connection would remove.",
        params: idParams,
        response: { 200: dataCounts, 404: errorBodySchema },
      },
    },
    async (request) => {
      if ((await services.connections.get(request.params.id)) === undefined) {
        throw notFound("The connection");
      }
      return services.parcels.countConnectionData(request.params.id);
    },
  );

  app.post(
    "/api/v1/connections/:id/clear",
    {
      preHandler: admin,
      schema: {
        tags: ["connections"],
        summary: "Remove everything a connection imported, so it syncs again from scratch.",
        description:
          "Parcels and orders only this connection reported are deleted with their history and " +
          "items; ones other connections also reported stay. An inbox reads its mails again. The " +
          "connection and its sign-in are kept, and an enabled connection runs again at once.",
        params: idParams,
        response: { 200: dataCounts, 404: errorBodySchema },
      },
    },
    async (request) => {
      const connection = await services.connections.get(request.params.id);
      if (connection === undefined) {
        throw notFound("The connection");
      }
      const counts = await services.parcels.clearConnectionData(connection.id);
      if (connection.state !== "disabled") {
        if (connection.kind === "mail") {
          await services.mail.disconnect(connection.id);
          await services.mail.connect(connection.id);
        } else {
          await services.connections.requestRun(connection.id);
          services.scheduler.wake();
        }
      }
      return counts;
    },
  );
}
