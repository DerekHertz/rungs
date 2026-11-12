import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import type { FileTree } from "../src/graph.ts";
import { jevCost } from "../src/jev/client.ts";
import type { JevResponse } from "../src/jev/client.ts";
import type { JudgedDocument } from "../src/jev/judged-types.ts";
import { judgedSource } from "../src/jev/source.ts";
import { serve } from "../src/server.ts";
import { DEFAULT_TIERS } from "../src/tier-table.ts";
import { fakeClient, finishedJudged } from "./jev-fixtures.ts";

const servers: { close(): Promise<void> }[] = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const server of servers) await server.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const base: FileTree = new Map([
  ["package.json", "{}\n"],
  ["AGENTS.md", "# Rules\nWrite the red test first.\n"],
  ["src/a.ts", "export function a() {\n  return 1;\n}\n"],
]);
const head: FileTree = new Map([...base, ["src/a.ts", "export function a() {\n  return 2;\n}\n"]]);

/** Jev says the changed lines break the rule with this chance, and the base's lines do not. */
const sure = (breaks: number) => fakeClient((): JevResponse => ({ answers: { breaks: { type: "yes-no", yes: breaks }, before: { type: "yes-no", yes: 0.01 } }, usage: { inputTokens: 100, outputTokens: 3, usd: jevCost(100) }, model: "fake-1" }));

async function judgedWith(breaks: number, table = DEFAULT_TIERS): Promise<JudgedDocument> {
  const cacheDir = mkdtempSync(join(tmpdir(), "streets-tiers-"));
  dirs.push(cacheDir);
  const tiering = { table, vocabulary: { status: "missing" as const, why: "no vocabulary is stored for this repository" } };
  const judged = judgedSource({ judge: true, env: {}, baseTree: base, headTree: head, cacheDir, client: sure(breaks), tiering });
  const server = await serve(head, 0, { ref: "main", commit: "0".repeat(40), tree: base }, undefined, undefined, undefined, undefined, undefined, undefined, judged);
  servers.push(server);
  return finishedJudged(server.url);
}

test("with no stored vocabulary the stakes are unknown: every record is held to the strictest tier, says why, and a settle must clear it", async () => {
  // 2% chance of a breach passes the gate's own limit (10%) and 95%, and not 99.9%.
  const middling = await judgedWith(0.02);
  const record = middling.sets.find((set) => set.question.id === "standard")!.records[0]!;
  expect(record.pick).toMatchObject({ rule: 1, percent: 99.9, rank: 0 });
  expect(record.pick!.why.join("; ")).toMatch(/stakes: possible harm, no vocabulary is stored for this repository/);
  expect(record.thresholds).toMatchObject({ clear: 0.1, tier: 0.999 });
  expect(record.verdict).toBe("undecided");
  // A breach chance of 0.05% clears even the strictest tier.
  const sureOfIt = await judgedWith(0.0005);
  expect(sureOfIt.sets.find((set) => set.question.id === "standard")!.records[0]).toMatchObject({ verdict: "settled", pick: { percent: 99.9 } });
});

test("the reviewer's table sets the percents, and nothing else about the item's tier", async () => {
  const document = await judgedWith(0.02, [99.99, 99.5, 90]);
  expect(document.sets.find((set) => set.question.id === "standard")!.records[0]).toMatchObject({ pick: { percent: 99.99, rank: 0 }, thresholds: { tier: 0.9999 }, verdict: "undecided" });
});
