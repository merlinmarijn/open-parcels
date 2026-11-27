import { useEffect, useState } from "react";

/**
 * The page side of the companion extension protocol (docs/extension-protocol.md, v1): the
 * extension opens a carrier's sign-in in its own window and hands back the final address, which
 * the page then submits like a pasted one. The server still checks it belongs to the sign-in.
 */

export const EXTENSION_URL = "https://github.com/merlinmarijn/open-parcels-extension";

const PAGE = "open-parcels-page";
const EXTENSION = "open-parcels-extension";
const HELLO_TIMEOUT_MS = 500;

interface ExtensionMessage {
  readonly source: typeof EXTENSION;
  readonly type: "hello" | "captured" | "cookies_captured" | "cancelled";
  readonly requestId?: string;
  readonly url?: string;
  readonly reason?: string;
  readonly version?: string;
  readonly cookieCapture?: boolean;
  readonly cookie?: string;
}

function isExtensionMessage(event: MessageEvent): event is MessageEvent<ExtensionMessage> {
  const data: unknown = event.data;
  return (
    event.source === window &&
    event.origin === window.location.origin &&
    typeof data === "object" &&
    data !== null &&
    (data as { source?: unknown }).source === EXTENSION
  );
}

function post(message: Record<string, unknown>): void {
  window.postMessage({ source: PAGE, ...message }, window.location.origin);
}

/** The installed extension's version, or null when none answers (checked once per mount). */
export function useCompanionExtension(): {
  readonly checked: boolean;
  readonly version: string | null;
  readonly cookieCapture: boolean;
} {
  const [state, setState] = useState<{
    checked: boolean;
    version: string | null;
    cookieCapture: boolean;
  }>({
    checked: false,
    version: null,
    cookieCapture: false,
  });
  useEffect(() => {
    const listener = (event: MessageEvent): void => {
      if (isExtensionMessage(event) && event.data.type === "hello") {
        setState({
          checked: true,
          version: event.data.version ?? "unknown",
          cookieCapture: event.data.cookieCapture === true,
        });
      }
    };
    window.addEventListener("message", listener);
    post({ type: "hello" });
    const timer = window.setTimeout(() => {
      setState((current) =>
        current.checked ? current : { checked: true, version: null, cookieCapture: false },
      );
    }, HELLO_TIMEOUT_MS);
    return () => {
      window.removeEventListener("message", listener);
      window.clearTimeout(timer);
    };
  }, []);
  return state;
}

export type CaptureOutcome =
  | { readonly status: "captured"; readonly url: string }
  | { readonly status: "cookies_captured"; readonly cookie: string }
  | { readonly status: "cancelled"; readonly reason: string };

/**
 * How long a capture may wait for the extension. Longer than any sign-in with a second factor;
 * an extension removed or crashed mid-capture then still ends the wait (OP-154).
 */
export const CAPTURE_TIMEOUT_MS = 15 * 60 * 1000;

/** Asks the extension to run one sign-in; `cancel` withdraws the request. */
export function captureSignIn(request: {
  readonly url: string;
  readonly redirectPrefix: string;
  readonly resumeUrl: string | null;
  readonly cookieUrl?: string;
}): { readonly result: Promise<CaptureOutcome>; readonly cancel: () => void } {
  const requestId = crypto.randomUUID();
  let listener: ((event: MessageEvent) => void) | null = null;
  let timer: number | undefined;
  let finish: (outcome: CaptureOutcome) => void = () => undefined;
  const result = new Promise<CaptureOutcome>((resolve) => {
    finish = resolve;
    timer = window.setTimeout(() => {
      post({ type: "cancel", requestId });
      resolve({ status: "cancelled", reason: "timeout" });
    }, CAPTURE_TIMEOUT_MS);
    listener = (event: MessageEvent): void => {
      if (!isExtensionMessage(event) || event.data.requestId !== requestId) return;
      if (
        request.cookieUrl !== undefined &&
        event.data.type === "cookies_captured" &&
        typeof event.data.cookie === "string" &&
        event.data.cookie.length > 0 &&
        event.data.cookie.length <= 32768 &&
        !/[\r\n]/.test(event.data.cookie)
      ) {
        resolve({ status: "cookies_captured", cookie: event.data.cookie });
      } else if (
        request.cookieUrl === undefined &&
        event.data.type === "captured" &&
        typeof event.data.url === "string"
      ) {
        resolve({ status: "captured", url: event.data.url });
      } else if (event.data.type === "cancelled") {
        resolve({ status: "cancelled", reason: event.data.reason ?? "closed" });
      }
    };
    window.addEventListener("message", listener);
  }).finally(() => {
    window.clearTimeout(timer);
    if (listener !== null) window.removeEventListener("message", listener);
  });
  post({ type: "capture", requestId, ...request });
  return {
    result,
    cancel: () => {
      post({ type: "cancel", requestId });
      finish({ status: "cancelled", reason: "closed" });
    },
  };
}
