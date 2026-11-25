import { afterEach, describe, expect, it, vi } from "vitest";
import { uiLocale } from "../lib/locale";
import { de } from "./de";
import { browserLanguage } from "./language";
import { en } from "./messages";

type Tree = Readonly<Record<string, unknown>>;

/** Every leaf as "path: kind", so both languages can be compared key by key. */
function leaves(tree: Tree, prefix = ""): string[] {
  return Object.entries(tree).flatMap(([key, value]) => {
    const path = `${prefix}${key}`;
    if (typeof value === "object" && value !== null) return leaves(value as Tree, `${path}.`);
    return [`${path}: ${typeof value}`];
  });
}

/** Every text, with functions called with sample values. */
function texts(tree: Tree): string[] {
  return Object.values(tree).flatMap((value): string[] => {
    if (typeof value === "string") return [value];
    if (typeof value === "function") {
      const call = value as (...args: unknown[]) => unknown;
      const result = call(...Array.from({ length: call.length }, () => 2));
      return [String(result)];
    }
    return typeof value === "object" && value !== null ? texts(value as Tree) : [];
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  localStorage.clear();
});

describe("the dictionaries", () => {
  it("have the same texts in English and German", () => {
    expect(leaves(de)).toEqual(leaves(en));
  });

  it("have no empty text", () => {
    for (const text of [...texts(en), ...texts(de)]) {
      expect(text.trim()).not.toBe("");
    }
  });
});

describe("the language", () => {
  it("follows the first supported language the browser asks for", () => {
    expect(browserLanguage(["fr-FR", "de-AT", "en"], "en-US")).toBe("de");
    expect(browserLanguage(["en-US"], "de-DE")).toBe("en");
    expect(browserLanguage([], "de-DE")).toBe("de");
    expect(browserLanguage(["fr"], "it-IT")).toBe("en");
  });

  it("formats in the UI language with the system's region", () => {
    expect(uiLocale("de", "DE")).toBe("de-DE");
    expect(uiLocale("en", "DE")).toBe("en-DE");
    expect(uiLocale("en", undefined)).toBe("en");
  });

  it("uses the language picked in the settings over the browser's", async () => {
    localStorage.setItem("open-parcels.language", "de");
    const { t, LANGUAGE } = await import("./index");
    expect(LANGUAGE).toBe("de");
    expect(t.shell.nav.parcels).toBe("Pakete");
    const { STATUS_LABELS } = await import("../lib/format");
    expect(STATUS_LABELS.delivered).toBe("Zugestellt");
  });
});
