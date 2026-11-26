import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { BUILTIN_CARRIERS } from "../../src/engine/builtin-carriers.js";
import { register } from "../../src/engine/registry.js";
import { defineAction, defineCarrier } from "../../src/provider/api.js";
import { hostMatches, linkUrl, parseManifest } from "../../src/provider/manifest.js";
import { testManifest } from "../manifests.js";

const tracker = defineCarrier({
  id: "tracker",
  configSchema: z.looseObject({}),
  secretSchema: z.null(),
  signIn: { type: "none" },
  http: { limits: { "api.tracker.example": { intervalMs: 1000, burst: 1 } } },
  async track(context) {
    await context.session.save({ seen: true });
    return { snapshots: [], complete: true };
  },
});

const allowed = { network: [{ host: ".tracker.example", reason: "Tracking data." }] };

describe("provider manifests", () => {
  it("refuses unknown keys, wildcards and missing reasons", () => {
    const valid = testManifest("tracker", { permissions: allowed });
    expect(parseManifest(valid, "test").id).toBe("tracker");
    expect(() => parseManifest({ ...valid, entry: "dist/x.mjs" }, "test")).toThrow(/entry/);
    for (const network of [
      [{ host: "*", reason: "Everything." }],
      [{ host: ".tracker.example" }],
      [{ host: "https://tracker.example", reason: "A URL, not a host." }],
    ]) {
      expect(() =>
        parseManifest({ ...valid, permissions: { ...valid.permissions, network } }, "test"),
      ).toThrow(/permissions\.network/);
    }
  });

  it("matches exact hosts, and suffix patterns on a label boundary only", () => {
    expect(hostMatches(".tracker.example", "tracker.example")).toBe(true);
    expect(hostMatches(".tracker.example", "a.b.tracker.example")).toBe(true);
    expect(hostMatches(".tracker.example", "eviltracker.example")).toBe(false);
    expect(hostMatches("api.tracker.example", "API.tracker.example.")).toBe(true);
    expect(hostMatches("api.tracker.example", "www.tracker.example")).toBe(false);
  });

  it("refuses to register code its manifest does not describe", () => {
    expect(() =>
      register(tracker, testManifest("tracker", { permissions: allowed })),
    ).not.toThrow();
    const cases: [Parameters<typeof testManifest>[1], RegExp][] = [
      [{ permissions: { network: [] } }, /api\.tracker\.example/],
      [{ permissions: { ...allowed, secrets: ["api_key"] } }, /permissions\.secrets/],
      [{ permissions: { ...allowed, user_agent: true } }, /user_agent/],
      [{ permissions: allowed, provides: { live: true } }, /readLive/],
      [{ permissions: allowed, provides: { connections: ["shop", "tracking"] } }, /fetchAccount/],
    ];
    for (const [changes, problem] of cases) {
      expect(() => register(tracker, testManifest("tracker", changes))).toThrow(problem);
    }
    expect(() => register(tracker, testManifest("other", { permissions: allowed }))).toThrow(
      /id is tracker/,
    );
  });

  it("checks actions: valid declarations, tasks that match the code, safe link addresses", () => {
    const valid = testManifest("tracker", { permissions: allowed });
    const link = {
      id: "open",
      kind: "link",
      label: "Open",
      connection_kinds: ["tracking"],
      url: "https://{host}/x",
    };
    const taskAction = { id: "open", kind: "task", label: "Open", connection_kinds: ["tracking"] };
    const parsed = parseManifest({ ...valid, actions: [link] }, "test");
    expect(parsed.actions[0]).toMatchObject({ when_state: ["ok", "idle"] });
    for (const actions of [
      [{ ...link, url: "javascript:alert(1)" }],
      [link, link],
      [{ ...taskAction, weight: "huge" }],
      [{ ...taskAction, url: "https://www.tracker.example/" }],
    ]) {
      expect(() => parseManifest({ ...valid, actions }, "test")).toThrow(/actions/);
    }
    expect(linkUrl(parsed, "https://{host}/x", { host: "www.tracker.example" })).toBe(
      "https://www.tracker.example/x",
    );
    for (const host of ["evil.example", "a@www.tracker.example", undefined]) {
      expect(linkUrl(parsed, "https://{host}/x", { host })).toBeUndefined();
    }
    const task = parseManifest({ ...valid, actions: [taskAction] }, "test");
    expect(() => register(tracker, task)).toThrow(/manifest's tasks \[open\]/);
    const withAction = {
      ...tracker,
      actions: {
        open: defineAction({
          input: z.object({}),
          run: () => Promise.resolve({ status: "done" as const, summary: "" }),
        }),
      },
    };
    expect(() => register(withAction, task)).not.toThrow();
    expect(() => register(withAction, parsed)).toThrow(/manifest's tasks \[\]/);
  });

  it("keeps no session for a provider whose manifest has none", async () => {
    const without = register(tracker, testManifest("tracker", { permissions: allowed }));
    const saved: unknown[] = [];
    const base = {
      connectionId: "c1",
      http: undefined as never,
      clock: { now: () => new Date() },
      logger: { debug: () => undefined, info: () => undefined, warn: () => undefined },
      session: {
        load: () => null,
        save: (value: unknown) => Promise.resolve(void saved.push(value)),
      },
      reportUnknown: () => undefined,
    };
    await expect(without.track(base, {}, null, ["X1"])).rejects.toThrow(/session store/);
    const withSession = register(
      tracker,
      testManifest("tracker", { permissions: { ...allowed, session: true } }),
    );
    await withSession.track(base, {}, null, ["X1"]);
    expect(saved).toEqual([{ seen: true }]);
  });

  it("describes every built-in provider: hosts with reasons, and logos that exist", () => {
    expect(BUILTIN_CARRIERS.length).toBeGreaterThan(80);
    for (const { manifest } of BUILTIN_CARRIERS) {
      for (const entry of manifest.permissions.network) {
        expect(entry.reason, manifest.id).toMatch(/\w/);
      }
      if (manifest.logo !== undefined) {
        expect(
          existsSync(new URL(`../../logos/${manifest.logo}`, import.meta.url)),
          manifest.id,
        ).toBe(true);
      }
    }
  });
});
