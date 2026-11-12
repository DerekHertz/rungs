import type { TestReport } from "./observed.ts";
import { READ_ONLY_REASON } from "./observed-types.ts";
import type { Outcome, Verdict, VerdictCounts } from "./observed-types.ts";

const key = (report: TestReport): string => `${JSON.stringify(report.file)}${JSON.stringify(report.path)}`;

function grouped(reports: readonly TestReport[]): Map<string, TestReport[]> {
  const groups = new Map<string, TestReport[]>();
  for (const report of reports) groups.set(key(report), [...(groups.get(key(report)) ?? []), report]);
  return groups;
}

/** One test's verdict from what it did on the PR's code (`head`) and on main's (`base`, undefined when main's run did not report it). */
function verdictOf(head: Outcome, base: Outcome | undefined): Verdict {
  if (base === undefined) return "head only";
  if (head === "skip" || base === "skip") return "skipped";
  if (head === "fail") return base === "fail" ? "environment" : "regression";
  return base === "fail" ? "fixed" : "passes";
}

/** What a read-only file system error says, in a failure or in a run's output. */
export const READ_ONLY = /EROFS|read-only file system/i;

/**
 * Whether a failure carries a read-only file system error: in its message or the assertion's
 * values, in any case. The control run's tree is read-only, so such a failure is the tree's, not main's.
 */
function readOnlyFailure(report: TestReport): boolean {
  return report.outcome === "fail" && [report.message, report.detail?.expected, report.detail?.actual].some((text) => text !== undefined && READ_ONLY.test(text));
}

/**
 * Sets the head run's reports against the control run's, test by test, by file and titles.
 * `verdicts` runs parallel to `head`. Tests only the control run reported are `baseOnly`. A name that
 * either run reported twice is `unclear`: which of the two is which cannot be told, so none is a regression.
 * A head failure main's run has no report for (a file that crashed on import is reported as a test named
 * after the file) is matched by file: a regression of that file when main's tests in it all passed,
 * else it stays `head only`, failed and not compared.
 * A failure on main that is a read-only file system error is the control run's read-only tree, not
 * main's own: the head's test is then `unclear`, with that reason in `reasons`, never `environment`
 * and never `fixed`. `baseTainted` says the same of every failure of main's run, for a run whose
 * output names such an error that no single failure carries.
 */
export function classify(
  head: readonly TestReport[],
  base: readonly TestReport[],
  baseTainted?: string,
): { verdicts: Verdict[]; reasons: (string | undefined)[]; baseOnly: TestReport[]; counts: VerdictCounts; notComparedFailures: number } {
  const headGroups = grouped(head);
  const baseGroups = grouped(base);
  // Files main ran with no failure in them: a head failure main has no report for is a regression of such a file.
  // A skipped test shows nothing worked, so a file needs a test that passed.
  const baseFiles = new Set(base.filter((report) => report.outcome === "pass").map((report) => report.file));
  for (const report of base) if (report.outcome === "fail") baseFiles.delete(report.file);
  const counts: Record<Verdict, number> = { regression: 0, environment: 0, fixed: 0, passes: 0, skipped: 0, "head only": 0, "base only": 0, unclear: 0 };
  const reasons: (string | undefined)[] = [];
  let notComparedFailures = 0;
  const verdicts = head.map((report): Verdict => {
    const here = headGroups.get(key(report)) ?? [];
    const there = baseGroups.get(key(report)) ?? [];
    let verdict: Verdict;
    let why: string | undefined;
    if (here.length > 1 || there.length > 1) verdict = "unclear";
    else {
      const unpairedCrash = report.outcome === "fail" && baseFiles.has(report.file);
      verdict = verdictOf(report.outcome, there[0]?.outcome ?? (unpairedCrash ? "pass" : undefined));
      // Only a main failure can excuse the PR's result or be fixed by it, and that is what the read-only tree can fake.
      const baseFailure = there[0];
      if (baseFailure?.outcome === "fail" && (verdict === "environment" || verdict === "fixed") && (baseTainted !== undefined || readOnlyFailure(baseFailure))) {
        verdict = "unclear";
        why = baseTainted ?? READ_ONLY_REASON;
      }
    }
    counts[verdict] += 1;
    // A failure of the PR that main's run says nothing about is not cleared of being a regression.
    if (report.outcome === "fail" && (verdict === "skipped" || verdict === "head only" || verdict === "unclear")) notComparedFailures += 1;
    reasons.push(why);
    return verdict;
  });
  const baseOnly = base.filter((report) => !headGroups.has(key(report)));
  counts["base only"] = baseOnly.length;
  return { verdicts, reasons, baseOnly, counts, notComparedFailures };
}
