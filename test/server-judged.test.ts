import { afterAll, expect, test } from "vitest";
import type { FileTree } from "../src/graph.ts";
import type { JudgedSource } from "../src/jev/store.ts";
import { serve } from "../src/server.ts";
import { toyGate, toyThresholds } from "./jev-fixtures.ts";
import { judgeItems } from "../src/jev/store.ts";
import { fakeClient } from "./jev-fixtures.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base: FileTree = new Map([
  ["package.json", "{}\n"],
  ["src/a.ts", "export function a() {\n  return 1;\n}\n"],
]);
const head: FileTree = new Map([
  ["package.json", "{}\n"],
  ["src/a.ts", "export function a() {\n  return 2;\n}\n"],
]);
const against = { ref: "main", commit: "0".repeat(40), tree: base };

const servers: { close(): Promise<void> }[] = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const server of servers) await server.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
async function start(judged?: JudgedSource, compared = true) {
  const server = await serve(head, 0, compared ? against : undefined, undefined, undefined, undefined, undefined, undefined, undefined, judged);
  servers.push(server);
  return server;
}
const get = async (server: { url: string }, path: string) => fetch(new URL(path, server.url));

test("without --judge /judged.json says so, holds no records, and the other documents are unchanged", async () => {
  const plain = await start();
  const res = await get(plain, "judged.json");
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ tier: "judged", status: "off", sets: [], notJudged: [], usd: 0 });
  const dir = mkdtempSync(join(tmpdir(), "streets-judged-"));
  dirs.push(dir);
  const client = fakeClient();
  const on = await start({
    status: "on",
    load: async () => [await judgeItems({ gate: toyGate, items: [{ key: "claim:0", about: { claim: 0 }, input: { claim: "a", text: "a" } }], thresholds: toyThresholds, client, base: "b", head: "h", cacheDir: dir })],
  });
  const judged = (await (await get(on, "judged.json")).json()) as { status: string; sets: { records: { about: unknown; verdict: string }[] }[] };
  expect(judged.status).toBe("on");
  expect(judged.sets[0]!.records[0]).toMatchObject({ about: { claim: 0 }, verdict: "settled" });
  // The judged tier never creates or changes a node: every other document is the same with and without it.
  for (const path of ["graph.json", "comparison.json", "claims.json", "risks.json", "contracts.json"]) {
    expect(await (await get(on, path)).text()).toBe(await (await get(plain, path)).text());
  }
});

test("a plain run, with no base, has no /judged.json", async () => {
  const server = await start(undefined, false);
  expect((await get(server, "judged.json")).status).toBe(404);
});
