import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  deleteApiV1SettingsConfigKey,
  getApiV1SettingsConfig,
  patchApiV1SettingsConfig,
  type GetApiV1SettingsConfig200Item,
  type GetApiV1SettingsConfig200ItemGroup as ServerSettingGroup,
} from "../api/generated";
import { t } from "../i18n";
import { mapLayersKey } from "../map/layers";

export type ServerSetting = GetApiV1SettingsConfig200Item;
export type ServerSettingValue = string | number | boolean;

const serverSettingsKey = ["settings", "config"] as const;

/** The passwords' group: edited on the Security card, not the generic editor. */
export const SECURITY_GROUP: ServerSettingGroup = "security";

export function useServerSettings() {
  return useQuery({
    queryKey: serverSettingsKey,
    queryFn: ({ signal }) => getApiV1SettingsConfig({ signal }),
  });
}

export function useSaveServerSetting() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (change: { readonly key: string; readonly value: ServerSettingValue }) =>
      patchApiV1SettingsConfig({ [change.key]: change.value }),
    onSuccess: (list) => {
      client.setQueryData(serverSettingsKey, list);
      // Map defaults and the custom provider change the layer list.
      void client.invalidateQueries({ queryKey: mapLayersKey });
    },
  });
}

export function useResetServerSetting() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (key: string) => deleteApiV1SettingsConfigKey(key),
    onSuccess: (list) => {
      client.setQueryData(serverSettingsKey, list);
      // Map defaults and the custom provider change the layer list.
      void client.invalidateQueries({ queryKey: mapLayersKey });
    },
  });
}

/** Settings by group, in the order the server lists them. */
export function groupSettings(
  settings: readonly ServerSetting[],
): [ServerSettingGroup, ServerSetting[]][] {
  const groups = new Map<ServerSettingGroup, ServerSetting[]>();
  for (const setting of settings) {
    const group = groups.get(setting.group) ?? [];
    group.push(setting);
    groups.set(setting.group, group);
  }
  return [...groups];
}

/** The key without its OPENPARCELS_ prefix, for display. */
export const shortKey = (key: string): string => key.replace(/^OPENPARCELS_/, "");

export function formatValue(value: ServerSettingValue | null): string {
  if (value === null) return t.settings.server.unset;
  if (typeof value === "boolean") return value ? t.settings.server.on : t.settings.server.off;
  return String(value);
}

/** Turns the editor's text back into the setting's type; null when it is not one. */
export function fromText(setting: ServerSetting, text: string): ServerSettingValue | null {
  // A secret is kept as typed: a space may be part of it (OP-152).
  const trimmed = setting.secret ? text : text.trim();
  if (trimmed.length === 0) return null;
  if (setting.kind === "boolean") return trimmed === "true";
  if (setting.kind === "number") {
    const number = Number(trimmed);
    return Number.isFinite(number) ? number : null;
  }
  return trimmed;
}

export const SOURCE_LABELS: Readonly<Record<ServerSetting["source"], string>> =
  t.settings.server.sources;

export const APPLY_LABELS: Readonly<Record<ServerSetting["apply"], string>> =
  t.settings.server.apply;
