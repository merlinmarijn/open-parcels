import { admin } from "./de/admin";
import { calendar } from "./de/calendar";
import { common } from "./de/common";
import { connections } from "./de/connections";
import { errors } from "./de/errors";
import { map } from "./de/map";
import { orders } from "./de/orders";
import { parcels } from "./de/parcels";
import { returns } from "./de/returns";
import { settings } from "./de/settings";
import { shell } from "./de/shell";
import type { Messages } from "./messages";

/** German texts. UI terms follow the German column of `docs/glossary.md`. */
export const de: Messages = {
  common,
  shell,
  parcels,
  connections,
  settings,
  admin,
  orders,
  returns,
  calendar,
  map,
  errors,
};
