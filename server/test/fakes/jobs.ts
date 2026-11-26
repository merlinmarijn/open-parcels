import { z } from "zod";
import { register, type RegisteredProvider } from "../../src/engine/registry.js";
import { defineAction, defineCarrier, snapshot } from "../../src/provider/api.js";
import { testManifest } from "../manifests.js";

/**
 * A made-up provider with actions, for the job tests: `walk` emits one parcel per page and saves
 * a checkpoint after each; the test scripts what each page does and can hold a page open.
 */
export class JobWorld {
  /** Per page, in order: an error to throw instead of the page; `undefined` runs it. */
  script: (Error | undefined)[] = [];
  /** Pages that were read, by number (a resumed job must not read one twice). */
  readonly pages: number[] = [];
  /** When set, the next page waits until `release()`. */
  #hold: Promise<void> | undefined;
  #release: (() => void) | undefined;
  /** Resolves when a page is waiting at the hold. */
  #waiting: (() => void) | undefined;

  hold(): Promise<void> {
    this.#hold = new Promise((resolve) => {
      this.#release = resolve;
    });
    return new Promise((resolve) => {
      this.#waiting = resolve;
    });
  }

  release(): void {
    this.#hold = undefined;
    this.#release?.();
  }

  async gate(): Promise<void> {
    if (this.#hold === undefined) return;
    this.#waiting?.();
    await this.#hold;
  }
}

const configSchema = z.looseObject({ host: z.string().optional() });

export function fakeJobs(world: JobWorld): RegisteredProvider {
  return register(
    defineCarrier({
      id: "fakejobs",
      configSchema,
      secretSchema: z.null(),
      signIn: { type: "none" },
      http: { limits: {} },
      fetchAccount: () => Promise.resolve({ snapshots: [], complete: false }),
      actions: {
        walk: defineAction({
          input: z.object({ pages: z.number().int().min(1).max(20).default(3) }),
          async run(context, input) {
            const saved = z.object({ page: z.number() }).safeParse(context.checkpoint.load());
            context.progress({ total: input.pages });
            for (let page = saved.success ? saved.data.page : 0; page < input.pages; page += 1) {
              await world.gate();
              if (context.signal.aborted) {
                return { status: "partial", summary: `stopped at page ${String(page)}` };
              }
              const failure = world.script.shift();
              if (failure !== undefined) throw failure;
              world.pages.push(page);
              await context.emit({
                snapshots: [
                  snapshot({
                    carrier: "fakejobs",
                    trackingNumber: `JOB${String(page).padStart(4, "0")}`,
                    status: "delivered",
                    rawStatus: "Delivered",
                  }),
                ],
              });
              await context.checkpoint.save({ page: page + 1 });
              context.progress({ done: page + 1, phase: `page ${String(page + 1)}` });
            }
            return { status: "done", summary: `${String(input.pages)} pages` };
          },
        }),
        rest: defineAction({
          input: z.object({}),
          run: () => Promise.resolve({ status: "pause", seconds: 600, summary: "resting" }),
        }),
        needs_input: defineAction({
          input: z.object({ year: z.number().int() }),
          run: () => Promise.resolve({ status: "done", summary: "ran" }),
        }),
      },
    }),
    testManifest("fakejobs", {
      name: "Fake Jobs",
      provides: { connections: ["account"] },
      permissions: {
        network: [{ host: ".example.com", reason: "Made-up shop pages." }],
      },
      actions: [
        {
          id: "walk",
          kind: "task",
          label: "Walk",
          connection_kinds: ["account"],
          when_state: ["ok", "idle"],
          weight: "heavy",
          destructive: false,
          expose_to_ha: true,
          cooldown_minutes: 60,
        },
        {
          id: "rest",
          kind: "task",
          label: "Rest",
          connection_kinds: ["account"],
          when_state: ["ok", "idle"],
          weight: "light",
          destructive: false,
          expose_to_ha: false,
          cooldown_minutes: 0,
        },
        {
          id: "needs_input",
          kind: "task",
          label: "Needs input",
          connection_kinds: ["account"],
          when_state: ["ok", "idle"],
          weight: "light",
          destructive: false,
          expose_to_ha: true,
          cooldown_minutes: 0,
        },
        {
          id: "open",
          kind: "link",
          label: "Open",
          connection_kinds: ["account"],
          when_state: ["ok", "idle"],
          url: "https://{host}/orders",
        },
      ],
    }),
  );
}
