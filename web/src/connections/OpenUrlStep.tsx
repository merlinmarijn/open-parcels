import { useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from "react";
import type { SignInStep } from "../api/types";
import { Field } from "../components/ui";
import { safeHref } from "../lib/links";
import { t } from "../i18n";
import { captureSignIn, EXTENSION_URL, useCompanionExtension } from "./extension";

type OpenUrl = Extract<SignInStep, { kind: "open_url" }>;

interface Props {
  readonly step: OpenUrl;
  readonly busy: boolean;
  readonly onSubmit: (input: Record<string, string>) => void;
}

/** Names in the browser's developer tools, the same in every language. */
const AUTHORIZE_REQUEST = "authorize";
const LOCATION_HEADER = "Location";

/** One named window, so "Continue" reopens the sign-in where the user already is. */
const POPUP = "open-parcels-sign-in";
/** `noopener`: the carrier's page gets no handle on this tab (no reverse tabnabbing). */
const POPUP_FEATURES = "popup,width=520,height=760,noopener";

/** Opens the carrier's sign-in page; only an https address is ever opened. */
function openPopup(url: string): boolean {
  const href = safeHref(url, ["https:"]);
  if (href === null) {
    return false;
  }
  window.open(href, POPUP, POPUP_FEATURES);
  return true;
}

/** An app address (`dhllogin://…`) the browser cannot open, unlike a web page it lands on. */
function isAppAddress(prefix: string | null): boolean {
  return prefix !== null && !/^https?:/iu.test(prefix);
}

function isFirefox(): boolean {
  return /firefox|librewolf/iu.test(navigator.userAgent);
}

const CANCEL_REASONS: ReadonlyMap<string, string> = new Map([
  ["closed", t.connections.cancelClosed],
  ["denied", t.connections.cancelDenied],
  ["invalid", t.connections.cancelInvalid],
  ["timeout", t.connections.cancelTimeout],
  ["busy", t.connections.cancelBusy],
  ["error", t.connections.cancelError],
]);

/** The text for a reason the extension gave; a Map, so a name like "constructor" is no reason. */
export function cancelText(reason: string): string {
  return CANCEL_REASONS.get(reason) ?? t.connections.cancelOther;
}

/** Sign-in through the companion extension: it opens the window and brings the address back. */
function ExtensionSignIn(
  props: Props & { readonly onFallback: (reason: string) => void },
): ReactNode {
  const { step, onSubmit, onFallback } = props;
  const cancelRef = useRef<(() => void) | null>(null);
  const [waiting, setWaiting] = useState(false);
  useEffect(() => () => cancelRef.current?.(), []);
  const start = (): void => {
    const run = captureSignIn({
      url: step.url,
      redirectPrefix: step.redirect_prefix ?? "",
      resumeUrl: step.resume_url,
    });
    cancelRef.current = run.cancel;
    setWaiting(true);
    void run.result.then((outcome) => {
      cancelRef.current = null;
      setWaiting(false);
      if (outcome.status === "captured") {
        onSubmit({ pasted: outcome.url });
      } else {
        onFallback(cancelText(outcome.reason));
      }
    });
  };
  return (
    <div className="stack">
      {waiting ? (
        <p className="muted" role="status" aria-live="polite">
          <span className="pulse" aria-hidden="true" /> {t.connections.extensionWaiting}
        </p>
      ) : (
        <p>{t.connections.extensionIntro}</p>
      )}
      <div className="actions">
        <button
          type="button"
          className="button primary"
          disabled={waiting || props.busy}
          onClick={start}
        >
          {props.busy
            ? t.connections.working
            : waiting
              ? t.connections.waitingSignIn
              : t.connections.signInWithExtension}
        </button>
      </div>
    </div>
  );
}

function ManualGuide({ step }: { readonly step: OpenUrl }): ReactNode {
  const app = isAppAddress(step.redirect_prefix);
  const firefox = isFirefox();
  const devtools = firefox ? t.connections.devtoolsFirefox : t.connections.devtoolsOther;
  return (
    <ol className="steps">
      <li>
        <button
          type="button"
          className="button"
          onClick={() => {
            openPopup(step.url);
          }}
        >
          {t.connections.openSignInPage}
        </button>{" "}
        {t.connections.inNewWindow}
      </li>
      {app ? <li>{devtools}</li> : null}
      <li>{t.connections.signInWithCode}</li>
      {step.resume_url === null ? null : (
        <li>
          {t.connections.pageWhite}{" "}
          <button
            type="button"
            className="button"
            onClick={() => {
              if (step.resume_url !== null) openPopup(step.resume_url);
            }}
          >
            {t.connections.continueSignIn}
          </button>{" "}
          {t.connections.noNewPasswordText}
        </li>
      )}
      {app ? (
        <li>
          {t.connections.networkRow} <strong>302</strong> {t.connections.networkUsually}{" "}
          <code>{AUTHORIZE_REQUEST}</code>
          {t.connections.networkCopy} <strong>{LOCATION_HEADER}</strong>
          {t.connections.networkStarts} <code>{step.redirect_prefix}</code>.
          {firefox ? t.connections.networkErrorPage : null}
        </li>
      ) : (
        <li>{t.connections.copyFinal}</li>
      )}
      <li>{t.connections.pasteBelow}</li>
    </ol>
  );
}

function PasteForm({ busy, onSubmit }: Pick<Props, "busy" | "onSubmit">): ReactNode {
  const [pasted, setPasted] = useState("");
  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    onSubmit({ pasted: pasted.trim() });
    setPasted("");
  };
  return (
    <form onSubmit={submit} className="stack">
      <Field label={t.connections.finalAddress}>
        {(id) => (
          <input
            id={id}
            type="text"
            required
            autoComplete="off"
            spellCheck={false}
            value={pasted}
            onChange={(e) => {
              setPasted(e.target.value);
            }}
          />
        )}
      </Field>
      <div className="actions">
        <button type="submit" className="button primary" disabled={busy}>
          {busy ? t.connections.working : t.connections.continue}
        </button>
      </div>
    </form>
  );
}

/**
 * "Sign in in your browser": with the companion extension in one click, or by hand with a guide
 * that fits the browser and the kind of final address.
 */
export function OpenUrlStep(props: Props): ReactNode {
  const { step } = props;
  const extension = useCompanionExtension();
  const usable = step.redirect_prefix !== null;
  const [mode, setMode] = useState<"extension" | "manual" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Shown in a frame (Home Assistant's ingress panel), where the extension cannot reach the page.
  const framed = window.self !== window.top;
  // Without the extension the guide shows at once, not only after a click (OP-038).
  const missing = extension.checked && extension.version === null;
  const chosen =
    mode ??
    (usable && extension.version !== null ? "extension" : usable && missing ? "manual" : null);

  return (
    <div className="stack">
      {step.message === undefined ? null : <p className="step-message">{step.message}</p>}
      {notice === null ? null : (
        <p className="notice" role="status">
          {notice} {t.connections.tryAgain}
        </p>
      )}
      {usable ? (
        <fieldset>
          <legend>{t.connections.howToSignIn}</legend>
          <label className="checkbox">
            <input
              type="radio"
              name="sign-in-way"
              checked={chosen === "extension"}
              disabled={extension.version === null}
              onChange={() => {
                setMode("extension");
              }}
            />
            {t.connections.withExtension}
            {extension.checked && extension.version === null ? (
              <span className="muted">
                {" "}
                {t.connections.notInstalled}{" "}
                <a href={EXTENSION_URL} target="_blank" rel="noreferrer noopener">
                  {t.connections.getIt}
                </a>{" "}
                {t.connections.getItRest}
              </span>
            ) : null}
          </label>
          {framed ? (
            <p className="muted">
              {t.connections.insideHa}{" "}
              <a href={window.location.href} target="_blank" rel="noreferrer noopener">
                {t.connections.openOwnTab}
              </a>{" "}
              {t.connections.toUseIt}
            </p>
          ) : null}
          <label className="checkbox">
            <input
              type="radio"
              name="sign-in-way"
              checked={chosen === "manual"}
              onChange={() => {
                setMode("manual");
              }}
            />
            {t.connections.byHand}
          </label>
        </fieldset>
      ) : null}
      {chosen === "extension" ? (
        <ExtensionSignIn
          {...props}
          onFallback={(reason) => {
            setNotice(reason);
          }}
        />
      ) : null}
      {chosen === "manual" || !usable ? (
        <>
          <ManualGuide step={step} />
          <PasteForm busy={props.busy} onSubmit={props.onSubmit} />
        </>
      ) : null}
    </div>
  );
}
