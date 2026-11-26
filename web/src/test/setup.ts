import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// The gate runs with one worker on a shared NAS; under load the first render of a page can take
// longer than testing-library's 1 s default for findBy*/waitFor, which made tests flaky.
configure({ asyncUtilTimeout: 5000 });

// jsdom has no layout; the router restores scroll positions on navigation.
window.scrollTo = (): void => undefined;

// jsdom has no ResizeObserver; the resizable split panels need one.
class NoopResizeObserver {
  observe(): void {
    return undefined;
  }
  unobserve(): void {
    return undefined;
  }
  disconnect(): void {
    return undefined;
  }
}
if (!("ResizeObserver" in window)) {
  Object.assign(window, { ResizeObserver: NoopResizeObserver });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
