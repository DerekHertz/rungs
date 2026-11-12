import type { UnreadFile } from "../compare.ts";
import type { NodeId } from "../graph.ts";
import { element, markPick, markSpan } from "./review-panel.ts";

const SIDE = {
  head: "syntax errors in the file as the change leaves it",
  base: "syntax errors in the file as it was before the change",
  both: "syntax errors before and after the change",
} as const;

/** The Could not read row's summary. */
export const unreadSummary = (files: readonly UnreadFile[]): string => `${files.length} ${files.length === 1 ? "file" : "files"}`;

/**
 * The files a syntax error stopped the extractor reading, one row each. What the change did inside
 * them is not compared: no function, contract or call of theirs is in any other row, so a clean
 * review answer elsewhere says nothing about them.
 */
export function unreadBlock(files: readonly UnreadFile[], pickNode: (id: NodeId) => void): HTMLElement {
  const wrap = element("div", "review-unread");
  wrap.append(element("p", "review-note", "Not read as code, so nothing inside these files is compared: their functions, contracts and calls are in no other row. Open them to read the change yourself."));
  const list = element("ul", "review-list");
  for (const file of files) {
    const item = element("li", "review-row");
    const text = element("span", "contract-text");
    text.append(element("span", "review-label", file.path), element("span", "contract-where", `could not read · ${SIDE[file.side]}`));
    const pick = element("button", "review-pick");
    pick.type = "button";
    pick.title = file.path;
    pick.addEventListener("click", () => {
      markPick(pick);
      pickNode(`file:${file.path}` as NodeId);
    });
    pick.append(markSpan("review-mark", "?", "could not read"), text);
    item.append(pick);
    list.append(item);
  }
  wrap.append(list);
  return wrap;
}
