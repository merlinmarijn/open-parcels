import { afterEach, describe, expect, it } from "vitest";
import {
  Sandbox,
  SandboxCrashedError,
  SandboxDisabledError,
  SandboxTimeoutError,
  type Capability,
} from "../../src/sandbox/host.js";
import {
  coreTransport,
  HostLimiter,
  HostNotAllowedError,
  ProviderHttp,
} from "../../src/provider/http.js";
import { brokeredTransport, httpCapability } from "../../src/sandbox/http.js";
import { CookieJar } from "../../src/provider/cookies.js";
import { FakeClock } from "../helpers.js";
import { testManifest } from "../manifests.js";
import { networkAllowList } from "../../src/provider/manifest.js";
import { isolated } from "../../src/sandbox/providers.js";
import { InvalidConnectionConfigError } from "../../src/engine/registry.js";
import { fakeShop, FakeWorld } from "../fakes/carriers.js";

const started: Sandbox[] = [];

function sandbox(): Sandbox {
  const box = new Sandbox({
    child: new URL("../../src/sandbox/child.ts", import.meta.url),
    guest: new URL("../fakes/sandbox-guest.ts", import.meta.url),
    memoryMb: 64,
    clock: new FakeClock(),
    rebuildError: (wire) => Object.assign(new Error(wire.message), wire),
  });
  started.push(box);
  return box;
}

const none = { capabilities: {}, timeoutMs: 5_000 };

afterEach(() => {
  for (const box of started.splice(0)) box.stop();
});

describe("sandbox", () => {
  it("runs a guest method and returns its value, bytes included", async () => {
    const box = sandbox();
    const args = { text: "hello", bytes: new Uint8Array([1, 2, 3]) };
    await expect(box.call("echo", args, none)).resolves.toEqual(args);
    await expect(box.call("toString", null, none)).rejects.toThrow(/no method toString/);
  });

  it("keeps the child off the files, the network, other processes and the environment", async () => {
    process.env["SANDBOX_TEST_SECRET"] = "must-not-leak";
    try {
      await expect(sandbox().call("probe", null, none)).resolves.toEqual({
        read: "ERR_ACCESS_DENIED",
        write: "ERR_ACCESS_DENIED",
        connect: "ERR_ACCESS_DENIED",
        spawn: "ERR_ACCESS_DENIED",
        inherited: null,
      });
    } finally {
      delete process.env["SANDBOX_TEST_SECRET"];
    }
  });

  it("answers only the capabilities granted to the call, and only while it runs", async () => {
    const box = sandbox();
    const echo: Capability = (args) => Promise.resolve({ echoed: args });
    await expect(
      box.call(
        "ask",
        { capability: "echo", payload: 7 },
        { capabilities: { echo }, timeoutMs: 5_000 },
      ),
    ).resolves.toEqual({ echoed: 7 });
    await expect(
      box.call(
        "ask",
        { capability: "secret", payload: null },
        { capabilities: { echo }, timeoutMs: 5_000 },
      ),
    ).rejects.toThrow(/may not use secret/);
    await box.call("keep", null, { capabilities: { echo }, timeoutMs: 5_000 });
    await expect(
      box.call("late", null, { capabilities: { echo }, timeoutMs: 5_000 }),
    ).rejects.toThrow(/may not use echo/);
  });

  it("carries a capability's error and the guest's errors with their name and wait", async () => {
    const box = sandbox();
    const limited: Capability = () =>
      Promise.reject(
        Object.assign(new Error("slow down"), { name: "RateLimitedError", retryAfterSeconds: 30 }),
      );
    await expect(
      box.call(
        "ask",
        { capability: "http", payload: null },
        { capabilities: { http: limited }, timeoutMs: 5_000 },
      ),
    ).rejects.toMatchObject({ name: "RateLimitedError", retryAfterSeconds: 30 });
    await expect(box.call("fail", { name: "SignInRejectedError" }, none)).rejects.toMatchObject({
      name: "SignInRejectedError",
      message: "SignInRejectedError from the guest",
    });
  });

  it("stops a call that runs too long and starts a fresh child for the next", async () => {
    const box = sandbox();
    await expect(
      box.call("hang", null, { capabilities: {}, timeoutMs: 300 }),
    ).rejects.toBeInstanceOf(SandboxTimeoutError);
    await expect(box.call("echo", 1, none)).resolves.toBe(1);
  });

  it("switches itself off after three crashes, until enabled again", async () => {
    const box = sandbox();
    for (let crash = 0; crash < 3; crash += 1) {
      await expect(box.call("crash", null, none)).rejects.toBeInstanceOf(SandboxCrashedError);
    }
    await expect(box.call("echo", 1, none)).rejects.toBeInstanceOf(SandboxDisabledError);
    box.enable();
    await expect(box.call("echo", 2, none)).resolves.toBe(2);
  });
});

describe("HTTP across the sandbox boundary", () => {
  it("sends each hop through the core's transport, cookies and form bodies intact", async () => {
    const clock = new FakeClock();
    const seen: string[] = [];
    const transport = coreTransport(
      { limits: {} },
      networkAllowList(
        testManifest("bridge", {
          permissions: { network: [{ host: ".carrier.example", reason: "Tracking data." }] },
        }),
        {},
      ),
      new HostLimiter(clock, () => Promise.resolve()),
      clock,
      async (url, init) => {
        seen.push(
          `${init.method ?? "GET"} ${url.hostname}${url.pathname} ${init.body instanceof URLSearchParams ? init.body.toString() : ""}`,
        );
        if (url.pathname === "/login") {
          const headers = new Headers({ location: "/home" });
          headers.append("set-cookie", "a=1; Path=/");
          headers.append("set-cookie", "b=2; Path=/");
          return Promise.resolve(new Response(null, { status: 302, headers }));
        }
        if (url.pathname === "/away") {
          return Promise.resolve(
            new Response(null, { status: 302, headers: { location: "https://evil.example/" } }),
          );
        }
        return Promise.resolve(
          new Response(`cookie=${new Headers(init.headers).get("cookie") ?? ""}`),
        );
      },
    );
    const capability = httpCapability(transport);
    // What IPC does to every message: a structured clone each way.
    const http = new ProviderHttp(
      brokeredTransport({
        request: async (_capability, args) =>
          structuredClone(await capability(structuredClone(args))),
      }),
    );
    const jar = new CookieJar();
    const response = await http.request(new URL("https://www.carrier.example/login"), {
      method: "POST",
      body: new URLSearchParams({ user: "u" }),
      jar,
    });
    expect(response.body).toBe("cookie=a=1; b=2");
    expect(seen).toEqual([
      "POST www.carrier.example/login user=u",
      "GET www.carrier.example/home ",
    ]);
    await expect(http.request(new URL("https://www.carrier.example/away"))).rejects.toBeInstanceOf(
      HostNotAllowedError,
    );
  });
});

describe("providers in the pool", () => {
  it("checks a finished sign-in's secret again in the core, whatever the guest says", async () => {
    let answer: unknown = { secret: { refreshToken: 5 } };
    const pool = { call: () => Promise.resolve(answer) } as unknown as Sandbox;
    const shop = isolated(fakeShop(new FakeWorld()), pool);
    const turn = {
      action: "continue" as const,
      flowId: "interactive",
      kind: "shop" as const,
      rawConfig: {},
      // Never asked: the pool's answer is made up here.
      http: { transport: undefined } as never,
      clock: new FakeClock(),
    };
    await expect(shop.signInTurn(turn)).rejects.toBeInstanceOf(InvalidConnectionConfigError);
    answer = { secret: { refreshToken: "rt-1" } };
    await expect(shop.signInTurn(turn)).resolves.toEqual({ secret: { refreshToken: "rt-1" } });
  });
});
