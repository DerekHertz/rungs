import type { FailureView } from "../failure-view.ts";
import { failureView } from "../failure-view.ts";
import type { LineRange } from "../graph.ts";
import { verdictText } from "../observed-types.ts";
import type { ControlDocument, ObservedTest } from "../observed-types.ts";
import type { CodeParts, Drawn } from "./code-rows.ts";

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const made = document.createElement(tag);
  made.className = className;
  if (text !== undefined) made.textContent = text;
  return made;
}

/** Marks the source row that has line number `line`, a removed row never; returns it, and scrolls it into view. */
export function markFailedLine(parts: CodeParts, drawn: Drawn, line: number | undefined): void {
  for (const cell of [...drawn.cells, ...drawn.gutters]) cell.classList.remove("failed-line");
  if (line === undefined) return;
  const index = drawn.rows.findIndex((row) => row.line === line && row.kind !== "removed");
  const cell = drawn.cells[index];
  if (cell === undefined) return;
  cell.classList.add("failed-line");
  drawn.gutters[index]?.classList.add("failed-line");
  parts.body.scrollTop = Math.max(0, cell.offsetTop - parts.body.clientHeight / 3);
}

function valueBox(label: string, value: string): HTMLElement {
  const box = element("div", "failure-value");
  box.append(element("div", "failure-label", label), element("pre", "failure-text", value));
  return box;
}

function draw(view: FailureView, onLine: (line: number) => void): HTMLElement[] {
  if (view.kind === "message-only") return [element("pre", "failure-text", view.text)];
  const parts: HTMLElement[] = [];
  if (view.message !== undefined) parts.push(element("pre", "failure-text", view.message));
  if (view.mark !== undefined) {
    const line = view.mark;
    const jump = element("button", "failure-line", `the runner's stack names line ${line}, marked in the source`);
    jump.type = "button";
    jump.addEventListener("click", () => onLine(line));
    parts.push(jump);
  }
  if (view.outside !== undefined) parts.push(element("div", "failure-note", `the runner's stack names line ${view.outside} of this file, which is outside this test function`));
  if (view.expected !== undefined && view.actual !== undefined) {
    if (view.operator !== undefined) parts.push(element("div", "failure-note", `assert.${view.operator}`));
    const sides = element("div", "failure-sides");
    sides.append(valueBox("expected", view.expected), valueBox("actual", view.actual));
    parts.push(sides);
  }
  return parts;
}

/** Says whether the failure is the change's: a regression, main's own, or not known for want of a control run. */
export function failureHeading(test: ObservedTest, control: ControlDocument): string {
  if (control.status !== "ran") return `Failed when main's tests ran against this change (observed; no control run: ${control.why})`;
  if (test.verdict === "regression") return "Regression: passes on main, fails with this change (observed)";
  if (test.verdict === "environment") return "Environment: fails on main too, so not this change's doing (observed)";
  return `Failed when main's tests ran against this change, not compared with main (${verdictText(test.verdict ?? "unclear", test.verdictWhy)})`;
}

/**
 * What the run produced of the failures of the open test function, in the pane above its source:
 * the runner's message, the assertion's expected and actual side by side, and the line its stack
 * named; hidden when the test did not fail. Returns the line to mark in the source, when there is one.
 */
export function renderFailure(pane: HTMLElement, tests: readonly ObservedTest[], range: LineRange, onLine: (line: number) => void, control: ControlDocument): number | undefined {
  const failed = tests.filter((test) => test.outcome === "fail");
  pane.replaceChildren();
  pane.hidden = failed.length === 0;
  let mark: number | undefined;
  for (const test of failed) {
    const view = failureView(test, range);
    pane.append(element("div", "failure-heading", failureHeading(test, control)), ...draw(view, onLine));
    if (view.kind === "detailed" && view.mark !== undefined) mark ??= view.mark;
  }
  return mark;
}
