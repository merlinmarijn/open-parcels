import { Archive, ArchiveRestore, Trash2 } from "lucide-react";
import type { ReactNode } from "react";

/** Archive or restore a parcel or order, as a small pressed/unpressed header button. */
export function ArchiveButton(props: {
  readonly archived: boolean;
  readonly pending: boolean;
  readonly archiveLabel: string;
  readonly restoreLabel: string;
  readonly title?: string;
  readonly onChange: (archived: boolean) => void;
}): ReactNode {
  return (
    <button
      type="button"
      className="button small"
      aria-pressed={props.archived}
      disabled={props.pending}
      title={props.title}
      onClick={() => {
        props.onChange(!props.archived);
      }}
    >
      {props.archived ? (
        <ArchiveRestore size={14} aria-hidden="true" />
      ) : (
        <Archive size={14} aria-hidden="true" />
      )}{" "}
      {props.archived ? props.restoreLabel : props.archiveLabel}
    </button>
  );
}

/** Delete for good, after the browser's confirmation with `question`. */
export function DeleteButton(props: {
  readonly label: string;
  readonly question: string;
  readonly onDelete: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      className="button small danger"
      onClick={() => {
        if (window.confirm(props.question)) props.onDelete();
      }}
    >
      <Trash2 size={14} aria-hidden="true" /> {props.label}
    </button>
  );
}
