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

test("one failed read between answers is forgiven", async () => {
  const answers: (ObservedDocument | null)[] = [null, running, null, done];
  const shown: ObservedDocument[] = [];
  await followObserved(running, () => Promise.resolve(answers.shift() ?? null), quick, (document) => shown.push(document));
  expect(shown).toEqual([done]);
});
