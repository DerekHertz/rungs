import type { JudgeSubject } from "./subject.ts";
import type { About, JudgedDocument, JudgedRecord, JudgedSet } from "./judged-types.ts";
import { documentOf } from "./store.ts";
import type { ItemOutcome, JudgedSource, JudgingEvents } from "./store.ts";

/** A judging run under way: the document for any moment, built from what has been answered so far. */
export interface Judging {
  document(): Promise<JudgedDocument>;
}

interface GateState {
  readonly identity: Pick<JudgedSet, "base" | "head" | "question" | "model">;
  readonly outcomes: Map<string, ItemOutcome>;
  readonly pending: Map<string, About>;
}

const keyOf = (outcome: ItemOutcome): string => (outcome.status === "judged" ? outcome.record.key : outcome.key);

const off = (source: JudgedSource | undefined): JudgedDocument => ({
  tier: "judged",
  status: "off",
  reason: source?.reason ?? "judging is off: pass --judge to send source text to TypeSafe",
  sets: [],
  notJudged: [],
  usd: 0,
  costUnknown: 0,
});

/**
 * Starts the source's run in the background and returns at once. `document()` waits only until
 * every gate has read its store (so a run answered wholly from the store never shows a pending
 * phase), then gives the finished document, or, while calls are out, a "pending" one that names
 * the checks still being asked. A run that throws ends as a finished document in which every
 * check without an answer is "not judged" with the reason; it never reaches the server.
 */
export function beginJudging(source: JudgedSource | undefined, subject: JudgeSubject): Judging {
  if (source === undefined || source.status === "off") {
    const finished = off(source);
    return { document: () => Promise.resolve(finished) };
  }
  const gates = new Map<string, GateState>();
  const expected = source.gates ?? 1;
  let finished: JudgedDocument | undefined;
  let planned: () => void = () => {};
  const allPlanned = new Promise<void>((resolve) => (planned = resolve));
  const events: JudgingEvents = {
    plan(identity, known, pending) {
      const state: GateState = { identity, outcomes: new Map(known.map((outcome) => [keyOf(outcome), outcome])), pending: new Map(pending.map((item) => [item.key, item.about])) };
      gates.set(identity.question.id, state);
      if (gates.size >= expected) planned();
    },
    outcome(gate, outcome) {
      const state = gates.get(gate);
      if (state === undefined) return;
      state.pending.delete(keyOf(outcome));
      state.outcomes.set(keyOf(outcome), outcome);
    },
  };
  const snapshot = (): { sets: JudgedSet[]; notJudged: { gate: string; key: string; about: About; reason: string }[]; usd: number; costUnknown: number } => {
    const sets: JudgedSet[] = [];
    const notJudged: { gate: string; key: string; about: About; reason: string }[] = [];
    let usd = 0;
    let costUnknown = 0;
    for (const [gate, state] of gates) {
      const records: JudgedRecord[] = [];
      for (const outcome of state.outcomes.values()) {
        if (outcome.status === "not judged") notJudged.push({ gate, key: outcome.key, about: outcome.about, reason: outcome.reason });
        else {
          records.push(outcome.record);
          if (!outcome.cached) {
            if (outcome.record.usd === null) costUnknown += 1;
            else usd += outcome.record.usd;
          }
        }
      }
      sets.push({ tier: "judged", ...state.identity, records });
    }
    return { sets, notJudged, usd, costUnknown };
  };
  const stillPending = (): { gate: string; key: string; about: About }[] => [...gates].flatMap(([gate, state]) => [...state.pending].map(([key, about]) => ({ gate, key, about })));
  const done = source.load(subject, events).then(
    (runs) => {
      finished = documentOf(runs);
    },
    (error: unknown) => {
      const reason = `judging failed: ${error instanceof Error ? error.message : String(error)}`;
      const partial = snapshot();
      finished = { tier: "judged", ...partial, notJudged: [...partial.notJudged, ...stillPending().map((item) => ({ ...item, reason }))], status: "on", runFailed: reason };
    },
  );
  return {
    async document() {
      await Promise.race([allPlanned, done]);
      // Nothing to ask: the run is only writing down what the store held, so wait for it rather than show an empty pending phase.
      if (finished === undefined && stillPending().length === 0) await done;
      if (finished !== undefined) return finished;
      return { tier: "judged", ...snapshot(), status: "pending", pending: stillPending() };
    },
  };
}
