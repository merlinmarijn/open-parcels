import { z } from "zod";
import {
  asObject,
  defineCarrier,
  pastedRedirect,
  isObject,
  InvalidConfigError,
  objects,
  readObject,
  SignInRejectedError,
  text,
  TransientError,
  UnexpectedResponseError,
  type Json,
  type ParcelSnapshot,
  type ProviderContext,
} from "../../provider/api.js";
import { finishSignIn, LOGIN_HOST, PostnlSession, startSignIn } from "./auth.js";
import { CARRIER_ID, shipmentSnapshot } from "./parcel.js";
import { POSTNL_EMAIL_RULES } from "./email-rules.js";

const API_HOST = "jouw.postnl.nl";
const STRINGS = { numbers: false } as const;
/** At most this many track & trace calls per run; delivered parcels never need one. */
export const DETAIL_LIMIT = 25;

const SHIPMENTS_QUERY = `query {
  trackedShipments {
    receiverShipments { ...shipment }
    senderShipments { ...shipment }
  }
}
fragment shipment on TrackedShipmentResultType {
  key creationDateTime title barcode delivered deliveredTimeStamp deliveryWindowFrom
  deliveryWindowTo deliveryWindowType detailsUrl shipmentType receiverTitle deliveryAddressType
}`;

const configSchema = z.object({
  country: z.enum(["NL", "BE"]).optional().meta({ title: "Country" }),
  postalCode: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9 ]{3,10}$/)
    .optional()
    .meta({ title: "Postcode" }),
});
const secretSchema = z
  .object({ refreshToken: z.string().min(1).meta({ title: "Refresh token" }) })
  .nullable();
type Config = z.infer<typeof configSchema>;
type Secret = z.infer<typeof secretSchema>;

/** A signed-in request. PostNL refusing the token leads to one refresh, never more. */
async function signed(
  context: ProviderContext<Config, Secret>,
  session: PostnlSession,
  url: URL,
  body?: string,
) {
  const send = async (token: string) =>
    context.http.request(url, {
      method: body === undefined ? "GET" : "POST",
      redirect: "manual",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body }),
    });
  let response = await send(await session.accessToken());
  if (response.status === 401) {
    response = await send(await session.renew());
    if (response.status === 401) {
      throw new SignInRejectedError("PostNL refuses a freshly refreshed sign-in.");
    }
  }
  return response;
}

async function shipments(
  context: ProviderContext<Config, Secret>,
  session: PostnlSession,
): Promise<Json> {
  const url = new URL(`https://${API_HOST}/account/api/graphql`);
  const response = await signed(context, session, url, JSON.stringify({ query: SHIPMENTS_QUERY }));
  if (response.status !== 200) {
    throw new TransientError(`PostNL's account answered HTTP ${response.status}.`);
  }
  const payload = readObject(response, "PostNL's account");
  const tracked = asObject(payload["data"])["trackedShipments"];
  if (!isObject(tracked)) {
    throw new UnexpectedResponseError("PostNL's account answered without a shipment list.");
  }
  return tracked;
}

/** The colli for one shipment, or null when track & trace has none for its tracking number. */
async function colli(
  context: ProviderContext<Config, Secret>,
  session: PostnlSession,
  shipment: Json,
): Promise<Json | null> {
  const key = text(shipment["key"], STRINGS);
  const barcode = text(shipment["barcode"], STRINGS);
  if (key === null || barcode === null) {
    return null;
  }
  const url = new URL(
    `https://${API_HOST}/track-and-trace/api/trackAndTrace/${encodeURIComponent(key)}`,
  );
  url.searchParams.set("language", "nl");
  const response = await signed(context, session, url);
  if (response.status === 404) {
    return null;
  }
  if (response.status !== 200) {
    throw new TransientError(`PostNL track & trace answered HTTP ${response.status}.`);
  }
  const found = asObject(readObject(response, "PostNL track & trace")["colli"])[barcode];
  return isObject(found) ? found : null;
}

async function fetchAccount(context: ProviderContext<Config, Secret>) {
  if (context.secret === null) {
    throw new SignInRejectedError("Sign in to your PostNL account first.");
  }
  const session = new PostnlSession(context, context.secret.refreshToken);
  const tracked = await shipments(context, session);
  // A renamed key or an error object must stop the run, never read as an empty account.
  if (!Array.isArray(tracked["receiverShipments"]) && !Array.isArray(tracked["senderShipments"])) {
    throw new UnexpectedResponseError("PostNL answered without its shipment lists.");
  }
  const report = (kind: string, key: string): void => {
    context.reportUnknown(kind, key);
  };
  const snapshots: ParcelSnapshot[] = [];
  let details = 0;
  const lists = [
    ["receiverShipments", "receiving"],
    ["senderShipments", "sending"],
  ] as const;
  for (const [list, direction] of lists) {
    for (const shipment of objects(tracked[list])) {
      if (text(shipment["barcode"], STRINGS) === null) {
        continue;
      }
      const wantDetail = shipment["delivered"] !== true && details < DETAIL_LIMIT;
      details += wantDetail ? 1 : 0;
      const found = wantDetail ? await colli(context, session, shipment) : null;
      snapshots.push(shipmentSnapshot({ shipment, direction, colli: found }, report));
    }
  }
  return { snapshots, complete: true };
}

async function track(context: ProviderContext<Config, Secret>, barcodes: readonly string[]) {
  const postcode = context.config.postalCode?.replace(/\s+/g, "").toUpperCase();
  if (!postcode) {
    throw new InvalidConfigError("Set the delivery postcode to track PostNL parcels.");
  }
  const snapshots: ParcelSnapshot[] = [];
  for (const barcode of barcodes) {
    if (!/^[A-Z0-9]{8,40}$/.test(barcode)) {
      continue;
    }
    const key = `${barcode}-${context.config.country ?? "NL"}-${postcode}`;
    const url = new URL(
      `https://${API_HOST}/track-and-trace/api/trackAndTrace/${encodeURIComponent(key)}`,
    );
    url.searchParams.set("language", "nl");
    const response = await context.http.request(url, { headers: { accept: "application/json" } });
    if (response.status === 404) {
      continue;
    }
    if (response.status !== 200) {
      throw new TransientError(`PostNL track & trace answered HTTP ${response.status}.`);
    }
    const collis = readObject(response, "PostNL track & trace")["colli"];
    if (!isObject(collis)) {
      throw new UnexpectedResponseError("PostNL answered without its parcel list.");
    }
    const found = collis[barcode];
    if (!isObject(found)) {
      continue;
    }
    const shipment: Json = {
      barcode,
      key,
      detailsUrl: `https://${API_HOST}/track-and-trace/${encodeURIComponent(key)}?language=nl`,
      delivered: found["isDelivered"],
      deliveredTimeStamp: found["deliveryDate"],
      deliveryAddressType: found["deliveryAddressType"],
      title: asObject(asObject(found["sender"])["names"])["companyName"],
    };
    snapshots.push(
      shipmentSnapshot({ shipment, direction: "receiving", colli: found }, (kind, key) => {
        context.reportUnknown(kind, key);
      }),
    );
  }
  return { snapshots, complete: true };
}

/** PostNL: signed-in account sync and public barcode/postcode tracking. */
export const postnl = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  configSchema,
  secretSchema,
  emailRules: POSTNL_EMAIL_RULES,
  signIn: [
    pastedRedirect<Config, Secret>({
      kinds: ["account"],
      start: () => Promise.resolve(startSignIn()),
      finish: (context, state, pasted) => finishSignIn(context.http, state, pasted),
    }),
    { type: "none", kinds: ["tracking"] },
  ],
  http: {
    limits: {
      [API_HOST]: { intervalMs: 4_000, burst: 2 },
      [LOGIN_HOST]: { intervalMs: 30_000, burst: 2 },
      "*": { intervalMs: 10_000, burst: 1 },
    },
  },
  fetchAccount,
  track,
});
