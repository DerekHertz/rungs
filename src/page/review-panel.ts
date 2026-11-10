import { tallyText } from "../compare.ts";
import type { ChangeKind } from "../compare.ts";
import { signatureDiff } from "../review.ts";
import type { ContractRollup, ContractRow, ContractsReport, ReviewEntry, Unmentioned } from "../review.ts";
import type { NodeId } from "../graph.ts";

const CONTRACT_MARK: Record<ContractRow["move"]["kind"], string> = {
  changed: "~",
  added: "+",
  removed: "−",
  exposed: "↑",
  unexported: "↓",
  moved: "→",
};

const MARK: Record<ChangeKind, string> = { added: "+", altered: "~", removed: "−", moved: "→" };

export interface ReviewInput {
  /** The claimed description, or null when none was given. */
  readonly description: string | null;
  /** Null when there is no description to check changes against. */
  readonly unmentioned: Unmentioned | null;
  /** Null without a comparison to derive them from. */
  readonly contracts: ContractsReport | null;
  /** The user picked an entry; the host selects and flies to its place. */
  readonly pick: (entry: ReviewEntry) => void;
  /** The user picked a contract row or a file rollup; the host selects and flies to the node or file. */
  readonly pickNode: (id: NodeId) => void;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const made = document.createElement(tag);
  made.className = className;
  if (text !== undefined) made.textContent = text;
  return made;
}

function section(title: string, tag: string): [HTMLElement, HTMLElement] {
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
  } else {
    claimsBody.append(element("pre", "review-claim", input.description));
  }

  const [unmentioned, unmentionedBody] = section("Unmentioned", "derived");
  const result = input.unmentioned;
  if (result === null) {
    unmentionedBody.append(element("p", "review-empty", "No description was given, so no change can be checked against a claim."));
  } else {
    const rows = result.entries.length;
    unmentionedBody.append(
      element("p", "review-summary", `${result.unmentionedFiles} of ${result.changedFiles} changed files are not in the description (${rows} ${rows === 1 ? "row" : "rows"}).`),
    );
    if (rows === 0) unmentionedBody.append(element("p", "review-empty", "Every changed file is mentioned."));
    const list = element("ul", "review-list");
    for (const entry of result.entries) list.append(row(entry));
    unmentionedBody.append(list);
  }

  function row(entry: ReviewEntry): HTMLElement {
    const item = element("li", `review-row level-${entry.level}`);
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
        if (!nested.hidden && nested.childElementCount === 0) for (const child of entry.children) nested.append(row(child));
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
    const parts = (["changed", "removed", "unexported", "exposed", "moved", "added"] as const)
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
    if (before !== null && after !== null) {
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
    pick.append(text);
    pick.addEventListener("click", () => choose(pick, entry.id));
    line.append(pick);
    item.append(line);
    return item;
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

  host.replaceChildren(claims, unmentioned, contracts);
}
