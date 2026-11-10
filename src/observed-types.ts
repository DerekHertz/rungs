/** The observed tier as /observed.json serves it; free of node so the page can read it too. */

export type Outcome = "pass" | "fail" | "skip";
export type Runner = "node" | "vitest";

export interface ObservedTest {
  /** The suite titles and the test's own, joined with " > ". */
  readonly name: string;
  readonly outcome: Outcome;
  readonly ms: number;
  readonly message?: string;
}

export interface UnmatchedTest extends ObservedTest {
  readonly file: string;
  readonly why: string;
}

export interface Counts {
  readonly pass: number;
  readonly fail: number;
  readonly skip: number;
}

/**
 * Observed facts, served at /observed.json: one run of one tree, keyed by the tree's digest and
 * kept apart from the graph. `tests` attaches results to test function nodes by id; a result no
 * single test function matches is listed in `unmatched` with why.
 */
export type ObservedDocument = { readonly tier: "observed"; readonly tree: string } & (
  | { readonly status: "refused" | "unsupported"; readonly why: string }
  | {
      readonly status: "failed";
      readonly why: string;
      readonly runner: Runner;
      readonly sandbox: "bwrap" | "unsandboxed";
      readonly seconds: number;
      readonly output: string;
    }
  | {
      /** The run's results contradict the runner or each other: none is served, only why. */
      readonly status: "unreliable";
      readonly why: string;
      readonly runner: Runner;
      readonly sandbox: "bwrap" | "unsandboxed";
      readonly seconds: number;
      readonly exitCode: number;
    }
  | {
      readonly status: "ran";
      readonly runner: Runner;
      readonly sandbox: "bwrap" | "unsandboxed";
      readonly seconds: number;
      readonly exitCode: number;
      readonly counts: Counts;
      readonly tests: Readonly<Record<string, readonly ObservedTest[]>>;
      readonly unmatched: readonly UnmatchedTest[];
    }
);
