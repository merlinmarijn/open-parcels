import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { mockApi, renderApp, SIGNED_IN } from "../test/helpers";

// Made up for the test, built from parts so it never looks like a stored credential.
const OWNER_PASSWORD = ["correct", "horse", "battery"].join("-");

describe("first start and login", () => {
  it("sets the owner password with the setup code, then opens the app", async () => {
    let done = false;
    const calls = mockApi({
      "GET /api/v1/session": () => ({
        body: done
          ? SIGNED_IN
          : {
              authenticated: false,
              method: null,
              role: null,
              scopes: [],
              csrf_token: null,
              reader_required: true,
              setup_required: true,
            },
      }),
      "POST /api/v1/setup": () => {
        done = true;
        return { body: { csrf_token: "csrf-test-value" } };
      },
      "GET /api/v1/parcels": () => ({ body: [] }),
    });
    const user = userEvent.setup();
    renderApp();

    await user.type(await screen.findByLabelText("Setup code"), "ABCD-EFGH");
    await user.type(screen.getByLabelText("Admin password"), OWNER_PASSWORD);
    await user.type(screen.getByLabelText("Repeat the password"), OWNER_PASSWORD);
    await user.click(screen.getByRole("button", { name: /set password/i }));

    expect(await screen.findByRole("heading", { name: "Parcels" })).toBeInTheDocument();
    const setup = calls.find((call) => call.path === "/api/v1/setup");
    expect(setup?.body).toEqual({ setup_code: "ABCD-EFGH", password: OWNER_PASSWORD });
  });

  it("refuses mismatched passwords before calling the server", async () => {
    const calls = mockApi({
      "GET /api/v1/session": () => ({
        body: {
          authenticated: false,
          method: null,
          role: null,
          scopes: [],
          csrf_token: null,
          reader_required: true,
          setup_required: true,
        },
      }),
    });
    const user = userEvent.setup();
    renderApp();
    await user.type(await screen.findByLabelText("Setup code"), "ABCD");
    await user.type(screen.getByLabelText("Admin password"), OWNER_PASSWORD);
    await user.type(screen.getByLabelText("Repeat the password"), `${OWNER_PASSWORD}x`);
    await user.click(screen.getByRole("button", { name: /set password/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("do not match");
    expect(calls.some((call) => call.path === "/api/v1/setup")).toBe(false);
  });

  it("shows the server's message for a wrong password and logs in on the next try", async () => {
    let signedIn = false;
    mockApi({
      "GET /api/v1/session": () => ({
        body: signedIn
          ? SIGNED_IN
          : {
              authenticated: false,
              method: null,
              role: null,
              scopes: [],
              csrf_token: null,
              reader_required: true,
              setup_required: false,
            },
      }),
      "POST /api/v1/session": (request) => {
        const body = request.body as { password: string };
        if (body.password !== OWNER_PASSWORD) {
          return {
            status: 401,
            body: { error: "wrong_password", message: "That password is not correct." },
          };
        }
        signedIn = true;
        return { body: { csrf_token: "csrf-test-value" } };
      },
      "GET /api/v1/parcels": () => ({ body: [] }),
    });
    const user = userEvent.setup();
    renderApp();

    await user.type(await screen.findByLabelText("Password"), "wrong-one");
    await user.click(screen.getByRole("button", { name: "Log in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("not correct");

    await user.type(screen.getByLabelText("Password"), OWNER_PASSWORD);
    await user.click(screen.getByRole("button", { name: "Log in" }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Parcels" })).toBeInTheDocument();
    });
  });

  it("opens read only without a reader password, with a Log in for the admin", async () => {
    let admin = false;
    const ANONYMOUS = {
      authenticated: false,
      method: "anonymous",
      role: "reader",
      scopes: ["read"],
      csrf_token: null,
      reader_required: false,
      setup_required: false,
    };
    mockApi({
      "GET /api/v1/session": () => ({ body: admin ? SIGNED_IN : ANONYMOUS }),
      "POST /api/v1/session": () => {
        admin = true;
        return { body: { csrf_token: "csrf-test-value", role: "admin" } };
      },
      "GET /api/v1/parcels": () => ({ body: [] }),
    });
    const user = userEvent.setup();
    renderApp();

    expect(await screen.findByRole("heading", { name: "Parcels" })).toBeInTheDocument();
    expect(screen.getByText("Read only")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /API tokens/ })).not.toBeInTheDocument();
    // Readers are not offered what they cannot do (OP-147).
    expect(screen.queryByRole("button", { name: /Track a parcel/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Log in" }));
    await user.type(await screen.findByLabelText("Password"), OWNER_PASSWORD);
    await user.click(screen.getByRole("button", { name: "Log in" }));
    expect(await screen.findByText("Admin")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Track a parcel/ })).toBeInTheDocument();
  });

  it("shows the login page and none of the data after logging out (OP-144)", async () => {
    let signedIn = true;
    mockApi({
      "GET /api/v1/session": () => ({
        body: signedIn
          ? { ...SIGNED_IN, reader_required: true }
          : {
              authenticated: false,
              method: null,
              role: null,
              scopes: [],
              csrf_token: null,
              reader_required: true,
              setup_required: false,
            },
      }),
      "DELETE /api/v1/session": () => {
        signedIn = false;
        return { status: 204 };
      },
      "GET /api/v1/parcels": () =>
        signedIn
          ? { body: [] }
          : { status: 401, body: { error: "unauthorized", message: "Log in first." } },
    });
    const user = userEvent.setup();
    renderApp();

    expect(await screen.findByRole("heading", { name: "Parcels" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Log out" }));
    expect(await screen.findByLabelText("Password")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Parcels" })).not.toBeInTheDocument();
    expect(screen.queryByText("Admin")).not.toBeInTheDocument();
  });

  it("tells the admin once that reading is open, until dismissed", async () => {
    let dismissed = false;
    const calls = mockApi({
      "GET /api/v1/session": () => ({
        body: { ...SIGNED_IN, reader_password_notice: !dismissed },
      }),
      "POST /api/v1/session/reader-password-notice/dismiss": () => {
        dismissed = true;
        return { status: 204 };
      },
      "GET /api/v1/parcels": () => ({ body: [] }),
    });
    const user = userEvent.setup();
    renderApp();

    expect(await screen.findByText(/No reader password is set/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => {
      expect(screen.queryByText(/No reader password is set/)).not.toBeInTheDocument();
    });
    expect(
      calls.some((call) => call.path === "/api/v1/session/reader-password-notice/dismiss"),
    ).toBe(true);
  });

  it("needs no login under Home Assistant ingress", async () => {
    mockApi({
      "GET /api/v1/session": () => ({
        body: { ...SIGNED_IN, method: "ingress", csrf_token: null, setup_required: true },
      }),
      "GET /api/v1/parcels": () => ({ body: [] }),
    });
    renderApp();
    expect(await screen.findByRole("heading", { name: "Parcels" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Log out" })).not.toBeInTheDocument();
  });
});
