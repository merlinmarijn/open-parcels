import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockApi, renderApp, SIGNED_IN } from "../test/helpers";
import { fromText, type ServerSetting } from "./server-settings";

// Leaflet needs a real browser; the home card's map is not what these tests are about.
vi.mock("../map/SharedMap", () => ({ SharedMap: () => null }));

/** A made-up server setting; every value is invented. */
function setting(overrides: Partial<ServerSetting> = {}): ServerSetting {
  return {
    key: "OPENPARCELS_ARCHIVE_DAYS",
    group: "retention",
    description: "Days after delivery before a parcel is archived.",
    kind: "number",
    choices: null,
    apply: "live",
    secret: false,
    source: "default",
    set: true,
    value: 30,
    default: 30,
    pending_restart: false,
    ...overrides,
  };
}

const SECRET = setting({
  key: "OPENPARCELS_SECRET_KEY",
  group: "storage",
  description: "Encrypts stored credentials.",
  kind: "string",
  apply: "env",
  secret: true,
  source: "env",
  value: null,
  default: null,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("settings page", () => {
  it("groups server settings into cards, saves and resets one", async () => {
    let archive = setting();
    const calls = mockApi({
      "GET /api/v1/session": () => ({ body: SIGNED_IN }),
      "GET /api/v1/carriers": () => ({ body: [] }),
      "GET /api/v1/settings": () => ({ body: { home: null, parcel_label: "tracking_number" } }),
      "GET /api/v1/settings/config": () => ({ body: [SECRET, archive] }),
      "PATCH /api/v1/settings/config": (request) => {
        const body = request.body as Record<string, number>;
        archive = setting({ source: "override", value: body["OPENPARCELS_ARCHIVE_DAYS"] ?? 0 });
        return { body: [SECRET, archive] };
      },
      "DELETE /api/v1/settings/config/OPENPARCELS_ARCHIVE_DAYS": () => {
        archive = setting();
        return { body: [SECRET, archive] };
      },
    });
    const user = userEvent.setup();
    renderApp("/settings");

    const retention = await screen.findByRole("region", { name: "Retention" }, { timeout: 5000 });
    expect(screen.getByRole("region", { name: "Home location" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Default parcel label" })).toBeInTheDocument();
    expect(within(retention).getByText("default")).toBeInTheDocument();
    expect(within(retention).getByText("live")).toBeInTheDocument();

    const storage = screen.getByRole("region", { name: "Storage" });
    expect(within(storage).getByText("Set (hidden)")).toBeInTheDocument();
    expect(within(storage).getByText("environment only")).toBeInTheDocument();
    expect(within(storage).queryByRole("textbox")).not.toBeInTheDocument();

    const input = within(retention).getByLabelText("ARCHIVE_DAYS value");
    await user.clear(input);
    await user.type(input, "45");
    await user.click(within(retention).getByRole("button", { name: "Save ARCHIVE_DAYS" }));
    expect(await within(retention).findByText("saved in UI")).toBeInTheDocument();

    await user.click(within(retention).getByRole("button", { name: "Reset ARCHIVE_DAYS" }));
    expect(await within(retention).findByText("default")).toBeInTheDocument();

    const writes = calls.filter((call) => call.method !== "GET").map((c) => [c.method, c.body]);
    expect(writes).toEqual([
      ["PATCH", { OPENPARCELS_ARCHIVE_DAYS: 45 }],
      ["DELETE", null],
    ]);
  });

  it("flags a restart setting that waits for a restart", async () => {
    mockApi({
      "GET /api/v1/session": () => ({ body: SIGNED_IN }),
      "GET /api/v1/carriers": () => ({ body: [] }),
      "GET /api/v1/settings": () => ({ body: { home: null, parcel_label: "tracking_number" } }),
      "GET /api/v1/settings/config": () => ({
        body: [
          setting({
            key: "OPENPARCELS_TIMEZONE",
            group: "tracking",
            kind: "string",
            apply: "restart",
            source: "override",
            value: "Asia/Tokyo",
            default: null,
            pending_restart: true,
          }),
        ],
      }),
    });
    renderApp("/settings");
    const tracking = await screen.findByRole("region", { name: "Tracking" });
    expect(within(tracking).getByText("saved, restart to apply")).toBeInTheDocument();
  });

  it("shows a reader the settings read only, without server settings", async () => {
    const calls = mockApi({
      "GET /api/v1/session": () => ({
        body: { ...SIGNED_IN, role: "reader", scopes: ["read"] },
      }),
      "GET /api/v1/carriers": () => ({ body: [] }),
      "GET /api/v1/settings": () => ({ body: { home: null, parcel_label: "tracking_number" } }),
    });
    renderApp("/settings");
    expect(await screen.findByRole("region", { name: "Default parcel label" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Name parcels by" })).toBeDisabled();
    expect(screen.queryByLabelText("Address or coordinates")).not.toBeInTheDocument();
    expect(screen.getByText(/for the admin only/)).toBeInTheDocument();
    expect(calls.some((call) => call.path === "/api/v1/settings/config")).toBe(false);
  });

  it("keeps the chosen language in this browser and reloads to apply it", async () => {
    mockApi({
      "GET /api/v1/session": () => ({
        body: { ...SIGNED_IN, role: "reader", scopes: ["read"] },
      }),
      "GET /api/v1/carriers": () => ({ body: [] }),
      "GET /api/v1/settings": () => ({ body: { home: null, parcel_label: "tracking_number" } }),
    });
    const reload = vi.fn();
    const original = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        href: original.href,
        origin: original.origin,
        protocol: original.protocol,
        host: original.host,
        hostname: original.hostname,
        port: original.port,
        pathname: original.pathname,
        search: original.search,
        hash: original.hash,
        assign: vi.fn(),
        replace: vi.fn(),
        reload,
      },
    });
    try {
      const user = userEvent.setup();
      renderApp("/settings");
      const select = await screen.findByRole("combobox", { name: "Language" });
      expect(select).toHaveValue("automatic");
      await user.selectOptions(select, "Deutsch");
      expect(localStorage.getItem("open-parcels.language")).toBe("de");
      expect(reload).toHaveBeenCalledOnce();
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: original });
      localStorage.removeItem("open-parcels.language");
    }
  });

  it("changes the admin password on the Security card", async () => {
    const calls = mockApi({
      "GET /api/v1/session": () => ({ body: SIGNED_IN }),
      "GET /api/v1/carriers": () => ({ body: [] }),
      "GET /api/v1/settings": () => ({ body: { home: null, parcel_label: "tracking_number" } }),
      "GET /api/v1/settings/config": () => ({
        body: [
          {
            key: "OPENPARCELS_ADMIN_PASSWORD",
            group: "security",
            description: "Password to change anything.",
            kind: "string",
            choices: null,
            apply: "env",
            secret: true,
            source: "override",
            set: true,
            value: null,
            default: null,
            pending_restart: false,
          },
        ],
      }),
      "PUT /api/v1/admin-password": () => ({ status: 204, body: null }),
    });
    const user = userEvent.setup();
    renderApp("/settings");
    const card = await screen.findByRole("region", { name: "Security" });
    const current = ["old", "admin", "secret"].join(" ");
    const next = ["new", "admin", "secret"].join(" ");
    await user.type(within(card).getByLabelText("Current admin password"), current);
    await user.type(within(card).getByLabelText("New admin password"), next);
    await user.type(within(card).getByLabelText("Repeat the new password"), next);
    await user.click(within(card).getByRole("button", { name: "Change admin password" }));
    await waitFor(() => {
      expect(calls.find((call) => call.path === "/api/v1/admin-password")?.body).toEqual({
        current,
        next,
      });
    });
  });
});

describe("backups card", () => {
  const FAILED = {
    ok: false,
    reason: "scheduled",
    at: "2026-11-24T03:00:00.000Z",
    file: null,
    bytes: null,
    error: "EACCES: permission denied, mkdir '/backups'",
    pruned: 0,
  };
  const DONE = {
    ok: true,
    reason: "manual",
    at: "2026-11-25T10:00:00.000Z",
    file: "openparcels-2026-11-25T10-00-00-000Z.db",
    bytes: 2_500_000,
    error: null,
    pruned: 0,
  };

  it("shows the last failure and backs up on demand", async () => {
    let status = {
      interval_hours: 24,
      keep: 7,
      directory: "/data/backups",
      last: FAILED as typeof FAILED | typeof DONE,
      next_at: "2026-11-25T03:00:00.000Z",
      failing: true,
      files: [] as { name: string; bytes: number; created_at: string }[],
    };
    const calls = mockApi({
      "GET /api/v1/session": () => ({ body: SIGNED_IN }),
      "GET /api/v1/carriers": () => ({ body: [] }),
      "GET /api/v1/settings": () => ({ body: { home: null, parcel_label: "tracking_number" } }),
      "GET /api/v1/settings/config": () => ({ body: [] }),
      "GET /api/v1/data/backups": () => ({ body: status }),
      "POST /api/v1/data/backups": () => {
        status = {
          ...status,
          last: DONE,
          failing: false,
          files: [{ name: DONE.file, bytes: DONE.bytes, created_at: DONE.at }],
        };
        return { body: DONE };
      },
    });
    const user = userEvent.setup();
    renderApp("/settings");
    const card = await screen.findByRole("region", { name: "Backups" });
    expect(await within(card).findByText("Last backup failed")).toBeInTheDocument();
    expect(within(card).getByText(/permission denied/)).toBeInTheDocument();
    expect(within(card).getByText("/data/backups")).toBeInTheDocument();

    await user.click(within(card).getByRole("button", { name: "Back up now" }));
    expect(await within(card).findByText("Last backup succeeded")).toBeInTheDocument();
    expect(within(card).getByText(DONE.file)).toBeInTheDocument();
    expect(calls.filter((call) => call.method === "POST").map((call) => call.path)).toEqual([
      "/api/v1/data/backups",
    ]);
  });
});

describe("a server setting's typed value (OP-152)", () => {
  it("keeps a secret as typed and trims the rest", () => {
    expect(fromText(SECRET, " made up ")).toBe(" made up ");
    expect(fromText(setting({ kind: "string" }), " plain ")).toBe("plain");
  });
});
