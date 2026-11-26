/**
 * Errors a carrier provider throws to tell the scheduler what happened. Anything else counts as a
 * transient failure. The distinction matters: only `SignInRejectedError` may lead to a new
 * sign-in, and only once; a network error never does.
 */

export class ProviderError extends Error {
  override readonly name: string = "ProviderError";
}

/** The carrier refused the stored credentials or session. The connection needs the user to sign in again. */
export class SignInRejectedError extends ProviderError {
  override readonly name = "SignInRejectedError";
}

/** The carrier asked us to slow down (HTTP 429, or 503 with Retry-After). */
export class RateLimitedError extends ProviderError {
  override readonly name = "RateLimitedError";

  constructor(
    message: string,
    /** Seconds the carrier asked us to wait, when it said so. */
    readonly retryAfterSeconds: number | undefined,
  ) {
    super(message);
  }
}

/** The carrier put a captcha in front of us. We never try to solve it; we pause the connection instead. */
export class CaptchaError extends ProviderError {
  override readonly name = "CaptchaError";
}

/**
 * The connection's settings cannot work (a required postcode is missing, say). Nothing is retried
 * until the user changes them; the connection shows the message.
 */
export class InvalidConfigError extends ProviderError {
  override readonly name = "InvalidConfigError";
}

/** A temporary failure: network error, timeout, 5xx, unexpected page. Retried with backoff. */
export class TransientError extends ProviderError {
  override readonly name: string = "TransientError";
}

/** A request got no answer within its timeout. Transient; a provider may treat a hang specially. */
export class RequestTimeoutError extends TransientError {
  override readonly name = "RequestTimeoutError";
}

/** The response did not have the shape we expect. Logged with keys only, never values. */
export class UnexpectedResponseError extends TransientError {
  override readonly name = "UnexpectedResponseError";
}
