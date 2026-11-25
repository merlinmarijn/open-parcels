import type { FastifyReply } from "fastify";
import { z } from "zod";
import { STATE_REASONS } from "../engine/state-reason.js";
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

/** Why a connection is in its state, as a code; clients show their own text. */
export const stateReasonSchema = z
  .enum(STATE_REASONS)
  .nullable()
  .describe("Why the connection is in its state, as a code; null when there is nothing to say.");

/** Words a provider or carrier wrote about the state, passed through untranslated. */
export const carrierMessageSchema = z
  .string()
  .nullable()
  .describe(
    "What the provider or carrier said about the state (an HTTP status, a changed response, why " +
      "it did nothing), as written; null when it said nothing.",
  );
