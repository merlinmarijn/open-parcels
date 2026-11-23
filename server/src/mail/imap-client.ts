import { ImapFlow, type ImapFlowOptions } from "imapflow";
import type {
  FetchedMessage,
  MailboxClient,
  MailboxClientFactory,
  MailConfig,
  MailSecret,
} from "./types.js";

/** The connection options for a mailbox. */
export function imapOptions(config: MailConfig, secret: MailSecret): ImapFlowOptions {
  return {
    host: config.host,
    port: config.port,
    secure: config.secure,
    // Not secure from the start: the connection must upgrade with STARTTLS (or fail), so the
    // password never crosses the network in clear text, unless the user allowed exactly that.
    ...(config.secure || config.allowPlaintext ? {} : { doSTARTTLS: true }),
    auth: { user: secret.username, pass: secret.password },
    // imapflow's own logging would print server responses, which can contain personal data.
    logger: false,
  };
}

/** The real IMAP connection. Folders are opened read-only, so nothing is ever marked as read. */
export const imapClientFactory: MailboxClientFactory = (config, secret) => {
  const client = new ImapFlow(imapOptions(config, secret));
  async function* toMessages(range: string): AsyncIterable<FetchedMessage> {
    const query = { uid: true, source: true, internalDate: true };
    for await (const message of client.fetch(range, query, { uid: true })) {
      if (message.source !== undefined) {
        const received = message.internalDate;
        yield {
          uid: message.uid,
          source: message.source,
          receivedAt: received instanceof Date ? received : null,
        };
      }
    }
  }
  const wrapper: MailboxClient = {
    connect: () => client.connect(),
    async open(folder) {
      const mailbox = await client.mailboxOpen(folder, { readOnly: true });
      return { uidValidity: String(mailbox.uidValidity) };
    },
    async searchSince(since) {
      const result = await client.search({ since }, { uid: true });
      return Array.isArray(result) ? result : [];
    },
    fetchAfter: (afterUid) => toMessages(`${afterUid + 1}:*`),
    fetchUids: (uids) => toMessages(uids.join(",")),
    onNewMail(listener) {
      client.on("exists", listener);
    },
    onClose(listener) {
      client.on("close", () => {
        listener(undefined);
      });
      client.on("error", (error: unknown) => {
        listener(error instanceof Error ? error : new Error("IMAP connection failed."));
      });
    },
    close: async () => {
      await client.logout();
    },
  };
  return wrapper;
};
