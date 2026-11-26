import type { Logger } from "pino";
import type { Clock } from "../clock.js";
import type { RegisteredProvider } from "../engine/registry.js";
import type {
  EmailContext,
  EmailResult,
  OrderSnapshot,
  ParcelSnapshot,
  ProviderEmail,
  ReturnSnapshot,
} from "../provider/api.js";
import { hostMatches } from "../provider/manifest.js";
import { mailId, senderDomain, senderName } from "./interpret.js";
import type { MailInput } from "./types.js";

/**
 * Email routing (`docs/provider-manifest-and-sandbox.md` §3): an inbox hands an email to the
 * providers whose manifest names its sender's domain, once the receiving server confirmed that the
 * sender is who it claims to be. An email a provider read is not read by the shared email rules as
 * well, so one email never gives a parcel twice.
 */

/** Drops comments (`(p=REJECT sp=REJECT)`); one level of nesting is all real headers use. */
function withoutComments(value: string): string {
  return value.replace(/\((?:[^()]|\([^()]*\))*\)/g, " ");
}

/**
 * DMARC's relaxed alignment without the public suffix list: the signer is the sender's domain, a
 * parent of it or a child of it. A signer without a dot (a top-level domain) never aligns.
 */
function aligned(signer: string, domain: string): boolean {
  return (
    signer.includes(".") &&
    (signer === domain || domain.endsWith(`.${signer}`) || signer.endsWith(`.${domain}`))
  );
}

/** `header.i=@example.com` or `header.i=user@example.com`: the domain after the `@`. */
function domainOf(identity: string | undefined): string | undefined {
  const domain = identity?.slice(identity.lastIndexOf("@") + 1);
  return domain === "" ? undefined : domain;
}

/**
 * True when an `Authentication-Results` header (RFC 8601) says DKIM passed for a signer aligned
 * with `domain`, or DMARC passed for `domain` itself.
 */
export function authenticatedSender(header: string | null, domain: string): boolean {
  if (header === null) return false;
  // The first part names the server that checked (authserv-id); each other part is one method.
  for (const part of withoutComments(header).split(";").slice(1)) {
    const [result = "", ...properties] = part.trim().split(/\s+/);
    const [method, outcome] = result.toLowerCase().split("=");
    if (outcome !== "pass") continue;
    const values = new Map(
      properties.map((property) => {
        const at = property.indexOf("=");
        return [
          property.slice(0, at).toLowerCase(),
          property
            .slice(at + 1)
            .replace(/^"|"$/g, "")
            .toLowerCase(),
        ] as const;
      }),
    );
    if (method === "dkim") {
      const signer = values.get("header.d") ?? domainOf(values.get("header.i"));
      if (signer !== undefined && aligned(signer, domain)) return true;
    }
    if (method === "dmarc" && values.get("header.from") === domain) return true;
  }
  return false;
}

/** The address of a From header (`Name <address>` or a bare address). */
function senderAddress(from: string): string {
  return (/<([^>]+)>\s*$/.exec(from)?.[1] ?? from).trim();
}

/** What a provider receives of an email: no headers besides these, no attachments. */
function providerEmail(mail: MailInput): ProviderEmail {
  return {
    id: mailId(mail),
    messageId: mail.messageId,
    date: mail.date?.toISOString() ?? null,
    from: { address: senderAddress(mail.from), name: senderName(mail.from) },
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
  };
}

interface EmailRouterDeps {
  /** Read on every email: the registry's providers. */
  readonly providers: () => readonly RegisteredProvider[];
  /** The global switch (`OPENPARCELS_EMAIL_ROUTING`), read on every email. */
  readonly enabled: () => boolean;
  readonly clock: Clock;
  readonly logger: Logger;
}

/** What the providers found in one email; null when none read it. */
interface RoutedEmail {
  readonly snapshots: readonly ParcelSnapshot[];
  readonly orders: readonly OrderSnapshot[];
  readonly returns: readonly ReturnSnapshot[];
}

export class EmailRouter {
  constructor(private readonly deps: EmailRouterDeps) {}

  /** The providers an email goes to: its sender's domain is theirs, and the sender is real. */
  routes(mail: MailInput): RegisteredProvider[] {
    if (!this.deps.enabled()) return [];
    const domain = senderDomain(mail.from);
    if (domain === undefined) return [];
    const claiming = this.deps
      .providers()
      .filter(
        (provider) =>
          provider.canParseEmail &&
          provider.manifest.email?.from_domains.some((pattern) => hostMatches(pattern, domain)) ===
            true,
      );
    if (claiming.length === 0) return [];
    if (!authenticatedSender(mail.authentication, domain)) {
      // Only the shop's or carrier's domain is logged, never the sender's address or the subject.
      this.deps.logger.info(
        { domain, providers: claiming.map((provider) => provider.info.id) },
        "An email from a provider's sender domain failed DKIM and DMARC; the shared email rules read it.",
      );
      return [];
    }
    return claiming;
  }

  /**
   * Hands the email to every provider it goes to. Null when it goes to none, or when each of them
   * ignored it or failed on it: the shared email rules read it then.
   */
  async read(connectionId: string, mail: MailInput): Promise<RoutedEmail | null> {
    const routes = this.routes(mail);
    if (routes.length === 0) return null;
    const email = providerEmail(mail);
    const read: EmailResult[] = [];
    for (const provider of routes) {
      const logger = this.deps.logger.child({
        connection: connectionId,
        provider: provider.info.id,
      });
      const context: EmailContext = {
        clock: this.deps.clock,
        logger,
        reportUnknown: (kind, key) => {
          logger.warn({ kind, key }, "A provider met a value in an email that it cannot map.");
        },
      };
      try {
        const result = await provider.parseEmail(context, email);
        if (result.ignored !== undefined) continue;
        read.push(result);
        logger.debug(
          {
            parcels: result.snapshots.length,
            orders: result.orders?.length ?? 0,
            returns: result.returns?.length ?? 0,
          },
          "A provider read an email.",
        );
      } catch (error) {
        // One odd email must not stop the inbox; the content is never logged.
        logger.warn(
          { error: error instanceof Error ? error.name : "unknown" },
          "A provider could not read an email.",
        );
      }
    }
    if (read.length === 0) return null;
    return {
      snapshots: read.flatMap((result) => result.snapshots),
      orders: read.flatMap((result) => result.orders ?? []),
      returns: read.flatMap((result) => result.returns ?? []),
    };
  }
}
