import { z } from "zod";
import { CONNECTION_KINDS } from "./api.js";

/**
 * The provider manifest, format 1 (`docs/provider-manifest-and-sandbox.md`): what a provider is and
 * what it may do. Every provider has one (`open-parcels-provider.json` in its folder); this schema
 * is the only parser.
 */

/** `api.example.com` exactly, or `.example.com` for the domain and every subdomain. */
const HOST_PATTERN = /^\.?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const reason = z.string().trim().min(3).max(200);

const networkEntry = z.union([
  z.strictObject({ host: z.string().regex(HOST_PATTERN), reason }),
  /** The host of a URL the user typed into this config field (a self-hosted server). */
  z.strictObject({ config: z.string().regex(/^[a-z][a-z0-9_]*$/), reason }),
]);

const SECRET_KINDS = ["credentials", "api_key", "token"] as const;
export type SecretKind = (typeof SECRET_KINDS)[number];

const providerManifestSchema = z.strictObject({
  schema: z.literal(1),
  id: z.string().regex(/^[a-z0-9_]{2,40}$/),
  name: z.string().trim().min(1).max(80),
  /** ISO 3166-1 alpha-2 codes, or `*` for worldwide. */
  countries: z.array(z.string().regex(/^(?:[A-Z]{2}|\*)$/)).min(1),
  /** Other names people search for (former names, sub-brands, local names). */
  aliases: z.array(z.string().trim().min(1)).optional(),
  /** File name of the logo in the server's `logos/` folder. Unset: the UI draws a monogram. */
  logo: z
    .string()
    .regex(/^[a-z0-9_.-]+\.(?:svg|png)$/)
    .optional(),
  provides: z.strictObject({
    connections: z.array(z.enum(CONNECTION_KINDS)).min(1),
    /** Reads the courier map (`readLive`). */
    live: z.boolean(),
    /**
     * A fallback service rather than a carrier: consulted only for parcels no built-in carrier
     * follows or finds; its answers are filed under the parcel's own carrier.
     */
    fallback: z.boolean(),
  }),
  permissions: z.strictObject({
    network: z.array(networkEntry),
    /** Hosts the image proxy may fetch this provider's pictures from (same patterns). */
    image_hosts: z.array(z.string().regex(HOST_PATTERN)),
    /** What its sign-in flows store: a password, an API key, or a token from an interactive sign-in. */
    secrets: z.array(z.enum(SECRET_KINDS)),
    /** Keeps a per-connection encrypted session store. */
    session: z.boolean(),
    /** Overrides the honest User-Agent (the value and its reason are in the code). */
    user_agent: z.boolean(),
  }),
});
export type ProviderManifest = z.infer<typeof providerManifestSchema>;

/** Parses a manifest; the error names the provider and every field that is wrong. */
export function parseManifest(raw: unknown, source: string): ProviderManifest {
  const parsed = providerManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const paths = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`The provider manifest ${source} is invalid: ${paths}.`);
  }
  return parsed.data;
}

/** True when `hostname` is `pattern`, or under it for a leading-dot pattern. */
export function hostMatches(pattern: string, hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return pattern.startsWith(".")
    ? host === pattern.slice(1) || host.endsWith(pattern)
    : host === pattern;
}

/** The hosts a provider may reach: the manifest's patterns plus those its config names. */
export interface HostAllowList {
  allows(hostname: string): boolean;
}

/**
 * The allow-list for one connection. A `config` entry adds the host of that config field's URL;
 * a field that is not a URL adds nothing.
 */
export function networkAllowList(manifest: ProviderManifest, config: unknown): HostAllowList {
  const patterns: string[] = [];
  for (const entry of manifest.permissions.network) {
    if ("host" in entry) {
      patterns.push(entry.host);
      continue;
    }
    const value: unknown =
      config !== null && typeof config === "object"
        ? (config as Record<string, unknown>)[entry.config]
        : undefined;
    if (typeof value === "string" && URL.canParse(value)) {
      patterns.push(new URL(value).hostname);
    }
  }
  return { allows: (hostname) => patterns.some((pattern) => hostMatches(pattern, hostname)) };
}
