# In progress

Items being worked on right now, with who is on it. Move them to `DONE.md` when shipped.

## Glossary consistency pass (server repo) — Claude, from 2026-11-24

- [ ] Consistency pass against `docs/glossary.md`: bring all code identifiers, API fields, DB
      columns, events, web UI text, docs, README, website, org profile, Home Assistant integration
      and app to the glossary terms; renames that cross a public boundary keep the old names
      working for one release as listed in the glossary's Renames table. Do this before the
      provider rewrite starts. Includes OP-044: the server says when an expected delivery is whole
      days (local dates in the server's zone, next to `expected_from` / `expected_to`), the web
      renders from that instead of guessing in the browser's zone.
