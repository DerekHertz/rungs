import { digestOf } from "./extract/extract.ts";
import type { DocFile, DocMember, DocPin, DocTerm, DocTermRef, VocabularyDoc } from "./file-card.ts";
import type { FileTree, Graph, NodeId } from "./graph.ts";
import { yesOf } from "./jev/gate.ts";
import { termDigest, unitsOf } from "./jev/membership-source.ts";
import type { Unit } from "./jev/membership-source.ts";
import { answersCover } from "./jev/membership-gate.ts";
import { recordValidity, rulesChanged, unitValidity } from "./membership-valid.ts";
import type { HeadFacts } from "./membership-valid.ts";
import { pairStatus } from "./memberships.ts";
import type { MembershipRecord, StoredMemberships } from "./memberships.ts";
import { codeFilesUnread } from "./setup.ts";
import type { StoredRead, StoredVocabulary } from "./setup.ts";
import type { Term } from "./vocabulary.ts";

/*
 * `GET /vocabulary.json`: the stored vocabulary (see setup.ts) read against the head of a
 * comparison. The terms and where they are written are derived; which functions belong to a term is
 * judged, and is stored once for the base. A stored answer holds for the head only while
 * `recordValidity` (src/membership-valid.ts) says so: that one rule builds every number and every
 * list below, so the card, the term detail, a term's count and the names on risk entries agree. An
 * answer that does not hold is "stale", and a function the store never saw is "not judged"; neither
 * is a member, and neither is "no term". Nothing here calls a model or writes a graph fact.
 *
 * Every stored path or name is text from disk: the page shows it as text. A path or name the store
 * withheld (it was shaped like a secret) is null here.
 */

/** The most members listed under one term; the rest are counted. */
export const MAX_MEMBERS = 100;

/** A stored path is a stand-in ("/withheld:…") when a part of the real one was shaped like a secret. */
const withheldPath = (path: string): boolean => path.startsWith("/withheld:");
const shownPath = (path: string): string | null => (withheldPath(path) ? null : path);
const shownName = (name: string): string | null => (name === "withheld" ? null : name);
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const plural = (count: number, one: string): string => `${count} ${count === 1 ? one : `${one}s`}`;

/** Where a pin can be opened in the head: only a file whose text is the text the vocabulary was built from (the stored digest). Otherwise its lines may hold something else. */
function pinsOf(term: Term, head: FileTree, stored: ReadonlyMap<string, string>): DocPin[] {
  return term.pins.map((pin) => {
    const path = shownPath(pin.path);
    const base = { source: pin.source, path, range: pin.range, written: pin.written };
    if (path === null) return { ...base, why: "the path was withheld" };
    if (pin.source === "folder") return base;
    const text = head.get(path);
    if (text === undefined) return { ...base, why: "the file is not in this tree" };
    if (stored.get(pin.path) !== digestOf(text)) return { ...base, why: "the file changed since setup" };
    return { ...base, id: `file:${path}` as NodeId };
  });
}

/** What the head says of one function: a current term, no answer for it, an answer out of date, or nothing to ask. */
type Standing = { readonly kind: "with term"; readonly terms: readonly DocTermRef[] } | { readonly kind: "not judged" | "stale" | "no term" | "no candidate" };

function standingOf(unit: Unit, facts: HeadFacts, records: ReadonlyMap<string, MembershipRecord>, names: ReadonlyMap<string, string>): Standing {
  const stored = facts.storedUnits.get(unit.key);
  const held = unitValidity(stored, unit, facts.rules);
  if (!held.ok) return { kind: stored === undefined && facts.rules === undefined ? "not judged" : "stale" };
  const terms: DocTermRef[] = [];
  let stale = false;
  let unknown = stored!.cut.length > 0;
  for (const key of stored!.candidates) {
    const record = records.get(`${unit.key}\0${key}`);
    if (record === undefined) {
      unknown = true;
      continue;
    }
    if (!recordValidity(record, facts).ok) {
      stale = true;
      continue;
    }
    const status = pairStatus(record);
    if (status === "member") {
      const probability = yesOf(record.answers, "belongs");
      const name = names.get(key);
      if (probability !== undefined && name !== undefined) terms.push({ key, name, probability });
      else unknown = true;
    } else if (status === "not judged") unknown = true;
  }
  if (terms.length > 0) return { kind: "with term", terms: terms.sort((a, b) => b.probability - a.probability || byText(a.name, b.name)) };
  if (stale) return { kind: "stale" };
  if (unknown) return { kind: "not judged" };
  return { kind: stored!.candidates.length === 0 ? "no candidate" : "no term" };
}

function filesOf(units: readonly Unit[], facts: HeadFacts, memberships: StoredMemberships | undefined, names: ReadonlyMap<string, string>): DocFile[] {
  const records = new Map((memberships?.records ?? []).map((record) => [`${record.unit}\0${record.term}`, record]));
  const files = new Map<string, { counts: DocFile["units"]; best: Map<string, DocTermRef>; members: DocFile["members"][number][] }>();
  const COUNT = { "with term": "withTerm", "not judged": "notJudged", stale: "stale", "no term": "noTerm", "no candidate": "noCandidate" } as const;
  for (const unit of units) {
    const file = files.get(unit.path) ?? { counts: { total: 0, withTerm: 0, notJudged: 0, stale: 0, noTerm: 0, noCandidate: 0 }, best: new Map<string, DocTermRef>(), members: [] };
    files.set(unit.path, file);
    const standing = memberships === undefined ? ({ kind: "not judged" } as const) : standingOf(unit, facts, records, names);
    const field = COUNT[standing.kind];
    file.counts = { ...file.counts, total: file.counts.total + 1, [field]: file.counts[field] + 1 };
    if (standing.kind !== "with term") continue;
    file.members.push({ id: unit.id, terms: standing.terms });
    for (const ref of standing.terms) {
      const was = file.best.get(ref.key);
      if (was === undefined || ref.probability > was.probability) file.best.set(ref.key, ref);
    }
  }
  return [...files]
    .sort(([a], [b]) => byText(a, b))
    .map(([path, file]) => ({ path, terms: [...file.best.values()].sort((a, b) => b.probability - a.probability || byText(a.name, b.name)), units: file.counts, members: file.members }));
}

interface Tally {
  member: number;
  stale: number;
  notJudged: number;
  cut: number;
  notMember: number;
  middle: number;
  candidates: number;
}

/** A term's counts over the head's functions, from the same validity rule as everything else. A pair with no valid answer is unknown. */
function summaryOf(tally: Tally | undefined, newUnits: number, codeUnread: number, rules: string | undefined): DocTerm["summary"] {
  if (rules !== undefined) return { kind: "not known", why: "rules changed: run streets setup" };
  const one = tally ?? { member: 0, stale: 0, notJudged: 0, cut: 0, notMember: 0, middle: 0, candidates: 0 };
  if (one.member > 0) return { kind: "has members", why: [plural(one.member, "member"), one.stale > 0 ? `${one.stale} stale` : "", one.notJudged > 0 ? `${one.notJudged} not judged` : ""].filter((part) => part !== "").join(", ") };
  const unknown = [one.notJudged > 0 ? `${plural(one.notJudged, "pair")} not judged` : "", one.stale > 0 ? `${one.stale} stale` : "", one.cut > 0 ? `${plural(one.cut, "candidate")} left out by the cap` : "", newUnits > 0 ? `${plural(newUnits, "function")} the store has not seen` : "", codeUnread > 0 ? `${plural(codeUnread, "code file")} could not be read` : ""].filter((part) => part !== "");
  if (unknown.length > 0) return { kind: "not known", why: unknown.join(", ") };
  if (one.candidates === 0) return { kind: "no members", why: "no code shares a word with it" };
  if (one.middle > 0) return { kind: "no members", why: `${plural(one.middle, "candidate")} in the middle band, left unmapped${one.notMember > 0 ? `, ${one.notMember} judged not a member` : ""}` };
  return { kind: "no members", why: `all ${plural(one.candidates, "candidate")} judged not a member` };
}

function termsOf(stored: StoredVocabulary, facts: HeadFacts, head: FileTree): DocTerm[] {
  const { memberships, vocabulary } = stored;
  const records = new Map((memberships?.records ?? []).map((record) => [`${record.unit}\0${record.term}`, record]));
  const tallies = new Map<string, Tally>();
  const tally = (key: string): Tally => {
    let one = tallies.get(key);
    if (one === undefined) tallies.set(key, (one = { member: 0, stale: 0, notJudged: 0, cut: 0, notMember: 0, middle: 0, candidates: 0 }));
    return one;
  };
  const members = new Map<string, DocMember[]>();
  for (const unit of memberships?.units ?? []) {
    const headUnit = facts.headUnits.get(unit.key);
    for (const key of unit.candidates) {
      const record = records.get(`${unit.key}\0${key}`);
      const one = tally(key);
      const valid = record === undefined ? undefined : recordValidity(record, facts);
      // Only a function the head has is counted; one it lost is listed below as stale, and never counted.
      if (headUnit !== undefined) {
        one.candidates += 1;
        if (record === undefined) one.notJudged += 1;
        else if (!valid!.ok) one.stale += 1;
        else {
          const status = pairStatus(record);
          if (status === "member") one.member += 1;
          else if (status === "not a member") one.notMember += 1;
          else if (status === "middle band") one.middle += 1;
          else one.notJudged += 1;
        }
      }
      if (record === undefined || valid === undefined || !answersCover(record.answers, Object.keys(record.shown.questions)) || record.verdict !== "settled") continue;
      const probability = yesOf(record.answers, "belongs");
      if (probability === undefined) continue;
      const verdict = valid;
      const list = members.get(key) ?? [];
      members.set(key, list);
      list.push({
        path: shownPath(unit.path),
        name: shownName(unit.name),
        level: unit.level,
        probability,
        state: verdict.ok ? "member" : "stale",
        ...(verdict.ok ? {} : { why: verdict.why }),
        ...(headUnit === undefined ? {} : { id: headUnit.id }),
      });
    }
    if (headUnit !== undefined) for (const key of unit.cut) tally(key).cut += 1;
  }
  const newUnits = [...facts.headUnits.keys()].filter((key) => !facts.storedUnits.has(key)).length;
  const codeUnread = codeFilesUnread(vocabulary);
  return vocabulary.terms.map((term) => {
    const all = (members.get(term.key) ?? []).sort((a, b) => Number(b.state === "member") - Number(a.state === "member") || b.probability - a.probability || byText(a.path ?? "", b.path ?? "") || byText(a.name ?? "", b.name ?? ""));
    const omitted = all.length - MAX_MEMBERS;
    return {
      key: term.key,
      name: term.name,
      summary: memberships === undefined ? { kind: "not known" as const, why: "not judged" } : summaryOf(tallies.get(term.key), newUnits, codeUnread, facts.rules),
      pins: pinsOf(term, head, new Map(Object.entries(stored.files))),
      members: all.slice(0, MAX_MEMBERS),
      ...(omitted > 0 ? { membersOmitted: omitted } : {}),
    };
  });
}

/** The document for the head's tree. `read` is what the store held (nothing, a file that cannot be trusted, or the vocabulary). */
export function vocabularyDocument(read: StoredRead | undefined, head: { readonly graph: Graph; readonly tree: FileTree }): VocabularyDoc {
  if (read === undefined || read.kind === "missing") return { tier: "derived", state: "none", judged: false, terms: [], withheldPaths: 0, files: [] };
  if (read.kind === "unreadable") return { tier: "derived", state: "unreadable", why: read.why, judged: false, terms: [], withheldPaths: 0, files: [] };
  const { stored } = read;
  const units = unitsOf(head.graph, head.tree);
  const termByKey = new Map(stored.vocabulary.terms.map((term) => [term.key, term]));
  const digests = new Map<string, string>();
  const rules = rulesChanged({ extractorVersion: stored.extractorVersion, tableVersion: stored.vocabulary.tableVersion, ...(stored.memberships === undefined ? {} : { memberships: stored.memberships }) });
  const facts: HeadFacts = {
    rules,
    headUnits: new Map(units.map((unit) => [unit.key, unit])),
    storedUnits: new Map((stored.memberships?.units ?? []).map((unit) => [unit.key, unit])),
    termDigestOf: (key) => {
      const term = termByKey.get(key);
      if (term === undefined) return undefined;
      let digest = digests.get(key);
      if (digest === undefined) digests.set(key, (digest = termDigest(term, head.tree)));
      return digest;
    },
  };
  const names = new Map(stored.vocabulary.terms.map((term) => [term.key, term.name]));
  return {
    tier: "derived",
    state: "stored",
    ...(rules === undefined ? {} : { rules }),
    built: stored.base,
    termsStatus: stored.vocabulary.status,
    ...(stored.vocabulary.reason === undefined ? {} : { reason: stored.vocabulary.reason }),
    judged: stored.memberships !== undefined,
    ...(stored.memberships === undefined ? {} : { model: stored.memberships.model }),
    terms: termsOf(stored, facts, head.tree),
    withheldPaths: stored.pathsWithheld,
    files: filesOf(units, facts, stored.memberships, names),
  };
}
