/**
 * The tier table: how sure a judged check must be before it may settle an item. No node imports:
 * the page reads this to say which tier was picked and why.
 *
 * A change item (a claim with its linked places, or one hunk) has a complexity, derived from the
 * graph, and stakes, judged and stored by `streets setup`. Each picks a tier of the reviewer's table
 * (three tiers, strictest first, 99.9% / 99% / 95% unless `--tiers` says otherwise). The strictest of
 * the two decides. The tier is only ever used to settle an item harder: it never loosens a gate's own
 * thresholds, and it never makes a flag, an undecided or a derived fact go away.
 *
 * The rule, in words (bar.md style), version 1:
 *
 *   Complexity picks the strictest tier when any of these holds, the middle tier when any of the
 *   next holds, and the loosest tier otherwise:
 *     - strict: the changed code reaches an effect (a call out to a process, the network, the file
 *       system, a queue, a timer or code loaded at run time), or 10 or more files rest on the changed
 *       files (the unread files that may rest on them count too), or 200 or more lines changed, or the
 *       number of changed lines is not known, or a changed file could not be read in full (what it
 *       calls out is not known), or the item names a place that is no change the comparison knows;
 *     - middle: 3 or more files rest on them, or 40 or more lines changed.
 *   Stakes pick the loosest tier only when every term a changed function belongs to is judged "no"
 *   for every kind of harm that may be judged now, completely (see stakes.ts): every kind asked of that
 *   term, every member shown, nothing cut, and every part of the item covered (a changed file with no
 *   changed function in it, a changed line outside every changed function, or a named place that is no
 *   known change, has no term to read). A term's stakes are complete only over every current member after
 *   a person's corrections: a function a person added to it was never judged. Any other state is possible
 *   harm and picks the strictest tier: could cause, unclear, stale, not judged, judged no over some of the
 *   code, a changed function mapped to no term, a member added by a person, a changed line outside every
 *   function, no stored vocabulary at all. Stakes unknown never read as none.
 *
 *   A settle over cut evidence is withheld too (see `verdictOf` in jev/gate.ts), whatever the tier.
 *
 * What a tier asks of a settle: with P(wrong) the chance that settling is a mistake, a settle needs
 * 1 - P(wrong) >= the tier. A probability that passes a gate's own settle limit but not the tier's
 * stays undecided; it is never settled. See `clearsTier`, and each gate's `decide` for its P(wrong).
 */

import type { LineRange, NodeId } from "./graph.ts";

/** Raise it when a cutoff or a word of the rule changes: a record says which rule picked its tier. */
export const TIER_RULE_VERSION = 1;

/** Three tiers in percent, strictest first. */
export type TierTable = readonly [number, number, number];

export const DEFAULT_TIERS: TierTable = [99.9, 99, 95];

/** 0 is the strictest tier, 2 the loosest. */
export type TierRank = 0 | 1 | 2;

/** The fixed cutoffs of the rule, written once. */
export const COMPLEXITY_CUTOFFS = {
  strict: { effects: 1, blastRadius: 10, lines: 200 },
  middle: { blastRadius: 3, lines: 40 },
} as const;

/** What code derives about an item's changed code. */
export interface ComplexityFacts {
  /** Files known to rest on the item's files (imports, directly or not). */
  readonly blastRadius: number;
  /** Files that could not be fully read and may rest on them too: possible, not known. They count toward the blast radius. */
  readonly unreadMayRest: number;
  /** The kinds of call out (an operation on a resource, such as network fetch) the changed code makes, or that came or went with the change. */
  readonly effects: number;
  /** Changed lines, added and removed; null when they are not known (binary, too large to diff). */
  readonly lines: number | null;
  /** Changed files that could not be read in full (a syntax error): the calls out they make are not known, so none is not known to be none. */
  readonly unreadFiles: number;
  /** Places the item names that are no change the comparison knows: what they changed is not known. */
  readonly unknownPlaces: number;
}

/** What is stored about the harm a mistake in the item's changed functions could cause. */
export type StakesFacts =
  /** Every function maps to terms judged no for every kind, completely. */
  | { readonly status: "none"; readonly terms: readonly string[] }
  /** At least one term could cause a harm. */
  | { readonly status: "could cause"; readonly harms: readonly string[] }
  /** Anything else: unknown, unclear, stale, not judged, over some of the code. Possible harm, never none. */
  | { readonly status: "possible"; readonly reason: string };

/** The tier an item got, and why, as recorded with its judged answer. */
export interface TierPick {
  /** The rule's version (TIER_RULE_VERSION). */
  readonly rule: number;
  /** The tier in percent, from the table: 99.9. */
  readonly percent: number;
  readonly rank: TierRank;
  /** The reasons that set the rank, in the page's words. */
  readonly why: readonly string[];
}

/**
 * What an item is about, for picking its tier: the changed nodes it names (a claim's linked places, or the
 * file of a hunk) and, for a hunk, the lines. Nothing here is text a model sees.
 */
export interface ItemScope {
  readonly ids: readonly NodeId[];
  readonly hunk?: { readonly head: LineRange | null; readonly base: LineRange | null };
}

/** Picks the tier of one item. The server builds it once per comparison, from the graphs and the stored vocabulary (see tier-facts.ts). */
export type TierPicker = (scope: ItemScope) => TierPick;

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

/** Three descending numbers in (0, 100), or one line saying what is wrong. */
export function parseTiers(text: string): TierTable | string {
  const parts = text.split(",").map((part) => part.trim());
  if (parts.length !== 3 || !parts.every((part) => /^\d+(?:\.\d+)?$/.test(part))) return `invalid --tiers: ${text}: give three numbers, strictest first, like --tiers 99.9,99,95`;
  const [strict, middle, loose] = parts.map(Number) as [number, number, number];
  if (![strict, middle, loose].every((value) => Number.isFinite(value) && value > 0 && value < 100)) return `invalid --tiers: ${text}: each tier must be above 0 and below 100`;
  if (!(strict > middle && middle > loose)) return `invalid --tiers: ${text}: the tiers must go down, strictest first`;
  return [strict, middle, loose];
}

/** The complexity's rank and the reasons that set it. */
export function complexityRank(facts: ComplexityFacts): { readonly rank: TierRank; readonly why: readonly string[] } {
  const reach = facts.blastRadius + facts.unreadMayRest;
  const rests = `${plural(facts.blastRadius, "file")} rest${facts.blastRadius === 1 ? "s" : ""} on it${facts.unreadMayRest > 0 ? `, and ${plural(facts.unreadMayRest, "unread file")} may` : ""}`;
  const strict: string[] = [];
  if (facts.effects >= COMPLEXITY_CUTOFFS.strict.effects) strict.push(`effects reached: ${plural(facts.effects, "kind")} of call out`);
  if (reach >= COMPLEXITY_CUTOFFS.strict.blastRadius) strict.push(`large blast radius: ${rests}`);
  if (facts.unreadFiles > 0) strict.push(`${plural(facts.unreadFiles, "changed file")} could not be read in full, so the calls out in it are not known`);
  if (facts.unknownPlaces > 0) strict.push(`${plural(facts.unknownPlaces, "named place")} ${facts.unknownPlaces === 1 ? "is" : "are"} no change this comparison knows`);
  if (facts.lines === null) strict.push("changed lines not known");
  else if (facts.lines >= COMPLEXITY_CUTOFFS.strict.lines) strict.push(`large change: ${plural(facts.lines, "line")} changed`);
  if (strict.length > 0) return { rank: 0, why: strict };
  const middle: string[] = [];
  if (reach >= COMPLEXITY_CUTOFFS.middle.blastRadius) middle.push(`blast radius: ${rests}`);
  if (facts.lines !== null && facts.lines >= COMPLEXITY_CUTOFFS.middle.lines) middle.push(`${plural(facts.lines, "line")} changed`);
  if (middle.length > 0) return { rank: 1, why: middle };
  return { rank: 2, why: [`small change: ${plural(facts.lines ?? 0, "line")} changed, ${plural(reach, "file")} may rest on it, no effect reached`] };
}

/** The stakes' rank and the reason that set it. */
export function stakesRank(facts: StakesFacts): { readonly rank: TierRank; readonly why: string } {
  if (facts.status === "none") return { rank: 2, why: `stakes: judged none in ${facts.terms.join(", ")}` };
  if (facts.status === "could cause") return { rank: 0, why: `stakes: could cause harm in ${facts.harms.join("; ")}` };
  return { rank: 0, why: `stakes: possible harm, ${facts.reason}` };
}

/** The tier for an item: the strictest of what its complexity and its stakes pick. */
export function pickTier(complexity: ComplexityFacts, stakes: StakesFacts, table: TierTable = DEFAULT_TIERS): TierPick {
  const byComplexity = complexityRank(complexity);
  const byStakes = stakesRank(stakes);
  const rank = Math.min(byComplexity.rank, byStakes.rank) as TierRank;
  const why = [...(byComplexity.rank === rank ? byComplexity.why : []), ...(byStakes.rank === rank ? [byStakes.why] : [])];
  return { rule: TIER_RULE_VERSION, percent: table[rank], rank, why };
}

/** The tier as a fraction: 0.999. Rounded so 99.9 / 100 carries no float tail into a comparison. */
export const tierLevel = (percent: number): number => Math.round(percent * 1e7) / 1e9;

/**
 * Whether a settle clears the tier: 1 - P(wrong) >= tier, compared to a billionth so that a
 * probability on the tier's own line (0.001 at 99.9%) settles and float noise does not unsettle it.
 * With no tier (a record written before tiers) there is nothing more to clear. A probability that
 * is not a number never clears.
 */
export function clearsTier(wrong: number, tier: number | undefined): boolean {
  if (tier === undefined) return true;
  return Math.round((1 - wrong) * 1e9) >= Math.round(tier * 1e9);
}

/** The picker of a caller that knows nothing of an item (a bench case has no comparison): everything unknown, so the strictest tier. */
export const unknownTier: TierPicker = () => pickTier({ blastRadius: 0, unreadMayRest: 0, effects: 0, lines: null, unreadFiles: 0, unknownPlaces: 0 }, { status: "possible", reason: "nothing is known of this item" });

/** A gate's own thresholds with the item's tier added, as the fraction a gate's `decide` reads in `tier`. */
export const withTier = (thresholds: Readonly<Record<string, number>>, pick: TierPick): Readonly<Record<string, number>> => ({ ...thresholds, tier: tierLevel(pick.percent) });

/** A tier fraction as the table writes it: 0.999 is "99.9%". */
export const tierPercent = (tier: number): string => `${Math.round(tier * 1e9) / 1e7}%`;

/** "tier 99.9%: effects reached: 2 kinds of call out; stakes: possible harm, ...". */
export const tierText = (pick: TierPick): string => `tier ${pick.percent}%: ${pick.why.join("; ")}`;
