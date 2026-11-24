import type { Kysely } from "kysely";
import type { Clock } from "../clock.js";
import type { Database } from "../db/schema.js";
import type { Return, ReturnStatus } from "../domain/return.js";
import { loadReturns, localDay } from "./repository.js";

/** Which returns a list shows: those still going on, those finished, or all. */
export const RETURN_VIEWS = ["open", "closed", "all"] as const;
export type ReturnView = (typeof RETURN_VIEWS)[number];

const CLOSED: ReadonlySet<ReturnStatus> = new Set(["refunded", "rejected", "cancelled", "expired"]);

export function inReturnView(view: ReturnView, status: ReturnStatus): boolean {
  switch (view) {
    case "all":
      return true;
    case "open":
      return !CLOSED.has(status);
    case "closed":
      return CLOSED.has(status);
  }
}

/** Returns as their own resource; read-only, since connections are what change them. */
export class ReturnService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly clock: Clock,
    private readonly timeZone: string,
  ) {}

  /** The server's local day: what return-by dates are compared with. */
  today(): string {
    return localDay(this.clock.now(), this.timeZone);
  }

  async list(view: ReturnView): Promise<Return[]> {
    const all = await loadReturns(this.db, {}, this.today());
    return all.filter((entry) => inReturnView(view, entry.status));
  }

  async get(id: string): Promise<Return | undefined> {
    const [found] = await loadReturns(this.db, { ids: [id] }, this.today());
    return found;
  }

  async byOrders(orderIds: readonly string[]): Promise<Return[]> {
    return loadReturns(this.db, { orderIds }, this.today());
  }
}
