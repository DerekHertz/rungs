import type { Comparison } from "./compare.ts";
import { isCodeNode } from "./graph.ts";
import type { ObservedDocument } from "./observed-types.ts";
import type { TestChanges } from "./test-changes-types.ts";

/** The one line above the review: what the change did, from derived facts only. */

const plural = (count: number, one: string, many: string = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

/** The tests part: main's tests run against the PR, said as what ran, or as not known. Never a count when no run gave one. */
function testsPart(observed: ObservedDocument | null): string {
  if (observed === null) return "tests not run";
  if (observed.status === "ran") {
    const { pass, fail } = observed.counts;
    return fail === 0 ? `main's tests: ${pass} passed` : `main's tests: ${fail} failed, ${pass} passed`;
  }
  if (observed.status === "failed") return "tests did not finish";
  if (observed.status === "unreliable") return "test results unreliable";
  return "tests not run";
}

/**
 * "3 files, 5 functions changed · calls +2 −1 · 2 calls changed arguments · imports +1 · tests removed 2 · main's tests: 27 passed".
 * A part with nothing to say is left out; the tests part always says what is known, including that they did not run.
 */
export function headline(comparison: Comparison, testChanges: TestChanges, observed: ObservedDocument | null): string {
  const files = comparison.changes.filter((change) => change.node.level === "file").length;
  const code = comparison.changes.filter((change) => isCodeNode(change.node)).length;
  const touched = [files > 0 ? plural(files, "file") : "", code > 0 ? plural(code, "function or class", "functions or classes") : ""].filter((part) => part !== "");
  const parts: string[] = [];
  if (touched.length > 0) parts.push(`${touched.join(", ")} changed`);
  else if (comparison.dependencies.length === 0 && comparison.sections.length === 0) parts.push("no code changed");
  const added = comparison.effects.filter((effect) => effect.kind === "added").length;
  const removed = comparison.effects.length - added;
  if (added + removed > 0) parts.push(`calls ${[added > 0 ? `+${added}` : "", removed > 0 ? `−${removed}` : ""].filter((part) => part !== "").join(" ")}`);
  const argumentCalls = comparison.changedEffects.reduce((sum, row) => sum + row.count, 0);
  if (argumentCalls > 0) parts.push(`${plural(argumentCalls, "call")} changed arguments`);
  const imported = comparison.imports.filter((change) => change.kind === "added").length;
  const unimported = comparison.imports.length - imported;
  if (imported + unimported > 0) parts.push(`imports ${[imported > 0 ? `+${imported}` : "", unimported > 0 ? `−${unimported}` : ""].filter((part) => part !== "").join(" ")}`);
  if (comparison.dependencies.length > 0) parts.push(`${plural(comparison.dependencies.length, "dependency", "dependencies")} changed`);
  const removedTests = testChanges.removedTests.length + testChanges.deletedFiles.reduce((sum, file) => sum + file.tests, 0);
  if (removedTests > 0) parts.push(`${plural(removedTests, "test")} removed`);
  parts.push(testsPart(observed));
  return parts.join(" · ");
}
