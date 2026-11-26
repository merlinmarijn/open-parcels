import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { createQueryClient } from "../api/client";
import { connection, mockApi } from "../test/helpers";
import { ConnectionDialog } from "./ConnectionDialog";

it("creates an inbox with credentials separate from its public config", async () => {
  const created = connection({ provider: "imap", kind: "mail", has_secret: true });
  const calls = mockApi({
    "GET /api/v1/carriers": () => ({ body: [] }),
    "GET /api/v1/inbox-form": () => ({
      body: {
        provider: "imap",
        config_schema: {
          type: "object",
          properties: { host: { type: "string", title: "IMAP server" } },
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
      },
    }),
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
  await user.click(screen.getByRole("button", { name: "Add connection" }));
  await waitFor(() => {
    expect(onCreated).toHaveBeenCalled();
  });
  expect(onCreated.mock.calls[0]?.[0]).toEqual(created);
  expect(calls.find((call) => call.method === "POST")?.body).toEqual({
    provider: "imap",
    kind: "mail",
    label: "Inbox",
    config: { host: "imap.example.org" },
    secret: { username: "test@example.org", password: "invented-test-password" },
  });
});
