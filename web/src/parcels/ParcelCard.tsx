/**
 * A parcel as one rich row: carrier tile, name, what the carrier last said, a four-step progress
 * line, the expected day in words and a status pill. Used by the parcel list, the map's side list
 * and an order's parcels.
 */
import { Link } from "@tanstack/react-router";
import { MapPin } from "lucide-react";
import type { ReactNode } from "react";
import type { LookupState, ParcelStatus } from "../api/types";
import { CarrierLogo, useCarrierName } from "../components/CarrierLogo";
import { ItemPictures } from "../components/ItemPictures";
import { etaParts, formatRelative, type ExpectedDelivery } from "../lib/format";
import { ArchivedBadge, LookupBadge, StatusBadge } from "./badges";
import { t } from "../i18n";
import "./parcels.css";

/** What a row needs; the parcel list, an order's parcels and the map all have this much. */
export interface ParcelRowData extends ExpectedDelivery {
  readonly id: string;
  readonly carrier: string;
  readonly tracking_number: string;
  readonly display_name: string;
  readonly status: ParcelStatus;
  readonly delivered: boolean;
  readonly delivered_at: string | null;
  readonly archived_at: string | null;
  readonly raw_status?: string | null;
  readonly manual_status?: string | null;
  readonly label?: string | null;
  readonly live?: { readonly stops_away: number | null } | null;
  readonly lookup?: { readonly state: LookupState };
  readonly location?: { readonly name: string | null } | null;
  readonly items?: readonly { readonly title: string; readonly image_url: string | null }[];
}

/** How far along the four steps (announced, on its way, out for delivery, delivered) it is. */
const STEP: Readonly<Record<ParcelStatus, number>> = {
  unknown: 0,
  registered: 1,
  in_transit: 2,
  returning: 2,
  problem: 2,
  out_for_delivery: 3,
  at_pickup_point: 3,
  delivered: 4,
};

function Progress(props: { readonly status: ParcelStatus }): ReactNode {
  const step = STEP[props.status];
  return (
    <span className={`parcel-progress progress-${props.status}`} aria-hidden="true">
      {[1, 2, 3, 4].map((n) => (
        <span key={n} className={n <= step ? "on" : undefined} />
      ))}
    </span>
  );
}

/** The right-hand column: "Tomorrow" over "10:00–12:00", "Next stop", or when it arrived. */
function When({ parcel }: { readonly parcel: ParcelRowData }): ReactNode {
  const stops = parcel.live?.stops_away;
  if (parcel.delivered) {
    return (
      <span className="parcel-when">
        <span className="parcel-when-day">{t.parcels.filterDelivered}</span>
        <span className="parcel-when-time">{formatRelative(parcel.delivered_at)}</span>
      </span>
    );
  }
  if (typeof stops === "number") {
    return (
      <span className="parcel-when soon">
        <span className="parcel-when-day">
          {stops === 0 ? t.parcels.nextStop : t.parcels.stopsAway(stops)}
        </span>
      </span>
    );
  }
  const eta = etaParts(parcel);
  if (eta === null) return null;
  return (
    <span className="parcel-when">
      <span className="parcel-when-day">{eta.day}</span>
      {eta.time === null ? null : <span className="parcel-when-time">{eta.time}</span>}
    </span>
  );
}

export function ParcelCard(props: {
  readonly parcel: ParcelRowData;
  /** Compact rows (map list, order cards) leave out the item pictures. */
  readonly compact?: boolean;
}): ReactNode {
  const { parcel } = props;
  const carrierName = useCarrierName(parcel.carrier);
  const notFound = parcel.lookup?.state === "not_found";
  const place = parcel.delivered ? null : (parcel.location?.name ?? null);
  const said = parcel.raw_status ?? null;
  return (
    <Link
      to="/parcels/$parcelId"
      params={{ parcelId: parcel.id }}
      className={props.compact === true ? "parcel-card compact" : "parcel-card"}
    >
      <CarrierLogo carrier={parcel.carrier} size={props.compact === true ? 36 : 44} />
      <span className="parcel-card-body">
        <span className="parcel-card-title">
          <span className="parcel-card-name">{parcel.display_name}</span>
          {parcel.archived_at === null ? null : <ArchivedBadge />}
        </span>
        <span className="parcel-card-meta">
          <span>{carrierName}</span>
          {parcel.label === null || parcel.label === undefined ? null : (
            <span className="mono">{parcel.tracking_number}</span>
          )}
          {place === null ? null : (
            <span>
              <MapPin size={12} aria-hidden="true" /> {place}
            </span>
          )}
          {said === null ? null : <span className="parcel-card-said">{said}</span>}
        </span>
        <Progress status={parcel.status} />
      </span>
      {props.compact === true || parcel.items === undefined ? null : (
        <ItemPictures items={parcel.items} limit={3} size="small" />
      )}
      <span className="parcel-card-side">
        <When parcel={parcel} />
        {notFound ? (
          <LookupBadge state="not_found" />
        ) : (
          <StatusBadge
            status={parcel.status}
            manual={parcel.manual_status !== null && parcel.manual_status !== undefined}
          />
        )}
      </span>
    </Link>
  );
}
