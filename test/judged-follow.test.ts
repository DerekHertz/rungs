import { expect, test } from "vitest";
import type { JudgedDocument } from "../src/jev/judged-types.ts";
import { followJudging, updateOf } from "../src/judged-follow.ts";
import type { JudgedUpdate } from "../src/judged-follow.ts";

const claims = [{ index: 0, ids: ["x"] }, { index: 1, ids: ["y"] }];
const pending: JudgedDocument = { tier: "judged", status: "pending", sets: [], notJudged: [], usd: 0, costUnknown: 0, pending: [{ gate: "claim", key: "claim:0", about: { claim: 0 } }, { gate: "claim", key: "claim:1", about: { claim: 1 } }] };

test("when the first document is pending and every poll fails, no mark is left judging", async () => {
  const shown: JudgedUpdate[] = [];
  await followJudging(pending, () => Promise.resolve(null), () => Promise.resolve(), (document) => updateOf(document, claims, true, new Map()), (update) => shown.push(update));
  const last = shown.at(-1)!;
  expect(last.judged).not.toBeNull();
  for (const mark of last.judged!.marks.values()) expect(mark).toMatchObject({ kind: "not judged", reason: expect.stringContaining("could not read") });
  expect(last.judgedSummary).toBe("2 not judged");
});

test("polling stops at the finished document", async () => {
  const done: JudgedDocument = { tier: "judged", status: "on", sets: [], notJudged: [], usd: 0, costUnknown: 0 };
  let reads = 0;
  const shown: JudgedUpdate[] = [];
  await followJudging(pending, () => Promise.resolve(++reads === 1 ? pending : done), () => Promise.resolve(), (document) => updateOf(document, claims, true, new Map()), (update) => shown.push(update));
  expect(reads).toBe(2);
  expect(shown).toHaveLength(2);
});
