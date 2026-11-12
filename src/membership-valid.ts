import { EXTRACTOR_VERSION } from "./extract/extract.ts";
import { MEMBERSHIP_THRESHOLDS, membershipGate } from "./jev/membership-gate.ts";
import { MAX_CANDIDATES, NARROWING_VERSION } from "./jev/membership-source.ts";
import type { Unit } from "./jev/membership-source.ts";
import type { MembershipRecord, StoredMemberships, StoredUnit } from "./memberships.ts";
import { VOCABULARY_TABLE_VERSION } from "./vocabulary-table.ts";

/*
 * The one rule for whether a stored answer still holds for the head of a comparison. The file
 * card, the term detail, a term's count and the names on risk and contract entries are all built
 * from it (src/vocabulary-doc.ts), so they cannot disagree. A stored answer is a judged fact about
 * the code and the term as they were when it was asked: it holds only while nothing it depended on
 * changed. Anything else is "stale" and is never read as a member, and never as "no term" either.
 */

/** What the stored file says it was built with, for the part of the store that is not about one answer. */
export interface StoredRules {
  readonly extractorVersion: string;
  readonly tableVersion: number;
  readonly memberships?: Pick<StoredMemberships, "gate" | "narrowing" | "thresholds">;
}

/**
 * Why every stored answer is out of date, or undefined when the store was built with this
 * version's rules: the extractor, the vocabulary table, the narrowing rule, the question or the
 * thresholds. One of them differing makes every answer stale, so the page says to run setup again.
 */
export function rulesChanged(stored: StoredRules): string | undefined {
  if (stored.tableVersion !== VOCABULARY_TABLE_VERSION) return `table ${stored.tableVersion}, this version uses ${VOCABULARY_TABLE_VERSION}`;
  if (stored.extractorVersion !== EXTRACTOR_VERSION) return `extractor ${stored.extractorVersion}, this version uses ${EXTRACTOR_VERSION}`;
  const held = stored.memberships;
  if (held === undefined) return undefined;
  if (held.narrowing.version !== NARROWING_VERSION) return `narrowing ${held.narrowing.version}, this version uses ${NARROWING_VERSION}`;
  if (held.narrowing.maxCandidates !== MAX_CANDIDATES) return `candidates per function ${held.narrowing.maxCandidates}, this version uses ${MAX_CANDIDATES}`;
  if (held.gate.id !== membershipGate.id || held.gate.version !== membershipGate.version) return `question ${held.gate.version}, this version uses ${membershipGate.version}`;
  if (JSON.stringify(held.thresholds) !== JSON.stringify(MEMBERSHIP_THRESHOLDS)) return "thresholds differ from this version's";
  return undefined;
}

export type Validity = { readonly ok: true } | { readonly ok: false; readonly why: string };

/** What the head offers to check a stored answer against. */
export interface HeadFacts {
  /** Set when the store's rules differ from this version's (see `rulesChanged`). */
  readonly rules: string | undefined;
  readonly headUnits: ReadonlyMap<string, Unit>;
  readonly storedUnits: ReadonlyMap<string, StoredUnit>;
  /** The digest of a term's definition as the head's text gives it; undefined for a term the store no longer has. */
  readonly termDigestOf: (termKey: string) => string | undefined;
}

/** Whether the stored unit is the function the head has under that key: key, path, name and level all agree. Any disagreement is damage, not a match. */
export const sameIdentity = (stored: StoredUnit, head: Unit): boolean => stored.key === head.key && stored.path === head.storedPath && stored.name === head.storedName && stored.level === head.level;

/** Whether a stored unit still describes the head's function: the rules, the identity and the function's own digest. */
export function unitValidity(stored: StoredUnit | undefined, head: Unit | undefined, rules: string | undefined): Validity {
  if (rules !== undefined) return { ok: false, why: "rules changed: run streets setup" };
  if (stored === undefined) return { ok: false, why: "not judged: the store has not seen this function" };
  if (head === undefined) return { ok: false, why: "not in this tree" };
  if (!sameIdentity(stored, head)) return { ok: false, why: "the stored function does not match this one" };
  if (stored.digest !== head.digest) return { ok: false, why: "the function changed" };
  return { ok: true };
}

/**
 * Whether one stored answer holds for the head: its unit still describes the head's function, the
 * answer's own digest is that function's, it was asked of the current question with the current
 * thresholds, it is not marked stale, and the term's definition is what the classifier was shown.
 */
export function recordValidity(record: MembershipRecord, facts: HeadFacts): Validity {
  const unit = unitValidity(facts.storedUnits.get(record.unit), facts.headUnits.get(record.unit), facts.rules);
  if (!unit.ok) return unit;
  if (record.digest !== facts.headUnits.get(record.unit)!.digest) return { ok: false, why: "the function changed" };
  if (record.stale !== undefined) return { ok: false, why: record.stale };
  if (record.question.id !== membershipGate.id || record.question.version !== membershipGate.version) return { ok: false, why: "the question changed" };
  if (JSON.stringify(record.thresholds) !== JSON.stringify(MEMBERSHIP_THRESHOLDS)) return { ok: false, why: "the thresholds changed" };
  const term = facts.termDigestOf(record.term);
  if (term === undefined) return { ok: false, why: "the term is gone" };
  if (term !== record.termDigest) return { ok: false, why: "the term's definition changed" };
  return { ok: true };
}
