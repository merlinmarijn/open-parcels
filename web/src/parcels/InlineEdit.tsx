import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Archive, ArchiveRestore, Check, Pencil, Trash2, X } from "lucide-react";
import {
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { keys, useDeleteParcel, useUpdateParcel } from "../api/queries";
import { PARCEL_STATUSES, type ParcelDetail, type ParcelStatus } from "../api/types";
import { useIsAdmin } from "../auth/session";
import { ErrorNotice } from "../components/ui";
import { STATUS_LABELS } from "../lib/format";
import { StatusBadge } from "./badges";
import { t } from "../i18n";

function PencilButton(props: { readonly label: string; readonly onClick: () => void }): ReactNode {
  return (
    <button
      type="button"
      className="icon-button pencil"
      aria-label={props.label}
      onClick={props.onClick}
    >
      <Pencil size={15} aria-hidden="true" />
    </button>
  );
}

interface InlineTitleProps {
  /** The page heading's id, for `aria-labelledby`. */
  readonly titleId: string;
  /** What the heading shows. */
  readonly shown: string;
  /** The own label, null when there is none. */
  readonly label: string | null;
  /** Shown in the empty field: the name used without a label. */
  readonly placeholder: string;
  readonly error: unknown;
  /** Called with the new label (null clears it) when it changed. */
  readonly onSave: (label: string | null) => void;
}

/** True when focus moves to another control of the same inline editor. */
function staysInGroup(event: FocusEvent<HTMLElement>): boolean {
  const next = event.relatedTarget;
  const group = event.currentTarget.parentElement;
  return next instanceof Node && group?.contains(next) === true;
}

/** A mouse press on the editor's buttons keeps focus where it is; the click then acts. */
function keepFocus(event: MouseEvent<HTMLButtonElement>): void {
  event.preventDefault();
}

/** A page heading renamed in place: Enter, Save or leaving saves; Escape or Cancel cancels. */
export function InlineTitle(props: InlineTitleProps): ReactNode {
  const canEdit = useIsAdmin();
  const [draft, setDraft] = useState<string | null>(null);

  const finish = (save: boolean): void => {
    if (draft === null) return;
    const next = draft.trim() === "" ? null : draft.trim();
    setDraft(null);
    if (save && next !== props.label) props.onSave(next);
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter") finish(true);
    if (event.key === "Escape") finish(false);
  };

  if (draft !== null) {
    return (
      <div className="inline-edit">
        <input
          className="inline-title-input"
          aria-label={t.common.label}
          autoFocus
          maxLength={120}
          value={draft}
          placeholder={props.placeholder}
          onChange={(e) => {
            setDraft(e.target.value);
          }}
          onKeyDown={onKey}
          // Leaving the whole group saves; moving to its own Save or Cancel button does not, so
          // a keyboard user can reach Cancel.
          onBlur={(e) => {
            if (!staysInGroup(e)) finish(true);
          }}
        />
        <button
          type="button"
          className="icon-button"
          aria-label={t.parcels.saveLabel}
          onMouseDown={keepFocus}
          onClick={() => {
            finish(true);
          }}
        >
          <Check size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={t.common.cancel}
          onMouseDown={keepFocus}
          onClick={() => {
            finish(false);
          }}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
    );
  }
  return (
    <div className="inline-edit">
      <h1 id={props.titleId}>{props.shown}</h1>
      {canEdit ? (
        <PencilButton
          label={t.common.rename}
          onClick={() => {
            setDraft(props.label ?? "");
          }}
        />
      ) : null}
      <ErrorNotice error={props.error} />
    </div>
  );
}

/** The parcel's name (label, else the tracking code), renamed in place. */
export function EditableTitle({ parcel }: { readonly parcel: ParcelDetail }): ReactNode {
  const update = useUpdateParcel(parcel.id);
  return (
    <InlineTitle
      titleId="parcel-title"
      shown={parcel.display_name}
      label={parcel.label}
      placeholder={parcel.tracking_number}
      error={update.error}
      onSave={(label) => {
        update.mutate({ label });
      }}
    />
  );
}

const FROM_CARRIER = "";

/**
 * The status badge; the pencil opens a picker. A choice is saved with Enter or Save, never by
 * moving through the list, so arrow keys can browse; Escape or Cancel closes it unsaved.
 */
export function EditableStatus({ parcel }: { readonly parcel: ParcelDetail }): ReactNode {
  const canEdit = useIsAdmin();
  const update = useUpdateParcel(parcel.id);
  const [choice, setChoice] = useState<string | null>(null);

  const close = (save: boolean): void => {
    if (choice === null) return;
    setChoice(null);
    const next = choice === FROM_CARRIER ? null : (choice as ParcelStatus);
    if (save && next !== parcel.manual_status) update.mutate({ manual_status: next });
  };

  if (choice !== null) {
    return (
      <span className="inline-edit">
        <select
          className="inline-status-select"
          aria-label={t.parcels.status}
          autoFocus
          value={choice}
          onChange={(e) => {
            setChoice(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") close(true);
            if (e.key === "Escape") close(false);
          }}
        >
          <option value={FROM_CARRIER}>
            {t.parcels.fromCarrier(STATUS_LABELS[parcel.carrier_status])}
          </option>
          {PARCEL_STATUSES.map((status) => (
            <option key={status} value={status}>
              {STATUS_LABELS[status]}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="icon-button"
          aria-label={t.parcels.saveStatus}
          onMouseDown={keepFocus}
          onClick={() => {
            close(true);
          }}
        >
          <Check size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={t.common.cancel}
          onMouseDown={keepFocus}
          onClick={() => {
            close(false);
          }}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </span>
    );
  }
  return (
    <span className="inline-edit">
      <StatusBadge status={parcel.status} manual={parcel.manual_status !== null} />
      {canEdit ? (
        <PencilButton
          label={t.parcels.changeStatus}
          onClick={() => {
            setChoice(parcel.manual_status ?? FROM_CARRIER);
          }}
        />
      ) : null}
      <ErrorNotice error={update.error} />
    </span>
  );
}

/** Archive or restore, and delete, as small buttons in the header. */
export function ParcelActions({ parcel }: { readonly parcel: ParcelDetail }): ReactNode {
  const canEdit = useIsAdmin();
  const update = useUpdateParcel(parcel.id);
  const remove = useDeleteParcel();
  const client = useQueryClient();
  const navigate = useNavigate();
  if (!canEdit) return null;
  const archived = parcel.archived_at !== null;
  return (
    <>
      <button
        type="button"
        className="button small"
        aria-pressed={archived}
        disabled={update.isPending}
        title={archived ? t.parcels.showAgain : t.parcels.hideFromList}
        onClick={() => {
          update.mutate({ archived: !archived });
        }}
      >
        {archived ? (
          <ArchiveRestore size={14} aria-hidden="true" />
        ) : (
          <Archive size={14} aria-hidden="true" />
        )}{" "}
        {archived ? t.parcels.unarchive : t.parcels.archive}
      </button>
      <button
        type="button"
        className="button small danger"
        onClick={() => {
          if (!window.confirm(t.parcels.confirmDelete)) {
            return;
          }
          remove.mutate(parcel.id, {
            onSuccess: () => {
              void navigate({ to: "/" }).then(() => {
                // Off its page now, so the deleted parcel's cached detail can go.
                client.removeQueries({ queryKey: keys.parcel(parcel.id), exact: true });
              });
            },
          });
        }}
      >
        <Trash2 size={14} aria-hidden="true" /> {t.common.delete}
      </button>
      {update.isSuccess && update.variables.archived !== undefined ? (
        <p className="notice" role="status">
          {update.variables.archived ? t.parcels.archivedNotice : t.parcels.restoredNotice}
        </p>
      ) : null}
      <ErrorNotice error={update.error ?? remove.error} />
    </>
  );
}
