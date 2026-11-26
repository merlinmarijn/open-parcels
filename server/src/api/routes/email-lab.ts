import { z } from "zod";
import { InvalidEmailRuleError } from "../../mail/custom-rules.js";
import {
  EMAIL_LAB_PAGE_MAX,
  EmailLabMailboxError,
  EmailLabNotFoundError,
} from "../../mail/email-lab.js";
import type { Services } from "../../services.js";
import type { TypedApp } from "../app.js";
import { requireScope } from "../auth-plugin.js";
import { ApiError, errorBodySchema, notFound } from "../errors.js";
import { idParams } from "../schemas.js";

/*
 * The email lab (`docs/email-lab.md`): how an inbox's emails are read, trying email rules on them and
 * the owner's custom email rules. Admin only: emails are personal data. Nothing here logs or
 * stores an email's content, and no live event carries it.
 */

const dayParam = z.iso.date().describe("A day, `YYYY-MM-DD` (UTC).");
const folderParam = z.string().min(1).max(200).default("INBOX").describe("The IMAP folder.");

const ruleResultSchema = z.object({
  rule_id: z.string().describe("The email rule, `schema.org` for embedded markup, or `fallback`."),
  kind: z.string(),
  carrier: z.string().nullable(),
  tracking_numbers: z.array(z.string()),
  order_numbers: z.array(z.string()),
  status: z.string().nullable(),
  event: z.string().nullable(),
});

const detectionSchema = z.object({
  outcome: z
    .enum(["detected", "ignored", "not_detected"])
    .describe(
      "`detected`: it gives a parcel, order or return; `ignored`: an `ignore` rule drops it; `not_detected`: nothing.",
    ),
  read_by: z
    .enum(["providers", "shared_rules"])
    .describe("Who read it: the providers of its sender's domain, or the shared email rules."),
  providers: z
    .array(z.string())
    .describe("Providers the email is routed to (sender domain and DKIM/DMARC check)."),
  rule_results: z.array(ruleResultSchema).describe("What each rule that applied extracted."),
  parcels: z.array(
    z.object({
      carrier: z.string(),
      tracking_number: z.string(),
      status: z.string().nullable(),
      shop: z.string().nullable(),
      order_number: z.string().nullable(),
    }),
  ),
  orders: z.array(
    z.object({ shop: z.string(), order_number: z.string(), status: z.string().nullable() }),
  ),
  returns: z.array(
    z.object({
      shop: z.string(),
      order_number: z.string(),
      status: z.string().nullable(),
      tracking_number: z.string().nullable(),
    }),
  ),
});

const messageSchema = z.object({
  uid: z.number().int().describe("The IMAP UID; 0 for a pasted message."),
  date: z.string().nullable(),
  from: z.string(),
  subject: z.string(),
  detection: detectionSchema,
});

const messageDetailSchema = messageSchema.extend({
  message_id: z.string().nullable(),
  authentication_results: z.string().nullable(),
  text: z.string().nullable(),
  html_text: z.string().nullable().describe("The HTML part as plain lines, as the rules see it."),
});

const problemSchema = z.object({
  index: z.number().int().describe("The rule's place in the list sent."),
  id: z.string().nullable(),
  message: z.string(),
});

const emailRuleSchema = z.object({
  id: z.string(),
  definition: z
    .record(z.string(), z.unknown())
    .describe("The rule in the email rule format (`schema/mail-rule.schema.json` of the rules)."),
  created_at: z.string(),
  updated_at: z.string(),
});

const ruleIdParams = z.object({ rule: z.string().min(1).max(100) });

/** The lab's own failures as API errors; anything else is a bug and stays a 500. */
function asApiError(error: unknown): never {
  if (error instanceof EmailLabNotFoundError) {
    throw notFound(error.resource === "connection" ? "connection" : "message");
  }
  if (error instanceof EmailLabMailboxError) {
    throw new ApiError(
      502,
      "mailbox_failed",
      "The mail server refused or failed. Check the inbox on the Connections page.",
    );
  }
  if (error instanceof InvalidEmailRuleError) {
    throw new ApiError(400, "invalid_email_rule", error.message, { detail: error.message });
  }
  throw error;
}

async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    return asApiError(error);
  }
}

function registerLabRoutes(app: TypedApp, services: Services): void {
  const admin = requireScope("admin");

  app.get(
    "/api/v1/connections/:id/email-lab/messages",
    {
      preHandler: admin,
      schema: {
        tags: ["email-lab"],
        summary: "List an inbox folder's emails, newest first, with how each is read.",
        description:
          "Opens a short-lived read-only connection of its own (the inbox's watcher is not touched). " +
          "`since` defaults to 30 days ago; `before` is exclusive. Emails are personal data: this is admin only.",
        params: idParams,
        querystring: z.object({
          folder: folderParam,
          since: dayParam.optional(),
          before: dayParam.optional(),
          limit: z.coerce.number().int().min(1).max(EMAIL_LAB_PAGE_MAX).default(20),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        response: {
          200: z.object({ total: z.number().int(), messages: z.array(messageSchema) }),
          404: errorBodySchema,
          502: errorBodySchema,
        },
      },
    },
    async (request) => {
      const { folder, since, before, limit, offset } = request.query;
      return guarded(() =>
        services.emailLab.list(request.params.id, folder, { since, before }, { limit, offset }),
      );
    },
  );

  app.get(
    "/api/v1/connections/:id/email-lab/messages/:uid",
    {
      preHandler: admin,
      schema: {
        tags: ["email-lab"],
        summary: "One email: its headers, text, HTML as text and how it is read.",
        params: idParams.extend({ uid: z.coerce.number().int().min(1) }),
        querystring: z.object({ folder: folderParam }),
        response: { 200: messageDetailSchema, 404: errorBodySchema, 502: errorBodySchema },
      },
    },
    async (request) =>
      guarded(() =>
        services.emailLab.get(request.params.id, request.query.folder, request.params.uid),
      ),
  );

  app.post(
    "/api/v1/email-lab/test",
    {
      preHandler: admin,
      schema: {
        tags: ["email-lab"],
        summary: "Read one email with candidate email rules, without saving anything.",
        description:
          "The email is an inbox's (`connection_id`, `folder`, `uid`) or pasted RFC 822 source " +
          "(`raw`, an .eml file's content). `rules` are candidate custom email rules; one with the id " +
          "of a saved custom rule replaces it for this test. `baseline` is how the email reads now, " +
          "`result` how it reads with the candidates. Candidates with `problems` are left out.",
        body: z
          .object({
            connection_id: z.uuid().optional(),
            folder: folderParam,
            uid: z.number().int().min(1).optional(),
            raw: z.string().min(1).max(900_000).optional(),
            check_senders: z
              .boolean()
              .optional()
              .describe("Overrides the inbox's DKIM/DMARC check; on when no inbox is given."),
            rules: z.array(z.unknown()).max(50).default([]),
          })
          .refine((body) => body.raw !== undefined || body.uid !== undefined, {
            message: "Send `raw`, or `connection_id` with `uid`.",
          }),
        response: {
          200: z.object({
            problems: z.array(problemSchema),
            message: messageDetailSchema,
            baseline: detectionSchema,
            result: detectionSchema,
          }),
          404: errorBodySchema,
          502: errorBodySchema,
        },
      },
    },
    async (request) => {
      const body = request.body;
      return guarded(() =>
        services.emailLab.test({
          connectionId: body.connection_id,
          folder: body.folder,
          uid: body.uid,
          raw: body.raw,
          rules: body.rules,
          checkSenders: body.check_senders,
        }),
      );
    },
  );

  app.post(
    "/api/v1/connections/:id/email-lab/reread",
    {
      preHandler: admin,
      schema: {
        tags: ["email-lab"],
        summary: "Read a window of an inbox again with the rules in use and store what it finds.",
        description:
          "Additive: nothing stored is removed, and an email read again adds no second history " +
          "entry. At most the newest 1000 emails per call; `truncated` says more were left. " +
          "`folders` defaults to the inbox's folders, `since` to 30 days ago.",
        params: idParams,
        body: z.object({
          since: dayParam.optional(),
          before: dayParam.optional(),
          folders: z.array(z.string().min(1).max(200)).min(1).max(50).optional(),
        }),
        response: {
          200: z.object({
            messages: z.number().int(),
            parcels: z.number().int(),
            orders: z.number().int(),
            returns: z.number().int(),
            truncated: z.boolean(),
          }),
          404: errorBodySchema,
          502: errorBodySchema,
        },
      },
    },
    async (request) => {
      const { since, before, folders } = request.body;
      return guarded(() => services.emailLab.reread(request.params.id, { since, before }, folders));
    },
  );
}

function registerRuleRoutes(app: TypedApp, services: Services): void {
  const admin = requireScope("admin");
  const toBody = (rule: Awaited<ReturnType<Services["customRules"]["list"]>>[number]) => ({
    id: rule.id,
    definition: rule.definition as Record<string, unknown>,
    created_at: rule.createdAt,
    updated_at: rule.updatedAt,
  });

  app.get(
    "/api/v1/email-rules",
    {
      preHandler: admin,
      schema: {
        tags: ["email-lab"],
        summary: "The owner's custom email rules, read by every inbox next to the shared ones.",
        response: { 200: z.array(emailRuleSchema) },
      },
    },
    async () => (await services.customRules.list()).map(toBody),
  );

  app.put(
    "/api/v1/email-rules/:rule",
    {
      preHandler: admin,
      schema: {
        tags: ["email-lab"],
        summary: "Create or replace a custom email rule.",
        description:
          "The body is the rule in the email rule format; its `id` must be the path's and may not " +
          "be a shared or provider rule's. It applies to the next email; read older ones again " +
          "with the re-read. A rule others could use belongs upstream in open-parcels-rules.",
        params: ruleIdParams,
        body: z.record(z.string(), z.unknown()),
        response: { 200: emailRuleSchema, 400: errorBodySchema },
      },
    },
    async (request) =>
      guarded(async () =>
        toBody(await services.customRules.put(request.params.rule, request.body)),
      ),
  );

  app.delete(
    "/api/v1/email-rules/:rule",
    {
      preHandler: admin,
      schema: {
        tags: ["email-lab"],
        summary: "Delete a custom email rule.",
        params: ruleIdParams,
        response: { 204: z.null(), 404: errorBodySchema },
      },
    },
    async (request, reply) => {
      if (!(await services.customRules.delete(request.params.rule))) {
        throw notFound("email_rule");
      }
      return reply.code(204).send(null);
    },
  );
}

export function registerEmailLabRoutes(app: TypedApp, services: Services): void {
  registerLabRoutes(app, services);
  registerRuleRoutes(app, services);
}
