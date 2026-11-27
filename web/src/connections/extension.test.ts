import { afterEach, describe, expect, it, vi } from "vitest";
import { CAPTURE_TIMEOUT_MS, captureSignIn } from "./extension";
import { cancelText } from "./OpenUrlStep";

afterEach(() => {
  vi.useRealTimers();
});

describe("a sign-in capture through the extension (OP-154)", () => {
  it("ends as timed out when the extension never answers", async () => {
    vi.useFakeTimers();
    const run = captureSignIn({
      url: "https://example.test/sign-in",
      redirectPrefix: "https://example.test/done",
      resumeUrl: null,
    });
    await vi.advanceTimersByTimeAsync(CAPTURE_TIMEOUT_MS);
    await expect(run.result).resolves.toEqual({ status: "cancelled", reason: "timeout" });
  });

  it("explains only reasons it knows", () => {
    expect(cancelText("busy")).toMatch(/another sign-in/);
    expect(cancelText("error")).toMatch(/error/);
    expect(cancelText("constructor")).toBe("The extension stopped.");
  });

  it("accepts cookies only for a matching cookie capture request", async () => {
    const sent = vi.spyOn(window, "postMessage");
    const run = captureSignIn({
      url: "https://www.bol.com/login",
      redirectPrefix: "https://www.bol.com/orders",
      resumeUrl: null,
      cookieUrl: "https://www.bol.com/orders",
    });
    const requestId = (sent.mock.calls[0]?.[0] as { requestId: string }).requestId;
    window.dispatchEvent(
      new MessageEvent("message", {
        source: window,
        origin: window.location.origin,
        data: {
          source: "open-parcels-extension",
          type: "cookies_captured",
          requestId,
          cookie: "test-session",
        },
      }),
    );
    await expect(run.result).resolves.toEqual({
      status: "cookies_captured",
      cookie: "test-session",
    });
    sent.mockRestore();
  });

  it("cancels locally before a late cookie result can save credentials", async () => {
    const run = captureSignIn({
      url: "https://www.bol.com/login",
      redirectPrefix: "https://www.bol.com/orders",
      resumeUrl: null,
      cookieUrl: "https://www.bol.com/orders",
    });
    const sent = vi.spyOn(window, "postMessage");
    run.cancel();
    const requestId = (sent.mock.calls[0]?.[0] as { requestId: string }).requestId;
    window.dispatchEvent(
      new MessageEvent("message", {
        source: window,
        origin: window.location.origin,
        data: {
          source: "open-parcels-extension",
          type: "cookies_captured",
          requestId,
          cookie: "test-session",
        },
      }),
    );
    await expect(run.result).resolves.toEqual({ status: "cancelled", reason: "closed" });
    sent.mockRestore();
  });
});
