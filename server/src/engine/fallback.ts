import type { Kysely } from "kysely";
import { isoNow, type Clock } from "../clock.js";
import type { Database } from "../db/schema.js";
import type { ProviderRegistry } from "./registry.js";

/** How long a parcel's carrier (or a fallback before) has to not find it before the next is asked. */
export const FALLBACK_AFTER_MS = 24 * 60 * 60 * 1000;

/** Fallback providers in the order they are asked: the user's own service first, then 17TRACK. */
const ORDER = ["universal_lookup", "17track"];

function rank(provider: string): number {
  const index = ORDER.indexOf(provider);
  return index === -1 ? ORDER.length : index;
}

/** Provider ids of the installed fallback tracking services. */
export function fallbackProviders(registry: ProviderRegistry): string[] {
  return registry
    .list()
    .filter((provider) => provider.info.fallback)
    .map((provider) => provider.info.id);
}

/** The user's fallback tracking connections that are not disabled, in the order they are asked. */
async function fallbackConnections(
  db: Kysely<Database>,
  registry: ProviderRegistry,
): Promise<{ id: string; provider: string }[]> {
  const providers = fallbackProviders(registry);
  if (providers.length === 0) return [];
  const rows = await db
    .selectFrom("connections")
    .select(["id", "provider", "created_at"])
    .where("kind", "=", "tracking")
    .where("provider", "in", providers)
    .where("state", "!=", "disabled")
    .execute();
  return rows
    .sort((a, b) => rank(a.provider) - rank(b.provider) || a.created_at.localeCompare(b.created_at))
    .map(({ id, provider }) => ({ id, provider }));
}

/**
 * The carrier a parcel no built-in carrier recognises is filed under: the first fallback service
 * the user added, or undefined when there is none.
 */
export async function fallbackCarrier(
  db: Kysely<Database>,
  registry: ProviderRegistry,
): Promise<string | undefined> {
  return (await fallbackConnections(db, registry))[0]?.provider;
}

/**
 * Hands parcels to the fallback services, one at a time: an active parcel no connection follows
 * (no built-in carrier can track it, or its provider needs settings), or one its carrier has not
 * found for {@link FALLBACK_AFTER_MS}, is linked to the first fallback connection it is not linked
 * to yet; when that one has not found it for as long either, to the next. Never more than one
 * service at a time is added, so a paid service is only asked when the free ones failed. Linked
 * connections are made due at once. Returns how many parcels were linked.
 */
export async function linkFallbacks(
  db: Kysely<Database>,
  registry: ProviderRegistry,
  clock: Clock,
): Promise<number> {
  const fallbacks = await fallbackConnections(db, registry);
  if (fallbacks.length === 0) return 0;
  const now = isoNow(clock);
  const cutoff = new Date(clock.now().getTime() - FALLBACK_AFTER_MS).toISOString();
  const candidates = await db
    .selectFrom("parcels")
    .select("parcels.id")
    .where("parcels.delivered", "=", 0)
    .where("parcels.archived_at", "is", null)
    .where("parcels.removed_at", "is", null)
    .where((eb) =>
      eb.or([
        eb("parcels.manual_status", "is", null),
        eb("parcels.manual_status", "!=", "delivered"),
      ]),
    )
    .where((eb) =>
      eb.or([
        eb.not(
          eb.exists(
            eb
              .selectFrom("parcel_connections as followed")
              .select("followed.parcel_id")
              .whereRef("followed.parcel_id", "=", "parcels.id")
              .where("followed.role", "in", ["primary", "handoff"]),
          ),
        ),
        eb.and([
          eb("parcels.lookup_state", "=", "not_found"),
          eb("parcels.lookup_since", "<=", cutoff),
        ]),
      ]),
    )
    .execute();
  if (candidates.length === 0) return 0;
  const links = await db
    .selectFrom("parcel_connections")
    .select(["parcel_id", "connection_id", "last_seen_at"])
    .where(
      "parcel_id",
      "in",
      candidates.map((row) => row.id),
    )
    .where(
      "connection_id",
      "in",
      fallbacks.map((row) => row.id),
    )
    .execute();
  const touched = new Set<string>();
  let linked = 0;
  for (const { id } of candidates) {
    const own = links.filter((link) => link.parcel_id === id);
    // The service asked last has had its day: only then is the next one asked.
    if (own.some((link) => link.last_seen_at > cutoff)) continue;
    const next = fallbacks.find(
      (fallback) => !own.some((link) => link.connection_id === fallback.id),
    );
    if (next === undefined) continue;
    await db
      .insertInto("parcel_connections")
      .values({
        parcel_id: id,
        connection_id: next.id,
        external_ref: null,
        role: "primary",
        last_seen_at: now,
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
    touched.add(next.id);
    linked += 1;
  }
  if (touched.size > 0) {
    await db
      .updateTable("connections")
      .set({ next_run_at: now })
      .where("id", "in", [...touched])
      .execute();
  }
  return linked;
}
