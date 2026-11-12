import type { LineRange } from "../graph.ts";
import { percent } from "../judged-marks.ts";
import type { StandardLine, StandardsView } from "../standards-marks.ts";
import { judgedDetail } from "./judged-panel.ts";
import { element } from "./review-panel.ts";

/** The Standards row's pieces that are text only; the row's picking and marks live in the review panel. Everything goes in as text. */

const lines = (range: LineRange | null): string => (range === null ? "none" : range.start === range.end ? `line ${range.start}` : `lines ${range.start}-${range.end}`);

/** "AGENTS.md > Project > Tests": the rule's file and its section. */
export function ruleName(rule: NonNullable<StandardLine["rule"]>): string {
  return [rule.path, ...rule.ancestors, rule.heading].filter((part) => part !== "").join(" > ");
}

/** The hunk as one short place: the head's lines, or the base's for a removed file. */
export function hunkPlace(hunk: NonNullable<StandardLine["hunk"]>): string {
  const range = hunk.head ?? hunk.base;
  return range === null ? hunk.path : `${hunk.path}:${range.start === range.end ? range.start : `${range.start}-${range.end}`}`;
}

/** What the base already did, in words: a new violation is told from one that was already there. */
export function baseWords(line: StandardLine): string {
  if (line.base === "unknown") return "the base's answer is unknown";
  return line.base === "already" ? "the base's lines already broke it" : "the base's lines did not";
}

/** One line of the row as a person reads it: the probability, the hunk, the rule. */
export function lineText(line: StandardLine): string {
  const how = line.breaks === null ? "" : `${percent(line.breaks)} `;
  if (line.rule === undefined || line.hunk === undefined) return line.mark.kind === "not judged" ? `not judged: ${line.mark.reason}` : "judging…";
  const already = line.mark.kind === "judged" && line.mark.verdict === "undecided" && line.base === "already" ? " (already in the base)" : "";
  return `${how}${hunkPlace(line.hunk)} · ${ruleName(line.rule)}${already}`;
}

/** The sentences at the top of the row: which rule files were read and how, why nothing was judged, what could not be read. */
export function standardsIntro(view: StandardsView): HTMLElement[] {
  const { standards, document } = view;
  const out: HTMLElement[] = [];
  if (standards.status === "none") return [element("p", "review-empty", "No written rules were found in the base: none of the files the table names (AGENTS.md, CLAUDE.md, CONTRIBUTING.md, style guides) holds a section.")];
  if (standards.status === "unknown") return [element("p", "review-empty", `The base's rules could not be read${standards.reason === undefined ? "" : `: ${standards.reason}`}, so there may be some. Nothing was judged.`)];
  const files = new Map<string, { sections: number; edited: boolean | null; scope: string }>();
  for (const rule of standards.rules) {
    const known = files.get(rule.path);
    files.set(rule.path, { sections: (known?.sections ?? 0) + 1, edited: rule.edited, scope: rule.scope });
  }
  const list = element("ul", "review-list");
  for (const [path, file] of files) {
    const item = element("li", "review-row");
    item.append(element("span", "review-source", `${path}: ${file.sections} ${file.sections === 1 ? "section" : "sections"}${file.scope === "" ? "" : `, applies under ${file.scope}/ only`}${file.edited === true ? ", edited by this change (judged by the base's text)" : ""}`));
    list.append(item);
  }
  out.push(element("p", "rv-note", "Rules are read from the base, never from this change. Each changed hunk is asked against each rule in its scope; a section that is not a rule about code, or only states what a linter checks, answers no."), list);
  if (standards.unread.length > 0) out.push(element("p", "review-warning", `Rule files that could not be read, so the list may be incomplete: ${standards.unread.join(", ")}.`));
  if (document === null) out.push(element("p", "review-empty", "Not judged: the page could not read the judged document."));
  else if (document.status === "off") out.push(element("p", "review-empty", `Not judged: ${document.reason}`));
  return out;
}

/** The click-through of one line: the rule, the hunk, whether the base already broke it, and the check itself with what Jev was shown. */
export function standardDetail(line: StandardLine, view: StandardsView): HTMLElement {
  const box = element("div", "standard-detail");
  if (line.rule !== undefined) {
    const edited = line.rule.edited === true ? "; the change edited this file, and the rule is read from the base" : "";
    box.append(element("p", "judged-line", `Rule: ${ruleName(line.rule)}, ${lines(line.rule.lines)} of the base${edited}.`));
  }
  if (line.hunk !== undefined) box.append(element("p", "judged-line", `Hunk: ${line.hunk.path}, base ${lines(line.hunk.base)}, head ${lines(line.hunk.head)}.`));
  if (line.mark.kind === "judged") box.append(element("p", "judged-line", `Before the change: ${baseWords(line)}.`));
  box.append(judgedDetail(line.mark, { marks: new Map(), rate: () => view.rate, adopted: () => view.adopted }));
  return box;
}
