import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { claimGate, CLAIM_THRESHOLDS } from "./claim-gate.ts";
import type { ClaimInput } from "./claim-gate.ts";
import type { Gate, Thresholds } from "./gate.ts";
import { rateOf } from "./rate.ts";
import type { GateRate, GateRatesDocument, ReportLike } from "./rate.ts";

const run = promisify(execFile);

/** The gates the bench can run, by id: the gate and the thresholds it ships with. Each gate adds itself here beside its `gates/<id>/` folder. */
export const BENCH_GATES: Readonly<Record<string, { readonly gate: Gate<ClaimInput>; readonly thresholds: Thresholds }>> = {
  claim: { gate: claimGate, thresholds: CLAIM_THRESHOLDS },
};

/** The folder of gates, `gates/` at the repository root. */
export const GATES_DIR = new URL("../../gates/", import.meta.url).pathname;

/** Where results are read from: names relative to the gates folder ("claim/results/x.json"), and a reader of one. */
interface Source {
  readonly files: readonly string[];
  read(file: string): Promise<string>;
}

const git = async (dir: string, args: string[]): Promise<string> => (await run("git", args, { cwd: dir, maxBuffer: 1 << 26 })).stdout;

/**
 * Inside a git work tree only the files committed at HEAD count, read as committed: a newer
 * uncommitted or edited result cannot make the page report adoption. Anywhere else (an installed
 * package) the files are read as shipped.
 */
async function sourceOf(dir: string): Promise<Source> {
  const inside = (await git(dir, ["rev-parse", "--is-inside-work-tree"]).catch(() => "")).trim() === "true";
  if (inside) {
    const listed = await git(dir, ["ls-tree", "-r", "--name-only", "HEAD", "--", "."]).catch(() => "");
    return { files: listed.split("\n").filter((name) => name !== ""), read: (file) => git(dir, ["show", `HEAD:./${file}`]) };
  }
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const ids = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const files: string[] = [];
  for (const id of ids) {
    try {
      for (const name of await readdir(join(dir, id, "results"))) files.push(`${id}/results/${name}`);
    } catch {
      continue;
    }
  }
  return { files, read: (file) => readFile(join(dir, file), "utf8") };
}

/** Orders results by date, then by repeat-run suffix as a number (no suffix is the first run), then by model. */
export function compareRuns(a: string, b: string): number {
  const parts = (stem: string): { date: string; repeat: number; rest: string } => {
    const match = /^(\d{4}-\d{2}-\d{2})-(.*?)(?:-(\d+))?$/.exec(stem);
    return match === null ? { date: stem, repeat: 1, rest: "" } : { date: match[1]!, repeat: match[3] === undefined ? 1 : Number(match[3]), rest: match[2]! };
  };
  const x = parts(a);
  const y = parts(b);
  if (x.date !== y.date) return x.date < y.date ? -1 : 1;
  if (x.repeat !== y.repeat) return x.repeat - y.repeat;
  return x.rest < y.rest ? -1 : x.rest > y.rest ? 1 : 0;
}

/** The newest result of one gate, or undefined when there is none or it cannot be read. */
async function latestRate(source: Source, gate: string): Promise<GateRate | undefined> {
  const prefix = `${gate}/results/`;
  const stems = source.files.filter((file) => file.startsWith(prefix) && file.endsWith(".json") && !file.slice(prefix.length).includes("/")).map((file) => file.slice(prefix.length, -".json".length));
  const newest = stems.sort(compareRuns).at(-1);
  if (newest === undefined) return undefined;
  try {
    const report = JSON.parse(await source.read(`${prefix}${newest}.json`)) as ReportLike;
    if (report.gate !== gate || typeof report.adopted !== "boolean" || !Array.isArray(report.wrongPasses)) return undefined;
    return rateOf(report, newest);
  } catch {
    return undefined;
  }
}

/** What /gate-rates.json serves: the newest committed result of every gate folder under `dir`. A gate with no readable result is left out, and the page says its rate is not measured. */
export async function gateRates(dir: string = GATES_DIR): Promise<GateRatesDocument> {
  const source = await sourceOf(dir);
  const ids = [...new Set(source.files.filter((file) => file.includes("/results/")).map((file) => file.split("/")[0]!))].sort();
  const gates: Record<string, GateRate> = {};
  for (const id of ids) {
    const rate = await latestRate(source, id);
    if (rate !== undefined) gates[id] = rate;
  }
  return { tier: "measured", gates };
}
