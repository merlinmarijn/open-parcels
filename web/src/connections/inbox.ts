import type { SignInFlow } from "../api/types";
import type { JsonSchema } from "./schema";

/** Inboxes are not a carrier provider, so their forms mirror the server's mail schemas here. */
export const INBOX_PROVIDER = "imap";

export const INBOX_CONFIG_SCHEMA: JsonSchema = {
  type: "object",
  required: ["host"],
  properties: {
    host: { type: "string", title: "IMAP server", description: "For example imap.example.org." },
    port: { type: "integer", minimum: 1, maximum: 65535, default: 993 },
    secure: {
      type: "boolean",
      title: "Use TLS",
      description: "Off: the connection must switch to TLS with STARTTLS, usually on port 143.",
      default: true,
    },
    allowPlaintext: {
      type: "boolean",
      title: "Allow an unencrypted connection",
      description:
        "Only with TLS off: connect even when the server offers no STARTTLS. Sends the password in clear text.",
      default: false,
    },
    folders: { type: "array", items: { type: "string" }, default: ["INBOX"] },
    initialDays: {
      type: "integer",
      title: "Days to look back on the first sync",
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
    username: { type: "string", title: "User name" },
    password: { type: "string", title: "Password" },
  },
};

export const INBOX_FLOWS: SignInFlow[] = [
  {
    id: "credentials",
    label: "User name and password",
    type: "credentials",
    kinds: [],
    secret_schema: null,
    conditional: false,
  },
];
