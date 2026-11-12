import { EVIDENCE_LINE, UNSANDBOXED_LINE, UNSANDBOXED_SHARED_LINE } from "./observed-types.ts";
import { leftoverText } from "./leftover.ts";
import type { Leftover } from "./leftover.ts";
import type { ControlDocument, ObservedDocument } from "./observed-types.ts";
import { unreliableText } from "./observed-report.ts";

/** What the control run says of the head run, for "About this run". */
export function controlText(control: ControlDocument): string {
  if (control.status !== "ran") return `No control run: ${control.why}. The failures are main's tests failing against this PR, not known to be this PR's doing.`;
  const { regression, environment, fixed } = control.counts;
  return `The same tests also ran against main's own code, in ${control.seconds}s: ${regression} ${regression === 1 ? "regression" : "regressions"}, ${environment} environment (fail on main too), ${fixed} fixed.`;
}

/** What was left running after the steps, as a sentence; a run in the sandbox has none to say. */
export function leftoverSentence(leftover: Leftover | undefined): string {
  if (leftover === undefined) return "";
  const text = leftoverText(leftover);
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/** The caveat that sits one hover or click from the Tests row. */
export function observedNote(document: ObservedDocument): string {
  if (document.status !== "ran" && document.status !== "failed" && document.status !== "unreliable") return EVIDENCE_LINE;
  const unsandboxed = document.sandbox === "unsandboxed";
  return [EVIDENCE_LINE, ...(unsandboxed ? [`Tests ${UNSANDBOXED_LINE}. ${UNSANDBOXED_SHARED_LINE}.`] : []), leftoverSentence(document.leftover)].filter((part) => part !== "").join(" ");
}

/** What the run was, for "About this run": the runner, the sandbox, the time, the counts. */
export function observedAbout(document: ObservedDocument): [string, string][] {
  const notes: [string, string][] = [];
  if (document.status === "ran") {
    const { pass, fail, skip } = document.counts;
    const where = document.sandbox === "bwrap" ? "in a sandbox with no network, the tree read-only and one scratch folder shared by all the tests" : "unsandboxed";
    notes.push(["Tests", `${pass + fail + skip} of main's tests ran once against this PR's code with node --test ${where}, in ${document.seconds}s: ${fail} fail, ${pass} pass, ${skip} skip. ${controlText(document.control)} ${observedNote(document)}`]);
  } else if (document.status === "running") notes.push(["Tests", document.stage === "control" ? "Main's tests ran against this PR's code and now run against main's own code (the control run); this fills in when it ends." : "Main's tests are running once against this PR's code; this fills in when the run ends."]);
  else if (document.status === "failed") notes.push(["Tests", `The node --test run failed after ${document.seconds}s: ${document.why}. ${observedNote(document)}`]);
  else if (document.status === "unreliable") notes.push(["Tests", `${unreliableText(document)} ${observedNote(document)}`]);
  else notes.push(["Tests", `Tests not run: ${document.why}.`]);
  return notes;
}
