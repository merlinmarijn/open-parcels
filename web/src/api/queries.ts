/**
 * TanStack Query hooks over the generated API functions. Query keys live here so live events and
 * mutations invalidate the same entries.
 */
import {
  hashKey,
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  deleteApiV1OrdersId,
  deleteApiV1ParcelsId,
  deleteApiV1ConnectionsId,
  deleteApiV1LoginsId,
  deleteApiV1TokensId,
  getApiV1Calendar,
  getApiV1Carriers,
  getApiV1InboxForm,
  getApiV1Data,
  getApiV1Diagnostics,
  getApiV1Status,
  getApiV1DataBackups,
  postApiV1DataBackups,
  getApiV1Orders,
  getApiV1OrdersId,
  getApiV1Returns,
  getApiV1Parcels,
  getApiV1ParcelsId,
  getApiV1Connections,
  getApiV1ConnectionsIdData,
  getApiV1Logins,
  getApiV1Tokens,
  patchApiV1OrdersId,
  patchApiV1ParcelsId,
  patchApiV1ConnectionsId,
  postApiV1DataClear,
  postApiV1Parcels,
  postApiV1Connections,
  postApiV1ConnectionsIdClear,
  postApiV1ConnectionsIdSync,
  postApiV1Tokens,
  type PatchApiV1OrdersIdBody,
  type PostApiV1DataClearBody,
  type PatchApiV1ParcelsIdBody,
  type PatchApiV1ConnectionsIdBody,
  type PostApiV1ParcelsBody,
  type PostApiV1ConnectionsBody,
  type PostApiV1TokensBody,
} from "./generated";
import type { OrderView, ParcelDetail, ReturnView } from "./types";

export const keys = {
  parcels: ["parcels"] as const,
  parcelList: (archived: boolean) => ["parcels", "list", { archived }] as const,
  parcel: (id: string) => ["parcels", "one", id] as const,
  orders: ["orders"] as const,
  orderList: (view: OrderView) => ["orders", "list", { view }] as const,
  order: (id: string) => ["orders", "one", id] as const,
  returns: ["returns"] as const,
  returnList: (view: ReturnView) => ["returns", "list", { view }] as const,
  connections: ["connections"] as const,
  signInFlows: (connectionId: string | undefined) => ["sign-in-flows", connectionId] as const,
  carriers: ["carriers"] as const,
  inboxForm: ["inbox-form"] as const,
  tokens: ["tokens"] as const,
  logins: ["logins"] as const,
  calendar: (from: string, to: string) => ["calendar", from, to] as const,
  status: ["status"] as const,
  backups: ["backups"] as const,
  diagnostics: ["diagnostics"] as const,
  data: ["data"] as const,
};

/**
 * Every page of a paged list: the server says a full page may have more after it, so pages are
 * read until one comes back short. Lists are searched and counted in the browser, so a list cut
 * at one page would quietly miss parcels or orders.
 */
export async function allPages<T>(
  limit: number,
  page: (offset: number) => Promise<readonly T[]>,
): Promise<T[]> {
  const all: T[] = [];
  for (let offset = 0; ; offset += limit) {
    const rows = await page(offset);
    all.push(...rows);
    if (rows.length < limit) return all;
  }
}

/** The server's largest pages for these lists. */
const PARCEL_PAGE = 1000;
const ORDER_PAGE = 500;

export function useParcels(includeArchived: boolean) {
  return useQuery({
    queryKey: keys.parcelList(includeArchived),
    queryFn: ({ signal }) =>
      allPages(PARCEL_PAGE, (offset) =>
        getApiV1Parcels(
          {
            limit: PARCEL_PAGE,
            offset,
            ...(includeArchived ? { include_archived: "true" } : {}),
          },
          { signal },
        ),
      ),
    // Switching "Include archived" keeps showing the current list until the other one arrives.
    placeholderData: keepPreviousData,
  });
}

export function useParcel(id: string) {
  return useQuery({
    queryKey: keys.parcel(id),
    queryFn: ({ signal }) => getApiV1ParcelsId(id, { signal }),
  });
}

export function useCarriers() {
  return useQuery({
    queryKey: keys.carriers,
    queryFn: ({ signal }) => getApiV1Carriers({ signal }),
    staleTime: 5 * 60_000,
  });
}

/** The inbox's forms; the server owns them like a provider's (translated, one source). */
export function useInboxForm() {
  return useQuery({
    queryKey: keys.inboxForm,
    queryFn: ({ signal }) => getApiV1InboxForm({ signal }),
    staleTime: 5 * 60_000,
  });
}

export function useConnections() {
  return useQuery({
    queryKey: keys.connections,
    queryFn: ({ signal }) => getApiV1Connections({ signal }),
  });
}

/** Tokens are used by other clients, so "last used" changes without any event: re-read it. */
const TOKENS_REFRESH_MS = 30_000;

/**
 * The interval pauses while the tab is in the background, so coming back to it re-reads at once:
 * TanStack's focus manager reports the tab becoming visible, and the window regaining focus (a
 * visible tab in an unfocused window) is caught here.
 */
export function useTokens() {
  // A tab coming back into view re-reads them through refetchOnWindowFocus.
  return useQuery({
    queryKey: keys.tokens,
    queryFn: ({ signal }) => getApiV1Tokens({ signal }),
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
    refetchInterval: TOKENS_REFRESH_MS,
  });
}

/** The calendar's entries in a range; nothing is asked before the range is known (OP-153). */
export function useCalendar(range: { readonly from: string; readonly to: string } | null) {
  const from = range?.from ?? "";
  const to = range?.to ?? "";
  return useQuery({
    queryKey: keys.calendar(from, to),
    queryFn: ({ signal }) => getApiV1Calendar({ from, to }, { signal }),
    enabled: range !== null,
  });
}

/**
 * Every connection, inbox, the scheduler, the live event stream and backups. Live events about
 * connections and backups refresh it at once; the interval catches the scheduler and inboxes.
 */
export function useStatus() {
  return useQuery({
    queryKey: keys.status,
    queryFn: ({ signal }) => getApiV1Status({ signal }),
    refetchInterval: 30_000,
  });
}

export function useDiagnostics() {
  return useQuery({
    queryKey: keys.diagnostics,
    queryFn: ({ signal }) => getApiV1Diagnostics({ signal }),
  });
}

/**
 * Everything that shows parcels: the lists and details, and the calendar, which must not stay
 * stale after an edit while the live stream is offline.
 */
export async function invalidateParcelViews(
  client: QueryClient,
  except?: readonly unknown[],
): Promise<void> {
  const skipped = except === undefined ? null : hashKey(except);
  await Promise.all([
    client.invalidateQueries({
      queryKey: keys.parcels,
      predicate: (query) => skipped === null || query.queryHash !== skipped,
    }),
    client.invalidateQueries({ queryKey: ["calendar"] }),
    // An order's status and archiving follow its parcels.
    client.invalidateQueries({ queryKey: keys.orders }),
  ]);
}

export function useAddParcel() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: PostApiV1ParcelsBody) => postApiV1Parcels(body),
    onSuccess: () => invalidateParcelViews(client),
  });
}

export function useUpdateParcel(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: PatchApiV1ParcelsIdBody) => patchApiV1ParcelsId(id, body),
    // Edits show at once; a refused one reloads the parcel from the server. Restoring a snapshot
    // instead would also undo another edit that succeeded while this one was pending.
    onMutate: async (body) => {
      await client.cancelQueries({ queryKey: keys.parcel(id) });
      const previous = client.getQueryData<ParcelDetail>(keys.parcel(id));
      if (previous !== undefined) {
        client.setQueryData<ParcelDetail>(keys.parcel(id), {
          ...previous,
          ...(body.label === undefined
            ? {}
            : // Without a label the server names it (code or item names); the code until it answers.
              { label: body.label, display_name: body.label ?? previous.tracking_number }),
          ...(body.manual_status === undefined
            ? {}
            : {
                manual_status: body.manual_status,
                status: body.manual_status ?? previous.carrier_status,
              }),
        });
      }
    },
    onError: () => client.invalidateQueries({ queryKey: keys.parcel(id) }),
    onSuccess: (parcel) => {
      client.setQueryData(keys.parcel(id), parcel);
      return invalidateParcelViews(client);
    },
  });
}

export function useDeleteParcel() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteApiV1ParcelsId(id),
    onSuccess: async (_result, id) => {
      // The lists refresh, but never the deleted parcel's own detail: asking for it again while
      // its page is still open would only get a 404. It is dropped once nothing shows it.
      await client.cancelQueries({ queryKey: keys.parcel(id), exact: true });
      await invalidateParcelViews(client, keys.parcel(id));
    },
  });
}

export function useOrders(view: OrderView) {
  return useQuery({
    queryKey: keys.orderList(view),
    queryFn: ({ signal }) =>
      allPages(ORDER_PAGE, (offset) =>
        getApiV1Orders({ view, limit: ORDER_PAGE, offset }, { signal }),
      ),
    placeholderData: keepPreviousData,
  });
}

export function useReturns(view: ReturnView) {
  return useQuery({
    queryKey: keys.returnList(view),
    queryFn: ({ signal }) => getApiV1Returns({ view }, { signal }),
    placeholderData: keepPreviousData,
  });
}

export function useOrder(id: string) {
  return useQuery({
    queryKey: keys.order(id),
    queryFn: ({ signal }) => getApiV1OrdersId(id, { signal }),
  });
}

export function useUpdateOrder(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: PatchApiV1OrdersIdBody) => patchApiV1OrdersId(id, body),
    onSuccess: (order) => {
      client.setQueryData(keys.order(id), order);
      // Parcels show the order's name.
      return Promise.all([
        client.invalidateQueries({ queryKey: keys.orders }),
        client.invalidateQueries({ queryKey: keys.parcels }),
      ]);
    },
  });
}

export function useDeleteOrder() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteApiV1OrdersId(id),
    onSuccess: async (_result, id) => {
      await client.cancelQueries({ queryKey: keys.order(id), exact: true });
      await Promise.all([
        client.invalidateQueries({
          queryKey: keys.orders,
          predicate: (query) => query.queryHash !== hashKey(keys.order(id)),
        }),
        client.invalidateQueries({ queryKey: keys.parcels }),
      ]);
    },
  });
}

export function useAddConnection() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: PostApiV1ConnectionsBody) => postApiV1Connections(body),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.connections }),
  });
}

export function useUpdateConnection() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: PatchApiV1ConnectionsIdBody }) =>
      patchApiV1ConnectionsId(id, body),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.connections }),
  });
}

export function useDeleteConnection() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteApiV1ConnectionsId(id),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.connections }),
  });
}

/** What clearing a connection would remove, read right before asking the owner. */
export function connectionDataCounts(id: string) {
  return getApiV1ConnectionsIdData(id);
}

/** Removes everything a connection imported; parcels, orders and the calendar reload after. */
export function useClearConnection() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => postApiV1ConnectionsIdClear(id),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: keys.connections }),
        client.invalidateQueries({ queryKey: keys.parcels }),
        client.invalidateQueries({ queryKey: keys.orders }),
        client.invalidateQueries({ queryKey: ["calendar"] }),
      ]);
    },
  });
}

/** Counts and sizes for the Data page (admin only). */
export function useDataSummary() {
  return useQuery({
    queryKey: keys.data,
    queryFn: ({ signal }) => getApiV1Data({ signal }),
  });
}

/** The backup schedule, the newest result and the backups kept (admin only). */
export function useBackups() {
  return useQuery({
    queryKey: keys.backups,
    queryFn: ({ signal }) => getApiV1DataBackups({ signal }),
  });
}

/** "Back up now"; the live event `backup.finished` refreshes the card and the status page too. */
export function useBackupNow() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => postApiV1DataBackups(),
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: keys.backups }),
        client.invalidateQueries({ queryKey: keys.status }),
      ]),
  });
}

/** One of the owner's clean-up actions; everything shown afterwards is read again. */
export function useClearData() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: PostApiV1DataClearBody) => postApiV1DataClear(body),
    onSuccess: () => client.invalidateQueries(),
  });
}

export function useSyncConnection() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => postApiV1ConnectionsIdSync(id),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.connections }),
  });
}

export function useCreateToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: PostApiV1TokensBody) => postApiV1Tokens(body),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.tokens }),
  });
}

export function useRevokeToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteApiV1TokensId(id),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.tokens }),
  });
}

/** Token logins, re-read like the tokens: their "last used" changes without any event. */
export function useLogins() {
  return useQuery({
    queryKey: keys.logins,
    queryFn: ({ signal }) => getApiV1Logins({ signal }),
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    refetchInterval: TOKENS_REFRESH_MS,
  });
}

export function useEndLogin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteApiV1LoginsId(id),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.logins }),
  });
}
