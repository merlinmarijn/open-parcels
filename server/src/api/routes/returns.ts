import { z } from "zod";
import { returnSchema } from "../../domain/return.js";
import { RETURN_VIEWS } from "../../returns/service.js";
import type { Services } from "../../services.js";
import type { TypedApp } from "../app.js";
import { requireScope } from "../auth-plugin.js";
import { errorBodySchema, notFound } from "../errors.js";

const ABOUT =
  "A return is something sent back to a shop, per order. Sources (a shop account, return and " +
  "refund mails) create and update it; `status` goes `requested`, `label_created`, " +
  "`dropped_off`, `in_transit`, `received`, `refunded`, or ends `rejected` or `cancelled`. A " +
  "return not handed in by `return_by` (the server's local day) reads `expired`. `drop_off` " +
  "lists where it may be handed in (`kind`: `shop`, `parcel_locker`, `post_office`, `pickup`, " +
  "or `any` point of the carrier); `cost` says whether sending it back is free. Once a tracking " +
  "number is known, `parcel_id` is the outgoing parcel that tracks it. Returns hide while every " +
  "source that reported them, or their order, is disabled. Changes fire `return.created` and " +
  "`return.updated`.";

export function registerReturnRoutes(app: TypedApp, services: Services): void {
  const read = requireScope("read");

  app.get(
    "/api/v1/returns",
    {
      preHandler: read,
      schema: {
        tags: ["returns"],
        summary: "List returns, newest first.",
        description:
          `${ABOUT} \`view\`: \`open\` (default; still going on), \`closed\` (refunded, ` +
          "rejected, cancelled or expired), or `all`.",
        querystring: z.object({ view: z.enum(RETURN_VIEWS).default("open") }),
        response: { 200: z.array(returnSchema) },
      },
    },
    async (request) => services.returns.list(request.query.view),
  );

  app.get(
    "/api/v1/returns/:id",
    {
      preHandler: read,
      schema: {
        tags: ["returns"],
        summary: "One return.",
        description: ABOUT,
        params: z.object({ id: z.uuid() }),
        response: { 200: returnSchema, 404: errorBodySchema },
      },
    },
    async (request) => {
      const found = await services.returns.get(request.params.id);
      if (found === undefined) {
        throw notFound("The return");
      }
      return found;
    },
  );
}
