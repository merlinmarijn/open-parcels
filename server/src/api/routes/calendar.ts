import { DAY_MS } from "../../clock.js";
import { snakeCased } from "../snake-case.js";
import { z } from "zod";
import { randomSecret, safeEqual, sha256Hex } from "../../auth/crypto.js";
import { renderIcs } from "../../calendar/ics.js";
import { returnSchema } from "../../domain/return.js";
import { LANGUAGES, requestLanguage } from "../../i18n/language.js";
import type { Services } from "../../services.js";
import type { TypedApp } from "../app.js";
import { requireScope } from "../auth-plugin.js";
import { ApiError, errorBodySchema, notFound } from "../errors.js";

/** The feed shows a month back and two months ahead. */
const FEED_PAST_MS = 30 * DAY_MS;
const FEED_FUTURE_MS = 60 * DAY_MS;

const entrySchema = z.object({
  uid: z.string(),
  parcel_id: z.uuid().nullable().describe("Null for a return's deadline."),
  return_id: z.uuid().nullable(),
  order_id: z.uuid().nullable(),
  title: z.string(),
  carrier: z
    .string()
    .describe("For a return: its carrier, else a drop-off option's, else the shop."),
  tracking_number: z.string().describe("For a return: the order number."),
  status: z.string(),
  kind: z
    .enum(["expected", "delivered", "return_by"])
    .describe("`return_by`: the last day to hand a return in (all day)."),
  drop_off: returnSchema.shape.drop_off.describe(
    "For a return: where it may be handed in (as on the return); empty for a parcel.",
  ),
  cost: returnSchema.shape.cost.describe(
    "For a return: what sending it back costs, null when not known; null for a parcel.",
  ),
  start: z.string(),
  end: z.string(),
  all_day: z.boolean(),
  start_date: z.iso.date().nullable().describe("All-day entries: the first local day."),
  end_date: z.iso
    .date()
    .nullable()
    .describe("All-day entries: the day after the last (exclusive)."),
  late: z.boolean(),
  image_url: z.string().nullable(),
  url: z.string().nullable(),
  pickup_point: z.string().nullable(),
});

export function registerCalendarRoutes(app: TypedApp, services: Services): void {
  app.get(
    "/api/v1/calendar",
    {
      preHandler: requireScope("read"),
      schema: {
        tags: ["calendar"],
        summary:
          "Expected deliveries, delivered parcels and return deadlines in a time range (what the Calendar tab and the ICS feed show).",
        querystring: z.object({
          from: z.iso.datetime({ offset: true }),
          to: z.iso.datetime({ offset: true }),
        }),
        response: { 200: z.array(entrySchema), 400: errorBodySchema },
      },
    },
    async (request) => {
      const from = new Date(request.query.from);
      const to = new Date(request.query.to);
      if (to <= from || to.getTime() - from.getTime() > 400 * DAY_MS) {
        throw new ApiError(
          400,
          "invalid_range",
          "Use a range that ends after it starts and spans at most 400 days.",
        );
      }
      const entries = await services.calendar.entries(from, to);
      return entries.map((entry) => snakeCased(entry));
    },
  );

  app.post(
    "/api/v1/calendar/feed",
    {
      preHandler: requireScope("admin"),
      schema: {
        tags: ["calendar"],
        summary:
          "Create (or replace) the secret ICS feed address. The previous address stops working.",
        response: { 201: z.object({ path: z.string(), url: z.string().nullable() }) },
      },
    },
    async (_request, reply) => {
      const token = randomSecret(24);
      await services.settings.setFeedHash(sha256Hex(token));
      const path = `/ical/${token}.ics`;
      const publicUrl = services.config.publicUrl;
      return reply.code(201).send({
        path,
        url: publicUrl === undefined ? null : new URL(path.slice(1), publicUrl).toString(),
      });
    },
  );

  app.delete(
    "/api/v1/calendar/feed",
    {
      preHandler: requireScope("admin"),
      schema: {
        tags: ["calendar"],
        summary: "Turn the ICS feed off.",
        response: { 204: z.null() },
      },
    },
    async (_request, reply) => {
      await services.settings.setFeedHash(null);
      return reply.code(204).send(null);
    },
  );

  // Calendar apps cannot send headers, so the feed is authorised by the secret in its path.
  app.get(
    "/ical/:token.ics",
    {
      schema: {
        tags: ["calendar"],
        summary:
          "The ICS feed. Its address is a secret: anyone who has it can read the delivery calendar.",
        description:
          "Texts are in the language of `lang`, else of Accept-Language (English or German).",
        security: [],
        params: z.object({ token: z.string().min(16).max(128) }),
        querystring: z.object({ lang: z.enum(LANGUAGES).optional() }),
      },
    },
    async (request, reply) => {
      const stored = services.settings.feedHash;
      if (stored === null || !safeEqual(stored, sha256Hex(request.params.token))) {
        throw notFound("calendar_feed");
      }
      const now = services.clock.now();
      const entries = await services.calendar.entries(
        new Date(now.getTime() - FEED_PAST_MS),
        new Date(now.getTime() + FEED_FUTURE_MS),
      );
      const body = renderIcs(entries, {
        timeZone: services.config.timeZone,
        language: request.query.lang ?? requestLanguage(request.headers["accept-language"]),
        publicUrl: services.config.publicUrl,
      });
      return reply
        .header("content-type", "text/calendar; charset=utf-8")
        .header("cache-control", "private, max-age=300")
        .send(body);
    },
  );
}
