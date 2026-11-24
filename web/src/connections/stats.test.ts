import { describe, expect, it } from "vitest";
import type { Parcel } from "../api/types";
import { parcel as made } from "../test/helpers";
import { statsByConnection } from "./ConnectionsPage";

function parcel(connections: string[], delivered: boolean, archived = false): Parcel {
  return made({
    connections: connections.map((connection_id) => ({
      connection_id,
      provider: "fakepost",
      label: "Test",
      kind: "account",
      role: "primary",
      last_seen_at: "2026-01-01T00:00:00Z",
    })),
    delivered,
    archived_at: archived ? "2026-01-01T00:00:00Z" : null,
  });
}

describe("parcels per connection", () => {
  it("counts each parcel once per connection: on the way, delivered and all", () => {
    const stats = statsByConnection([
      parcel(["a", "a"], false),
      parcel(["a", "b"], true),
      parcel(["b"], false, true),
    ]);
    expect(stats.get("a")).toEqual({ active: 1, delivered: 1, total: 2 });
    expect(stats.get("b")).toEqual({ active: 0, delivered: 1, total: 2 });
    expect(stats.get("c")).toBeUndefined();
  });
});
