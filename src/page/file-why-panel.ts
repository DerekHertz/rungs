import { activatable } from "./activatable.ts";
import { count, definingHeading, effectStepsOf, restsOnIt, whyLine } from "../defining.ts";
import type { Block, CallList, CallRef, FileWhy, Step } from "../defining.ts";
import type { Graph, LineRange, NodeId } from "../graph.ts";

/** What a block's callers and callees are, as /calls serves them. */
export interface Neighbours {
  readonly callers: readonly CallRef[];
  readonly callees: CallList;
  /** The effects the block reaches, as /file-why shows them. */
  readonly effects: readonly Step[];
}

/** What the panel needs from the page: the graph the effects are read from, what a click does, and the next step of a block's calls. */
export interface WhyActions {
  readonly graph: Graph;
  /** A block was clicked: show its lines, opening what hides them. */
  readonly pickBlock: (block: Block) => void;
  /** A block or file in a call step was clicked: select it, banding `marked` in it when given. */
  readonly pickNode: (id: NodeId, marked?: LineRange) => void;
  /** The callers and callees of one block, asked for when a step is opened one step further. */
  readonly neighbours: (id: NodeId) => Promise<Neighbours | undefined>;
  /** Files that could not be read may import or call into the file: a caller list that is empty is empty of the readable ones. */
  readonly unknownCallers?: boolean;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ""): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
};

const lines = (range: LineRange): string => (range.start === range.end ? `L${range.start}` : `L${range.start}-${range.end}`);

/** A toggle that shows `below` after the first click, and hides and shows it again after. */
function toggling(title: string, make: () => Promise<HTMLElement> | HTMLElement, place: (below: HTMLElement) => void, button: HTMLButtonElement): void {
  let below: HTMLElement | undefined;
  let asking = false;
  button.type = "button";
  button.setAttribute("aria-expanded", "false");
  button.addEventListener("click", () => {
    if (below === undefined) {
      if (asking) return;
      asking = true;
      void Promise.resolve(make()).then((made) => {
        below = made;
        place(made);
        button.textContent = `▾ ${title}`;
        button.setAttribute("aria-expanded", "true");
      });
      return;
    }
    below.hidden = !below.hidden;
    button.textContent = `${below.hidden ? "▸" : "▾"} ${title}`;
    button.setAttribute("aria-expanded", `${!below.hidden}`);
  });
}

/** One resolved block: its name, file and lines, clickable, and one step further in `direction` when it is a block. */
function refRow(ref: CallRef, direction: "callers" | "callees", actions: WhyActions): HTMLElement {
  const row = el("div", "why-step why-ref");
  const name = el("button", "why-toggle why-ref-name", ref.level === "file" ? `${ref.path} ${ref.label}` : `${ref.level} ${ref.label}`);
  name.type = "button";
  name.addEventListener("click", () => actions.pickNode(ref.id, direction === "callers" ? ref.at[0] : undefined));
  const where = ref.level === "file" ? [] : [`${ref.path} ${ref.range === null ? "" : lines(ref.range)}`.trim()];
  const calls = ref.at.length === 0 ? [] : [`${ref.at.length === 1 ? "call" : `${ref.at.length} calls`} ${ref.at.map(lines).join(", ")}`];
  row.append(name, el("span", "why-ref-at", [...where, ...calls].join(" · ")));
  if (ref.level !== "file") {
    const more = el("button", "why-toggle", `▸ ${direction}`);
    toggling(
      direction,
      async () => {
        const next = await actions.neighbours(ref.id);
        const list = next === undefined ? el("div", "why-step unresolved", "not found") : direction === "callers" ? callersList(next.callers, actions) : calleesList(next.callees, next.effects, actions);
        list.classList.add("why-nested");
        return list;
      },
      (below) => row.after(below),
      more,
    );
    row.append(more);
  }
  return row;
}

function callersList(refs: readonly CallRef[], actions: WhyActions): HTMLElement {
  const list = el("div", "why-steps");
  if (refs.length === 0) list.append(el("div", "why-step unresolved", actions.unknownCallers === true ? "no caller found in the files that could be read: a file that could not be read may call it" : "no caller found in this file or the files that import it"));
  for (const ref of refs) list.append(refRow(ref, "callers", actions));
  return list;
}

/** The resolved callees, then the effects the block reaches, then "unresolved: N" and each call that could not be resolved. */
function calleesList(callees: CallList, effects: readonly Step[], actions: WhyActions): HTMLElement {
  const list = el("div", "why-steps");
  for (const ref of callees.resolved) list.append(refRow(ref, "callees", actions));
  for (const effect of effects) list.append(el("div", effect.unresolved === true ? "why-step unresolved" : "why-step", effect.label));
  if (callees.resolved.length === 0 && effects.length === 0 && callees.unresolved.length === 0) list.append(el("div", "why-step unresolved", "calls nothing"));
  if (callees.unresolved.length > 0) {
    list.append(el("div", "why-heading", `unresolved: ${callees.unresolved.length}`));
    for (const call of callees.unresolved) list.append(el("div", "why-step unresolved", `${call.text} · ${lines(call.at)}`));
  }
  return list;
}

/** A collapsed "callers" or "callees" under a block; it opens one step at a time. */
function neighbourStep(title: string, make: () => HTMLElement, wrap: HTMLElement): void {
  const toggle = el("button", "why-toggle", `▸ ${title}`);
  toggling(title, make, (below) => wrap.append(below), toggle);
  wrap.append(toggle);
}

function blockRow(block: Block, actions: WhyActions): HTMLElement {
  const row = el("div", "why-block");
  const head = activatable(el("div", "why-block-head"));
  head.append(el("span", "why-block-name", `${block.level} ${block.label}`));
  if (block.reasons.length > 0) head.append(el("span", "why-block-reasons", block.reasons.join(" · ")));
  if (block.rests !== undefined) head.append(el("span", "why-block-rests", restsOnIt(block.rests.length, block.restsUnknown ?? 0)));
  head.append(el("span", "why-block-at", `L${block.range.start}-${block.range.end}`));
  head.addEventListener("click", () => actions.pickBlock(block));
  row.append(head);
  if (block.folded.length > 0) row.append(el("div", "why-folded", `${count(block.folded.length, "unnamed callback")} folded under it`));
  const callers = el("div", "why-neighbours");
  const callees = el("div", "why-neighbours");
  neighbourStep("callers", () => callersList(block.callers ?? [], actions), callers);
  neighbourStep("callees", () => calleesList(block.callees ?? { resolved: [], unresolved: [] }, effectStepsOf(actions.graph, block.id), actions), callees);
  row.append(callers, callees);
  if (block.rests !== undefined && block.rests.length > 0) {
    const rests = el("div", "why-neighbours");
    const paths = block.rests;
    neighbourStep(
      "files that rest on it",
      () => {
        const list = el("div", "why-steps");
        for (const path of paths) list.append(el("div", "why-step", path));
        return list;
      },
      rests,
    );
    row.append(rests);
  }
  return row;
}

/**
 * Draws the why-line and the block list into `pane`: defining blocks first, then the other
 * changed ones, with what is folded away named. Shown only for a file the comparison knows.
 */
export function renderFileWhy(pane: HTMLElement, found: FileWhy, given: WhyActions): void {
  const actions: WhyActions = { ...given, unknownCallers: found.why.unknownDependents > 0 };
  const line = el("div", "why-line", whyLine(found));
  pane.replaceChildren(line);
  if (found.why.contracts.length + found.why.effects.length > 0) {
    const facts = el("div", "why-facts");
    for (const text of [...found.why.contracts, ...found.why.effects]) facts.append(el("div", "", text));
    pane.append(facts);
  }
  pane.append(el("div", "why-heading", definingHeading(found)));
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
