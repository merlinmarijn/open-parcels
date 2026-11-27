import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BolBrowserSignIn } from "./BolBrowserSignIn";

function extension(supported: boolean) {
  return vi.spyOn(window, "postMessage").mockImplementation((message) => {
    const data = message as { type: string; requestId: string; cookieUrl?: string };
    const reply =
      data.type === "hello"
        ? { type: "hello", version: supported ? "0.3.0" : "0.2.0", cookieCapture: supported }
        : data.type === "capture"
          ? {
              type: "cookies_captured",
              requestId: data.requestId,
              cookie: "JSESSIONID=test-session",
            }
          : null;
    if (reply !== null)
      window.dispatchEvent(
        new MessageEvent("message", {
          source: window,
          origin: window.location.origin,
          data: { source: "open-parcels-extension", ...reply },
        }),
      );
  });
}

describe("Bol browser sign-in", () => {
  it("uses explicit cookie capture and passes the result directly to credential saving", async () => {
    const post = extension(true);
    const onCookie = vi.fn();
    render(<BolBrowserSignIn busy={false} onCookie={onCookie} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Sign in with the extension" }));
    await waitFor(() => {
      expect(onCookie).toHaveBeenCalledWith("JSESSIONID=test-session");
    });
    expect(
      post.mock.calls.find(([message]) => (message as { type: string }).type === "capture")?.[0],
    ).toMatchObject({ cookieUrl: "https://www.bol.com/nl/nl/account/bestellingen/overzicht/" });
    post.mockRestore();
  });

  it("explains that an older extension must be updated and disables unsupported capture", async () => {
    const post = extension(false);
    render(<BolBrowserSignIn busy={false} onCookie={vi.fn()} />);
    expect(await screen.findByText(/0.3.0 or newer/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in with the extension" })).toBeDisabled();
    post.mockRestore();
  });
});
