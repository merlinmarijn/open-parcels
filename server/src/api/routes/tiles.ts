import type { FastifyReply } from "fastify";
import { z } from "zod";
import { requestLanguage } from "../../i18n/language.js";
import type { Services } from "../../services.js";
import { TILE_MAX_ZOOM_ANY, TileError } from "../../tiles/proxy.js";
import type { TypedApp } from "../app.js";
import { requireScope } from "../auth-plugin.js";
import { ApiError } from "../errors.js";

/** At the deepest zoom a column or row is below 2^zoom; anything larger is refused up front. */
const coordinate = (maxZoom: number) =>
  z.coerce
    .number()
    .int()
    .min(0)
    .max(2 ** maxZoom - 1);

const layerSchema = z.object({
  id: z.string(),
  label: z.string().describe("In the language of Accept-Language (English or German)."),
  kind: z.enum(["base", "overlay"]),
  max_zoom: z.number().int(),
  attribution: z
    .string()
    .describe("HTML for the map's attribution control, in the language of Accept-Language."),
  satellite: z.boolean().describe("Photographic imagery: no dark-mode filter."),
  dark: z.boolean().describe("A dark style already: no dark-mode filter."),
});

const layersSchema = z.object({
  layers: z.array(layerSchema),
  default_base: z.string().describe("Base layer shown until the user picks one."),
  default_overlay: z.string().nullable(),
});

async function sendTile(
  services: Services,
  reply: FastifyReply,
  at: { readonly layer: string; readonly z: number; readonly x: number; readonly y: number },
): Promise<FastifyReply> {
  try {
    const tile = await services.tiles.get(at.layer, at.z, at.x, at.y);
    return await reply
      .header("content-type", tile.contentType)
      .header("cache-control", "private, max-age=86400")
      .header("x-content-type-options", "nosniff")
      .send(tile.body);
  } catch (error) {
    if (error instanceof TileError) {
      throw new ApiError(error.statusCode, "tile", error.message, { status: error.statusCode });
    }
    throw error;
  }
}

export function registerTileRoutes(app: TypedApp, services: Services): void {
  app.get(
    "/api/v1/map/layers",
    {
      preHandler: requireScope("read"),
      schema: {
        tags: ["map"],
        summary: "The map styles this server proxies, without their upstream addresses or keys.",
        response: { 200: layersSchema },
      },
    },
    (request) => {
      const language = requestLanguage(request.headers["accept-language"]);
      const layers = services.tiles.layers();
      const { baseLayer, overlay } = services.config.map;
      const hasBase = layers.some((layer) => layer.id === baseLayer);
      return {
        layers: layers.map((layer) => ({
          id: layer.id,
          label: layer.label[language],
          kind: layer.kind,
          max_zoom: layer.maxZoom,
          attribution: layer.attribution[language],
          satellite: layer.satellite,
          dark: layer.dark ?? false,
        })),
        // A custom default without a usable custom provider falls back to the plain map.
        default_base: hasBase ? baseLayer : "osm",
        default_overlay: overlay === "none" ? null : overlay,
      };
    },
  );

  app.get(
    "/tiles/:layer/:z/:x/:y",
    {
      preHandler: requireScope("read"),
      schema: {
        tags: ["map"],
        summary: "A map tile of one of the listed layers, fetched and cached by this server.",
        params: z.object({
          layer: z.string().regex(/^[a-z0-9_-]{1,32}$/),
          z: z.coerce.number().int().min(0).max(TILE_MAX_ZOOM_ANY),
          x: coordinate(TILE_MAX_ZOOM_ANY),
          y: coordinate(TILE_MAX_ZOOM_ANY),
        }),
      },
    },
    async (request, reply) => {
      return sendTile(services, reply, request.params);
    },
  );
}
