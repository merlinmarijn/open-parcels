import type L from "leaflet";
import { Search, X } from "lucide-react";
import { useMemo, useState, type ReactNode, type SyntheticEvent } from "react";
import { Marker, useMapEvents } from "react-leaflet";
import { ErrorNotice, ReadOnlyHint, Spinner, errorMessage } from "../components/ui";
import { chooseLanguage, LANGUAGES, storedLanguageChoice, t, type LanguageChoice } from "../i18n";
import { formatLatLng, parseLatLng, type LatLngTuple } from "../lib/geo";
import { iconHome } from "../map/mapIcons";
import { SharedMap } from "../map/SharedMap";
import {
  searchPlaces,
  useClearHome,
  useHome,
  useParcelLabel,
  useSaveHome,
  useSaveParcelLabel,
  type Home,
  type ParcelLabelMode,
} from "./home";
import { useIsAdmin } from "../auth/session";
import { BackupCard } from "./BackupCard";
import { DataCard } from "./DataCard";
import { ServerSettingsCards } from "./ServerSettings";
import "./settings.css";

interface Place {
  readonly label: string;
  readonly latitude: number;
  readonly longitude: number;
}

/** Clicking the map moves the home there. */
function ClickToPlace({ onPlace }: { readonly onPlace: (point: LatLngTuple) => void }): null {
  useMapEvents({
    click: (event) => {
      onPlace([event.latlng.lat, event.latlng.lng]);
    },
  });
  return null;
}

function HomeSection(): ReactNode {
  const admin = useIsAdmin();
  const { home, loading } = useHome();
  const save = useSaveHome();
  const clear = useClearHome();
  const [text, setText] = useState<string | null>(null);
  const [places, setPlaces] = useState<readonly Place[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const shown = text ?? (home === null ? "" : (home.label ?? formatLatLng(home.point)));
  const point = home?.point ?? null;
  const bounds = useMemo(() => (point === null ? undefined : [point]), [point]);

  const place = (next: Home): void => {
    setPlaces(null);
    setText(null);
    save.mutate(next);
  };

  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    const value = shown.trim();
    if (value.length === 0) return;
    const coordinates = parseLatLng(value);
    if (coordinates !== null) {
      place({ point: coordinates, label: null });
      return;
    }
    setSearching(true);
    setSearchError(null);
    searchPlaces(value)
      .then((found) => {
        if (found.length === 1 && found[0] !== undefined) {
          place({ point: [found[0].latitude, found[0].longitude], label: found[0].label });
        } else {
          setPlaces(found);
        }
      })
      .catch((error: unknown) => {
        setSearchError(errorMessage(error));
      })
      .finally(() => {
        setSearching(false);
      });
  };

  if (loading) return <Spinner />;
  return (
    <section className="card stack" aria-labelledby="home-title">
      <h2 id="home-title">{t.settings.home.title}</h2>
      <p className="muted">
        {t.settings.home.intro}
        {admin ? t.settings.home.introAdmin : null}
      </p>
      {admin ? null : <ReadOnlyHint />}
      {admin ? (
        <form className="search-row" onSubmit={submit}>
          <div className="input-with-clear">
            <input
              aria-label={t.settings.home.inputLabel}
              value={shown}
              placeholder={t.settings.home.placeholder}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => {
                setText(e.target.value);
                setPlaces(null);
              }}
            />
            {shown.length > 0 ? (
              <button
                type="button"
                className="clear-button"
                aria-label={t.settings.home.clear}
                onClick={() => {
                  setText("");
                  setPlaces(null);
                  setSearchError(null);
                }}
              >
                <X size={16} aria-hidden="true" />
              </button>
            ) : null}
          </div>
          <button type="submit" className="button primary" disabled={searching || save.isPending}>
            <Search size={16} aria-hidden="true" />{" "}
            {searching ? t.settings.home.searching : t.settings.home.find}
          </button>
        </form>
      ) : null}
      {admin ? (
        // Nominatim's usage policy asks for the ODbL credit wherever its results are shown; the
        // search runs only when the form is submitted, never while typing.
        <p className="muted">
          {t.settings.home.attribution}{" "}
          <a
            href="https://www.openstreetmap.org/copyright"
            target="_blank"
            rel="noreferrer noopener"
          >
            {t.settings.home.osmContributors}
          </a>
          {t.settings.home.license}
        </p>
      ) : null}
      {/* Announced and styled like every other error (OP-157). */}
      {searchError === null ? null : (
        <p role="alert" className="notice notice-error">
          {searchError}
        </p>
      )}
      {places === null ? null : places.length === 0 ? (
        <p className="muted">{t.settings.home.nothingFound}</p>
      ) : (
        <ul className="place-results" aria-label={t.settings.home.placesFound}>
          {places.map((found) => (
            <li key={`${String(found.latitude)},${String(found.longitude)}`}>
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  place({ point: [found.latitude, found.longitude], label: found.label });
                }}
              >
                {found.label}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="settings-map">
        <SharedMap
          label={t.settings.home.title}
          {...(point === null ? {} : { center: point, zoom: 16 })}
          {...(bounds === undefined ? {} : { bounds, fitMaxZoom: 17 })}
        >
          {admin ? (
            <ClickToPlace
              onPlace={(clicked) => {
                place({ point: clicked, label: null });
              }}
            />
          ) : null}
          {point === null ? null : (
            <Marker
              position={[point[0], point[1]]}
              icon={iconHome}
              draggable={admin}
              eventHandlers={{
                dragend: (event) => {
                  const { lat, lng } = (event.target as L.Marker).getLatLng();
                  place({ point: [lat, lng], label: null });
                },
              }}
            />
          )}
        </SharedMap>
      </div>
      <p className="muted" role="status" aria-live="polite">
        {save.isPending
          ? t.settings.home.saving
          : point === null
            ? t.settings.home.notSet
            : t.settings.home.saved(formatLatLng(point))}
      </p>
      <ErrorNotice error={save.error ?? clear.error} />
      {home === null || !admin ? null : (
        <div className="actions">
          <button
            type="button"
            className="button danger"
            disabled={clear.isPending}
            onClick={() => {
              setText(null);
              clear.mutate();
            }}
          >
            {t.settings.home.remove}
          </button>
        </div>
      )}
    </section>
  );
}

function LabelSection(): ReactNode {
  const admin = useIsAdmin();
  const mode = useParcelLabel();
  const save = useSaveParcelLabel();
  return (
    <section className="card stack" aria-labelledby="label-title">
      <h2 id="label-title">{t.settings.label.title}</h2>
      <p className="muted">{t.settings.label.intro}</p>
      <label className="field">
        <span>{t.settings.label.nameBy}</span>
        <select
          value={save.isPending ? save.variables : mode}
          disabled={save.isPending || !admin}
          title={admin ? undefined : t.settings.label.adminOnly}
          onChange={(e) => {
            save.mutate(e.target.value as ParcelLabelMode);
          }}
        >
          <option value="tracking_number">{t.settings.label.trackingNumber}</option>
          <option value="items">{t.settings.label.items}</option>
        </select>
      </label>
      <ErrorNotice error={save.error} />
    </section>
  );
}

/** The UI language in this browser; a change reloads the page. */
function LanguageSection(): ReactNode {
  const choice = storedLanguageChoice();
  return (
    <section className="card stack" aria-labelledby="language-title">
      <h2 id="language-title">{t.settings.language.title}</h2>
      <p className="muted">{t.settings.language.intro}</p>
      <label className="field">
        <span>{t.settings.language.label}</span>
        <select
          value={choice}
          onChange={(e) => {
            chooseLanguage(e.target.value as LanguageChoice);
          }}
        >
          <option value="automatic">{t.settings.language.automatic}</option>
          {LANGUAGES.map((language) => (
            <option key={language} value={language} lang={language}>
              {t.settings.language[language]}
            </option>
          ))}
        </select>
      </label>
    </section>
  );
}

export function SettingsPage(): ReactNode {
  const admin = useIsAdmin();
  return (
    <section aria-labelledby="settings-title" className="stack">
      <div className="page-header">
        <h1 id="settings-title">{t.settings.title}</h1>
      </div>
      <div className="settings-grid">
        <HomeSection />
        <LabelSection />
        <LanguageSection />
        {admin ? (
          <>
            <ServerSettingsCards />
            <DataCard />
            <BackupCard />
          </>
        ) : (
          <section className="card stack">
            <h2>{t.settings.serverSettings}</h2>
            <ReadOnlyHint>{t.settings.serverSettingsAdminOnly}</ReadOnlyHint>
          </section>
        )}
      </div>
    </section>
  );
}
