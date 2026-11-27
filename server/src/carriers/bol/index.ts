import { z } from "zod";
import {
  asObject,
  defineCarrier,
  objects,
  SignInRejectedError,
  text,
  TransientError,
  UnexpectedResponseError,
  type Json,
  type ProviderContext,
} from "../../provider/api.js";
import { pageData } from "./page.js";
import { orderItem, orderSnapshots } from "./parcel.js";

const HOST = "www.bol.com";
const OVERVIEW = "/nl/nl/account/bestellingen/overzicht/";
const configSchema = z.object({});
const secretSchema = z
  .object({
    cookie: z
      .string()
      .trim()
      .min(1)
      .max(32768)
      .regex(/^[^\r\n]+$/)
      .meta({ title: "Cookie header" }),
  })
  .nullable();
type Config = z.infer<typeof configSchema>;
type Secret = z.infer<typeof secretSchema>;

async function page(context: ProviderContext<Config, Secret>, path: string): Promise<string> {
  if (context.secret === null)
    throw new SignInRejectedError("Add your signed-in Bol browser session first.");
  const response = await context.http.request(new URL(path, `https://${HOST}`), {
    redirect: "manual",
    headers: { accept: "text/html", cookie: context.secret.cookie },
  });
  const location = response.headers.get("location");
  if (
    response.status === 401 ||
    (response.status >= 300 &&
      response.status < 400 &&
      location !== null &&
      /login|inloggen/.test(location))
  ) {
    throw new SignInRejectedError(
      "Bol's browser session expired; copy a new Cookie header after signing in.",
    );
  }
  if (response.status !== 200)
    throw new TransientError(`Bol's order page answered HTTP ${response.status}.`);
  return response.body;
}

export const bol = defineCarrier<Config, Secret>({
  id: "bol",
  configSchema,
  secretSchema,
  signIn: { type: "credentials", label: "Browser session" },
  http: { limits: { [HOST]: { intervalMs: 5_000, burst: 1 } } },
  async fetchAccount(context) {
    const overview = pageData(await page(context, OVERVIEW), "OrdersOverviewRoute");
    const customer = asObject(overview["identifiedCustomer"]);
    if (!Array.isArray(customer["orders"]))
      throw new UnexpectedResponseError("Bol answered without its order list.");
    const paths = new Map<string, Json>();
    for (const order of objects(customer["orders"])) {
      for (const item of objects(order["items"])) {
        const path = text(item["url"]);
        if (
          path === null ||
          !/^\/nl\/nl\/account\/bestellingen\/details\/[A-Z0-9]+\/(?:\?order_item_id=\d+)?$/i.test(
            path,
          )
        ) {
          throw new UnexpectedResponseError("Bol answered with an unfamiliar order address.");
        }
        paths.set(path, order);
      }
    }
    // ponytail: Discover the first five orders, at most 25 details per poll; add paged import for older history.
    const snapshots = [];
    for (const [path, order] of [...paths].slice(0, 25)) {
      const data = pageData(await page(context, path), "OrderDetailsRoute");
      if (
        !Array.isArray(data["shopOrderItems"]) ||
        text(data["orderReference"]) === null ||
        data["orderReference"] !== order["reference"]
      ) {
        throw new UnexpectedResponseError("Bol answered without its order details.");
      }
      snapshots.push(...orderSnapshots(data, objects(order["items"]).map(orderItem)));
    }
    return { snapshots, complete: false };
  },
});
