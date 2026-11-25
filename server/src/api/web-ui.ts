import { escapeHtml } from "../net/html.js";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { routeNotFound } from "./errors.js";

/** Paths the web UI never answers, so an unknown API route stays a JSON 404. */
const SERVER_PREFIXES = ["/api/", "/ical/", "/img/", "/tiles/"] as const;
const BASE_PLACEHOLDER = "%OPENPARCELS_BASE%";
/** Home Assistant ingress prefixes look like `/api/hassio_ingress/<token>`. */
const INGRESS_PATH = /^\/api\/hassio_ingress\/[\w-]{1,128}$/;

/**
 * The page may load code, styles and fonts only from this server and talk only to it. Map tiles
 * and item pictures come through this server's own /tiles/ and /img/ proxies, so images need only
 * 'self' plus data: and blob: URLs. Scripts never run inline. Styles allow 'unsafe-inline' because
 * leaflet-ant-path ships its CSS through a style-loader runtime that injects <style> elements;
 * inline CSS cannot run code, so the script rule is what matters.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "font-src 'self' data:", // FullCalendar embeds its icon font as a data: URL
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  // Home Assistant shows ingress pages in a frame on its own origin, which is this one.
  "frame-ancestors 'self'",
].join("; ");

/** Headers for the HTML page; the hashed assets only carry caching headers. */
const PAGE_HEADERS: Readonly<Record<string, string>> = {
  "cache-control": "no-cache",
  "content-security-policy": CONTENT_SECURITY_POLICY,
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
  "referrer-policy": "same-origin",
  // "Use my location" in Settings needs geolocation; nothing else is used.
  "permissions-policy": "geolocation=(self), camera=(), microphone=(), payment=()",
};

export interface WebUiOptions {
  /** Folder holding the built UI (`index.html` plus `assets/`). */
  readonly root: string;
  /** Only the ingress listener honours the `X-Ingress-Path` header. */
  readonly trustIngressPath: boolean;
}

export function isServerPath(url: string): boolean {
  const pathname = url.split("?", 1)[0] ?? url;
  return (
    pathname === "/api" ||
    pathname === "/ical" ||
    pathname === "/img" ||
    SERVER_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
}

/** The base path the UI is served under: `/`, or the ingress prefix followed by `/`. */
function basePath(request: FastifyRequest, trustIngressPath: boolean): string {
  const header = request.headers["x-ingress-path"];
  if (trustIngressPath && typeof header === "string" && INGRESS_PATH.test(header)) {
    return `${header}/`;
  }
  return "/";
}

function sendIndex(reply: FastifyReply, template: string, base: string): FastifyReply {
  return reply
    .code(200)
    .type("text/html; charset=utf-8")
    .headers(PAGE_HEADERS)
    .send(template.replaceAll(BASE_PLACEHOLDER, escapeHtml(base)));
}

/**
 * Serves the built web UI: hashed assets as static files, and `index.html` (with the base path
 * filled in) for every other GET that is not an API, feed or image route.
 * Returns false when the folder has no build, so the server runs API-only.
 */
export async function registerWebUi(app: FastifyInstance, options: WebUiOptions): Promise<boolean> {
  const indexFile = path.join(options.root, "index.html");
  if (!existsSync(indexFile)) {
    return false;
  }
  const template = readFileSync(indexFile, "utf8");
  await app.register(fastifyStatic, {
    root: options.root,
    prefix: "/",
    index: false,
    wildcard: false,
    // index.html is only ever sent through the template, never raw.
    allowedPath: (pathName) => pathName !== "/index.html",
    setHeaders: (response, filePath) => {
      const immutable = filePath.includes(`${path.sep}assets${path.sep}`);
      void response.header(
        "cache-control",
        immutable ? "public, max-age=31536000, immutable" : "public, max-age=3600",
      );
    },
  });
  app.setNotFoundHandler((request, reply) => {
    const acceptsHtml = request.headers.accept?.includes("text/html") ?? false;
    if (request.method === "GET" && !isServerPath(request.url) && acceptsHtml) {
      return sendIndex(reply, template, basePath(request, options.trustIngressPath));
    }
    return reply.code(404).send(routeNotFound(request.method, request.url));
  });
  return true;
}
