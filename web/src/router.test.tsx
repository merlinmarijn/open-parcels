import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { mockApi, renderApp, SIGNED_IN } from "./test/helpers";

describe("unknown addresses", () => {
  it("show a styled page with a way back", async () => {
    mockApi({
      "GET /api/v1/session": () => ({ body: SIGNED_IN }),
      "GET /api/v1/parcels": () => ({ body: [] }),
      "GET /api/v1/carriers": () => ({ body: [] }),
    });
    renderApp("/no/such/page");
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to the parcels" })).toHaveAttribute("href", "/");
  });
});
