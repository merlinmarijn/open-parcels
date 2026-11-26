/** Setup file of the `providers-pool` project: each test file's sandbox child ends with the file. */
import { afterAll } from "vitest";
import { stopTestPool } from "./manifests.js";

afterAll(() => {
  stopTestPool();
});
