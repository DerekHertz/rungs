import { calleesOf, callersOf, importersOf } from "../defining.ts";
import type { Block, FileWhy, Step } from "../defining.ts";
import type { Graph, NodeId } from "../graph.ts";

/** What the panel needs from the page: the graph the steps are read from, and what a click does. */
export interface WhyActions {
  readonly graph: Graph;
  /** A block was clicked: show its lines, opening what hides them. */
  readonly pickBlock: (block: Block) => void;
  /** A file in a caller step was clicked: select it. */
  readonly pickFile: (id: NodeId) => void;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ""): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
};

const count = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The one line that says why the file matters: derived facts only, each a number or a name. */
export function whyLine(found: FileWhy): string {
  const { why } = found;
  const parts = [
    why.contracts.length === 0 ? "no contract moved" : `${count(why.contracts.length, "contract")} moved`,
    why.dependents.length === 0 ? "no file rests on it" : `${count(why.dependents.length, "file")} rest on it`,
    why.effects.length === 0 ? "no new effect" : `${count(why.effects.length, "new effect")}`,
    why.isTest ? "is a test file" : why.testReaches.length === 0 ? "no test reaches it" : `${count(why.testReaches.length, "test file")} reach it`,
  ];
  return parts.join(" · ");
}

/** A list of steps, each file step opening one step further on a click, every unresolved one shown as that. */
function stepList(steps: readonly Step[], actions: WhyActions): HTMLElement {
  const list = el("div", "why-steps");
  for (const step of steps) {
    const row = el("div", step.unresolved === true ? "why-step unresolved" : "why-step");
    const label = el("span", "why-step-label", step.unresolved === true ? `${step.label}: unresolved` : step.label);
    row.append(label);
    if (step.open !== undefined) {
      const id = step.open;
      let below: HTMLElement | undefined;
      const more = el("button", "why-toggle", "▸ imported by");
      more.type = "button";
      more.setAttribute("aria-expanded", "false");
      more.addEventListener("click", () => {
        if (below === undefined) {
          const next = importersOf(actions.graph, id);
          below = next.length === 0 ? el("div", "why-step unresolved", "nothing imports it") : stepList(next, actions);
          below.classList.add("why-nested");
          row.after(below);
          more.textContent = "▾ imported by";
          more.setAttribute("aria-expanded", "true");
        } else {
          below.hidden = !below.hidden;
          more.textContent = `${below.hidden ? "▸" : "▾"} imported by`;
          more.setAttribute("aria-expanded", `${!below.hidden}`);
        }
      });
      const open = el("button", "why-toggle", "open");
      open.type = "button";
      open.addEventListener("click", () => actions.pickFile(id));
      row.append(more, open);
    }
    list.append(row);
  }
  return list;
}

/** A collapsed "callers" or "callees" under a block; the steps are worked out when it first opens. */
function neighbours(title: string, steps: () => Step[], actions: WhyActions): HTMLElement {
  const wrap = el("div", "why-neighbours");
  const toggle = el("button", "why-toggle", `▸ ${title}`);
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", "false");
  let list: HTMLElement | undefined;
  toggle.addEventListener("click", () => {
    if (list === undefined) {
      list = stepList(steps(), actions);
      wrap.append(list);
    } else list.hidden = !list.hidden;
    toggle.textContent = `${list.hidden ? "▸" : "▾"} ${title}`;
    toggle.setAttribute("aria-expanded", `${!list.hidden}`);
  });
  wrap.append(toggle);
  return wrap;
}

function blockRow(block: Block, actions: WhyActions): HTMLElement {
  const row = el("div", "why-block");
  const head = el("div", "why-block-head");
  head.append(el("span", "why-block-name", `${block.level} ${block.label}`));
  if (block.reasons.length > 0) head.append(el("span", "why-block-reasons", block.reasons.join(" · ")));
  head.append(el("span", "why-block-at", `L${block.range.start}-${block.range.end}`));
  head.addEventListener("click", () => actions.pickBlock(block));
  row.append(head);
  if (block.folded.length > 0) row.append(el("div", "why-folded", `${count(block.folded.length, "unnamed callback")} folded under it`));
  row.append(neighbours("files that import this file", () => callersOf(actions.graph, block.id), actions), neighbours("callees", () => calleesOf(actions.graph, block.id), actions));
  return row;
}

/**
 * Draws the why-line and the block list into `pane`: defining blocks first, then the other
 * changed ones, with what is folded away named. Shown only for a file the comparison knows.
 */
export function renderFileWhy(pane: HTMLElement, found: FileWhy, actions: WhyActions): void {
  const line = el("div", "why-line", whyLine(found));
  pane.replaceChildren(line);
  if (found.why.contracts.length + found.why.effects.length > 0) {
    const facts = el("div", "why-facts");
    for (const text of [...found.why.contracts, ...found.why.effects]) facts.append(el("div", "", text));
    pane.append(facts);
  }
  pane.append(el("div", "why-heading", found.defining.length === 0 ? "Defining blocks: none (no changed block is exported, moved a contract or gained an effect)" : `Defining blocks (${found.defining.length})`));
  for (const block of found.defining) pane.append(blockRow(block, actions));
  if (found.other.length > 0) {
    pane.append(el("div", "why-heading", `Other changed blocks (${found.other.length})`));
    for (const block of found.other) pane.append(blockRow(block, actions));
  }
  const { callbacks, imports } = found.foldedLoose;
  const folded = [callbacks > 0 ? count(callbacks, "unnamed callback") : "", imports > 0 ? count(imports, "changed import") : ""].filter((text) => text !== "");
  if (folded.length > 0) pane.append(el("div", "why-folded", `Folded under the file: ${folded.join(", ")}`));
  pane.hidden = false;
}
