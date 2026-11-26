# Email lab and custom email rules

The email lab lets the admin, or an agent with an admin token, see how an inbox's emails are read
and fix an email that is not detected. The step-by-step use is in the agent guide
([`server/agent-guide.md`](../server/agent-guide.md), served at `/llms.txt` and shown in the web UI
under "For AI agents"); this note records how it is built.

## Reading without disturbing the inbox

Every lab call opens a short-lived IMAP connection of its own, like folder discovery
(`MailWatcher.listFolders`), and closes it afterwards. Folders are opened read-only. The watcher's
IDLE connection, its sync queue and its read position are never touched.

An email is read exactly as the watcher reads it (`EmailRouter.read`, then the shared rules), and
the lab adds what each rule extracted (`rule_results`) so the reason for a miss is visible.

## Personal data

Emails are personal data. The lab is admin only; content is returned to the caller and nowhere
else: never logged (failures log only the error's name), never in live events, never stored. The
mail server's own error words are dropped too.

## Custom email rules

- Stored in `email_rules` (migration 0031), one row per rule, in the email rule format of
  `open-parcels-rules` (`EmailRuleDefinition`). Saving checks the schema (`withEmailRules`), the
  regular expressions and the id: it may not be a shared or provider rule's id.
- They are **added** to every rule set: to the shared rules for emails no provider claims, and to
  a provider's rules for emails routed to it (`EmailRuleReader`). They never replace a rule.
  `ignore` rules still win.
- A rule saved applies to the next email. Emails read before are read again with the lab's
  re-read (`POST /connections/{id}/email-lab/reread`): a date window, at most 1000 emails per
  call, additive (nothing is removed; an email read again adds no second history entry). The
  connection's "Clear data" also reads everything again but deletes what the inbox found first.
- A stored rule that newer rules no longer accept is skipped at start, with a warning naming its
  id.

**Rules that help others belong upstream.** A custom rule is for this server only. A shop or
carrier that anyone may get emails from should get its rule in `open-parcels-rules` (or in its
provider, `docs/rules-split.md`) with a made-up `.eml` fixture, and the custom rule is deleted
once the server ships with it.
