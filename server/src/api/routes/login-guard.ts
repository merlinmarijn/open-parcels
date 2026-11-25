import type { FastifyReply, FastifyRequest } from "fastify";
import type { LoginThrottle } from "../../auth/throttle.js";
import type { Services } from "../../services.js";
import { ApiError } from "../errors.js";

/**
 * Behind a reverse proxy that is not in OPENPARCELS_TRUST_PROXY every visitor shares the proxy's
 * address, so one person's wrong passwords block everyone's login. Said once in the log.
 */
export function proxyWarning(services: Services): (request: FastifyRequest) => void {
  let warned = false;
  return (request) => {
    if (warned || request.headers["x-forwarded-for"] === undefined) return;
    if (request.ip !== request.socket.remoteAddress) return;
    warned = true;
    services.logger.warn(
      "Logins arrive through a proxy that OPENPARCELS_TRUST_PROXY does not list: every visitor shares its address for the login throttle. Add the proxy's address to OPENPARCELS_TRUST_PROXY.",
    );
  };
}

/** Throws 429 while the caller's address has too many recent failures. */
export function checkThrottle(
  throttle: LoginThrottle,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const wait = throttle.retryAfterSeconds(request.ip);
  if (wait > 0) {
    void reply.header("retry-after", String(wait));
    throw new ApiError(
      429,
      "too_many_attempts",
      `Too many failed attempts. Try again in ${wait} seconds.`,
      { seconds: wait },
    );
  }
}
