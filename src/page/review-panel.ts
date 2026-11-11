import { tallyText } from "../compare.ts";
import type { ChangeKind } from "../compare.ts";
import { shortToken } from "../effects.ts";
import { effectChip, signatureDiff } from "../review.ts";
import { claimGroups, claimsSummary, contractsSummary, foldersOf, resourceSummaries, signatureChange, testsSummary, unmentionedSummary } from "../review-summary.ts";
import type { ContractRow, ContractsReport, EffectGroup, EffectRow, EffectsBlock, EffectsChangedRow, NewEffects, ReviewEntry, Unmentioned } from "../review.ts";
import type { NodeId } from "../graph.ts";
import { observedAbout, observedBody, observedNote } from "./observed-panel.ts";
import type { ObservedInput } from "./observed-panel.ts";
import type { TestChanges } from "../test-changes-types.ts";
import { testChangesBlock } from "./test-changes-panel.ts";

const CONTRACT_MARK: Record<ContractRow["move"]["kind"], string> = {
  changed: "~",
  effects: "≈",
  added: "+",
  removed: "−",
  exposed: "↑",
  unexported: "↓",
  moved: "→",
};

const MARK: Record<ChangeKind, string> = { added: "+", altered: "~", removed: "−", moved: "→" };

/** One claim of the description, with the changed modules an agent linked to it. */
export interface ClaimRow {
  readonly index: number;
  readonly text: string;
  /** The agent's short restatement; false when the row shows the description's own words. */
  readonly restated: boolean;
  /** The description's own sentences behind this row, shown when it is selected. */
  readonly sources: readonly { readonly text: string }[];
  readonly ids: readonly string[];
}

/** How the links were made, as /claims.json says. */
export type LinkNote =
  | { readonly status: "off" }
  | {
      readonly status: "ok";
      readonly model: string;
      readonly promptVersion: string;
      readonly dropped: { readonly ids: number; readonly claims: number; readonly restatements: number };
      readonly cached: boolean;
    }
  | { readonly status: "failed"; readonly message: string };

export interface ReviewInput {
  /** The claimed description, or null when none was given. */
  readonly description: string | null;
  readonly claims: readonly ClaimRow[];
  /** Lines the agent called context, counted and kept out of the claims list. */
  readonly context: readonly { readonly text: string }[];
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
  /** What the change did to the tests, derived from the two trees. */
  readonly testChanges: TestChanges;
}

/** A new element with a class and, when given, text; never markup. */
export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const made = document.createElement(tag);
  made.className = className;
  if (text !== undefined) made.textContent = text;
  return made;
}

type RowId = "claims" | "unmentioned" | "contracts" | "tests";

const STORE_KEY = "streets.review.open";

function remembered(): string | null {
  try {
    return localStorage.getItem(STORE_KEY);
  } catch {
    return null;
  }
}

function remember(id: string): void {
  try {
    localStorage.setItem(STORE_KEY, id);
  } catch {
    // Private windows and blocked site data: the choice just does not last.
  }
}

const plural = (count: number, one: string): string => `${count} ${count === 1 ? one : `${one}s`}`;

/** The text of a target group: a literal in quotes, or exactly what is not known. */
function targetText(group: EffectGroup): string {
  if (group.target === "unknown") return "target unknown";
  return group.target === "none" ? "no target" : `"${group.target.literal}"`;
}

function linkNote(link: LinkNote): string {
  if (link.status === "ok") {
    const dropped = link.dropped.ids + link.dropped.claims;
    const where = link.cached ? "cached links" : "links";
    return `Agent ${where} by ${link.model} (prompt ${link.promptVersion}); dropped ${link.dropped.ids} unknown ids and ${link.dropped.claims} bad claim numbers, kept the original words for ${link.dropped.restatements} unusable restatements${dropped === 0 ? "" : ", not shown"}.`;
  }
  if (link.status === "failed") return `No agent links: ${link.message}. Only paths and names count as mentions.`;
  return "No agent links; run with --link to link claims to the modules they describe.";
}

/**
 * Fills `host` with one summary row per question: Claims, Unmentioned, Contracts moved and Tests.
 * One opens at a time and takes the column's height. Everything user-supplied goes in as text.
 */
export function renderReview(host: HTMLElement, input: ReviewInput): void {
  let active: { pick: HTMLElement; detail?: HTMLElement } | undefined;
  const choose = (pick: HTMLElement, detail?: HTMLElement): void => {
    if (active !== undefined) {
      active.pick.classList.remove("active");
      active.pick.setAttribute("aria-current", "false");
      if (active.detail !== undefined) active.detail.hidden = true;
    }
    active = { pick, ...(detail === undefined ? {} : { detail }) };
    pick.classList.add("active");
    pick.setAttribute("aria-current", "true");
    if (detail !== undefined) detail.hidden = false;
  };

  /** A button that picks something: marks itself, shows its detail, tells the host. */
  function picker(className: string, detail: HTMLElement | undefined, onPick: () => void): HTMLButtonElement {
    const pick = element("button", className);
    pick.type = "button";
    pick.addEventListener("click", () => {
      choose(pick, detail);
      onPick();
    });
    return pick;
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

  const list = (...items: HTMLElement[]): HTMLElement => {
    const made = element("ul", "review-list");
    made.append(...items);
    return made;
  };

  // Claims

  function fillClaims(body: HTMLElement): void {
    if (input.description === null) {
      body.append(element("p", "review-empty", "No description was given."));
      return;
    }
    if (input.claims.length === 0 && input.context.length > 0) {
      body.append(element("p", "review-empty", `No claims; ${plural(input.context.length, "context line")} not shown`), contextList(input.context));
      return;
    }
    if (input.claims.length === 0) {
      body.append(element("pre", "review-claim", input.description));
      return;
    }
    const linked = input.link.status === "ok";
    for (const group of claimGroups(input.claims, linked)) {
      if (group.name === "unlinked") {
        const head = element("h3", "review-subtitle", `Not linked to any place (${group.items.length})`);
        head.append(element("span", "review-flag", "gap"));
        body.append(head);
      } else if (group.name === "linked") body.append(element("h3", "review-subtitle", `Linked (${group.items.length})`));
      body.append(list(...group.items.map((claim) => claimRow(claim, linked))));
    }
    if (input.context.length > 0) body.append(contextList(input.context));
  }

  function contextList(context: readonly { readonly text: string }[]): HTMLElement {
    const more = element("details", "review-context");
    more.append(element("summary", "review-summary", `${plural(context.length, "context line")} not shown`));
    for (const line of context) more.append(element("p", "review-source", line.text));
    return more;
  }

  function claimRow(claim: ClaimRow, linked: boolean): HTMLElement {
    const item = element("li", `review-row${linked && claim.ids.length === 0 ? " unlinked" : ""}`);
    const full = element("div", "rv-full");
    full.append(element("p", "review-claim", claim.text));
    // A restated claim is reached through its source sentences: the description's own words.
    if (claim.restated) full.append(element("blockquote", "review-source", claim.sources.map((source) => source.text).join(" ")));
    full.hidden = true;
    const pick = picker("review-pick review-claim-row", full, () => {
      if (claim.ids.length > 0) input.pickClaim(claim);
    });
    pick.title = claim.text;
    pick.append(element("span", "rv-one review-claim", claim.text));
    if (linked) pick.append(element("span", claim.ids.length === 0 ? "review-flag" : "review-size", claim.ids.length === 0 ? "no places" : plural(claim.ids.length, "place")));
    item.append(pick, full);
    return item;
  }

  // Unmentioned

  function fillUnmentioned(body: HTMLElement): void {
    if (input.effects !== null) body.append(...effectsBlock(input.effects.none, false));
    if (input.effects !== null && input.effects.changed.none.length > 0) {
      body.append(element("h3", "review-subtitle", `Effects changed, no claim covers them (${input.effects.changed.none.length})`), list(...input.effects.changed.none.map(effectsChangedRow)));
    }
    const result = input.unmentioned;
    if (result === null) {
      body.append(element("p", "review-empty", "No description was given, so no file can be checked against a claim."));
    } else {
      const uncovered = result.unmentionedFiles - result.linkedFiles;
      body.append(element("h3", "review-subtitle", `Files no claim covers (${uncovered} of ${result.changedFiles} changed)`));
      if (result.entries.length === 0) body.append(element("p", "review-empty", "Every changed file is mentioned or linked."));
      else body.append(list(...result.entries.map((entry) => row(entry, false))));
      if (input.link.status === "ok" && result.linkedEntries.length > 0) {
        const head = element("h3", "review-subtitle", `Linked by the agent only (${plural(result.linkedFiles, "file")})`);
        head.append(element("span", "review-tag claimed", "claimed"));
        body.append(head, list(...result.linkedEntries.map((entry) => row(entry, true))));
      }
    }
    if (input.effects !== null && input.link.status === "ok" && input.effects.byAgent.edges + input.effects.byAgent.tests.edges > 0) {
      body.append(...effectsBlock(input.effects.byAgent, true));
    }
  }

  function effectsBlock(block: EffectsBlock, byAgent: boolean): HTMLElement[] {
    const { edges, functions } = block;
    const title = element("h3", "review-subtitle", `New calls out${byAgent ? ", linked by the agent" : ""} (${edges} in ${plural(functions, "function")})`);
    if (byAgent) title.append(element("span", "review-tag claimed", "claimed"));
    if (edges === 0 && block.tests.edges === 0) return [title, element("p", "review-empty", "No new call reaches a process, the network, the file system, a timer or code loaded at run time.")];
    const items = resourceSummaries(block.groups).map(resourceRow);
    if (block.tests.edges > 0) {
      items.push(
        openable("effect-tests", `in tests (${block.tests.edges})`, "", (into) => {
          for (const summary of resourceSummaries(block.tests.groups)) into.append(resourceRow(summary));
        }),
      );
    }
    return [title, list(...items)];
  }

  function resourceRow(summary: ReturnType<typeof resourceSummaries>[number]): HTMLElement {
    return openable("effect-resource", summary.resource, plural(summary.calls, "call"), (into) => {
      for (const group of summary.targets) {
        into.append(openable("effect-group", targetText(group), plural(group.rows.length, "call"), (calls) => {
          for (const found of group.rows) calls.append(effectRow(found));
        }));
      }
    });
  }

  function effectRow(found: EffectRow): HTMLElement {
    const item = element("li", "review-row effect-call");
    const line = element("div", "review-line");
    line.append(element("span", "review-toggle"));
    const pick = picker("review-pick effect-pick", undefined, () => input.pickEffect(found));
    pick.dataset.id = found.id;
    const where = found.range.start === found.range.end ? `${found.range.start}` : `${found.range.start}-${found.range.end}`;
    const text = element("span", "contract-text");
    text.append(element("span", "review-label rv-ellipsis", found.label), element("span", "contract-where rv-ellipsis", `${found.operation} · ${found.path}:${where}`));
    pick.title = `${found.label}: ${found.operation} · ${found.path}:${where}`;
    pick.append(text);
    line.append(pick);
    item.append(line);
    return item;
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

    const pick = picker("review-pick", undefined, () => input.pick(entry));
    pick.dataset.id = entry.id;
    const mark = entry.level === "district" ? "" : MARK[entry.change];
    pick.append(element("span", `review-mark ${entry.level === "district" ? "" : entry.change}`, mark));
    const label = element("span", "review-label", entry.label);
    if (entry.level === "file" && entry.from !== undefined) label.title = `moved from ${entry.from}`;
    else if (entry.level === "class" || entry.level === "function") label.title = entry.id.slice(entry.id.indexOf("#") + 1);
    pick.append(label);
    const size =
      entry.level === "district"
        ? `${entry.files} files ${tallyText(entry.kinds)}`
        : entry.lines === null
          ? "binary"
          : `${entry.lines} ${entry.lines === 1 ? "line" : "lines"}${entry.folded === undefined ? "" : ` · +${plural(entry.folded.length, "callback")}`}`;
    pick.append(element("span", "review-size", size));
    line.append(pick);
    item.append(line);
    if (nested !== undefined) item.append(nested);
    return item;
  }

  // Contracts moved

  function fillContracts(body: HTMLElement): void {
    const report = input.contracts;
    if (report === null || (report.entries.length === 0 && report.effectsChanged.length === 0)) {
      body.append(element("p", "review-empty", "No exported signature changed."));
      return;
    }
    const rows = report.entries.flatMap((entry) => (entry.kind === "row" ? [entry] : entry.rows));
    const single = rows.filter((entry) => entry.move.kind !== "added" && entry.move.kind !== "moved");
    if (single.length > 0) body.append(list(...single.map((entry) => contractRow(entry, true))));
    if (report.effectsChanged.length > 0) {
      body.append(element("h3", "review-subtitle", `Effects changed (${report.effectsChanged.length})`), list(...report.effectsChanged.map(effectsChangedRow)));
    }
    for (const kind of ["moved", "added"] as const) {
      const bulk = rows.filter((entry) => entry.move.kind === kind);
      if (bulk.length === 0) continue;
      body.append(element("h3", "review-subtitle", `${kind === "added" ? "Added" : "Moved"} (${bulk.length}), by folder`));
      body.append(
        list(
          ...foldersOf(bulk).map((group) =>
            openable(`contract contract-${kind}`, group.folder, plural(group.rows.length, kind === "added" ? "export" : "move"), (into) => {
              for (const entry of group.rows) into.append(contractRow(entry, false));
            }),
          ),
        ),
      );
    }
  }

  /** A call whose arguments changed: the holder, what the call reaches, and the arguments gained and lost. */
  function effectsChangedRow(row: EffectsChangedRow): HTMLElement {
    const { change } = row;
    const item = element("li", "review-row contract contract-effects");
    const detail = element("div", "rv-detail contract-text");
    detail.hidden = true;
    detail.append(element("span", "contract-where", `${change.label} in ${row.path}`), chips(change.added, "+", "added", true), chips(change.removed, "−", "removed", true));
    const line = element("div", "review-line");
    line.append(element("span", "review-toggle"));
    const pick = picker("review-pick contract-pick", detail, () => input.pickNode(row.id));
    pick.dataset.id = row.id;
    const count = change.count > 1 ? ` ×${change.count}` : "";
    pick.title = `${row.label}: ${change.label}${count}`;
    pick.append(element("span", "review-mark contract-effects", "≈"), element("span", "review-label rv-name", row.label));
    pick.append(element("span", "contract-where rv-ellipsis rv-change", `${change.label}${count}`));
    if (row.coverage !== "claimed") pick.append(element("span", "review-flag", "unmentioned"));
    line.append(pick);
    item.append(line, detail);
    return item;
  }

  /** The change itself as one line: parameters that came or went, then the effects. */
  function changeLine(entry: ContractRow): string {
    const { before, after, effects } = entry.move;
    const parts: string[] = [];
    if (entry.move.kind === "changed" && before !== null && after !== null) parts.push(signatureChange(before, after).text);
    else if (entry.move.kind === "exposed") parts.push("now exported");
    else if (entry.move.kind === "unexported") parts.push("no longer exported");
    if (effects !== undefined) parts.push(...effects.added.map((label) => `+ ${effectChip(label)}`), ...effects.removed.map((label) => `− ${effectChip(label)}`));
    return parts.filter((part) => part !== "").join("  ");
  }

  function contractRow(entry: ContractRow, showChange: boolean): HTMLElement {
    const kind = entry.move.kind;
    const item = element("li", `review-row contract contract-${kind}`);
    const detail = contractDetail(entry);
    const line = element("div", "review-line");
    line.append(element("span", "review-toggle"));
    const pick = picker("review-pick contract-pick", detail, () => input.pickNode(entry.id));
    pick.dataset.id = entry.id;
    const change = showChange ? changeLine(entry) : "";
    pick.title = change === "" ? `${entry.label} in ${entry.path}` : `${entry.label}: ${change}`;
    pick.append(element("span", `review-mark contract-${kind}`, CONTRACT_MARK[kind]), element("span", "review-label rv-name", entry.label));
    pick.append(element("span", "contract-where rv-ellipsis rv-change", showChange ? change : entry.path.slice(entry.path.lastIndexOf("/") + 1)));
    if (entry.unmentioned) pick.append(element("span", "review-flag", "unmentioned"));
    line.append(pick);
    item.append(line, detail);
    return item;
  }

  /** What a selected contract adds: where it is, the signatures in full, every effect. */
  function contractDetail(entry: ContractRow): HTMLElement {
    const detail = element("div", "rv-detail contract-text");
    detail.hidden = true;
    detail.append(element("span", "contract-where", `${entry.level} in ${entry.path}`));
    const { before, after } = entry.move;
    if (entry.move.kind !== "effects" && before !== null && after !== null) {
      const diff = signatureDiff(before, after);
      const was = element("span", "contract-sig before");
      was.append(element("span", "contract-side", "before"), diff.prefix, element("mark", "removed", diff.removed), diff.suffix);
      const now = element("span", "contract-sig after");
      now.append(element("span", "contract-side", "after"), diff.prefix, element("mark", "added", diff.added), diff.suffix);
      detail.append(was, now);
    } else if (before !== null || after !== null) {
      const only = element("span", "contract-sig");
      only.append(element("span", "contract-side", before !== null ? "was" : "now"), before ?? after ?? "");
      detail.append(only);
    }
    const found = entry.move.effects;
    if (found !== undefined) detail.append(chips(found.added, "+", "added"), chips(found.removed, "−", "removed"));
    return detail;
  }

  function chips(labels: readonly string[], mark: string, kind: "added" | "removed", plain = false): DocumentFragment {
    const fragment = document.createDocumentFragment();
    if (labels.length === 0) return fragment;
    const line = element("span", "effect-chips");
    for (const label of labels) {
      const chip = element("span", `effect-chip ${kind}`, `${mark}${plain ? shortToken(label) : effectChip(label)}`);
      chip.title = label;
      line.append(chip);
    }
    fragment.append(line);
    return fragment;
  }

  // Tests

  function fillTests(body: HTMLElement): void {
    if (input.observed !== null) body.append(...observedBody(input.observed, input.pickNode));
    const changes = testChangesBlock(input.testChanges, input.pickNode);
    if (changes !== null) body.append(changes);
  }

  // Rows

  interface Question {
    readonly id: RowId;
    readonly name: string;
    readonly tag: string;
    readonly summary: string;
    readonly fill: (body: HTMLElement) => void;
    readonly about?: string;
  }

  const result = input.unmentioned;
  const tested = input.observed !== null || testChangesBlock(input.testChanges, input.pickNode) !== null;
  const weakened = input.testChanges.deletedFiles.length + input.testChanges.removedTests.length + input.testChanges.markers.length + input.testChanges.weakened.length;
  const questions: Question[] = [
    { id: "claims", name: "Claims", tag: "claimed", summary: claimsSummary(input.description, input.claims, input.link.status, input.context.length), fill: fillClaims },
    {
      id: "unmentioned",
      name: "Unmentioned",
      tag: "derived",
      summary: unmentionedSummary({ files: result === null ? null : result.unmentionedFiles - result.linkedFiles, calls: (input.effects?.none.edges ?? 0) + (input.effects?.none.tests.edges ?? 0), changed: input.effects?.changed.none.length ?? 0 }),
      fill: fillUnmentioned,
    },
    {
      id: "contracts",
      name: "Contracts moved",
      tag: "derived",
      summary: input.contracts === null ? "none" : contractsSummary(input.contracts.counts, input.contracts.effectsChanged.length),
      fill: fillContracts,
    },
    ...(tested
      ? [
          {
            id: "tests" as const,
            name: "Tests",
            tag: input.observed === null ? "derived" : "observed",
            summary: testsSummary(input.observed?.document ?? null, weakened),
            fill: fillTests,
            ...(input.observed === null ? {} : { about: observedNote(input.observed.document) }),
          },
        ]
      : []),
  ];

  const bodies = new Map<RowId, { section: HTMLElement; body: HTMLElement; button: HTMLButtonElement; chevron: HTMLElement; filled: boolean; fill: (body: HTMLElement) => void }>();
  const setOpen = (open: RowId): void => {
    for (const [id, found] of bodies) {
      const isOpen = id === open;
      found.section.classList.toggle("open", isOpen);
      found.body.hidden = !isOpen;
      found.button.setAttribute("aria-expanded", String(isOpen));
      found.chevron.textContent = isOpen ? "▾" : "▸";
      if (isOpen && !found.filled) {
        found.filled = true;
        found.fill(found.body);
      }
    }
  };

  const sections: HTMLElement[] = [];
  for (const question of questions) {
    const wrap = element("section", "rv-row");
    const head = element("h2", "rv-head");
    const button = element("button", "rv-toggle");
    button.type = "button";
    button.setAttribute("aria-expanded", "false");
    const bodyId = `review-body-${question.id}`;
    button.setAttribute("aria-controls", bodyId);
    const chevron = element("span", "rv-chevron", "▸");
    button.append(chevron, element("span", "rv-name-label", `${question.name}:`), element("span", "rv-summary", question.summary), element("span", `review-tag ${question.tag}`, question.tag));
    if (question.about !== undefined) button.title = question.about;
    head.append(button);
    const body = element("div", "rv-body");
    body.id = bodyId;
    body.hidden = true;
    wrap.append(head);
    if (question.about !== undefined) {
      const note = element("p", "rv-note", question.about);
      note.hidden = true;
      const info = element("button", "rv-info", "ⓘ");
      info.type = "button";
      info.setAttribute("aria-expanded", "false");
      info.setAttribute("aria-label", "About these results");
      info.title = question.about;
      info.addEventListener("click", () => {
        note.hidden = !note.hidden;
        info.setAttribute("aria-expanded", String(!note.hidden));
      });
      head.append(info);
      wrap.append(note);
    }
    wrap.append(body);
    button.addEventListener("click", () => {
      remember(question.id);
      setOpen(question.id);
    });
    bodies.set(question.id, { section: wrap, body, button, chevron, filled: false, fill: question.fill });
    sections.push(wrap);
  }

  const saved = remembered();
  const fallback: RowId = input.description === null ? "unmentioned" : "claims";
  setOpen(questions.find((question) => question.id === saved)?.id ?? fallback);

  // About this run

  const about = element("footer", "rv-about");
  const aboutBody = element("div", "rv-about-body");
  aboutBody.id = "review-about";
  aboutBody.hidden = true;
  const aboutButton = element("button", "rv-about-toggle", "ⓘ About this run");
  aboutButton.type = "button";
  aboutButton.setAttribute("aria-expanded", "false");
  aboutButton.setAttribute("aria-controls", "review-about");
  aboutButton.addEventListener("click", () => {
    aboutBody.hidden = !aboutBody.hidden;
    aboutButton.setAttribute("aria-expanded", String(!aboutBody.hidden));
  });
  const notes: [string, string][] = [
    ["Claims", linkNote(input.link)],
    ["Unmentioned", "A change counts as mentioned when its path or name appears in the description, or an agent links it. New calls out are direct calls to runtime built-ins only; calls through other modules are not followed yet."],
    ...(input.observed === null ? [] : observedAbout(input.observed))
  ];
  for (const [title, text] of notes) aboutBody.append(element("h3", "review-subtitle", title), element("p", "rv-note", text));
  about.append(aboutBody, aboutButton);

  host.replaceChildren(...sections, about);
}
