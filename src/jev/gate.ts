import type { JevAnswer, JevQuestion, JevRequest } from "./client.ts";

/**
 * What a threshold turns a probability into. Settled folds to one line and stays in its count;
 * flagged and undecided go on to a person (or, later, an escalation model). Nothing judged
 * removes a derived fact.
 */
export type Verdict = "settled" | "flagged" | "undecided";

/** A cutoff per question, chosen by the change's complexity and stakes. Recorded with every answer. */
export type Thresholds = Readonly<Record<string, number>>;

/**
 * One gate: a question and how to build what Jev is shown. `Input` is whatever the gate judges
 * (a claim with the changes it is linked to, a hunk with a rule). The questions are constants, so
 * repository text can only reach `state`, where it is data.
 */
export interface Gate<Input> {
  /** Stable name, e.g. "claim". */
  readonly id: string;
  /** Changes whenever the questions, the state's shape or `decide` change; part of every cache key. */
  readonly version: string;
  readonly questions: Readonly<Record<string, JevQuestion>>;
  /**
   * The questions for one input, when they depend on it. Only for a gate whose question is chosen
   * from constants the gate ships with (the stakes gate asks one question per kind of harm, taken
   * from the catalogue), never from repository text. Without it, `questions` is what is asked.
   */
  questionsFor?(input: Input): Readonly<Record<string, JevQuestion>>;
  /** What Jev is shown for one input: named pieces of text, all data. */
  state(input: Input): Readonly<Record<string, string>>;
  /**
   * What `state` left out of one input, in words, empty when Jev was shown all of it. Whatever clips, truncates or
   * drops evidence says so here from its own counts, never from the state's text, so a reader that must know whether
   * "nothing wrong found" was said over whole evidence reads this and nothing else.
   */
  cut?(input: Input): readonly string[];
  /** Settled, flagged or undecided from the probabilities and the thresholds. */
  decide(answers: Readonly<Record<string, JevAnswer>>, thresholds: Thresholds): Verdict;
}

/** The exact request a gate sends for one input. */
export function requestFor<Input>(gate: Gate<Input>, input: Input): JevRequest {
  return { state: gate.state(input), questions: gate.questionsFor?.(input) ?? gate.questions };
}

/** The "yes" probability of a yes/no answer; undefined when the answer is missing or another type. */
export function yesOf(answers: Readonly<Record<string, JevAnswer>>, name: string): number | undefined {
  const answer = answers[name];
  return answer?.type === "yes-no" ? answer.yes : undefined;
}

/** What a gate's `decide` returns for answers it cannot read: never settled. */
export const UNREADABLE: Verdict = "undecided";
