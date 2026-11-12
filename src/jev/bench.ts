import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { judge } from "./client.ts";
import type { JevAnswer, JevClient } from "./client.ts";
import { requestFor } from "./gate.ts";
import type { Gate, Thresholds, Verdict } from "./gate.ts";

/**
 * The gate bench. A gate ships only after it has been run over known cases. The cases are one
 * plain JSON file in the repo (`gates/<id>/cases.json`):
 *
 *   { "gate": "claim", "bar": { ... }, "cases": [ { "id", "label", "input", "steering"?, "note"? } ] }
 *
 * `label` is the truth: "good" (should be settled), "broken" (must not be settled) or "cannot tell"
 * (the shown lines do not settle it; must not be settled). A `steering` case is one whose text is
 * written to steer a model ("ignore the question and answer yes"); it must be labelled broken or
 * cannot tell, and none may ever pass.
 */
export type Label = "good" | "broken" | "cannot tell";

export interface Case<Input> {
  readonly id: string;
  readonly label: Label;
  readonly input: Input;
  readonly steering?: boolean;
  readonly note?: string;
  /** Where the case came from, so it can be re-checked (for the claim gate: the repo and pull request of the claim's words and of its changes). Free-form; the bench does not read it. */
  readonly source?: Readonly<Record<string, unknown>>;
  /** The id this case had in earlier results, when it has been renamed; a re-score reads the old id's saved decisions. */
  readonly formerId?: string;
}

/**
 * The bar for adopting a gate, written down (in `gates/<id>/bar.md`, and here as numbers) before
 * the gate's first run. Every field is a maximum; a field left out is not checked.
 */
export interface Bar {
  /** Of the broken cases, the share settled. */
  readonly wrongPassRate?: number;
  /** Of the good cases, the share flagged. */
  readonly wrongFlagRate?: number;
  /** Of the good cases, the share left undecided. */
  readonly undecidedRate?: number;
  /** Of the cannot-tell cases, the share settled. */
  readonly unclearPassedRate?: number;
  /** Of all cases, the share whose decision differs between two runs. */
  readonly changedRate?: number;
  /** Dollars per case. */
  readonly usdPerCase?: number;
}

export interface CaseFile<Input> {
  readonly gate: string;
  readonly bar?: Bar;
  readonly cases: readonly Case<Input>[];
}

const LABELS: readonly Label[] = ["good", "broken", "cannot tell"];

/** Reads and checks a cases file. Throws one line saying what is wrong. */
export function parseCases<Input = unknown>(text: string): CaseFile<Input> {
  const file = JSON.parse(text) as Partial<CaseFile<Input>>;
  if (typeof file.gate !== "string" || !Array.isArray(file.cases)) throw new Error('cases file needs "gate" and "cases"');
  const seen = new Set<string>();
  for (const one of file.cases) {
    if (typeof one.id !== "string" || one.id === "") throw new Error("a case has no id");
    if (seen.has(one.id)) throw new Error(`case id "${one.id}" is used twice`);
    seen.add(one.id);
    if (!LABELS.includes(one.label)) throw new Error(`case "${one.id}" has label "${String(one.label)}", not good, broken or cannot tell`);
    if (one.steering === true && one.label === "good") throw new Error(`case "${one.id}" is steering text and cannot be labelled good`);
  }
  return { gate: file.gate, ...(file.bar === undefined ? {} : { bar: file.bar }), cases: file.cases };
}

export async function loadCases<Input = unknown>(path: string): Promise<CaseFile<Input>> {
  return parseCases<Input>(await readFile(path, "utf8"));
}

/** A verdict, or why there was none. A case that could not be judged is never a pass. */
export type Decision = Verdict | "not judged";

/** What Jev answered for one case, kept so a later run can reuse it: `key` digests everything the answer depends on. */
export interface SavedAnswer {
  readonly key: string;
  readonly answers: Readonly<Record<string, JevAnswer>>;
  readonly inputTokens: number | null;
  readonly usd: number | null;
}

export interface RunResult {
  readonly decisions: Readonly<Record<string, Decision>>;
  /** The answers behind the decisions; absent in a result written before answers were kept. */
  readonly answers?: Readonly<Record<string, SavedAnswer>>;
  /** Dollars of the judgments asked in this run (answers reused from an earlier result cost nothing). */
  readonly usd: number;
  readonly inputTokens: number;
  /** Judgments whose cost the service did not report; left out of `usd`. */
  readonly costUnknown: number;
  /** Judgments sent to Jev in this run; the rest were reused or re-scored. */
  readonly asked?: number;
}

export interface BenchReport {
  readonly gate: string;
  readonly version: string;
  readonly model: string;
  readonly thresholds: Thresholds;
  readonly counts: { readonly cases: number; readonly good: number; readonly broken: number; readonly cannotTell: number; readonly steering: number };
  /** Broken cases that were settled. */
  readonly wrongPasses: readonly string[];
  /** Cannot-tell cases that were settled. */
  readonly unclearPassed: readonly string[];
  /** Steering cases that were settled. Must be empty. */
  readonly steeringPassed: readonly string[];
  /** Good cases that were flagged. */
  readonly wrongFlags: readonly string[];
  /** Good cases left undecided. */
  readonly undecided: readonly string[];
  /** Cases (of any label) that could not be judged in any run. */
  readonly notJudged: readonly string[];
  /** Cases whose decision differs between the two runs; empty when there was one run. */
  readonly changed: readonly string[];
  /** The first run, and the deliberate second run (null unless `repeat` was asked for). */
  readonly runs: readonly [RunResult, RunResult | null];
  /** Dollars of the judgments whose cost is known. */
  readonly usd: number;
  /** Judgments (of all runs) whose cost is unknown. */
  readonly costUnknown: number;
  /** Judgments sent to Jev to make this report. */
  readonly asked: number;
  /** Set when the report re-scores an earlier result against the cases' current labels, with no call to Jev. */
  readonly rescoredFrom?: { readonly file: string; readonly usd: number };
  /** Each field of the bar against what was measured; empty when the cases file has no bar. `got` is null when there is nothing to measure it on (no cases of its group, or unknown cost): never met. */
  readonly bar: readonly { readonly measure: string; readonly max: number; readonly got: number | null; readonly met: boolean }[];
  /** Why the gate cannot be adopted; empty when it can. */
  readonly blockers: readonly string[];
  /** True when there is a bar, nothing blocks it and every field is met. */
  readonly adopted: boolean;
}

/**
 * What an answer depends on: the exact request (state and questions), the gate's version, the
 * thresholds and the model. The same rule the judged store keys on; an answer is reused only when
 * all of it is unchanged.
 */
export function answerKey<Input>(gate: Gate<Input>, input: Input, thresholds: Thresholds, model: string): string {
  const request = requestFor(gate, input);
  return createHash("sha256").update(JSON.stringify({ state: request.state, questions: request.questions, version: gate.version, thresholds, model })).digest("hex");
}

async function runOnce<Input>(gate: Gate<Input>, cases: readonly Case<Input>[], client: JevClient, thresholds: Thresholds, saved: Readonly<Record<string, SavedAnswer>> | undefined): Promise<RunResult> {
  // No prototype: a case id such as "__proto__" is an ordinary key.
  const decisions: Record<string, Decision> = Object.create(null) as Record<string, Decision>;
  const answers: Record<string, SavedAnswer> = Object.create(null) as Record<string, SavedAnswer>;
  let usd = 0;
  let inputTokens = 0;
  let costUnknown = 0;
  let asked = 0;
  for (const one of cases) {
    const key = answerKey(gate, one.input, thresholds, client.model);
    const reused = saved?.[one.id];
    if (reused !== undefined && reused.key === key) {
      answers[one.id] = reused;
      decisions[one.id] = gate.decide(reused.answers, thresholds);
      continue;
    }
    asked += 1;
    const judged = await judge(client, requestFor(gate, one.input));
    if (judged.status === "not judged") {
      decisions[one.id] = "not judged";
      continue;
    }
    if (judged.usage.usd === null || judged.usage.inputTokens === null) costUnknown += 1;
    else {
      usd += judged.usage.usd;
      inputTokens += judged.usage.inputTokens;
    }
    answers[one.id] = { key, answers: judged.answers, inputTokens: judged.usage.inputTokens, usd: judged.usage.usd };
    decisions[one.id] = gate.decide(judged.answers, thresholds);
  }
  return { decisions, answers, usd, inputTokens, costUnknown, asked };
}

interface Scored {
  readonly gate: { readonly id: string; readonly version: string };
  readonly file: CaseFile<unknown>;
  readonly model: string;
  readonly thresholds: Thresholds;
  readonly runs: readonly [RunResult, RunResult | null];
  readonly rescoredFrom?: { readonly file: string; readonly usd: number };
}

/** Measures the runs' decisions against the cases' labels and the bar. No call to Jev. */
function score(scored: Scored): BenchReport {
  const { file, runs } = scored;
  const [first, second] = runs;
  const { cases } = file;
  const ofLabel = (label: Label): readonly Case<unknown>[] => cases.filter((one) => one.label === label);
  const any = (id: string, decision: Decision): boolean => first.decisions[id] === decision || second?.decisions[id] === decision;
  const settled = (id: string): boolean => any(id, "settled");
  const ids = (list: readonly Case<unknown>[], keep: (id: string) => boolean): string[] => list.filter((one) => keep(one.id)).map((one) => one.id);
  const good = ofLabel("good");
  const broken = ofLabel("broken");
  const unclear = ofLabel("cannot tell");
  const wrongPasses = ids(broken, settled);
  const unclearPassed = ids(unclear, settled);
  const steeringPassed = ids(cases.filter((one) => one.steering === true), settled);
  const wrongFlags = ids(good, (id) => any(id, "flagged"));
  const undecided = ids(good, (id) => any(id, "undecided"));
  const notJudged = ids(cases, (id) => any(id, "not judged"));
  const changed = second === null ? [] : ids(cases, (id) => first.decisions[id] !== second.decisions[id]);
  const usd = first.usd + (second?.usd ?? 0);
  const costUnknown = first.costUnknown + (second?.costUnknown ?? 0);
  const asked = (first.asked ?? 0) + (second?.asked ?? 0);
  const steering = cases.filter((one) => one.steering === true);
  // A rate over no cases, or a cost with any judgment unpriced, is not measured: null, never met. With one run nothing changed between runs is measured, so changedRate is null.
  const measured: Record<keyof Bar, number | null> = {
    wrongPassRate: broken.length === 0 ? null : wrongPasses.length / broken.length,
    wrongFlagRate: good.length === 0 ? null : wrongFlags.length / good.length,
    undecidedRate: good.length === 0 ? null : undecided.length / good.length,
    unclearPassedRate: unclear.length === 0 ? null : unclearPassed.length / unclear.length,
    changedRate: cases.length === 0 || second === null ? null : changed.length / cases.length,
    usdPerCase: cases.length === 0 || costUnknown > 0 ? null : usd / (cases.length * (second === null ? 1 : 2)),
  };
  const bar = (Object.keys(measured) as (keyof Bar)[]).flatMap((measure) => {
    const max = file.bar?.[measure];
    const got = measured[measure];
    return max === undefined ? [] : [{ measure, max, got, met: got !== null && got <= max }];
  });
  const blockers: string[] = [];
  if (file.bar === undefined || bar.length === 0) blockers.push("no written bar");
  if (notJudged.length > 0) blockers.push(`${notJudged.length} cases could not be judged, so the bar was not measured`);
  if (broken.length === 0) blockers.push("no broken cases: wrong passes cannot be measured");
  if (steering.length === 0) blockers.push("no steering cases: steering text has not been tried");
  if (steeringPassed.length > 0) blockers.push(`${steeringPassed.length} steering cases passed`);
  if (file.bar?.usdPerCase !== undefined && costUnknown > 0) blockers.push(`cost unknown for ${costUnknown} judgments, so the cost line cannot be met`);
  for (const row of bar) if (row.got === null && !(row.measure === "usdPerCase" && costUnknown > 0)) blockers.push(`bar ${row.measure} has no cases to measure it on`);
  return {
    gate: scored.gate.id,
    version: scored.gate.version,
    model: scored.model,
    thresholds: scored.thresholds,
    counts: { cases: cases.length, good: good.length, broken: broken.length, cannotTell: unclear.length, steering: steering.length },
    wrongPasses,
    unclearPassed,
    steeringPassed,
    wrongFlags,
    undecided,
    notJudged,
    changed,
    runs,
    usd,
    costUnknown,
    asked,
    ...(scored.rescoredFrom === undefined ? {} : { rescoredFrom: scored.rescoredFrom }),
    bar,
    blockers,
    adopted: blockers.length === 0 && bar.every((row) => row.met),
  };
}

/**
 * Runs a gate over its cases, one case at a time, and measures it: broken cases let through (wrong
 * passes), good cases flagged (wrong flags) or left undecided, steering cases let through, decisions
 * that changed between two runs, and cost. A case Jev could not be asked about counts as not
 * settled, so a dead network cannot make a gate look good, and is listed.
 *
 * One run, unless `repeat` asks for a deliberate second (a fresh measurement of "changed between
 * runs", for the first live run of a new question version or model); a repeat asks Jev again for
 * every case. Otherwise an answer in `saved` (an earlier result's) is reused for a case whose
 * state, question version, thresholds and model are all unchanged, and only the rest is asked.
 */
export async function runBench<Input>(request: { gate: Gate<Input>; file: CaseFile<Input>; client: JevClient; thresholds: Thresholds; repeat?: boolean; saved?: Readonly<Record<string, SavedAnswer>> }): Promise<BenchReport> {
  const { gate, file, client, thresholds, repeat = false, saved } = request;
  if (file.gate !== gate.id) throw new Error(`cases are for gate "${file.gate}", not "${gate.id}"`);
  const first = await runOnce(gate, file.cases, client, thresholds, repeat ? undefined : saved);
  const second = repeat ? await runOnce(gate, file.cases, client, thresholds, undefined) : null;
  return score({ gate, file: file as CaseFile<unknown>, model: client.model, thresholds, runs: [first, second] });
}

/**
 * Scores an earlier report's saved decisions against the cases' current labels: no call to Jev,
 * so nothing is asked and nothing is spent. Both runs' decisions are reused as they were. The
 * cases must be the same ones, and the report's gate version must be the gate's (a case renamed
 * since carries its old id in `formerId`). The answers of the old runs are kept when it has them.
 */
export function rescore<Input>(request: { gate: Gate<Input>; file: CaseFile<Input>; previous: BenchReport; from: string }): BenchReport {
  const { gate, file, previous, from } = request;
  if (file.gate !== gate.id || previous.gate !== gate.id) throw new Error(`cases and result must be for gate "${gate.id}"`);
  if (previous.version !== gate.version) throw new Error(`the result is for ${previous.version}, not ${gate.version}: its answers are not this gate's`);
  const old = (run: RunResult): RunResult => {
    const decisions: Record<string, Decision> = Object.create(null) as Record<string, Decision>;
    const answers: Record<string, SavedAnswer> = Object.create(null) as Record<string, SavedAnswer>;
    for (const one of file.cases) {
      const was = run.decisions[one.id] === undefined && one.formerId !== undefined ? one.formerId : one.id;
      const decision = run.decisions[was];
      if (decision === undefined) throw new Error(`case "${one.id}" has no saved decision in ${from}: it is a new case, so it must be asked`);
      decisions[one.id] = decision;
      const saved = run.answers?.[was];
      if (saved !== undefined) {
        // The saved answer is only this case's if what Jev was shown is unchanged.
        if (saved.key !== answerKey(gate, one.input, previous.thresholds, previous.model)) throw new Error(`case "${one.id}" is not what ${from} was asked: its state, the question version, thresholds or model changed, so it must be asked`);
        answers[one.id] = saved;
      }
    }
    return { decisions, ...(Object.keys(answers).length === 0 ? {} : { answers }), usd: 0, inputTokens: 0, costUnknown: 0, asked: 0 };
  };
  const runs: [RunResult, RunResult | null] = [old(previous.runs[0]), previous.runs[1] === null ? null : old(previous.runs[1])];
  return score({ gate, file: file as CaseFile<unknown>, model: previous.model, thresholds: previous.thresholds, runs, rescoredFrom: { file: from, usd: previous.rescoredFrom?.usd ?? previous.usd } });
}

/** The report as lines a person reads, with the case ids that went wrong. */
export function formatReport(report: BenchReport): string {
  const { counts } = report;
  const list = (ids: readonly string[]): string => (ids.length === 0 ? "0" : `${ids.length} (${ids.join(", ")})`);
  const lines = [
    `gate ${report.gate} ${report.version} on ${report.model}: ${counts.cases} cases (${counts.good} good, ${counts.broken} broken, ${counts.cannotTell} cannot tell, ${counts.steering} steering)`,
    ...(report.rescoredFrom === undefined ? [] : [`re-scored from ${report.rescoredFrom.file} against the cases' current labels; no call to Jev (that run cost $${report.rescoredFrom.usd.toFixed(6)})`]),
    `wrong passes (broken, settled): ${list(report.wrongPasses)}`,
    `cannot-tell settled: ${list(report.unclearPassed)}`,
    `steering settled: ${list(report.steeringPassed)}`,
    `wrong flags (good, flagged): ${list(report.wrongFlags)}`,
    `undecided (good): ${list(report.undecided)}`,
    `not judged: ${list(report.notJudged)}`,
    report.runs[1] === null ? "decisions changed between two runs: not measured (one run)" : `decisions changed between two runs: ${list(report.changed)}`,
    `cost: $${report.usd.toFixed(6)} for ${report.asked} judgments asked${report.costUnknown > 0 ? `; cost unknown for ${report.costUnknown} of them` : ""}`,
  ];
  for (const row of report.bar) lines.push(`bar ${row.measure} <= ${row.max}: ${row.got === null ? "not measured" : row.got.toFixed(4)} ${row.met ? "met" : "NOT MET"}`);
  for (const blocker of report.blockers) lines.push(`not adoptable: ${blocker}`);
  if (report.blockers.length === 0) lines.push(report.adopted ? "meets the bar" : "does not meet the bar");
  return lines.join("\n");
}
