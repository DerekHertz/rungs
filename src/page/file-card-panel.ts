import { certificationLine, fileCard, markOf, omittedText, shownPath } from "../file-card.ts";
import type { CardLine, DocTerm, Stakes, VocabularyDoc } from "../file-card.ts";
import type { FileWhy } from "../defining.ts";
import type { LineRange, NodeId } from "../graph.ts";

/** What the file card needs from the page. Everything it shows from the store is untrusted text: it is set as text, never as markup. */
export interface CardActions {
  /** `GET /vocabulary.json`; null when it could not be fetched. */
  readonly doc: VocabularyDoc | null;
  readonly path: string;
  /** The file's role; undefined for a file the role table does not recognise. */
  readonly role: string | undefined;
  /** What the comparison did to the file: added, altered, moved. */
  readonly kind: string | undefined;
  /** A pin or a member was clicked: select the node, banding `marked` in it when given. */
  readonly pickNode: (id: NodeId, marked?: LineRange) => void;
  /** Optional until stakes exist (#199). */
  readonly stakes?: Stakes;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ""): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
};

const lines = (range: LineRange | null): string => (range === null ? "" : range.start === range.end ? ` L${range.start}` : ` L${range.start}-${range.end}`);

/** A button that opens and closes `below`, built once on the first click. */
function opener(button: HTMLButtonElement, title: string, make: () => HTMLElement, place: (below: HTMLElement) => void): void {
  let below: HTMLElement | undefined;
  button.type = "button";
  button.setAttribute("aria-expanded", "false");
  button.addEventListener("click", () => {
    if (below === undefined) {
      below = make();
      place(below);
    } else below.hidden = !below.hidden;
    button.setAttribute("aria-expanded", `${!below.hidden}`);
    button.textContent = `${below.hidden ? "▸" : "▾"} ${title}`;
  });
}

/** A line of a term's detail that opens a node when it can, and is plain text with its reason when it cannot. */
function pointer(text: string, id: NodeId | undefined, why: string, open: () => void): HTMLElement {
  if (id === undefined) {
    const plain = el("div", "card-pin", text);
    plain.title = why;
    return plain;
  }
  const button = el("button", "card-pin card-pin-open", text);
  button.type = "button";
  button.addEventListener("click", open);
  return button;
}

/** What clicking a term shows: where the repository writes it (derived) and which functions belong to it (judged), each with its probability. */
function termDetail(term: DocTerm, doc: VocabularyDoc, actions: CardActions): HTMLElement {
  const detail = el("div", "card-term-detail");
  detail.append(el("div", "card-heading", `${term.name}: ${term.summary.kind}, ${term.summary.why}`));
  // What a person did to the term (human tier), and whether anyone certified the vocabulary it is in.
  const done = [term.confirmed === undefined ? "" : `confirmed by ${term.confirmed.by} at ${term.confirmed.at}`, term.renamedFrom === undefined ? "" : `renamed from ${term.renamedFrom}`, term.mergedFrom === undefined ? "" : `merged in: ${term.mergedFrom.join(", ")}`].filter((part) => part !== "");
  if (done.length > 0) detail.append(el("div", "card-note", done.join("; ")));
  if (doc.certification !== undefined) detail.append(el("div", "card-note", `vocabulary ${certificationLine(doc.certification)}`));
  if (term.proposed !== undefined) {
    detail.append(el("div", "card-heading card-claimed", `Proposed by ${term.proposed.model} (claimed, not written in the repository)`));
    detail.append(el("div", "card-pin", term.proposed.description));
    detail.append(el("div", "card-pin", `files it named: ${term.proposed.files.join(", ")}`));
  }
  detail.append(el("div", "card-heading", "Written in the repository (derived)"));
  if (term.pins.length === 0) detail.append(el("div", "card-pin", term.proposed === undefined ? "nowhere the store kept" : "nowhere: a model proposed this term"));
  for (const pin of term.pins) {
    const where = `${pin.source} · ${shownPath(pin.path)}${lines(pin.range)} · ${pin.written}`;
    const reason = pin.why ?? "a folder: it has no lines";
    detail.append(pointer(where, pin.id, reason, () => actions.pickNode(pin.id!, pin.range ?? undefined)));
  }
  detail.append(el("div", "card-heading", "Members (judged, or corrected by a person)"));
  if (!doc.judged && term.members.length === 0) detail.append(el("div", "card-pin", "not judged (run streets setup --judge)"));
  else if (term.members.length === 0) detail.append(el("div", "card-pin", term.summary.kind === "no members" ? `no members: ${term.summary.why}` : `none known: ${term.summary.why}`));
  for (const member of term.members) {
    const text = `${markOf(member)} ${member.level} ${member.name === null ? "withheld" : member.name} in ${shownPath(member.path)}${member.state === "stale" ? ` · stale: ${member.why ?? "out of date"}` : ""}`;
    detail.append(pointer(text, member.id, "not in this tree", () => actions.pickNode(member.id!)));
  }
  if (term.correctedAway !== undefined) detail.append(el("div", "card-pin", `${term.correctedAway} judged ${term.correctedAway === 1 ? "member" : "members"} corrected by a person to not a member`));
  if (term.membersOmitted !== undefined) detail.append(el("div", "card-pin", omittedText(term.membersOmitted)));
  if (doc.built !== undefined) detail.append(el("div", "card-note", `built from ${doc.built.ref} at ${doc.built.commit.slice(0, 7)}`));
  return detail;
}

function lineElement(line: CardLine, doc: VocabularyDoc | null, actions: CardActions): HTMLElement {
  const wrap = el("div", "card-line");
  wrap.append(el("span", `card-tier ${line.tier}`, line.tier));
  if (line.label !== "") wrap.append(el("span", "card-label", line.label));
  let detail: HTMLElement | undefined;
  for (const chip of line.chips ?? []) {
    const button = el("button", chip.claimed === true ? "card-term card-term-claimed" : "card-term", chip.text);
    button.title = chip.claimed === true ? `${chip.name}: a term a model proposed (claimed); which functions belong to it is judged` : `${chip.name}: where it is written and which functions belong to it`;
    button.type = "button";
    button.addEventListener("click", () => {
      const term = doc?.terms.find((one) => one.key === chip.key);
      if (term === undefined || doc === null) return;
      detail?.remove();
      const same = detail?.dataset.term === chip.key;
      detail = undefined;
      if (same) return;
      detail = termDetail(term, doc, actions);
      detail.dataset.term = chip.key;
      wrap.after(detail);
    });
    wrap.append(button);
  }
  if (line.text !== "") wrap.append(el("span", "card-text", line.text));
  if (line.note !== undefined) wrap.append(el("span", "card-note", line.note));
  if (line.list !== undefined) {
    const list = line.list;
    const more = el("button", "why-toggle", `▸ list (${list.length})`);
    opener(more, `list (${list.length})`, () => {
      const steps = el("div", "why-steps");
      for (const entry of list) steps.append(el("div", "why-step", entry));
      return steps;
    }, (below) => wrap.after(below));
    wrap.append(more);
  }
  return wrap;
}

/** The card: what the file is and why to care, before its lines. Each line says whether it is judged or derived. */
export function renderFileCard(found: FileWhy, actions: CardActions): HTMLElement {
  const card = el("div", "card");
  card.setAttribute("aria-label", "What this file is and why it matters");
  const rows = fileCard({ doc: actions.doc, file: actions.doc?.files.find((file) => file.path === actions.path), role: actions.role, ...(actions.kind === undefined ? {} : { kind: actions.kind }), why: found.why, ...(actions.stakes === undefined ? {} : { stakes: actions.stakes }) });
  for (const entry of rows) {
    const row = el("div", "card-row");
    row.append(el("div", "card-heading", entry.label));
    for (const line of entry.lines) row.append(lineElement(line, actions.doc, actions));
    card.append(row);
  }
  return card;
}
