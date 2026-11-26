import type { Clock } from "../../src/clock.js";
import type { RegisteredProvider } from "../../src/engine/registry.js";
import type { ProviderConnectionKind } from "../../src/provider/api.js";
import { coreHttp, HostLimiter, type ProviderHttp } from "../../src/provider/http.js";
import { ANY_HOST } from "../manifests.js";

/** A pasted-link sign-in never touches the network in its first step. */
function noNetwork(clock: Clock): ProviderHttp {
  return coreHttp(
    { limits: {} },
    ANY_HOST,
    new HostLimiter(clock, () => Promise.resolve()),
    clock,
    () =>
      Promise.reject(
        new Error("The first step of a pasted-link sign-in must not use the network."),
      ),
  );
}

export interface PastedDriver {
  start(config: unknown, clock: Clock): Promise<Started>;
  finish(http: ProviderHttp, clock: Clock, state: Started["state"], text: string): Promise<unknown>;
}

interface Started {
  readonly url: string;
  readonly state: {
    readonly config: unknown;
    readonly kind: ProviderConnectionKind;
    readonly flow: string;
    readonly inner: unknown;
  };
}

function pick(
  provider: RegisteredProvider,
  config: unknown,
): { kind: ProviderConnectionKind; flow: string } {
  for (const kind of provider.info.connectionKinds) {
    const flow = provider.signInFlows(kind, config).find((each) => each.type === "interactive");
    if (flow !== undefined) {
      return { kind, flow: flow.id };
    }
  }
  throw new Error(`${provider.info.id} has no interactive sign-in for this configuration.`);
}

/** Drives a provider's pasted-link flow in two calls, as the compatibility routes do. */
export function pasted(provider: RegisteredProvider): PastedDriver {
  return {
    async start(config: unknown, clock: Clock): Promise<Started> {
      const { kind, flow } = pick(provider, config);
      const turn = await provider.signInTurn({
        action: "start",
        flowId: flow,
        kind,
        rawConfig: config,
        http: noNetwork(clock),
        clock,
      });
      if (!("step" in turn) || turn.step.kind !== "open_url") {
        throw new Error("Not a pasted-link flow.");
      }
      return { url: turn.step.url, state: { config, kind, flow, inner: turn.state } };
    },
    async finish(
      http: ProviderHttp,
      clock: Clock,
      state: Started["state"],
      text: string,
    ): Promise<unknown> {
      const turn = await provider.signInTurn({
        action: "continue",
        flowId: state.flow,
        kind: state.kind,
        rawConfig: state.config,
        http,
        clock,
        state: state.inner,
        input: { pasted: text },
      });
      if (!("secret" in turn)) {
        throw new Error("The pasted-link flow asked for another step.");
      }
      return turn.secret;
    },
  };
}
