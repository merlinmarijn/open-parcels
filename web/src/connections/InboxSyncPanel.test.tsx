import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { InboxSync } from "../api/types";
import { connection, mockApi, renderApp, SIGNED_IN } from "../test/helpers";

const inbox = connection({ provider: "imap", kind: "mail", label: "Test inbox", has_secret: true });

const reading: InboxSync = {
  connection_id: inbox.id,
  phase: "reading",
  folder: "INBOX",
  done: 120,
  total: 480,
  read: 120,
  parcels: 3,
  orders: 2,
  returns: 0,
  ignored: 115,
  started_at: "2026-11-18T12:00:00.000Z",
  finished_at: null,
  error: null,
  steps: [
    { at: "2026-11-18T12:00:00.000Z", phase: "connecting", folder: null, count: null },
    { at: "2026-11-18T12:00:01.000Z", phase: "searching", folder: "INBOX", count: null },
    { at: "2026-11-18T12:00:02.000Z", phase: "reading", folder: "INBOX", count: 480 },
  ],
};

describe("an inbox's sync panel", () => {
  it("shows a running sync live and folds a finished one after Sync now", async () => {
    let sync: InboxSync = reading;
    const calls = mockApi({
      "GET /api/v1/session": () => ({ body: SIGNED_IN }),
      "GET /api/v1/connections": () => ({ body: [inbox] }),
      "GET /api/v1/carriers": () => ({ body: [] }),
      [`GET /api/v1/connections/${inbox.id}/sync`]: () => ({ body: sync }),
      [`POST /api/v1/connections/${inbox.id}/sync`]: () => ({ status: 202, body: null }),
    });
    renderApp("/connections");
    expect(await screen.findByText("Reading 120 of 480 in INBOX")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("value", "120");
    expect(screen.getByText(/Found 3 parcels, 2 orders, 0 returns · 115/)).toBeInTheDocument();
    expect(screen.getByText("480 mails to read in INBOX", { exact: false })).toBeInTheDocument();

    sync = {
      ...reading,
      phase: "done",
      folder: null,
      done: 0,
      total: null,
      read: 480,
      parcels: 12,
      finished_at: new Date().toISOString(),
    };
    await userEvent.setup().click(screen.getByRole("button", { name: "Sync now" }));
    expect(
      await screen.findByText("Last sync: just now, 480 mails, 12 parcels"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(calls.map((call) => `${call.method} ${call.path}`)).toContain(
        `POST /api/v1/connections/${inbox.id}/sync`,
      );
    });
  });

  it("names why a sync failed", async () => {
    mockApi({
      "GET /api/v1/session": () => ({ body: SIGNED_IN }),
      "GET /api/v1/connections": () => ({ body: [inbox] }),
      "GET /api/v1/carriers": () => ({ body: [] }),
      [`GET /api/v1/connections/${inbox.id}/sync`]: () => ({
        body: { ...reading, phase: "failed", error: "sign_in_rejected" },
      }),
    });
    renderApp("/connections");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The mail server rejected the sign-in.",
    );
  });
});
