import { useMutation } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { postApiV1InboxFolders } from "../api/generated";
import { ErrorNotice } from "../components/ui";
import { t } from "../i18n";
import type { FormValues } from "./schema";

export function InboxFolders(props: {
  readonly config: FormValues;
  readonly secret: FormValues;
  readonly connectionId?: string;
  readonly onChange: (folders: string[]) => void;
}): ReactNode {
  const host = typeof props.config["host"] === "string" ? props.config["host"] : "";
  const username = typeof props.secret["username"] === "string" ? props.secret["username"] : "";
  const password = typeof props.secret["password"] === "string" ? props.secret["password"] : "";
  const selected = Array.isArray(props.config["folders"])
    ? props.config["folders"].filter((value): value is string => typeof value === "string")
    : ["INBOX"];
  const discover = useMutation({
    mutationFn: () =>
      postApiV1InboxFolders({
        config: { ...props.config, host, folders: ["INBOX"] },
        ...(props.connectionId === undefined
          ? {
              secret: {
                username,
                password,
              },
            }
          : { connection_id: props.connectionId }),
      }),
    onSuccess: (folders) => {
      props.onChange(selected.filter((folder) => folders.includes(folder)));
    },
  });
  const folders = discover.data ?? selected;
  const ready =
    Boolean(host) && (props.connectionId !== undefined || Boolean(username && password));
  return (
    <fieldset className="stack">
      <legend>{t.connections.folders}</legend>
      <p className="muted">{t.connections.foldersHint}</p>
      <div className="actions">
        <button
          type="button"
          className="button"
          disabled={!ready || discover.isPending}
          onClick={() => {
            discover.mutate();
          }}
        >
          {discover.isPending ? t.connections.working : t.connections.detectFolders}
        </button>
        {folders.length > 0 ? (
          <label className="checkbox">
            <input
              type="checkbox"
              checked={folders.every((folder) => selected.includes(folder))}
              onChange={(event) => {
                props.onChange(event.target.checked ? [...folders] : []);
              }}
            />
            {t.connections.selectAllFolders}
          </label>
        ) : null}
      </div>
      <ErrorNotice error={discover.error} />
      {discover.data?.length === 0 ? <p role="status">{t.connections.noFolders}</p> : null}
      {folders.map((folder, index) => (
        <label className="checkbox" key={folder}>
          <input
            type="checkbox"
            checked={selected.includes(folder)}
            required={selected.length === 0 && index === 0}
            onChange={(event) => {
              props.onChange(
                event.target.checked
                  ? [...selected, folder]
                  : selected.filter((name) => name !== folder),
              );
            }}
          />
          {folder}
        </label>
      ))}
      {selected.length === 0 ? <p role="status">{t.connections.chooseFolder}</p> : null}
    </fieldset>
  );
}
