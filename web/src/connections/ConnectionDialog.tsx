import { useMemo, useState, type SyntheticEvent, type ReactNode } from "react";
import { useAddConnection, useCarriers, useUpdateConnection } from "../api/queries";
import type { Carrier, Connection } from "../api/types";
import { Dialog, ErrorNotice, Field } from "../components/ui";
import { LogoTile } from "../components/CarrierLogo";
import { INBOX_CONFIG_SCHEMA, INBOX_PROVIDER } from "./inbox";
import { pickerEntries } from "./picker";
import { ProviderPicker } from "./ProviderPicker";
import { SchemaFields } from "./SchemaForm";
import { asSchema, cleanValues, initialValues, type FormValues, type JsonSchema } from "./schema";
import { t } from "../i18n";

type Kind = Connection["kind"];

const KIND_LABELS: Readonly<Record<Kind, string>> = {
  account: t.connections.kindAccount,
  tracking: t.connections.kindTracking,
  shop: t.connections.kindShop,
  mail: t.connections.kindMail,
};

function configSchema(provider: string, carriers: readonly Carrier[]): JsonSchema {
  return provider === INBOX_PROVIDER
    ? INBOX_CONFIG_SCHEMA
    : asSchema(carriers.find((c) => c.id === provider)?.config_schema);
}

function kindsOf(provider: string, carriers: readonly Carrier[]): Kind[] {
  return provider === INBOX_PROVIDER
    ? ["mail"]
    : [...(carriers.find((c) => c.id === provider)?.connection_kinds ?? [])];
}

/** The chosen provider above the form, with a button back to the picker. */
function ChosenProvider(props: {
  readonly id: string;
  readonly name: string;
  readonly logo: string | null;
  readonly onChange: () => void;
}): ReactNode {
  return (
    <div className="picker-chosen">
      <LogoTile carrier={props.id} name={props.name} logo={props.logo} size={36} />
      <span className="picker-name">{props.name}</span>
      <button type="button" className="button" onClick={props.onChange}>
        {t.connections.change}
      </button>
    </div>
  );
}

/**
 * Adds a connection (pick a provider first, then its kind and settings) or edits an existing
 * one's label and config.
 */
export function ConnectionDialog(props: {
  readonly open: boolean;
  readonly editing: Connection | null;
  readonly onClose: () => void;
  readonly onCreated: (connection: Connection) => void;
}): ReactNode {
  const carriers = useCarriers();
  const add = useAddConnection();
  const update = useUpdateConnection();
  const list = useMemo(() => carriers.data ?? [], [carriers.data]);
  const entries = useMemo(() => pickerEntries(list), [list]);
  const editing = props.editing;
  const [provider, setProvider] = useState(editing?.provider ?? "");
  const kinds = kindsOf(provider, list);
  const [kind, setKind] = useState<Kind | "">(editing?.kind ?? "");
  const effectiveKind = kind !== "" && kinds.includes(kind) ? kind : (kinds[0] ?? "");
  const schema = configSchema(provider, list);
  const [label, setLabel] = useState(editing?.label ?? "");
  const [values, setValues] = useState<FormValues>(() =>
    initialValues(configSchema(editing?.provider ?? "", carriers.data ?? []), editing?.config),
  );
  const mutation = editing === null ? add : update;

  const chooseProvider = (next: string): void => {
    setProvider(next);
    setKind("");
    setValues(initialValues(configSchema(next, list), undefined));
    const name =
      next === INBOX_PROVIDER ? t.connections.inboxName : list.find((c) => c.id === next)?.name;
    if (name !== undefined) {
      setLabel(name);
    }
  };
  const chosen = entries.find((entry) => entry.id === provider);

  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    const config = cleanValues(schema, values);
    if (editing !== null) {
      update.mutate({ id: editing.id, body: { label, config } }, { onSuccess: props.onClose });
      return;
    }
    if (effectiveKind === "") {
      return;
    }
    add.mutate({ provider, kind: effectiveKind, label, config }, { onSuccess: props.onCreated });
  };

  return (
    <Dialog
      title={editing === null ? t.connections.add : t.connections.editTitle(editing.label)}
      open={props.open}
      onClose={props.onClose}
      wide
    >
      {editing === null && provider === "" ? (
        <ProviderPicker entries={entries} onChoose={chooseProvider} />
      ) : (
        <form onSubmit={submit} className="stack">
          {editing === null ? (
            <>
              {chosen === undefined ? null : (
                <ChosenProvider
                  id={chosen.id}
                  name={chosen.name}
                  logo={chosen.logo}
                  onChange={() => {
                    setProvider("");
                  }}
                />
              )}
              {kinds.length > 1 ? (
                <Field label={t.connections.kind}>
                  {(id) => (
                    <select
                      id={id}
                      value={effectiveKind}
                      onChange={(e) => {
                        setKind(e.target.value as Kind);
                      }}
                    >
                      {kinds.map((k) => (
                        <option key={k} value={k}>
                          {KIND_LABELS[k]}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
              ) : null}
            </>
          ) : null}
          <Field label={t.connections.name}>
            {(id) => (
              <input
                id={id}
                required
                maxLength={80}
                value={label}
                onChange={(e) => {
                  setLabel(e.target.value);
                }}
              />
            )}
          </Field>
          {provider === "" ? null : (
            <SchemaFields schema={schema} values={values} onChange={setValues} />
          )}
          {editing === null && provider !== "" ? (
            <p className="muted">{t.connections.afterAdding}</p>
          ) : null}
          <ErrorNotice error={mutation.error} />
          <div className="actions">
            <button type="button" className="button" onClick={props.onClose}>
              {t.connections.cancel}
            </button>
            <button
              type="submit"
              className="button primary"
              disabled={mutation.isPending || provider === ""}
            >
              {editing === null ? t.connections.addConnection : t.connections.save}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
