import type { ReactNode } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { t } from "../i18n";
import { NARROW, useMediaQuery } from "../lib/media";
import "./split.css";

/**
 * Two panels side by side with a draggable divider. On narrow screens the panels stack instead,
 * first panel on top.
 */
export function SplitContainer(props: {
  readonly leftPanel: ReactNode;
  readonly rightPanel: ReactNode;
  readonly leftDefaultSize?: number;
  readonly rightDefaultSize?: number;
  readonly leftMinSize?: number;
  readonly rightMinSize?: number;
}): ReactNode {
  const narrow = useMediaQuery(NARROW);
  if (narrow) {
    return (
      <div className="stacked">
        {props.leftPanel}
        {props.rightPanel}
      </div>
    );
  }
  return (
    <Group orientation="horizontal" style={{ height: "100%", width: "100%" }}>
      <Panel defaultSize={props.leftDefaultSize ?? 40} minSize={props.leftMinSize ?? 20}>
        {props.leftPanel}
      </Panel>
      <Separator className="split-handle" aria-label={t.common.resizePanels} />
      <Panel defaultSize={props.rightDefaultSize ?? 60} minSize={props.rightMinSize ?? 30}>
        {props.rightPanel}
      </Panel>
    </Group>
  );
}
