import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { mockApi, renderApp, SIGNED_IN } from "../test/helpers";

describe("calendar page", () => {
  it("asks once, for the range it shows, also for a day in another month (OP-153)", async () => {
    const calls = mockApi({
      "GET /api/v1/session": () => ({ body: SIGNED_IN }),
      "GET /api/v1/calendar": () => ({ body: [] }),
      "GET /api/v1/carriers": () => ({ body: [] }),
    });
    renderApp("/calendar?date=2025-03-15");
    const reads = () => calls.filter((call) => call.path === "/api/v1/calendar");
    await waitFor(() => {
      expect(reads()).toHaveLength(1);
    });
    expect(await screen.findByText(/March 2025/)).toBeInTheDocument();
    const [read] = reads();
    expect(read?.query.get("from")?.slice(0, 10) ?? "").toMatch(/^2025-0[23]-/);
    expect(read?.query.get("to")?.slice(0, 10) ?? "").toMatch(/^2025-04-/);
    expect(reads()).toHaveLength(1);
  });
});
