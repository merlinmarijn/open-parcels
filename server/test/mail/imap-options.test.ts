import { describe, expect, it } from "vitest";
import { imapOptions } from "../../src/mail/imap-client.js";
import { mailConfigSchema } from "../../src/mail/types.js";

const secret = { username: "someone@example.invalid", password: ["made", "up"].join("-") };

describe("IMAP connection options (OP-012)", () => {
  it("require STARTTLS without TLS from the start, unless cleartext was allowed", () => {
    const tls = mailConfigSchema.parse({ host: "imap.example.invalid" });
    expect(imapOptions(tls, secret)).toMatchObject({ secure: true });
    expect(imapOptions(tls, secret)).not.toHaveProperty("doSTARTTLS");

    const starttls = mailConfigSchema.parse({ host: "imap.example.invalid", port: 143, secure: false });
    expect(imapOptions(starttls, secret)).toMatchObject({ secure: false, doSTARTTLS: true });

    const cleartext = mailConfigSchema.parse({
      host: "imap.example.invalid",
      port: 143,
      secure: false,
      allowPlaintext: true,
    });
    expect(imapOptions(cleartext, secret)).not.toHaveProperty("doSTARTTLS");
  });
});
