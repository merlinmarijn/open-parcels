import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    environment: "node",
    // A skipped test reports green while proving nothing; treat .only/.skip leftovers as failures.
    allowOnly: false,
    passWithNoTests: false,
    // The first API test of a file builds the server and migrates a fresh database; with parallel
    // workers that alone came close to the 5 s default and timed out a different test each run.
    testTimeout: 15_000,
  },
});
