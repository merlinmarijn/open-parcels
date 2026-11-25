import type { SignInFlow } from "../api/types";
import { t } from "../i18n";

/** Inboxes are not a carrier provider: their forms come from `GET /api/v1/inbox-form`. */
export const INBOX_PROVIDER = "imap";

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
