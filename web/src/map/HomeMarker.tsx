import type { ReactNode } from "react";
import { Marker, Popup } from "react-leaflet";
import { t } from "../i18n";
import { iconHome } from "./mapIcons";

/** The home place on a map: below every other marker, its label in the popup. */
export function HomeMarker(props: {
  readonly point: readonly [number, number];
  readonly label: string | null | undefined;
}): ReactNode {
  return (
    <Marker
      position={[props.point[0], props.point[1]]}
      icon={iconHome}
      title={t.map.home}
      zIndexOffset={-100}
    >
      <Popup>
        <div className="popup-content">
          <strong>{t.map.home}</strong>
          {props.label === null || props.label === undefined ? null : (
            <span className="muted">{props.label}</span>
          )}
        </div>
      </Popup>
    </Marker>
  );
}
