import { afterAll, expect, test } from "vitest";
import { extract } from "../src/extract/extract.ts";
import type { FileTree } from "../src/graph.ts";
import { observedDocument, treeDigest } from "../src/observed.ts";
import type { TestRun } from "../src/observed.ts";
import { serve } from "../src/server.ts";

const base: FileTree = new Map([["package.json", "{}\n"]]);
const head: FileTree = new Map([
  ["package.json", "{}\n"],
  ["test/a.test.mjs", 'import { test } from "node:test";\ntest("works", () => {});\n'],
]);
const against = { ref: "main", commit: "3f2a9c1d00000000000000000000000000000000", tree: base };
const run: TestRun = {
  status: "ran",
  runner: "node",
  isolation: "bwrap",
  seconds: 1.5,
  exitCode: 1,
  deleted: [],
  edited: [],
  reports: [
    { file: "test/a.test.mjs", path: ["works"], outcome: "fail", ms: 3, message: "nope" },
    { file: "test/a.test.mjs", path: ["elsewhere"], outcome: "pass", ms: 1 },
  ],
};

const observed = await serve(head, 0, against, undefined, undefined, undefined, run);
const plain = await serve(head, 0, against);
afterAll(async () => {
  await observed.close();
  await plain.close();
});

const get = (server: { url: string }, path: string) => fetch(new URL(path, server.url));

test("/observed.json attaches the run to the head graph's test functions, keyed by the head tree's digest", async () => {
  const response = await get(observed, "observed.json");
  expect(response.headers.get("content-type")).toMatch(/^application\/json/);
  const document = await response.json();
  expect(document).toEqual(observedDocument(run, extract(head), treeDigest(head)));
  expect(document).toMatchObject({
    tier: "observed",
    tree: treeDigest(head),
    tests: { 'function:test/a.test.mjs#"test(\\"works\\") callback"': [{ name: "works", outcome: "fail", ms: 3, message: "nope" }] },
    unmatched: [{ file: "test/a.test.mjs", name: "elsewhere", why: "no test function in the file has this name" }],
  });
});

test("observed facts never enter the graph or the comparison", async () => {
  for (const path of ["graph.json", "comparison.json", "contracts.json", "claims.json", "test-changes.json"]) {
    expect([path, await (await get(observed, path)).text()]).toEqual([path, await (await get(plain, path)).text()]);
  }
});

test("without a run /observed.json is 404", async () => {
  expect((await get(plain, "observed.json")).status).toBe(404);
});
