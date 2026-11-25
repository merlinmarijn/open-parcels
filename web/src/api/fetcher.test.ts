import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { basePath } from "../router";
import { ApiError, apiFetch, apiUrl, setCsrfToken } from "./fetcher";

const INGRESS = "/api/hassio_ingress/abc/";

describe("addresses under a Home Assistant ingress prefix (OP-071)", () => {
  let base: HTMLBaseElement;
  beforeEach(() => {
    base = document.createElement("base");
    base.href = INGRESS;
    document.head.append(base);
  });
  afterEach(() => {
    base.remove();
  });

  it("resolve API paths below the prefix, with or without a leading slash", () => {
    const origin = window.location.origin;
    expect(apiUrl("/api/v1/parcels")).toBe(`${origin}${INGRESS}api/v1/parcels`);
    expect(apiUrl("api/v1/parcels?limit=5")).toBe(`${origin}${INGRESS}api/v1/parcels?limit=5`);
    expect(apiUrl("//api/v1/events")).toBe(`${origin}${INGRESS}api/v1/events`);
  });

  it("give the router the prefix without its trailing slash", () => {
    expect(basePath()).toBe("/api/hassio_ingress/abc");
  });

  it("fall back to the root without a prefix", () => {
    base.remove();
    expect(basePath()).toBe("/");
    expect(apiUrl("/api/v1/parcels")).toBe(`${window.location.origin}/api/v1/parcels`);
  });
});

describe("apiFetch (OP-071)", () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    setCsrfToken("csrf-1");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setCsrfToken(null);
  });

  const sent = (): { init: RequestInit; headers: Headers } => {
    const [, init = {}] = fetchMock.mock.calls.at(-1) ?? [];
    return { init, headers: new Headers(init.headers) };
  };

  it("sends the CSRF header on writes only, and the session cookie always", async () => {
    fetchMock.mockResolvedValue(Response.json({ ok: true }));
    expect(await apiFetch("/api/v1/parcels")).toEqual({ ok: true });
    expect(sent().headers.has("x-csrf-token")).toBe(false);
    expect(sent().init.credentials).toBe("same-origin");

    fetchMock.mockResolvedValue(Response.json({ ok: true }));
    await apiFetch("/api/v1/parcels", { method: "post", body: "{}" });
    expect(sent().init.method).toBe("POST");
    expect(sent().headers.get("x-csrf-token")).toBe("csrf-1");

    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await apiFetch("/api/v1/parcels/p1", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
    });
    expect(sent().headers.get("x-csrf-token")).toBe("csrf-1");
    // No body, so no content type: Fastify refuses an empty JSON body.
    expect(sent().headers.has("content-type")).toBe(false);
  });

  it("answers a 204 or an empty body with null", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    expect(await apiFetch("/api/v1/session", { method: "DELETE" })).toBeNull();
    fetchMock.mockResolvedValue(new Response("", { status: 200 }));
    expect(await apiFetch("/api/v1/health/live")).toBeNull();
  });

  it("turns a JSON error into an ApiError with its code, message and wait", async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        { error: "connection_backing_off", message: "Wait a bit.", params: { seconds: 30 } },
        { status: 429, headers: { "retry-after": "30" } },
      ),
    );
    const error = await apiFetch("/api/v1/connections/c1/sync", { method: "POST" }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 429,
      code: "connection_backing_off",
      message: "Wait a bit.",
      retryAfterSeconds: 30,
      params: { seconds: 30 },
    });
  });

  it("turns a non-JSON error page (a proxy's) into an ApiError naming the status", async () => {
    fetchMock.mockResolvedValue(
      new Response("<html>Bad gateway</html>", {
        status: 502,
        statusText: "Bad Gateway",
        headers: { "content-type": "text/html" },
      }),
    );
    await expect(apiFetch("/api/v1/parcels")).rejects.toMatchObject({
      status: 502,
      code: "http_502",
      message: "The server answered 502 Bad Gateway.",
      retryAfterSeconds: null,
      params: {},
    });
  });
});
