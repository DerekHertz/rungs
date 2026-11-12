#!/usr/bin/env node
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { formatReport, loadCases, rescore, runBench } from "./jev/bench.ts";
import type { BenchReport, CaseFile, SavedAnswer } from "./jev/bench.ts";
import { createJevClient } from "./jev/client.ts";
import { BENCH_GATES, GATES_DIR, compareRuns } from "./jev/results.ts";
import { formatKinds, kindsOf } from "./jev/stakes-adoption.ts";
import type { StakesInput } from "./jev/stakes-gate.ts";

/**
 * `npm run bench -- <gate> [--repeat] [--rescore <results file>]`
 *
 * Live (the default): runs the gate over gates/<gate>/cases.json once against the real Jev
 * (TYPESAFE_API_KEY in the environment). An answer saved in the newest result is reused for a case
 * whose state, question version, thresholds and model are unchanged; only the rest is asked.
 * `--repeat` makes a fresh measurement instead: every case is asked twice, to measure decisions
 * changed between runs (use it on the first live run of a new question version or model).
 *
 * `--rescore <file>` scores a saved result against the cases' current labels with no call to Jev
 * and no key, and writes a new result that says where it was re-scored from.
 *
 * Either way it prints the report and writes gates/<gate>/results/<date>-<model>.json and .txt
 * (a repeat on the same day and model adds -2, -3 and so on, so no result is overwritten). The
 * cases' text is sent to TypeSafe on a live run; it is public pull requests and hand-written text.
 */
const args = process.argv.slice(2);
const id = args[0];
const repeat = args.includes("--repeat");
const at = args.indexOf("--rescore");
const rescoreFile = at === -1 ? undefined : args[at + 1];
const entry = id === undefined ? undefined : BENCH_GATES[id];
if (id === undefined || entry === undefined || (at !== -1 && rescoreFile === undefined) || (rescoreFile !== undefined && repeat)) {
  console.error(`usage: npm run bench -- <gate> [--repeat | --rescore <results file>]   (gates: ${Object.keys(BENCH_GATES).join(", ")})`);
  process.exit(2);
}
const dir = join(GATES_DIR, id, "results");
const file = await loadCases(join(GATES_DIR, id, "cases.json"));
let report: BenchReport;
if (rescoreFile !== undefined) {
  const previous = JSON.parse(await readFile(rescoreFile, "utf8")) as BenchReport;
  report = rescore({ gate: entry.gate, file, previous, from: rescoreFile.split("/").at(-1) ?? rescoreFile });
} else {
  const key = process.env.TYPESAFE_API_KEY;
  if (key === undefined || key === "") {
    console.error("bench: no TYPESAFE_API_KEY in the environment; nothing was sent");
    process.exit(2);
  }
  const client = createJevClient({ key });
  let saved: Readonly<Record<string, SavedAnswer>> | undefined;
  if (!repeat) {
    const names = (await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -".json".length)).sort(compareRuns);
    const newest = names.at(-1);
    if (newest !== undefined) saved = (JSON.parse(await readFile(join(dir, `${newest}.json`), "utf8")) as BenchReport).runs[0].answers;
  }
  console.error(`bench: ${file.cases.length} cases of gate ${id}, ${repeat ? "two fresh runs" : "one run, reusing saved answers whose state is unchanged"}, on ${client.model}`);
  report = await runBench({ gate: entry.gate, file, client, thresholds: entry.thresholds, repeat, ...(saved === undefined ? {} : { saved }) });
}
await mkdir(dir, { recursive: true });
const day = new Date().toISOString().slice(0, 10);
let name = `${day}-${report.model}`;
for (let n = 2; await exists(join(dir, `${name}.json`)); n++) name = `${day}-${report.model}-${n}`;
// The stakes gate is also scored over each kind's own cases, with the same bar and no call to Jev: a kind that misses is "not judged".
const kinds = id === "stakes" ? kindsOf(file as CaseFile<StakesInput>, report, name) : undefined;
const text = kinds === undefined ? formatReport(report) : `${formatReport(report)}\n${formatKinds(kinds)}`;
console.log(text);
await writeFile(join(dir, `${name}.json`), `${JSON.stringify(report, null, 1)}\n`);
await writeFile(join(dir, `${name}.txt`), `${text}\n`);
console.error(`bench: wrote gates/${id}/results/${name}.json and .txt`);
if (kinds !== undefined) {
  await writeFile(join(GATES_DIR, id, "kinds.json"), `${JSON.stringify(kinds, null, 1)}\n`);
  console.error(`bench: wrote gates/${id}/kinds.json`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
