import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import {
  deleteApiV1SettingsHome,
  getApiV1Geocode,
  getApiV1Settings,
  putApiV1SettingsHome,
  putApiV1SettingsParcelLabel,
} from "../api/generated";
import { keys } from "../api/queries";
import type { LatLngTuple } from "../lib/geo";

export const settingsKey = ["settings"] as const;

/** One read of the settings, shared by every hook that needs a part of them. */
const settingsQuery = {
  queryKey: settingsKey,
  queryFn: ({ signal }: { readonly signal: AbortSignal }) => getApiV1Settings({ signal }),
  staleTime: 5 * 60_000,
};

export interface Home {
  readonly point: LatLngTuple;
  readonly label: string | null;
}

/** The home location set on the Settings page, or null. Read by the maps and distances. */
export function useHome(): { readonly home: Home | null; readonly loading: boolean } {
  const query = useQuery(settingsQuery);
  const home = query.data?.home;
  // The same object until the stored home changes, so maps derived from it are not redrawn on
  // every render (OP-149).
  const value = useMemo<Home | null>(
    () =>
      home === null || home === undefined
        ? null
        : { point: [home.latitude, home.longitude], label: home.label },
    [home],
  );
  return { home: value, loading: query.isPending };
}

export function useSaveHome() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (home: Home) =>
      putApiV1SettingsHome({
        latitude: home.point[0],
        longitude: home.point[1],
        label: home.label,
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: settingsKey }),
  });
}

export function useClearHome() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => deleteApiV1SettingsHome(),
    onSuccess: () => client.invalidateQueries({ queryKey: settingsKey }),
  });
}

/** Address search through the server (OpenStreetMap Nominatim). */
export function searchPlaces(text: string, signal?: AbortSignal) {
  return getApiV1Geocode({ q: text }, signal === undefined ? {} : { signal });
}

export type ParcelLabelMode = "tracking_number" | "items";

/** How parcels without a label are named; "tracking_number" until the settings arrive. */
export function useParcelLabel(): ParcelLabelMode {
  return useQuery(settingsQuery).data?.parcel_label ?? "tracking_number";
}

export function useSaveParcelLabel() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (mode: ParcelLabelMode) => putApiV1SettingsParcelLabel({ parcel_label: mode }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: settingsKey });
      // Every parcel's name may change.
      await client.invalidateQueries({ queryKey: keys.parcels });
    },
  });
}
