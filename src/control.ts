import type { TestReport } from "./observed.ts";
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

/**
 * Sets the head run's reports against the control run's, test by test, by file and titles.
 * `verdicts` runs parallel to `head`. Tests only the control run reported are `baseOnly`. A name that
 * either run reported twice is `unclear`: which of the two is which cannot be told, so none is a regression.
 * A file that failed outside any test only on the PR's code is a regression of that file, when main's
 * run of the file did not fail that way.
 */
export function classify(head: readonly TestReport[], base: readonly TestReport[]): { verdicts: Verdict[]; baseOnly: TestReport[]; counts: VerdictCounts } {
  const headGroups = grouped(head);
  const baseGroups = grouped(base);
  const baseFiles = new Set(base.map((report) => report.file));
  const counts: Record<Verdict, number> = { regression: 0, environment: 0, fixed: 0, passes: 0, skipped: 0, "head only": 0, "base only": 0, unclear: 0 };
  const verdicts = head.map((report): Verdict => {
    const here = headGroups.get(key(report)) ?? [];
    const there = baseGroups.get(key(report)) ?? [];
    let verdict: Verdict;
    if (here.length > 1 || there.length > 1) verdict = "unclear";
    else {
      const outsideTests = report.suite === true || report.path.length === 0;
      verdict = verdictOf(report.outcome, there[0]?.outcome ?? (outsideTests && baseFiles.has(report.file) ? "pass" : undefined));
    }
    counts[verdict] += 1;
    return verdict;
  });
  const baseOnly = base.filter((report) => !headGroups.has(key(report)));
  counts["base only"] = baseOnly.length;
  return { verdicts, baseOnly, counts };
}
