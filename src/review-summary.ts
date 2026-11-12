import type { ContractMoveKind } from "./compare.ts";
import { runningText } from "./observed-types.ts";
import type { ObservedDocument } from "./observed-types.ts";
import { signatureDiff } from "./review.ts";
import type { ContractRow, EffectGroup } from "./review.ts";
import type { ResourceKind } from "./graph.ts";

const OPEN = "([{";
const CLOSE = ")]}";

/** Splits at commas outside brackets and strings. */
function splitTop(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (quote !== "") {
      if (c === "\\") i += 1;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (OPEN.includes(c) || c === "<") depth += 1;
    else if (CLOSE.includes(c) || (c === ">" && text[i - 1] !== "=")) depth = Math.max(0, depth - 1);
    else if (c === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

/** The index of the bracket that closes the one at `open`, or -1. */
function closing(text: string, open: number): number {
  let depth = 0;
  let quote = "";
  for (let i = open; i < text.length; i += 1) {
    const c = text[i]!;
    if (quote !== "") {
      if (c === "\\") i += 1;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (OPEN.includes(c)) depth += 1;
    else if (CLOSE.includes(c)) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** An item without its `= default`. */
function withoutDefault(item: string): string {
  let depth = 0;
  for (let i = 0; i < item.length; i += 1) {
    const c = item[i]!;
    if (OPEN.includes(c)) depth += 1;
    else if (CLOSE.includes(c)) depth -= 1;
    else if (c === "=" && depth === 0 && item[i + 1] !== ">" && item[i + 1] !== "=" && !"=!<>".includes(item[i - 1] ?? "")) return item.slice(0, i).trim();
  }
  return item;
}

const keyOf = (item: string): string => (/^[^\s:=]+/.exec(withoutDefault(item))?.[0] ?? item).replace(/^\.\.\./, "").replace(/\?$/, "");

interface Parsed {
  readonly items: readonly string[];
  readonly rest: string;
  /** Everything before the parameter list: the name, `async`, `function*`. */
  readonly prefix: string;
}

function parse(signature: string): Parsed | undefined {
  const open = signature.indexOf("(");
  if (open === -1) return undefined;
  const end = closing(signature, open);
  if (end === -1) return undefined;
  let inside = signature.slice(open + 1, end).trim();
  if (inside.startsWith("{") && closing(inside, 0) === inside.length - 1) inside = inside.slice(1, -1);
  return { items: splitTop(inside), prefix: signature.slice(0, open).trim(), rest: signature.slice(end + 1).replace(/^\s*:\s*/, "").trim() };
}

/** What changed between two signatures: parameters added, removed or re-defaulted, and a changed return type. */
export interface SignatureChange {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly modified: readonly string[];
  readonly returns: { readonly before: string; readonly after: string } | null;
  /** The change as one line, empty when the signatures are the same. */
  readonly text: string;
}

export function signatureChange(before: string, after: string): SignatureChange {
  const from = parse(before);
  const to = parse(after);
  const finish = (added: string[], removed: string[], modified: string[], returns: SignatureChange["returns"], whole?: string): SignatureChange => ({
    added,
    removed,
    modified,
    returns,
    text: whole ?? [...added.map((a) => `+ ${a}`), ...removed.map((r) => `− ${r}`), ...modified.map((m) => `~ ${m}`), ...(returns === null ? [] : [`returns ${returns.before || "(none)"} → ${returns.after || "(none)"}`])].join("  "),
  });
  if (before === after) return finish([], [], [], null);
  if (from !== undefined && to !== undefined) {
    const was = new Map(from.items.map((item) => [keyOf(item), item]));
    const now = new Map(to.items.map((item) => [keyOf(item), item]));
    const added = [...now].filter(([key]) => !was.has(key)).map(([, item]) => withoutDefault(item));
    const removed = [...was].filter(([key]) => !now.has(key)).map(([, item]) => withoutDefault(item));
    const modified = [...now].filter(([key, item]) => was.has(key) && was.get(key) !== item).map(([key]) => key);
    const returns = from.rest === to.rest ? null : { before: from.rest, after: to.rest };
    const common = (items: readonly string[], other: ReadonlyMap<string, string>): string[] => items.map(keyOf).filter((key) => other.has(key));
    const sameOrder = common(from.items, now).join("\0") === common(to.items, was).join("\0");
    if (from.prefix !== to.prefix || !sameOrder) return finish([], [], [], null, "signature changed");
    const found = finish(added, removed, modified, returns);
    if (found.text !== "") return found;
  }
  const diff = signatureDiff(before, after);
  const text = [diff.removed === "" ? "" : `− ${diff.removed.trim()}`, diff.added === "" ? "" : `+ ${diff.added.trim()}`].filter((part) => part !== "").join("  ");
  return { added: [], removed: [], modified: [], returns: null, text };
}

/** All the calls of one resource kind, with the targets they name. A target of "unknown" or "none" is one of them. */
export interface ResourceSummary {
  readonly resource: ResourceKind;
  readonly calls: number;
  readonly targets: readonly EffectGroup[];
}

/** Groups in, in order, folded by resource: the order of the first group of each kind is kept. */
export function resourceSummaries(groups: readonly EffectGroup[]): ResourceSummary[] {
  const by = new Map<ResourceKind, EffectGroup[]>();
  for (const group of groups) by.set(group.resource, [...(by.get(group.resource) ?? []), group]);
  return [...by].map(([resource, targets]) => ({ resource, calls: targets.reduce((sum, group) => sum + group.rows.length, 0), targets }));
}

const directoryOf = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "(root)");

/** Contract rows by their file's folder, the folder with most first, then by name; the root folder after the named ones of its size. */
export function foldersOf(rows: readonly ContractRow[]): { folder: string; rows: ContractRow[] }[] {
  const by = new Map<string, ContractRow[]>();
  for (const row of rows) by.set(directoryOf(row.path), [...(by.get(directoryOf(row.path)) ?? []), row]);
  return [...by]
    .map(([folder, found]) => ({ folder, rows: found }))
    .sort((a, b) => b.rows.length - a.rows.length || (a.folder === "(root)" ? -1 : b.folder === "(root)" ? 1 : a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0));
}

/** Claims with no linked place first, so the gaps are read before the rest. Without links there is nothing to split. */
export function claimGroups<T extends { readonly ids: readonly string[] }>(claims: readonly T[], linkedByAgent: boolean): { name: "unlinked" | "linked" | "all"; items: T[] }[] {
  if (!linkedByAgent) return [{ name: "all", items: [...claims] }];
  return [
    { name: "unlinked" as const, items: claims.filter((claim) => claim.ids.length === 0) },
    { name: "linked" as const, items: claims.filter((claim) => claim.ids.length > 0) },
  ].filter((group) => group.items.length > 0);
}

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

/** A summary with the files that could not be read said beside it: a "none" is then of the readable files only. */
export function qualifyUnread(summary: string, unread: number): string {
  if (unread === 0) return summary;
  const said = `${plural(unread, "file")} could not be read`;
  return /^(none|nothing)( found)?$/.test(summary) ? `${summary} in readable files · ${said}` : `${summary} · ${said}`;
}

export function claimsSummary(description: string | null, claims: readonly { readonly ids: readonly string[] }[], link: "ok" | "off" | "failed", context = 0, judged = ""): string {
  if (description === null) return "no description";
  if (claims.length === 0) return context > 0 ? `no claims · ${plural(context, "context line")}` : "no claims read";
  const base = link !== "ok" ? `${plural(claims.length, "claim")}, not linked` : `${claims.filter((claim) => claim.ids.length > 0).length} of ${claims.length} linked`;
  // Judged marks, counted number first, after the links: "2 of 3 linked · 1 settled, 1 flagged, 1 not judged".
  return judged === "" ? base : `${base} · ${judged}`;
}

/**
 * The Unmentioned row. `moves` groups of identical-text moves hold `movedFiles` of the files; each group counts as one item, not as its files.
 * `agent` counts what only an agent's link covers; it stays in the row, so the row says "nothing" only when no change is uncovered and none rests on an agent's word.
 */
export function unmentionedSummary(found: { files: number | null; calls: number; changed?: number; sections?: number; moves?: number; movedFiles?: number; dependencies?: number; agent?: { files: number; calls: number; changed: number } }): string {
  const files = found.files === null ? null : found.files - (found.movedFiles ?? 0);
  const agent = found.agent ?? { files: 0, calls: 0, changed: 0 };
  const calls = (n: number): string => `${n} new ${n === 1 ? "call" : "calls"} out`;
  const changed = (n: number): string => `${n} ${n === 1 ? "effect" : "effects"} changed`;
  const parts = [
    files === null || files === 0 ? "" : plural(files, "file"),
    (found.sections ?? 0) === 0 ? "" : plural(found.sections ?? 0, "section"),
    (found.moves ?? 0) === 0 ? "" : plural(found.moves!, "move group"),
    found.calls === 0 ? "" : calls(found.calls),
    (found.changed ?? 0) === 0 ? "" : changed(found.changed!),
    (found.dependencies ?? 0) === 0 ? "" : plural(found.dependencies ?? 0, "dependency change"),
    agent.files === 0 ? "" : `${plural(agent.files, "file")} linked by the agent only`,
    agent.calls === 0 ? "" : `${calls(agent.calls)} linked by the agent only`,
    agent.changed === 0 ? "" : `${changed(agent.changed)} linked by the agent only`,
  ].filter((part) => part !== "");
  return parts.length === 0 ? (found.files === null ? "not checked, no description" : "nothing") : parts.join(" · ");
}

/** The empty state of the uncovered new calls out. Calls only an agent links stay counted, so it never says no call exists then. */
export function noNewCallsText(agentOnly: number, unread = 0): string {
  if (agentOnly > 0) return "Every other new call out is mentioned.";
  const none = "No new call reaches a process, the network, the file system, a timer or code loaded at run time";
  return unread === 0 ? `${none}.` : `${none} in the files that could be read; ${plural(unread, "file")} could not be read.`;
}

const CONTRACT_KINDS: readonly ContractMoveKind[] = ["changed", "effects", "removed", "unexported", "exposed", "moved", "added"];

export function contractsSummary(counts: Readonly<Record<ContractMoveKind, number>>, effectsChanged = 0): string {
  const parts = [...CONTRACT_KINDS.filter((kind) => counts[kind] > 0).map((kind) => `${counts[kind]} ${kind}`), ...(effectsChanged > 0 ? [`${effectsChanged} effects changed`] : [])];
  return parts.length === 0 ? "none" : parts.join(" · ");
}

export function testsSummary(observed: ObservedDocument | null, weakened: number): string {
  const changes = weakened > 0 ? `${weakened} weakened${observed === null ? " or removed" : ""}` : "";
  let run = "";
  if (observed !== null) {
    if (observed.status === "running") run = runningText(observed.stage);
    else if (observed.status === "ran") {
      const { pass, fail, skip } = observed.counts;
      const total = pass + fail + skip;
      const { control } = observed;
      const failed =
        control.status !== "ran"
          ? `${fail} fail of ${total} (no control run)`
          : `${control.counts.regression > 0 ? `${control.counts.regression} ${control.counts.regression === 1 ? "regression" : "regressions"}` : "no regressions"}${control.counts.environment > 0 ? ` · ${control.counts.environment} environment` : ""} of ${total}`;
      run = total === 0 ? "no results" : fail > 0 ? failed : [pass > 0 ? `${pass} pass` : "", skip > 0 ? `${skip} skip` : ""].filter((part) => part !== "").join(" · ");
    } else if (observed.status === "unreliable") run = "results unreliable";
    else if (observed.status === "failed") run = "run failed";
    else run = "not run";
  }
  return [run, changes].filter((part) => part !== "").join(" · ");
}
