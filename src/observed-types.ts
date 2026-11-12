/** The observed tier as /observed.json serves it; free of node so the page can read it too. */

export type Outcome = "pass" | "fail" | "skip";
/** Only node's own runner: any other is a dependency the change installs, and the change picks it. */
export type Runner = "node";

/** Said by the Observed section, the panel and the CLI wherever a result is shown. */
export const EVIDENCE_LINE = "Evidence against mistakes, not against a hostile author: the PR's code runs inside each test.";
/** The label on every result of a run that had no sandbox. */
export const UNSANDBOXED_LINE = "ran without a sandbox: as trustworthy as the PR's author";

/** What the runner gave of a failure beyond its message; each part only when the run produced it. */
export interface FailureDetail {
  /** The assertion's operator, such as "strictEqual". */
  readonly operator?: string;
  /** The values an assertion compared, as the runner printed them; multiline ones keep their lines. */
  readonly expected?: string;
  readonly actual?: string;
  /** The line of the test's own file that the failure's stack names first. */
  readonly line?: number;
}

/** The longest message or value kept of a failure. */
export const FAILURE_LIMIT = 2000;

/** `text` cut to `limit` characters, saying how many were left out. */
export function bounded(text: string, limit: number = FAILURE_LIMIT): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}… ${text.length - limit} more characters`;
}

export interface ObservedTest {
  /** The suite titles and the test's own, joined with " > ". */
  readonly name: string;
  readonly outcome: Outcome;
  readonly ms: number;
  readonly message?: string;
  readonly detail?: FailureDetail;
}

export interface UnmatchedTest extends ObservedTest {
  readonly file: string;
  readonly why: string;
}

export interface WrittenTest extends ObservedTest {
  readonly file: string;
}

export interface Counts {
  readonly pass: number;
  readonly fail: number;
  readonly skip: number;
}

/**
 * The tests the change wrote or edited, run by themselves. Their author is the change, so what
 * they show is claimed, never evidence.
 */
export type WrittenDocument = {
  readonly tier: "claimed";
  readonly files: readonly string[];
  readonly seconds: number;
} & (
  | { readonly status: "failed" | "unreliable"; readonly why: string }
  | { readonly status: "ran"; readonly exitCode: number; readonly counts: Counts; readonly tests: readonly WrittenTest[] }
);

/**
 * Observed facts, served at /observed.json: one run of one tree, keyed by the tree's digest and
 * kept apart from the graph. The tests that count are the base's, run against the head's code.
 * `tests` attaches their results to the head's test function nodes by id, for each file the change
 * left as it was; a result no single test function matches, or from a file the change edited or
 * deleted, is listed in `unmatched` with why. `deleted` and `edited` name the base test files the
 * change deleted or edited, whose base versions ran. `written` is what the change's own tests did.
 * While the run is under way the document is `running` and holds nothing else; the page reads it again until it is not.
 */
export type ObservedDocument = { readonly tier: "observed"; readonly tree: string } & (
  /** The server is listening and the run is still going: no count, no failure, no result yet. Unknown, never zero. */
  | { readonly status: "running" }
  /** `stopped`: the run itself threw, so no test ran; the server stays up and `why` says what happened. */
  | { readonly status: "refused" | "unsupported" | "stopped"; readonly why: string }
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
      readonly deleted: readonly string[];
      readonly edited: readonly string[];
      readonly written: WrittenDocument | null;
    }
);
