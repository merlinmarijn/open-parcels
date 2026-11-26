import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockApi, renderApp, SIGNED_IN } from "../test/helpers";

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("session", () => {
  it("retries a failed session read with backoff, then offers Try again (OP-073)", async () => {
    let up = false;
    const calls = mockApi({
      "GET /api/v1/session": () =>
        up
          ? { body: SIGNED_IN }
          : { status: 503, body: { error: "unavailable", message: "Restarting." } },
      "GET /api/v1/parcels": () => ({ body: [] }),
      "GET /api/v1/carriers": () => ({ body: [] }),
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderApp();
    const reads = () => calls.filter((call) => call.path === "/api/v1/session").length;
    // Waits of 1, 2, 4, 8 and 16 seconds: five retries after the first read.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reads()).toBeLessThan(6);
    await vi.advanceTimersByTimeAsync(25_000);
    const again = await screen.findByRole("button", { name: "Try again" });
    expect(reads()).toBe(6);

    up = true;
    await user.click(again);
    expect(await screen.findByText("No parcels on the way.")).toBeInTheDocument();
  });
});
