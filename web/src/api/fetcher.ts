/**
 * The one place the UI talks HTTP. Every generated call goes through `apiFetch`, which:
 * - resolves `/api/...` against the document base, so the UI works under an ingress prefix;
 * - sends the session cookie and, on state-changing requests, the CSRF header;
 * - turns error bodies into `ApiError`.
 * Nothing here logs or stores request bodies: they can carry passwords and codes.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

let csrfToken: string | null = null;

/** Kept in memory only; a reload asks `GET /session` again. */
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

/** Values the server sends for the code's text (`errors.ts` in each dictionary). */
export type ErrorParams = Readonly<Record<string, string | number>>;

export class ApiError extends Error {
  override readonly name = "ApiError";

  constructor(
    readonly status: number,
    /** The server's error code, or `http_<status>` when the answer had none (a proxy's page). */
    readonly code: string,
    /** The server's English explanation; the UI shows its own text for the code. */
    message: string,
    readonly retryAfterSeconds: number | null = null,
    readonly params: ErrorParams = {},
  ) {
    super(message);
  }
}

/** Turns an absolute API path into one relative to `<base href>`. */
export function apiUrl(path: string): string {
  const relative = path.replace(/^\/+/, "");
  return new URL(relative, document.baseURI).toString();
}

interface ErrorBody {
  readonly error?: unknown;
  readonly message?: unknown;
  readonly params?: unknown;
}

function readParams(value: unknown): ErrorParams {
  if (typeof value !== "object" || value === null) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string | number] =>
        typeof entry[1] === "string" || typeof entry[1] === "number",
    ),
  );
}

async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return null;
  }
  const text = await response.text();
  if (text === "") {
    return null;
  }
  const type = response.headers.get("content-type") ?? "";
  return type.includes("json") ? (JSON.parse(text) as unknown) : text;
}

/** Retry-After in seconds, given as seconds or as an HTTP date (a proxy may send one; OP-041). */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (value === null) return null;
  const text = value.trim();
  if (/^\d+$/u.test(text)) {
    const seconds = Number(text);
    return seconds > 0 ? seconds : null;
  }
  const at = Date.parse(text);
  if (Number.isNaN(at)) return null;
  const seconds = Math.ceil((at - now) / 1000);
  return seconds > 0 ? seconds : null;
}

function toApiError(response: Response, body: unknown): ApiError {
  const parsed: ErrorBody = typeof body === "object" && body !== null ? body : {};
  const code = typeof parsed.error === "string" ? parsed.error : `http_${response.status}`;
  const message =
    typeof parsed.message === "string"
      ? parsed.message
      : `The server answered ${response.status} ${response.statusText}.`;
  return new ApiError(
    response.status,
    code,
    message,
    parseRetryAfter(response.headers.get("retry-after")),
    readParams(parsed.params),
  );
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (!SAFE_METHODS.has(method) && csrfToken !== null) {
    headers.set("x-csrf-token", csrfToken);
  }
  if (init.body === undefined || init.body === null) {
    headers.delete("content-type");
  }
  const response = await fetch(apiUrl(path), {
    ...init,
    method,
    headers,
    credentials: "same-origin",
  });
  const body = await readBody(response);
  if (!response.ok) {
    throw toApiError(response, body);
  }
  return body as T;
}
