import type { TestChanges } from "../test-changes-types.ts";
import type { NodeId } from "../graph.ts";
import { element, markPick, markSpan } from "./review-panel.ts";

/** What the panel says for each kind of change; the heading says "derived", since nothing ran. */
const MARKER_TEXT = { skip: "skipped", todo: "marked todo", only: "given a focus marker (.only), which does nothing to other tests unless the runner is told to honour it" } as const;

/**
 * The derived facts of what a change did to the tests, or null when it did nothing to them. A row
 * whose file the head still has selects that file in the town; a deleted file has no place to select.
 */
export function testChangesBlock(changes: TestChanges, pickNode: (id: NodeId) => void): HTMLElement | null {
  const { deletedFiles, removedTests, renamed, markers, weakened } = changes;
  const total = deletedFiles.length + removedTests.length + markers.length + weakened.length;
  if (total === 0 && renamed.length === 0) return null;
  const wrap = element("div", "review-test-changes");
  const warnings = element("ul", "review-list");
  const renames = element("ul", "review-list");
  const row = (list: HTMLElement, what: string, where: string, detail: string, file?: string, mark = "!", word = "warning") => {
    const item = element("li", "review-row");
    const text = element("span", "contract-text");
    text.append(element("span", "review-label", what), element("span", "contract-where", `${where} · ${detail}`));
    if (file === undefined) item.append(markSpan("review-mark", mark, word), text);
    else {
      const pick = element("button", "review-pick");
      pick.type = "button";
      pick.title = file;
      pick.addEventListener("click", () => {
        markPick(pick);
        pickNode(`file:${file}` as NodeId);
      });
      pick.append(markSpan("review-mark", mark, word), text);
      item.append(pick);
    }
    list.append(item);
  };
  for (const file of deletedFiles) row(warnings, file.path, file.movedTo === undefined ? "test file deleted" : `removed from the test run (now ${file.movedTo})`, file.tests === 0 ? "no tests were read from it" : `${file.tests} ${file.tests === 1 ? "test" : "tests"} no longer run`);
  for (const test of removedTests) row(warnings, test.name, test.file, "test removed by name", test.file);
  for (const marker of markers) row(warnings, marker.name, marker.file, `now ${MARKER_TEXT[marker.marker]}`, marker.file);
  for (const test of weakened) row(warnings, test.name, test.file, `weakened: ${test.why}`, test.file);
  for (const test of renamed) row(renames, test.to, test.file, `renamed from "${test.from}"`, test.file, "~", "renamed");
  if (total > 0) wrap.append(element("h3", "review-subtitle", `Tests weakened or removed (${total})`), warnings);
  if (renamed.length > 0) wrap.append(element("h3", "review-subtitle", `Tests renamed (${renamed.length})`), renames);
  return wrap;
}
