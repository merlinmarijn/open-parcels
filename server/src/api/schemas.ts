import type { FastifyReply } from "fastify";
import { z } from "zod";
import { CONNECTION_KINDS } from "../provider/api.js";

/** `/:id` of a parcel, order or connection. */
export const idParams = z.object({ id: z.uuid() });

/** The kinds a provider's connection can have. */
export const providerKindSchema = z.enum(CONNECTION_KINDS);

/** `limit` (up to `max`) and `offset` of a paged list. */
export const pageQuery = (
  max: number,
): { limit: z.ZodOptional<z.ZodCoercedNumber>; offset: z.ZodOptional<z.ZodCoercedNumber> } => ({
  limit: z.coerce.number().int().min(1).max(max).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

/** Tells the client where the next page starts, when another page follows. */
export function markNextPage(
  reply: FastifyReply,
  offset: number,
  limit: number,
  more: boolean,
): void {
  if (more) {
    void reply.header("x-next-offset", String(offset + limit));
  }
}
