import { useState, type SyntheticEvent, type ReactNode } from "react";
import { ErrorNotice, Field } from "../components/ui";
import { BRAND, t } from "../i18n";
import { MIN_PASSWORD } from "./password";
import { useSetup, useSignIn } from "./session";
import "./auth.css";

interface AuthPageProps {
  /** Set when reading is open and this page was opened from the web UI: a way back to it. */
  readonly onCancel?: () => void;
}

function AuthCard(
  props: AuthPageProps & { readonly title: string; readonly children: ReactNode },
): ReactNode {
  return (
    <main className="auth-page">
      <section className="card auth-card" aria-labelledby="auth-title">
        <p className="brand">
          <img className="brand-logo" src="favicon.svg" alt="" />
          {BRAND}
        </p>
        <h1 id="auth-title">{props.title}</h1>
        {props.children}
        {props.onCancel === undefined ? null : (
          <button type="button" className="link-button" onClick={props.onCancel}>
            {t.shell.backToApp}
          </button>
        )}
      </section>
    </main>
  );
}

/** First start: the setup code from the container log, then the admin password. */
export function SetupPage(props: AuthPageProps): ReactNode {
  const setup = useSetup();
  const [setupCode, setSetupCode] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    if (password.length < MIN_PASSWORD) {
      setProblem(t.shell.useMinLength(MIN_PASSWORD));
      return;
    }
    if (password !== repeat) {
      setProblem(t.shell.mismatch);
      return;
    }
    setProblem(null);
    setup.mutate({ setupCode: setupCode.trim(), password });
  };

  return (
    <AuthCard title={t.shell.setupTitle} {...props}>
      <p className="muted">{t.shell.setupIntro}</p>
      <form onSubmit={submit} className="stack">
        <Field label={t.shell.setupCode} hint={t.shell.setupCodeHint}>
          {(id, hint) => (
            <input
              id={id}
              aria-describedby={hint}
              autoComplete="one-time-code"
              required
              value={setupCode}
              onChange={(e) => {
                setSetupCode(e.target.value);
              }}
            />
          )}
        </Field>
        <Field label={t.shell.adminPasswordText} hint={t.shell.minLength(MIN_PASSWORD)}>
          {(id, hint) => (
            <input
              id={id}
              type="password"
              aria-describedby={hint}
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
              }}
            />
          )}
        </Field>
        <Field label={t.shell.repeatPasswordText}>
          {(id) => (
            <input
              id={id}
              type="password"
              autoComplete="new-password"
              required
              value={repeat}
              onChange={(e) => {
                setRepeat(e.target.value);
              }}
            />
          )}
        </Field>
        {problem === null ? null : (
          <p role="alert" className="notice notice-error">
            {problem}
          </p>
        )}
        <ErrorNotice error={setup.error} />
        <button type="submit" className="button primary" disabled={setup.isPending}>
          {setup.isPending ? t.shell.saving : t.shell.setPasswordText}
        </button>
      </form>
    </AuthCard>
  );
}

/** One box: the admin password logs in to change things, the reader password only to read. */
export function SignInPage(props: AuthPageProps): ReactNode {
  const signIn = useSignIn();
  const [password, setPassword] = useState("");

  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    signIn.mutate(password, {
      onSettled: () => {
        setPassword("");
      },
    });
  };

  return (
    <AuthCard title={t.shell.logIn} {...props}>
      <form onSubmit={submit} className="stack">
        <Field label={t.shell.passwordText} hint={t.shell.passwordHint}>
          {(id, hint) => (
            <input
              id={id}
              aria-describedby={hint}
              type="password"
              autoComplete="current-password"
              required
              autoFocus
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
              }}
            />
          )}
        </Field>
        <ErrorNotice error={signIn.error} />
        <button type="submit" className="button primary" disabled={signIn.isPending}>
          {signIn.isPending ? t.shell.loggingIn : t.shell.logIn}
        </button>
      </form>
    </AuthCard>
  );
}
