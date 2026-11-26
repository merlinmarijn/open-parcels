import { z } from "zod";
import type { HopRequest, HopResponse, HopTransport } from "../provider/http.js";
import type { Broker } from "./child.js";
import type { Capability } from "./host.js";

/**
 * HTTP across the sandbox boundary (`docs/provider-manifest-and-sandbox.md` §2). The guest keeps
 * the client (redirects, cookie jar, decoding) and sends every single hop as an `http` capability
 * request; the core answers it with its own transport, which holds the hop to the manifest's
 * hosts, refuses non-public addresses, paces per host and caps the body. The child never holds a
 * socket.
 */

/** A hop as it crosses the boundary: plain data only. */
const wireHop = z.strictObject({
  url: z.url({ protocol: /^https?$/ }),
  method: z.string().regex(/^[A-Z]{3,7}$/),
  headers: z.record(z.string(), z.string()),
  body: z.union([z.null(), z.string(), z.strictObject({ form: z.string() })]),
  timeoutMs: z.number().int().positive().max(120_000).optional(),
  maxBytes: z
    .number()
    .int()
    .positive()
    .max(16 * 1024 * 1024)
    .optional(),
});
type WireHop = z.infer<typeof wireHop>;

interface WireResponse {
  readonly status: number;
  /** In order, `set-cookie` once per cookie. */
  readonly headers: readonly (readonly [string, string])[];
  readonly body: Uint8Array;
}

/** The core's side: the `http` capability for one call, answered by `transport`. */
export function httpCapability(transport: HopTransport): Capability {
  return async (args) => {
    const hop = wireHop.parse(args);
    const response = await transport({
      url: new URL(hop.url),
      method: hop.method,
      headers: hop.headers,
      body:
        hop.body === null
          ? undefined
          : typeof hop.body === "string"
            ? hop.body
            : new URLSearchParams(hop.body.form),
      ...(hop.timeoutMs === undefined ? {} : { timeoutMs: hop.timeoutMs }),
      ...(hop.maxBytes === undefined ? {} : { maxBytes: hop.maxBytes }),
    });
    const wire: WireResponse = {
      status: response.status,
      headers: [...response.headers],
      body: new Uint8Array(response.body),
    };
    return wire;
  };
}

/** The guest's side: a transport that sends each hop to the core through `broker`. */
export function brokeredTransport(broker: Broker): HopTransport {
  return async (request: HopRequest): Promise<HopResponse> => {
    const hop: WireHop = {
      url: request.url.toString(),
      method: request.method,
      headers: { ...request.headers },
      body:
        request.body === undefined
          ? null
          : typeof request.body === "string"
            ? request.body
            : { form: request.body.toString() },
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      ...(request.maxBytes === undefined ? {} : { maxBytes: request.maxBytes }),
    };
    const answer = (await broker.request("http", hop)) as WireResponse;
    return {
      status: answer.status,
      headers: new Headers(answer.headers.map(([name, value]) => [name, value])),
      body: Buffer.from(answer.body),
    };
  };
}
