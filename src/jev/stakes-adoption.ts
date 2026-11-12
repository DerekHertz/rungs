import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { HARM_CATALOGUE, HARM_CATALOGUE_VERSION } from "../harm-catalogue.ts";
import type { KindChoice } from "../stakes.ts";
import { rescore } from "./bench.ts";
import type { BenchReport, CaseFile, RunResult } from "./bench.ts";
import { GATES_DIR } from "./results.ts";
import { STAKES_GATE_ID, stakesGate } from "./stakes-gate.ts";
import type { StakesInput } from "./stakes-gate.ts";

/*
 * Which kinds of harm the stakes gate may judge. The bench's bar is measured over all the cases and
 * again over each kind's own cases: a kind that misses it is "not judged", per kind and never per
 * term. `gates/stakes/kinds.json` is written from the bench's result (the committed file is checked
 * against it by a test), so the setup reads the outcome and never re-derives it.
 */

/** What the bench measured for one kind, and whether the kind met the bar. */
export interface KindBench {
  readonly adopted: boolean;
  readonly good: number;
  readonly broken: number;
  readonly cannotTell: number;
  readonly steering: number;
  /** Broken cases settled: a harm that is there, judged a confident no. */
  readonly wrongPasses: number;
  readonly unclearPassed: number;
  readonly steeringPassed: number;
  /** Good cases flagged: no harm there, judged a confident yes. Recorded, no limit. */
  readonly wrongFlags: number;
  readonly undecided: number;
  readonly notJudged: number;
  /** Why the kind is not adopted, from the bench: each missed line of the bar and each blocker. Empty when adopted. */
  readonly missed: readonly string[];
}

export interface StakesKindsFile {
  readonly gate: typeof STAKES_GATE_ID;
  readonly gateVersion: string;
  readonly catalogueVersion: number;
  readonly model: string;
  /** The name of the bench result this is written from, without its extension. */
  readonly result: string;
  /** Whether the whole gate met the bar over all its cases. Without it no kind is adopted. */
  readonly adopted: boolean;
  readonly overall: { readonly missed: readonly string[] };
  readonly kinds: Readonly<Record<string, KindBench>>;
}

const restrict = (run: RunResult, ids: ReadonlySet<string>): RunResult => {
  // No prototype: a case id such as "__proto__" is an ordinary key.
  const pick = <T>(table: Readonly<Record<string, T>> | undefined): Record<string, T> => {
    const kept: Record<string, T> = Object.create(null) as Record<string, T>;
    for (const [id, value] of Object.entries(table ?? {})) if (ids.has(id)) kept[id] = value;
    return kept;
  };
  return { ...run, decisions: pick(run.decisions), ...(run.answers === undefined ? {} : { answers: pick(run.answers) }) };
};

/** The lines of a report's bar that were missed, and its blockers, in words. */
const missedOf = (report: BenchReport): string[] => [...report.bar.filter((row) => !row.met).map((row) => `${row.measure} ${row.got === null ? "not measured" : row.got.toFixed(4)} over ${row.max}`), ...report.blockers];

/**
 * Scores a bench report again over each kind's own cases, with the same bar and no call to Jev,
 * and says which kinds met it. A kind is adopted only if the whole gate was.
 */
export function kindsOf(file: CaseFile<StakesInput>, report: BenchReport, result: string): StakesKindsFile {
  const kinds: Record<string, KindBench> = {};
  for (const kind of HARM_CATALOGUE) {
    const cases = file.cases.filter((one) => one.input.kind === kind.id);
    if (cases.length === 0) continue;
    const ids = new Set(cases.map((one) => one.id));
    const own = rescore({
      gate: stakesGate,
      file: { gate: file.gate, ...(file.bar === undefined ? {} : { bar: file.bar }), cases },
      previous: { ...report, runs: [restrict(report.runs[0], ids), report.runs[1] === null ? null : restrict(report.runs[1], ids)] },
      from: result,
    });
    kinds[kind.id] = {
      adopted: report.adopted && own.adopted,
      good: own.counts.good,
      broken: own.counts.broken,
      cannotTell: own.counts.cannotTell,
      steering: own.counts.steering,
      wrongPasses: own.wrongPasses.length,
      unclearPassed: own.unclearPassed.length,
      steeringPassed: own.steeringPassed.length,
      wrongFlags: own.wrongFlags.length,
      undecided: own.undecided.length,
      notJudged: own.notJudged.length,
      missed: missedOf(own),
    };
  }
  return { gate: STAKES_GATE_ID, gateVersion: report.version, catalogueVersion: HARM_CATALOGUE_VERSION, model: report.model, result, adopted: report.adopted, overall: { missed: missedOf(report) }, kinds };
}

/** The kinds the setup may ask about, and why each other is "not judged". A kind answered by code is never gated by the bench, since Jev is not asked. */
export function kindChoice(file: StakesKindsFile | undefined): KindChoice {
  const why = (reason: string): KindChoice => ({
    asked: HARM_CATALOGUE.filter((kind) => kind.answer === "code").map((kind) => kind.id),
    notJudged: HARM_CATALOGUE.filter((kind) => kind.answer === "judgement").map((kind) => ({ id: kind.id, reason })),
  });
  if (file === undefined) return why("the stakes gate has no bench result");
  if (file.gateVersion !== stakesGate.version || file.catalogueVersion !== HARM_CATALOGUE_VERSION) return why(`the bench result is for ${file.gateVersion} and catalogue version ${file.catalogueVersion}, not the current ones`);
  if (!file.adopted) return why("the stakes gate missed the bench bar: gate not adopted");
  const asked: string[] = [];
  const notJudged: { id: string; reason: string }[] = [];
  for (const kind of HARM_CATALOGUE) {
    if (kind.answer === "code" || file.kinds[kind.id]?.adopted === true) asked.push(kind.id);
    else notJudged.push({ id: kind.id, reason: file.kinds[kind.id] === undefined ? "no bench cases for this kind" : "missed the bench bar" });
  }
  return { asked, notJudged };
}

/** `gates/stakes/kinds.json`, or undefined when there is none or it cannot be read. */
export async function readKindsFile(dir: string = GATES_DIR): Promise<StakesKindsFile | undefined> {
  try {
    const file = JSON.parse(await readFile(join(dir, STAKES_GATE_ID, "kinds.json"), "utf8")) as StakesKindsFile;
    return file.gate === STAKES_GATE_ID && typeof file.adopted === "boolean" && typeof file.kinds === "object" && file.kinds !== null ? file : undefined;
  } catch {
    return undefined;
  }
}

/** The per-kind result as lines a person reads. */
export function formatKinds(file: StakesKindsFile): string {
  const lines = [`stakes gate ${file.gateVersion}, catalogue version ${file.catalogueVersion}: ${file.adopted ? "met the bar over all its cases" : "did not meet the bar over all its cases: gate not adopted, no kind is judged"}`];
  for (const missed of file.overall.missed) lines.push(`  gate: ${missed}`);
  for (const kind of HARM_CATALOGUE) {
    const one = file.kinds[kind.id];
    if (one === undefined) continue;
    lines.push(`kind ${kind.name}: ${one.adopted ? "judged" : "not judged"}: ${one.good} good, ${one.broken} broken (${one.steering} steering), ${one.cannotTell} cannot tell; wrong passes ${one.wrongPasses}, cannot-tell settled ${one.unclearPassed}, steering settled ${one.steeringPassed}, good flagged ${one.wrongFlags}, good undecided ${one.undecided}, not judged ${one.notJudged}${one.missed.length === 0 ? "" : `; missed: ${one.missed.join("; ")}`}`);
  }
  return lines.join("\n");
}
