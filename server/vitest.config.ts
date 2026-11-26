import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // A skipped test reports green while proving nothing; treat .only/.skip leftovers as failures.
    allowOnly: false,
    passWithNoTests: false,
    // The first API test of a file builds the server and migrates a fresh database; with parallel
    // workers that alone came close to the 5 s default and timed out a different test each run.
    testTimeout: 15_000,
    projects: [
      {
        extends: true,
        test: { name: "server", include: ["src/**/*.test.ts", "test/**/*.test.ts"] },
      },
      {
        // The carrier suites again, every built-in provider served from a sandbox child
        // (OPENPARCELS_PROVIDER_ISOLATION=pool), so both isolation modes pass the same fixtures.
        extends: true,
        test: {
          name: "providers-pool",
          include: ["test/carriers/**/*.test.ts"],
          globalSetup: ["test/provider-pool-setup.ts"],
          setupFiles: ["test/provider-pool-teardown.ts"],
        },
      },
    ],
  },
});
