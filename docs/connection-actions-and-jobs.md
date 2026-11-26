# Connection actions and jobs

Design note for TODO §3 "Connection actions and jobs". It narrows decision record
[0002](decisions/0002-providers.md) §2.12 to what is built now, so that the next item, the Amazon
"Import history" job (§2.13), only has to write the provider's part.

## 1. Actions in the manifest

A provider declares its actions in its manifest (format 1, `actions`, optional). What an action is
lives there; what it does (and what input it takes) lives in the code, as for sign-in flows.

```json
"actions": [
  {
    "id": "import_history",
    "kind": "task",
    "label": "Import history",
    "description": "Reads every order on the account, back to the first one.",
    "connection_kinds": ["shop"],
    "when_state": ["ok", "idle"],
    "weight": "heavy",
    "confirm": "This reads your whole order history, slowly. It can take hours.",
    "destructive": false,
    "expose_to_ha": true,
    "cooldown_minutes": 1440
  },
  {
    "id": "open_orders",
    "kind": "link",
    "label": "Your orders",
    "connection_kinds": ["shop"],
    "url": "https://{storefront}/your-orders/orders"
  }
]
```

- `id` is `[a-z0-9_]+`, unique in the provider. `label`, `description` and `confirm` are English;
  the server translates them like every provider text (`i18n/provider-texts-de.ts`).
- `when_state` (default `ok`, `idle`): the connection states in which the action may start.
- `kind: "link"` runs nothing: `url` may use `{field}` placeholders of the connection's config
  only. The server fills them, and answers only with an `https` URL whose host the manifest's
  `permissions.network` allows, so a config value can never become another scheme or host.
- `kind: "task"` runs provider code as a **job**. `weight: "heavy"` jobs run one at a time per
  server, the rest wait as `queued`. `cooldown_minutes` is the earliest re-run after a finished
  (`done`) job. `destructive` actions are never offered as HA buttons, and the HA service needs
  `confirm: true` for them. `expose_to_ha` offers the action as an HA button when it needs no
  input (every input field has a default).
- Checked at registration: the task ids of the manifest are exactly the keys of the code's
  `actions`, and a link has a `url` and no task fields.

## 2. The task contract (provider API)

```ts
actions?: Record<string, ProviderAction<Config, Secret>>;   // in CarrierProvider

defineAction({
  input: z.object({ since_year: z.number().int().optional() }),  // validated by the core first
  async run(context, input) {           // context: ActionContext<Config, Secret>
    const at = context.checkpoint.load() ?? { page: 0 };  // what the last leg saved
    // ... one page:
    await context.emit({ snapshots, orders });            // reconciled at once, idempotent
    await context.checkpoint.save({ page: at.page + 1 });  // after every emitted batch
    context.progress({ done: 3, total: 12, phase: "2023: page 4" });
    if (context.signal.aborted) return { status: "partial", summary: "…" };
    return { status: "done", summary: "412 orders, 37 parcels" };
    // or, to rest between legs: { status: "pause", seconds: 3600, summary: "…" }
  },
});
```

`ActionContext` is the connection's `ProviderContext` (config, secret, http, clock, logger,
session, reportUnknown) plus `signal`, `checkpoint`, `progress` and `emit`. Requests go through
the same transport, allow-list and host token buckets as the connection's runs.

## 3. Jobs

Table `jobs` (migration 0029): `id`, `connection_id` (deleted with the connection), `provider`,
`action`, `input` (JSON), `state`, `reason`, `progress` (JSON `{done, total, phase}`),
`checkpoint_blob` (encrypted, at most 256 KB), `summary`, `retries`, `created_at`, `started_at`,
`updated_at`, `finished_at`, `resume_at`.

States: `queued` → `running` → `done` | `partial` | `failed` | `cancelled`, or `paused` (with a
`reason`, and `resume_at` when it resumes on its own).

- **One job per connection** at a time (queued, running or paused): a second start is
  `409 job_running`.
- **The connection lock is shared and yielded between pages.** A job holds the connection's lock
  while it works and gives it up at every `emit` and `checkpoint.save`; a scheduled run, a live
  read or a sign-in step waiting for it goes first. Polling continues during a long import.
- **Errors keep their meaning** (never a new sign-in):
  `RateLimitedError` pauses (`rate_limited`) until its `Retry-After` (15 min without one);
  `CaptchaError` pauses (`captcha`) for 6 h; `SignInRejectedError` pauses (`needs_sign_in`)
  until resumed by hand; `TransientError` retries after 1, 5 and 15 min, then pauses
  (`waiting_for_carrier`) for 1 h; anything else fails the job (`failed`) and keeps its
  checkpoint. A paused job with `resume_at` is queued again when that time comes.
- **Resumable.** The checkpoint is saved by the provider after every batch. Resume (from
  `paused`, `failed`, `partial` or `cancelled`) continues from it; a server start puts jobs that
  were `running` back to `queued`. Restart ("Start over") clears checkpoint and progress.
- **Cancel** aborts `signal` at once for a running job; a queued or paused job is cancelled
  at once. A running job that has not returned 30 s later is recorded as `cancelled` and every
  further emit or checkpoint save of it is refused. Results emitted so far stay.
- **A hard ceiling of 12 h per leg:** the signal is aborted and the job pauses (`ceiling`);
  resume continues.
- **In the sandbox** (`OPENPARCELS_PROVIDER_ISOLATION=pool`) the call is `runAction`, granted
  `http`, `log`, `report-unknown`, `session.save` (with `permissions.session`) and
  `job.progress`, `job.emit`, `job.checkpoint`. The checkpoint travels with the call; every job
  capability's answer says whether the job was cancelled, which aborts the guest's signal.

## 4. API and live events

| Route | Does |
|---|---|
| `GET /api/v1/carriers` | Each provider's `actions` (as declared, translated; tasks with `input_schema` and `input_required`) |
| `GET /api/v1/connections/{id}/actions` | The actions of this connection's kind, with `available` (state allows it, no job) and `cooldown_until` |
| `POST /api/v1/connections/{id}/actions/{action}` | `{input}`: `202 {job}` for a task, `200 {url}` for a link. `409 job_running`, `409 action_unavailable`, `429 action_cooldown` with `Retry-After` |
| `GET /api/v1/jobs?connection_id&state` / `GET /api/v1/jobs/{id}` | State, progress, summary |
| `POST /api/v1/jobs/{id}/cancel`, `/resume`, `/restart` | `200 {job}`; `409 job_state` when the state does not allow it |

Starting, cancelling and resuming need the `write` scope (as "Run now"); reading needs `read`.

Live events carry the job (`job: {id, connection_id, provider, action, state, reason, progress,
summary, resume_at, …}`) and `connection: {id, provider, label, kind}`:
`job.queued`, `job.started` (also on every resume), `job.progress` (at most one every 5 s per
job; short-lived), `job.paused`, `job.finished` (`done`, `partial`, `failed` or `cancelled`).
Parcels and orders a job emits fire their usual events; flagging imported history
(`imported: true`, directly archived, `parcel.imported`, 0002 §2.15) comes with the Amazon import.

## 5. Clients

- **Web UI:** each connection card shows its actions (a task as a button, a link as an outbound
  link), a confirm dialog when the action has `confirm`, the typed label for a destructive one, and
  an input form (the existing `SchemaForm`) when it has input. Below them the connection's newest
  job: state, reason, a progress bar, phase and summary, with Cancel, Resume and Start over.
- **HA integration:** per connection, a `button` per task action with `expose_to_ha`, not
  `destructive` and no required input; a `sensor` "Job" (state = job state, attributes: action,
  progress, phase, summary, reason, resume_at) kept current from the `job.*` live events; the
  services `open_parcels.run_action` (connection's device, action, input, `confirm`) and
  `open_parcels.cancel_job`; and the Home Assistant events `open_parcels_job_finished` and
  `open_parcels_job_paused`.

## 6. What the Amazon import adds on top

Its manifest entry (`import_history`, heavy, `cooldown_minutes`), its `actions.import_history`
(years from the orders page, checkpoint `{year, startIndex, pending}`, pacing inside the provider:
6–10 s per page, a 2-minute break every 25 pages, `{status: "pause", seconds: 3600}` after 300
pages), and the "imported" flags of 0002 §2.15. No change to jobs, routes or clients.
