import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import type { AccessControl } from "../auth/access.js";
import { safeEqual } from "../auth/crypto.js";
import { ACCESS_PREFIX, type LoginStore } from "../auth/logins.js";
import {
  ROLE_SCOPES,
  roleOfScopes,
  SCOPES,
  type AuthStore,
  type Role,
  type Scope,
} from "../auth/store.js";
import { forbidden, unauthorized, ApiError } from "./errors.js";
import { isServerPath } from "./web-ui.js";

export const SESSION_COOKIE = "op_session";
const CSRF_HEADER = "x-csrf-token";

/** Address the Home Assistant Supervisor uses for ingress requests. */
export const HA_INGRESS_ADDRESS = "172.30.32.2";

interface Caller {
  readonly role: Role;
  readonly scopes: readonly Scope[];
}

export type AuthContext =
  | (Caller & { readonly kind: "ingress" })
  | (Caller & { readonly kind: "token"; readonly tokenId: string })
  /** A token login (log in with a password, access + refresh token), e.g. the Android app. */
  | (Caller & { readonly kind: "login"; readonly loginId: string })
  | (Caller & { readonly kind: "session"; readonly csrfToken: string })
  /** No credential, but reading is open because OPENPARCELS_PASSWORD is empty. */
  | (Caller & { readonly kind: "anonymous" });

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface AuthPluginOptions {
  readonly store: AuthStore;
  readonly logins: LoginStore;
  readonly access: AccessControl;
  /**
   * When set, this server instance is the Home Assistant ingress listener and requests from this
   * address are trusted as the admin: Home Assistant has already authenticated the user.
   */
  readonly trustedIngressAddress: string | undefined;
}

/** The live event stream: browsers' EventSource cannot send headers. */
const EVENTS_PATH = "/api/v1/events";

/**
 * The bearer token of the Authorization header; on the live event stream also a login's access
 * token in `?access_token=` (short-lived, and the logger never writes query strings). Long-lived
 * API tokens are never accepted in an address.
 */
function bearerToken(request: Pick<FastifyRequest, "headers" | "url">): string | undefined {
  const header = request.headers.authorization;
  if (header !== undefined) return /^Bearer\s+(\S+)$/i.exec(header)?.[1];
  const [path, query] = request.url.split("?", 2);
  if (path !== EVENTS_PATH || query === undefined) return undefined;
  const token = new URLSearchParams(query).get("access_token");
  return token?.startsWith(ACCESS_PREFIX) === true ? token : undefined;
}

async function resolveAuth(
  request: FastifyRequest,
  options: AuthPluginOptions,
): Promise<AuthContext | null> {
  if (options.trustedIngressAddress !== undefined) {
    // On the ingress listener nothing else is accepted: only the Supervisor may talk to it.
    return request.socket.remoteAddress === options.trustedIngressAddress
      ? { kind: "ingress", role: "admin", scopes: SCOPES }
      : null;
  }
  const token = bearerToken(request);
  if (token?.startsWith(ACCESS_PREFIX) === true) {
    const login = await options.logins.findByAccess(token);
    return login === undefined
      ? null
      : { kind: "login", loginId: login.id, role: login.role, scopes: ROLE_SCOPES[login.role] };
  }
  if (token !== undefined) {
    const found = await options.store.findToken(token);
    return found === undefined
      ? null
      : {
          kind: "token",
          tokenId: found.id,
          role: roleOfScopes(found.scopes),
          scopes: found.scopes,
        };
  }
  const cookie = request.cookies[SESSION_COOKIE];
  const session = cookie === undefined ? undefined : await options.store.findSession(cookie);
  if (session !== undefined) {
    return {
      kind: "session",
      csrfToken: session.csrfToken,
      role: session.role,
      scopes: ROLE_SCOPES[session.role],
    };
  }
  return options.access.readerRequired
    ? null
    : { kind: "anonymous", role: "reader", scopes: ROLE_SCOPES.reader };
}

/**
 * A check that the credential this request came with is still valid: the session not logged out
 * or expired, the token not revoked, reading still open. Long-lived responses (the event stream)
 * call it to end themselves when their access ends.
 */
/** The parts of a request whose credentials a long-lived stream re-checks. */
export type CredentialRequest = Pick<FastifyRequest, "auth" | "headers" | "cookies" | "url">;

export function credentialCheck(
  request: CredentialRequest,
  options: Pick<AuthPluginOptions, "store" | "logins" | "access">,
): () => Promise<boolean> {
  const { store, logins, access } = options;
  const auth = request.auth;
  if (auth === null) {
    return () => Promise.resolve(false);
  }
  switch (auth.kind) {
    case "ingress":
      return () => Promise.resolve(true);
    case "anonymous":
      return () => Promise.resolve(!access.readerRequired);
    // The login, not its access token: a stream outlives the token it was opened with until the
    // login is logged out, revoked or runs out.
    case "login":
      return () => logins.alive(auth.loginId);
    case "token": {
      const token = bearerToken(request) ?? "";
      return async () => (await store.tokenAlive(token)) === auth.tokenId;
    }
    case "session": {
      const cookie = request.cookies[SESSION_COOKIE] ?? "";
      return () => store.sessionAlive(cookie);
    }
  }
}

/** Browser sessions must echo the CSRF token on state-changing requests. */
function checkCsrf(request: FastifyRequest, auth: AuthContext): void {
  if (auth.kind !== "session" || SAFE_METHODS.has(request.method)) {
    return;
  }
  const sent = request.headers[CSRF_HEADER];
  if (typeof sent !== "string" || !safeEqual(sent, auth.csrfToken)) {
    throw new ApiError(
      403,
      "csrf",
      "The CSRF token is missing or wrong. Reload the page and try again.",
    );
  }
}

/**
 * Routes anyone may call: those that declare `security: []` in their schema (login, setup,
 * health, the secret calendar feed) and the web UI's own files, which hold no data and must load
 * so the login page can show. Decided from the route that matched, never from the raw URL alone:
 * the router decodes the path, so `/%61pi/v1/...` reaches an API route while its raw URL does
 * not look like one.
 */
function isPublicRoute(request: FastifyRequest): boolean {
  const security = (request.routeOptions.schema as { security?: unknown } | undefined)?.security;
  if (Array.isArray(security) && security.length === 0) return true;
  const route = request.routeOptions.url;
  return !isServerPath(request.url) && (route === undefined || !isServerPath(route));
}

/**
 * The access rule for every route, so new routes are covered without opting in: reading needs a
 * reader login when OPENPARCELS_PASSWORD is set (else nothing), anything else needs the admin.
 */
function checkAccess(request: FastifyRequest): void {
  if (request.is404 || isPublicRoute(request)) return;
  const auth = request.auth;
  if (auth === null) throw unauthorized();
  if (SAFE_METHODS.has(request.method) || auth.role === "admin") return;
  if (auth.kind === "anonymous") throw unauthorized();
  throw new ApiError(
    403,
    "admin_required",
    "Only the admin may change anything. Log in with the admin password.",
  );
}

export function registerAuth(app: FastifyInstance, options: AuthPluginOptions): void {
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    request.auth = await resolveAuth(request, options);
    if (request.auth !== null) {
      checkCsrf(request, request.auth);
    }
    checkAccess(request);
  });
}

/**
 * Route guard: the request must hold the scope. Sessions hold their role's scopes; API tokens
 * hold the scopes they were made with, so a write token cannot manage tokens or settings.
 */
export function requireScope(scope: Scope): preHandlerHookHandler {
  return (request: FastifyRequest, _reply: FastifyReply, done) => {
    if (request.auth === null) {
      done(unauthorized());
      return;
    }
    if (!request.auth.scopes.includes(scope)) {
      done(forbidden(scope));
      return;
    }
    done();
  };
}
