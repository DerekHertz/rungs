import { basename } from "node:path";
import { certificationOf, combine, effectOf, noLongerApply, pairKeyOf, shownCertification, describeCorrection } from "./corrections.ts";
import type { Effect, PairCorrection, Part } from "./corrections.ts";
import { digestOf } from "./extract/extract.ts";
import type { DocFile, DocMember, DocPin, DocStamp, DocTerm, DocTermRef, VocabularyDoc } from "./file-card.ts";
import type { FileTree, Graph, NodeId } from "./graph.ts";
import { yesOf } from "./jev/gate.ts";
import { termDigest, unitsOf } from "./jev/membership-source.ts";
import type { Unit } from "./jev/membership-source.ts";
import { answersCover } from "./jev/membership-gate.ts";
import { recordValidity, rulesChanged, unitValidity } from "./membership-valid.ts";
import type { HeadFacts, Validity } from "./membership-valid.ts";
import { pairStatus } from "./memberships.ts";
import type { MembershipRecord, PairStatus, StoredMemberships, StoredUnit } from "./memberships.ts";
import { codeFilesUnread } from "./setup.ts";
import type { StoredRead, StoredVocabulary } from "./setup.ts";
import { shown } from "./stored-names.ts";
import type { Term } from "./vocabulary.ts";
import { NON_CODE_EXTENSIONS, NON_CODE_NAMES } from "./vocabulary-table.ts";

/*
 * `GET /vocabulary.json`: the stored vocabulary (see setup.ts) read against the head of a
 * comparison. The terms and where they are written are derived; which functions belong to a term is
 * judged, and is stored once for the base. A stored answer holds for the head only while
 * `recordValidity` (src/membership-valid.ts) says so: that one rule builds every number and every
 * list below, so the card, the term detail, a term's count and the names on risk entries agree. An
 * answer that does not hold is "stale", and a function the store never saw is "not judged"; neither
 * is a member, and neither is "no term". Nothing here calls a model or writes a graph fact.
 *
 * A person's corrections (src/corrections.ts) are read through the same views and win over judged
 * answers: a corrected pair is a member or not whatever the judged record says (and whether or not
 * the function changed since: a correction is keyed on the function, not on its digest), a removed
 * term is not here, a merged term's members are the union of its sources', and a renamed term has
 * its new name. A correction with nothing to apply to is listed, never dropped. On a pair a person
 * corrected directly, that correction beats what the pair inherits by a merge.
 *
 * Every stored path or name is text from disk: the page shows it as text. A path or name the store
 * withheld (it was shaped like a secret) is null here, and a name a person wrote that is shaped like
 * a secret is "withheld".
 */

/** The most members listed under one term; the rest are counted. */
export const MAX_MEMBERS = 100;

/** A stored path is a stand-in ("/withheld:…") when a part of the real one was shaped like a secret. */
const withheldPath = (path: string): boolean => path.startsWith("/withheld:");
const shownPath = (path: string): string | null => (withheldPath(path) ? null : path);
const shownName = (name: string): string | null => (name === "withheld" ? null : name);
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const plural = (count: number, one: string): string => `${count} ${count === 1 ? one : `${one}s`}`;
const stampOf = (one: PairCorrection | { readonly by: string; readonly at: string }): DocStamp => ({ by: shown(one.by), at: one.at });

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

/** What the head offers and what a person said, for reading a pair. */
interface Ctx {
  readonly facts: HeadFacts;
  readonly records: ReadonlyMap<string, MembershipRecord>;
  readonly effect: Effect;
  /** The corrections of pairs whose function the head has: a correction about a function the tree lacks is reported, and counts for nothing. */
  readonly live: ReadonlyMap<string, PairCorrection>;
  /** The terms (as the person named them) corrected for each function in `live`. */
  readonly liveTerms: ReadonlyMap<string, readonly string[]>;
  /** A visible term's name. */
  readonly names: ReadonlyMap<string, string>;
}

/** One stored judged answer for one pair, read by the shared validity rule. */
interface Judged {
  readonly status: PairStatus;
  readonly why: string | undefined;
  /** Set for an answer that says "member" (a settled record), valid or not: its probability, and whether it holds. */
  readonly settled?: { readonly probability: number; readonly valid: Validity };
}

function judgedOf(unit: string, term: string, ctx: Ctx): Judged {
  const record = ctx.records.get(pairKeyOf(unit, term));
  if (record === undefined) return { status: "not judged", why: undefined };
  const valid = recordValidity(record, ctx.facts);
  const probability = answersCover(record.answers, Object.keys(record.shown.questions)) && record.verdict === "settled" ? yesOf(record.answers, "belongs") : undefined;
  const settled = probability === undefined ? {} : { settled: { probability, valid } };
  if (!valid.ok) return { status: "stale", why: valid.why, ...settled };
  const status = pairStatus(record);
  // A member with no readable probability is unknown, never a member.
  return { status: status === "member" && probability === undefined ? "not judged" : status, why: undefined, ...settled };
}

/** What is known of one function and one visible term: judged answers of every term merged into it, and a person's corrections. */
interface View {
  readonly status: PairStatus;
  /** Why each stale answer is stale. */
  readonly why: readonly string[];
  /** A person's yes that makes it a member, or a person's no on this very pair: it decides, whatever the judged record says. */
  readonly corrected?: PairCorrection;
  /** The best settled judged answer behind the pair (valid ones first). */
  readonly settled?: { readonly probability: number; readonly valid: Validity };
  /** A person's no covers a judged member. */
  readonly away: boolean;
}

function viewOf(unit: string, key: string, asked: ReadonlySet<string>, ctx: Ctx): View | undefined {
  const sources = ctx.effect.sources(key);
  const direct = ctx.live.get(pairKeyOf(unit, key));
  const parts: Part[] = [];
  const settled: NonNullable<Judged["settled"]>[] = [];
  let away = false;
  for (const source of sources) {
    const said = ctx.live.get(pairKeyOf(unit, source));
    const judged = asked.has(source) ? judgedOf(unit, source, ctx) : undefined;
    if (judged?.settled !== undefined) {
      settled.push(judged.settled);
      if (said !== undefined && !said.belongs) away = true;
    }
    if (said !== undefined) parts.push({ status: said.belongs ? "member" : "not a member", said });
    else if (judged !== undefined) parts.push({ status: judged.status, ...(judged.why === undefined ? {} : { why: judged.why }) });
  }
  if (parts.length === 0) return undefined;
  const best = settled.slice().sort((a, b) => Number(b.valid.ok) - Number(a.valid.ok) || b.probability - a.probability)[0];
  const common = { ...(best === undefined ? {} : { settled: best }), away };
  const { status, corrected } = combine(direct, parts);
  // On the pair itself, a person's word beats what it inherits from a merged term.
  if (direct !== undefined) return { status, why: [], corrected: direct, ...common, away: away || (!direct.belongs && best !== undefined) };
  return { status, why: parts.flatMap((part) => (part.status === "stale" && part.why !== undefined ? [part.why] : [])), ...(corrected === undefined ? {} : { corrected }), ...common };
}

/** The views of one function: one for each visible term it has a candidate or a correction for. */
function viewsOf(unit: string, stored: StoredUnit | undefined, ctx: Ctx): Map<string, View> {
  const asked = new Set(stored?.candidates ?? []);
  const keys = new Set<string>();
  for (const key of [...asked, ...(ctx.liveTerms.get(unit) ?? [])]) {
    const visible = ctx.effect.resolve(key);
    if (visible !== undefined) keys.add(visible);
  }
  const views = new Map<string, View>();
  for (const key of keys) {
    const view = viewOf(unit, key, asked, ctx);
    if (view !== undefined) views.set(key, view);
  }
  return views;
}

/** A pair a person corrected is not left unknown by a cap that cut it from the questions. */
const stillCut = (unit: string, key: string, ctx: Ctx): boolean => {
  const visible = ctx.effect.resolve(key);
  return visible !== undefined && !ctx.live.has(pairKeyOf(unit, key)) && !ctx.live.has(pairKeyOf(unit, visible));
};

/** Corrected members first, then the strongest judged answer, then the name. */
const refOrder = (a: DocTermRef, b: DocTermRef): number => Number(b.corrected !== undefined) - Number(a.corrected !== undefined) || (b.probability ?? 0) - (a.probability ?? 0) || byText(a.name, b.name);

function refOf(key: string, view: View, ctx: Ctx): DocTermRef {
  const name = ctx.names.get(key) ?? key;
  if (view.corrected?.belongs === true) return { key, name, probability: null, corrected: stampOf(view.corrected) };
  return { key, name, probability: view.settled?.probability ?? 0 };
}

/** What the head says of one function: a current term, no answer for it, an answer out of date, or nothing to ask. */
type Standing = { readonly kind: "with term"; readonly terms: readonly DocTermRef[] } | { readonly kind: "stale"; readonly why: readonly string[] } | { readonly kind: "not judged" | "no term" | "no candidate" };

function standingOf(unit: Unit, ctx: Ctx): Standing {
  const { facts } = ctx;
  const stored = facts.storedUnits.get(unit.key);
  const held = unitValidity(stored, unit, facts.rules);
  const terms: DocTermRef[] = [];
  const why = new Set<string>();
  let unknown = false;
  const views = viewsOf(unit.key, stored, ctx);
  for (const [key, view] of views) {
    if (view.status === "member") terms.push(refOf(key, view, ctx));
    else if (view.status === "stale") for (const reason of view.why) why.add(reason);
    else if (view.status === "not judged") unknown = true;
  }
  if (terms.length > 0) return { kind: "with term", terms: terms.sort(refOrder) };
  if (!held.ok) return stored === undefined && facts.rules === undefined ? { kind: "not judged" } : { kind: "stale", why: [held.why] };
  if (stored!.cut.some((key) => stillCut(unit.key, key, ctx))) unknown = true;
  if (why.size > 0) return { kind: "stale", why: [...why] };
  if (unknown) return { kind: "not judged" };
  return { kind: views.size === 0 ? "no candidate" : "no term" };
}

type Unread = ReadonlyMap<string, "no adapter" | "could not be read">;

/** The head's code files that are not read: no adapter reads their language, or a syntax error stopped the extractor. Data, media and plain repository files are not code, so they are not listed. */
export function unreadOf(graph: Graph): Map<string, "no adapter" | "could not be read"> {
  const found = new Map<string, "no adapter" | "could not be read">();
  for (const node of graph.nodes) {
    if (node.level !== "file" || node.analysis === "analysed") continue;
    const name = basename(node.path).toLowerCase();
    // Markdown is read for its headings, and package.json for its manifest, whatever the extractor says of their code.
    if (name.endsWith(".md")) continue;
    if (node.analysis === "not fully read") {
      if (name !== "package.json") found.set(node.path, "could not be read");
    } else if (!NON_CODE_EXTENSIONS.some((extension) => name.endsWith(extension)) && !NON_CODE_NAMES.includes(name)) found.set(node.path, "no adapter");
  }
  return found;
}

function filesOf(units: readonly Unit[], ctx: Ctx, memberships: StoredMemberships | undefined, unread: Unread): DocFile[] {
  const files = new Map<string, { counts: DocFile["units"]; best: Map<string, DocTermRef>; members: DocFile["members"][number][]; why: Set<string> }>();
  const COUNT = { "with term": "withTerm", "not judged": "notJudged", stale: "stale", "no term": "noTerm", "no candidate": "noCandidate" } as const;
  for (const unit of units) {
    const file = files.get(unit.path) ?? { counts: { total: 0, withTerm: 0, notJudged: 0, stale: 0, noTerm: 0, noCandidate: 0 }, best: new Map<string, DocTermRef>(), members: [], why: new Set<string>() };
    files.set(unit.path, file);
    const standing = memberships === undefined && ctx.live.size === 0 ? ({ kind: "not judged" } as const) : standingOf(unit, ctx);
    const field = COUNT[standing.kind];
    file.counts = { ...file.counts, total: file.counts.total + 1, [field]: file.counts[field] + 1 };
    if (standing.kind === "stale") for (const why of standing.why) file.why.add(why);
    if (standing.kind !== "with term") continue;
    file.members.push({ id: unit.id, terms: standing.terms });
    for (const ref of standing.terms) {
      const was = file.best.get(ref.key);
      if (was === undefined || refOrder(ref, was) < 0) file.best.set(ref.key, ref);
    }
  }
  const made: DocFile[] = [...files].map(([path, file]) => ({
    path,
    terms: [...file.best.values()].sort(refOrder),
    units: file.counts,
    members: file.members,
    ...(file.why.size === 0 ? {} : { staleWhy: [...file.why].sort(byText) }),
  }));
  // A file whose code is not read has no function to judge, and that is not "no function": its terms are not known.
  for (const [path, why] of unread) if (!files.has(path)) made.push({ path, terms: [], units: { total: 0, withTerm: 0, notJudged: 0, stale: 0, noTerm: 0, noCandidate: 0 }, members: [], unread: why });
  return made.sort((a, b) => byText(a.path, b.path));
}

interface Tally {
  member: number;
  stale: number;
  notJudged: number;
  cut: number;
  notMember: number;
  /** Pairs a person corrected to "not a member". */
  correctedNo: number;
  middle: number;
  candidates: number;
  /** Judged members the head has no function for. */
  lost: number;
  /** Judged members the head has no function for because their file could not be read. */
  lostUnread: number;
}

const emptyTally = (): Tally => ({ member: 0, stale: 0, notJudged: 0, cut: 0, notMember: 0, correctedNo: 0, middle: 0, candidates: 0, lost: 0, lostUnread: 0 });

/** A term's counts over the head's functions, from the same validity rule as everything else. A pair with no valid answer is unknown. */
interface Unknowns {
  /** Functions the head has that the store never saw. */
  readonly newUnits: number;
  /** Code files the vocabulary was built without (see codeFilesUnread). */
  readonly codeUnread: number;
  /** Code files of the head that are not read. */
  readonly headUnread: number;
}

function summaryOf(tally: Tally | undefined, unknowns: Unknowns, rules: string | undefined): DocTerm["summary"] {
  const { newUnits, codeUnread, headUnread } = unknowns;
  if (rules !== undefined) return { kind: "not known", why: "rules changed: run streets setup" };
  const one = tally ?? emptyTally();
  if (one.member > 0) return { kind: "has members", why: [plural(one.member, "member"), one.stale > 0 ? `${one.stale} stale` : "", one.notJudged > 0 ? `${one.notJudged} not judged` : ""].filter((part) => part !== "").join(", ") };
  const unknown = [one.notJudged > 0 ? `${plural(one.notJudged, "pair")} not judged` : "", one.stale > 0 ? `${one.stale} stale` : "", one.cut > 0 ? `${plural(one.cut, "candidate")} left out by the cap` : "", one.lost > 0 ? `${plural(one.lost, "stored member")} not in this tree` : "", one.lostUnread > 0 ? `${plural(one.lostUnread, "stored member")} whose file could not be read` : "", newUnits > 0 ? `${plural(newUnits, "function")} the store has not seen` : "", codeUnread > 0 ? `${plural(codeUnread, "code file")} could not be read when the vocabulary was built` : "", headUnread > 0 ? `${plural(headUnread, "code file")} in this tree could not be read` : ""].filter((part) => part !== "");
  if (unknown.length > 0) return { kind: "not known", why: unknown.join(", ") };
  if (one.candidates === 0) return { kind: "no members", why: "no code shares a word with it" };
  const corrected = one.correctedNo > 0 ? `${plural(one.correctedNo, "candidate")} corrected as not a member` : "";
  if (one.middle > 0) return { kind: "no members", why: `${plural(one.middle, "candidate")} in the middle band, left unmapped${one.notMember > 0 ? `, ${one.notMember} judged not a member` : ""}${corrected === "" ? "" : `, ${corrected}`}` };
  if (one.correctedNo > 0) return { kind: "no members", why: `${one.notMember > 0 ? `${one.notMember} judged not a member, ` : ""}${corrected}` };
  return { kind: "no members", why: `all ${plural(one.candidates, "candidate")} judged not a member` };
}

/** Corrected members first, then members that hold before stale ones, then the strongest answer. */
const memberOrder = (a: DocMember, b: DocMember): number =>
  Number(b.state === "member") - Number(a.state === "member") || Number(b.corrected !== undefined) - Number(a.corrected !== undefined) || (b.probability ?? 0) - (a.probability ?? 0) || byText(a.path ?? "", b.path ?? "") || byText(a.name ?? "", b.name ?? "");

function termsOf(stored: StoredVocabulary, ctx: Ctx, head: FileTree, unread: Unread): DocTerm[] {
  const { memberships, vocabulary } = stored;
  const { facts, effect } = ctx;
  const tallies = new Map<string, Tally>();
  const tally = (key: string): Tally => {
    let one = tallies.get(key);
    if (one === undefined) tallies.set(key, (one = emptyTally()));
    return one;
  };
  const members = new Map<string, DocMember[]>();
  const away = new Map<string, number>();
  // The functions the store judged, and the ones only a person's correction speaks of.
  const keys = [...(memberships?.units ?? []).map((unit) => unit.key), ...[...ctx.liveTerms.keys()].filter((key) => !facts.storedUnits.has(key))];
  for (const unitKey of keys) {
    const unit = facts.storedUnits.get(unitKey);
    const headUnit = facts.headUnits.get(unitKey);
    const who = unit ?? headUnit!;
    const path = unit?.path ?? headUnit!.storedPath;
    const name = unit?.name ?? headUnit!.storedName;
    for (const [key, view] of viewsOf(unitKey, unit, ctx)) {
      const one = tally(key);
      // Only a function the head has is counted; one it lost is listed below as stale, and never counted.
      if (headUnit !== undefined) {
        one.candidates += 1;
        if (view.status === "member") one.member += 1;
        else if (view.status === "stale") one.stale += 1;
        else if (view.status === "not judged") one.notJudged += 1;
        else if (view.status === "middle band") one.middle += 1;
        else if (view.corrected !== undefined) one.correctedNo += 1;
        else one.notMember += 1;
      }
      if (view.away) away.set(key, (away.get(key) ?? 0) + 1);
      const list = members.get(key) ?? [];
      members.set(key, list);
      if (view.corrected?.belongs === true) list.push({ path: shownPath(path), name: shownName(name), level: who.level, probability: null, corrected: stampOf(view.corrected), state: "member", id: headUnit!.id });
      else if (view.corrected === undefined && view.settled !== undefined) {
        // A judged member the head has no function for may be gone, or its file may not be read: either way the term is not known to lack members.
        if (headUnit === undefined) one[unread.has(path) ? "lostUnread" : "lost"] += 1;
        const { probability, valid } = view.settled;
        list.push({ path: shownPath(path), name: shownName(name), level: who.level, probability, state: valid.ok ? "member" : "stale", ...(valid.ok ? {} : { why: valid.why }), ...(headUnit === undefined ? {} : { id: headUnit.id }) });
      }
    }
    if (headUnit !== undefined && unit !== undefined) for (const key of unit.cut) if (stillCut(unitKey, key, ctx)) tally(effect.resolve(key)!).cut += 1;
  }
  const newUnits = [...facts.headUnits.keys()].filter((key) => !facts.storedUnits.has(key)).length;
  const unknowns: Unknowns = { newUnits, codeUnread: codeFilesUnread(vocabulary), headUnread: unread.size };
  const pins = new Map(Object.entries(stored.files));
  const termByKey = new Map(vocabulary.terms.map((term) => [term.key, term]));
  return [...effect.visible.values()].map((visible) => {
    const all = (members.get(visible.key) ?? []).sort(memberOrder);
    const left = all.slice(MAX_MEMBERS);
    const omitted = { current: left.filter((member) => member.state === "member").length, stale: left.filter((member) => member.state === "stale").length };
    const own = tallies.get(visible.key);
    return {
      key: visible.key,
      name: shown(visible.name),
      summary: memberships === undefined && (own?.member ?? 0) === 0 ? { kind: "not known" as const, why: "not judged" } : summaryOf(own, unknowns, facts.rules),
      pins: effect.sources(visible.key).flatMap((source) => pinsOf(termByKey.get(source)!, head, pins)),
      members: all.slice(0, MAX_MEMBERS),
      ...(left.length > 0 ? { membersOmitted: omitted } : {}),
      ...(visible.confirmed === undefined ? {} : { confirmed: stampOf(visible.confirmed) }),
      ...(visible.renamedFrom === undefined ? {} : { renamedFrom: shown(visible.renamedFrom) }),
      ...(visible.mergedFrom === undefined ? {} : { mergedFrom: visible.mergedFrom.map(shown) }),
      ...((away.get(visible.key) ?? 0) > 0 ? { correctedAway: away.get(visible.key)! } : {}),
    };
  });
}

/** The document for the head's tree. `read` is what the store held (nothing, a file that cannot be trusted, or the vocabulary). */
export function vocabularyDocument(read: StoredRead | undefined, head: { readonly graph: Graph; readonly tree: FileTree }): VocabularyDoc {
  if (read === undefined || read.kind === "missing") return { tier: "derived", state: "none", judged: false, terms: [], withheldPaths: 0, files: [] };
  if (read.kind === "unreadable") return { tier: "derived", state: "unreadable", why: read.why, judged: false, terms: [], withheldPaths: 0, files: [] };
  const { stored } = read;
  const units = unitsOf(head.graph, head.tree);
  const unread = unreadOf(head.graph);
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
  const corrections = stored.corrections ?? [];
  const effect = effectOf(stored.vocabulary.terms, corrections);
  const live = new Map([...effect.pairs].filter(([, pair]) => facts.headUnits.has(pair.unit)));
  const liveTerms = new Map<string, string[]>();
  for (const pair of live.values()) liveTerms.set(pair.unit, [...(liveTerms.get(pair.unit) ?? []), pair.term]);
  const ctx: Ctx = {
    facts,
    records: new Map((stored.memberships?.records ?? []).map((record) => [pairKeyOf(record.unit, record.term), record])),
    effect,
    live,
    liveTerms,
    names: new Map([...effect.visible].map(([key, term]) => [key, shown(term.name)])),
  };
  return {
    tier: "derived",
    state: "stored",
    ...(rules === undefined ? {} : { rules }),
    built: stored.base,
    termsStatus: stored.vocabulary.status,
    ...(stored.vocabulary.reason === undefined ? {} : { reason: stored.vocabulary.reason }),
    judged: stored.memberships !== undefined,
    ...(stored.memberships === undefined ? {} : { model: stored.memberships.model }),
    terms: termsOf(stored, ctx, head.tree, unread),
    certification: shownCertification(certificationOf(stored.vocabulary.terms, corrections, stored.certification)),
    corrections: { count: corrections.length, noLongerApply: noLongerApply(effect, corrections, new Set(facts.headUnits.keys())).map((one) => ({ text: describeCorrection(one.correction), why: one.why, ...stampOf(one.correction) })) },
    withheldPaths: stored.pathsWithheld,
    files: filesOf(units, ctx, stored.memberships, unread),
  };
}
