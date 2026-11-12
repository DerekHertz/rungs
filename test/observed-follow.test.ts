import { expect, test } from "vitest";
import { followObserved } from "../src/observed-follow.ts";
import type { ObservedDocument } from "../src/observed-types.ts";

const running: ObservedDocument = { tier: "observed", tree: "t", status: "running" };
const done: ObservedDocument = { tier: "observed", tree: "t", status: "refused", why: "no sandbox" };
const quick = () => Promise.resolve();

test("polls until the run is done, showing the finished document, and stops there", async () => {
  let reads = 0;
  const shown: ObservedDocument[] = [];
  await followObserved(running, () => Promise.resolve(++reads < 3 ? running : done), quick, (document) => shown.push(document));
  expect(reads).toBe(3);
  expect(shown).toEqual([done]);
});

test("five failed reads in a row leave the tests not run, with why", async () => {
  const shown: ObservedDocument[] = [];
  await followObserved(running, () => Promise.resolve(null), quick, (document) => shown.push(document));
  expect(shown).toEqual([{ tier: "observed", tree: "t", status: "stopped", why: "the page could not read the server's test progress" }]);
});

test("a finished document of another tree is never shown as this picture's: the wait ends as stopped", async () => {
  const other: ObservedDocument = { tier: "observed", tree: "head-B", status: "refused", why: "no sandbox" };
  const shown: ObservedDocument[] = [];
  await followObserved({ ...running, tree: "head-A" }, () => Promise.resolve(other), quick, (document) => shown.push(document));
  expect(shown).toEqual([{ tier: "observed", tree: "head-A", status: "stopped", why: "the server now serves another tree" }]);
});

test("a running document of another tree also ends the wait", async () => {
  const shown: ObservedDocument[] = [];
  await followObserved({ ...running, tree: "head-A" }, () => Promise.resolve({ ...running, tree: "head-B" }), quick, (document) => shown.push(document));
  expect(shown[0]).toMatchObject({ status: "stopped", why: "the server now serves another tree" });
});

test("one failed read between answers is forgiven", async () => {
  const answers: (ObservedDocument | null)[] = [null, running, null, done];
  const shown: ObservedDocument[] = [];
  await followObserved(running, () => Promise.resolve(answers.shift() ?? null), quick, (document) => shown.push(document));
  expect(shown).toEqual([done]);
});
