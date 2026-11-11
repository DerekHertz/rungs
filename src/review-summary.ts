import type { ContractMoveKind } from "./compare.ts";
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
    else if (OPEN.includes(c)) depth += 1;
    else if (CLOSE.includes(c)) depth -= 1;
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

const keyOf = (item: string): string => /^[^\s:=]+/.exec(withoutDefault(item))?.[0] ?? item;

interface Parsed {
  readonly items: readonly string[];
  readonly rest: string;
}

function parse(signature: string): Parsed | undefined {
  const open = signature.indexOf("(");
  if (open === -1) return undefined;
  const end = closing(signature, open);
  if (end === -1) return undefined;
  let inside = signature.slice(open + 1, end).trim();
  if (inside.startsWith("{") && closing(inside, 0) === inside.length - 1) inside = inside.slice(1, -1);
  return { items: splitTop(inside), rest: signature.slice(end + 1).replace(/^\s*:\s*/, "").trim() };
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
  const finish = (added: string[], removed: string[], modified: string[], returns: SignatureChange["returns"]): SignatureChange => ({
    added,
    removed,
    modified,
    returns,
    text: [...added.map((a) => `+ ${a}`), ...removed.map((r) => `− ${r}`), ...modified.map((m) => `~ ${m}`), ...(returns === null ? [] : [`returns ${returns.before || "(none)"} → ${returns.after || "(none)"}`])].join("  "),
  });
  if (before === after) return finish([], [], [], null);
  if (from !== undefined && to !== undefined) {
    const was = new Map(from.items.map((item) => [keyOf(item), item]));
    const now = new Map(to.items.map((item) => [keyOf(item), item]));
    const added = [...now].filter(([key]) => !was.has(key)).map(([, item]) => withoutDefault(item));
    const removed = [...was].filter(([key]) => !now.has(key)).map(([, item]) => withoutDefault(item));
    const modified = [...now].filter(([key, item]) => was.has(key) && was.get(key) !== item).map(([key]) => key);
    const returns = from.rest === to.rest ? null : { before: from.rest, after: to.rest };
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

export function claimsSummary(description: string | null, claims: readonly { readonly ids: readonly string[] }[], link: "ok" | "off" | "failed"): string {
  if (description === null) return "no description";
  if (claims.length === 0) return "no claims read";
  if (link !== "ok") return `${plural(claims.length, "claim")}, not linked`;
  return `${claims.filter((claim) => claim.ids.length > 0).length} of ${claims.length} linked`;
}

export function unmentionedSummary(found: { files: number | null; calls: number }): string {
  const parts = [found.files === null || found.files === 0 ? "" : plural(found.files, "file"), found.calls === 0 ? "" : `${found.calls} new ${found.calls === 1 ? "call" : "calls"} out`].filter((part) => part !== "");
  return parts.length === 0 ? "nothing" : parts.join(" · ");
}

const CONTRACT_KINDS: readonly ContractMoveKind[] = ["changed", "effects", "removed", "unexported", "exposed", "moved", "added"];

export function contractsSummary(counts: Readonly<Record<ContractMoveKind, number>>): string {
  const parts = CONTRACT_KINDS.filter((kind) => counts[kind] > 0).map((kind) => `${counts[kind]} ${kind}`);
  return parts.length === 0 ? "none" : parts.join(" · ");
}

export function testsSummary(observed: ObservedDocument | null, weakened: number): string {
  const changes = weakened > 0 ? `${weakened} weakened${observed === null ? " or removed" : ""}` : "";
  let run = "";
  if (observed !== null) {
    if (observed.status === "ran") {
      const { pass, fail, skip } = observed.counts;
      const total = pass + fail + skip;
      run = total === 0 ? "no results" : fail > 0 ? `${fail} fail of ${total}` : `${total} ran, none fail`;
    } else if (observed.status === "unreliable") run = "results unreliable";
    else if (observed.status === "failed") run = "run failed";
    else run = "not run";
  }
  return [run, changes].filter((part) => part !== "").join(" · ");
}
