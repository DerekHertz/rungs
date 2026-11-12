import { createHash } from "node:crypto";
import { DERIVED_FACTS, HARM_CATALOGUE, HARM_CATALOGUE_VERSION } from "../harm-catalogue.ts";
import type { DerivedFact, DerivedFactName, HarmKind } from "../harm-catalogue.ts";
import type { FileTree, NodeId } from "../graph.ts";
import { pairStatus } from "../memberships.ts";
import type { MembershipRecord, StoredMemberships } from "../memberships.ts";
import { promptEffect } from "../prompt-safe.ts";
import type { DerivedStake, StakeRecord } from "../stakes.ts";
import type { Term } from "../vocabulary.ts";
import { judge } from "./client.ts";
import type { JevClient } from "./client.ts";
import { requestFor, yesOf } from "./gate.ts";
import type { Thresholds } from "./gate.ts";
import { answersCover } from "./membership-gate.ts";
import { pairKey, termDigest, termFacts, unitFacts } from "./membership-source.ts";
import type { Unit } from "./membership-source.ts";
import { MAX_EFFECTS, MAX_MEMBERS_SHOWN, MAX_MEMBER_LINES, STAKES_THRESHOLDS, stakesGate } from "./stakes-gate.ts";
import type { MemberFacts, StakesInput } from "./stakes-gate.ts";

/*
 * What the stakes gate is given and how code picks it. Nothing here writes a graph fact: a stake is
 * a judged record kept apart, and a member is read from the stored memberships, never changed. The
 * pair is (term, kind of harm). The term's code is its mapped members (current, judged members
 * only: a stale or unjudged mapping is not a member, and the term says how many pairs are unknown).
 * Every piece of text that can reach Jev is made prompt-safe by the membership edge's own functions
 * (termFacts and unitFacts: secrets withheld, URLs cut to their host, long lines clipped, paths with
 * a secret-shaped part withheld).
 */

/** The most (term, kind) pairs asked in one run; the rest are counted and listed as left out. */
export const MAX_STAKES_PAIRS = 2_000;

/** One mapped member of a term, with how sure the mapping was. */
export interface MappedMember {
  readonly unit: Unit;
  /** Jev's probability that the unit belongs to the term, as the membership record has it. */
  readonly belongs: number;
}

/** A term and the code mapped to it. */
export interface TermMembers {
  readonly term: Term;
  /** Current members only, strongest mapping first, then by key. Empty when none is mapped: its stakes are unknown. */
  readonly members: readonly MappedMember[];
  /** Pairs of the term whose mapping is not known (stale, not judged, or left out by the cap): its members may be incomplete. */
  readonly unknown: number;
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The code of every term, read from the stored memberships: the units whose pair with the term is
 * a current member, and how many of the term's candidate pairs are not known. Every term of the
 * vocabulary is in the result, with no members when none is mapped to it.
 */
export function termMembers(stored: StoredMemberships, units: readonly Unit[], terms: readonly Term[]): Map<string, TermMembers> {
  const unitByKey = new Map(units.map((unit) => [unit.key, unit]));
  const byPair = new Map<string, MembershipRecord>(stored.records.map((record) => [pairKey(record.unit, record.term), record]));
  const found = new Map<string, { members: MappedMember[]; unknown: number }>();
  const slot = (key: string): { members: MappedMember[]; unknown: number } => {
    let one = found.get(key);
    if (one === undefined) found.set(key, (one = { members: [], unknown: 0 }));
    return one;
  };
  for (const stored1 of stored.units) {
    const unit = unitByKey.get(stored1.key);
    if (unit === undefined) continue;
    for (const key of stored1.candidates) {
      const record = byPair.get(pairKey(unit.key, key));
      const status = pairStatus(record);
      if (status === "member" && record!.digest === unit.digest) slot(key).members.push({ unit, belongs: yesOf(record!.answers, "belongs") ?? 0 });
      else if (status === "member" || status === "stale" || status === "not judged") slot(key).unknown += 1;
    }
    for (const key of stored1.cut) slot(key).unknown += 1;
  }
  return new Map(
    terms.map((term) => {
      const one = found.get(term.key) ?? { members: [], unknown: 0 };
      const members = [...one.members].sort((a, b) => b.belongs - a.belongs || byText(a.unit.key, b.unit.key));
      return [term.key, { term, members, unknown: one.unknown }];
    }),
  );
}

/** A digest of the term's mapped members: each member's key and declaration digest. A stake is stale when a member or the membership changes. */
export function membersDigest(members: readonly MappedMember[]): string {
  const rows = members.map((member) => [member.unit.key, member.unit.digest]).sort((a, b) => byText(a[0]!, b[0]!));
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 32);
}

/**
 * Whether an answer covers all of a term's code: every mapped member was shown, and no pair of the term
 * is unknown (a member whose mapping is stale, not judged or cut may exist). A "no" over less than that
 * is a no over some members, never none.
 */
export const isComplete = (members: number, shown: number, unknown: number): boolean => shown >= members && unknown === 0;

/** The key of one (term, kind) pair. A Map's key: term keys come from the repository. */
export const stakePairKey = (term: string, kind: string): string => `${term}\0${kind}`;

/* ---- what Jev is shown ---- */

/** The resource a derived fact is about, when it is an effect. */
const resourceOf = (fact: DerivedFactName): DerivedFact["resource"] => (DERIVED_FACTS[fact] as DerivedFact).resource;

/** What a member's own calls derive that bears on this kind: its effects on the resources the kind's facts name, as a prompt may show them. */
function derivedEffects(kind: HarmKind, unit: Unit, effects: ReadonlyMap<NodeId, ReadonlySet<string>> | undefined): string[] {
  const resources = new Set(kind.facts.map((fact) => resourceOf(fact)).filter((resource) => resource !== undefined));
  if (resources.size === 0 || effects === undefined) return [];
  const labels = [...(effects.get(unit.id) ?? [])].filter((label) => [...resources].some((resource) => label.startsWith(`${resource} `)));
  return [...new Set(labels.map(promptEffect))].sort(byText).slice(0, MAX_EFFECTS);
}

/**
 * The gate's input for one (term, kind): the term as the membership edge shows it, and the first
 * MAX_MEMBERS_SHOWN members, strongest mapping first, each cut to MAX_MEMBER_LINES lines. The
 * input says how many members were left out and how many lines were cut.
 */
export function stakesInputOf(request: { readonly kind: HarmKind; readonly entry: TermMembers; readonly tree: FileTree; readonly effects?: ReadonlyMap<NodeId, ReadonlySet<string>> }): StakesInput {
  const { kind, entry, tree, effects } = request;
  const shown = entry.members.slice(0, MAX_MEMBERS_SHOWN);
  const members: MemberFacts[] = shown.map((member) => ({ ...unitFacts(member.unit, tree, MAX_MEMBER_LINES), effects: derivedEffects(kind, member.unit, effects) }));
  return { kind: kind.id, term: termFacts(entry.term, tree), members, omittedMembers: entry.members.length - shown.length };
}

/* ---- kinds that code answers ---- */

/** Whether a member has a derived fact: true or false when it is known exactly, undefined when code cannot tell. */
export type FactReader = (fact: DerivedFactName, member: Unit) => boolean | undefined;

/**
 * The reader over the effect sets of a graph (see effectSets). It says yes when a member's own
 * calls reach the resource a fact names. It never says no: an effect set holds direct calls only,
 * so a member with none may still reach the resource through a call it makes, and that is unknown.
 */
export function effectReader(effects: ReadonlyMap<NodeId, ReadonlySet<string>>): FactReader {
  return (fact, member) => {
    const resource = resourceOf(fact);
    if (resource === undefined) return undefined;
    return [...(effects.get(member.id) ?? [])].some((label) => label.startsWith(`${resource} `)) ? true : undefined;
  };
}

/**
 * The answer of a kind whose `answer` is "code": yes when any member has any of the kind's facts,
 * no only when every member is known not to have any of them, and otherwise unknown. A term with
 * no member is unknown. Never called for a kind that needs judgement.
 */
export function answerByCode(kind: HarmKind, members: readonly { readonly unit: Unit }[], read: FactReader): "yes" | "no" | "unknown" {
  if (kind.facts.length === 0) throw new Error(`${kind.id} is answered by code but names no derived fact`);
  if (members.length === 0) return "unknown";
  let unknown = false;
  for (const member of members) {
    for (const fact of kind.facts) {
      const seen = read(fact, member.unit);
      if (seen === true) return "yes";
      if (seen === undefined) unknown = true;
    }
  }
  return unknown ? "unknown" : "no";
}

/* ---- asking ---- */

export interface NotJudgedStake {
  readonly term: string;
  readonly kind: string;
  readonly reason: string;
}

export interface JudgeStakesOutcome {
  /** One record per pair that has an answer now: asked, reused, or an older one kept and marked stale. */
  readonly records: StakeRecord[];
  /** The pairs a kind answered by code filled, by code alone. */
  readonly derived: DerivedStake[];
  readonly asked: number;
  readonly reused: number;
  readonly notJudged: readonly NotJudgedStake[];
  /** Pairs not asked because more than `maxPairs` had to be: listed, never dropped silently. */
  readonly cut: readonly { readonly term: string; readonly kind: string }[];
  readonly overLimit: number;
  readonly usd: number;
  /** Calls whose cost is unknown; `usd` leaves them out. */
  readonly costUnknown: number;
}

export interface JudgeStakesRequest {
  readonly terms: ReadonlyMap<string, TermMembers>;
  readonly tree: FileTree;
  /** The effect sets of the graph (see effectSets), for the derived facts shown beside the question. */
  readonly effects?: ReadonlyMap<NodeId, ReadonlySet<string>>;
  /** The records a stored run holds, by `stakePairKey`. */
  readonly previous: ReadonlyMap<string, StakeRecord>;
  readonly client: JevClient;
  readonly thresholds?: Thresholds;
  readonly maxPairs?: number;
  /** The kinds to ask about, in the order a limit cuts at; the catalogue when left out. A kind that missed the bench bar is not given. */
  readonly kinds?: readonly HarmKind[];
  /** Reads the facts that a kind answered by code uses. The effect reader of `effects`, or a reader that knows nothing, when left out. */
  readonly reader?: FactReader;
  readonly catalogueVersion?: number;
}

const PARALLEL = 4;

/** A record with its stale mark taken off: its members, request, thresholds, catalogue and model are all as they were. */
function fresh(record: StakeRecord): StakeRecord {
  const { stale, ...rest } = record;
  void stale;
  return rest;
}

/**
 * Asks Jev once for each (term, kind that needs judgement), the terms with the most members first,
 * up to `maxPairs`. A term with no mapped member is not asked: its stakes are unknown. An answer
 * already stored is reused when the members' digest, the term's text, the exact request, the
 * thresholds, the model and the catalogue's version are all the same. A pair that could not be
 * judged has no record (no answer is never a no); an older record for it is kept and marked stale.
 * A kind answered by code is filled by `answerByCode`, never by Jev, and costs nothing.
 */
export async function judgeStakes(request: JudgeStakesRequest): Promise<JudgeStakesOutcome> {
  const { terms, tree, effects, previous, client, thresholds = STAKES_THRESHOLDS, maxPairs = MAX_STAKES_PAIRS, kinds = HARM_CATALOGUE, catalogueVersion = HARM_CATALOGUE_VERSION } = request;
  const reader = request.reader ?? (effects === undefined ? () => undefined : effectReader(effects));
  const question = { id: stakesGate.id, version: stakesGate.version };
  const asked = [...terms.values()].filter((entry) => entry.members.length > 0).sort((a, b) => b.members.length - a.members.length || byText(a.term.key, b.term.key));
  const digests = new Map(asked.map((entry) => [entry.term.key, { members: membersDigest(entry.members), term: termDigest(entry.term, tree) }]));
  const notJudged: NotJudgedStake[] = [];
  const derived: DerivedStake[] = [];
  for (const entry of asked) {
    for (const kind of kinds) {
      if (kind.answer !== "code") continue;
      const answer = answerByCode(kind, entry.members, reader);
      if (answer === "unknown") notJudged.push({ term: entry.term.key, kind: kind.id, reason: "the derived facts could not answer it" });
      else derived.push({ tier: "derived", term: entry.term.key, kind: kind.id, catalogueVersion, membersDigest: digests.get(entry.term.key)!.members, members: entry.members.length, complete: entry.unknown === 0, answer, facts: [...kind.facts] });
    }
  }
  interface Pair {
    readonly entry: TermMembers;
    readonly kind: HarmKind;
  }
  const pairs: Pair[] = asked.flatMap((entry) => kinds.filter((kind) => kind.answer === "judgement").map((kind) => ({ entry, kind })));
  const slots: (StakeRecord | undefined)[] = new Array<StakeRecord | undefined>(pairs.length);
  const toAsk: number[] = [];
  let reused = 0;
  let usd = 0;
  let costUnknown = 0;
  const kept = (index: number, why: string): void => {
    const { entry, kind } = pairs[index]!;
    const old = previous.get(stakePairKey(entry.term.key, kind.id));
    if (old === undefined) return;
    const now = digests.get(entry.term.key)!;
    const stale = old.catalogueVersion !== catalogueVersion ? "the catalogue changed" : old.membersDigest !== now.members ? "the term's members changed" : old.termDigest !== now.term ? "the term's definition changed" : `not judged again: ${why}`;
    slots[index] = { ...old, stale };
  };
  // Answers that can be reused are separated first and do not use the per-run limit: only pairs that
  // must be asked count against it, so a run over the limit finishes the rest on the next run.
  pairs.forEach(({ entry, kind }, index) => {
    const old = previous.get(stakePairKey(entry.term.key, kind.id));
    const now = digests.get(entry.term.key)!;
    const shown = requestFor(stakesGate, stakesInputOf({ kind, entry, tree, ...(effects === undefined ? {} : { effects }) }));
    if (
      old !== undefined &&
      old.catalogueVersion === catalogueVersion &&
      old.membersDigest === now.members &&
      old.termDigest === now.term &&
      old.model === client.model &&
      JSON.stringify(old.shown) === JSON.stringify(shown) &&
      JSON.stringify(old.thresholds) === JSON.stringify(thresholds) &&
      old.question.id === question.id &&
      old.question.version === question.version &&
      answersCover(old.answers, Object.keys(shown.questions))
    ) {
      // Whether the answer covers every member is a fact about the term now: a mapping that was not known may be now.
      slots[index] = { ...fresh(old), complete: isComplete(old.members, old.shownMembers, entry.unknown) };
      reused += 1;
    } else toAsk.push(index);
  });
  const asking = toAsk.slice(0, maxPairs);
  const over = toAsk.slice(maxPairs);
  for (const index of over) kept(index, `over the limit of ${maxPairs} pairs`);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let slot = next++; slot < asking.length; slot = next++) {
      const index = asking[slot]!;
      const { entry, kind } = pairs[index]!;
      const input = stakesInputOf({ kind, entry, tree, ...(effects === undefined ? {} : { effects }) });
      const shown = requestFor(stakesGate, input);
      const judged = await judge(client, shown);
      if (judged.status === "not judged") {
        notJudged.push({ term: entry.term.key, kind: kind.id, reason: judged.reason });
        // A request that was sent and got no usage may have been charged: its cost is unknown, never zero. One that was never sent cost nothing.
        if (judged.kind !== "off" && judged.kind !== "no-key") costUnknown += 1;
        kept(index, judged.reason);
        continue;
      }
      if (judged.usage.usd === null) costUnknown += 1;
      else usd += judged.usage.usd;
      // A call that answered, but not every question with a probability, is unknown: no record, so no later run reuses it.
      if (!answersCover(judged.answers, Object.keys(shown.questions))) {
        const reason = "an answer could not be read (missing or not a probability)";
        notJudged.push({ term: entry.term.key, kind: kind.id, reason });
        kept(index, reason);
        continue;
      }
      const now = digests.get(entry.term.key)!;
      slots[index] = {
        tier: "judged",
        term: entry.term.key,
        kind: kind.id,
        catalogueVersion,
        membersDigest: now.members,
        termDigest: now.term,
        members: entry.members.length,
        shownMembers: input.members.length,
        complete: isComplete(entry.members.length, input.members.length, entry.unknown),
        question,
        shown,
        answers: judged.answers,
        thresholds,
        verdict: stakesGate.decide(judged.answers, thresholds),
        model: judged.model,
        inputTokens: judged.usage.inputTokens,
        usd: judged.usage.usd,
      };
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, asking.length) }, worker));
  return {
    records: slots.filter((one): one is StakeRecord => one !== undefined),
    derived,
    asked: asking.length,
    reused,
    notJudged: notJudged.sort((a, b) => byText(a.term, b.term) || byText(a.kind, b.kind)),
    cut: over.map((index) => ({ term: pairs[index]!.entry.term.key, kind: pairs[index]!.kind.id })),
    overLimit: over.length,
    usd,
    costUnknown,
  };
}
