import type { LineRange, NodeId } from "../graph.ts";
import type { JevAnswer, JevRequest } from "./client.ts";
import type { Thresholds, Verdict } from "./gate.ts";

/** The shape of what /judged.json serves, with no node imports, so the page can read it. */

/**
 * Judged facts, kept apart from the graph and from the derived, observed and claimed tiers. A
 * record says what a classifier answered to one typed question about two things already on the
 * page. It attaches to graph nodes by id, or to one claim of the description by number; it holds
 * no node, so it can never create or change one.
 */
export type About =
  | { readonly nodes: readonly NodeId[]; readonly standard?: StandardAbout }
  | { readonly claim: number };

/** What a standard record is about besides the file node it attaches to: the rule (in the base) and the hunk (in the two trees). Plain text and numbers: no node. */
export interface StandardAbout {
  readonly rule: { readonly path: string; readonly heading: string; readonly ancestors: readonly string[]; readonly lines: LineRange; readonly edited: boolean | null };
  readonly hunk: { readonly path: string; readonly base: LineRange | null; readonly head: LineRange | null };
}

export interface JudgedRecord {
  readonly tier: "judged";
  /** The item within its gate's set, unique there (for a claim, its number). */
  readonly key: string;
  readonly about: About;
  readonly question: { readonly id: string; readonly version: string };
  /** The exact request Jev was sent: the state it was shown and the questions it was asked. */
  readonly shown: JevRequest;
  readonly answers: Readonly<Record<string, JevAnswer>>;
  readonly thresholds: Thresholds;
  readonly verdict: Verdict;
  /** The model version that answered. */
  readonly model: string;
  /** Null when the service did not report a valid count: the cost is unknown, not zero. */
  readonly inputTokens: number | null;
  readonly usd: number | null;
}

/** Everything one gate judged in one comparison. */
export interface JudgedSet {
  readonly tier: "judged";
  readonly base: string;
  readonly head: string;
  readonly question: { readonly id: string; readonly version: string };
  readonly model: string;
  readonly records: readonly JudgedRecord[];
}

/**
 * Served at /judged.json, apart from every other tier. `off` says why nothing was judged (the
 * reviewer did not pass --judge, or there is no key); each `notJudged` entry says why one check
 * has no answer. With judging off the page is today's page.
 */
export type JudgedDocument = {
  readonly tier: "judged";
  readonly sets: readonly JudgedSet[];
  readonly notJudged: readonly { readonly gate: string; readonly key: string; readonly about: About; readonly reason: string }[];
  /** Dollars of the calls whose cost is known. */
  readonly usd: number;
  /** Calls whose cost is unknown (shown as unknown, never as free). */
  readonly costUnknown: number;
} & (
  | { readonly status: "off"; readonly reason: string }
  /** `runFailed` is set when the whole run threw: every check without an answer then says so. */
  | { readonly status: "on"; readonly runFailed?: string }
  /** The server is listening and the calls are still out: `pending` names the checks not yet answered; `sets` and `notJudged` hold those that have been. */
  | { readonly status: "pending"; readonly pending: readonly { readonly gate: string; readonly key: string; readonly about: About }[] }
);

