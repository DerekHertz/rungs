import { createHash } from "node:crypto";
import { hasFields, isRecord, isText } from "./memberships.ts";
import type { PairStatus } from "./memberships.ts";
import { certificationLine } from "./file-card.ts";
import type { DocCertification, DocStamp } from "./file-card.ts";
import { shown } from "./stored-names.ts";

/*
 * Corrections: what a person says about a vocabulary, stored with it (`corrections` in the setup
 * store, see setup.ts) and winning over every judged answer. A correction is a human fact (its own
 * tier): who made it (a display name, never an email), when, and what. It is keyed on stable ids,
 * the term's key and the unit's key (see Unit.key), so it survives a rebuild of the vocabulary, a
 * new extractor or a changed table. One that no longer has anything to apply to is kept and
 * reported ("no longer applies"), never dropped.
 *
 * Replay: the list is in the order the corrections were made, and the latest correction about a
 * term (or about a (function, term) pair) wins. A confirm brings back a term that was removed or
 * merged away.
 */

/** Who and when. `by` is a display name: it is what the page shows, so an email is never stored unless the person passed one as the name. */
export interface Stamp {
  readonly by: string;
  /** ISO 8601, UTC. */
  readonly at: string;
}

/** `label` says what the correction was about when it was made (a term's name, or a function and its file), so a correction whose target is gone can still be read. */
export type Correction = Stamp & { readonly label: string } & (
    | { readonly kind: "confirm"; readonly term: string }
    | { readonly kind: "rename"; readonly term: string; readonly name: string }
    | { readonly kind: "merge"; readonly term: string; readonly into: string }
    | { readonly kind: "remove"; readonly term: string }
    | { readonly kind: "member"; readonly unit: string; readonly term: string; readonly belongs: boolean }
  );

/** A certification: who and when, and what the person was shown. See `certificationOf`. */
export interface Certification extends Stamp {
  /** `vocabularyDigest` of the terms at the time. */
  readonly vocabulary: string;
  /** `correctionsDigest` of the corrections at the time. */
  readonly corrections: string;
}

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/;
const isStamp = (value: unknown): boolean => hasFields(value, { by: isText, at: (at) => typeof at === "string" && ISO.test(at) && !Number.isNaN(Date.parse(at)) });

const KINDS: Readonly<Record<string, Readonly<Record<string, (field: unknown) => boolean>>>> = {
  confirm: { term: isText },
  rename: { term: isText, name: isText },
  merge: { term: isText, into: isText },
  remove: { term: isText },
  member: { unit: isText, term: isText, belongs: (belongs) => typeof belongs === "boolean" },
};

/** The name of the first thing wrong with stored corrections, or undefined when they are whole. */
export function problemWithCorrections(value: unknown): string | undefined {
  if (!Array.isArray(value)) return "corrections is not a list";
  const bad = value.findIndex((one) => !(isRecord(one) && isStamp(one) && isText(one.label) && typeof one.kind === "string" && Object.hasOwn(KINDS, one.kind) && hasFields(one, KINDS[one.kind]!)));
  return bad === -1 ? undefined : `corrections[${bad}]`;
}

/** The name of what is wrong with a stored certification, or undefined when it is whole or absent. */
export function problemWithCertification(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return isStamp(value) && hasFields(value, { vocabulary: isText, corrections: isText }) ? undefined : "certification";
}

/* ---- replaying the corrections over the terms ---- */

/** A term as the page shows it once the corrections are applied. */
export interface VisibleTerm {
  readonly key: string;
  readonly name: string;
  /** The name the vocabulary gave it, when a rename changed it. */
  readonly renamedFrom?: string;
  readonly confirmed?: Stamp;
  /** The names of the terms merged into this one. */
  readonly mergedFrom?: readonly string[];
}

export interface PairCorrection extends Stamp {
  readonly unit: string;
  /** The term as the person named it: a stored term's key, whatever has been merged since. */
  readonly term: string;
  readonly belongs: boolean;
}

export interface Inapplicable {
  readonly correction: Correction;
  readonly why: string;
}

export interface Effect {
  /** The terms to show, by key, in the vocabulary's order. */
  readonly visible: ReadonlyMap<string, VisibleTerm>;
  /** The visible term a stored term shows as (itself, or the term it was merged into); undefined when it was removed, or was merged into a term that was. */
  readonly resolve: (key: string) => string | undefined;
  /** A stored term's name as the corrections leave it (renamed or not), shown or hidden. */
  readonly nameOf: (key: string) => string;
  /** The stored terms that show as this visible term: itself first, then every term merged into it. */
  readonly sources: (key: string) => readonly string[];
  /** The latest correction of each (function, term) pair as the person named it, by `${unit}\0${term}`. */
  readonly pairs: ReadonlyMap<string, PairCorrection>;
  /** Corrections with nothing to apply to, in the order made: kept, and said so. */
  readonly inapplicable: readonly Inapplicable[];
}

/**
 * The keys of the terms a person removed, or merged away as a duplicate, and did not bring back with a confirm. Replayed in the
 * order made, whether or not a term of that key is in the vocabulary now, so a model that proposes terms is never taken up on
 * one again on a later setup.
 */
export function rejectedTerms(corrections: readonly Correction[]): Set<string> {
  const rejected = new Set<string>();
  for (const correction of corrections) {
    if (correction.kind === "remove" || correction.kind === "merge") rejected.add(correction.term);
    else if (correction.kind === "confirm") rejected.delete(correction.term);
  }
  return rejected;
}

interface TermState {
  removed: boolean;
  name?: string;
  confirmed?: Stamp;
  into?: string;
}

export const pairKeyOf = (unit: string, term: string): string => `${unit}\0${term}`;

/** The terms of the vocabulary with the corrections replayed over them, in the order they were made. */
export function effectOf(terms: readonly { readonly key: string; readonly name: string }[], corrections: readonly Correction[]): Effect {
  const nameOf = new Map(terms.map((term) => [term.key, term.name]));
  const states = new Map(terms.map((term) => [term.key, { removed: false } as TermState]));
  const pairs = new Map<string, PairCorrection>();
  const inapplicable: Inapplicable[] = [];
  const skip = (correction: Correction, why: string): void => void inapplicable.push({ correction, why });
  /** Whether following merges from `key` arrives at `target`. */
  const reaches = (key: string, target: string): boolean => {
    for (let at: string | undefined = key, seen = 0; at !== undefined && seen <= terms.length; at = states.get(at)?.into, seen++) if (at === target) return true;
    return false;
  };
  for (const correction of corrections) {
    const state = states.get(correction.term);
    if (state === undefined) {
      skip(correction, "the term is no longer in the vocabulary");
      continue;
    }
    const stamp = { by: correction.by, at: correction.at };
    switch (correction.kind) {
      case "confirm":
        state.removed = false;
        delete state.into;
        state.confirmed = stamp;
        break;
      case "rename":
        state.name = correction.name;
        break;
      case "remove":
        state.removed = true;
        delete state.into;
        break;
      case "merge":
        if (!states.has(correction.into)) skip(correction, "the term it was merged into is no longer in the vocabulary");
        else if (reaches(correction.into, correction.term)) skip(correction, "a merge loops back on itself");
        else {
          state.removed = false;
          state.into = correction.into;
        }
        break;
      case "member":
        pairs.set(pairKeyOf(correction.unit, correction.term), { ...stamp, unit: correction.unit, term: correction.term, belongs: correction.belongs });
        break;
    }
  }
  const resolve = (key: string): string | undefined => {
    let at = key;
    // A merge loop is refused when it is made, so this ends; the bound is for a file edited by hand.
    for (let hops = 0; hops <= terms.length; hops++) {
      const state = states.get(at);
      if (state === undefined || state.removed) return undefined;
      if (state.into === undefined) return at;
      at = state.into;
    }
    return undefined;
  };
  const nameFor = (key: string): string => states.get(key)?.name ?? nameOf.get(key) ?? key;
  const visible = new Map<string, VisibleTerm>();
  const sourcesOf = new Map<string, string[]>();
  for (const { key } of terms) {
    const target = resolve(key);
    if (target === undefined) continue;
    sourcesOf.set(target, [...(sourcesOf.get(target) ?? []), key]);
  }
  for (const { key } of terms) {
    if (resolve(key) !== key) continue;
    const state = states.get(key)!;
    const merged = (sourcesOf.get(key) ?? []).filter((one) => one !== key);
    visible.set(key, {
      key,
      name: nameFor(key),
      ...(state.name !== undefined && state.name !== nameOf.get(key) ? { renamedFrom: nameOf.get(key)! } : {}),
      ...(state.confirmed === undefined ? {} : { confirmed: state.confirmed }),
      ...(merged.length === 0 ? {} : { mergedFrom: merged.map(nameFor) }),
    });
  }
  const sources = (key: string): readonly string[] => (sourcesOf.get(key) ?? [key]).slice().sort((a, b) => (a === key ? -1 : b === key ? 1 : 0));
  return { visible, resolve, nameOf: nameFor, sources, pairs, inapplicable };
}

/** What one stored term (a visible term, or a term merged into it) says of one function: a person's word on the pair, or the judged answer. */
export interface Part {
  readonly status: PairStatus;
  readonly why?: string;
  readonly said?: PairCorrection;
}

/** Least to greatest doubt: a member beats an answer that is out of date, that is unknown, that is in the middle, that is a no. */
const RANK: Readonly<Record<PairStatus, number>> = { member: 0, stale: 1, "not judged": 2, "middle band": 3, "not a member": 4 };

/**
 * THE rule for whether a function is in a visible term, one for everything that reads membership (the card, the term's counts,
 * the stakes behind a tier): `direct` is a person's word on the pair with the visible term itself, and it decides. Otherwise the
 * parts (the term and every term merged into it) are read together: the least doubtful status wins, and a person's yes on any part
 * is the correction behind it. A person's word beats every judged answer.
 */
export function combine(direct: PairCorrection | undefined, parts: readonly Part[]): { readonly status: PairStatus; readonly corrected?: PairCorrection } {
  if (direct !== undefined) return { status: direct.belongs ? "member" : "not a member", corrected: direct };
  const yes = parts.find((part) => part.said?.belongs === true)?.said;
  const status = parts.reduce<PairStatus>((one, part) => (RANK[part.status] < RANK[one] ? part.status : one), "not a member");
  return { status, ...(yes === undefined ? {} : { corrected: yes }) };
}

/**
 * Every correction with nothing to apply to, in the order made: the ones `effectOf` could not apply, and the latest
 * correction of a pair whose function is not among `unitKeys` (the functions of the tree being drawn or built from;
 * undefined when they are not known, and then no function is reported).
 */
export function noLongerApply(effect: Effect, corrections: readonly Correction[], unitKeys: ReadonlySet<string> | undefined): Inapplicable[] {
  const found = new Map(effect.inapplicable.map((one) => [one.correction, one.why]));
  const latest = new Map<string, Correction>();
  for (const correction of corrections) if (correction.kind === "member") latest.set(pairKeyOf(correction.unit, correction.term), correction);
  const out: Inapplicable[] = [];
  for (const correction of corrections) {
    const why = found.get(correction) ?? (correction.kind === "member" && latest.get(pairKeyOf(correction.unit, correction.term)) === correction && unitKeys !== undefined && !unitKeys.has(correction.unit) ? "the function is not in this tree" : undefined);
    if (why !== undefined) out.push({ correction, why });
  }
  return out;
}

/* ---- certification ---- */

const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

/** What a person looked at when they certified the terms: every term's key and name, in key order. */
export const vocabularyDigest = (terms: readonly { readonly key: string; readonly name: string }[]): string => digest(terms.map((term) => [term.key, term.name]).sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0)));

/** Every correction, in the order made, with who and when. */
export const correctionsDigest = (corrections: readonly Correction[]): string => digest(corrections);

export type CertificationState =
  | { readonly kind: "drafted"; readonly was?: Stamp; readonly since?: "corrections" }
  | { readonly kind: "certified"; readonly by: string; readonly at: string }
  | { readonly kind: "changed"; readonly by: string; readonly at: string };

/**
 * Whether the vocabulary is certified. THE RULE, the simplest one that is never false: a
 * certification records the digest of the terms (key and name) and of the corrections as they were
 * when `streets vocabulary certify` ran. Certified means both digests match the store now, so the
 * label never sits on terms or corrections nobody saw.
 * - No certification: drafted.
 * - Corrections differ (any later correction, of any kind): drafted again, naming who certified before.
 * - Only the terms differ (setup rebuilt them with other keys or names): "changed", said as
 *   "certified ..., vocabulary changed since". It is not plain certified.
 * Judged memberships are not part of what is certified: a person certifies terms and corrections.
 */
export function certificationOf(terms: readonly { readonly key: string; readonly name: string }[], corrections: readonly Correction[], certification: Certification | undefined): CertificationState {
  if (certification === undefined) return { kind: "drafted" };
  const who = { by: certification.by, at: certification.at };
  if (certification.corrections !== correctionsDigest(corrections)) return { kind: "drafted", was: who, since: "corrections" };
  if (certification.vocabulary !== vocabularyDigest(terms)) return { kind: "changed", ...who };
  return { kind: "certified", ...who };
}

/* ---- saying it ---- */

/** One correction in words, with what it was about when it was made. Text from the store is withheld when it is shaped like a secret. */
export function describeCorrection(correction: Correction): string {
  switch (correction.kind) {
    case "confirm":
      return `confirm ${shown(correction.label)}`;
    case "rename":
      return `rename ${shown(correction.label)} to ${shown(correction.name)}`;
    case "merge":
      return `merge ${shown(correction.label)}`;
    case "remove":
      return `remove ${shown(correction.label)}`;
    case "member":
      return `${correction.belongs ? "yes" : "no"}: ${shown(correction.label)}`;
  }
}

/** The certification as the page and the command line show it: who certified is withheld when it is shaped like a secret. */
export function shownCertification(state: CertificationState): DocCertification {
  const stamp = (one: Stamp): DocStamp => ({ by: shown(one.by), at: one.at });
  if (state.kind === "drafted") return { kind: "drafted", ...(state.was === undefined ? {} : { was: stamp(state.was) }), ...(state.since === undefined ? {} : { since: state.since }) };
  return { kind: state.kind, ...stamp(state) } as DocCertification;
}

/** The certification in one line: drafted, certified by whom and when, or certified and changed since. */
export const certificationText = (state: CertificationState): string => certificationLine(shownCertification(state));
