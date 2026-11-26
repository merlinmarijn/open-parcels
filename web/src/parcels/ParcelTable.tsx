import { ItemPictures } from "../components/ItemPictures";
import { Segmented } from "../components/Segmented";
import { Link } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import { useMemo, type ReactNode } from "react";
import { pickOne, useUrlParam } from "../lib/urlState";
import { ParcelCard } from "./ParcelCard";

import type { Parcel } from "../api/types";
import { CarrierLogo } from "../components/CarrierLogo";
import { DataTable } from "../components/DataTable";
import { formatRelative, formatExpected } from "../lib/format";
import { ArchivedBadge, LookupBadge, StatusBadge } from "./badges";
import { t } from "../i18n";

export const PARCEL_FILTERS = ["active", "delivered", "all"] as const;
export type ParcelFilter = (typeof PARCEL_FILTERS)[number];

const FILTER_LABELS: Readonly<Record<ParcelFilter, string>> = {
  active: t.parcels.filterActive,
  delivered: t.parcels.filterDelivered,
  all: t.parcels.filterAll,
};

const VIEWS = ["list", "table"] as const;
type ParcelView = (typeof VIEWS)[number];

const VIEW_LABELS: Readonly<Record<ParcelView, string>> = {
  list: t.parcels.viewList,
  table: t.parcels.viewTable,
};

const column = createColumnHelper<Parcel>();

const COLUMNS = [
  column.accessor((parcel) => parcel.display_name, {
    id: "label",
    header: t.parcels.columnParcel,
    cell: (info) => (
      <Link
        to="/parcels/$parcelId"
        params={{ parcelId: info.row.original.id }}
        className="row-link"
      >
        <CarrierLogo carrier={info.row.original.carrier} size={32} />
        <span className="cell-title">
          <strong>{info.getValue()}</strong>
          {info.row.original.label === null ? null : (
            <span className="mono"> {info.row.original.tracking_number}</span>
          )}
          {info.row.original.archived_at === null ? null : (
            <>
              {" "}
              <ArchivedBadge />
            </>
          )}
        </span>
        <ItemPictures items={info.row.original.items} limit={3} size="small" />
      </Link>
    ),
  }),
  column.accessor("status", {
    header: t.parcels.columnStatus,
    // `status` is already the effective one: a manual status wins on the server.
    cell: (info) => (
      <StatusBadge status={info.getValue()} manual={info.row.original.manual_status !== null} />
    ),
    filterFn: "equalsString",
  }),
  column.accessor((parcel) => parcel.lookup.state, {
    id: "lookup",
    header: t.parcels.columnLookup,
    cell: (info) => <LookupBadge state={info.getValue()} />,
  }),
  column.accessor("carrier", { header: t.parcels.columnCarrier }),
  column.accessor((parcel) => parcel.expected_from ?? parcel.expected_to ?? "", {
    id: "eta",
    header: t.parcels.columnEta,
    cell: (info) => formatExpected(info.row.original),
  }),
  column.accessor("updated_at", {
    header: t.parcels.columnUpdated,
    cell: (info) => <time dateTime={info.getValue()}>{formatRelative(info.getValue())}</time>,
  }),
];

function matchesFilter(parcel: Parcel, filter: ParcelFilter): boolean {
  if (filter === "all") {
    return true;
  }
  return filter === "delivered" ? parcel.delivered : !parcel.delivered;
}

function renderCard(parcel: Parcel): ReactNode {
  return <ParcelCard parcel={parcel} />;
}

/**
 * The parcel list, as rich rows or (`?view=table`) a sortable table. The Show filter is owned by the page, so it survives the table being
 * re-rendered with another data set (archived parcels included or not).
 */
export function ParcelTable(props: {
  readonly parcels: Parcel[];
  readonly filter: ParcelFilter;
  readonly onFilterChange: (filter: ParcelFilter) => void;
}): ReactNode {
  const { filter, onFilterChange: setFilter } = props;
  const [carrierParam, setCarrierParam] = useUrlParam("carrier");
  const carrier = carrierParam?.toLowerCase() ?? "";
  const [viewParam, setViewParam] = useUrlParam("view");
  const view = pickOne(viewParam, VIEWS, "list");
  const setCarrier = (value: string): void => {
    setCarrierParam(value === "" ? null : value);
  };
  const carriers = useMemo(
    () => [...new Set(props.parcels.map((parcel) => parcel.carrier))].sort(),
    [props.parcels],
  );
  const rows = useMemo(
    () =>
      props.parcels.filter(
        (parcel) => matchesFilter(parcel, filter) && (carrier === "" || parcel.carrier === carrier),
      ),
    [props.parcels, filter, carrier],
  );

  const controls = (
    <>
      <Segmented
        legend={t.parcels.show}
        name="parcel-filter"
        options={(["active", "delivered", "all"] as const).map((value) => ({
          value,
          label: FILTER_LABELS[value],
        }))}
        value={filter}
        onChange={setFilter}
      />
      <label>
        <span className="visually-hidden">{t.parcels.carrier}</span>
        <select
          value={carrier}
          onChange={(e) => {
            setCarrier(e.target.value);
          }}
        >
          <option value="">{t.parcels.allCarriers}</option>
          {carriers.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </label>
      <Segmented
        legend={t.parcels.view}
        name="parcel-view"
        options={VIEWS.map((value) => ({ value, label: VIEW_LABELS[value] }))}
        value={view}
        onChange={(next) => {
          setViewParam(next === "list" ? null : next);
        }}
      />
    </>
  );

  return (
    <DataTable
      caption={t.parcels.title}
      columns={COLUMNS}
      data={rows}
      searchLabel={t.parcels.searchParcels}
      extraControls={controls}
      defaultSort={[{ id: "updated_at", desc: true }]}
      urlKeys={{ search: "q", sort: "sort" }}
      emptyText={filter === "active" ? t.parcels.noneOnTheWay : t.parcels.none}
      rowClassName={(parcel) => (parcel.lookup.state === "not_found" ? "row-warning" : undefined)}
      {...(view === "list" ? { renderItem: renderCard } : {})}
    />
  );
}
