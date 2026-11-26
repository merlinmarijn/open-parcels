import { AGENT_GUIDE } from "../../agent-guide.js";
import type { TypedApp } from "../app.js";

/** `/llms.txt`: the guide for AI agents (`server/agent-guide.md`), where agents look for one. */
export function registerAgentGuideRoutes(app: TypedApp): void {
  app.get(
    "/llms.txt",
    {
      schema: {
        tags: ["agents"],
        summary: "How an AI agent operates and debugs this server (Markdown).",
        description: "Holds no data and no secrets, so it needs no login.",
        security: [],
        // No response schema: the zod serializer would send the text as a JSON string.
      },
    },
    (_request, reply) =>
      reply
        .header("content-type", "text/markdown; charset=utf-8")
        .header("cache-control", "public, max-age=3600")
        .send(AGENT_GUIDE),
  );
}
