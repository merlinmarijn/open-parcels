import { useSyncExternalStore } from "react";

/** Phones and small tablets: the bottom tab bar instead of the sidebar, panels stacked. */
export const NARROW = "(max-width: 899px)";

/** Whether a media query matches, kept up to date. False where there is no matchMedia (tests). */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window.matchMedia !== "function") return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => {
        list.removeEventListener("change", onChange);
      };
    },
    () => typeof window.matchMedia === "function" && window.matchMedia(query).matches,
    () => false,
  );
}
