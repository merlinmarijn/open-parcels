import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config.js";

const ALLOWED_METHODS = "GET, HEAD, POST, PUT, PATCH, DELETE";
const ALLOWED_HEADERS = "authorization, content-type, last-event-id";
/** Response headers a cross-origin page may read: paging and throttling. */
const EXPOSED_HEADERS = "x-next-offset, retry-after";
const PREFLIGHT_MAX_AGE_S = 600;

/**
 * CORS for the origins in OPENPARCELS_CORS_ORIGINS (read on every request, so a change in the
 * Settings page applies at once). Exact matches only, never `*`, and never credentials: pages on
 * other origins log in with tokens (`POST /api/v1/logins`), so the session cookie stays
 * same-origin. Other origins get no CORS headers, which browsers treat as a refusal. Preflights
 * of allowed origins are answered here, before the access rule (they carry no credentials).
 */
export function registerCors(app: FastifyInstance, config: AppConfig): void {
  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (origin === undefined || !config.corsOrigins.includes(origin)) return undefined;
    void reply.header("access-control-allow-origin", origin).header("vary", "Origin");
    if (
      request.method === "OPTIONS" &&
      request.headers["access-control-request-method"] !== undefined
    ) {
      return reply
        .code(204)
        .header("access-control-allow-methods", ALLOWED_METHODS)
        .header("access-control-allow-headers", ALLOWED_HEADERS)
        .header("access-control-max-age", String(PREFLIGHT_MAX_AGE_S))
        .send();
    }
    void reply.header("access-control-expose-headers", EXPOSED_HEADERS);
    return undefined;
  });
}
