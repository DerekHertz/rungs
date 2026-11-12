import { runningText } from "./observed-types.ts";
import type { WalkNote } from "./stops.ts";

/** What the opening view says about the run: what is compared, and what a reviewer can open straight away. */

/** One entry of the opening view: its words, and whether it opens anything. */
export interface Entry {
  readonly label: string;
  readonly enabled: boolean;
  /** Why it is disabled, or what it does; shown as the entry's title. */
  readonly note: string;
}

const plural = (count: number, one: string): string => `${count} ${count === 1 ? one : `${one}s`}`;

/** The pull request a run was opened from, as the page names it. */
export interface PullRequestName {
  readonly number: number;
  readonly title: string;
  /** The head commit. */
  readonly head: string;
}

/**
 * "docviz against pr14-base at 31163ce (merge base)": the repository when known, then the comparison target.
 * For a pull request: "PR #14: title, head 9fdc980 against main at 31163ce (merge base)".
 */
export function comparedLine(repo: string | null, against: { readonly ref: string; readonly commit: string; readonly pr?: PullRequestName }): string {
  const target = `against ${against.ref} at ${against.commit.slice(0, 7)} (merge base)`;
  if (against.pr !== undefined) return `PR #${against.pr.number}: ${against.pr.title}, head ${against.pr.head.slice(0, 7)} ${target}`;
  return `${repo === null ? "" : `${repo} `}${target}`;
}

/** The tests entry. `status` is the observed document's, or "absent" when the tests were not asked to run; `failing` counts the failures of a run. */
export function failingEntry(
  status: "ran" | "running" | "failed" | "unreliable" | "refused" | "unsupported" | "stopped" | "absent",
  failing: number,
  /** `stage`: which run is going. `noControl`: why the control run gave nothing, so `failing` is the head run's failures. `others`: the other results of a run with a control run (environment, fixed, skipped). */
  how: { readonly stage?: "tests" | "control"; readonly noControl?: string; readonly others?: number } = {},
): Entry {
  if (status === "ran") {
    if (failing === 0) {
      const others = how.others ?? 0;
      return others > 0
        ? { label: `No regressions (${plural(others, "other result")})`, enabled: true, note: "No test passes on main and fails with this PR. Opens the rest: environment failures, fixed tests and tests only one run reported." }
        : { label: "No failing tests", enabled: false, note: "Main's tests ran against this PR and none failed." };
    }
    return how.noControl === undefined
      ? { label: `Inspect ${plural(failing, "failing test")}`, enabled: true, note: "Opens the regressions: tests that pass on main and fail with this PR, observed by running main's tests against both." }
      : { label: `Inspect ${plural(failing, "failing test")} (no control run: ${how.noControl})`, enabled: true, note: "Main's tests failed against this PR, and the control run on main's own code gave no results, so these are not known to be this PR's doing." };
  }
  if (status === "running") {
    return how.stage === "control"
      ? { label: runningText("control"), enabled: false, note: "Main's tests ran against this PR and now run against main's own code; this fills in when that run ends." }
      : { label: "running tests…", enabled: false, note: "Main's tests are running against this PR; this fills in when the run ends." };
  }
  if (status === "failed") return { label: "Tests did not finish", enabled: false, note: "The test run failed; About this run says why." };
  if (status === "unreliable") return { label: "Test results unreliable", enabled: false, note: "The run's results contradicted each other; About this run says why." };
  return { label: "Tests not run", enabled: false, note: status === "absent" ? "Run with --run-tests to run main's tests against this PR." : "The tests were not run; About this run says why." };
}

/** The tour entry: how many changed files it walks through. */
export function walkEntry(note: WalkNote, stops: number, coverage: { readonly covered: number; readonly changed: number }): Entry {
  if (note.status === "off") return { label: "No walkthrough", enabled: false, note: "Run with --walkthrough for an agent's tour of the change." };
  if (note.status === "failed") return { label: "No walkthrough", enabled: false, note: `The walkthrough failed: ${note.message}.` };
  if (stops === 0) return { label: "No walkthrough stops", enabled: false, note: "The agent gave no stop that could be shown." };
  const files = coverage.covered === coverage.changed ? plural(coverage.changed, "changed file") : `${coverage.covered} of ${plural(coverage.changed, "changed file")}`;
  return { label: `Walk through ${files}`, enabled: true, note: "Starts the agent's tour; the picture stays free to explore." };
}

/** The Failing list's heading: the count with where the results come from. */
export function failingHeading(count: number, controlled = false): string {
  if (controlled) {
    if (count === 0) return "No regressions: no test passes on main and fails with this PR";
    return count === 1 ? "1 regression: a test that passes on main and fails with this PR" : `${count} regressions: tests that pass on main and fail with this PR`;
  }
  return count === 0 ? "No test failed running main's tests against this PR" : `${plural(count, "failure")} running main's tests against this PR`;
}
