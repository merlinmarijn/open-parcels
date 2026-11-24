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
});
