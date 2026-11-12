import { posix } from "node:path";
import { diffText } from "../diff.ts";
import type { LineOp } from "../diff.ts";
import type { LineRange, NodeId } from "../graph.ts";
import { isBinary, sliceLines } from "../lines.ts";
import { cap } from "../prompt-safe.ts";
import type { Rule, Standards } from "../standards.ts";
import type { StandardsDocument } from "../standards-marks.ts";
import { withTier } from "../tier-table.ts";
import { clipText, withholdSecrets } from "./claim-source.ts";
import { MAX_HUNK_LINES, MAX_RULE_CHARS, STANDARD_THRESHOLDS, standardGate } from "./standard-gate.ts";
import type { HunkFacts, RuleFacts, StandardInput } from "./standard-gate.ts";
import type { GateContext, GateRunner } from "./source.ts";
import { judgeItems } from "./store.ts";
import type { Item, ItemOutcome, JudgingEvents } from "./store.ts";
import type { JudgeSubject } from "./subject.ts";

/** The unchanged lines shown on each side of a changed stretch. */
export const HUNK_CONTEXT = 3;
/** The most removed lines, and the most added lines, in one piece of a run: a longer run is split into parts of this many, so no hunk is cut and none left out. */
export const HUNK_CHANGED_LINES = 40;
/** The most rule and hunk pairs asked for one comparison; the rest are listed as not judged. */
export const MAX_PAIRS = 300;

/** One hunk before it is named for a file: the base's side and the head's side of the same stretch. */
export type Hunk = Pick<HunkFacts, "base" | "head" | "before" | "after" | "part" | "clipped"> & {
  /** Set on a part of a split replacement that holds lines of one side only, though the run replaced lines: its other side is in other parts, so it must not be judged as if nothing were there. */
  readonly lopsided?: true;
};

const rangeOf = (numbers: readonly number[]): LineRange | null => (numbers.length === 0 ? null : { start: Math.min(...numbers), end: Math.max(...numbers) });

type Removed = Extract<LineOp, { kind: "removed" }>;
type Added = Extract<LineOp, { kind: "added" }>;

/** A stretch of changed lines (or a part of one too long to show whole), with the span of the diff it came from. */
interface Piece {
  readonly removed: readonly Removed[];
  readonly added: readonly Added[];
  /** The first and last diff line of the whole run this piece is from. */
  readonly from: number;
  readonly to: number;
  /** Set when the run was split: this piece is part `number` of `of`. */
  readonly part?: { readonly number: number; readonly of: number };
  /** A part of a run that both removed and added lines, holding only one of the two. */
  readonly lopsided?: true;
}

/**
 * The changed hunks of one file, from a line diff of its two texts. A run of changed lines is one
 * piece, or, when either side of it has more than HUNK_CHANGED_LINES lines, several pieces that
 * split the removed lines and the added lines together, so each part keeps its own base lines and
 * head lines (a replacement is never shown as a pure addition) and says "part n of m". Pieces
 * separated by at most twice the context are joined into one hunk while what the hunk shows of
 * each side, context included, stays within MAX_HUNK_LINES, so every line of a hunk is shown to
 * the gate; a part of a split run is a hunk of its own. Each changed line is in exactly one hunk.
 * A text that is binary, or too large to diff, is skipped with its reason; it is never read as
 * empty. Every line is as the prompt rules allow: secrets withheld, URLs reduced to their host,
 * the line clipped.
 */
export function hunksOf(before: string, after: string): Hunk[] | { readonly skipped: string } {
  if (isBinary(before) || isBinary(after)) return { skipped: "binary file" };
  let ops: LineOp[] | undefined;
  try {
    ops = diffText(before, after);
  } catch {
    ops = undefined;
  }
  if (ops === undefined) return { skipped: "too large to diff" };
  const all = ops;
  const runs: { from: number; to: number; removed: Removed[]; added: Added[] }[] = [];
  all.forEach((op, index) => {
    if (op.kind === "same") return;
    let run = runs.at(-1);
    if (run === undefined || run.to !== index - 1) {
      run = { from: index, to: index, removed: [], added: [] };
      runs.push(run);
    }
    run.to = index;
    if (op.kind === "removed") run.removed.push(op);
    else run.added.push(op);
  });
  const pieces: Piece[] = runs.flatMap((run) => {
    const count = Math.max(1, Math.ceil(Math.max(run.removed.length, run.added.length) / HUNK_CHANGED_LINES));
    return Array.from({ length: count }, (_, at) => ({
      removed: run.removed.slice(at * HUNK_CHANGED_LINES, (at + 1) * HUNK_CHANGED_LINES),
      added: run.added.slice(at * HUNK_CHANGED_LINES, (at + 1) * HUNK_CHANGED_LINES),
      from: run.from,
      to: run.to,
      ...(count > 1 ? { part: { number: at + 1, of: count } } : {}),
      ...(count > 1 && run.removed.length > 0 && run.added.length > 0 && (at * HUNK_CHANGED_LINES >= run.removed.length || at * HUNK_CHANGED_LINES >= run.added.length) ? { lopsided: true as const } : {}),
    }));
  });
  const gapOf = (last: Piece, next: Piece): number => next.from - last.to - 1;
  /** What a group of pieces shows of each side, with room kept for three lines of context at both ends. */
  const shown = (group: readonly Piece[], side: "removed" | "added"): number => group.reduce((sum, piece, at) => sum + piece[side].length + (at === 0 ? 0 : gapOf(group[at - 1]!, piece)), 2 * HUNK_CONTEXT);
  const groups: Piece[][] = [];
  for (const piece of pieces) {
    const current = groups.at(-1);
    const last = current?.at(-1);
    const joins = current !== undefined && last !== undefined && last.part === undefined && piece.part === undefined && gapOf(last, piece) <= 2 * HUNK_CONTEXT && (["removed", "added"] as const).every((side) => shown([...current, piece], side) <= MAX_HUNK_LINES);
    if (joins) current.push(piece);
    else groups.push([piece]);
  }
  // Context after each hunk, then before each: the two never share a line, and a part of a split run has none against its own run.
  const trailing = groups.map((group, at) => {
    const last = group.at(-1)!;
    const next = groups[at + 1]?.[0];
    if (next === undefined) return Math.min(HUNK_CONTEXT, all.length - 1 - last.to);
    return next.from === last.from ? 0 : Math.min(HUNK_CONTEXT, gapOf(last, next));
  });
  return groups.map((group, at) => {
    const first = group[0]!;
    const previous = groups[at - 1]?.at(-1);
    const free = previous === undefined ? first.from : previous.from === first.from ? 0 : first.from - previous.to - 1 - trailing[at - 1]!;
    const lead = Math.min(HUNK_CONTEXT, Math.max(0, free));
    const lines = { before: [] as string[], after: [] as string[] };
    let clipped = false;
    const safeClip = (text: string): string => {
      const found = clipText(text);
      if (found.clipped) clipped = true;
      return found.text;
    };
    const baseNumbers: number[] = [];
    const headNumbers: number[] = [];
    const same = (from: number, to: number): void => {
      for (const op of all.slice(from, to)) {
        if (op.kind !== "same") continue;
        const text = safeClip(op.text);
        lines.before.push(` ${op.base}: ${text}`);
        lines.after.push(` ${op.head}: ${text}`);
        baseNumbers.push(op.base);
        headNumbers.push(op.head);
      }
    };
    same(first.from - lead, first.from);
    group.forEach((piece, k) => {
      if (k > 0) same(group[k - 1]!.to + 1, piece.from);
      for (const op of piece.removed) {
        lines.before.push(`-${op.base}: ${safeClip(op.text)}`);
        baseNumbers.push(op.base);
      }
      for (const op of piece.added) {
        lines.after.push(`+${op.head}: ${safeClip(op.text)}`);
        headNumbers.push(op.head);
      }
    });
    const last = group.at(-1)!;
    same(last.to + 1, last.to + 1 + trailing[at]!);
    return { base: rangeOf(baseNumbers), head: rangeOf(headNumbers), before: lines.before, after: lines.after, clipped, ...(group.length === 1 && first.part !== undefined ? { part: first.part } : {}), ...(group.length === 1 && first.lopsided === true ? { lopsided: true as const } : {}) };
  });
}

/**
 * The folder a rule applies to ("" is the whole repository). A nested AGENTS.md or CLAUDE.md
 * applies only to its own folder and what is below it, whatever that folder is called. The only
 * root-level exceptions: a rule file directly in the repository's own `.claude/` or `.github/`
 * speaks for the whole repository (where agents look for it), and every rule file that is not
 * named AGENTS.md or CLAUDE.md (CONTRIBUTING.md, style guides, `.claude/rules/`) is the repository's.
 */
export function ruleScope(path: string): string {
  const name = posix.basename(path).toLowerCase();
  if (name !== "agents.md" && name !== "claude.md") return "";
  const folder = posix.dirname(path);
  return folder === "." || folder === ".claude" || folder === ".github" ? "" : folder;
}

const inScope = (scope: string, path: string): boolean => scope === "" || path.startsWith(`${scope}/`);

const MAX_PATH_CHARS = 200;

/** A path as the gate is shown it: each segment goes through the secret rule, so a secret-shaped segment reads "withheld"; then clipped. */
export const safePath = (path: string): string => cap(path.split("/").map(withholdSecrets).join("/"), MAX_PATH_CHARS);
/** Whether `safePath` cut the path. */
export const pathCut = (path: string): boolean => path.split("/").map(withholdSecrets).join("/").length > MAX_PATH_CHARS;

/** A rule as the gate is shown it: the base's text, secrets withheld first, then cut with the cut counted. */
function ruleFacts(rule: Rule, baseText: string): RuleFacts {
  const text = withholdSecrets(sliceLines(baseText, rule.range));
  const headings = [rule.heading, ...rule.ancestorHeadings].map(clipText);
  return {
    path: safePath(rule.path),
    kind: rule.kind,
    heading: headings[0]!.text,
    ancestors: headings.slice(1).map((heading) => heading.text),
    clipped: headings.some((heading) => heading.clipped) || pathCut(rule.path) || pathCut(ruleScope(rule.path)),
    lines: rule.range,
    text: text.slice(0, MAX_RULE_CHARS),
    cutChars: Math.max(0, text.length - MAX_RULE_CHARS),
    scope: safePath(ruleScope(rule.path)),
    edited: rule.edited,
  };
}

const keyOf = (rule: Rule, path: string, hunk: Hunk): string => `standard:${rule.id}:${path}:${hunk.base?.start ?? "-"}:${hunk.head?.start ?? "-"}`;

/**
 * One item per changed hunk and rule in its scope, and the pairs that were not asked, each as a
 * "not judged" outcome with its reason. Rules are the base's (see collectStandards); no written
 * rules, or rules that could not be read, give nothing to ask.
 */
export function standardItems(subject: JudgeSubject): { readonly items: Item<StandardInput>[]; readonly skipped: ItemOutcome[] } {
  const { standards, comparison, baseTree, headTree } = subject;
  const items: Item<StandardInput>[] = [];
  const skipped: ItemOutcome[] = [];
  if (standards.status !== "found") return { items, skipped };
  const rules = standards.rules.flatMap((rule) => {
    const text = baseTree.get(rule.path);
    return text === undefined ? [] : [{ rule, facts: ruleFacts(rule, text), scope: ruleScope(rule.path) }];
  });
  const files = comparison.changes.filter((change) => change.node.level === "file").sort((a, b) => (a.node.path < b.node.path ? -1 : a.node.path > b.node.path ? 1 : 0));
  for (const change of files) {
    const path = change.node.path;
    const basePath = change.kind === "moved" ? change.from.path : path;
    const nodes: NodeId[] = [change.node.id];
    const label = change.kind === "moved" ? `moved ${safePath(change.from.path)} to ${safePath(path)}` : `${change.kind} ${safePath(path)}`;
    const before = change.kind === "added" ? "" : baseTree.get(basePath);
    const after = change.kind === "removed" ? "" : headTree.get(path);
    const hunks = before === undefined || after === undefined ? { skipped: "the file's text is not in the tree" } : hunksOf(before, after);
    if ("skipped" in hunks) {
      skipped.push({ status: "not judged", key: `standard:file:${path}`, about: { nodes }, reason: `${label}: ${hunks.skipped}, so its hunks were not judged against any rule` });
      continue;
    }
    for (const hunk of hunks) {
      if (hunk.lopsided === true && rules.length > 0) {
        // One side of this part is in other parts. Showing it with "nothing" there would tell the gate a violation was new when the base had it.
        const place = `${label}, ${hunk.base === null ? "no base lines" : "no head lines"}`;
        skipped.push({ status: "not judged", key: `standard:lopsided:${path}:${hunk.base?.start ?? "-"}:${hunk.head?.start ?? "-"}`, about: { nodes }, reason: `${place}: part ${hunk.part?.number ?? "?"} of ${hunk.part?.of ?? "?"} of a change that replaced lines, holding lines of one side only, so it was not judged against any rule` });
        continue;
      }
      for (const { rule, facts, scope } of rules) {
        if (!inScope(scope, path)) continue;
        const key = keyOf(rule, path, hunk);
        const about = { nodes, standard: { rule: { path: facts.path, heading: facts.heading, ancestors: facts.ancestors, lines: facts.lines, edited: facts.edited }, hunk: { path: safePath(path), base: hunk.base, head: hunk.head } } };
        if (hunk.before.length > MAX_HUNK_LINES || hunk.after.length > MAX_HUNK_LINES) {
          // Never reached with hunksOf's bound; a hunk the gate could not be shown whole is never judged.
          skipped.push({ status: "not judged", key, about, reason: `this hunk has more than ${MAX_HUNK_LINES} lines on a side, so the gate could not be shown all of it` });
          continue;
        }
        if (items.length >= MAX_PAIRS) {
          skipped.push({ status: "not judged", key, about, reason: `over the cap of ${MAX_PAIRS} rule and hunk pairs asked per comparison; this pair was not asked` });
          continue;
        }
        // The hunk's tier comes from its file and its lines: how far the change reaches, and what harm a mistake there could cause.
        const pick = subject.tiers({ ids: nodes, hunk: { head: hunk.head, base: hunk.base } });
        items.push({ key, about, input: { rule: facts, hunk: { path: safePath(path), label, ...hunk, clipped: hunk.clipped || pathCut(path) || (change.kind === "moved" && pathCut(change.from.path)) } }, thresholds: withTier(STANDARD_THRESHOLDS, pick), pick });
      }
    }
  }
  return { items, skipped };
}

/** What /standards.json serves: the base's rules (no text: that is in what Jev was shown) with their lines and scope, and why the status is what it is. Derived; no model is called. */
export function standardsBody(standards: Standards): string {
  const document: StandardsDocument = {
    tier: "derived",
    tableVersion: standards.tableVersion,
    status: standards.status,
    ...(standards.reason === undefined ? {} : { reason: standards.reason }),
    unread: standards.unread,
    rules: standards.rules.map((rule) => ({ path: rule.path, heading: rule.heading, kind: rule.kind, range: rule.range, edited: rule.edited, scope: ruleScope(rule.path) })),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** The standard gate's runner: judges each hunk against each rule in scope once per comparison, through the judged store. */
export const standardRunner: GateRunner = async (context: GateContext) => {
  const { items, skipped } = standardItems(context.subject);
  // The pairs not asked are known before the first call: they are part of the plan, so the page reads them as not judged while the rest is asked.
  const events = context.events === undefined ? undefined : { ...context.events, plan: (set: Parameters<JudgingEvents["plan"]>[0], known: readonly ItemOutcome[], pending: Parameters<JudgingEvents["plan"]>[2]) => context.events!.plan(set, [...known, ...skipped], pending) };
  const run = await judgeItems({
    gate: standardGate,
    items,
    thresholds: STANDARD_THRESHOLDS,
    client: context.client,
    base: context.base,
    head: context.head,
    cacheDir: context.cacheDir,
    ...(events === undefined ? {} : { events }),
  });
  return skipped.length === 0 ? run : { ...run, outcomes: [...run.outcomes, ...skipped] };
};
