import { startServer } from "./server.js";

startServer(process.env)
  .then((server) => {
    const shutdown = (signal: string): void => {
      server.logger.info({ signal }, "Shutting down.");
      server
        .stop()
        .then(() => process.exit(0))
        .catch((error: unknown) => {
          server.logger.error({ err: error }, "Shutdown failed.");
          process.exit(1);
        });
    };
    process.once("SIGTERM", () => {
      shutdown("SIGTERM");
    });
    process.once("SIGINT", () => {
      shutdown("SIGINT");
    });
  })
  .catch((error: unknown) => {
    // The logger may not exist yet (bad configuration), so this is the one place that writes to stderr directly.
    process.stderr.write(
      `open-parcels failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
