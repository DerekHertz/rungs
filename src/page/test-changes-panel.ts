import type { TestChanges } from "../test-changes-types.ts";
import { element } from "./review-panel.ts";

/** What the panel says for each kind of change; the heading says "derived", since nothing ran. */
const MARKER_TEXT = { skip: "skipped", todo: "marked todo", only: "marked only (the rest of the file is skipped)" } as const;

/** The derived facts of what a change did to the tests, or null when it did nothing to them. */
export function testChangesBlock(changes: TestChanges): HTMLElement | null {
  const { deletedFiles, removedTests, markers, weakened } = changes;
  const total = deletedFiles.length + removedTests.length + markers.length + weakened.length;
  if (total === 0) return null;
  const wrap = element("div", "review-test-changes");
  wrap.append(element("h3", "review-subtitle", `Tests weakened or removed (${total})`));
  const list = element("ul", "review-list");
  const row = (what: string, where: string, detail: string) => {
    const item = element("li", "review-row");
    const text = element("span", "contract-text");
    text.append(element("span", "review-label", what), element("span", "contract-where", `${where} · ${detail}`));
    item.append(element("span", "review-mark", "!"), text);
    list.append(item);
  };
  for (const file of deletedFiles) row(file.path, "test file deleted", file.tests === 0 ? "no tests were read from it" : `${file.tests} ${file.tests === 1 ? "test" : "tests"} gone`);
  for (const test of removedTests) row(test.name, test.file, "test removed by name");
  for (const marker of markers) row(marker.name, marker.file, `now ${MARKER_TEXT[marker.marker]}`);
  for (const test of weakened) row(test.name, test.file, `weakened: ${test.why}`);
  wrap.append(list);
  return wrap;
}
