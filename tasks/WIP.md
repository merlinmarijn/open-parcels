# In progress

Items being worked on right now, with who is on it. Move them to `DONE.md` when shipped.

- TODO §3 provider sandbox (child process with the Node permission model, broker for HTTP, secrets
  per call; design in `docs/provider-manifest-and-sandbox.md` §2): agent, 2026-11-26. Built:
  the generic host and child runtime (`server/src/sandbox/`, permission model, IPC protocol,
  per-call capabilities, timeouts, crash switch-off), `ProviderHttp` over a hop transport and the
  HTTP bridge. Left: the provider guest (a bundle of the carriers serving `fetchAccount`, `track`,
  `readLive` and sign-in turns, with session/logger/reportUnknown brokered),
  `OPENPARCELS_PROVIDER_ISOLATION=off|pool`, the bundle entry for `sandbox/child` and the guest,
  a check that the compiled child starts under the permission model in the image, and the
  fixture suites run in both modes
