import { tallyText } from "../compare.ts";
import type { ChangeKind } from "../compare.ts";
import { effectChip, signatureDiff } from "../review.ts";
import type { ContractRollup, ContractRow, ContractsReport, EffectGroup, EffectRow, EffectsBlock, NewEffects, ReviewEntry, Unmentioned } from "../review.ts";
import type { NodeId } from "../graph.ts";
import { observedSection } from "./observed-panel.ts";
import type { ObservedInput } from "./observed-panel.ts";

const CONTRACT_MARK: Record<ContractRow["move"]["kind"], string> = {
  changed: "~",
  effects: "≈",
  added: "+",
  removed: "−",
  exposed: "↑",
  unexported: "↓",
  moved: "→",
};

const MAX_CHIPS = 4;

const MARK: Record<ChangeKind, string> = { added: "+", altered: "~", removed: "−", moved: "→" };

/** One claim of the description, with the changed modules an agent linked to it. */
export interface ClaimRow {
  readonly index: number;
  readonly text: string;
  readonly ids: readonly string[];
}

/** How the links were made, as /claims.json says. */
export type LinkNote =
  | { readonly status: "off" }
  | {
      readonly status: "ok";
      readonly model: string;
      readonly promptVersion: string;
      readonly dropped: { readonly ids: number; readonly claims: number };
      readonly cached: boolean;
    }
  | { readonly status: "failed"; readonly message: string };

export interface ReviewInput {
  /** The claimed description, or null when none was given. */
  readonly description: string | null;
  readonly claims: readonly ClaimRow[];
  readonly link: LinkNote;
  /** The user picked a claim; the host selects its linked modules and flies to them. */
  readonly pickClaim: (claim: ClaimRow) => void;
  /** Null when there is no description to check changes against. */
  readonly unmentioned: Unmentioned | null;
  /** Null without a comparison to derive them from. */
  readonly contracts: ContractsReport | null;
  /** Null without a comparison to derive them from. Shown with or without a description. */
  readonly effects: NewEffects | null;
  /** The user picked an entry; the host selects and flies to its place. */
  readonly pick: (entry: ReviewEntry) => void;
  /** The user picked a call; the host selects its module and marks the call's lines. */
  readonly pickEffect: (row: EffectRow) => void;
  /** The user picked a contract row or a file rollup; the host selects and flies to the node or file. */
  readonly pickNode: (id: NodeId) => void;
  /** Null when the tests were not asked to run. */
  readonly observed: ObservedInput | null;
}

/** A new element with a class and, when given, text; never markup. */
export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const made = document.createElement(tag);
  made.className = className;
  if (text !== undefined) made.textContent = text;
  return made;
}

export function section(title: string, tag: string): [HTMLElement, HTMLElement] {
  const wrap = element("section", "review-section");
  const head = element("h2", "review-title", title);
  head.append(element("span", `review-tag ${tag}`, tag));
  const body = element("div", "review-body");
  wrap.append(head, body);
  return [wrap, body];
}

/** Fills `host` with Claims, Unmentioned and Contracts moved. Everything user-supplied goes in as text. */
export function renderReview(host: HTMLElement, input: ReviewInput): void {
  let active: HTMLElement | undefined;
  const [claims, claimsBody] = section("Claims", "claimed");
  if (input.description === null) {
    claimsBody.append(element("p", "review-empty", "No description was given."));
  } else if (input.claims.length === 0) {
    claimsBody.append(element("pre", "review-claim", input.description));
  } else {
    claimsBody.append(element("p", "review-summary", linkNote(input.link)));
    const list = element("ul", "review-list");
    for (const claim of input.claims) {
      const item = element("li", "review-row");
      const pick = element("button", "review-pick review-claim-row");
      pick.type = "button";
      pick.append(element("span", "review-label review-claim", claim.text));
      if (input.link.status === "ok") pick.append(element("span", "review-size", claim.ids.length === 0 ? "no links" : `${claim.ids.length} linked`));
      pick.disabled = claim.ids.length === 0;
      pick.addEventListener("click", () => {
        active?.classList.remove("active");
        active = pick;
        pick.classList.add("active");
        input.pickClaim(claim);
      });
      item.append(pick);
      list.append(item);
    }
    claimsBody.append(list);
  }

  const [unmentioned, unmentionedBody] = section("Unmentioned", "derived");
  if (input.effects !== null) unmentionedBody.append(effectsBlock(input.effects.none, false));
  const result = input.unmentioned;
  if (result === null) {
    unmentionedBody.append(element("p", "review-empty", "No description was given, so no change can be checked against a claim."));
  } else {
    const uncovered = result.unmentionedFiles - result.linkedFiles;
    unmentionedBody.append(
      element("p", "review-summary", `${result.unmentionedFiles} of ${result.changedFiles} changed files are not in the description.`),
    );
    const none = element("h3", "review-subtitle", `No claim covers it (${uncovered} ${uncovered === 1 ? "file" : "files"})`);
    unmentionedBody.append(none);
    if (result.entries.length === 0) unmentionedBody.append(element("p", "review-empty", "Every changed file is mentioned or linked."));
    const list = element("ul", "review-list");
    for (const entry of result.entries) list.append(row(entry, false));
    unmentionedBody.append(list);
    if (input.link.status === "ok") {
      const head = element("h3", "review-subtitle", `Linked by the agent only (${result.linkedFiles} ${result.linkedFiles === 1 ? "file" : "files"})`);
      head.append(element("span", "review-tag claimed", "claimed"));
      unmentionedBody.append(head);
      const linkedList = element("ul", "review-list");
      for (const entry of result.linkedEntries) linkedList.append(row(entry, true));
      unmentionedBody.append(linkedList);
    }
  }
  if (input.effects !== null && input.link.status === "ok" && input.effects.byAgent.edges + input.effects.byAgent.tests.edges > 0) {
    unmentionedBody.append(effectsBlock(input.effects.byAgent, true));
  }

  function targetText(group: EffectGroup): string {
    if (group.target === "unknown") return "target unknown";
    return group.target === "none" ? "no target" : `"${group.target.literal}"`;
  }

  function effectsBlock(block: EffectsBlock, byAgent: boolean): HTMLElement {
    const wrap = element("div", "review-effects");
    const { edges, functions } = block;
    const title = element(
      "h3",
      "review-subtitle",
      `Reaches the outside world${byAgent ? ", linked by the agent" : ""} (${edges} new effect ${edges === 1 ? "edge" : "edges"} in ${functions} ${functions === 1 ? "function" : "functions"})`,
    );
    if (byAgent) title.append(element("span", "review-tag claimed", "claimed"));
    wrap.append(
      title,
      element("p", "review-note", "Direct calls to runtime built-ins only; calls through other modules are not followed yet."),
    );
    if (edges === 0 && block.tests.edges === 0) {
      wrap.append(element("p", "review-empty", "No new call reaches a process, the network, the file system or a timer."));
      return wrap;
    }
    const list = element("ul", "review-list");
    for (const group of block.groups) list.append(groupRow(group));
    if (block.tests.edges > 0) list.append(testsRow(block));
    wrap.append(list);
    return wrap;
  }

  /** A row that opens a nested list on first expand, so a group of a hundred calls costs nothing until asked for. */
  function openable(className: string, label: string, size: string, fill: (into: HTMLElement) => void): HTMLElement {
    const item = element("li", `review-row ${className}`);
    const line = element("div", "review-line");
    const nested = element("ul", "review-list");
    nested.hidden = true;
    const toggle = element("button", "review-toggle", "▸");
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-label", `Expand ${label}`);
    const open = (): void => {
      nested.hidden = !nested.hidden;
      toggle.textContent = nested.hidden ? "▸" : "▾";
      toggle.setAttribute("aria-expanded", String(!nested.hidden));
      if (!nested.hidden && nested.childElementCount === 0) fill(nested);
    };
    toggle.addEventListener("click", open);
    const head = element("button", "review-pick");
    head.type = "button";
    head.append(element("span", "review-label", label), element("span", "review-size", size));
    head.addEventListener("click", open);
    line.append(toggle, head);
    item.append(line, nested);
    return item;
  }

  function groupRow(group: EffectGroup): HTMLElement {
    const label = `${group.resource} ${targetText(group)}`;
    const size = `${group.rows.length} ${group.rows.length === 1 ? "call" : "calls"}`;
    return openable("effect-group", label, size, (into) => {
      for (const found of group.rows) into.append(effectRow(found));
    });
  }

  function testsRow(block: EffectsBlock): HTMLElement {
    return openable("effect-tests", `in tests (${block.tests.edges})`, "", (into) => {
      for (const group of block.tests.groups) into.append(groupRow(group));
    });
  }

  function effectRow(found: EffectRow): HTMLElement {
    const item = element("li", "review-row effect-call");
    const line = element("div", "review-line");
    line.append(element("span", "review-toggle"));
    const pick = element("button", "review-pick effect-pick");
    pick.type = "button";
    pick.dataset.id = found.id;
    const where = found.range.start === found.range.end ? `${found.range.start}` : `${found.range.start}-${found.range.end}`;
    const text = element("span", "contract-text");
    text.append(element("span", "review-label", found.label), element("span", "contract-where", `${found.operation} · ${found.path}:${where}`));
    pick.append(text);
    pick.addEventListener("click", () => {
      active?.classList.remove("active");
      active = pick;
      pick.classList.add("active");
      input.pickEffect(found);
    });
    line.append(pick);
    item.append(line);
    return item;
  }

  function linkNote(link: LinkNote): string {
    if (link.status === "ok") {
      const dropped = link.dropped.ids + link.dropped.claims;
      const where = link.cached ? "cached links" : "links";
      return `Agent ${where} by ${link.model} (prompt ${link.promptVersion}); dropped ${link.dropped.ids} unknown ids and ${link.dropped.claims} bad claim numbers${dropped === 0 ? "" : ", not shown"}. Select a claim to see what it covers.`;
    }
    if (link.status === "failed") return `No agent links: ${link.message}. Only paths and names count as mentions.`;
    return "No agent links; run with --link to link claims to the modules they describe.";
  }

  function row(entry: ReviewEntry, byAgent: boolean): HTMLElement {
    const item = element("li", `review-row level-${entry.level}${byAgent ? " by-agent" : ""}${entry.level !== "district" && entry.linked === true ? " linked" : ""}`);
    const line = element("div", "review-line");
    const nested = entry.children.length > 0 ? element("ul", "review-list") : undefined;
    if (nested !== undefined) {
      const toggle = element("button", "review-toggle", "▸");
      toggle.type = "button";
      toggle.setAttribute("aria-expanded", "false");
      toggle.setAttribute("aria-label", `Expand ${entry.label}`);
      nested.hidden = true;
      toggle.addEventListener("click", () => {
        nested.hidden = !nested.hidden;
        toggle.textContent = nested.hidden ? "▸" : "▾";
        toggle.setAttribute("aria-expanded", String(!nested.hidden));
        if (!nested.hidden && nested.childElementCount === 0) for (const child of entry.children) nested.append(row(child, byAgent));
      });
      line.append(toggle);
    } else line.append(element("span", "review-toggle"));

    const pick = element("button", "review-pick");
    pick.type = "button";
    pick.dataset.id = entry.id;
    const mark = entry.level === "district" ? "" : MARK[entry.change];
    pick.append(element("span", `review-mark ${entry.level === "district" ? "" : entry.change}`, mark));
    const label = element("span", "review-label", entry.label);
    if (entry.level === "file" && entry.from !== undefined) label.title = `moved from ${entry.from}`;
    pick.append(label);
    const size =
      entry.level === "district"
        ? `${entry.files} files ${tallyText(entry.kinds)}`
        : `${entry.lines} ${entry.lines === 1 ? "line" : "lines"}`;
    pick.append(element("span", "review-size", size));
    pick.addEventListener("click", () => {
      active?.classList.remove("active");
      active = pick;
      pick.classList.add("active");
      input.pick(entry);
    });
    line.append(pick);
    item.append(line);
    if (nested !== undefined) item.append(nested);
    return item;
  }

  const [contracts, contractsBody] = section("Contracts moved", "derived");
  const report = input.contracts;
  if (report === null || report.entries.length === 0) {
    contractsBody.append(element("p", "review-empty", "No exported signature changed."));
  } else {
    const c = report.counts;
    const parts = (["changed", "effects", "removed", "unexported", "exposed", "moved", "added"] as const)
      .filter((kind) => c[kind] > 0)
      .map((kind) => `${c[kind]} ${kind}`);
    contractsBody.append(element("p", "review-summary", `${parts.join(", ")}.`));
    const list = element("ul", "review-list");
    for (const entry of report.entries) list.append(entry.kind === "row" ? contractRow(entry) : rollupRow(entry));
    contractsBody.append(list);
  }

  function choose(pick: HTMLElement, id: NodeId): void {
    active?.classList.remove("active");
    active = pick;
    pick.classList.add("active");
    input.pickNode(id);
  }

  function contractRow(entry: ContractRow): HTMLElement {
    const kind = entry.move.kind;
    const item = element("li", `review-row contract contract-${kind}`);
    const line = element("div", "review-line");
    line.append(element("span", "review-toggle"));
    const pick = element("button", "review-pick contract-pick");
    pick.type = "button";
    pick.dataset.id = entry.id;
    pick.append(element("span", `review-mark contract-${kind}`, CONTRACT_MARK[kind]));
    const text = element("span", "contract-text");
    const head = element("span", "contract-head");
    head.append(element("span", "review-label", entry.label), element("span", "review-size", kind));
    if (entry.unmentioned) head.append(element("span", "review-flag", "unmentioned"));
    text.append(head, element("span", "contract-where", `${entry.level} in ${entry.path}`));
    const { before, after } = entry.move;
    if (kind === "effects") {
      // Same signature on both sides: the chips are the whole change.
    } else if (before !== null && after !== null) {
      const diff = signatureDiff(before, after);
      const was = element("span", "contract-sig before");
      was.append(element("span", "contract-side", "before"), diff.prefix, element("mark", "removed", diff.removed), diff.suffix);
      const now = element("span", "contract-sig after");
      now.append(element("span", "contract-side", "after"), diff.prefix, element("mark", "added", diff.added), diff.suffix);
      text.append(was, now);
    } else if (before !== null || after !== null) {
      const only = element("span", "contract-sig");
      only.append(element("span", "contract-side", before !== null ? "was" : "now"), before ?? after ?? "");
      text.append(only);
    }
    const found = entry.move.effects;
    if (found !== undefined) text.append(chips(found.added, "+", "added"), chips(found.removed, "−", "removed"));
    pick.append(text);
    pick.addEventListener("click", () => choose(pick, entry.id));
    line.append(pick);
    item.append(line);
    return item;
  }

  function chips(labels: readonly string[], mark: string, kind: "added" | "removed"): DocumentFragment {
    const shown = labels.slice(0, MAX_CHIPS);
    const fragment = document.createDocumentFragment();
    if (shown.length === 0) return fragment;
    const line = element("span", "effect-chips");
    for (const label of shown) {
      const chip = element("span", `effect-chip ${kind}`, `${mark}${effectChip(label)}`);
      chip.title = label;
      line.append(chip);
    }
    if (labels.length > shown.length) line.append(element("span", "effect-chip more", `${mark}${labels.length - shown.length} more`));
    fragment.append(line);
    return fragment;
  }

  function rollupRow(entry: ContractRollup): HTMLElement {
    const item = element("li", `review-row contract contract-${entry.moveKind} rollup`);
    const line = element("div", "review-line");
    const nested = element("ul", "review-list");
    nested.hidden = true;
    const toggle = element("button", "review-toggle", "▸");
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-label", `Expand ${entry.path}`);
    toggle.addEventListener("click", () => {
      nested.hidden = !nested.hidden;
      toggle.textContent = nested.hidden ? "▸" : "▾";
      toggle.setAttribute("aria-expanded", String(!nested.hidden));
      if (!nested.hidden && nested.childElementCount === 0) for (const row of entry.rows) nested.append(contractRow(row));
    });
    line.append(toggle);
    const pick = element("button", "review-pick contract-pick");
    pick.type = "button";
    pick.dataset.id = entry.fileId;
    pick.append(element("span", `review-mark contract-${entry.moveKind}`, CONTRACT_MARK[entry.moveKind]));
    const text = element("span", "contract-text");
    const head = element("span", "contract-head");
    head.append(element("span", "review-label", entry.path), element("span", "review-size", `${entry.rows.length} ${entry.moveKind}`));
    if (entry.unmentioned > 0) head.append(element("span", "review-flag", entry.unmentioned === entry.rows.length ? "unmentioned" : `${entry.unmentioned} unmentioned`));
    text.append(head);
    pick.append(text);
    pick.addEventListener("click", () => choose(pick, entry.fileId));
    line.append(pick);
    item.append(line, nested);
    return item;
  }

  host.replaceChildren(claims, ...(input.observed === null ? [] : [observedSection(input.observed, input.pickNode)]), unmentioned, contracts);
}
