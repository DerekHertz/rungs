import { tallyText } from "../compare.ts";
import type { ChangeKind } from "../compare.ts";
import type { ReviewEntry, Unmentioned } from "../review.ts";

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

  host.replaceChildren(claims, unmentioned);
}
