import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Connection } from "../api/types";
import { ConnectionStateBadge } from "../parcels/badges";
import { mockApi, renderApp, SIGNED_IN } from "../test/helpers";

describe("a connection that ran but had nothing to do", () => {
  it("shows Idle from the server's idle state", () => {
    render(<ConnectionStateBadge state="idle" lastOkAt={null} />);
    expect(screen.getByText("Idle", { selector: ".badge" })).toBeInTheDocument();
  });

  it("does not guess Idle from the detail text of an OK connection", () => {
    render(<ConnectionStateBadge state="ok" lastOkAt="2026-11-01T10:00:00.000Z" />);
    expect(screen.getByText("OK", { selector: ".badge" })).toBeInTheDocument();
  });
});

describe("connections", () => {
  const disabled: Connection = {
    id: "s3",
    provider: "dhl",
    kind: "account",
    label: "DHL account",
    config: {},
    has_secret: false,
    state: "disabled",
    state_reason: null,
    carrier_message: null,
    next_run_at: null,
    last_run_at: null,
    last_ok_at: null,
  };

  it("offers neither Sync now nor Sign in on a disabled connection", async () => {
    mockApi({
      "GET /api/v1/session": () => ({ body: SIGNED_IN }),
      "GET /api/v1/connections": () => ({ body: [disabled] }),
      "GET /api/v1/carriers": () => ({ body: [] }),
    });
    renderApp("/connections");
    await screen.findByRole("heading", { name: "DHL account" });
    expect(screen.getByRole("button", { name: "Enable" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sync now" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Sign in/ })).not.toBeInTheDocument();
  });

  it("shows a connection that never had a successful run as not run yet, never OK", async () => {
    mockApi({
      "GET /api/v1/session": () => ({ body: SIGNED_IN }),
      "GET /api/v1/connections": () => ({
        body: [{ ...disabled, state: "ok", state_reason: "not_run_yet" }],
      }),
      "GET /api/v1/carriers": () => ({ body: [] }),
    });
    renderApp("/connections");
    await screen.findByRole("heading", { name: "DHL account" });
    expect(screen.getByText("Not run yet", { selector: ".badge" })).toBeInTheDocument();
    expect(
      screen.getByText("Not run yet.", { selector: ".connection-detail" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("OK", { selector: ".badge" })).not.toBeInTheDocument();
  });
});
