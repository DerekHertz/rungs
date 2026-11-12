import type { ContractMove } from "../compare.ts";
import { effectLabel } from "../effects.ts";
import { diffText } from "../diff.ts";
import { isCodeNode } from "../graph.ts";
import type { Graph, NodeId } from "../graph.ts";
import { isBinary } from "../lines.ts";
import { WITHHELD, looksSecret, promptEffect, promptName, promptTarget } from "../prompt-safe.ts";
import { CLAIM_THRESHOLDS, MAX_CHANGED_LINES, MAX_FACTS, MAX_LINE_CHARS, MAX_PLACES, claimGate } from "./claim-gate.ts";
import type { ClaimInput, PlaceFacts } from "./claim-gate.ts";
import type { GateContext, GateRunner } from "./source.ts";
import { judgeItems } from "./store.ts";
import type { Item } from "./store.ts";
import type { JudgeSubject, Owners } from "./subject.ts";
import { withTier } from "../tier-table.ts";

/** The owning file and name of every node of `graph`, read from the nodes themselves. */
export function ownersOf(graph: Graph): Owners {
  return new Map(graph.nodes.map((node) => [node.id, { path: node.path, name: isCodeNode(node) ? node.qualifiedName : "" }]));
}

/** A quoted literal (the quote kinds a source line uses), escapes included. */
const QUOTED = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
/** A run of the characters a secret is made of; a trailing "." belongs to the sentence, not the token. */
const TOKEN = /[A-Za-z0-9+/_=.-]*[A-Za-z0-9+/_=-]/g;

/**
 * Source text as the gate is sent it: every quoted literal or bare token that has a secret's shape
 * (see looksSecret) becomes "withheld", the quotes of a literal kept. The rest of the text stays,
 * since the gate needs it. Withholding comes before any clipping, so a cut cannot leave half a key.
 */
export function withholdSecrets(text: string): string {
  const quoted = text.replace(QUOTED, (literal) => {
    const inner = literal.slice(1, -1);
    const mark = literal[0]!;
    if (URL_LITERAL.test(inner)) return `${mark}${hostOnly(inner)}${mark}`;
    return looksSecret(inner) ? `${mark}${WITHHELD}${mark}` : literal;
  });
  const urls = quoted.replace(BARE_URL, (url) => hostOnly(url));
  return urls.replace(TOKEN, (token) => (looksSecret(token) ? WITHHELD : token));
}

/** A URL as an agent's prompt shows an effect target: scheme and host only, or "withheld". */
const hostOnly = (url: string): string => promptTarget("network", url);
/** A quoted literal that is a whole URL: with a scheme, or a dotted host followed by a path, query or fragment. */
const URL_LITERAL = /^(?:[a-z][a-z0-9+.-]*:\/\/\S+|[\w-]+(?:\.[\w-]+)+(?::\d+)?[/?#]\S*)$/i;
/** A URL with a scheme inside other text; it ends at a space, a quote or a bracket. */
const BARE_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>()[\]{},;]+/gi;

/** A line of source text as the gate is sent it, and whether it was clipped: the caller that builds evidence counts the clips, so a clipped line is never read as whole. */
export function clipText(text: string): { readonly text: string; readonly clipped: boolean } {
  const safe = withholdSecrets(text);
  return safe.length > MAX_LINE_CHARS ? { text: `${safe.slice(0, MAX_LINE_CHARS)}...`, clipped: true } : { text: safe, clipped: false };
}
/** A line of source text (a signature, a contract, a changed line) as the gate is sent it. Use `clipText` where the evidence must say it was clipped. */
export const safeClip = (text: string): string => clipText(text).text;

/** What one linked file is shown as: derived facts from the comparison, and its changed lines from a line diff of the two trees. */
function placeOf(id: NodeId, subject: JudgeSubject): PlaceFacts | undefined {
  const { comparison, contracts, baseTree, headTree } = subject;
  const inHead = (id: NodeId, file: string): boolean => subject.head.get(id)?.path === file;
  const inBase = (id: NodeId, file: string): boolean => subject.base.get(id)?.path === file;
  const change = comparison.changes.find((found) => found.node.id === id);
  if (change === undefined) return undefined;
  const path = change.node.path;
  const basePath = change.kind === "moved" ? change.from.path : change.kind === "removed" ? change.node.path : path;
  const label = change.kind === "moved" ? `moved ${change.from.path} to ${path}` : `${change.kind} ${path}`;

  // Every line and fact of the place goes through here, so the place says whether any was clipped (counting the ones past the caps too: those are cut as well).
  let clipped = false;
  const safeClip = (text: string): string => {
    const found = clipText(text);
    if (found.clipped) clipped = true;
    return found.text;
  };
  const facts: string[] = [];
  for (const other of comparison.changes) {
    if (other.node.path !== path || !isCodeNode(other.node)) continue;
    const signature = other.kind === "altered" && isCodeNode(other.before) && other.before.signature !== other.node.signature ? `: ${safeClip(other.before.signature)} -> ${safeClip(other.node.signature)}` : "";
    facts.push(`${other.kind} ${other.node.level} ${promptName(other.node.qualifiedName)}${signature}`);
  }
  // A move names the head node (the base node for a removed one, the old id too for a moved one); the owning file comes from the graph's node.
  const inFile = (move: ContractMove): boolean => inHead(move.id, path) || inBase(move.id, basePath) || (move.from !== undefined && inBase(move.from, basePath));
  for (const move of contracts.filter(inFile)) {
    const name = promptName(move.type?.name ?? move.exportName ?? subject.head.get(move.id)?.name ?? subject.base.get(move.id)?.name ?? "");
    facts.push(`contract ${move.kind} ${name}: ${move.before === null ? "(none)" : safeClip(move.before)} -> ${move.after === null ? "(none)" : safeClip(move.after)}`);
    for (const effect of move.effects?.added ?? []) facts.push(`  effect gained by ${name}: ${promptEffect(effect)}`);
    for (const effect of move.effects?.removed ?? []) facts.push(`  effect lost by ${name}: ${promptEffect(effect)}`);
  }
  for (const effect of comparison.effects) {
    if (effect.kind === "added" ? inHead(effect.edge.from, path) : inBase(effect.edge.from, basePath)) facts.push(`effect call ${effect.kind}: ${promptEffect(effectLabel(effect.edge))}`);
  }
  // Calls that stay but take other arguments, worded as the page words them: "+" what the head gained, "−" what it lost.
  for (const changed of comparison.changedEffects) {
    if (!inHead(changed.owner, path)) continue;
    const count = changed.count > 1 ? ` x${changed.count}` : "";
    facts.push(`effect call changed: ${promptEffect(changed.label)}${count}: ${[...changed.added.map((token) => `+ ${safeClip(token)}`), ...changed.removed.map((token) => `− ${safeClip(token)}`)].join(" ")}`);
  }
  const shownFacts = facts.slice(0, MAX_FACTS);
  const cutFacts = facts.length - shownFacts.length;

  const before = change.kind === "added" ? "" : baseTree.get(basePath);
  const after = change.kind === "removed" ? "" : headTree.get(path);
  if (before === undefined || after === undefined) return { label, facts: shownFacts, cutFacts, clipped, lines: [], cutLines: 0, noLines: "the file's text is not in the tree" };
  if (isBinary(before) || isBinary(after)) return { label, facts: shownFacts, cutFacts, clipped, lines: [], cutLines: 0, noLines: "binary file" };
  let ops;
  try {
    ops = diffText(before, after);
  } catch {
    ops = undefined;
  }
  if (ops === undefined) return { label, facts: shownFacts, cutFacts, clipped, lines: [], cutLines: 0, noLines: "too large to diff" };
  const changed = ops.flatMap((op) => (op.kind === "added" ? [`+${op.head}: ${safeClip(op.text)}`] : op.kind === "removed" ? [`-${op.base}: ${safeClip(op.text)}`] : []));
  if (changed.length === 0) return { label, facts: shownFacts, cutFacts, clipped, lines: [], cutLines: 0, noLines: change.kind === "moved" ? "moved with no line changed" : "no line changed" };
  return { label, facts: shownFacts, cutFacts, clipped, lines: changed.slice(0, MAX_CHANGED_LINES), cutLines: Math.max(0, changed.length - MAX_CHANGED_LINES) };
}

/** One item per claim that has links: its sentence, and the facts and changed lines of its linked places. Unlinked claims are not judged. */
export function claimItems(subject: JudgeSubject): Item<ClaimInput>[] {
  return subject.claims
    .filter((claim) => claim.ids.length > 0)
    .map((claim) => {
      const places = claim.ids.flatMap((id) => placeOf(id, subject) ?? []);
      const input: ClaimInput = { claim: claim.text, places: places.slice(0, MAX_PLACES), omittedPlaces: Math.max(0, places.length - MAX_PLACES) };
      // The claim's tier comes from the places it is linked to: how big and how far-reaching they changed, and what harm a mistake there could cause.
      const pick = subject.tiers({ ids: claim.ids });
      return { key: `claim:${claim.index}`, about: { claim: claim.index }, input, thresholds: withTier(CLAIM_THRESHOLDS, pick), pick };
    });
}

/** The claim gate's runner: judges each linked claim once per comparison, through the judged store. */
export const claimRunner: GateRunner = (context: GateContext) =>
  judgeItems({
    gate: claimGate,
    items: claimItems(context.subject),
    thresholds: CLAIM_THRESHOLDS,
    client: context.client,
    base: context.base,
    head: context.head,
    cacheDir: context.cacheDir,
    ...(context.events === undefined ? {} : { events: context.events }),
  });
