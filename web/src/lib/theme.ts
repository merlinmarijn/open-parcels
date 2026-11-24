import { useEffect, useSyncExternalStore } from "react";

export type ThemeChoice = "system" | "dark" | "light";

const STORAGE_KEY = "open-parcels.theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

function stored(): ThemeChoice {
  const value = localStorage.getItem(STORAGE_KEY);
  return value === "dark" || value === "light" ? value : "system";
}

/**
 * One store for the choice, so every reader (the header switch, the maps) sees a change at once
 * instead of only on its next render (OP-150).
 */
let current: ThemeChoice | null = null;
const listeners = new Set<() => void>();

function choice(): ThemeChoice {
  current ??= stored();
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Puts the choice on the page (the styles read `data-theme`) and remembers it. */
function apply(next: ThemeChoice): void {
  if (next === "system") {
    delete document.documentElement.dataset["theme"];
    localStorage.removeItem(STORAGE_KEY);
  } else {
    document.documentElement.dataset["theme"] = next;
    localStorage.setItem(STORAGE_KEY, next);
  }
}

function choose(next: ThemeChoice): void {
  current = next;
  apply(next);
  for (const listener of listeners) listener();
}

/** The theme preference (not a secret) is the only thing the UI keeps in local storage. */
export function useTheme(): [ThemeChoice, (choice: ThemeChoice) => void] {
  const chosen = useSyncExternalStore(subscribe, choice);
  useEffect(() => {
    apply(chosen);
  }, [chosen]);
  return [chosen, choose];
}

function subscribeDevice(listener: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => undefined;
  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener("change", listener);
  return () => {
    query.removeEventListener("change", listener);
  };
}

function deviceDark(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(DARK_QUERY).matches;
}

/** The mode in effect: the chosen one, or the device's while the choice is "system". */
export function useResolvedMode(): "dark" | "light" {
  const chosen = useSyncExternalStore(subscribe, choice);
  const dark = useSyncExternalStore(subscribeDevice, deviceDark);
  if (chosen === "system") return dark ? "dark" : "light";
  return chosen;
}
