import { expect, test } from "vitest";
import { followObserved, ofPicture } from "../src/observed-follow.ts";
import type { ObservedDocument } from "../src/observed-types.ts";

const running: ObservedDocument = { tier: "observed", tree: "t", status: "running", stage: "tests" };
const done: ObservedDocument = { tier: "observed", tree: "t", status: "refused", why: "no sandbox" };
const quick = () => Promise.resolve();
const other = (document: ObservedDocument, tree: string): ObservedDocument => ({ ...document, tree });
const another = { tier: "observed", tree: "t", status: "stopped", why: "the server now serves another tree" };

test("polls until the run is done, showing the finished document, and stops there", async () => {
  let reads = 0;
  const shown: ObservedDocument[] = [];
  await followObserved("t", () => Promise.resolve(++reads < 3 ? running : done), quick, (document) => shown.push(document));
  expect(reads).toBe(3);
  expect(shown).toEqual([done]);
});

test("the control run's running document keeps the wait going: only the finished one is shown", async () => {
  const control: ObservedDocument = { tier: "observed", tree: "t", status: "running", stage: "control" };
  const answers = [running, control, control, done];
  const shown: ObservedDocument[] = [];
  await followObserved("t", () => Promise.resolve(answers.shift() ?? null), quick, (document) => shown.push(document));
  expect(shown).toEqual([done]);
});

test("a change of stage is handed on once, so an open page can say the control run is going; the tree is still checked", async () => {
  const control: ObservedDocument = { tier: "observed", tree: "t", status: "running", stage: "control" };
  const answers = [running, control, control, done];
  const staged: ObservedDocument[] = [];
  const shown: ObservedDocument[] = [];
  await followObserved("t", () => Promise.resolve(answers.shift() ?? null), quick, (document) => shown.push(document), (document) => staged.push(document), "tests");
  expect(staged).toEqual([control]);
  expect(shown).toEqual([done]);
  const other: ObservedDocument[] = [];
  const stagedOther: ObservedDocument[] = [];
  await followObserved("t", () => Promise.resolve({ ...control, tree: "head-B" }), quick, (document) => other.push(document), (document) => stagedOther.push(document), "tests");
  expect(stagedOther).toEqual([]);
  expect(other).toEqual([another]);
});

test("five failed reads in a row leave the tests not run, with why", async () => {
  const shown: ObservedDocument[] = [];
  await followObserved("t", () => Promise.resolve(null), quick, (document) => shown.push(document));
  expect(shown).toEqual([{ tier: "observed", tree: "t", status: "stopped", why: "the page could not read the server's test progress" }]);
});

test("a finished document of another tree is never shown as this picture's: the wait ends as stopped", async () => {
  const shown: ObservedDocument[] = [];
  await followObserved("t", () => Promise.resolve(other(done, "head-B")), quick, (document) => shown.push(document));
  expect(shown).toEqual([another]);
});

test("a running document of another tree also ends the wait, even as the very first answer", async () => {
  const shown: ObservedDocument[] = [];
  await followObserved("t", () => Promise.resolve(other(running, "head-B")), quick, (document) => shown.push(document));
  expect(shown).toEqual([another]);
});

test("the picture's tree is what is compared: a server that restarted on tree B before the first poll is caught", () => {
  expect(ofPicture(other(done, "head-B"), "t")).toEqual(another);
  expect(ofPicture(other(running, "head-B"), "t")).toEqual(another);
  expect(ofPicture(done, "t")).toBe(done);
  expect(ofPicture(null, "t")).toBeNull();
});

test("one failed read between answers is forgiven", async () => {
  const answers: (ObservedDocument | null)[] = [null, running, null, done];
  const shown: ObservedDocument[] = [];
  await followObserved("t", () => Promise.resolve(answers.shift() ?? null), quick, (document) => shown.push(document));
  expect(shown).toEqual([done]);
});
