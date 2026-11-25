import type { Messages } from "../messages";

/** FullCalendar's own texts (Today, Month, …) come from its locale, picked by UI_LOCALE. */
export const calendar: Messages["calendar"] = {
  title: "Kalender",
  returnBy: (title) => `Zurücksenden bis: ${title}`,
};
