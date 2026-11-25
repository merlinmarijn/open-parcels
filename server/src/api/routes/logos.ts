import { z } from "zod";
import type { Logo } from "../../logos.js";
import type { Services } from "../../services.js";
import type { TypedApp } from "../app.js";
import { notFound } from "../errors.js";

/**
 * Serves the built-in providers' logos. Public like the web UI's own files: a logo says nothing
 * about the user. The URL carries the content hash (`logoPath`), so browsers keep it for good.
 */
export function registerLogoRoutes(
  app: TypedApp,
  services: Services,
  logos: ReadonlyMap<string, Logo>,
): void {
  app.get(
    "/api/v1/carriers/:id/logo",
    {
      schema: {
        tags: ["connections"],
        summary: "A provider's logo (SVG or PNG); the carrier list gives its URL.",
        security: [],
        params: z.object({ id: z.string() }),
        querystring: z.object({ v: z.string().optional() }),
      },
    },
    (request, reply) => {
      const file = services.registry.list().find((p) => p.info.id === request.params.id)?.info.logo;
      const logo = file === undefined || file === null ? undefined : logos.get(file);
      if (logo === undefined) {
        throw notFound("route");
      }
      const immutable = request.query.v === logo.version;
      return reply
        .header("content-type", logo.contentType)
        .header("cache-control", immutable ? "public, max-age=31536000, immutable" : "no-cache")
        .header("x-content-type-options", "nosniff")
        .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'")
        .send(logo.body);
    },
  );
}
