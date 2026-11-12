import { createHash } from "node:crypto";
import type { CodeNode, FileTree, Graph, LineRange, NodeId } from "../graph.ts";
import { isCodeNode } from "../graph.ts";
import { splitLines } from "../lines.ts";
import type { MembershipRecord } from "../memberships.ts";
import { WITHHELD, cap, looksSecret, promptName } from "../prompt-safe.ts";
import { standIn, storedPath } from "../stored-names.ts";
import { isFillerStem, keyOf, stem, wordsOf } from "../vocabulary.ts";
import type { Term, TermPin } from "../vocabulary.ts";
import { judge } from "./client.ts";
import type { JevClient } from "./client.ts";
import { safeClip } from "./claim-source.ts";
import { requestFor } from "./gate.ts";
import type { Thresholds } from "./gate.ts";
import { MAX_CODE_LINES, MAX_CONTEXT_LINES, MAX_DOC_LINES, MAX_TERM_PINS, MEMBERSHIP_THRESHOLDS, answersCover, membershipGate } from "./membership-gate.ts";
import type { MembershipInput, TermFacts, TermPinFacts, UnitFacts } from "./membership-gate.ts";

/*
 * What the membership gate is given and how code picks it. Nothing here writes a graph fact: a
 * mapping is a judged record kept apart, and a unit is read from the graph, never changed. Every
 * piece of text that can reach Jev is made prompt-safe here (see prompt-safe.ts and claim-source.ts):
 * secret-shaped text withheld, URLs cut to their host, long lines clipped, paths with a secret-shaped
 * part withheld.
 */

/**
 * The version of the narrowing rule below. Raise it when the rule changes: a stored mapping says
 * which rule picked its pair. Narrowing only decides which pairs are asked, so a changed rule does
 * not make an answer already given untrue.
 */
export const NARROWING_VERSION = 1;
/** The most terms asked about one unit. The rest are listed as cut, never dropped silently. */
export const MAX_CANDIDATES = 5;
/** The most pairs asked in one run; the rest are counted as not asked. */
export const MAX_PAIRS = 10_000;

export type UnitLevel = "function" | "class" | "constant";

/** One function, class or constant at the top level of an analysed file: what a membership is about. */
export interface Unit {
  /** Stable and storable: the node's id, or a stand-in when its path or name is shaped like a secret. */
  readonly key: string;
  readonly id: NodeId;
  readonly path: string;
  /** The path as the store keeps it (see storedPath). */
  readonly storedPath: string;
  /** The qualified name. */
  readonly name: string;
  /** The name as the store keeps it: "withheld" when it is shaped like a secret. */
  readonly storedName: string;
  readonly level: UnitLevel;
  /** The declaration's digest: a mapping is stale when this changes. */
  readonly digest: string;
  readonly range: LineRange;
  readonly signature: string;
}

/** A callback the extractor names by its callee (`"map() callback"`): not a unit, it has no name of its own. */
const isCallback = (qualifiedName: string): boolean => / callback"(?:@\d+)?$/.test(qualifiedName);

/**
 * The units of a graph: the functions, classes and exported constants written at the top level of
 * an analysed file that is not generated, other than callbacks. A method, a nested function and a
 * callback are part of the unit that holds them (the declaration's digest covers its children).
 */
export function unitsOf(graph: Graph, tree: FileTree): Unit[] {
  const eligible = new Set<NodeId>();
  for (const node of graph.nodes) if (node.level === "file" && node.analysis === "analysed" && node.role !== "generated" && tree.has(node.path)) eligible.add(node.id);
  const units: Unit[] = [];
  for (const node of graph.nodes) {
    if (!isCodeNode(node) || !eligible.has(node.parent) || isCallback(node.qualifiedName)) continue;
    units.push(unitOf(node));
  }
  return units.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function unitOf(node: CodeNode): Unit {
  const secret = node.path.split("/").some(looksSecret) || looksSecret(node.qualifiedName);
  return {
    key: secret ? standIn(node.id) : node.id,
    id: node.id,
    path: node.path,
    storedPath: storedPath(node.path),
    name: node.qualifiedName,
    storedName: looksSecret(node.qualifiedName) ? WITHHELD : node.qualifiedName,
    level: node.level as UnitLevel,
    digest: node.digest,
    range: node.range,
    signature: node.signature,
  };
}

/** A path as a prompt shows it: a part shaped like a secret is withheld, and a long path is cut in the middle. */
export const promptPath = (path: string): string => cap(path.split("/").map((part) => (looksSecret(part) ? WITHHELD : part)).join("/"), 120);

const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

/** The comment lines directly above a declaration, as written, nearest last. Empty when the line above is code or blank. */
function docAbove(lines: readonly string[], start: number): string[] {
  const found: string[] = [];
  for (let at = start - 1; at >= 1 && found.length < MAX_DOC_LINES; at--) {
    const line = lines[at - 1] ?? "";
    if (!COMMENT_LINE.test(line) && !/\*\/\s*$/.test(line)) break;
    found.unshift(line.trim());
  }
  return found;
}

/** The text of comment lines without their markers, for taking words from. */
const commentText = (line: string): string => line.replace(/^\s*(?:\/\/+|\/\*+|\*+\/?)/, "").replace(/\*\/\s*$/, "");

/* ---- narrowing ---- */

type Where = "name" | "path" | "doc";

/** The stems a unit's name, path and comment give: each stem once, under the first place it is found. */
function unitStems(unit: Unit, lines: readonly string[]): Map<string, Where> {
  const stems = new Map<string, Where>();
  const take = (text: string, where: Where): void => {
    for (const word of wordsOf(text)) {
      const one = stem(word);
      if (!stems.has(one)) stems.set(one, where);
    }
  };
  take(unit.name, "name");
  take(unit.path.replace(/\.[^./]+$/, ""), "path");
  take(docAbove(lines, unit.range.start).map(commentText).join(" "), "doc");
  return stems;
}

/** A term's stems that say something: not a stop word, not a generic word, and at least three characters. One of each. */
function termStems(term: Term): string[] {
  return [...new Set(term.key.split(" "))].filter((one) => one.length >= 3 && !isFillerStem(one));
}

/**
 * A pin that the unit itself is the only reason for: its own exported name. A term whose every pin
 * is this says nothing about the unit that the unit's name does not, so it is no candidate for it.
 */
function isOwnPin(pin: TermPin, unit: Unit): boolean {
  if (pin.source !== "export" || pin.path !== unit.path) return false;
  const inside = pin.range !== null && pin.range.start >= unit.range.start && pin.range.end <= unit.range.end;
  return inside || keyOf(pin.written) === keyOf(unit.name);
}

export interface Candidate {
  readonly unit: Unit;
  readonly term: Term;
  /** The stems the unit and the term share. */
  readonly shared: readonly string[];
  /** The share of the term's stems that the unit has, 0 to 1. */
  readonly score: number;
  /** How many of the shared stems are in the unit's own name. */
  readonly nameHits: number;
}

export interface Narrowed {
  /** Every pair to ask, strongest first: the order a limit cuts at. */
  readonly pairs: readonly Candidate[];
  /** By unit key: the term keys asked about it (strongest first) and the ones cut by MAX_CANDIDATES. */
  readonly units: ReadonlyMap<string, { readonly candidates: string[]; readonly cut: string[] }>;
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The fixed rule that picks which (unit, term) pairs are asked, so that not every pair is. A term
 * is a candidate for a unit when they share a stem (see `stem`) between the term's words and the
 * words of the unit's name, its path or the comment directly above it, skipping stop words and
 * generic words, unless the term is written nowhere but by the unit's own exported name. Per unit
 * the candidates are ranked by the share of the term's stems the unit has, then by how many of them
 * are in the unit's name, then by term key; the first MAX_CANDIDATES are asked and the rest listed
 * as cut. The rule uses no model and no randomness, and is versioned by NARROWING_VERSION.
 */
export function narrow(units: readonly Unit[], terms: readonly Term[], tree: FileTree): Narrowed {
  const stemsOf = new Map<string, string[]>();
  const index = new Map<string, Term[]>();
  // A term a model proposed is also a candidate for every unit of the files it named: it shares no word with a poorly named unit. Those pairs rank after every pair that shares a word.
  const citedBy = new Map<string, Term[]>();
  for (const term of terms) {
    const stems = termStems(term);
    stemsOf.set(term.key, stems);
    for (const one of stems) index.set(one, [...(index.get(one) ?? []), term]);
    for (const path of term.claimed?.files ?? []) citedBy.set(path, [...(citedBy.get(path) ?? []), term]);
  }
  const perUnit = new Map<string, { candidates: string[]; cut: string[] }>();
  const pairs: Candidate[] = [];
  const lineCache = new Map<string, string[]>();
  for (const unit of units) {
    let lines = lineCache.get(unit.path);
    if (lines === undefined) lineCache.set(unit.path, (lines = splitLines(tree.get(unit.path) ?? "")));
    const have = unitStems(unit, lines);
    const found = new Map<string, Term>();
    for (const one of have.keys()) for (const term of index.get(one) ?? []) found.set(term.key, term);
    for (const term of citedBy.get(unit.path) ?? []) found.set(term.key, term);
    const ranked: Candidate[] = [];
    for (const term of found.values()) {
      if (term.pins.length > 0 && term.pins.every((pin) => isOwnPin(pin, unit))) continue;
      const mine = stemsOf.get(term.key)!;
      const shared = mine.filter((one) => have.has(one));
      ranked.push({ unit, term, shared, score: mine.length === 0 ? 0 : shared.length / mine.length, nameHits: shared.filter((one) => have.get(one) === "name").length });
    }
    ranked.sort((a, b) => b.score - a.score || b.nameHits - a.nameHits || byText(a.term.key, b.term.key));
    perUnit.set(unit.key, { candidates: ranked.slice(0, MAX_CANDIDATES).map((one) => one.term.key), cut: ranked.slice(MAX_CANDIDATES).map((one) => one.term.key) });
    pairs.push(...ranked.slice(0, MAX_CANDIDATES));
  }
  pairs.sort((a, b) => b.score - a.score || b.nameHits - a.nameHits || byText(a.unit.key, b.unit.key) || byText(a.term.key, b.term.key));
  return { pairs, units: perUnit };
}

/* ---- what Jev is shown ---- */

/** The order a term's places are shown in: what the repository wrote to explain it first. */
const SOURCE_ORDER = ["heading", "package description", "export", "test", "folder"];

/** The lines that say what a place of a term means: the first lines under a heading, the line of an export, a test or a description. */
function pinContext(pin: TermPin, tree: FileTree): string[] {
  if (pin.range === null || pin.source === "folder") return [];
  const lines = splitLines(tree.get(pin.path) ?? "");
  if (pin.source !== "heading") return lines.slice(pin.range.start - 1, pin.range.end).slice(0, MAX_CONTEXT_LINES).map(safeClip);
  const found: string[] = [];
  for (let at = pin.range.end + 1; at <= lines.length && found.length < MAX_CONTEXT_LINES; at++) {
    const line = lines[at - 1]!;
    if (/^\s{0,3}#/.test(line)) break;
    if (line.trim() !== "") found.push(safeClip(line.trim()));
  }
  return found;
}

/** A term as the gate is shown it: its name and up to MAX_TERM_PINS of the places it is written, with the lines around each. */
export function termFacts(term: Term, tree: FileTree): TermFacts {
  const order = (pin: TermPin): number => SOURCE_ORDER.indexOf(pin.source);
  const ranked = [...term.pins].sort((a, b) => order(a) - order(b));
  const pins: TermPinFacts[] = ranked.slice(0, MAX_TERM_PINS).map((pin) => ({
    source: pin.source,
    where: pin.range === null ? promptPath(pin.path) : `${promptPath(pin.path)} line ${pin.range.start}`,
    written: safeClip(pin.written),
    context: pinContext(pin, tree),
  }));
  return { name: safeClip(term.name), pins, omittedPins: Math.max(0, term.pins.length - pins.length), ...(term.claimed === undefined ? {} : { claimed: safeClip(term.claimed.description) }) };
}

/** A unit as the gate is shown it: its path, signature, the comment above it and the first lines of its code. */
export function unitFacts(unit: Unit, tree: FileTree, maxLines: number = MAX_CODE_LINES): UnitFacts {
  const lines = splitLines(tree.get(unit.path) ?? "");
  const body = lines.slice(unit.range.start - 1, unit.range.end);
  const code = body.slice(0, maxLines).map(safeClip);
  return {
    kind: unit.level,
    name: looksSecret(unit.name) ? WITHHELD : promptName(unit.name),
    path: promptPath(unit.path),
    lines: unit.range,
    signature: safeClip(unit.signature),
    doc: docAbove(lines, unit.range.start).map(safeClip),
    code,
    cutLines: body.length - code.length,
  };
}

/** A digest of everything the classifier is shown of a term: a mapping is stale when this changes, as when its function does. */
export const termDigest = (term: Term, tree: FileTree): string => createHash("sha256").update(JSON.stringify(termFacts(term, tree))).digest("hex").slice(0, 32);

export const inputOf =(candidate: Pick<Candidate, "unit" | "term">, tree: FileTree): MembershipInput => ({ term: termFacts(candidate.term, tree), unit: unitFacts(candidate.unit, tree) });

/* ---- asking ---- */

/** The key of one (unit, term) pair. A Map's key: unit keys and term keys come from the repository. */
export const pairKey = (unit: string, term: string): string => `${unit}\0${term}`;

export interface NotJudged {
  readonly unit: string;
  readonly term: string;
  readonly reason: string;
}

export interface JudgeOutcome {
  /** One record per pair that has an answer now: asked, reused, or an older one kept and marked stale. */
  readonly records: MembershipRecord[];
  readonly asked: number;
  readonly reused: number;
  readonly notJudged: readonly NotJudged[];
  /** Pairs not asked because more than `maxPairs` were picked. */
  readonly overLimit: number;
  readonly usd: number;
  /** Calls whose cost is unknown; `usd` leaves them out. */
  readonly costUnknown: number;
}

export interface JudgeMembershipsRequest {
  readonly pairs: readonly Candidate[];
  readonly tree: FileTree;
  /** The records a stored run holds, by `pairKey`. */
  readonly previous: ReadonlyMap<string, MembershipRecord>;
  readonly client: JevClient;
  readonly thresholds?: Thresholds;
  readonly maxPairs?: number;
}

const PARALLEL = 4;

/** A record with its stale mark taken off: its function, request, thresholds and model are all as they were. */
function fresh(record: MembershipRecord): MembershipRecord {
  const { stale, ...rest } = record;
  void stale;
  return rest;
}

/**
 * Asks Jev once for each pair, strongest first, up to `maxPairs`. An answer already stored is
 * reused when the function's digest, the exact request, the thresholds and the model are all the
 * same. A pair that could not be judged has no record (no answer is never a no); an older record for
 * it is kept and marked stale, so a changed function is never trusted by its old answer.
 */
export async function judgeMemberships(request: JudgeMembershipsRequest): Promise<JudgeOutcome> {
  const { pairs, tree, previous, client, thresholds = MEMBERSHIP_THRESHOLDS, maxPairs = MAX_PAIRS } = request;
  const question = { id: membershipGate.id, version: membershipGate.version };
  const slots: (MembershipRecord | undefined)[] = new Array<MembershipRecord | undefined>(pairs.length);
  const asking: number[] = [];
  const notJudged: NotJudged[] = [];
  let reused = 0;
  let usd = 0;
  let costUnknown = 0;
  const toAsk: number[] = [];
  const kept = (index: number, why: string): void => {
    const pair = pairs[index]!;
    const old = previous.get(pairKey(pair.unit.key, pair.term.key));
    if (old !== undefined) slots[index] = { ...old, stale: old.digest !== pair.unit.digest ? "the function changed" : old.termDigest !== termDigest(pair.term, tree) ? "the term's definition changed" : `not judged again: ${why}` };
  };
  // Answers that can be reused are separated first and do not use the per-run limit: only pairs that
  // must be asked count against it, so a run over the limit finishes the rest on the next run.
  pairs.forEach((pair, index) => {
    const old = previous.get(pairKey(pair.unit.key, pair.term.key));
    const shown = requestFor(membershipGate, inputOf(pair, tree));
    if (
      old !== undefined &&
      old.digest === pair.unit.digest &&
      old.termDigest === termDigest(pair.term, tree) &&
      old.model === client.model &&
      JSON.stringify(old.shown) === JSON.stringify(shown) &&
      JSON.stringify(old.thresholds) === JSON.stringify(thresholds) &&
      old.question.version === question.version &&
      answersCover(old.answers, Object.keys(shown.questions))
    ) {
      slots[index] = fresh(old);
      reused += 1;
    } else toAsk.push(index);
  });
  asking.push(...toAsk.slice(0, maxPairs));
  const over = toAsk.slice(maxPairs);
  for (const index of over) kept(index, `over the limit of ${maxPairs} pairs`);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let slot = next++; slot < asking.length; slot = next++) {
      const index = asking[slot]!;
      const pair = pairs[index]!;
      const shown = requestFor(membershipGate, inputOf(pair, tree));
      const judged = await judge(client, shown);
      if (judged.status === "not judged") {
        notJudged.push({ unit: pair.unit.key, term: pair.term.key, reason: judged.reason });
        kept(index, judged.reason);
        continue;
      }
      if (judged.usage.usd === null) costUnknown += 1;
      else usd += judged.usage.usd;
      // A call that answered, but not every question with a probability, is unknown: no record, so no later run reuses it.
      if (!answersCover(judged.answers, Object.keys(shown.questions))) {
        const reason = "an answer could not be read (missing or not a probability)";
        notJudged.push({ unit: pair.unit.key, term: pair.term.key, reason });
        kept(index, reason);
        continue;
      }
      slots[index] = {
        tier: "judged",
        unit: pair.unit.key,
        term: pair.term.key,
        digest: pair.unit.digest,
        termDigest: termDigest(pair.term, tree),
        question,
        shown,
        answers: judged.answers,
        thresholds,
        verdict: membershipGate.decide(judged.answers, thresholds),
        model: judged.model,
        inputTokens: judged.usage.inputTokens,
        usd: judged.usage.usd,
      };
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, asking.length) }, worker));
  return {
    records: slots.filter((one): one is MembershipRecord => one !== undefined),
    asked: asking.length,
    reused,
    notJudged: notJudged.sort((a, b) => byText(a.unit, b.unit) || byText(a.term, b.term)),
    overLimit: over.length,
    usd,
    costUnknown,
  };
}
