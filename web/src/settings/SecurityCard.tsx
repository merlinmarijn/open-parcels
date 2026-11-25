import { useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode, type SyntheticEvent } from "react";
import {
  SESSION_KEY,
  useChangeAdminPassword,
  useResetAdminPassword,
  useSession,
} from "../auth/session";
import { MIN_PASSWORD } from "../auth/password";
import { ErrorNotice, Field } from "../components/ui";
import { t } from "../i18n";
import {
  SOURCE_LABELS,
  useResetServerSetting,
  useSaveServerSetting,
  type ServerSetting,
} from "./server-settings";

const ADMIN_KEY = "OPENPARCELS_ADMIN_PASSWORD";
const READER_KEY = "OPENPARCELS_PASSWORD";

function PasswordInput(props: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly autoComplete: "current-password" | "new-password";
  readonly required?: boolean;
  readonly hint?: string;
}): ReactNode {
  return (
    <Field label={props.label} {...(props.hint === undefined ? {} : { hint: props.hint })}>
      {(id, hint) => (
        <input
          id={id}
          type="password"
          aria-describedby={hint}
          autoComplete={props.autoComplete}
          required={props.required ?? true}
          value={props.value}
          onChange={(e) => {
            props.onChange(e.target.value);
          }}
        />
      )}
    </Field>
  );
}

function AdminPassword({ setting }: { readonly setting: ServerSetting | undefined }): ReactNode {
  const ingress = useSession().data?.method === "ingress";
  const change = useChangeAdminPassword();
  const reset = useResetAdminPassword();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    if (next.length < MIN_PASSWORD) {
      setProblem(t.settings.security.tooShort(MIN_PASSWORD));
      return;
    }
    if (next !== repeat) {
      setProblem(t.settings.security.newMismatch);
      return;
    }
    setProblem(null);
    change.mutate({ current: ingress && current === "" ? null : current, next });
  };

  return (
    <div className="stack">
      <h3>{t.settings.security.adminTitle}</h3>
      <p className="muted">
        {t.settings.security.adminIntro}{" "}
        {setting === undefined ? t.settings.security.unknown : SOURCE_LABELS[setting.source]}
        {setting?.source === "override" ? t.settings.security.storedHashed : null}
        {t.settings.security.adminSignsOut}
      </p>
      <form className="stack" onSubmit={submit}>
        <PasswordInput
          label={t.settings.security.current}
          value={current}
          onChange={setCurrent}
          autoComplete="current-password"
          required={!ingress}
          {...(ingress ? { hint: t.settings.security.notNeededIngress } : {})}
        />
        <PasswordInput
          label={t.settings.security.newAdmin}
          hint={t.settings.security.atLeast(MIN_PASSWORD)}
          value={next}
          onChange={setNext}
          autoComplete="new-password"
        />
        <PasswordInput
          label={t.settings.security.repeatNew}
          value={repeat}
          onChange={setRepeat}
          autoComplete="new-password"
        />
        {problem === null ? null : (
          <p role="alert" className="notice notice-error">
            {problem}
          </p>
        )}
        <ErrorNotice error={change.error ?? reset.error} />
        <div className="actions">
          <button type="submit" className="button primary" disabled={change.isPending}>
            {change.isPending ? t.settings.security.saving : t.settings.security.changeAdmin}
          </button>
          {setting?.source === "override" ? (
            <button
              type="button"
              className="button"
              disabled={reset.isPending}
              title={t.settings.security.adminResetTitle}
              onClick={() => {
                if (window.confirm(t.settings.security.adminResetConfirm)) {
                  reset.mutate();
                }
              }}
            >
              {t.settings.security.resetToEnvironment}
            </button>
          ) : null}
        </div>
      </form>
    </div>
  );
}

function ReaderPassword({ setting }: { readonly setting: ServerSetting | undefined }): ReactNode {
  const client = useQueryClient();
  const save = useSaveServerSetting();
  const reset = useResetServerSetting();
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const set = setting?.set === true;
  const refreshSession = (): void => {
    void client.invalidateQueries({ queryKey: SESSION_KEY });
  };
  const store = (value: string): void => {
    save.mutate(
      { key: READER_KEY, value },
      {
        onSuccess: () => {
          setNext("");
          setRepeat("");
          refreshSession();
        },
      },
    );
  };

  return (
    <div className="stack">
      <h3>{t.settings.security.readerTitle}</h3>
      <p className="muted">
        {set ? t.settings.security.readerSet : t.settings.security.readerUnset}{" "}
        {t.settings.security.readerSignsOut}
      </p>
      <form
        className="setting-edit"
        onSubmit={(event) => {
          event.preventDefault();
          // The same rules as the admin password: a mistyped one would lock every reader out
          // (OP-152).
          if (next.length < MIN_PASSWORD) {
            setProblem(t.settings.security.tooShort(MIN_PASSWORD));
          } else if (next !== repeat) {
            setProblem(t.settings.security.mismatch);
          } else {
            setProblem(null);
            store(next);
          }
        }}
      >
        <input
          type="password"
          aria-label={t.settings.security.newReader}
          placeholder={set ? t.settings.server.setTypeToReplace : t.settings.server.unset}
          autoComplete="new-password"
          value={next}
          onChange={(e) => {
            setNext(e.target.value);
          }}
        />
        <input
          type="password"
          aria-label={t.settings.security.repeatReader}
          placeholder={t.settings.security.repeat}
          autoComplete="new-password"
          value={repeat}
          onChange={(e) => {
            setRepeat(e.target.value);
          }}
        />
        <button type="submit" className="button primary" disabled={save.isPending || next === ""}>
          {set ? t.settings.security.change : t.settings.security.set}
        </button>
        {set ? (
          <button
            type="button"
            className="button"
            disabled={save.isPending}
            onClick={() => {
              if (window.confirm(t.settings.security.clearConfirm)) {
                store("");
              }
            }}
          >
            {t.settings.security.clear}
          </button>
        ) : null}
        {setting?.source === "override" ? (
          <button
            type="button"
            className="button"
            disabled={reset.isPending}
            title={t.settings.security.readerResetTitle}
            onClick={() => {
              reset.mutate(READER_KEY, { onSuccess: refreshSession });
            }}
          >
            {t.settings.security.reset}
          </button>
        ) : null}
      </form>
      {problem === null ? null : (
        <p role="alert" className="notice notice-error">
          {problem}
        </p>
      )}
      <ErrorNotice error={save.error ?? reset.error} />
    </div>
  );
}

/** The two passwords; admin only. */
export function SecurityCard({
  settings,
}: {
  readonly settings: readonly ServerSetting[];
}): ReactNode {
  return (
    <section className="card stack" aria-labelledby="settings-security">
      <h2 id="settings-security">{t.settings.security.title}</h2>
      <AdminPassword setting={settings.find((s) => s.key === ADMIN_KEY)} />
      <ReaderPassword setting={settings.find((s) => s.key === READER_KEY)} />
    </section>
  );
}
