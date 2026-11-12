import { posix } from "node:path";
import { diffText } from "../diff.ts";
import type { LineOp } from "../diff.ts";
import type { LineRange, NodeId } from "../graph.ts";
import { isBinary, sliceLines } from "../lines.ts";
import { cap } from "../prompt-safe.ts";
import type { Rule, Standards } from "../standards.ts";
import type { StandardsDocument } from "../standards-marks.ts";
import { safeClip, withholdSecrets } from "./claim-source.ts";
import { MAX_RULE_CHARS, STANDARD_THRESHOLDS, standardGate } from "./standard-gate.ts";
import type { HunkFacts, RuleFacts, StandardInput } from "./standard-gate.ts";
import type { GateContext, GateRunner } from "./source.ts";
import { judgeItems } from "./store.ts";
import type { Item, ItemOutcome } from "./store.ts";
import type { JudgeSubject } from "./subject.ts";

/** The unchanged lines shown on each side of a changed stretch. */
export const HUNK_CONTEXT = 3;
/** The most changed lines (added and removed together) in one hunk: a longer run is split, so no hunk is cut and none left out. */
export const HUNK_CHANGED_LINES = 40;
/** The most rule and hunk pairs asked for one comparison; the rest are listed as not judged. */
export const MAX_PAIRS = 300;

/** One hunk before it is named for a file: the base's side and the head's side of the same stretch. */
export type Hunk = Pick<HunkFacts, "base" | "head" | "before" | "after">;

const rangeOf = (numbers: readonly number[]): LineRange | null => (numbers.length === 0 ? null : { start: Math.min(...numbers), end: Math.max(...numbers) });

/**
 * The changed hunks of one file, from a line diff of its two texts: each changed stretch with three
 * lines of context, stretches whose contexts meet joined, and a run of more than HUNK_CHANGED_LINES
 * changed lines split. Each changed line is in exactly one hunk. A text that is binary, or too large
 * to diff, is skipped with its reason; it is never read as empty. Every line is as the prompt rules
 * allow: secrets withheld, URLs reduced to their host, the line clipped.
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
  const changed = ops.flatMap((op, index) => (op.kind === "same" ? [] : [index]));
  const groups: number[][] = [];
  for (const index of changed) {
    const current = groups.at(-1);
    if (current !== undefined && index - current.at(-1)! - 1 <= 2 * HUNK_CONTEXT && current.length < HUNK_CHANGED_LINES) current.push(index);
    else groups.push([index]);
  }
  return groups.map((group, at) => {
    const previous = groups[at - 1]?.at(-1);
    const next = groups[at + 1]?.[0];
    const from = Math.max(group[0]! - HUNK_CONTEXT, previous === undefined ? 0 : previous + 1);
    const to = Math.min(group.at(-1)! + HUNK_CONTEXT, next === undefined ? ops.length - 1 : next - 1);
    const lines = { before: [] as string[], after: [] as string[] };
    const baseNumbers: number[] = [];
    const headNumbers: number[] = [];
    for (const op of ops.slice(from, to + 1)) {
      const text = safeClip(op.text);
      if (op.kind !== "added") {
        lines.before.push(`${op.kind === "removed" ? "-" : " "}${op.base}: ${text}`);
        baseNumbers.push(op.base);
      }
      if (op.kind !== "removed") {
        lines.after.push(`${op.kind === "added" ? "+" : " "}${op.head}: ${text}`);
        headNumbers.push(op.head);
      }
    }
    return { base: rangeOf(baseNumbers), head: rangeOf(headNumbers), before: lines.before, after: lines.after };
  });
}

/**
 * The folder a rule applies to ("" is the whole repository). A nested AGENTS.md or CLAUDE.md
 * applies only to its own subtree; a file in `.claude/` or `.github/` speaks for the folder that
 * holds that folder; every other rule file is the repository's.
 */
export function ruleScope(path: string): string {
  const name = posix.basename(path).toLowerCase();
  if (name !== "agents.md" && name !== "claude.md") return "";
  let folder = posix.dirname(path);
  if (posix.basename(folder) === ".claude" || posix.basename(folder) === ".github") folder = posix.dirname(folder);
  return folder === "." ? "" : folder;
}

const inScope = (scope: string, path: string): boolean => scope === "" || path.startsWith(`${scope}/`);

/** A rule as the gate is shown it: the base's text, secrets withheld first, then cut with the cut counted. */
function ruleFacts(rule: Rule, baseText: string): RuleFacts {
  const text = withholdSecrets(sliceLines(baseText, rule.range));
  return {
    path: cap(rule.path, 200),
    kind: rule.kind,
    heading: safeClip(rule.heading),
    ancestors: rule.ancestorHeadings.map(safeClip),
    lines: rule.range,
    text: text.slice(0, MAX_RULE_CHARS),
    cutChars: Math.max(0, text.length - MAX_RULE_CHARS),
    scope: ruleScope(rule.path),
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
    return text === undefined ? [] : [{ rule, facts: ruleFacts(rule, text) }];
  });
  const files = comparison.changes.filter((change) => change.node.level === "file").sort((a, b) => (a.node.path < b.node.path ? -1 : a.node.path > b.node.path ? 1 : 0));
  for (const change of files) {
    const path = change.node.path;
    const basePath = change.kind === "moved" ? change.from.path : path;
    const nodes: NodeId[] = [change.node.id];
    const label = cap(change.kind === "moved" ? `moved ${change.from.path} to ${path}` : `${change.kind} ${path}`, 240);
    const before = change.kind === "added" ? "" : baseTree.get(basePath);
    const after = change.kind === "removed" ? "" : headTree.get(path);
    const hunks = before === undefined || after === undefined ? { skipped: "the file's text is not in the tree" } : hunksOf(before, after);
    if ("skipped" in hunks) {
      skipped.push({ status: "not judged", key: `standard:file:${path}`, about: { nodes }, reason: `${label}: ${hunks.skipped}, so its hunks were not judged against any rule` });
      continue;
    }
    for (const hunk of hunks) {
      for (const { rule, facts } of rules) {
        if (!inScope(facts.scope, path)) continue;
        const key = keyOf(rule, path, hunk);
        const about = { nodes, standard: { rule: { path: facts.path, heading: facts.heading, ancestors: facts.ancestors, lines: facts.lines, edited: facts.edited }, hunk: { path: cap(path, 200), base: hunk.base, head: hunk.head } } };
        if (items.length >= MAX_PAIRS) {
          skipped.push({ status: "not judged", key, about, reason: `over the cap of ${MAX_PAIRS} rule and hunk pairs asked per comparison; this pair was not asked` });
          continue;
        }
        items.push({ key, about, input: { rule: facts, hunk: { path: cap(path, 200), label, ...hunk } } });
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
  const run = await judgeItems({
    gate: standardGate,
    items,
    thresholds: STANDARD_THRESHOLDS,
    client: context.client,
    base: context.base,
    head: context.head,
    cacheDir: context.cacheDir,
    ...(context.events === undefined ? {} : { events: context.events }),
  });
  return skipped.length === 0 ? run : { ...run, outcomes: [...run.outcomes, ...skipped] };
};
