import { readFileSync } from "node:fs";

/**
 * The guide for AI agents (`server/agent-guide.md`), its one copy: the server serves it as
 * `/llms.txt` and the web UI's "For AI agents" page bundles the same file. This module sits at the
 * top of `src`, like `logos.ts`, so `../agent-guide.md` resolves the same from `src`, `dist` and the
 * bundle (`tools/bundle.ts` copies the file).
 */
export const AGENT_GUIDE = readFileSync(new URL("../agent-guide.md", import.meta.url), "utf8");
