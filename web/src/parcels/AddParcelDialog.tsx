import { useNavigate } from "@tanstack/react-router";
import { useState, type SyntheticEvent, type ReactNode } from "react";
import { useAddParcel, useCarriers } from "../api/queries";
import { Dialog, ErrorNotice, Field } from "../components/ui";
import { t } from "../i18n";

const AUTO = "";

export function AddParcelDialog(props: {
  readonly open: boolean;
  readonly onClose: () => void;
}): ReactNode {
  const carriers = useCarriers();
  const add = useAddParcel();
  const navigate = useNavigate();
  const [trackingNumber, setTrackingNumber] = useState("");
  const [carrier, setCarrier] = useState(AUTO);
  const [label, setLabel] = useState("");

  const close = (): void => {
    add.reset();
    props.onClose();
  };

  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    add.mutate(
      {
        tracking_number: trackingNumber.trim(),
        ...(carrier === AUTO ? {} : { carrier }),
        label: label.trim() === "" ? null : label.trim(),
      },
      {
        onSuccess: (parcel) => {
          setTrackingNumber("");
          setLabel("");
          setCarrier(AUTO);
          props.onClose();
          void navigate({ to: "/parcels/$parcelId", params: { parcelId: parcel.id } });
        },
      },
    );
  };

  const trackable = (carriers.data ?? []).filter((c) => c.connection_kinds.includes("tracking"));

  return (
    <Dialog title={t.parcels.track} open={props.open} onClose={close}>
      <form onSubmit={submit} className="stack">
        <Field label={t.parcels.trackingNumber}>
          {(id) => (
            <input
              id={id}
              required
              minLength={4}
              maxLength={64}
              autoFocus
              className="mono"
              value={trackingNumber}
              onChange={(e) => {
                setTrackingNumber(e.target.value);
              }}
            />
          )}
        </Field>
        <Field label={t.parcels.carrier} hint={t.parcels.carrierHint}>
          {(id, hint) => (
            <select
              id={id}
              aria-describedby={hint}
              value={carrier}
              onChange={(e) => {
                setCarrier(e.target.value);
              }}
            >
              <option value={AUTO}>{t.parcels.detectCarrier}</option>
              {trackable.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t.parcels.labelOptional}>
          {(id) => (
            <input
              id={id}
              maxLength={120}
              value={label}
              onChange={(e) => {
                setLabel(e.target.value);
              }}
            />
          )}
        </Field>
        <ErrorNotice error={add.error} />
        <div className="actions">
          <button type="button" className="button" onClick={close}>
            {t.common.cancel}
          </button>
          <button type="submit" className="button primary" disabled={add.isPending}>
            {add.isPending ? t.parcels.adding : t.parcels.trackButton}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
