# 0003: One household per installation, no user accounts

- **Status:** accepted 2026-11-25. It writes down what [0001](0001-architecture.md) §5 settled
  ("Users: one per container") and §2.7 built, so that `tasks/TODO.md` §2 ("real accounts or a
  documented single-household model") is decided. Revisit only for the triggers in §5.
- **Builds on:** 0001 §2.5 (data model, no user column) and §2.7 (security).

## 1. Context

open-parcels runs as one container per household, on Docker, Unraid or as a Home Assistant app.
The parcels it follows come from connections that are signed in with the household's own carrier
and shop accounts and from the household's inboxes. Who may see and change what is decided today by:

| Who | How they get in | What they may do |
| --- | --- | --- |
| Admin | `OPENPARCELS_ADMIN_PASSWORD`, or the one changed on the Settings page (scrypt-hashed in `owner`); a one-time setup code from the log when neither exists | Everything: connections, sign-ins, parcels, orders, settings, tokens, data and backups |
| Reader | `OPENPARCELS_PASSWORD`; empty means reading needs no login | Read the web UI, the API, live events, maps and images |
| API client | Bearer API token (SHA-256 stored, shown once) with the scopes `read`, `write`, `admin` | What its scopes allow; Home Assistant uses one |
| Home Assistant ingress | Requests from `172.30.32.2` on the separate ingress listener | The admin: Home Assistant has already authenticated the person |
| Calendar app | The secret in the ICS feed address | The feed only; revocable |

The one rule on every route is by method: GET/HEAD/OPTIONS need a reader (when a reader password
is set), everything else needs the admin. Sessions carry their role; tokens carry their scopes.
No table has a user column (0001 §2.5).

The audit asked whether thousands of installs need real per-user accounts instead.

## 2. Options

**A. One household, two passwords and API tokens (what the code does).**

- Simple to run: two environment variables, or the setup code once. Nothing to administer.
- Fits the data: carrier accounts, inboxes and the home location belong to the household; a parcel
  for one person arrives at the same door.
- Small attack surface: no user table, no password reset by email, no invitation flow, no
  per-row permission checks that a forgotten `where user_id = ?` could break.
- Home Assistant users (who already have per-person logins there) get people-aware access
  through ingress for free.
- Costs: everyone who reads sees every parcel, order and return of the household; there is no
  per-person history of who changed what (the log says "admin"); the reader password is shared, so
  revoking one person means changing it for all; in the web UI a family member who should add
  parcels but not change connections cannot be expressed (every change needs the admin password).

**B. Per-user accounts inside open-parcels.**

- Users, roles and per-user connections and parcels; each person sees their own and shared ones.
- Costs: a `user_id` on connections, parcels, orders, returns, events, tokens and settings, and a
  migration that assigns every existing row; ownership rules for hand-off and deduplication (an
  Amazon parcel of one person carried by a DHL connection of another); per-user live event
  streams; user management, password reset without email infrastructure, and a much larger
  security review. Every client (Home Assistant integration and app, extension) changes in
  lockstep.

**C. Delegate identity to a reverse proxy or OIDC provider.**

- Authelia, Authentik, Tailscale identity or similar authenticate people in front of
  open-parcels; open-parcels trusts a header.
- Costs: trusting a header safely needs a listener only the proxy can reach (as the ingress
  listener does); without per-user data (option B) it adds only a login screen, which the two
  passwords already provide.

## 3. Decision

**Option A.** One installation serves one household. The admin password guards every change, the
reader password (optional) guards reading, API tokens with scopes serve programs, and Home
Assistant ingress and the calendar feed keep their own narrow ways in. No user accounts are built.

What a household that needs more does instead:

- **Separate people's data:** run one installation per person (each with its own connections);
  Home Assistant can add several open-parcels integrations.
- **Per-person login or single sign-on:** put a proxy such as Authelia or Tailscale in front and
  keep the reader password set as a second line; `OPENPARCELS_TRUST_PROXY` makes the login
  throttle see real addresses.
- **Revoke one program:** give each program its own API token and revoke it on the Tokens page.

## 4. Consequences

- The data model stays without a user column; new tables follow suit.
- Write access stays coarse: in the web UI every change needs the admin password; an API token
  with `write` may change parcels, orders and the household settings (home, labels, sync), but
  only `admin` manages connections and sign-ins, server settings, tokens, data and backups. A
  finer role (a household member who may add parcels but not
  touch connections) can be added as a token scope or a third password later without a data
  migration, because it needs no ownership of rows.
- Documentation (README, website) describes open-parcels as a per-household service and says what
  the reader password exposes.
- Live events, status and backups are per installation, which is what one household needs.

## 5. Revisit when

- Several unrelated people are expected to share one installation (a shared flat, a small office),
  or the project is offered as a hosted service; or
- the owner asks for per-person views or a change log by person.

Either needs option B, planned as its own decision record with the migration and the clients'
lockstep changes.

## 6. Token logins for clients without cookies (added 2026-11-25)

Decision record 0004 §3.2 needs a login for clients that cannot use the session cookie: the web UI
on another origin, the Android app, the client libraries. It stays inside option A: the same two
passwords, the same two roles, no user accounts.

| | API token (`opk_…`) | Token login (`opa_…` access, `opr_…` refresh) |
| --- | --- | --- |
| For | Programs: Home Assistant, scripts, the extension | People in a client: another web UI, the Android app, a library used interactively |
| Made by | The admin on the Tokens page | Logging in (`POST /api/v1/logins`) with the admin or reader password |
| Rights | The scopes chosen (`read`, `write`, `admin`) | The password's role (`admin` or `reader`); the admin password may ask for `reader` |
| Lifetime | Until revoked or its optional expiry | Access token 15 minutes; refresh token 30 days, renewed by every refresh |
| Rotation | None | Every refresh replaces both tokens; a replaced refresh token used again ends the login |
| Ends when | Revoked on the Tokens page | Logged out (`POST /api/v1/logins/logout`), ended on the Tokens page, 30 days unused, or either password changes (the reader password ends reader logins only) |
| Live event stream | `Authorization` header only | Header, or `?access_token=` (browsers' EventSource cannot send headers); the stream lasts as long as the login |

Both are bearer tokens, stored only as SHA-256 hashes, listed on the Tokens page and revocable
there. They stay separate because they answer different questions: an API token is a standing
grant the admin hands to a program, a token login is a person's password login without a cookie.
Changing a password ends every login made with it but no API token, as before.

Cross-origin pages are allowed by `OPENPARCELS_CORS_ORIGINS` (exact origins, never `*`) and get no
credentials: the session cookie stays same-origin, so a listed origin cannot ride on it.
