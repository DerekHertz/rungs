/**
 * A gate's measured rate on its labelled cases, read from the newest report in
 * `gates/<id>/results/`, and the words the page puts beside the gate's marks. No node imports:
 * the page reads this. `ReportLike` is the part of the bench's `BenchReport` this needs, so a
 * report file is read as it was committed.
 */
export interface ReportLike {
  readonly gate: string;
  readonly version: string;
  readonly model: string;
  readonly counts: { readonly cases: number; readonly good: number; readonly broken: number; readonly cannotTell: number; readonly steering: number };
  readonly wrongPasses: readonly string[];
  readonly unclearPassed: readonly string[];
  readonly steeringPassed: readonly string[];
  readonly wrongFlags: readonly string[];
  readonly undecided: readonly string[];
  readonly notJudged: readonly string[];
  readonly changed: readonly string[];
  readonly usd: number;
  readonly costUnknown: number;
  /** Judgments sent to Jev to make the report; reused or re-scored answers are not counted. */
  readonly asked?: number;
  readonly bar: readonly { readonly measure: string; readonly max: number; readonly got: number | null; readonly met: boolean }[];
  readonly blockers: readonly string[];
  readonly adopted: boolean;
}

/** What /gate-rates.json serves for one gate. */
export interface GateRate {
  readonly gate: string;
  readonly version: string;
  readonly model: string;
  /** The results file's name without its extension, "2026-11-11-jev-1.14.0": the date and the model. */
  readonly run: string;
  readonly counts: ReportLike["counts"];
  readonly wrongPasses: number;
  readonly unclearPassed: number;
  readonly steeringPassed: number;
  readonly wrongFlags: number;
  readonly undecided: number;
  readonly notJudged: number;
  readonly changed: number;
  /** Dollars per judgment; null when any cost is unknown. */
  readonly usdPerCase: number | null;
  readonly bar: ReportLike["bar"];
  readonly blockers: readonly string[];
  readonly adopted: boolean;
}

export interface GateRatesDocument {
  readonly tier: "measured";
  readonly gates: Readonly<Record<string, GateRate>>;
}

/** The rate of one report; `run` names its results file. */
export function rateOf(report: ReportLike, run: string): GateRate {
  // Judgments actually asked; a report written before this was counted ran every case twice.
  const judgments = report.asked ?? report.counts.cases * 2;
  return {
    gate: report.gate,
    version: report.version,
    model: report.model,
    run,
    counts: report.counts,
    wrongPasses: report.wrongPasses.length,
    unclearPassed: report.unclearPassed.length,
    steeringPassed: report.steeringPassed.length,
    wrongFlags: report.wrongFlags.length,
    undecided: report.undecided.length,
    notJudged: report.notJudged.length,
    changed: report.changed.length,
    usdPerCase: report.costUnknown > 0 ? null : judgments === 0 ? 0 : report.usd / judgments,
    bar: report.bar,
    blockers: report.blockers,
    adopted: report.adopted,
  };
}

const plural = (count: number, one: string, many: string = `${one}s`): string => `${count} ${count === 1 ? one : many}`;
const pct = (part: number, whole: number): string => (whole === 0 ? "n/a" : `${Math.round((part / whole) * 100)}%`);

/** The gate named as a person says it. */
const NAMES: Readonly<Record<string, string>> = { claim: "Claim gate", standard: "Standard gate" };
export const gateName = (gate: string): string => NAMES[gate] ?? `Gate ${gate}`;

/** What a settled mark of each gate would be evidence of, in the words of the line that says it is not. */
const HOLDS: Readonly<Record<string, string>> = { claim: "the claim holds", standard: "the change keeps the rule" };
const holds = (gate: string): string => HOLDS[gate] ?? "the change is sound";

/**
 * One honest line for the page. Adopted: the rate and the bar it met. Not adopted: the rate, which
 * limits it missed, and that the gate stays off, so a settled mark is not evidence.
 */
export function rateText(rate: GateRate): string {
  const wrong = `${plural(rate.wrongPasses, "wrong pass", "wrong passes")} of ${plural(rate.counts.broken, "broken case")} (${pct(rate.wrongPasses, rate.counts.broken)})`;
  const limit = rate.bar.find((row) => row.measure === "wrongPassRate");
  const head = `${gateName(rate.gate)}: ${wrong}${limit === undefined ? "" : `, bar at most ${Math.round(limit.max * 100)}%`}`;
  if (rate.adopted) return `${head}: adopted. Measured on ${rate.counts.cases} labelled cases (${rate.run}).`;
  const missed = rate.bar.filter((row) => !row.met && row.measure !== "wrongPassRate").map((row) => barWord(rate.gate, row.measure));
  if (rate.wrongPasses > 0 && limit !== undefined && !limit.met) missed.unshift("wrong passes");
  if (rate.steeringPassed > 0) missed.push(`${plural(rate.steeringPassed, "steering case")} settled`);
  const why = [...missed, ...rate.blockers.filter((blocker) => !blocker.includes("steering cases passed"))];
  return `${head}: not adopted${why.length === 0 ? "" : ` (${why.join("; ")})`}. The gate stays off: its marks are shown for inspection, and a settled mark is not evidence that ${holds(rate.gate)}. Measured on ${rate.counts.cases} labelled cases (${rate.run}).`;
}

/** A bar line in words; the claim gate's cases are claims, the standard gate's are hunks. */
const barWord = (gate: string, measure: string): string => (BAR_WORDS[measure] ?? measure).replace("good claims", gate === "claim" ? "good claims" : "good cases");

const BAR_WORDS: Readonly<Record<string, string>> = {
  wrongPassRate: "wrong passes",
  unclearPassedRate: "cannot-tell cases settled",
  undecidedRate: "good claims undecided",
  wrongFlagRate: "good claims flagged",
  changedRate: "decisions changed between runs",
  usdPerCase: "cost",
};

/** What a gate with no committed result says. */
export const NOT_MEASURED = "Rate of wrong passes: not measured yet. The gate is not adopted, so a settled mark is not evidence that the claim holds.";

/** The same for any gate: the claim gate's words are NOT_MEASURED. */
export const notMeasured = (gate: string): string => `Rate of wrong passes: not measured yet. The gate is not adopted, so a settled mark is not evidence that ${holds(gate)}.`;

/** The rates a document carries, by gate id; empty when the document is missing or not one. */
export function ratesOf(document: unknown): ReadonlyMap<string, GateRate> {
  const gates = typeof document === "object" && document !== null ? (document as { gates?: unknown }).gates : undefined;
  if (typeof gates !== "object" || gates === null) return new Map();
  return new Map(Object.entries(gates as Record<string, GateRate>));
}
