import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { judge } from "./client.ts";
import type { JevClient } from "./client.ts";
import { requestFor } from "./gate.ts";
import type { JudgeSubject } from "./subject.ts";
import type { Gate, Thresholds } from "./gate.ts";
import type { TierPick } from "../tier-table.ts";
import type { Tiering } from "../tier-facts.ts";
import type { About, JudgedDocument, JudgedRecord, JudgedSet } from "./judged-types.ts";

export type { About, JudgedDocument, JudgedRecord, JudgedSet } from "./judged-types.ts";

/** One thing to judge: where it attaches, and the gate's input for it. */
export interface Item<Input> {
  readonly key: string;
  readonly about: About;
  readonly input: Input;
  /** The thresholds this item is decided by, when they are its own (the gate's, plus the item's tier); the request's otherwise. */
  readonly thresholds?: Thresholds;
  /** The tier the item was picked, recorded with its answer. */
  readonly pick?: TierPick;
}

export type ItemOutcome =
  | { readonly status: "judged"; readonly record: JudgedRecord; /** Read from the store: no call was made. */ readonly cached: boolean }
  | { readonly status: "not judged"; readonly key: string; readonly about: About; readonly reason: string };

/** One item a run has still to ask, named by where its mark attaches. */
export interface PendingItem {
  readonly key: string;
  readonly about: About;
}

/**
 * What a run reports while it works, so the server can answer before the calls return. `plan` is
 * called once, after the store is read: the items already answered (from the store) and those still
 * to be asked. `outcome` is called as each asked item finishes.
 */
export interface JudgingEvents {
  plan(set: Pick<JudgedSet, "base" | "head" | "question" | "model">, known: readonly ItemOutcome[], pending: readonly PendingItem[]): void;
  outcome(gate: string, outcome: ItemOutcome): void;
}

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
  readonly events?: JudgingEvents;
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

/** A record on file with the thresholds, tier and verdict of this comparison's item: the answers are its own. */
function recordOf(known: JudgedRecord, thresholds: Thresholds, pick: TierPick | undefined, verdict: JudgedRecord["verdict"]): JudgedRecord {
  const { pick: was, ...rest } = known;
  void was;
  return { ...rest, thresholds, verdict, ...(pick === undefined ? {} : { pick }) };
}

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
  const { gate, items, thresholds, client, base, head, cacheDir, events } = request;
  const question = { id: gate.id, version: gate.version };
  const identity = { base, head, question, model: client.model };
  const file = fileOf(cacheDir, setKey(base, head, question, client.model));
  const saved = new Map((await readSet(file, identity)).map((record) => [record.key, record]));
  const outcomes: ItemOutcome[] = new Array<ItemOutcome>(items.length);
  let usd = 0;
  let costUnknown = 0;
  let calls = 0;
  const asked: number[] = [];
  items.forEach((item, index) => {
    const known = saved.get(item.key);
    if (known !== undefined && JSON.stringify(known.shown) === JSON.stringify(requestFor(gate, item.input))) {
      // The same request has the same answers. A verdict is a function of the answers and the thresholds, so a changed tier or
      // threshold is decided again here, from the answers on file, with no call.
      const own = item.thresholds ?? thresholds;
      const same = JSON.stringify(known.thresholds) === JSON.stringify(own) && JSON.stringify(known.pick) === JSON.stringify(item.pick);
      outcomes[index] = { status: "judged", record: same ? known : recordOf(known, own, item.pick, gate.decide(known.answers, own)), cached: true };
    } else asked.push(index);
  });
  events?.plan(identity, outcomes.filter((outcome) => outcome !== undefined), asked.map((index) => ({ key: items[index]!.key, about: items[index]!.about })));
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let slot = next++; slot < asked.length; slot = next++) {
      const index = asked[slot]!;
      const item = items[index]!;
      const shown = requestFor(gate, item.input);
      calls += 1;
      const judged = await judge(client, shown);
      if (judged.status === "not judged") {
        outcomes[index] = { status: "not judged", key: item.key, about: item.about, reason: judged.reason };
        events?.outcome(gate.id, outcomes[index]!);
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
        thresholds: item.thresholds ?? thresholds,
        verdict: gate.decide(judged.answers, item.thresholds ?? thresholds),
        ...(item.pick === undefined ? {} : { pick: item.pick }),
        model: judged.model,
        inputTokens: judged.usage.inputTokens,
        usd: judged.usage.usd,
      };
      outcomes[index] = { status: "judged", record, cached: false };
      events?.outcome(gate.id, outcomes[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, asked.length) }, worker));
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

/** What the server asks for the document: judging's state, and the runs of each gate for this comparison. */
export interface JudgedSource {
  readonly status: "on" | "off";
  /** Why judging is off. */
  readonly reason?: string;
  /** The reviewer's tier table and the stored vocabulary the tiers are picked from; the default table and no vocabulary when left out. */
  readonly tiering?: Tiering;
  /** How many gates will each call `events.plan` once (default one). */
  readonly gates?: number;
  load(subject: JudgeSubject, events?: JudgingEvents): Promise<readonly JudgedRun[]>;
}

export async function judgedDocument(source: JudgedSource | undefined, subject: JudgeSubject): Promise<JudgedDocument> {
  if (source === undefined || source.status === "off") {
    return { tier: "judged", status: "off", reason: source?.reason ?? "judging is off: pass --judge to send source text to TypeSafe", sets: [], notJudged: [], usd: 0, costUnknown: 0 };
  }
  return documentOf(await source.load(subject));
}

/** The finished document of a source that is on, from its runs. */
export function documentOf(runs: readonly JudgedRun[]): JudgedDocument {
  return {
    tier: "judged",
    status: "on",
    sets: runs.map((run) => run.set),
    notJudged: runs.flatMap((run) => run.outcomes.flatMap((outcome) => (outcome.status === "not judged" ? [{ gate: run.set.question.id, key: outcome.key, about: outcome.about, reason: outcome.reason }] : []))),
    usd: runs.reduce((sum, run) => sum + run.usd, 0),
    costUnknown: runs.reduce((sum, run) => sum + run.costUnknown, 0),
  };
}
