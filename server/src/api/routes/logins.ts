import type { FastifyRequest } from "fastify";
import { z } from "zod";
import type { IssuedTokens, LoginInfo } from "../../auth/logins.js";
import { ROLES } from "../../auth/store.js";
import type { LoginThrottle } from "../../auth/throttle.js";
import type { Services } from "../../services.js";
import type { TypedApp } from "../app.js";
import { requireScope } from "../auth-plugin.js";
import { ApiError, errorBodySchema, notFound } from "../errors.js";
import { checkThrottle } from "./login-guard.js";

const loginInfoSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  role: z.enum(ROLES),
  created_at: z.string(),
  last_used_at: z.string(),
  expires_at: z.string().describe("When the login ends unless it is refreshed before."),
});

const issuedSchema = z.object({
  access_token: z.string().describe("Send as `Authorization: Bearer`; valid for 15 minutes."),
  access_expires_at: z.string(),
  refresh_token: z
    .string()
    .describe("Trade for new tokens before it expires; each one works once."),
  refresh_expires_at: z.string(),
  login: loginInfoSchema,
});

const refreshBody = z.object({ refresh_token: z.string().max(200) });

function infoBody(info: LoginInfo): z.infer<typeof loginInfoSchema> {
  return {
    id: info.id,
    name: info.name,
    role: info.role,
    created_at: info.createdAt,
    last_used_at: info.lastUsedAt,
    expires_at: info.expiresAt,
  };
}

function issuedBody(issued: IssuedTokens): z.infer<typeof issuedSchema> {
  return {
    access_token: issued.accessToken,
    access_expires_at: issued.accessExpiresAt,
    refresh_token: issued.refreshToken,
    refresh_expires_at: issued.refreshExpiresAt,
    login: infoBody(issued.login),
  };
}

export interface LoginGuard {
  readonly throttle: LoginThrottle;
  readonly warnAboutProxy: (request: FastifyRequest) => void;
}

/**
 * Token logins for clients without cookies (decision record 0003 §6): the web UI on another
 * origin, the Android app, client libraries. The same passwords and throttle as the cookie login.
 */
export function registerLoginRoutes(app: TypedApp, services: Services, guard: LoginGuard): void {
  const admin = requireScope("admin");

  app.post(
    "/api/v1/logins",
    {
      schema: {
        tags: ["session"],
        summary:
          "Log in without a cookie: the admin password or OPENPARCELS_PASSWORD gives an access token and a refresh token.",
        description:
          "The access token is valid for 15 minutes; trade the refresh token at " +
          "`POST /api/v1/logins/refresh` for new ones. A login not refreshed for 30 days ends. " +
          "`role: reader` with the admin password gives a login that may only read.",
        security: [],
        body: z.object({
          password: z.string().max(256),
          name: z.string().trim().min(1).max(80).describe("Shown on the tokens page."),
          role: z.enum(ROLES).optional().describe("At most the password's role."),
        }),
        response: { 201: issuedSchema, 401: errorBodySchema, 429: errorBodySchema },
      },
    },
    async (request, reply) => {
      guard.warnAboutProxy(request);
      checkThrottle(guard.throttle, request, reply);
      const role = await services.access.roleFor(request.body.password);
      if (role === null) {
        guard.throttle.recordFailure(request.ip);
        services.logger.info({ ip: request.ip }, "A token login failed.");
        throw new ApiError(401, "wrong_password", "That password is not correct.");
      }
      guard.throttle.reset(request.ip);
      const granted = request.body.role === "reader" ? "reader" : role;
      return reply
        .code(201)
        .send(issuedBody(await services.logins.create(request.body.name, granted)));
    },
  );

  app.post(
    "/api/v1/logins/refresh",
    {
      schema: {
        tags: ["session"],
        summary: "Trade a refresh token for a new access token and refresh token.",
        description:
          "Each refresh token works once. Presenting one that was already traded ends the login " +
          "(someone else holds a copy), so refresh from one place at a time.",
        security: [],
        body: refreshBody,
        response: { 200: issuedSchema, 401: errorBodySchema },
      },
    },
    async (request) => {
      const issued = await services.logins.refresh(request.body.refresh_token);
      if (issued === undefined) {
        throw new ApiError(401, "login_ended", "The login has ended. Log in again.");
      }
      return issuedBody(issued);
    },
  );

  app.post(
    "/api/v1/logins/logout",
    {
      schema: {
        tags: ["session"],
        summary: "Log out a token login: its access and refresh tokens stop working.",
        // Holding the refresh token is the proof; it works after the access token expired.
        security: [],
        body: refreshBody,
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      await services.logins.endByRefresh(request.body.refresh_token);
      return reply.code(204).send(null);
    },
  );

  app.get(
    "/api/v1/logins",
    {
      preHandler: admin,
      schema: {
        tags: ["tokens"],
        summary: "Token logins that have not ended (tokens are never shown).",
        response: { 200: z.array(loginInfoSchema) },
      },
    },
    async () => (await services.logins.list()).map(infoBody),
  );

  app.delete(
    "/api/v1/logins/:id",
    {
      preHandler: admin,
      schema: {
        tags: ["tokens"],
        summary: "End a token login: its tokens stop working and its live event streams close.",
        params: z.object({ id: z.uuid() }),
        response: { 204: z.null(), 404: errorBodySchema },
      },
    },
    async (request, reply) => {
      if (!(await services.logins.delete(request.params.id))) throw notFound("login");
      return reply.code(204).send(null);
    },
  );
}
