import type { SignInFlow } from "../api/types";
import type { JsonSchema } from "./schema";
import { t } from "../i18n";

/** Inboxes are not a carrier provider, so their forms mirror the server's mail schemas here. */
export const INBOX_PROVIDER = "imap";

export const INBOX_CONFIG_SCHEMA: JsonSchema = {
  type: "object",
  required: ["host"],
  properties: {
    host: {
      type: "string",
      title: t.connections.imapServer,
      description: t.connections.imapServerHint,
    },
    port: { type: "integer", title: t.connections.port, minimum: 1, maximum: 65535, default: 993 },
    secure: {
      type: "boolean",
      title: t.connections.useTls,
      description: t.connections.useTlsHint,
      default: true,
    },
    allowPlaintext: {
      type: "boolean",
      title: t.connections.allowPlaintext,
      description: t.connections.allowPlaintextHint,
      default: false,
    },
    folders: {
      type: "array",
      title: t.connections.folders,
      items: { type: "string" },
      default: ["INBOX"],
    },
    initialDays: {
      type: "integer",
      title: t.connections.initialDays,
      minimum: 1,
      maximum: 365,
      default: 30,
    },
  },
};

export const INBOX_SECRET_SCHEMA: JsonSchema = {
  type: "object",
  required: ["username", "password"],
  properties: {
    username: { type: "string", title: t.connections.userName },
    password: { type: "string", title: t.connections.passwordText },
  },
};

export const INBOX_FLOWS: SignInFlow[] = [
  {
    id: "credentials",
    label: t.connections.userNameAndPasswordText,
    type: "credentials",
    kinds: [],
    secret_schema: null,
    conditional: false,
  },
];
