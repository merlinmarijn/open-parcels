// The gate cannot see CSS: a class name with no rule renders as unstyled browser default.
/// <reference types="node" />
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Read from disk: with `css: false` the test run turns every CSS import into an empty module,
// so the glob only names the files.
const styles = Object.keys(import.meta.glob("../**/*.css"))
  .map((file) => readFileSync(path.join(import.meta.dirname, file), "utf8"))
  .join("\n");

const sources = import.meta.glob<string>(["../**/*.tsx", "!../**/*.test.tsx"], {
  query: "?raw",
  import: "default",
  eager: true,
});

function cssClasses(css: string): Set<string> {
  const withoutComments = css.replaceAll(/\/\*[\s\S]*?\*\//g, "");
  return new Set([...withoutComments.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1] ?? ""));
}

describe("the style sheets", () => {
  it("has a rule for every literal class name in the components", () => {
    const defined = cssClasses(styles);
    const missing = Object.entries(sources).flatMap(([file, source]) =>
      [...source.matchAll(/className="([^"]*)"/g)]
        .flatMap((m) => (m[1] ?? "").split(/\s+/))
        .filter((name) => name !== "" && !defined.has(name))
        .map((name) => `${file}: ${name}`),
    );
    expect(missing).toEqual([]);
  });
});
