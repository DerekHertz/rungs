import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import type { NodeId } from "../src/graph.ts";
import { judgedSource } from "../src/jev/source.ts";
import type { GateRunner } from "../src/jev/source.ts";
import { judgeItems, judgedDocument, setKey } from "../src/jev/store.ts";
import type { Item } from "../src/jev/store.ts";
import { fakeClient, response, toyGate, toyThresholds } from "./jev-fixtures.ts";
import type { ToyInput } from "./jev-fixtures.ts";

const scratch: string[] = [];
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "streets-judged-"));
  scratch.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const items: Item<ToyInput>[] = [
  { key: "claim:0", about: { claim: 0 }, input: { claim: "adds", text: "adds numbers" } },
  { key: "nodes:a", about: { nodes: ["function:src/a.ts#add" as NodeId] }, input: { claim: "reads", text: "writes" } },
];
const run = (cacheDir: string, client = fakeClient(), over: { base?: string; head?: string; items?: Item<ToyInput>[] } = {}) =>
  judgeItems({ gate: toyGate, items: over.items ?? items, thresholds: toyThresholds, client, base: over.base ?? "b1", head: over.head ?? "h1", cacheDir });

test("a record holds the question, what was shown, probabilities, threshold, model, cost and where it attaches", async () => {
  const first = await run(temp());
  const [claim, nodes] = first.outcomes;
  expect(claim).toMatchObject({ status: "judged", cached: false });
  if (claim?.status !== "judged" || nodes?.status !== "judged") throw new Error("expected judged");
  expect(claim.record).toEqual({
    tier: "judged",
    key: "claim:0",
    about: { claim: 0 },
    question: { id: "toy", version: "toy-v1" },
    shown: { state: { claim: "adds", text: "adds numbers" }, questions: toyGate.questions },
    answers: { shown: { type: "yes-no", yes: 0.97 } },
    thresholds: toyThresholds,
    verdict: "settled",
    model: "fake-1",
    inputTokens: 100,
    usd: 100 * 0.042 / 1e6,
  });
  expect(nodes.record.about).toEqual({ nodes: ["function:src/a.ts#add"] });
  expect(nodes.record.verdict).toBe("flagged");
  expect(first.usd).toBeCloseTo(2 * 100 * 0.042 / 1e6, 12);
});

test("a second load of the same comparison makes no classifier call and returns the same records", async () => {
  const dir = temp();
  const a = await run(dir);
  const client = fakeClient();
  const b = await run(dir, client);
  expect(client.requests).toHaveLength(0);
  expect(b.calls).toBe(0);
  expect(b.usd).toBe(0);
  expect(b.set).toEqual(a.set);
  expect(b.outcomes.every((outcome) => outcome.status === "judged" && outcome.cached)).toBe(true);
});

test("the store is keyed by base tree, head tree, question version and model", async () => {
  const dir = temp();
  await run(dir);
  const other = fakeClient();
  await run(dir, other, { head: "h2" });
  expect(other.requests).toHaveLength(2);
  await run(dir, other, { base: "b2" });
  expect(other.requests).toHaveLength(4);
  expect(readdirSync(join(dir, "judged"))).toHaveLength(3);
  const version = { id: "toy", version: "toy-v2" };
  expect(setKey("b1", "h1", version, "fake-1")).not.toBe(setKey("b1", "h1", { id: "toy", version: "toy-v1" }, "fake-1"));
  expect(setKey("b1", "h1", version, "fake-2")).not.toBe(setKey("b1", "h1", version, "fake-1"));
});

test("an item whose shown text changed is asked again; one that could not be judged is never stored", async () => {
  const dir = temp();
  await run(dir);
  const client = fakeClient();
  const edited = [{ ...items[0]!, input: { claim: "adds", text: "something else" } }, items[1]!];
  const next = await run(dir, client, { items: edited });
  expect(client.requests).toHaveLength(1);
  expect(next.outcomes[0]).toMatchObject({ status: "judged", cached: false });
  const flaky = temp();
  const down = fakeClient((request) => (request.state.claim === "reads" ? Promise.reject(new Error("down")) : Promise.resolve(response(0.97))));
  const partial = await run(flaky, down);
  expect(partial.outcomes[1]).toMatchObject({ status: "not judged", key: "nodes:a" });
  expect(partial.set.records).toHaveLength(1);
  const retry = fakeClient();
  const again = await run(flaky, retry);
  expect(retry.requests).toHaveLength(1);
  expect(again.outcomes.every((outcome) => outcome.status === "judged")).toBe(true);
});

test("the store file is plain JSON holding only the judged tier", async () => {
  const dir = temp();
  await run(dir);
  const [name] = readdirSync(join(dir, "judged"));
  const saved = JSON.parse(readFileSync(join(dir, "judged", name!), "utf8")) as { tier: string; records: { tier: string }[]; nodes?: unknown };
  expect(saved.tier).toBe("judged");
  expect(saved.records.every((record) => record.tier === "judged")).toBe(true);
  expect(saved.nodes).toBeUndefined();
});

test("the document is off with a reason when judging is off, or there is no key", async () => {
  const dir = temp();
  const trees = { baseTree: new Map([["a", "1"]]), headTree: new Map([["a", "2"]]), cacheDir: dir };
  const off = await judgedDocument(judgedSource({ judge: false, env: { TYPESAFE_API_KEY: "k" }, ...trees }));
  expect(off).toMatchObject({ tier: "judged", status: "off", sets: [], usd: 0 });
  expect(off.status === "off" && off.reason).toMatch(/--judge/);
  const noKey = await judgedDocument(judgedSource({ judge: true, env: {}, ...trees }));
  expect(noKey.status === "off" && noKey.reason).toMatch(/TYPESAFE_API_KEY/);
});

test("on, the document runs each gate and lists the checks that were not judged", async () => {
  const dir = temp();
  const client = fakeClient((request) => (request.state.claim === "reads" ? Promise.reject(new Error("down")) : Promise.resolve(response(0.97))));
  const runner: GateRunner = (context) => judgeItems({ gate: toyGate, items, thresholds: toyThresholds, client: context.client, base: context.base, head: context.head, cacheDir: context.cacheDir });
  const source = judgedSource({ judge: true, env: {}, baseTree: new Map([["a", "1"]]), headTree: new Map([["a", "2"]]), cacheDir: dir, client, runners: [runner] });
  const document = await judgedDocument(source);
  expect(document.status).toBe("on");
  expect(document.sets).toHaveLength(1);
  expect(document.notJudged).toEqual([{ gate: "toy", key: "nodes:a", about: { nodes: ["function:src/a.ts#add"] }, reason: "the classifier failed" }]);
  expect(document.usd).toBeGreaterThan(0);
});
