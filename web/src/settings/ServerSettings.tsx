import { RotateCcw, Save } from "lucide-react";
import { useState, type ReactNode, type SyntheticEvent } from "react";
import { ErrorNotice, Spinner } from "../components/ui";
import { t } from "../i18n";
import { FALLBACK_LAYER, useMapLayers } from "../map/layers";
import { SharedMap } from "../map/SharedMap";
import { SecurityCard } from "./SecurityCard";
import {
  APPLY_LABELS,
  formatValue,
  fromText,
  groupSettings,
  SECURITY_GROUP,
  shortKey,
  SOURCE_LABELS,
  useResetServerSetting,
  useSaveServerSetting,
  useServerSettings,
  type ServerSetting,
} from "./server-settings";

function Editor(props: {
  readonly setting: ServerSetting;
  readonly text: string;
  readonly onText: (text: string) => void;
}): ReactNode {
  const { setting, text, onText } = props;
  const label = t.settings.server.valueLabel(shortKey(setting.key));
  if (setting.kind === "boolean") {
    return (
      <select
        aria-label={label}
        value={text}
        onChange={(e) => {
          onText(e.target.value);
        }}
      >
        {/* Without a value nothing is chosen yet, so choosing "on" is a change (OP-152). */}
        {text === "" ? <option value="">{t.settings.server.unset}</option> : null}
        <option value="true">{t.settings.server.on}</option>
        <option value="false">{t.settings.server.off}</option>
      </select>
    );
  }
  if (setting.choices !== null) {
    return (
      <select
        aria-label={label}
        value={text}
        onChange={(e) => {
          onText(e.target.value);
        }}
      >
        {setting.choices.map((choice) => (
          <option key={choice} value={choice}>
            {choice}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      aria-label={label}
      type={setting.secret ? "password" : setting.kind === "number" ? "number" : "text"}
      value={text}
      placeholder={
        setting.secret
          ? setting.set
            ? t.settings.server.setTypeToReplace
            : t.settings.server.unset
          : formatValue(setting.default)
      }
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => {
        onText(e.target.value);
      }}
    />
  );
}

function SettingRow({ setting }: { readonly setting: ServerSetting }): ReactNode {
  const save = useSaveServerSetting();
  const reset = useResetServerSetting();
  const current = setting.value === null ? "" : String(setting.value);
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? current;
  const value = fromText(setting, shown);
  // A secret saved in the UI is write-only: the box starts empty and a new value replaces it.
  const editable = setting.apply !== "env";
  const busy = save.isPending || reset.isPending;

  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    if (value === null) return;
    save.mutate(
      { key: setting.key, value },
      {
        onSuccess: () => {
          setText(null);
        },
      },
    );
  };

  return (
    <li className="setting">
      <div className="setting-head">
        <code className="setting-key" title={setting.key}>
          {shortKey(setting.key)}
        </code>
        <span className={`badge setting-source-${setting.source}`}>
          {SOURCE_LABELS[setting.source]}
        </span>
        <span className={`badge setting-apply-${setting.apply}`}>
          {APPLY_LABELS[setting.apply]}
        </span>
        {setting.pending_restart ? (
          <span className="badge setting-pending">{t.settings.server.pendingRestart}</span>
        ) : null}
      </div>
      <p className="muted setting-description">{setting.description}</p>
      {setting.secret ? (
        <p className="setting-values muted">
          {setting.set ? t.settings.server.secretSet : t.settings.server.secretNotSet}
        </p>
      ) : (
        <p className="setting-values muted">
          {t.settings.server.current} <strong>{formatValue(setting.value)}</strong>{" "}
          {t.settings.server.defaultIs} {formatValue(setting.default)}
        </p>
      )}
      {editable ? (
        <form className="setting-edit" onSubmit={submit}>
          <Editor setting={setting} text={shown} onText={setText} />
          <button
            type="submit"
            className="button primary"
            disabled={busy || value === null || shown === current}
            aria-label={t.settings.server.saveLabel(shortKey(setting.key))}
          >
            <Save size={14} aria-hidden="true" /> {t.settings.server.save}
          </button>
          {setting.source === "override" ? (
            <button
              type="button"
              className="button"
              disabled={busy}
              aria-label={t.settings.server.resetLabel(shortKey(setting.key))}
              title={t.settings.server.resetTitle}
              onClick={() => {
                reset.mutate(setting.key, {
                  onSuccess: () => {
                    setText(null);
                  },
                });
              }}
            >
              <RotateCcw size={14} aria-hidden="true" /> {t.settings.server.reset}
            </button>
          ) : null}
        </form>
      ) : null}
      <ErrorNotice error={save.error ?? reset.error} />
    </li>
  );
}

/** The default style as saved, on a small map. */
function MapPreview({ settings }: { readonly settings: readonly ServerSetting[] }): ReactNode {
  const query = useMapLayers();
  const layers = query.data?.layers ?? [FALLBACK_LAYER];
  const value = (key: string): unknown => settings.find((s) => s.key === key)?.value;
  const base =
    layers.find((l) => l.kind === "base" && l.id === value("OPENPARCELS_MAP_BASE_LAYER")) ??
    layers.find((l) => l.id === query.data?.default_base) ??
    FALLBACK_LAYER;
  const overlay =
    layers.find((l) => l.kind === "overlay" && l.id === value("OPENPARCELS_MAP_OVERLAY")) ?? null;
  return (
    <div className="settings-map">
      <SharedMap label={t.settings.server.mapPreview} zoom={4} style={{ base, overlay }} />
    </div>
  );
}

/** One card per group of OPENPARCELS_* settings; admin only. */
export function ServerSettingsCards(): ReactNode {
  const query = useServerSettings();
  if (query.isPending) return <Spinner />;
  if (query.isError) return <ErrorNotice error={query.error} />;
  return groupSettings(query.data).map(([group, settings]) => {
    if (group === SECURITY_GROUP) return <SecurityCard key={group} settings={settings} />;
    const id = `settings-group-${group.toLowerCase().replace(/\W+/g, "-")}`;
    return (
      <section key={group} className="card stack" aria-labelledby={id}>
        <h2 id={id}>{group}</h2>
        <ul className="setting-list">
          {settings.map((setting) => (
            <SettingRow key={setting.key} setting={setting} />
          ))}
        </ul>
        {group === "Map" ? <MapPreview settings={settings} /> : null}
      </section>
    );
  });
}
