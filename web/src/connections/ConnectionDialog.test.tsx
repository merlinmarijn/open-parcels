import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { createQueryClient } from "../api/client";
import { connection, mockApi } from "../test/helpers";
import { ConnectionDialog } from "./ConnectionDialog";

const inboxForm = {
  provider: "imap",
  config_schema: {
    type: "object",
    properties: {
      host: { type: "string", title: "IMAP server" },
      folders: { type: "array", items: { type: "string" }, default: ["INBOX"] },
    },
    required: ["host"],
  },
  secret_schema: {
    type: "object",
    properties: {
      username: { type: "string", title: "Username" },
      password: { type: "string", title: "Password" },
    },
    required: ["username", "password"],
  },
};

it("creates an inbox with credentials separate from its public config", async () => {
  const created = connection({ provider: "imap", kind: "mail", has_secret: true });
  const calls = mockApi({
    "GET /api/v1/carriers": () => ({ body: [] }),
    "GET /api/v1/inbox-form": () => ({
      body: inboxForm,
    }),
    "POST /api/v1/inbox-folders": () => ({ body: ["INBOX", "Orders/届いた", "Archive"] }),
    "POST /api/v1/connections": () => ({ body: created }),
  });
  const onCreated = vi.fn();
  render(
    <QueryClientProvider client={createQueryClient()}>
      <ConnectionDialog open editing={null} onClose={vi.fn()} onCreated={onCreated} />
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /Inbox \(IMAP\)/u }));
  await user.type(await screen.findByLabelText(/IMAP server/u), "imap.example.org");
  const username = screen.getByLabelText(/Username/u);
  const password = screen.getByLabelText(/Password/u);
  expect(username).toBeRequired();
  expect(password).toBeRequired();
  expect(password).toHaveAttribute("type", "password");
  await user.type(username, "test@example.org");
  await user.type(password, "invented-test-password");
  await user.click(screen.getByRole("button", { name: "Detect folders" }));
  expect(await screen.findByRole("checkbox", { name: "INBOX" })).toBeChecked();
  await screen.findByRole("checkbox", { name: "Archive" });
  await user.click(screen.getByRole("checkbox", { name: "Select all" }));
  expect(screen.getByRole("checkbox", { name: "Orders/届いた" })).toBeChecked();
  await user.click(screen.getByRole("checkbox", { name: "Archive" }));
  expect(screen.getByRole("checkbox", { name: "Select all" })).not.toBeChecked();
  await user.click(screen.getByRole("button", { name: "Add connection" }));
  await waitFor(() => {
    expect(onCreated).toHaveBeenCalled();
  });
  expect(onCreated.mock.calls[0]?.[0]).toEqual(created);
  expect(
    calls.find((call) => call.path === "/api/v1/connections" && call.method === "POST")?.body,
  ).toEqual({
    provider: "imap",
    kind: "mail",
    label: "Inbox",
    config: { host: "imap.example.org", folders: ["INBOX", "Orders/届いた"] },
    secret: { username: "test@example.org", password: "invented-test-password" },
  });
});

it("discovers and saves folders on an existing inbox without asking for its password", async () => {
  const editing = connection({
    provider: "imap",
    kind: "mail",
    has_secret: true,
    config: { host: "imap.example.org", folders: ["INBOX"] },
  });
  let fail = true;
  const calls = mockApi({
    "GET /api/v1/carriers": () => ({ body: [] }),
    "GET /api/v1/inbox-form": () => ({ body: inboxForm }),
    "POST /api/v1/inbox-folders": () =>
      fail
        ? { status: 400, body: { error: "folder_discovery_failed" } }
        : { body: ["INBOX", "Archive"] },
    [`PATCH /api/v1/connections/${editing.id}`]: () => ({ body: editing }),
  });
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={createQueryClient()}>
      <ConnectionDialog open editing={editing} onClose={onClose} onCreated={vi.fn()} />
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await screen.findByLabelText(/IMAP server/u);
  expect(screen.queryByLabelText(/Password/u)).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Detect folders" }));
  await screen.findByText(/Could not list IMAP folders/u);
  expect(screen.getByRole("checkbox", { name: "INBOX" })).toBeChecked();
  fail = false;
  await user.click(screen.getByRole("button", { name: "Detect folders" }));
  await screen.findByRole("checkbox", { name: "Archive" });
  await user.click(screen.getByRole("checkbox", { name: "Select all" }));
  await user.click(screen.getByRole("checkbox", { name: "Select all" }));
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  await user.click(screen.getByRole("checkbox", { name: "Archive" }));
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => {
    expect(onClose).toHaveBeenCalled();
  });
  expect(calls.find((call) => call.path === "/api/v1/inbox-folders")?.body).toEqual({
    config: { host: "imap.example.org", folders: ["INBOX"] },
    connection_id: editing.id,
  });
  expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({
    label: editing.label,
    config: { host: "imap.example.org", folders: ["Archive"] },
  });
});
