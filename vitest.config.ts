import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    passWithNoTests: true,
    // Many tests start node, git or a bwrap sandbox. Vitest's 5 s default is a wall-clock guess
    // that a loaded machine (a second `npm test`, a build) overruns on healthy tests, while a
    // test that is truly stuck still fails, just later. Tests that wait on a clock under test
    // inject it or state their own timeout.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
