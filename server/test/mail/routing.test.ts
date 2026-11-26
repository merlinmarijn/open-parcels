import { loadRules } from "open-parcels-rules";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { systemClock } from "../../src/clock.js";
import { register } from "../../src/engine/registry.js";
import { EmailRuleReader } from "../../src/mail/rule-reader.js";
import { authenticatedSender, EmailRouter } from "../../src/mail/routing.js";
import type { MailInput } from "../../src/mail/types.js";
import { defineCarrier } from "../../src/provider/api.js";
import { parseManifest } from "../../src/provider/manifest.js";
import { testManifest } from "../manifests.js";

/* Made-up domains and headers only. */

const DOMAIN = "shop.example.org";
const ruleReader = new EmailRuleReader(loadRules(), "UTC");

describe("authenticatedSender", () => {
  it("accepts DKIM aligned with the sender's domain, or DMARC for it", () => {
    for (const header of [
      `mx.example.net; dkim=pass header.i=@${DOMAIN} header.s=s1`,
      `mx.example.net; dkim=pass header.d=example.org`,
      `mx.example.net; dkim=pass header.d=mail.${DOMAIN}`,
      `mx.example.net;\r\n\tdkim=fail header.d=other.example;\r\n\tdmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=${DOMAIN}`,
      `mx.example.net; spf=pass smtp.mailfrom=bounce.example; dkim=pass (2048-bit key) header.i="news@${DOMAIN}"`,
    ]) {
      expect(authenticatedSender(header, DOMAIN), header).toBe(true);
    }
  });

  it("refuses failures, other signers and checks that prove nothing about the sender", () => {
    for (const header of [
      null,
      "mx.example.net; none",
      `mx.example.net; dkim=fail header.d=${DOMAIN}; dmarc=fail header.from=${DOMAIN}`,
      "mx.example.net; dkim=pass header.d=mailer.example",
      "mx.example.net; dkim=pass header.d=org",
      `mx.example.net; spf=pass smtp.mailfrom=${DOMAIN}`,
      "mx.example.net; dmarc=pass header.from=example.org",
      `mx.example.net; dkim=neutral (dkim=pass header.d=${DOMAIN}) header.d=${DOMAIN}`,
      `dkim=pass header.d=${DOMAIN}`,
    ]) {
      expect(authenticatedSender(header, DOMAIN), String(header)).toBe(false);
    }
  });
});

const reader = defineCarrier({
  id: "reader",
  configSchema: z.looseObject({}),
  secretSchema: z.null(),
  signIn: { type: "none" },
  http: { limits: {} },
  track: () => Promise.resolve({ snapshots: [], complete: true }),
  parseEmail: (_context, email) =>
    Promise.resolve(
      email.subject.startsWith("Ignore")
        ? { snapshots: [], ignored: "Not a shipping email." }
        : { snapshots: [], orders: [] },
    ),
});

const emailManifest = (domains: string[]) => ({
  ...testManifest("reader"),
  email: { from_domains: domains },
});

function mail(from: string, subject = "Shipped", authentication: string | null = null): MailInput {
  return {
    messageId: "<1@example.invalid>",
    from,
    subject,
    text: null,
    html: null,
    date: null,
    authentication,
  };
}

describe("email in provider manifests", () => {
  it("needs parseEmail and the email section together, and refuses webmail domains", () => {
    expect(() => register(reader, emailManifest([`.${DOMAIN}`]))).not.toThrow();
    expect(() => register(reader, testManifest("reader"))).toThrow(/parseEmail/);
    for (const domain of ["gmail.com", ".web.de", "com", "*"]) {
      expect(() => parseManifest(emailManifest([domain]), "test")).toThrow(/email\.from_domains/);
    }
    expect(() => parseManifest(emailManifest([]), "test")).toThrow(/email\.from_domains/);
  });

  it("routes only authenticated email from a declared domain, and only while switched on", async () => {
    let enabled = true;
    const router = new EmailRouter({
      providers: () => [register(reader, emailManifest([`.${DOMAIN}`]))],
      enabled: () => enabled,
      ruleReader,
      clock: systemClock,
      logger: pino({ level: "silent" }),
    });
    const passed = `mx.example.net; dkim=pass header.d=${DOMAIN}`;
    const from = `Shop <orders@news.${DOMAIN}>`;

    expect(await router.read("inbox", mail(from, "Shipped", passed), true)).toEqual({
      snapshots: [],
      orders: [],
      returns: [],
    });
    expect(router.routes(mail(from), true)).toEqual([]);
    expect(router.routes(mail("Shop <orders@other.example>", "Shipped", passed), true)).toEqual([]);
    expect(await router.read("inbox", mail(from, "Ignore me", passed), true)).toBeNull();
    enabled = false;
    expect(router.routes(mail(from, "Shipped", passed), true)).toEqual([]);
  });

  it("routes by the domain alone for an inbox that does not check senders", () => {
    const router = new EmailRouter({
      providers: () => [register(reader, emailManifest([`.${DOMAIN}`]))],
      enabled: () => true,
      ruleReader,
      clock: systemClock,
      logger: pino({ level: "silent" }),
    });
    const from = `Shop <orders@news.${DOMAIN}>`;
    expect(router.routes(mail(from), true)).toEqual([]);
    expect(router.routes(mail(from), false).map((provider) => provider.info.id)).toEqual([
      "reader",
    ]);
    expect(router.routes(mail("Shop <orders@other.example>"), false)).toEqual([]);
  });

  it("reads with a provider's email rules in the core, and refuses rules next to parseEmail", async () => {
    const rule = {
      id: "parcel-example-shop",
      name: "Example shop shipping emails",
      kind: "parcel" as const,
      senders: { domains: [DOMAIN] },
      carrier: "dhl",
      extract: { tracking_number: [{ pattern: "(?<tracking_number>00340434\\d{12})" }] },
      tests: [{ fixture: "none.eml", expect: [] }],
    };
    const ruled = defineCarrier({
      id: "reader",
      configSchema: z.looseObject({}),
      secretSchema: z.null(),
      signIn: { type: "none" },
      http: { limits: {} },
      track: () => Promise.resolve({ snapshots: [], complete: true }),
      emailRules: [rule],
    });
    expect(() => register({ ...reader, emailRules: [rule] }, emailManifest([DOMAIN]))).toThrow(
      /exclude each other/,
    );
    const router = new EmailRouter({
      providers: () => [register(ruled, emailManifest([DOMAIN]))],
      enabled: () => true,
      ruleReader,
      clock: systemClock,
      logger: pino({ level: "silent" }),
    });
    const passed = `mx.example.net; dkim=pass header.d=${DOMAIN}`;
    const shipped = mail(`Shop <orders@${DOMAIN}>`, "Shipped", passed);
    const found = await router.read(
      "inbox",
      { ...shipped, text: "Tracking number: 00340434000000000017" },
      true,
    );
    expect(found?.snapshots.map((parcel) => [parcel.carrier, parcel.trackingNumber])).toEqual([
      ["dhl", "00340434000000000017"],
    ]);
    // Read even when the rules find nothing: the shared rules never see it.
    expect(await router.read("inbox", shipped, true)).toEqual({
      snapshots: [],
      orders: [],
      returns: [],
    });
  });
});
