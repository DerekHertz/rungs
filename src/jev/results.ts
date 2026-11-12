import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { claimGate, CLAIM_THRESHOLDS } from "./claim-gate.ts";
import type { ClaimInput } from "./claim-gate.ts";
import type { Gate, Thresholds } from "./gate.ts";
import { rateOf } from "./rate.ts";
import type { GateRate, GateRatesDocument, ReportLike } from "./rate.ts";

/** The gates the bench can run, by id: the gate and the thresholds it ships with. Each gate adds itself here beside its `gates/<id>/` folder. */
export const BENCH_GATES: Readonly<Record<string, { readonly gate: Gate<ClaimInput>; readonly thresholds: Thresholds }>> = {
  claim: { gate: claimGate, thresholds: CLAIM_THRESHOLDS },
};

/** The folder of gates, `gates/` at the repository root. */
export const GATES_DIR = new URL("../../gates/", import.meta.url).pathname;

/** The newest result of one gate (results are named by date, then model, so the last name is the newest), or undefined when there is none or it cannot be read. */
async function latestRate(dir: string, gate: string): Promise<GateRate | undefined> {
  let names: string[];
  try {
    names = (await readdir(join(dir, gate, "results"))).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -".json".length)).sort().map((stem) => `${stem}.json`);
  } catch {
    return undefined;
  }
  const newest = names.at(-1);
  if (newest === undefined) return undefined;
  try {
    const report = JSON.parse(await readFile(join(dir, gate, "results", newest), "utf8")) as ReportLike;
    if (report.gate !== gate || typeof report.adopted !== "boolean" || !Array.isArray(report.wrongPasses)) return undefined;
    return rateOf(report, newest.slice(0, -".json".length));
  } catch {
    return undefined;
  }
}

/** What /gate-rates.json serves: the newest committed result of every gate folder under `dir`. A gate with no readable result is left out, and the page says its rate is not measured. */
export async function gateRates(dir: string = GATES_DIR): Promise<GateRatesDocument> {
  let ids: string[];
  try {
    ids = (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    ids = [];
  }
  const gates: Record<string, GateRate> = {};
  for (const id of ids.sort()) {
    const rate = await latestRate(dir, id);
    if (rate !== undefined) gates[id] = rate;
  }
  return { tier: "measured", gates };
}
