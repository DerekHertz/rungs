import { HARM_CATALOGUE_VERSION, harmKind } from "./harm-catalogue.ts";
import { requestFor } from "./jev/gate.ts";
import type { JevAnswer, JevRequest } from "./jev/client.ts";
import type { Thresholds, Verdict } from "./jev/gate.ts";
import type { FileTree } from "./graph.ts";
import { answersCover } from "./jev/membership-gate.ts";
import { termDigest } from "./jev/membership-source.ts";
import { STAKES_THRESHOLDS, stakesGate } from "./jev/stakes-gate.ts";
import { isComplete, membersDigest, stakePairKey } from "./jev/stakes-source.ts";
import type { JudgeStakesOutcome, TermMembers } from "./jev/stakes-source.ts";
import { hasFields, isAnswer, isCount, isList, isNumberMap, isRecord, isText } from "./memberships.ts";
import type { Term } from "./vocabulary.ts";

/*
 * Stakes: for each term and each kind of harm, whether a mistake in the term's code could cause it,
 * as Jev judged it. They are judged facts (SPEC rule 2): kept apart from the graph, the vocabulary
 * and the memberships, stored beside them in the setup file, and never able to create or change a
 * term or a mapping. A record says what Jev was shown and what it answered. A stake is "stale" once
 * the term's members change (a member's declaration, or which functions are members), once the
 * term's own text changes, or once the catalogue's version, the question or the thresholds change,
 * and is then never counted until it is judged again. A term with no mapped member has no stake:
 * unknown, never none. A kind that missed the gate's bench bar is not asked: it is "not judged".
 */

/** One answer from Jev about one (term, kind) pair. */
export interface StakeRecord {
  readonly tier: "judged";
  /** The term's key. */
  readonly term: string;
  /** The catalogue's id of the kind of harm. */
  readonly kind: string;
  /** The catalogue's version when it was judged: a stake is stale when the catalogue's version changes. */
  readonly catalogueVersion: number;
  /** A digest of the term's mapped members when it was judged (see membersDigest). */
  readonly membersDigest: string;
  /** A digest of the term's text the classifier was shown. */
  readonly termDigest: string;
  /** How many members the term had, and how many of them were shown. */
  readonly members: number;
  readonly shownMembers: number;
  /**
   * Whether the answer covers all of the term's code: every mapped member was shown and no pair of the
   * term was unknown. A no (settled) over less than that is a no over some members, never none.
   */
  readonly complete: boolean;
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

/** An answer code gave exactly, for a kind the catalogue marks as answered by code. Jev was never asked. */
export interface DerivedStake {
  readonly tier: "derived";
  readonly term: string;
  readonly kind: string;
  readonly catalogueVersion: number;
  readonly membersDigest: string;
  readonly members: number;
  /** Whether every pair of the term was known: a no over some members is not none. */
  readonly complete: boolean;
  readonly answer: "yes" | "no";
  /** The derived facts that gave the answer. */
  readonly facts: readonly string[];
  readonly stale?: string;
}

/** One term as the stakes run saw it. Every term of the vocabulary has one. */
export interface StoredStakeTerm {
  readonly key: string;
  /** Mapped members when it was judged. Zero: its stakes are unknown, never none. */
  readonly members: number;
  /** Pairs of the term whose mapping was not known (stale, not judged, or left out by the cap): its members may be incomplete. */
  readonly unknown: number;
  readonly membersDigest: string;
  /** The kinds asked about this term, and the kinds picked and left out by the cap of pairs per run. */
  readonly asked: readonly string[];
  readonly cut: readonly string[];
}

export interface StoredStakes {
  readonly tier: "judged";
  readonly gate: { readonly id: string; readonly version: string };
  /** The model that answered the newest run. */
  readonly model: string;
  readonly catalogueVersion: number;
  readonly thresholds: Thresholds;
  readonly limit: { readonly maxPairs: number };
  readonly kinds: {
    /** The kinds this run asked about, in catalogue order. */
    readonly asked: readonly string[];
    /** The kinds it did not, with why: they are "not judged", whatever the term. */
    readonly notJudged: readonly { readonly id: string; readonly reason: string }[];
  };
  /** Sorted by key. */
  readonly terms: readonly StoredStakeTerm[];
  /** Sorted by term key, then kind. */
  readonly records: readonly StakeRecord[];
  readonly derived: readonly DerivedStake[];
}

/** What one stakes run did, for the report. Not stored. */
export interface StakesNote {
  readonly asked: number;
  readonly reused: number;
  readonly notJudged: number;
  readonly firstFailure?: string;
  readonly overLimit: number;
  readonly maxPairs: number;
  readonly usd: number;
  readonly costUnknown: number;
}

/** The kinds a run may ask about and the kinds it may not (a kind that missed the bench bar), with why. */
export interface KindChoice {
  readonly asked: readonly string[];
  readonly notJudged: readonly { readonly id: string; readonly reason: string }[];
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/* ---- reading ---- */

const VERDICTS: readonly string[] = ["settled", "flagged", "undecided"];

/**
 * Whether a record's answers are whole and its verdict follows from them. Every question it was
 * asked has a readable probability (a record that lacks one is damage, not a judged fact), and for
 * the current version of the question the verdict is what the answers and the record's own
 * thresholds give. A record of another version is checked for its answers only: it is stale, not damaged.
 */
function isConsistent(record: unknown): boolean {
  if (!isRecord(record) || !isRecord(record.shown) || !isRecord(record.shown.questions) || !isRecord(record.answers) || !isRecord(record.question) || !isNumberMap(record.thresholds)) return true;
  const names = Object.keys(record.shown.questions);
  if (names.length === 0 || !answersCover(record.answers as Record<string, JevAnswer>, names)) return false;
  // Another gate's question is damage, not an old version: a stake is only ever the stakes gate's answer.
  if (record.question.id !== stakesGate.id) return false;
  if (record.question.version !== stakesGate.version) return true;
  // For the current question and catalogue, what Jev was shown is the question of the record's own kind.
  if (record.catalogueVersion === HARM_CATALOGUE_VERSION) {
    if (typeof record.kind !== "string" || harmKind(record.kind) === undefined) return false;
    if (JSON.stringify(record.shown.questions) !== JSON.stringify(requestFor(stakesGate, { kind: record.kind, term: { name: "", pins: [], omittedPins: 0 }, members: [], omittedMembers: 0 }).questions)) return false;
  }
  return stakesGate.decide(record.answers as Record<string, JevAnswer>, record.thresholds as Thresholds) === record.verdict;
}

/** The name of the first thing wrong with stored stakes, or undefined when they are whole. Every field the report and the later steps read is checked. */
export function problemWithStakes(value: unknown): string | undefined {
  const text = isText;
  const top: [string, boolean][] = [
    ["tier", isRecord(value) && value.tier === "judged"],
    ["gate", isRecord(value) && hasFields(value.gate, { id: text, version: text })],
    ["model", isRecord(value) && text(value.model)],
    ["catalogueVersion", isRecord(value) && isCount(value.catalogueVersion)],
    ["thresholds", isRecord(value) && isNumberMap(value.thresholds)],
    ["limit", isRecord(value) && hasFields(value.limit, { maxPairs: isCount })],
    ["kinds", isRecord(value) && hasFields(value.kinds, { asked: (list) => isList(list, text), notJudged: (list) => isList(list, (one) => hasFields(one, { id: text, reason: text })) })],
    ["terms", isRecord(value) && isList(value.terms, (one) => hasFields(one, { key: text, members: isCount, unknown: isCount, membersDigest: text, asked: (list) => isList(list, text), cut: (list) => isList(list, text) }))],
    [
      "records",
      isRecord(value) &&
        isList(value.records, (one) =>
          isConsistent(one) &&
          hasFields(one, {
            tier: (tier) => tier === "judged",
            term: text,
            kind: text,
            catalogueVersion: isCount,
            membersDigest: text,
            termDigest: text,
            members: isCount,
            shownMembers: isCount,
            complete: (complete) => typeof complete === "boolean",
            question: (question) => hasFields(question, { id: text, version: text }),
            shown: (shown) => hasFields(shown, { state: isRecord, questions: isRecord }),
            answers: (answers) => isRecord(answers) && Object.values(answers).every(isAnswer),
            thresholds: isNumberMap,
            verdict: (verdict) => typeof verdict === "string" && VERDICTS.includes(verdict),
            model: text,
            inputTokens: (tokens) => tokens === null || isCount(tokens),
            usd: (usd) => usd === null || typeof usd === "number",
            stale: (stale) => stale === undefined || text(stale),
          }),
        ),
    ],
    [
      "derived",
      isRecord(value) &&
        isList(value.derived, (one) =>
          hasFields(one, {
            tier: (tier) => tier === "derived",
            term: text,
            kind: text,
            catalogueVersion: isCount,
            membersDigest: text,
            members: isCount,
            complete: (complete) => typeof complete === "boolean",
            answer: (answer) => answer === "yes" || answer === "no",
            facts: (list) => isList(list, text),
            stale: (stale) => stale === undefined || text(stale),
          }),
        ),
    ],
  ];
  return top.find(([, ok]) => !ok)?.[0];
}

/* ---- what a pair, a term and a kind are ---- */

export type StakeStatus = "could cause" | "judged no" | "judged no over some members" | "unclear" | "stale" | "not judged";

/**
 * A record's status. A stale answer is never a yes, a no or unclear: it is stale. No record is
 * "not judged", never a no. An unclear answer (the middle band) is not read as none.
 */
export function stakeStatus(record: StakeRecord | DerivedStake | undefined): StakeStatus {
  if (record === undefined) return "not judged";
  if (record.tier === "derived") return record.stale !== undefined ? "stale" : record.answer === "yes" ? "could cause" : record.complete ? "judged no" : "judged no over some members";
  // A record that lacks a readable answer is unknown, never unclear (validation refuses to store one; this is the guard behind it).
  if (!answersCover(record.answers, Object.keys(record.shown.questions))) return "not judged";
  if (record.stale !== undefined) return "stale";
  // A yes over some members stays a yes; a no over some members is not none: for what reads it, unknown.
  return record.verdict === "flagged" ? "could cause" : record.verdict === "settled" ? (record.complete ? "judged no" : "judged no over some members") : "unclear";
}

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

interface KindCounts {
  couldCause: number;
  judgedNo: number;
  judgedNoSome: number;
  unclear: number;
  stale: number;
  notJudged: number;
  cut: number;
}
const noCounts = (): KindCounts => ({ couldCause: 0, judgedNo: 0, judgedNoSome: 0, unclear: 0, stale: 0, notJudged: 0, cut: 0 });

export interface StakesSummary {
  readonly terms: number;
  /** Terms with a mapped member: the only ones that have stakes. */
  readonly withMembers: number;
  /** Terms with no mapped member: stakes unknown, never none. */
  readonly noMembers: number;
  /** Terms with a member whose mapping is not fully known: their stakes cover the members known. */
  readonly incomplete: number;
  readonly pairs: Readonly<KindCounts>;
  /** By kind id, the kinds asked. */
  readonly byKind: ReadonlyMap<string, Readonly<KindCounts>>;
}

/** Counts what the stored stakes say, from the terms and the records. */
export function summarizeStakes(stored: StoredStakes): StakesSummary {
  // Only kinds the run was allowed to ask are counted: an answer kept for a kind that is not adopted is not a stake.
  const asked = new Set(stored.kinds.asked);
  const records = new Map<string, StakeRecord | DerivedStake>([...stored.records, ...stored.derived].filter((record) => asked.has(record.kind)).map((record) => [stakePairKey(record.term, record.kind), record]));
  const byKind = new Map<string, KindCounts>(stored.kinds.asked.map((id) => [id, noCounts()]));
  const pairs = noCounts();
  let withMembers = 0;
  let incomplete = 0;
  const kept = new Map<string, (StakeRecord | DerivedStake)[]>();
  for (const record of [...stored.records, ...stored.derived].filter((one) => asked.has(one.kind))) kept.set(record.term, [...(kept.get(record.term) ?? []), record]);
  for (const term of stored.terms) {
    if (term.members === 0) {
      // A term with no current member has no stake; an answer kept from when it had one is stale, and counted as that.
      for (const record of kept.get(term.key) ?? []) {
        pairs.stale += 1;
        const kind = byKind.get(record.kind);
        if (kind !== undefined) kind.stale += 1;
      }
      continue;
    }
    withMembers += 1;
    if (term.unknown > 0) incomplete += 1;
    for (const id of term.asked) {
      const status = stakeStatus(records.get(stakePairKey(term.key, id)));
      const field = status === "could cause" ? "couldCause" : status === "judged no" ? "judgedNo" : status === "judged no over some members" ? "judgedNoSome" : status === "unclear" ? "unclear" : status === "stale" ? "stale" : "notJudged";
      pairs[field] += 1;
      const kind = byKind.get(id);
      if (kind !== undefined) kind[field] += 1;
    }
    for (const id of term.cut) {
      pairs.cut += 1;
      const kind = byKind.get(id);
      if (kind !== undefined) kind.cut += 1;
    }
  }
  return { terms: stored.terms.length, withMembers, noMembers: stored.terms.length - withMembers, incomplete, pairs, byKind };
}

/* ---- building and keeping ---- */

const sortRecords = <T extends { readonly term: string; readonly kind: string }>(records: readonly T[]): T[] => [...records].sort((a, b) => byText(a.term, b.term) || byText(a.kind, b.kind));

function storedTerms(entries: ReadonlyMap<string, TermMembers>, asked: (key: string) => readonly string[], cut: (key: string) => readonly string[]): StoredStakeTerm[] {
  return [...entries.values()]
    .map((entry) => ({ key: entry.term.key, members: entry.members.length, unknown: entry.unknown, membersDigest: membersDigest(entry.members), asked: asked(entry.term.key), cut: cut(entry.term.key) }))
    .sort((a, b) => byText(a.key, b.key));
}

/** The stakes after a judging run: every term as it is now, with the run's records. */
export function stakes(entries: ReadonlyMap<string, TermMembers>, outcome: JudgeStakesOutcome, choice: KindChoice, model: string, maxPairs: number, thresholds: Thresholds = STAKES_THRESHOLDS): StoredStakes {
  const cut = new Map<string, string[]>();
  for (const one of outcome.cut) cut.set(one.term, [...(cut.get(one.term) ?? []), one.kind]);
  return {
    tier: "judged",
    gate: { id: stakesGate.id, version: stakesGate.version },
    model,
    catalogueVersion: HARM_CATALOGUE_VERSION,
    thresholds,
    limit: { maxPairs },
    kinds: choice,
    // A term with no mapped member is asked about no kind.
    terms: storedTerms(
      entries,
      (key) => (entries.get(key)!.members.length === 0 ? [] : choice.asked.filter((id) => !(cut.get(key) ?? []).includes(id))),
      (key) => cut.get(key) ?? [],
    ),
    records: sortRecords(outcome.records),
    derived: sortRecords(outcome.derived),
  };
}

/**
 * Stored stakes brought up to date with the current members without asking Jev. A record of a term
 * that is gone, or of a kind that is no longer asked about, is dropped. A record whose term's
 * members or text changed, or whose catalogue version, question or thresholds are not the current
 * ones, is kept and marked stale.
 */
export function reconcileStakes(previous: StoredStakes, entries: ReadonlyMap<string, TermMembers>, tree: FileTree, choice: KindChoice): StoredStakes {
  const wanted = new Set(choice.asked);
  const now = new Map([...entries].map(([key, entry]) => [key, { members: membersDigest(entry.members), term: termDigest(entry.term, tree) }]));
  const kept = <T extends StakeRecord | DerivedStake>(records: readonly T[]): T[] =>
    records.flatMap((record) => {
      const current = now.get(record.term);
      if (current === undefined || !wanted.has(record.kind)) return [];
      const why =
        record.catalogueVersion !== HARM_CATALOGUE_VERSION
          ? "the catalogue changed"
          : record.membersDigest !== current.members
            ? "the term's members changed"
            : record.tier === "judged" && record.termDigest !== current.term
              ? "the term's definition changed"
              : record.tier === "judged" && record.question.version !== stakesGate.version
                ? "the question changed"
                : record.tier === "judged" && JSON.stringify(record.thresholds) !== JSON.stringify(STAKES_THRESHOLDS)
                  ? "the thresholds changed"
                  : record.stale?.startsWith("not judged again")
                    ? record.stale
                    : undefined;
      const { stale, ...rest } = record;
      void stale;
      const unknown = entries.get(record.term)!.unknown;
      const complete = record.tier === "judged" ? isComplete(record.members, record.shownMembers, unknown) : unknown === 0;
      return [(why === undefined ? { ...rest, complete } : { ...rest, complete, stale: why }) as T];
    });
  const old = new Map(previous.terms.map((term) => [term.key, term]));
  return {
    ...previous,
    kinds: choice,
    terms: storedTerms(entries, (key) => (entries.get(key)!.members.length === 0 ? [] : old.get(key)?.asked.filter((id) => wanted.has(id)) ?? []), (key) => old.get(key)?.cut.filter((id) => wanted.has(id)) ?? []),
    records: sortRecords(kept(previous.records)),
    derived: sortRecords(kept(previous.derived)),
  };
}

/** Whether stored stakes are the current ones' kind: the catalogue, the question and the thresholds are as they are now. A run over nothing changed redoes nothing only if so. */
export const stakesAreCurrent = (stored: StoredStakes): boolean =>
  stored.catalogueVersion === HARM_CATALOGUE_VERSION && stored.gate.version === stakesGate.version && JSON.stringify(stored.thresholds) === JSON.stringify(STAKES_THRESHOLDS);

/* ---- saying it ---- */

const money = (usd: number): string => `$${usd.toFixed(6)}`;

/** The report's lines about stakes. `note` is this run's judging, when it judged. */
export function stakesLines(stored: StoredStakes | undefined, terms: readonly Pick<Term, "key" | "name">[], note: StakesNote | undefined, hasMemberships: boolean): string[] {
  if (stored === undefined) {
    return [hasMemberships ? "  stakes: not recorded yet (run `streets setup --judge` to judge each term against each kind of harm)" : "  stakes: not recorded: they are judged over a term's mapped members, and nothing is mapped yet (run `streets setup --judge`)"];
  }
  const summary = summarizeStakes(stored);
  const names = new Map(terms.map((term) => [term.key, term.name]));
  const lines: string[] = [];
  lines.push(`  stakes: ${plural(summary.withMembers, "term")} judged of ${plural(summary.terms, "term")}`);
  lines.push(`    stakes unknown: ${summary.noMembers}${summary.noMembers > 0 ? " (a term with no mapped member has no stakes: unknown, never none)" : ""}`);
  if (summary.incomplete > 0) lines.push(`    judged over some of their members: ${summary.incomplete} (a pair of the term is stale, not judged or left out by the cap, so a no covers the members known)`);
  const asked = stored.kinds.asked.length;
  const total = asked + stored.kinds.notJudged.length;
  lines.push(`    kinds judged: ${asked} of ${total}`);
  for (const one of stored.kinds.notJudged) lines.push(`    kind not judged: ${harmKind(one.id)?.name ?? one.id} (${one.reason})`);
  const { pairs } = summary;
  lines.push(`    pairs: ${pairs.couldCause} could cause, ${pairs.judgedNo} judged no, ${pairs.judgedNoSome} judged no over some members, ${pairs.unclear} unclear, ${pairs.stale} stale, ${pairs.notJudged} not judged, ${pairs.cut} left out by the cap of ${stored.limit.maxPairs} per run`);
  if (note !== undefined) {
    // A request that was sent and got no usage may have been charged: it is never counted as $0.
    const cost = note.costUnknown > 0 ? (note.usd > 0 ? `cost at least ${money(note.usd)} (${note.costUnknown} ${note.costUnknown === 1 ? "call's" : "calls'"} cost unknown)` : `cost unknown (${plural(note.costUnknown, "call")})`) : `cost ${money(note.usd)}`;
    lines.push(`    this run: ${note.asked} asked of Jev, ${note.reused} reused, ${note.notJudged} not judged${note.firstFailure === undefined ? "" : ` (${note.firstFailure})`}, ${note.overLimit} not asked: over the limit of ${note.maxPairs} pairs; ${cost}`);
  }
  for (const id of stored.kinds.asked) {
    const one = summary.byKind.get(id)!;
    const name = harmKind(id)?.name ?? id;
    lines.push(`    ${name}: ${one.couldCause} could cause, ${one.judgedNo} judged no, ${one.judgedNoSome} judged no over some members, ${one.unclear} unclear, ${one.stale} stale, ${one.notJudged} not judged${one.cut > 0 ? `, ${one.cut} left out by the cap` : ""}`);
  }
  const unknownNames = stored.terms.filter((term) => term.members === 0).map((term) => names.get(term.key) ?? term.key);
  if (unknownNames.length > 0 && unknownNames.length <= 5) lines.push(`    stakes unknown for: ${unknownNames.join(", ")}`);
  return lines;
}
