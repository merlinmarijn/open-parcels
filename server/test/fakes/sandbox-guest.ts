/**
 * A guest for the sandbox tests. Node runs it as it is inside the child, so it uses only erasable
 * TypeScript and imports nothing but types and Node's own modules.
 */
import type { Broker, GuestMethods } from "../../src/sandbox/child.js";

let kept: Broker | undefined;

/** Runs `attempt` and returns "allowed", or the error code the permission model answered with. */
async function outcome(attempt: () => Promise<unknown>): Promise<string> {
  try {
    await attempt();
    return "allowed";
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
}

const methods: GuestMethods = {
  echo: (args) => Promise.resolve(args),

  ask: (args, broker) => {
    const { capability, payload } = args as { capability: string; payload: unknown };
    return broker.request(capability, payload);
  },

  async probe() {
    const fs = await import("node:fs/promises");
    const net = await import("node:net");
    const child = await import("node:child_process");
    return {
      read: await outcome(() => fs.readFile("/etc/hostname")),
      write: await outcome(() => fs.writeFile("/tmp/sandbox-probe", "x")),
      connect: await outcome(
        () =>
          new Promise((resolve, reject) => {
            const socket = net.connect(443, "192.0.2.1");
            socket.on("error", reject);
            socket.on("connect", resolve);
          }),
      ),
      spawn: await outcome(() => Promise.resolve(child.spawnSync("true"))),
      inherited: process.env["SANDBOX_TEST_SECRET"] ?? null,
    };
  },

  hang: () => new Promise(() => undefined),

  crash: () => {
    process.exit(3);
  },

  fail: (args) => {
    const { name, retryAfterSeconds } = args as { name: string; retryAfterSeconds?: number };
    return Promise.reject(
      Object.assign(new Error(`${name} from the guest`), { name, retryAfterSeconds }),
    );
  },

  keep: (_args, broker) => {
    kept = broker;
    return Promise.resolve("kept");
  },

  late: () => {
    if (kept === undefined) return Promise.reject(new Error("Nothing kept."));
    return kept.request("echo", "after its call");
  },
};

export default methods;
