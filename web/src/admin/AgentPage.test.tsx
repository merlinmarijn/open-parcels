import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import guide from "../../../server/agent-guide.md?raw";
import { mockApi, renderApp, SIGNED_IN } from "../test/helpers";
import { blocks } from "./markdown";

describe("For AI agents", () => {
  it("shows the server's guide, links tokens and /llms.txt, and copies the guide", async () => {
    mockApi({ "GET /api/v1/session": () => ({ body: SIGNED_IN }) });
    const writeText = vi.fn(() => Promise.resolve());
    // After setup: user-event puts a clipboard stub of its own in place.
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderApp("/agent");
    expect(await screen.findByRole("heading", { level: 1, name: "For AI agents" })).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Playbook: an email is not detected" }),
    ).toBeVisible();
    const main = screen.getByRole("main");
    expect(within(main).getByRole("link", { name: "API tokens" })).toBeVisible();
    expect(within(main).getByRole("link", { name: "/llms.txt" })).toHaveAttribute(
      "href",
      "llms.txt",
    );
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: "For AI agents" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Copy guide" }));
    expect(writeText).toHaveBeenCalledWith(guide);
    expect(await screen.findByText("Copied.")).toBeVisible();
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("reads the guide's Markdown into blocks without losing a playbook step", () => {
    const parsed = blocks(guide);
    // The playbook's numbered list is split by its code block and goes on where it stopped.
    const starts = parsed.flatMap((block) =>
      block.kind === "list" && block.start !== null
        ? [[block.start, block.start + block.items.length - 1]]
        : [],
    );
    expect(starts).toEqual([
      [1, 4],
      [5, 8],
    ]);
    expect(parsed.filter((block) => block.kind === "code").length).toBeGreaterThan(4);
    expect(parsed.some((block) => block.kind === "table")).toBe(true);
  });
});
