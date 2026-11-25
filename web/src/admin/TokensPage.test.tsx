import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { mockApi, renderApp, SIGNED_IN } from "../test/helpers";

describe("API tokens", () => {
  const token = {
    id: "00000000-0000-4000-8000-0000000000c1",
    name: "Made-up client",
    scopes: ["read"],
    created_at: "2026-11-18T09:00:00.000Z",
    expires_at: null,
  };

  it("re-reads 'last used' when the window regains focus and shows it", async () => {
    let used: string | null = null;
    const calls = mockApi({
      "GET /api/v1/session": () => ({ body: SIGNED_IN }),
      "GET /api/v1/tokens": () => ({ body: [{ ...token, last_used_at: used }] }),
    });
    renderApp("/tokens");
    const row = (await screen.findByText("Made-up client")).closest("tr");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText("never")).toBeInTheDocument();
    const before = calls.filter((call) => call.path === "/api/v1/tokens").length;

    used = new Date(Date.now() - 60_000).toISOString();
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => {
      expect(calls.filter((call) => call.path === "/api/v1/tokens").length).toBeGreaterThan(before);
    });
    const updated = (await screen.findByText("Made-up client")).closest("tr") as HTMLElement;
    await waitFor(() => {
      expect(within(updated).queryByText("never")).not.toBeInTheDocument();
    });
    expect(within(updated).getByText("1 minute ago")).toBeInTheDocument();
  });

  it("says whether Copy worked, and selects the token where the clipboard is missing (OP-146)", async () => {
    mockApi({
      "GET /api/v1/session": () => ({ body: SIGNED_IN }),
      "GET /api/v1/tokens": () => ({ body: [] }),
      "POST /api/v1/tokens": () => ({
        status: 201,
        body: { ...token, last_used_at: null, token: "opt_made_up_value" },
      }),
    });
    // Plain HTTP on the LAN: no secure context, so no clipboard.
    Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
    const user = userEvent.setup();
    renderApp("/tokens");
    await user.type(await screen.findByLabelText("Name"), "Made-up client");
    await user.click(screen.getByRole("button", { name: "Create token" }));
    await user.click(await screen.findByRole("button", { name: "Copy" }));
    expect(await screen.findByText(/copy it by hand/)).toBeInTheDocument();
    expect(window.getSelection()?.toString()).toBe("opt_made_up_value");
    Reflect.deleteProperty(window, "isSecureContext");
  });
});
