import type { JevAnswer, JevRequest } from "./jev/client.ts";
import type { Thresholds, Verdict } from "./jev/gate.ts";
import { MAX_CANDIDATES, NARROWING_VERSION } from "./jev/membership-source.ts";
import type { JudgeOutcome, Narrowed, Unit, UnitLevel } from "./jev/membership-source.ts";
import { MEMBERSHIP_GATE_ID, MEMBERSHIP_THRESHOLDS, answersCover, membershipGate } from "./jev/membership-gate.ts";
import type { Term } from "./vocabulary.ts";

/*
 * Memberships: which function, class or constant belongs to which term, as Jev judged it. They are
 * judged facts (SPEC rule 2): kept apart from the graph and from the vocabulary's own derived words,
 * stored beside the vocabulary in the setup file, and never able to create or change a node or a
 * term. A record says what Jev was shown and what it answered; a mapping is "stale" once its
 * function's digest changes, and is then never counted until it is judged again.
 */

/** One answer about one (function, term) pair. */
export interface MembershipRecord {
  readonly tier: "judged";
  /** The unit's key (see Unit.key). */
  readonly unit: string;
  /** The term's key. */
  readonly term: string;
  /** The function's digest when it was judged: a mapping is stale when this no longer matches. */
  readonly digest: string;
  readonly question: { readonly id: string; readonly version: string };
  /** The exact request Jev was sent. */
  readonly shown: JevRequest;
  readonly answers: Readonly<Record<string, JevAnswer>>;
  readonly thresholds: Thresholds;
  readonly verdict: Verdict;
  readonly model: string;
  /** Null when the service did not report a valid count: unknown, never zero. */
  readonly inputTokens: number | null;
  readonly usd: number | null;
  /** Set when the answer is no longer to be trusted: why. Absent for a current answer. */
  readonly stale?: string;
}

/** One unit looked at, and which terms were picked for it. */
export interface StoredUnit {
  readonly key: string;
  readonly path: string;
  readonly name: string;
  readonly level: UnitLevel;
  readonly digest: string;
  /** The term keys picked by the narrowing rule and asked, strongest first. None means no term shares a word with it. */
  readonly candidates: readonly string[];
  /** The term keys the rule picked and the per-unit cap left out: not asked. */
  readonly cut: readonly string[];
}

export interface StoredMemberships {
  readonly tier: "judged";
  readonly gate: { readonly id: string; readonly version: string };
  /** The model that answered the newest run. */
  readonly model: string;
  readonly narrowing: { readonly version: number; readonly maxCandidates: number };
  readonly thresholds: Thresholds;
  /** Sorted by key. */
  readonly units: readonly StoredUnit[];
  /** Sorted by unit key, then term key. */
  readonly records: readonly MembershipRecord[];
}

/** What one judging run did, for the report. Not stored. */
export interface JudgingNote {
  readonly status: "judged";
  readonly asked: number;
  readonly reused: number;
  readonly notJudged: number;
  /** The first reason a call could not be judged, when any. */
  readonly firstFailure?: string;
  readonly overLimit: number;
  readonly maxPairs: number;
  readonly usd: number;
  readonly costUnknown: number;
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/* ---- reading ---- */

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): boolean => typeof value === "number" && Number.isInteger(value) && value >= 0;
const isText = (value: unknown): boolean => typeof value === "string";
const isList = (value: unknown, each: (one: unknown) => boolean): boolean => Array.isArray(value) && value.every(each);
const hasFields = (value: unknown, fields: Readonly<Record<string, (field: unknown) => boolean>>): boolean => isRecord(value) && Object.entries(fields).every(([name, holds]) => holds(value[name]));
const isNumberMap = (value: unknown): boolean => isRecord(value) && Object.values(value).every((one) => typeof one === "number");
const LEVELS: readonly string[] = ["function", "class", "constant"];
const VERDICTS: readonly string[] = ["settled", "flagged", "undecided"];

function isAnswer(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === "yes-no") return typeof value.yes === "number";
  if (value.type === "unreadable") return isText(value.why) && isText(value.raw);
  return value.type === "choice" && isNumberMap(value.probabilities) && isText(value.choice);
}

/**
 * Whether a record's answers are whole and its verdict follows from them. Every question it was
 * asked has a readable probability (a record that lacks one is not a judged fact, it is damage), and
 * for the current version of the question the verdict is what the answers and the record's own
 * thresholds give. A record of another version is checked for its answers only: it is stale, not damaged.
 */
function isConsistent(record: unknown): boolean {
  if (!isRecord(record) || !isRecord(record.shown) || !isRecord(record.shown.questions) || !isRecord(record.answers) || !isRecord(record.question) || !isNumberMap(record.thresholds)) return true;
  const names = Object.keys(record.shown.questions);
  if (names.length === 0 || !answersCover(record.answers as Record<string, JevAnswer>, names)) return false;
  if (record.question.id !== membershipGate.id || record.question.version !== membershipGate.version) return true;
  return membershipGate.decide(record.answers as Record<string, JevAnswer>, record.thresholds as Thresholds) === record.verdict;
}

/** The name of the first thing wrong with stored memberships, or undefined when they are whole. Every field the report and the later steps read is checked. */
export function problemWithMemberships(value: unknown): string | undefined {
  const top: [string, boolean][] = [
    ["tier", isRecord(value) && value.tier === "judged"],
    ["gate", isRecord(value) && hasFields(value.gate, { id: isText, version: isText })],
    ["model", isRecord(value) && isText(value.model)],
    ["narrowing", isRecord(value) && hasFields(value.narrowing, { version: isCount, maxCandidates: isCount })],
    ["thresholds", isRecord(value) && isNumberMap(value.thresholds)],
    ["units", isRecord(value) && isList(value.units, (one) => hasFields(one, { key: isText, path: isText, name: isText, level: (level) => typeof level === "string" && LEVELS.includes(level), digest: isText, candidates: (list) => isList(list, isText), cut: (list) => isList(list, isText) }))],
    [
      "records",
      isRecord(value) &&
        isList(value.records, (one) =>
          isConsistent(one) &&
          hasFields(one, {
            tier: (tier) => tier === "judged",
            unit: isText,
            term: isText,
            digest: isText,
            question: (question) => hasFields(question, { id: isText, version: isText }),
            shown: (shown) => hasFields(shown, { state: isRecord, questions: isRecord }),
            answers: (answers) => isRecord(answers) && Object.values(answers).every(isAnswer),
            thresholds: isNumberMap,
            verdict: (verdict) => typeof verdict === "string" && VERDICTS.includes(verdict),
            model: isText,
            inputTokens: (tokens) => tokens === null || isCount(tokens),
            usd: (usd) => usd === null || typeof usd === "number",
            stale: (stale) => stale === undefined || isText(stale),
          }),
        ),
    ],
  ];
  return top.find(([, ok]) => !ok)?.[0];
}

/* ---- what a pair, a unit and a term are ---- */

export type PairStatus = "member" | "not a member" | "middle band" | "stale" | "not judged";

/** A record's status. A stale answer is never a member, a no or a middle band: it is stale. No record is "not judged", never a no. */
export function pairStatus(record: MembershipRecord | undefined): PairStatus {
  // A record that lacks a readable answer is unknown, never a middle band (validation refuses to store one; this is the guard behind it).
  if (record === undefined || !answersCover(record.answers, Object.keys(record.shown.questions))) return "not judged";
  if (record.stale !== undefined) return "stale";
  return record.verdict === "settled" ? "member" : record.verdict === "flagged" ? "not a member" : "middle band";
}

const recordsByPair = (memberships: StoredMemberships): Map<string, MembershipRecord> => new Map(memberships.records.map((record) => [`${record.unit}\0${record.term}`, record]));

export interface PairCounts {
  readonly member: number;
  readonly notMember: number;
  readonly middle: number;
  readonly stale: number;
  readonly notJudged: number;
  /** Picked by the rule and left out by the per-unit cap. */
  readonly cut: number;
}

export type UnitStatus = "with a term" | "no candidate term" | "not a member of any candidate" | "middle band only" | "not known";

export interface TermSummary {
  readonly key: string;
  readonly name: string;
  readonly members: number;
  /** "has members", "no members" (every pair picked for it was judged, and none belongs) or "not known" (a pair is not judged, stale or cut). Never "no members" on an unknown. */
  readonly kind: "has members" | "no members" | "not known";
  readonly why: string;
  /** A term the repository's docs wrote: it has a heading or a package description among its places. */
  readonly docs: boolean;
}

export interface MembershipSummary {
  readonly units: number;
  readonly files: number;
  readonly byUnit: Readonly<Record<UnitStatus, number>>;
  readonly pairs: PairCounts;
  readonly terms: readonly TermSummary[];
  /** Files with at least one unit that has a current member. */
  readonly mappedFiles: number;
}

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

/** Counts what the stored memberships say, from the units, the records and the vocabulary's terms. */
export function summarize(memberships: StoredMemberships, terms: readonly Pick<Term, "key" | "name" | "pins">[]): MembershipSummary {
  const byPair = recordsByPair(memberships);
  const byUnit: Record<UnitStatus, number> = { "with a term": 0, "no candidate term": 0, "not a member of any candidate": 0, "middle band only": 0, "not known": 0 };
  const counts = { member: 0, notMember: 0, middle: 0, stale: 0, notJudged: 0, cut: 0 };
  const perTerm = new Map<string, { member: number; notMember: number; middle: number; stale: number; notJudged: number; cut: number; candidates: number }>();
  const slot = (key: string): { member: number; notMember: number; middle: number; stale: number; notJudged: number; cut: number; candidates: number } => {
    let one = perTerm.get(key);
    if (one === undefined) perTerm.set(key, (one = { member: 0, notMember: 0, middle: 0, stale: 0, notJudged: 0, cut: 0, candidates: 0 }));
    return one;
  };
  const mapped = new Set<string>();
  const files = new Set<string>();
  for (const unit of memberships.units) {
    files.add(unit.path);
    const seen = { member: 0, notMember: 0, middle: 0, stale: 0, notJudged: 0 };
    for (const key of unit.candidates) {
      const status = pairStatus(byPair.get(`${unit.key}\0${key}`));
      const one = slot(key);
      one.candidates += 1;
      const field = status === "member" ? "member" : status === "not a member" ? "notMember" : status === "middle band" ? "middle" : status === "stale" ? "stale" : "notJudged";
      one[field] += 1;
      seen[field] += 1;
      counts[field] += 1;
    }
    for (const key of unit.cut) {
      slot(key).cut += 1;
      counts.cut += 1;
    }
    if (seen.member > 0) {
      byUnit["with a term"] += 1;
      mapped.add(unit.path);
    } else if (seen.stale + seen.notJudged > 0) byUnit["not known"] += 1;
    else if (unit.candidates.length === 0) byUnit[unit.cut.length > 0 ? "not known" : "no candidate term"] += 1;
    else if (seen.middle > 0) byUnit["middle band only"] += 1;
    else byUnit["not a member of any candidate"] += 1;
  }
  const termList: TermSummary[] = terms.map((term) => {
    const one = perTerm.get(term.key) ?? { member: 0, notMember: 0, middle: 0, stale: 0, notJudged: 0, cut: 0, candidates: 0 };
    const docs = term.pins.some((pin) => pin.source === "heading" || pin.source === "package description");
    const base = { key: term.key, name: term.name, members: one.member, docs };
    if (one.member > 0) return { ...base, kind: "has members", why: `${plural(one.member, "member")}` };
    const unknown = [one.notJudged > 0 ? `${plural(one.notJudged, "pair")} not judged` : "", one.stale > 0 ? `${one.stale} stale` : "", one.cut > 0 ? `${plural(one.cut, "candidate")} left out by the cap of ${MAX_CANDIDATES} per function` : ""].filter((part) => part !== "");
    if (unknown.length > 0) return { ...base, kind: "not known", why: unknown.join(", ") };
    if (one.candidates === 0) return { ...base, kind: "no members", why: "no code shares a word with it" };
    if (one.middle > 0) return { ...base, kind: "no members", why: `${plural(one.middle, "candidate")} in the middle band, left unmapped${one.notMember > 0 ? `, ${one.notMember} judged not a member` : ""}` };
    return { ...base, kind: "no members", why: `all ${plural(one.candidates, "candidate")} judged not a member` };
  });
  return { units: memberships.units.length, files: files.size, byUnit, pairs: counts, terms: termList, mappedFiles: mapped.size };
}

/* ---- coverage ---- */

/** What `streets setup` stores and prints as coverage. */
export interface Coverage {
  /** Analysed files that are not generated. */
  readonly of: number;
  /** Files that have a function, class or constant with a current member term. At least this many when `measured` is false. */
  readonly mapped: number;
  /**
   * True only when every pair the narrowing rule picked has a current answer: none not judged and
   * none stale. False when nothing has been judged, or any pair is unknown; `mapped` is then a lower bound.
   */
  readonly measured: boolean;
  /** Pairs picked and not judged. Present once memberships exist. */
  readonly unjudged?: number;
  /** Mappings gone stale because their function changed (or the question did). Present once memberships exist. */
  readonly stale?: number;
  /** Why coverage is not measured when it is nothing to do with a pair's answer: there is nothing to measure it over. */
  readonly reason?: string;
}

export function coverageOf(of: number, memberships: StoredMemberships | undefined): Coverage {
  if (memberships === undefined) return { of, mapped: 0, measured: false };
  const { pairs, mappedFiles } = summarize(memberships, []);
  const picked = pairs.member + pairs.notMember + pairs.middle + pairs.stale + pairs.notJudged;
  // Over no files, or when no pair was picked, nothing was measured: a share of nothing is not a coverage.
  const reason = of === 0 ? "no analysed files" : picked === 0 ? "no pair was picked: no term shares a word with any function, class or constant" : undefined;
  return { of, mapped: mappedFiles, measured: reason === undefined && pairs.notJudged === 0 && pairs.stale === 0, unjudged: pairs.notJudged, stale: pairs.stale, ...(reason === undefined ? {} : { reason }) };
}

/* ---- building and keeping ---- */

const storedUnit = (unit: Unit, narrowed: Narrowed): StoredUnit => ({
  key: unit.key,
  path: unit.storedPath,
  name: unit.storedName,
  level: unit.level,
  digest: unit.digest,
  candidates: narrowed.units.get(unit.key)?.candidates ?? [],
  cut: narrowed.units.get(unit.key)?.cut ?? [],
});

const sortRecords = (records: readonly MembershipRecord[]): MembershipRecord[] => [...records].sort((a, b) => byText(a.unit, b.unit) || byText(a.term, b.term));

function assemble(units: readonly Unit[], narrowed: Narrowed, records: readonly MembershipRecord[], model: string, thresholds: Thresholds): StoredMemberships {
  return {
    tier: "judged",
    gate: { id: MEMBERSHIP_GATE_ID, version: membershipGate.version },
    model,
    narrowing: { version: NARROWING_VERSION, maxCandidates: MAX_CANDIDATES },
    thresholds,
    units: units.map((unit) => storedUnit(unit, narrowed)).sort((a, b) => byText(a.key, b.key)),
    records: sortRecords(records),
  };
}

/** The memberships after a judging run: the units and their picked terms as they are now, with the run's records. */
export function memberships(units: readonly Unit[], narrowed: Narrowed, outcome: JudgeOutcome, model: string, thresholds: Thresholds = MEMBERSHIP_THRESHOLDS): StoredMemberships {
  const picked = new Set<string>();
  for (const [unit, one] of narrowed.units) for (const term of one.candidates) picked.add(`${unit}\0${term}`);
  // A record kept stale for a pair the rule still picks stays; a pair the rule no longer picks has no record.
  return assemble(units, narrowed, outcome.records.filter((record) => picked.has(`${record.unit}\0${record.term}`)), model, thresholds);
}

/**
 * Stored memberships brought up to date with a graph and a vocabulary without asking Jev. A record
 * of a function that was removed, or of a term that is gone, is dropped. A record whose function's
 * digest changed, or whose question or thresholds are not the current ones, is kept and marked stale.
 */
export function reconcile(previous: StoredMemberships, units: readonly Unit[], narrowed: Narrowed, terms: readonly Pick<Term, "key">[]): StoredMemberships {
  const current = new Map(units.map((unit) => [unit.key, unit]));
  const termKeys = new Set(terms.map((term) => term.key));
  const records: MembershipRecord[] = [];
  for (const record of previous.records) {
    const unit = current.get(record.unit);
    if (unit === undefined || !termKeys.has(record.term)) continue;
    const why =
      record.digest !== unit.digest
        ? "the function changed"
        : record.question.version !== membershipGate.version
          ? "the question changed"
          : JSON.stringify(record.thresholds) !== JSON.stringify(MEMBERSHIP_THRESHOLDS)
            ? "the thresholds changed"
            : record.stale?.startsWith("not judged again")
              ? record.stale
              : undefined;
    const { stale, ...rest } = record;
    void stale;
    records.push(why === undefined ? rest : { ...rest, stale: why });
  }
  return assemble(units, narrowed, records, previous.model, previous.thresholds);
}

/* ---- saying it ---- */

const money = (usd: number): string => `$${usd.toFixed(6)}`;

/** The report's lines about memberships. `note` is this run's judging, when it judged. */
export function membershipLines(stored: StoredMemberships | undefined, coverage: Coverage, terms: readonly Pick<Term, "key" | "name" | "pins">[], note: JudgingNote | undefined, notRead: number): string[] {
  const lines: string[] = [];
  const unitWord = "functions, classes and constants";
  if (stored === undefined) {
    lines.push(`  coverage: ${coverage.mapped} of ${plural(coverage.of, "analysed file")} map to a term: not measured, nothing has been judged yet (run \`streets setup --judge\` to map code to terms)`);
    return lines;
  }
  const summary = summarize(stored, terms);
  const caveat = notRead > 0 ? `; ${plural(notRead, "file")} not analysed or not fully read ${notRead === 1 ? "is" : "are"} not counted` : "";
  if (coverage.reason !== undefined) {
    lines.push(`  coverage: not measured: ${coverage.reason} (${coverage.mapped} of ${plural(coverage.of, "analysed file")} map to a term${caveat})`);
  } else if (coverage.measured) {
    const cut = summary.pairs.cut;
    lines.push(`  coverage: ${coverage.mapped} of ${plural(coverage.of, "analysed file")} map to a term (measured: every pair the narrowing rule picked has a current answer${cut > 0 ? `; ${plural(cut, "pair")} left out by the cap of ${MAX_CANDIDATES} per function` : ""}${caveat})`);
  } else {
    const parts = [coverage.unjudged !== undefined && coverage.unjudged > 0 ? `${plural(coverage.unjudged, "pair")} not judged` : "", coverage.stale !== undefined && coverage.stale > 0 ? `${coverage.stale} stale` : ""].filter((part) => part !== "");
    lines.push(`  coverage: at least ${coverage.mapped} of ${plural(coverage.of, "analysed file")} map to a term: not fully measured (${parts.join(", ")}${caveat})`);
  }
  const { byUnit, pairs } = summary;
  lines.push(`  memberships: ${summary.units} ${unitWord} in ${plural(summary.files, "file")}`);
  lines.push(`    with a term: ${byUnit["with a term"]}`);
  const noTerm = byUnit["no candidate term"] + byUnit["not a member of any candidate"] + byUnit["middle band only"];
  const why = [
    byUnit["no candidate term"] > 0 ? `${byUnit["no candidate term"]} with no candidate term, no term shares a word with it` : "",
    byUnit["not a member of any candidate"] > 0 ? `${byUnit["not a member of any candidate"]} judged not a member of any candidate` : "",
    byUnit["middle band only"] > 0 ? `${byUnit["middle band only"]} in the middle band, left unmapped` : "",
  ].filter((part) => part !== "");
  lines.push(`    with no term: ${noTerm}${why.length === 0 ? "" : ` (${why.join("; ")})`}`);
  lines.push(`    not known: ${byUnit["not known"]}${byUnit["not known"] > 0 ? " (a pair is not judged, stale or left out by the cap)" : ""}`);
  lines.push(`    pairs: ${pairs.member} members, ${pairs.notMember} not members, ${pairs.middle} in the middle band, ${pairs.stale} stale, ${pairs.notJudged} not judged`);
  if (note !== undefined) {
    const cost = note.costUnknown > 0 ? `cost unknown for ${plural(note.costUnknown, "call")}${note.usd > 0 ? `, ${money(note.usd)} for the rest` : ""}` : `cost ${money(note.usd)}`;
    lines.push(`    this run: ${note.asked} asked of Jev, ${note.reused} reused, ${note.notJudged} not judged${note.firstFailure === undefined ? "" : ` (${note.firstFailure})`}, ${note.overLimit} not asked: over the limit of ${note.maxPairs} pairs; ${cost}`);
  }
  const shown = summary.terms.filter((term) => term.docs && term.kind !== "has members");
  const MAX_TERMS_SHOWN = 10;
  for (const term of shown.slice(0, MAX_TERMS_SHOWN)) lines.push(`    ${term.kind === "no members" ? "term with no members" : "term not known to have members"}: ${term.name} (${term.why})`);
  if (shown.length > MAX_TERMS_SHOWN) lines.push(`    and ${shown.length - MAX_TERMS_SHOWN} more terms from the docs without members`);
  const others = summary.terms.filter((term) => !term.docs && term.kind === "no members").length;
  if (others > 0) lines.push(`    ${plural(others, "other term")} named only by code, folders or tests ${others === 1 ? "has" : "have"} no members`);
  return lines;
}
