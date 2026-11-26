import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type Row,
  type Table,
  type SortingState,
  type Updater,
} from "@tanstack/react-table";
import { ChevronDown, ChevronsUpDown, ChevronUp, Search } from "lucide-react";
import { useId, type ReactNode } from "react";
import { useUrlParam } from "../lib/urlState";
import { t } from "../i18n";
import { useShowMore } from "./ShowMore";
import "./data-table.css";

export interface DataTableProps<TData> {
  /** Column definitions; build them with `createColumnHelper<TData>()`. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TanStack's column helper yields ColumnDef<T, any>; the value type differs per column.
  readonly columns: ColumnDef<TData, any>[];
  readonly data: TData[];
  readonly caption: string;
  readonly emptyText?: string;
  readonly searchLabel?: string;
  /** Controls placed beside the search box, such as filters. */
  readonly extraControls?: ReactNode;
  readonly defaultSort?: SortingState;
  /** Keep search and sorting in the address under these keys (`?q=…&sort=-column`). */
  readonly urlKeys: { readonly search: string; readonly sort: string };
  readonly rowClassName?: (row: TData) => string | undefined;
  /** Draws each row as a list entry instead of a table row; search, sort and paging stay. */
  readonly renderItem?: (row: TData) => ReactNode;
}

/** `-updated_at,label` → updated_at descending, then label ascending; unknown columns are dropped. */
function parseSort(raw: string | null, ids: ReadonlySet<string | undefined>): SortingState | null {
  if (raw === null) return null;
  if (raw === "none") return [];
  const sorting = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map((part) => ({ id: part.replace(/^-/, ""), desc: part.startsWith("-") }))
    .filter((entry) => ids.has(entry.id));
  return sorting.length === 0 ? null : sorting;
}

/** Empty sorting is written as "none" so it stays empty instead of falling back to the default. */
function formatSort(sorting: SortingState): string {
  return sorting.length === 0
    ? "none"
    : sorting.map((entry) => `${entry.desc ? "-" : ""}${entry.id}`).join(",");
}

function SortIcon({ sorted }: { readonly sorted: false | "asc" | "desc" }): ReactNode {
  if (sorted === false) {
    return <ChevronsUpDown size={12} className="sort-icon" aria-hidden="true" />;
  }
  const Icon = sorted === "asc" ? ChevronUp : ChevronDown;
  return <Icon size={12} className="sort-icon active" aria-hidden="true" />;
}

/** A sortable, searchable table built on TanStack Table. Headers are buttons, so sorting works by keyboard. */
export function DataTable<TData>(props: DataTableProps<TData>): ReactNode {
  const [sortParam, setSortParam] = useUrlParam(props.urlKeys.sort);
  const [searchParam, setSearchParam] = useUrlParam(props.urlKeys.search);
  const ids = new Set(props.columns.map((column) => column.id));
  const sorting = parseSort(sortParam, ids) ?? props.defaultSort ?? [];
  const filter = searchParam ?? "";
  const setSorting = (updater: Updater<SortingState>): void => {
    const next = typeof updater === "function" ? updater(sorting) : updater;
    setSortParam(formatSort(next));
  };
  const setFilter = (updater: Updater<string>): void => {
    setSearchParam(typeof updater === "function" ? updater(filter) : updater);
  };
  const searchId = useId();
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table returns fresh functions on purpose.
  const table = useReactTable({
    data: props.data,
    columns: props.columns,
    state: { sorting, globalFilter: filter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });
  const rows = table.getRowModel().rows;
  const { visible, more } = useShowMore(rows, `${filter}|${formatSort(sorting)}`);
  const empty = filter === "" ? (props.emptyText ?? t.common.nothingYet) : t.common.nothingMatches;

  return (
    <div className="data-table">
      <div className="table-toolbar">
        <label htmlFor={searchId} className="visually-hidden">
          {props.searchLabel ?? t.common.search}
        </label>
        <div className="search-wrap">
          <Search size={14} aria-hidden="true" />
          <input
            id={searchId}
            type="search"
            placeholder={`${props.searchLabel ?? t.common.search}…`}
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
            }}
          />
        </div>
        {props.extraControls}
        <span className="count" aria-live="polite">
          {t.common.countOf(rows.length, props.data.length)}
        </span>
      </div>
      {props.renderItem === undefined ? (
        <TableBody table={table} visible={visible} empty={empty} {...props} />
      ) : visible.length === 0 ? (
        <p className="row-list empty">{empty}</p>
      ) : (
        <ul className="row-list" aria-label={props.caption}>
          {visible.map((row) => (
            <li key={row.id} className={props.rowClassName?.(row.original)}>
              {props.renderItem?.(row.original)}
            </li>
          ))}
        </ul>
      )}
      {more}
    </div>
  );
}

/** The table itself: sortable headers, then the rows drawn so far. */
function TableBody<TData>(
  props: DataTableProps<TData> & {
    readonly table: Table<TData>;
    readonly visible: readonly Row<TData>[];
    readonly empty: string;
  },
): ReactNode {
  return (
    <div className="table-scroll glass-panel">
      <table>
        <caption className="visually-hidden">{props.caption}</caption>
        <thead>
          {props.table.getHeaderGroups().map((group) => (
            <tr key={group.id}>
              {group.headers.map((header) => {
                const sorted = header.column.getIsSorted();
                const ariaSort =
                  sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none";
                return (
                  <th key={header.id} scope="col" aria-sort={ariaSort}>
                    {header.isPlaceholder ? null : header.column.getCanSort() ? (
                      <button
                        type="button"
                        className="sort-button"
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        <SortIcon sorted={sorted} />
                      </button>
                    ) : (
                      flexRender(header.column.columnDef.header, header.getContext())
                    )}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {props.visible.length === 0 ? (
            <tr>
              <td colSpan={props.columns.length} className="muted empty">
                {props.empty}
              </td>
            </tr>
          ) : (
            props.visible.map((row) => (
              <tr key={row.id} className={props.rowClassName?.(row.original)}>
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
