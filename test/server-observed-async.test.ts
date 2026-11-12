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
  reports: [{ file: "test/a.test.mjs", path: ["works"], outcome: "fail", ms: 3, message: "nope" }],
};

const servers: { close(): Promise<void> }[] = [];
afterAll(async () => {
  for (const server of servers) await server.close();
});

/** A run that stays open until the test settles it. */
function controlled() {
  let settle: (value: TestRun | Error) => void = () => {};
  const started = { count: 0 };
  const start = (): Promise<TestRun> => {
    started.count += 1;
    return new Promise<TestRun>((resolve, reject) => (settle = (value) => (value instanceof Error ? reject(value) : resolve(value))));
  };
  return { start, settle: (value: TestRun | Error) => settle(value), started };
}
const open = async (tests?: TestRun | (() => Promise<TestRun>)) => {
  const server = await serve(head, 0, against, undefined, undefined, undefined, undefined, tests);
  servers.push(server);
  return server;
};
const observed = async (server: { url: string }) => (await fetch(new URL("observed.json", server.url))).json() as Promise<{ status: string }>;
const finished = async (server: { url: string }) => {
  let document = await observed(server);
  for (let tries = 0; tries < 200 && document.status === "running"; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    document = await observed(server);
  }
  return document;
};

test("the page is served while /observed.json says running; the finished document replaces it", async () => {
  const control = controlled();
  const server = await open(control.start);
  expect((await fetch(server.url)).status).toBe(200);
  expect(await observed(server)).toEqual({ tier: "observed", tree: treeDigest(head), status: "running" });
  expect(control.started.count).toBe(1);
  control.settle(run);
  expect(await finished(server)).toEqual(observedDocument(run, extract(head), treeDigest(head)));
  expect(control.started.count).toBe(1);
});

test("a run that throws leaves the server up and the tests not run, with the reason", async () => {
  const control = controlled();
  const server = await open(control.start);
  expect(await observed(server)).toMatchObject({ status: "running" });
  control.settle(new Error("the sandbox fell over"));
  expect(await finished(server)).toEqual({ tier: "observed", tree: treeDigest(head), status: "stopped", why: "the test run stopped: the sandbox fell over" });
  expect((await fetch(server.url)).status).toBe(200);
});

test("a runner that throws before it returns a promise is stopped with the reason, and serve does not reject", async () => {
  const server = await open(() => {
    throw new Error("threw at once");
  });
  expect(await finished(server)).toMatchObject({ status: "stopped", why: "the test run stopped: threw at once" });
  expect((await fetch(server.url)).status).toBe(200);
});

test("a run handed in finished is served as it was, with no running phase", async () => {
  const server = await open(run);
  expect(await observed(server)).toMatchObject({ status: "ran" });
});

test("with tests off there is no /observed.json", async () => {
  const server = await open();
  expect((await fetch(new URL("observed.json", server.url))).status).toBe(404);
});
