import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { NodeId } from "../graph.ts";
import { judge } from "./client.ts";
import type { JevAnswer, JevClient, JevRequest } from "./client.ts";
import { requestFor } from "./gate.ts";
import type { Gate, Thresholds, Verdict } from "./gate.ts";

/**
 * Judged facts, kept apart from the graph and from the derived, observed and claimed tiers. A
 * record says what a classifier answered to one typed question about two things already on the
 * page. It attaches to graph nodes by id, or to one claim of the description by number; it holds
 * no node, so it can never create or change one.
 */
export type About =
  | { readonly nodes: readonly NodeId[] }
  | { readonly claim: number };

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

/** One thing to judge: where it attaches, and the gate's input for it. */
export interface Item<Input> {
  readonly key: string;
  readonly about: About;
  readonly input: Input;
}

export type ItemOutcome =
  | { readonly status: "judged"; readonly record: JudgedRecord; /** Read from the store: no call was made. */ readonly cached: boolean }
  | { readonly status: "not judged"; readonly key: string; readonly about: About; readonly reason: string };

export interface JudgeRequest<Input> {
  readonly gate: Gate<Input>;
  readonly items: readonly Item<Input>[];
  readonly thresholds: Thresholds;
  readonly client: JevClient;
  /** The tree digests of the comparison (see `treeDigest`). */
  readonly base: string;
  readonly head: string;
  /** Where judged sets are kept: `<cacheDir>/judged/`. */
  readonly cacheDir: string;
}

export interface JudgedRun {
  readonly set: JudgedSet;
  readonly outcomes: readonly ItemOutcome[];
  /** Dollars spent by this run's calls; zero when everything came from the store. */
  readonly usd: number;
  /** Calls whose cost is unknown; `usd` leaves them out. */
  readonly costUnknown: number;
  readonly calls: number;
}

const PARALLEL = 4;

/** A comparison, a question's version and a model make one key; the trees are named by digest. */
export function setKey(base: string, head: string, question: { id: string; version: string }, model: string): string {
  return createHash("sha256").update(JSON.stringify([base, head, question.id, question.version, model])).digest("hex");
}

const fileOf = (cacheDir: string, key: string): string => join(cacheDir, "judged", `${key}.json`);

async function readSet(file: string, expected: Pick<JudgedSet, "base" | "head" | "question" | "model">): Promise<readonly JudgedRecord[]> {
  try {
    const saved = JSON.parse(await readFile(file, "utf8")) as Partial<JudgedSet>;
    const same = saved.tier === "judged" && saved.base === expected.base && saved.head === expected.head && saved.model === expected.model && saved.question?.id === expected.question.id && saved.question.version === expected.question.version;
    return same && Array.isArray(saved.records) ? saved.records : [];
  } catch {
    return [];
  }
}

/**
 * Judges each item once per comparison. An item whose record is in the store, and whose exact
 * request is unchanged, is read back with no classifier call; the rest are asked. An item that
 * could not be judged is returned "not judged" with why and is never stored, so asking again tries
 * again. The store is one plain JSON file per (base tree, head tree, question version, model).
 */
export async function judgeItems<Input>(request: JudgeRequest<Input>): Promise<JudgedRun> {
  const { gate, items, thresholds, client, base, head, cacheDir } = request;
  const question = { id: gate.id, version: gate.version };
  const identity = { base, head, question, model: client.model };
  const file = fileOf(cacheDir, setKey(base, head, question, client.model));
  const saved = new Map((await readSet(file, identity)).map((record) => [record.key, record]));
  const outcomes: ItemOutcome[] = new Array<ItemOutcome>(items.length);
  let usd = 0;
  let costUnknown = 0;
  let calls = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < items.length; index = next++) {
      const item = items[index]!;
      const shown = requestFor(gate, item.input);
      const known = saved.get(item.key);
      if (known !== undefined && JSON.stringify(known.shown) === JSON.stringify(shown) && JSON.stringify(known.thresholds) === JSON.stringify(thresholds)) {
        outcomes[index] = { status: "judged", record: known, cached: true };
        continue;
      }
      calls += 1;
      const judged = await judge(client, shown);
      if (judged.status === "not judged") {
        outcomes[index] = { status: "not judged", key: item.key, about: item.about, reason: judged.reason };
        continue;
      }
      if (judged.usage.usd === null) costUnknown += 1;
      else usd += judged.usage.usd;
      const record: JudgedRecord = {
        tier: "judged",
        key: item.key,
        about: item.about,
        question,
        shown,
        answers: judged.answers,
        thresholds,
        verdict: gate.decide(judged.answers, thresholds),
        model: judged.model,
        inputTokens: judged.usage.inputTokens,
        usd: judged.usage.usd,
      };
      outcomes[index] = { status: "judged", record, cached: false };
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, worker));
  const records = outcomes.flatMap((outcome) => (outcome.status === "judged" ? [outcome.record] : []));
  const set: JudgedSet = { tier: "judged", ...identity, records };
  if (calls > 0 && records.length > 0) {
    try {
      await mkdir(join(cacheDir, "judged"), { recursive: true });
      await writeFile(file, `${JSON.stringify(set, null, 2)}\n`);
    } catch {
      // An unwritable store costs a call next time, nothing more.
    }
  }
  return { set, outcomes, usd, costUnknown, calls };
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
} & ({ readonly status: "off"; readonly reason: string } | { readonly status: "on" });

/** What the server asks for the document: judging's state, and the runs of each gate for this comparison. */
export interface JudgedSource {
  readonly status: "on" | "off";
  /** Why judging is off. */
  readonly reason?: string;
  load(): Promise<readonly JudgedRun[]>;
}

export async function judgedDocument(source: JudgedSource | undefined): Promise<JudgedDocument> {
  if (source === undefined || source.status === "off") {
    return { tier: "judged", status: "off", reason: source?.reason ?? "judging is off: pass --judge to send source text to TypeSafe", sets: [], notJudged: [], usd: 0, costUnknown: 0 };
  }
  const runs = await source.load();
  return {
    tier: "judged",
    status: "on",
    sets: runs.map((run) => run.set),
    notJudged: runs.flatMap((run) => run.outcomes.flatMap((outcome) => (outcome.status === "not judged" ? [{ gate: run.set.question.id, key: outcome.key, about: outcome.about, reason: outcome.reason }] : []))),
    usd: runs.reduce((sum, run) => sum + run.usd, 0),
    costUnknown: runs.reduce((sum, run) => sum + run.costUnknown, 0),
  };
}
