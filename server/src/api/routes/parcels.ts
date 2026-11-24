import { z } from "zod";
import { DIRECTIONS, parcelSchema, parcelStatusSchema } from "../../domain/parcel.js";
import { detectCarrier } from "../../engine/detect.js";
import { PARCEL_PAGE_DEFAULT } from "../../parcels/repository.js";
import { DuplicateParcelError } from "../../parcels/service.js";
import type { Services } from "../../services.js";
import type { TypedApp } from "../app.js";
import { requireScope } from "../auth-plugin.js";
import { fallbackCarrier } from "../../engine/fallback.js";
import { ApiError, errorBodySchema, notFound } from "../errors.js";

const idParams = z.object({ id: z.uuid() });

const trackingNumberField = z.string().trim().min(4).max(64);

const booleanQuery = z.enum(["true", "false"]).transform((value) => value === "true");

export function registerParcelRoutes(app: TypedApp, services: Services): void {
  const read = requireScope("read");
  const write = requireScope("write");

  app.get(
    "/api/v1/parcels",
    {
      preHandler: read,
      schema: {
        tags: ["parcels"],
        summary: "List parcels, newest change first.",
        description:
          "Pages of `limit` parcels (default 500), from `offset`. A full page carries the " +
          "`X-Next-Offset` header with the offset of the next page; the last page has none.",
        querystring: z.object({
          active: booleanQuery.optional(),
          status: parcelStatusSchema.optional(),
          carrier: z.string().max(64).optional(),
          include_archived: booleanQuery.optional(),
          include_history: booleanQuery.optional(),
          limit: z.coerce.number().int().min(1).max(1000).optional(),
          offset: z.coerce.number().int().min(0).optional(),
        }),
        response: { 200: z.array(parcelSchema) },
      },
    },
    async (request, reply) => {
      const query = request.query;
      const limit = query.limit ?? PARCEL_PAGE_DEFAULT;
      const offset = query.offset ?? 0;
      const parcels = await services.parcels.repository.list(
        {
          ...(query.active === undefined ? {} : { active: query.active }),
          ...(query.status === undefined ? {} : { status: query.status }),
          ...(query.carrier === undefined ? {} : { carrier: query.carrier }),
          ...(query.include_archived === undefined
            ? {}
            : { includeArchived: query.include_archived }),
          limit,
          offset,
        },
        query.include_history === true,
      );
      if (parcels.length === limit) {
        void reply.header("x-next-offset", String(offset + limit));
      }
      return parcels;
    },
  );

  app.get(
    "/api/v1/parcels/:id",
    {
      preHandler: read,
      schema: {
        tags: ["parcels"],
        summary: "One parcel with its full history.",
        params: idParams,
        response: { 200: parcelSchema, 404: errorBodySchema },
      },
    },
    async (request) => {
      const parcel = await services.parcels.repository.getVisible(request.params.id);
      if (parcel === undefined) {
        throw notFound("The parcel");
      }
      return parcel;
    },
  );

  app.post(
    "/api/v1/parcels",
    {
      preHandler: write,
      schema: {
        tags: ["parcels"],
        summary:
          "Start tracking a tracking number. Without a carrier it is detected from the number.",
        body: z.object({
          carrier: z.string().min(1).max(64).optional(),
          tracking_number: trackingNumberField,
          direction: z.enum(DIRECTIONS).default("receiving"),
          label: z.string().max(120).nullable().default(null),
        }),
        response: { 201: parcelSchema, 400: errorBodySchema, 409: errorBodySchema },
      },
    },
    async (request, reply) => {
      const { tracking_number: trackingNumber, direction, label } = request.body;
      // No built-in carrier recognises the number: a fallback tracking service, if added.
      const carrier =
        request.body.carrier ??
        detectCarrier(trackingNumber, null) ??
        (await fallbackCarrier(services.db, services.registry));
      if (carrier === undefined) {
        throw new ApiError(
          400,
          "carrier_not_detected",
          "The carrier could not be detected from this tracking number. Choose one, or add a " +
            "fallback tracking connection (Universal lookup, 17TRACK).",
        );
      }
      try {
        const parcel = await services.parcels.create({
          carrier,
          trackingNumber,
          direction,
          label,
        });
        return await reply.code(201).send(parcel);
      } catch (error) {
        if (error instanceof DuplicateParcelError) {
          throw new ApiError(
            409,
            "duplicate",
            `This parcel is already tracked as ${error.existingId}.`,
          );
        }
        throw error;
      }
    },
  );

  app.patch(
    "/api/v1/parcels/:id",
    {
      preHandler: write,
      schema: {
        tags: ["parcels"],
        summary:
          "Rename, override the status, or archive a parcel. A manual status is never overwritten by carrier updates.",
        params: idParams,
        body: z.object({
          label: z.string().max(120).nullable().optional(),
          manual_status: parcelStatusSchema.nullable().optional(),
          archived: z.boolean().optional(),
        }),
        response: { 200: parcelSchema, 404: errorBodySchema },
      },
    },
    async (request) => {
      const body = request.body;
      const parcel = await services.parcels.update(request.params.id, {
        ...(body.label === undefined ? {} : { label: body.label }),
        ...(body.manual_status === undefined ? {} : { manualStatus: body.manual_status }),
        ...(body.archived === undefined ? {} : { archived: body.archived }),
      });
      if (parcel === undefined) {
        throw notFound("The parcel");
      }
      return parcel;
    },
  );

  app.delete(
    "/api/v1/parcels/:id",
    {
      preHandler: write,
      schema: {
        tags: ["parcels"],
        summary: "Stop tracking and delete a parcel.",
        params: idParams,
        response: { 204: z.null(), 404: errorBodySchema },
      },
    },
    async (request, reply) => {
      if (!(await services.parcels.delete(request.params.id))) {
        throw notFound("The parcel");
      }
      return reply.code(204).send(null);
    },
  );
}
