import { tallyText } from "../compare.ts";
import type { ChangeKind } from "../compare.ts";
import type { ReviewEntry, Unmentioned } from "../review.ts";

const MARK: Record<ChangeKind, string> = { added: "+", altered: "~", removed: "−", moved: "→" };

export interface ReviewInput {
  /** The claimed description, or null when none was given. */
  readonly description: string | null;
  /** Null when there is no description to check changes against. */
  readonly unmentioned: Unmentioned | null;
  /** The user picked an entry; the host selects and flies to its place. */
  readonly pick: (entry: ReviewEntry) => void;
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

/** Fills `host` with Claims and Unmentioned. Everything user-supplied goes in as text. */
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

  host.replaceChildren(claims, unmentioned);
}
