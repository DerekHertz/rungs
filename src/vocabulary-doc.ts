import { EXTRACTOR_VERSION } from "./extract/extract.ts";
import type { DocFile, DocMember, DocPin, DocTerm, DocTermRef, VocabularyDoc } from "./file-card.ts";
import type { FileTree, Graph } from "./graph.ts";
import { yesOf } from "./jev/gate.ts";
import { unitsOf } from "./jev/membership-source.ts";
import type { Unit } from "./jev/membership-source.ts";
import { pairStatus, summarize } from "./memberships.ts";
import type { MembershipRecord, StoredMemberships, StoredUnit } from "./memberships.ts";
import { codeFilesUnread } from "./setup.ts";
import type { StoredRead } from "./setup.ts";
import { VOCABULARY_TABLE_VERSION } from "./vocabulary-table.ts";
import type { Term } from "./vocabulary.ts";

/*
 * `GET /vocabulary.json`: the stored vocabulary (see setup.ts) read against the head of a
 * comparison. The terms and where they are written are derived; which functions belong to a term is
 * judged, and is stored once for the base. A function the change edited, or one the store never saw,
 * has no current answer for the head: it is "stale" or "not judged", and never "no term" and never a
 * member. Nothing here calls a model or writes a graph fact.
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

const rulesNote = (read: Extract<StoredRead, { kind: "ok" }>): string | undefined => {
  const { tableVersion } = read.stored.vocabulary;
  if (tableVersion !== VOCABULARY_TABLE_VERSION) return `table ${tableVersion}, this version uses ${VOCABULARY_TABLE_VERSION}`;
  if (read.stored.extractorVersion !== EXTRACTOR_VERSION) return `extractor ${read.stored.extractorVersion}, this version uses ${EXTRACTOR_VERSION}`;
  return undefined;
};

/** What the head's text and the base's text say about the file a pin was read from. */
function pinsOf(term: Term, head: FileTree, base: FileTree): DocPin[] {
  return term.pins.map((pin) => {
    const path = shownPath(pin.path);
    const openable = path !== null && pin.source !== "folder" && head.has(path) && head.get(path) === base.get(path);
    return { source: pin.source, path, range: pin.range, written: pin.written, ...(openable ? { id: `file:${path}` as DocPin["id"] } : {}) };
  });
}

/** A record's probability that the code belongs to the term, or undefined when the answer cannot be read. */
const belongsOf = (record: MembershipRecord): number | undefined => yesOf(record.answers, "belongs");

interface MemberFacts {
  readonly state: DocMember["state"];
  readonly why?: string;
}

/** Whether a record that was a member for the base still is for the head. */
function currentFor(record: MembershipRecord, head: Unit | undefined): MemberFacts | undefined {
  const status = pairStatus(record);
  if (status === "stale") return { state: "stale", why: record.stale ?? "stale" };
  if (status !== "member") return undefined;
  if (head === undefined) return { state: "stale", why: "not in this tree" };
  if (head.digest !== record.digest) return { state: "stale", why: "the function changed" };
  return { state: "member" };
}

/** The unit's standing in the head: a current term, no answer for it, an out-of-date answer, or judged with none. */
type UnitStanding = { readonly kind: "with term"; readonly terms: readonly DocTermRef[] } | { readonly kind: "not judged" | "stale" | "no term" };

function standingOf(unit: Unit, stored: StoredUnit | undefined, records: ReadonlyMap<string, MembershipRecord>, names: ReadonlyMap<string, string>): UnitStanding {
  if (stored === undefined) return { kind: "not judged" };
  if (stored.digest !== unit.digest) return { kind: "stale" };
  const terms: DocTermRef[] = [];
  let stale = false;
  let unknown = stored.cut.length > 0;
  for (const key of stored.candidates) {
    const record = records.get(`${unit.key}\0${key}`);
    const status = pairStatus(record);
    if (status === "member") {
      const probability = belongsOf(record!);
      const name = names.get(key);
      if (probability !== undefined && name !== undefined) terms.push({ key, name, probability });
      else unknown = true;
    } else if (status === "stale") stale = true;
    else if (status === "not judged") unknown = true;
  }
  if (terms.length > 0) return { kind: "with term", terms: terms.sort((a, b) => b.probability - a.probability || byText(a.name, b.name)) };
  return { kind: stale ? "stale" : unknown ? "not judged" : "no term" };
}

function filesOf(units: readonly Unit[], memberships: StoredMemberships | undefined, names: ReadonlyMap<string, string>): DocFile[] {
  const byKey = new Map((memberships?.units ?? []).map((unit) => [unit.key, unit]));
  const records = new Map((memberships?.records ?? []).map((record) => [`${record.unit}\0${record.term}`, record]));
  const files = new Map<string, { counts: DocFile["units"]; best: Map<string, DocTermRef>; members: DocFile["members"][number][] }>();
  for (const unit of units) {
    const file = files.get(unit.path) ?? { counts: { total: 0, withTerm: 0, notJudged: 0, stale: 0, noTerm: 0 }, best: new Map<string, DocTermRef>(), members: [] };
    files.set(unit.path, file);
    const standing = memberships === undefined ? ({ kind: "not judged" } as const) : standingOf(unit, byKey.get(unit.key), records, names);
    const c = file.counts;
    file.counts = { ...c, total: c.total + 1, ...(standing.kind === "with term" ? { withTerm: c.withTerm + 1 } : standing.kind === "not judged" ? { notJudged: c.notJudged + 1 } : standing.kind === "stale" ? { stale: c.stale + 1 } : { noTerm: c.noTerm + 1 }) };
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

function termsOf(stored: Extract<StoredRead, { kind: "ok" }>["stored"], headUnits: ReadonlyMap<string, Unit>, head: FileTree, base: FileTree): DocTerm[] {
  const { memberships, vocabulary } = stored;
  const summaries = new Map(memberships === undefined ? [] : summarize(memberships, vocabulary.terms, codeFilesUnread(vocabulary)).terms.map((term) => [term.key, term]));
  const storedUnits = new Map((memberships?.units ?? []).map((unit) => [unit.key, unit]));
  const members = new Map<string, DocMember[]>();
  for (const record of memberships?.records ?? []) {
    const unit = storedUnits.get(record.unit);
    const probability = belongsOf(record);
    const headUnit = headUnits.get(record.unit);
    const facts = currentFor(record, headUnit);
    if (unit === undefined || probability === undefined || facts === undefined) continue;
    const list = members.get(record.term) ?? [];
    members.set(record.term, list);
    list.push({ path: shownPath(unit.path), name: shownName(unit.name), level: unit.level, probability, state: facts.state, ...(facts.why === undefined ? {} : { why: facts.why }), ...(headUnit === undefined ? {} : { id: headUnit.id }) });
  }
  return vocabulary.terms.map((term) => {
    const all = (members.get(term.key) ?? []).sort((a, b) => b.probability - a.probability || byText(a.path ?? "", b.path ?? "") || byText(a.name ?? "", b.name ?? ""));
    const summary = summaries.get(term.key);
    const omitted = all.length - MAX_MEMBERS;
    return {
      key: term.key,
      name: term.name,
      summary: summary === undefined ? { kind: "not known" as const, why: "not judged" } : { kind: summary.kind, why: summary.why },
      pins: pinsOf(term, head, base),
      members: all.slice(0, MAX_MEMBERS),
      ...(omitted > 0 ? { membersOmitted: omitted } : {}),
    };
  });
}

/** The document for the head's tree. `read` is what the store held (nothing, a file that cannot be trusted, or the vocabulary). */
export function vocabularyDocument(read: StoredRead | undefined, head: { readonly graph: Graph; readonly tree: FileTree }, baseTree: FileTree): VocabularyDoc {
  if (read === undefined || read.kind === "missing") return { tier: "derived", state: "none", judged: false, terms: [], withheldPaths: 0, files: [] };
  if (read.kind === "unreadable") return { tier: "derived", state: "unreadable", why: read.why, judged: false, terms: [], withheldPaths: 0, files: [] };
  const { stored } = read;
  const units = unitsOf(head.graph, head.tree);
  const headUnits = new Map(units.map((unit) => [unit.key, unit]));
  const names = new Map(stored.vocabulary.terms.map((term) => [term.key, term.name]));
  const rules = rulesNote(read);
  return {
    tier: "derived",
    state: "stored",
    ...(rules === undefined ? {} : { rules }),
    built: stored.base,
    termsStatus: stored.vocabulary.status,
    ...(stored.vocabulary.reason === undefined ? {} : { reason: stored.vocabulary.reason }),
    judged: stored.memberships !== undefined,
    ...(stored.memberships === undefined ? {} : { model: stored.memberships.model }),
    terms: termsOf(stored, headUnits, head.tree, baseTree),
    withheldPaths: stored.pathsWithheld,
    files: filesOf(units, stored.memberships, names),
  };
}
