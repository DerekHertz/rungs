#!/usr/bin/env node
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { formatReport, loadCases, runBench } from "./jev/bench.ts";
import type { ClaimInput } from "./jev/claim-gate.ts";
import { createJevClient } from "./jev/client.ts";
import { BENCH_GATES, GATES_DIR } from "./jev/results.ts";

/**
 * `npm run bench -- <gate>` runs one gate over gates/<gate>/cases.json, twice, against the real
 * Jev (TYPESAFE_API_KEY in the environment), prints the report, and writes
 * gates/<gate>/results/<date>-<model>.json and .txt. A second run on the same day and model adds
 * -2, -3 and so on, so no result is overwritten. The cases' text is sent to TypeSafe; they are
 * public pull requests and hand-written text.
 */
const id = process.argv[2];
const entry = id === undefined ? undefined : BENCH_GATES[id];
if (id === undefined || entry === undefined) {
  console.error(`usage: npm run bench -- <gate>   (gates: ${Object.keys(BENCH_GATES).join(", ")})`);
  process.exit(2);
}
const key = process.env.TYPESAFE_API_KEY;
if (key === undefined || key === "") {
  console.error("bench: no TYPESAFE_API_KEY in the environment; nothing was sent");
  process.exit(2);
}
const file = await loadCases<ClaimInput>(join(GATES_DIR, id, "cases.json"));
const client = createJevClient({ key });
console.error(`bench: ${file.cases.length} cases of gate ${id}, two runs, on ${client.model}`);
const report = await runBench({ gate: entry.gate, file, client, thresholds: entry.thresholds });
const text = formatReport(report);
console.log(text);
const dir = join(GATES_DIR, id, "results");
await mkdir(dir, { recursive: true });
const day = new Date().toISOString().slice(0, 10);
let name = `${day}-${report.model}`;
for (let n = 2; await exists(join(dir, `${name}.json`)); n++) name = `${day}-${report.model}-${n}`;
await writeFile(join(dir, `${name}.json`), `${JSON.stringify(report, null, 1)}\n`);
await writeFile(join(dir, `${name}.txt`), `${text}\n`);
console.error(`bench: wrote gates/${id}/results/${name}.json and .txt`);

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
