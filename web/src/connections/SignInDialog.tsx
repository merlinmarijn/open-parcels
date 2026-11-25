import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type SyntheticEvent, type ReactNode } from "react";
import { getApiV1ConnectionsIdSignInFlows, putApiV1ConnectionsIdSecret } from "../api/generated";
import { keys, useCarriers } from "../api/queries";
import type { SignInFlow, Connection } from "../api/types";
import { Dialog, ErrorNotice, Spinner } from "../components/ui";
import { INBOX_FLOWS, INBOX_PROVIDER, INBOX_SECRET_SCHEMA } from "./inbox";
import { SchemaFields } from "./SchemaForm";
import { asSchema, cleanValues, type FormValues } from "./schema";
import { StepRenderer } from "./StepRenderer";
import { useSignInAttempt } from "./useSignInAttempt";
import { t } from "../i18n";

/** Credentials and API keys: a form from the carrier's sign-in schema, sent once with PUT. */
function StaticSecretForm(props: {
  readonly connection: Connection;
  readonly flow: SignInFlow;
  readonly onDone: () => void;
}): ReactNode {
  const carriers = useCarriers();
  const client = useQueryClient();
  // A flow with its own fields (an optional API key) shows only those, not the whole sign-in data.
  const schema =
    props.connection.provider === INBOX_PROVIDER
      ? INBOX_SECRET_SCHEMA
      : asSchema(
          props.flow.secret_schema ??
            carriers.data?.find((c) => c.id === props.connection.provider)?.secret_schema,
        );
  const [values, setValues] = useState<FormValues>({});
  const save = useMutation({
    mutationFn: (secret: FormValues) =>
      putApiV1ConnectionsIdSecret(props.connection.id, { secret }),
    onSuccess: async () => {
      setValues({});
      await client.invalidateQueries({ queryKey: keys.connections });
      props.onDone();
    },
  });
  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    save.mutate(cleanValues(schema, values));
  };
  return (
    <form onSubmit={submit} className="stack" autoComplete="off">
      <SchemaFields schema={schema} values={values} onChange={setValues} />
      <ErrorNotice error={save.error} />
      <div className="actions">
        <button type="submit" className="button primary" disabled={save.isPending}>
          {t.connections.saveSignIn}
        </button>
      </div>
    </form>
  );
}

function InteractiveSignIn(props: {
  readonly connection: Connection;
  readonly flow: SignInFlow;
  readonly onDone: () => void;
}): ReactNode {
  const attempt = useSignInAttempt(props.connection.id);
  const { state } = attempt;
  if (state.phase === "done") {
    return (
      <div className="stack">
        <p className="notice" role="status">
          {t.connections.signedIn}
        </p>
        <div className="actions">
          <button type="button" className="button primary" onClick={props.onDone}>
            {t.connections.close}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="stack">
      <ErrorNotice error={attempt.error} />
      {state.phase === "idle" ? (
        <div className="actions">
          <button
            type="button"
            className="button primary"
            disabled={attempt.busy}
            onClick={() => {
              void attempt.start(props.flow.id);
            }}
          >
            {attempt.busy ? t.connections.starting : t.connections.startFlow(props.flow.label)}
          </button>
        </div>
      ) : (
        <>
          <StepRenderer
            // A new key per step: a choice or code typed for one step never carries into the next.
            key={`${state.attempt.attempt_id}:${String(state.seq)}`}
            step={state.attempt.step}
            busy={attempt.busy}
            onSubmit={(input) => {
              void attempt.answer(input);
            }}
          />
          <div className="actions">
            <button type="button" className="button" onClick={attempt.cancel}>
              {t.connections.cancelSignIn}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function FlowBody(props: {
  readonly connection: Connection;
  readonly flow: SignInFlow;
  readonly onDone: () => void;
}): ReactNode {
  switch (props.flow.type) {
    case "none":
      return <p className="muted">{t.connections.noSignIn}</p>;
    case "credentials":
    case "api_key":
      return (
        <StaticSecretForm connection={props.connection} flow={props.flow} onDone={props.onDone} />
      );
    case "interactive":
      return <InteractiveSignIn key={props.flow.id} {...props} />;
  }
}

export function SignInDialog(props: {
  readonly connection: Connection | null;
  readonly onClose: () => void;
}): ReactNode {
  const connection = props.connection;
  const isMail = connection?.provider === INBOX_PROVIDER;
  const flows = useQuery({
    queryKey: keys.signInFlows(connection?.id),
    queryFn: ({ signal }) =>
      connection === null || isMail
        ? Promise.resolve(INBOX_FLOWS)
        : getApiV1ConnectionsIdSignInFlows(connection.id, { signal }),
    enabled: connection !== null,
  });
  const [chosen, setChosen] = useState<string | null>(null);
  const list = flows.data ?? [];
  const flow = list.find((f) => f.id === chosen) ?? list[0];

  return (
    <Dialog
      title={
        connection === null ? t.connections.signIn : t.connections.signInTitle(connection.label)
      }
      open={connection !== null}
      onClose={() => {
        setChosen(null);
        props.onClose();
      }}
      wide
    >
      <ErrorNotice error={flows.error} />
      {flows.isPending ? <Spinner /> : null}
      {list.length > 1 ? (
        <label className="field">
          <span>{t.connections.signInMethod}</span>
          <select
            value={flow?.id ?? ""}
            onChange={(e) => {
              setChosen(e.target.value);
            }}
          >
            {list.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {connection === null || flow === undefined ? null : (
        <FlowBody connection={connection} flow={flow} onDone={props.onClose} />
      )}
    </Dialog>
  );
}
