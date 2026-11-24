import { z } from "zod";
import type { Services } from "../../services.js";
import type { TypedApp } from "../app.js";
import { requireScope } from "../auth-plugin.js";
import { errorBodySchema, notFound } from "../errors.js";

const idParams = z.object({ id: z.uuid() });

/** Counting and clearing what a source imported ("Clear data" on its card). */
export function registerSourceDataRoutes(app: TypedApp, services: Services): void {
  const admin = requireScope("admin");

  const dataCounts = z.object({
    parcels: z.number().int().describe("Parcels only this source reported."),
    orders: z.number().int().describe("Orders only this source reported."),
    shared: z
      .number()
      .int()
      .describe("Parcels and orders other sources also reported; they stay, unlinked from it."),
  });

  app.get(
    "/api/v1/sources/:id/data",
    {
      preHandler: admin,
      schema: {
        tags: ["sources"],
        summary: "Count what clearing a source would remove.",
        params: idParams,
        response: { 200: dataCounts, 404: errorBodySchema },
      },
    },
    async (request) => {
      if ((await services.sources.get(request.params.id)) === undefined) {
        throw notFound("The source");
      }
      return services.parcels.countSourceData(request.params.id);
    },
  );

  app.post(
    "/api/v1/sources/:id/clear",
    {
      preHandler: admin,
      schema: {
        tags: ["sources"],
        summary: "Remove everything a source imported, so it syncs again from scratch.",
        description:
          "Parcels and orders only this source reported are deleted with their history and " +
          "items; ones other sources also reported stay. A mailbox reads its mails again. The " +
          "source and its sign-in are kept, and an enabled source runs again at once.",
        params: idParams,
        response: { 200: dataCounts, 404: errorBodySchema },
      },
    },
    async (request) => {
      const source = await services.sources.get(request.params.id);
      if (source === undefined) {
        throw notFound("The source");
      }
      const counts = await services.parcels.clearSourceData(source.id);
      if (source.state !== "disabled") {
        if (source.kind === "mail") {
          await services.mail.disconnect(source.id);
          await services.mail.connect(source.id);
        } else {
          await services.sources.requestRun(source.id);
          services.scheduler.wake();
        }
      }
      return counts;
    },
  );
}
