import { useEffect, useRef, useState, type ReactNode } from "react";
import { t } from "../i18n";
import { captureSignIn, EXTENSION_URL, useCompanionExtension } from "./extension";
import { cancelText } from "./OpenUrlStep";

const ORDERS = "https://www.bol.com/nl/nl/account/bestellingen/overzicht/";

export function BolBrowserSignIn(props: {
  readonly busy: boolean;
  readonly onCookie: (cookie: string) => void;
}): ReactNode {
  const extension = useCompanionExtension();
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = useRef<(() => void) | null>(null);
  useEffect(() => () => cancel.current?.(), []);
  const start = (): void => {
    const run = captureSignIn({
      url: `https://www.bol.com/nl/account/login.html?redirectUrl=${encodeURIComponent(new URL(ORDERS).pathname)}`,
      redirectPrefix: ORDERS,
      resumeUrl: null,
      cookieUrl: ORDERS,
    });
    cancel.current = run.cancel;
    setError(null);
    setWaiting(true);
    void run.result.then((outcome) => {
      cancel.current = null;
      setWaiting(false);
      if (outcome.status === "cookies_captured") props.onCookie(outcome.cookie);
      else if (outcome.status === "cancelled") setError(cancelText(outcome.reason));
    });
  };
  return (
    <div className="stack">
      <p>{t.connections.bolBrowserHelp}</p>
      {window.self !== window.top ? (
        <p className="muted">
          {t.connections.insideHa}{" "}
          <a href={window.location.href} target="_blank" rel="noreferrer noopener">
            {t.connections.openOwnTab}
          </a>{" "}
          {t.connections.toUseIt}
        </p>
      ) : null}
      {extension.checked && !extension.cookieCapture ? (
        <p className="muted">
          {t.connections.bolExtensionUpdate}{" "}
          <a href={EXTENSION_URL} target="_blank" rel="noreferrer noopener">
            {t.connections.getIt}
          </a>
        </p>
      ) : null}
      {waiting ? <p role="status">{t.connections.extensionWaiting}</p> : null}
      {error === null ? null : <p role="alert">{error}</p>}
      <div className="actions">
        <button
          type="button"
          className="button primary"
          disabled={props.busy || waiting || !extension.cookieCapture || window.self !== window.top}
          onClick={start}
        >
          {waiting ? t.connections.waitingSignIn : t.connections.signInWithExtension}
        </button>
      </div>
    </div>
  );
}
