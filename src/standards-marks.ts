import type { LineRange, NodeId } from "./graph.ts";
import type { About, JudgedDocument, JudgedRecord, StandardAbout } from "./jev/judged-types.ts";
import { STANDARD_GATE_ID } from "./jev/standard-gate.ts";
import { yesOf } from "./jev/gate.ts";
import { rateText } from "./jev/rate.ts";
import type { GateRate } from "./jev/rate.ts";
import type { JudgedMark } from "./judged-marks.ts";

/**
 * What the Standards row shows, from /standards.json (the base's rules, derived) and /judged.json
 * (the standard gate's answers, judged) alone. Kept apart: a mark never changes a rule, and a rule
 * never changes a mark. No node imports: the page reads this.
 */

/** /standards.json: the written rules of the base, with no text. */
export interface StandardsDocument {
  readonly tier: "derived";
  readonly tableVersion: number;
  /** "none" means every file the table names was read and none holds a rule; "unknown" means the rules could not be read, so there may be some. */
  readonly status: "found" | "none" | "unknown";
  readonly reason?: string;
  /** Rule files that could not be read as text, so the list may be incomplete. */
  readonly unread: readonly string[];
  readonly rules: readonly { readonly path: string; readonly heading: string; readonly kind: string; readonly range: LineRange; readonly edited: boolean | null; readonly scope: string }[];
}

/** One line of the row: a rule against a hunk, with how sure the classifier is. */
export interface StandardLine {
  readonly key: string;
  readonly mark: JudgedMark;
  /** Absent for a file that could not be read as lines, so it was judged against no rule. */
  readonly rule?: StandardAbout["rule"];
  readonly hunk?: StandardAbout["hunk"];
  /** The file node the line attaches to. */
  readonly nodes: readonly NodeId[];
  /** The probability that the changed lines break the rule; null while unanswered. */
  readonly breaks: number | null;
  /** Whether the base's lines already broke the rule: "unknown" when that question has no answer, never "new". */
  readonly base: "new" | "already" | "unknown";
}

const nodesOf = (about: About): readonly NodeId[] => ("nodes" in about ? about.nodes : []);
const standardOf = (about: About): StandardAbout | undefined => ("standard" in about ? about.standard : undefined);

function ofRecord(record: JudgedRecord): StandardLine {
  const before = yesOf(record.answers, "before");
  const already = record.thresholds.already ?? 0.5;
  return {
    key: record.key,
    mark: { kind: "judged", verdict: record.verdict, record },
    ...pinned(record.about),
    nodes: nodesOf(record.about),
    breaks: yesOf(record.answers, "breaks") ?? null,
    base: before === undefined ? "unknown" : before >= already ? "already" : "new",
  };
}

const pinned = (about: About): { rule?: StandardAbout["rule"]; hunk?: StandardAbout["hunk"] } => {
  const standard = standardOf(about);
  return standard === undefined ? {} : { rule: standard.rule, hunk: standard.hunk };
};

const ORDER = (line: StandardLine): number => {
  if (line.mark.kind === "pending") return 3;
  if (line.mark.kind === "not judged") return 2;
  return { flagged: 0, undecided: 1, settled: 4 }[line.mark.verdict];
};

/**
 * The row's lines: every record of the standard gate, every check that could not be answered with
 * why, and every one still being asked. Flagged first, then undecided, not judged, judging and
 * settled; the order within each is the server's. Empty with no document or with judging off.
 */
export function standardLines(document: JudgedDocument | null): StandardLine[] {
  if (document === null || document.status === "off") return [];
  const lines: StandardLine[] = [];
  for (const set of document.sets) if (set.question.id === STANDARD_GATE_ID) lines.push(...set.records.map(ofRecord));
  for (const entry of document.notJudged) {
    if (entry.gate === STANDARD_GATE_ID) lines.push({ key: entry.key, mark: { kind: "not judged", reason: entry.reason }, ...pinned(entry.about), nodes: nodesOf(entry.about), breaks: null, base: "unknown" });
  }
  if (document.status === "pending") {
    for (const entry of document.pending) {
      if (entry.gate === STANDARD_GATE_ID) lines.push({ key: entry.key, mark: { kind: "pending" }, ...pinned(entry.about), nodes: nodesOf(entry.about), breaks: null, base: "unknown" });
    }
  }
  return lines.map((line, index) => ({ line, index })).sort((a, b) => ORDER(a.line) - ORDER(b.line) || a.index - b.index).map(({ line }) => line);
}

const plural = (count: number, one: string): string => `${count} ${count === 1 ? one : `${one}s`}`;

/**
 * The row's summary, number first, or null when there is no /standards.json to read (no comparison,
 * so no row). No written rules and rules that could not be read are said as they are; with judging
 * off or no judged document the row says "not judged". A settled mark of a gate that is not adopted
 * says so, as the Claims row does.
 */
export function standardsSummary(standards: StandardsDocument | null, document: JudgedDocument | null, lines: readonly StandardLine[], adopted: boolean): string | null {
  if (standards === null) return null;
  if (standards.status === "none") return "no written rules";
  if (standards.status === "unknown") return "rules could not be read";
  const rules = plural(standards.rules.length, "rule");
  const unread = standards.unread.length === 0 ? "" : `, ${plural(standards.unread.length, "rule file")} not read`;
  if (document === null || document.status === "off") return `${rules}, not judged${unread}`;
  const count = (keep: (line: StandardLine) => boolean): number => lines.filter(keep).length;
  const verdict = (name: string) => (line: StandardLine): boolean => line.mark.kind === "judged" && line.mark.verdict === name;
  const settled = count(verdict("settled"));
  const parts = [
    [count(verdict("flagged")), "flagged"],
    [settled, "settled"],
    [count(verdict("undecided")), "undecided"],
    [count((line) => line.mark.kind === "not judged"), "not judged"],
    [count((line) => line.mark.kind === "pending"), "judging…"],
  ].flatMap(([n, word]) => (n === 0 ? [] : [`${n} ${word}`]));
  const text = parts.length === 0 ? "no hunk to judge" : parts.join(", ");
  return `${text} · ${rules}${unread}${settled > 0 && !adopted ? " (standard gate not adopted)" : ""}`;
}

/** Everything the Standards row draws: the base's rules, the lines, the summary, and what to say about the gate's rate. */
export interface StandardsView {
  readonly standards: StandardsDocument;
  /** The judged document the lines come from; null when the page could not read one. */
  readonly document: JudgedDocument | null;
  readonly lines: readonly StandardLine[];
  readonly summary: string;
  /** True only when the standard gate's committed result meets its bar. */
  readonly adopted: boolean;
  /** The gate's measured rate as one line; undefined while none is measured. */
  readonly rate: string | undefined;
}

export function standardsView(standards: StandardsDocument | null, document: JudgedDocument | null, rates: ReadonlyMap<string, GateRate>): StandardsView | null {
  if (standards === null) return null;
  const gate = rates.get(STANDARD_GATE_ID);
  const adopted = gate?.adopted === true;
  const lines = standardLines(document);
  return { standards, document, lines, summary: standardsSummary(standards, document, lines, adopted) ?? "", adopted, rate: gate === undefined ? undefined : rateText(gate) };
}
