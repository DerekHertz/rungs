import type { Comparison, ModuleChange } from "./compare.ts";
import { combine, effectOf, pairKeyOf } from "./corrections.ts";
import type { Part } from "./corrections.ts";
import { diffText } from "./diff.ts";
import { effectLabel, effectSets } from "./effects.ts";
import { EXTRACTOR_VERSION } from "./extract/extract.ts";
import { isCodeNode } from "./graph.ts";
import type { FileTree, Graph, LineRange, ModuleNode, NodeId } from "./graph.ts";
import { harmKind } from "./harm-catalogue.ts";
import { importanceOf, unknownRestOf } from "./importance.ts";
import { narrow, pairKey, unitsOf } from "./jev/membership-source.ts";
import type { Unit } from "./jev/membership-source.ts";
import { stakePairKey, termMembers } from "./jev/stakes-source.ts";
import { isBinary } from "./lines.ts";
import { pairStatus, reconcile } from "./memberships.ts";
import { promptName } from "./prompt-safe.ts";
import { shown } from "./stored-names.ts";
import { termsOf } from "./setup.ts";
import type { StoredRead, StoredVocabulary } from "./setup.ts";
import { kindChoice, readKindsFile } from "./jev/stakes-adoption.ts";
import { reconcileStakes, stakeStatus } from "./stakes.ts";
import type { KindChoice, StoredStakes } from "./stakes.ts";
import { DEFAULT_TIERS, pickTier } from "./tier-table.ts";
import type { ComplexityFacts, ItemScope, StakesFacts, TierPicker, TierTable } from "./tier-table.ts";
import { VOCABULARY_TABLE_VERSION } from "./vocabulary.ts";
import type { Term } from "./vocabulary.ts";

/*
 * The facts behind an item's tier (see tier-table.ts for the rule). Complexity is derived from the two
 * graphs and the two trees: nothing here asks a model. Stakes are read from what `streets setup` stored,
 * brought up to date against this comparison's base the way setup does without a model (a mapping or
 * a stake whose function, term or request changed is stale), and never changed: a stake is a judged
 * fact kept apart. Whatever cannot be read is unknown, and unknown is possible harm, never none.
 */

/** What was stored for the repository, as `streets compare` found it. */
export type VocabularyRead =
  | { readonly status: "ok"; readonly stored: StoredVocabulary; /** The kinds of harm that may be judged now: a kind not in it is not judged, whatever was stored. */ readonly choice: KindChoice }
  | { readonly status: "missing" | "unreadable"; readonly why: string };

/** The reviewer's table and the stored vocabulary: what a comparison picks tiers from. */
export interface Tiering {
  readonly table: TierTable;
  readonly vocabulary: VocabularyRead;
}

/** The tiering of a comparison that was given none: the default table, and no vocabulary. */
export const NO_TIERING: Tiering = { table: DEFAULT_TIERS, vocabulary: { status: "missing", why: "no vocabulary was read" } };

/** The reviewer's table with what setup stored, as a comparison picks tiers from them. A vocabulary built with other rules than this version's is not read as one. */
export async function tieringOf(read: StoredRead, table: TierTable): Promise<Tiering> {
  if (read.kind === "missing") return { table, vocabulary: { status: "missing", why: "no vocabulary is stored for this repository (run `streets setup --judge`)" } };
  if (read.kind === "unreadable") return { table, vocabulary: { status: "unreadable", why: `the stored vocabulary could not be read (${read.why})` } };
  const { stored } = read;
  if (stored.vocabulary.tableVersion !== VOCABULARY_TABLE_VERSION || stored.extractorVersion !== EXTRACTOR_VERSION) {
    return { table, vocabulary: { status: "missing", why: "the stored vocabulary was built with other rules than this version's (run `streets setup --judge`)" } };
  }
  return { table, vocabulary: { status: "ok", stored, choice: kindChoice(await readKindsFile()) } };
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const overlaps = (a: LineRange, b: LineRange | null): boolean => b !== null && a.start <= b.end && b.start <= a.end;
const rangeOf = (node: ModuleNode): LineRange | null => (isCodeNode(node) ? node.range : null);
const underFolder = (path: string, folder: string): boolean => folder === "" || path.startsWith(`${folder}/`);

/** "a, b and 3 more are" / "a is": up to two names, the rest counted, and the verb that agrees. */
const named = (names: ReadonlySet<string>): string => {
  const sorted = [...names].sort(byText);
  return `${sorted.slice(0, 2).join(", ")}${sorted.length > 2 ? ` and ${sorted.length - 2} more` : ""} ${sorted.length === 1 ? "is" : "are"}`;
};

/** At most this many reasons are written out; the rest are counted. */
const MAX_REASONS = 3;
const listOf = (reasons: readonly string[]): string => {
  const unique = [...new Set(reasons)].sort(byText);
  return unique.length <= MAX_REASONS ? unique.join("; ") : `${unique.slice(0, MAX_REASONS).join("; ")}; and ${unique.length - MAX_REASONS} more`;
};

/* ---- stakes ---- */

/** One term's stakes: whether every kind of harm is judged no, completely. */
type TermStakes = { readonly status: "none" } | { readonly status: "could cause"; readonly harms: readonly string[] } | { readonly status: "possible"; readonly reason: string };

/** What a unit is mapped to, from the memberships as they stand against this comparison's base, with a person's corrections over them. */
interface UnitTerms {
  /** The terms it is a current member of: a term as the corrections leave it (merged ones folded in, removed ones gone). */
  readonly terms: readonly string[];
  /** The terms in `terms` it is in only because a person said so: the stakes of the term were judged without its code. */
  readonly added: ReadonlySet<string>;
  /** False when a pair of the unit is stale, not judged or left out by the cap: it may belong to a term not listed. */
  readonly known: boolean;
}

interface StakesLookup {
  readonly units: ReadonlyMap<NodeId, Unit>;
  unitTerms(unit: Unit): UnitTerms | undefined;
  termStakes(key: string): TermStakes;
  termName(key: string): string;
}

/** The stored memberships and stakes as they stand against this base, or why they cannot be read. */
function stakesLookup(vocabulary: VocabularyRead, baseGraph: Graph, baseTree: FileTree): StakesLookup | string {
  if (vocabulary.status !== "ok") return vocabulary.why;
  const { stored, choice } = vocabulary;
  if (stored.memberships === undefined) return "no code is mapped to a term yet (run `streets setup --judge`)";
  if (stored.stakes === undefined) return "stakes are not recorded yet (run `streets setup --judge`)";
  const terms: readonly Term[] = termsOf(stored);
  const units = unitsOf(baseGraph, baseTree);
  const held = reconcile(stored.memberships, units, narrow(units, terms, baseTree), terms, baseTree);
  const entries = termMembers(held, units, terms);
  const stakes: StoredStakes = reconcileStakes(stored.stakes, entries, baseTree, choice, effectSets(baseGraph));
  const records = new Map([...stakes.records, ...stakes.derived].map((record) => [stakePairKey(record.term, record.kind), record]));
  const heldUnits = new Map(held.units.map((unit) => [unit.key, unit]));
  const heldRecords = new Map(held.records.map((record) => [pairKey(record.unit, record.term), record]));
  // A person's word wins over the judged answer, as it does on the card: the same rule (src/corrections.ts) reads both.
  const effect = effectOf(terms, stored.corrections ?? []);
  const unitKeys = new Set(units.map((unit) => unit.key));
  const said = new Map([...effect.pairs].filter(([, pair]) => unitKeys.has(pair.unit)));
  const saidTerms = new Map<string, string[]>();
  for (const pair of said.values()) saidTerms.set(pair.unit, [...(saidTerms.get(pair.unit) ?? []), pair.term]);
  const storedTerms = new Map(stakes.terms.map((term) => [term.key, term]));
  const kindName = (id: string): string => harmKind(id)?.name ?? id;
  /** One stored term's stakes, and whether it has no judged code at all (then it says nothing about a union it is part of). */
  const ownStakes = (key: string): { readonly stakes: TermStakes; readonly empty: boolean } => {
    const term = storedTerms.get(key);
    const harms: string[] = [];
    const reasons: string[] = [];
    if (term === undefined) reasons.push("the term has no stored stakes");
    else if (term.members === 0) reasons.push(term.unknown > 0 ? "a mapping of the term is not fully known" : "the term has no mapped member");
    else {
      // Every kind that may be judged now, not only the ones this term was asked at setup: a kind adopted since then was never asked of it, and that is "not judged", never "no".
      for (const id of stakes.kinds.asked) {
        if (term.cut.includes(id)) continue;
        const status = stakeStatus(records.get(stakePairKey(key, id)));
        if (status === "could cause") harms.push(kindName(id));
        else if (status !== "judged no") reasons.push(`${kindName(id)} ${status}`);
      }
      for (const id of term.cut) reasons.push(`${kindName(id)} left out by the cap`);
      for (const one of stakes.kinds.notJudged) reasons.push(`${kindName(one.id)} not judged`);
      if (term.unknown > 0) reasons.push("a mapping of the term is not fully known");
    }
    const stakesOf: TermStakes = harms.length > 0 ? { status: "could cause", harms } : reasons.length > 0 ? { status: "possible", reason: listOf(reasons) } : { status: "none" };
    // Empty means no code and nothing unknown: a term whose members are stale, not judged or cut may hold code, so it speaks, and so does a term nothing is stored for.
    return { stakes: stakesOf, empty: term !== undefined && term.members === 0 && term.unknown === 0 };
  };
  const answered = new Map<string, TermStakes>();
  const addedMembers = lazy(() => {
    const byTerm = new Map<string, string[]>();
    const spokenFor = new Set([...said.values()].filter((pair) => pair.belongs).map((pair) => pair.unit));
    for (const unit of units) {
      if (!spokenFor.has(unit.key)) continue;
      for (const key of lookup.unitTerms(unit)?.added ?? []) byTerm.set(key, [...(byTerm.get(key) ?? []), promptName(unit.name)]);
    }
    return byTerm;
  });
  const lookup: StakesLookup = {
    units: new Map(units.map((unit) => [unit.id, unit])),
    unitTerms(unit) {
      const seen = heldUnits.get(unit.key);
      const candidates = seen?.candidates ?? [];
      const keys = new Set<string>();
      for (const key of [...candidates, ...(saidTerms.get(unit.key) ?? [])]) {
        const visible = effect.resolve(key);
        if (visible !== undefined) keys.add(visible);
      }
      if (seen === undefined && keys.size === 0) return undefined;
      const members: string[] = [];
      const added = new Set<string>();
      let known = true;
      for (const key of keys) {
        const parts: Part[] = [];
        let judgedMember = false;
        for (const source of effect.sources(key)) {
          const word = said.get(pairKeyOf(unit.key, source));
          const status = candidates.includes(source) ? pairStatus(heldRecords.get(pairKey(unit.key, source))) : undefined;
          if (status === "member") judgedMember = true;
          if (word !== undefined) parts.push({ status: word.belongs ? "member" : "not a member", said: word });
          else if (status !== undefined) parts.push({ status });
        }
        const { status, corrected } = combine(said.get(pairKeyOf(unit.key, key)), parts);
        if (status === "member") {
          members.push(key);
          if (corrected !== undefined && !judgedMember) added.add(key);
        } else if (status === "stale" || status === "not judged") known = false;
      }
      // A pair the cap left out of the questions is unknown, unless a person has spoken for it.
      for (const key of seen?.cut ?? []) {
        const visible = effect.resolve(key);
        if (visible !== undefined && !said.has(pairKeyOf(unit.key, key)) && !said.has(pairKeyOf(unit.key, visible))) known = false;
      }
      return { terms: members, added, known };
    },
    termName: (key) => shown(effect.nameOf(key)),
    termStakes(key) {
      const cached = answered.get(key);
      if (cached !== undefined) return cached;
      // A merged term holds the code of every part, so it carries the worst of their stakes; a part with no judged code says nothing, unless none has any.
      const parts = effect.sources(key).map(ownStakes);
      const speaking = parts.filter((part) => !part.empty);
      const used = (speaking.length > 0 ? speaking : parts.slice(0, 1)).map((part) => part.stakes);
      const harms = used.flatMap((one) => (one.status === "could cause" ? one.harms : []));
      const reasons = used.flatMap((one) => (one.status === "possible" ? [one.reason] : []));
      // Stakes are complete only over every current member after the corrections: a function a person added is a member the judged stakes never examined, so whatever the other members were judged, the term is possible harm for every item that touches it.
      const added = [...new Set(addedMembers().get(key) ?? [])].sort(byText);
      if (added.length > 0) reasons.push(`${added.slice(0, 2).join(", ")}${added.length > 2 ? ` and ${added.length - 2} more` : ""} ${added.length === 1 ? "was" : "were"} added to it by a person after its stakes were judged`);
      const result: TermStakes = harms.length > 0 ? { status: "could cause", harms: [...new Set(harms)] } : reasons.length > 0 ? { status: "possible", reason: listOf(reasons) } : { status: "none" };
      answered.set(key, result);
      return result;
    },
  };
  return lookup;
}

/* ---- the picker ---- */

export interface TierRequest {
  readonly tiering: Tiering;
  readonly comparison: Comparison;
  readonly baseGraph: Graph;
  readonly graph: Graph;
  readonly baseTree: FileTree;
  readonly tree: FileTree;
}

const lazy = <T>(make: () => T): (() => T) => {
  let made: { readonly value: T } | undefined;
  return () => (made ??= { value: make() }).value;
};

/**
 * Picks an item's tier. Built once per comparison; the graph facts it needs are computed on first
 * use. An item whose changed nodes are not known to the comparison has unknown complexity and unknown
 * stakes: the strictest tier.
 */
export function tierPicker(request: TierRequest): TierPicker {
  const { tiering, comparison, baseGraph, graph, baseTree, tree } = request;
  const changesById = new Map<NodeId, ModuleChange>(comparison.changes.map((change) => [change.node.id, change]));
  const fileChanges = comparison.changes.filter((change) => change.node.level === "file");
  const codeByPath = new Map<string, ModuleChange[]>();
  for (const change of comparison.changes) if (isCodeNode(change.node)) codeByPath.set(change.node.path, [...(codeByPath.get(change.node.path) ?? []), change]);
  const headNodes = lazy(() => new Map<NodeId, ModuleNode>(graph.nodes.map((node) => [node.id, node])));
  const baseNodes = lazy(() => new Map<NodeId, ModuleNode>(baseGraph.nodes.map((node) => [node.id, node])));
  const headRests = lazy(() => importanceOf(graph));
  const baseRests = lazy(() => importanceOf(baseGraph));
  const headEffects = lazy(() => effectSets(graph));
  const baseEffects = lazy(() => effectSets(baseGraph));
  const lookup = lazy(() => stakesLookup(tiering.vocabulary, baseGraph, baseTree));
  const lineCounts = new Map<string, readonly { readonly base?: number; readonly head?: number }[] | null>();

  /** The changed files an item names: a file itself, the files under a folder or package, the file of a code node. */
  const filesOf = (ids: readonly NodeId[]): ModuleChange[] => {
    const found = new Map<string, ModuleChange>();
    for (const id of ids) {
      const change = changesById.get(id);
      if (change === undefined) continue;
      if (change.node.level === "file") found.set(change.node.id, change);
      else if (isCodeNode(change.node)) for (const file of fileChanges) if (file.node.path === change.node.path) found.set(file.node.id, file);
      else for (const file of fileChanges) if (underFolder(file.node.path, change.node.path)) found.set(file.node.id, file);
    }
    return [...found.values()].sort((a, b) => byText(a.node.id, b.node.id));
  };

  /** The changed lines of a file as the line diff has them (a base line, or a head line), or null when they cannot be known. */
  const changedLines = (file: ModuleChange): readonly { readonly base?: number; readonly head?: number }[] | null => {
    const key = file.node.id;
    if (lineCounts.has(key)) return lineCounts.get(key)!;
    const basePath = file.kind === "moved" ? file.from.path : file.node.path;
    const before = file.kind === "added" ? "" : baseTree.get(basePath);
    const after = file.kind === "removed" ? "" : tree.get(file.node.path);
    let lines: { base?: number; head?: number }[] | null = null;
    if (before !== undefined && after !== undefined && !isBinary(before) && !isBinary(after)) {
      try {
        // Too large to diff is undefined: the changed lines are not known.
        lines = diffText(before, after)?.flatMap((op): { base?: number; head?: number }[] => (op.kind === "added" ? [{ head: op.head }] : op.kind === "removed" ? [{ base: op.base }] : [])) ?? null;
      } catch {
        lines = null;
      }
    }
    lineCounts.set(key, lines);
    return lines;
  };

  /** The changed lines of a file that the item is about: all of them, or the hunk's own; null when they are not known. */
  const itemLines = (file: ModuleChange, scope: ItemScope): readonly { readonly base?: number; readonly head?: number }[] | null => {
    const changed = changedLines(file);
    const hunk = scope.hunk;
    if (changed === null || hunk === undefined) return changed;
    const inside = (line: number | undefined, range: LineRange | null): boolean => line !== undefined && range !== null && line >= range.start && line <= range.end;
    return changed.filter((one) => inside(one.head, hunk.head) || inside(one.base, hunk.base));
  };

  /**
   * How many of the item's changed lines in a file are inside no changed function, class or constant (an import, a top-level
   * statement, a comment above a function), so that no unit and no term is known for them; null when the lines are not known.
   * A line is covered by the head range of a changed unit when it was added, by the base range of one when it was removed.
   */
  const linesOutsideUnits = (file: ModuleChange, scope: ItemScope): number | null => {
    const changed = itemLines(file, scope);
    if (changed === null) return null;
    const basePath = file.kind === "moved" ? file.from.path : file.node.path;
    const head: LineRange[] = [];
    const base: LineRange[] = [];
    for (const change of codeByPath.get(file.node.path) ?? []) {
      const after = change.kind === "removed" ? null : rangeOf(change.node);
      const was = change.kind === "altered" ? change.before : change.kind === "removed" ? change.node : change.kind === "moved" ? change.from : undefined;
      if (after !== null) head.push(after);
      if (was !== undefined && was.path === basePath) {
        const range = rangeOf(was);
        if (range !== null) base.push(range);
      }
    }
    const within = (ranges: readonly LineRange[], line: number | undefined): boolean => line !== undefined && ranges.some((range) => line >= range.start && line <= range.end);
    return changed.filter((one) => !(one.head !== undefined ? within(head, one.head) : within(base, one.base))).length;
  };

  /** The code changes of an item's files, narrowed to a hunk's lines when it has them. */
  const codeOf = (files: readonly ModuleChange[], scope: ItemScope): ModuleChange[] => {
    const code = files.flatMap((file) => codeByPath.get(file.node.path) ?? []);
    const hunk = scope.hunk;
    if (hunk === undefined) return code;
    return code.filter((change) => {
      const before = change.kind === "altered" ? rangeOf(change.before) : change.kind === "removed" ? rangeOf(change.node) : change.kind === "moved" ? rangeOf(change.from) : null;
      const after = change.kind === "removed" ? null : rangeOf(change.node);
      return (after !== null && overlaps(after, hunk.head)) || (before !== null && overlaps(before, hunk.base));
    });
  };

  const complexity = (files: readonly ModuleChange[], code: readonly ModuleChange[], scope: ItemScope): ComplexityFacts => {
    const own = new Set(files.map((file) => file.node.id));
    const known = new Set<NodeId>();
    const unread = new Set<NodeId>();
    for (const file of files) {
      const headId = file.kind === "removed" ? undefined : file.node.id;
      const baseId = file.kind === "moved" ? file.from.id : file.kind === "added" ? undefined : file.node.id;
      for (const id of headId === undefined ? [] : (headRests().get(headId) ?? [])) known.add(id);
      for (const id of baseId === undefined ? [] : (baseRests().get(baseId) ?? [])) known.add(id);
      if (headId !== undefined) for (const id of unknownRestOf(graph, headId, known, [file.kind === "moved" ? file.from.path : file.node.path])) unread.add(id);
    }
    for (const id of own) known.delete(id);
    for (const id of [...unread]) if (own.has(id) || known.has(id)) unread.delete(id);

    const effects = new Set<string>();
    const paths = new Set(files.map((file) => file.node.path));
    for (const change of code) {
      for (const label of headEffects().get(change.node.id) ?? []) effects.add(label);
      const baseId = change.kind === "moved" ? change.from.id : change.kind === "added" ? undefined : change.node.id;
      for (const label of baseId === undefined ? [] : (baseEffects().get(baseId) ?? [])) effects.add(label);
    }
    // Calls that came or went, and calls that stayed but take other arguments, in an item's files (a hunk's lines when it has them). A call is one kind of call out whether it is reached from a changed function or came with the change: the same label is added once.
    const nodePath = (id: NodeId, side: "head" | "base"): string | undefined => (side === "head" ? headNodes() : baseNodes()).get(id)?.path;
    for (const effect of comparison.effects) {
      const side = effect.kind === "added" ? "head" : "base";
      const path = nodePath(effect.edge.from, side);
      const range = side === "head" ? scope.hunk?.head : scope.hunk?.base;
      if (path !== undefined && paths.has(path) && (scope.hunk === undefined || overlaps(effect.edge.range, range ?? null))) effects.add(effectLabel(effect.edge));
    }
    for (const changed of comparison.changedEffects) {
      const path = nodePath(changed.owner, "head");
      if (path !== undefined && paths.has(path) && (scope.hunk === undefined || changed.ranges.some((range) => overlaps(range, scope.hunk?.head ?? null)))) effects.add(changed.label);
    }

    let lines: number | null = 0;
    if (files.length === 0) lines = null;
    for (const file of files) {
      const changed = itemLines(file, scope);
      if (changed === null || lines === null) {
        lines = null;
        continue;
      }
      lines += changed.length;
    }
    // Files the item names are covered only when read in full: a file with a syntax error has calls out nobody can see.
    const unreadFiles = files.filter((file) => {
      const head = file.kind === "removed" ? undefined : headNodes().get(file.node.id);
      const base = file.kind === "added" ? undefined : baseNodes().get(file.kind === "moved" ? file.from.id : file.node.id);
      return [head, base].some((node) => node?.level === "file" && node.analysis === "not fully read");
    }).length;
    return { blastRadius: known.size, unreadMayRest: unread.size, effects: effects.size, lines, unreadFiles, unknownPlaces: scope.ids.filter((id) => !changesById.has(id)).length };
  };

  /** The top-level unit a changed node belongs to in the base: itself, or the class or function that holds it. */
  const unitOf = (change: ModuleChange, units: ReadonlyMap<NodeId, Unit>): Unit | undefined => {
    const climb = (nodes: ReadonlyMap<NodeId, ModuleNode>, start: NodeId): Unit | undefined => {
      for (let at: NodeId | undefined = start; at !== undefined; ) {
        const unit = units.get(at);
        if (unit !== undefined) return unit;
        const node = nodes.get(at);
        if (node === undefined || !isCodeNode(node)) return undefined;
        at = node.parent;
      }
      return undefined;
    };
    if (change.kind === "added") return isCodeNode(change.node) ? climb(headNodes(), change.node.parent) : undefined;
    return climb(baseNodes(), change.kind === "moved" ? change.from.id : change.node.id);
  };

  /** The name of the top-level function, class or constant a changed node is in (itself when it is one). */
  const topName = (change: ModuleChange): string => {
    const nodes = change.kind === "removed" ? baseNodes() : headNodes();
    let at: ModuleNode | undefined = change.node;
    while (at !== undefined && isCodeNode(at)) {
      const parent: ModuleNode | undefined = nodes.get(at.parent);
      if (parent === undefined || !isCodeNode(parent)) return promptName(at.qualifiedName);
      at = parent;
    }
    return change.node.path;
  };

  const stakes = (files: readonly ModuleChange[], code: readonly ModuleChange[], scope: ItemScope): StakesFacts => {
    const found = lookup();
    if (typeof found === "string") return { status: "possible", reason: found };
    if (code.length === 0) return { status: "possible", reason: scope.hunk === undefined ? "no changed function to map to a term" : "the changed lines are in no function, so no term is known for them" };
    const reasons: string[] = [];
    const harms: string[] = [];
    const none = new Set<string>();
    const strangers = scope.ids.filter((id) => !changesById.has(id)).length;
    if (strangers > 0) reasons.push(`${strangers === 1 ? "a named place is" : `${strangers} named places are`} no change this comparison knows`);
    // One rule for every changed line: a term can be read only for a line that is inside a changed unit. A changed file with no changed function in it (unparseable, binary, a document, a script of top-level statements) has none; a file with functions can still change lines beside them. Stakes there are unknown, however clean the functions nearby are.
    const bare = new Set<string>();
    const outside = new Map<string, number | null>();
    for (const file of files) {
      if (!codeByPath.has(file.node.path)) bare.add(file.node.path);
      else {
        const count = linesOutsideUnits(file, scope);
        if (count === null || count > 0) outside.set(file.node.path, count);
      }
    }
    if (bare.size > 0) reasons.push(`${named(bare)} changed with no function to map to a term`);
    for (const [path, count] of outside) reasons.push(count === null ? `the changed lines of ${path} are not known, so none is known to be in a function` : `${count === 1 ? "a changed line" : `${count} changed lines`} of ${path} ${count === 1 ? "is" : "are"} outside every function, so no term is known for ${count === 1 ? "it" : "them"}`);
    // Functions with no term, by the unit (or top-level function) that holds them: one line per reason, not one per nested callback.
    const unmapped = new Set<string>();
    const noTerm = new Set<string>();
    const notKnown = new Set<string>();
    for (const change of code) {
      const unit = unitOf(change, found.units);
      const mapped = unit === undefined ? undefined : found.unitTerms(unit);
      if (mapped === undefined) {
        unmapped.add(topName(change));
        continue;
      }
      if (mapped.terms.length === 0) noTerm.add(promptName(unit!.name));
      if (!mapped.known) notKnown.add(promptName(unit!.name));
      for (const key of mapped.terms) {
        const stake = found.termStakes(key);
        if (stake.status === "could cause") harms.push(...stake.harms.map((harm) => `${harm} in ${found.termName(key)}`));
        else if (stake.status === "possible") reasons.push(`${found.termName(key)}: ${stake.reason}`);
        else none.add(found.termName(key));
      }
    }
    if (unmapped.size > 0) reasons.push(`${named(unmapped)} in no unit that setup mapped to a term`);
    if (noTerm.size > 0) reasons.push(`${named(noTerm)} mapped to no term`);
    if (notKnown.size > 0) reasons.push(`the mapping of ${[...notKnown].sort(byText).slice(0, 2).join(", ")}${notKnown.size > 2 ? ` and ${notKnown.size - 2} more` : ""} is not fully known`);
    if (harms.length > 0) return { status: "could cause", harms: [...new Set(harms)].sort(byText) };
    if (reasons.length > 0) return { status: "possible", reason: listOf(reasons) };
    return { status: "none", terms: [...none].sort(byText) };
  };

  return (scope) => {
    const files = filesOf(scope.ids);
    const code = codeOf(files, scope);
    return pickTier(complexity(files, code, scope), stakes(files, code, scope), tiering.table);
  };
}
