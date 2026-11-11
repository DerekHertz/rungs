import { EVIDENCE_LINE, UNSANDBOXED_LINE } from "../observed-types.ts";
import { ROLLUP_OVER, signatureDiff } from "../review.ts";
import type { LineRange, NodeId } from "../graph.ts";
import { walkStatus } from "../stops.ts";
import type { Observed, StopEffect, StopFacts, StopTest, WalkNote } from "../stops.ts";
import type { Stop } from "../tour.ts";
import { changeNote, drawRows, markRows } from "./code-rows.ts";
import type { Drawn, Loaded } from "./code-rows.ts";
import { element } from "./review-panel.ts";

export interface WalkInput {
  readonly note: WalkNote;
  readonly stops: readonly Stop[];
  /** How many of the changed files the stops point at or into. */
  readonly coverage: { readonly covered: number; readonly changed: number };
  /** The description's claims, by index. */
  readonly claims: readonly { readonly index: number; readonly text: string }[];
  /** The derived facts at a stop and what its narration leaves out. */
  readonly facts: (stop: Stop) => StopFacts;
  readonly observed: (stop: Stop) => Observed;
  /** A node's name. */
  readonly describe: (id: NodeId) => { readonly label: string };
  /** The node's source lines as rows, changed ones marked, or undefined when it has none. */
  readonly rows: (id: NodeId) => Promise<Loaded | undefined>;
  /** The reviewer came to a stop, or closed the tour; the host flies the picture to its nodes. */
  readonly visit: (stop: Stop | undefined) => void;
}

export interface Walk {
  /** One stop forward or back. Forward starts a tour that is closed. */
  step(by: 1 | -1): void;
}

const where = (range: LineRange): string => (range.start === range.end ? `line ${range.start}` : `lines ${range.start}-${range.end}`);

/**
 * Fills `host` with the walkthrough: a bar that says how the tour was made, and, once started, one
 * stop at a time in four columns: what the description expects, what the agent says, what the
 * code is, and what was observed. Everything the agent or the description wrote goes in as text.
 */
export function renderWalkthrough(host: HTMLElement, input: WalkInput): Walk {
  const { stops } = input;
  let index = -1;
  let ticket = 0;
  let shown: NodeId | undefined;

  const bar = element("header", "walk-bar");
  const title = element("h2", "review-title", "Walkthrough");
  title.append(element("span", "review-tag claimed", "claimed"));
  const status = element("span", "walk-status");
  const back = element("button", "walk-button", "Back (←)");
  const next = element("button", "walk-button");
  const close = element("button", "walk-button", "Close");
  for (const button of [back, next, close]) button.type = "button";
  bar.append(title, status, back, next, close);
  const body = element("div", "walk-body");
  host.replaceChildren(bar, body);

  const column = (name: string, tag: string): HTMLElement => {
    const wrap = element("section", `walk-column walk-${tag}`);
    const head = element("h3", "walk-head", name);
    head.append(element("span", `review-tag ${tag}`, tag));
    const inner = element("div", "walk-inner");
    wrap.append(head, inner);
    body.append(wrap);
    return inner;
  };
  const expectedBody = column("Expected", "claimed");
  const saysBody = column("Agent says", "claimed");
  const codeBody = column("Code", "derived");
  const observedBody = column("Observed", "observed");

  const tabs = element("div", "walk-tabs");
  const facts = element("div", "walk-facts");
  const lines = element("div", "walk-source");
  const gutter = element("pre", "walk-gutter");
  const text = element("pre", "walk-code");
  const mark = element("div", "walk-mark");
  const changes = element("p", "walk-changes");
  mark.hidden = true;
  lines.append(gutter, text, mark);
  codeBody.append(tabs, facts, changes, lines);
  const parts = { gutter, code: text, body: lines, mark };
  let drawn: Drawn | undefined;

  /** Shows one node's source lines in the Code column, its changes marked, scrolled to the first one in `range`. */
  async function show(id: NodeId, range: LineRange | undefined): Promise<void> {
    const mine = ++ticket;
    if (shown !== id) {
      const loaded = await input.rows(id);
      if (mine !== ticket) return;
      shown = id;
      drawn = drawRows(parts, loaded?.rows ?? []);
      if (loaded === undefined) text.textContent = "No source lines are served for this node.";
      const note = loaded === undefined ? undefined : changeNote(loaded.rows, loaded.tooLarge);
      changes.textContent = note ?? "";
      changes.hidden = note === undefined;
      for (const tab of tabs.children) tab.classList.toggle("active", (tab as HTMLElement).dataset.id === id);
    }
    if (drawn !== undefined) markRows(parts, drawn, range);
  }

  function draw(): void {
    const stop = stops[index];
    host.classList.toggle("open", stop !== undefined);
    back.hidden = close.hidden = stop === undefined;
    back.disabled = index <= 0;
    next.hidden = stops.length === 0;
    next.disabled = stop !== undefined && index >= stops.length - 1;
    next.textContent = stop === undefined ? "Start (→)" : "Next (→)";
    status.textContent = stop === undefined ? walkStatus(input.note, stops.length) : `Stop ${index + 1} of ${stops.length}: ${stop.title}`;
    if (stop === undefined) return;
    const found = input.facts(stop);
    shown = undefined;

    expectedBody.replaceChildren(
      ...(stop.claims.length === 0
        ? [element("p", "review-empty", "The agent names no claim this stop fulfils.")]
        : stop.claims.map((claim) => element("p", "review-claim walk-claim", input.claims[claim]?.text ?? ""))),
    );

    let active: HTMLElement | undefined;
    const choose = (button: HTMLElement, id: NodeId, range: LineRange | undefined): void => {
      active?.classList.remove("active");
      active = button;
      button.classList.add("active");
      void show(id, range);
    };
    const sentences = stop.sentences.map((sentence) => {
      const button = element("button", "walk-sentence");
      button.type = "button";
      button.append(element("span", "walk-text", sentence.text), element("span", "contract-where", `${input.describe(sentence.id).label} · ${where(sentence.range)}`));
      button.addEventListener("click", () => choose(button, sentence.id, sentence.range));
      return button;
    });
    const notes = found.notes.map((note) => {
      const line = element("p", "walk-note", note);
      line.prepend(element("span", "review-tag derived", "derived"));
      return line;
    });
    saysBody.replaceChildren(...(sentences.length === 0 ? [element("p", "review-empty", "No narration is anchored to this stop's lines.")] : sentences), ...notes);

    tabs.replaceChildren(
      ...stop.ids.map((id) => {
        const tab = element("button", "walk-tab", input.describe(id).label);
        tab.type = "button";
        tab.dataset.id = id;
        tab.addEventListener("click", () => choose(tab, id, undefined));
        return tab;
      }),
    );
    facts.replaceChildren(...moveRows(found), ...effectRows(found.effects, choose));
    if (facts.childElementCount === 0) facts.append(element("p", "review-empty", "No contract moved and no new call reaches outside at this stop."));

    observedBody.replaceChildren(...observedRows(input.observed(stop)));

    const first = sentences[0];
    if (first !== undefined) first.click();
    else void show(stop.ids[0]!, undefined);
  }

  function observedRows(observed: Observed): HTMLElement[] {
    const rows: HTMLElement[] = [];
    const changes = (): void => {
      if (observed.changes.length === 0) return;
      rows.push(element("p", "walk-observed", "this PR changed the tests here"));
      for (const change of observed.changes) rows.push(element("p", "walk-fact", change));
    };
    if (observed.status === "not run") {
      rows.push(element("p", "walk-observed", "not run"), element("p", "review-empty", "No test run is recorded for this stop."));
      changes();
      return rows;
    }
    rows.push(element("p", "review-summary observed-trust", EVIDENCE_LINE));
    if (observed.unsandboxed) rows.push(element("p", "review-warning", `Tests ${UNSANDBOXED_LINE}.`));
    if (observed.status !== "ran") {
      rows.push(element("p", "review-warning", `Tests ${observed.status === "refused" || observed.status === "unsupported" ? "not run" : observed.status === "failed" ? "run failed" : "results unreliable"}: ${observed.why}.`));
      changes();
      return rows;
    }
    const mark = (outcome: StopTest["outcome"]): string => (outcome === "fail" ? "✗" : outcome === "pass" ? "✓" : "·");
    const list = (tests: readonly StopTest[]): HTMLElement => {
      const made = element("ul", "review-list");
      for (const test of tests) {
        const item = element("li", "review-row observed-loose");
        const text = element("span", "contract-text");
        text.append(element("span", "review-label", test.name || "(the whole file)"), element("span", "contract-where", test.why === undefined ? test.file : `${test.file} · ${test.why}`));
        if (test.message !== undefined) text.append(element("span", "observed-message", test.message.split("\n")[0] ?? ""));
        item.append(element("span", `review-mark observed-${test.outcome}`, mark(test.outcome)), text);
        made.append(item);
      }
      return made;
    };
    if (observed.results.length > 0) rows.push(element("p", "walk-observed", "main's tests at this stop"), list(observed.results));
    if (observed.written.length > 0 || observed.writtenProblem !== undefined) {
      const head = element("p", "walk-observed", "written by this PR (claimed)");
      head.append(element("span", "review-tag claimed", "claimed"));
      rows.push(head, element("p", "review-empty", "Not evidence: the PR wrote these tests."));
      if (observed.writtenProblem !== undefined) rows.push(element("p", "review-warning", `These tests did not give results (${observed.writtenProblem.status}): ${observed.writtenProblem.why}.`));
      if (observed.written.length > 0) rows.push(list(observed.written));
    }
    changes();
    if (observed.results.length === 0 && observed.written.length === 0 && observed.writtenProblem === undefined) rows.push(element("p", "review-empty", "no test attached"));
    return rows;
  }

  function moveRows(found: StopFacts): HTMLElement[] {
    const rows: HTMLElement[] = [];
    const bulk = (["added", "moved"] as const).filter((kind) => found.moves.filter((entry) => entry.move.kind === kind).length > ROLLUP_OVER);
    for (const kind of bulk) rows.push(element("p", "walk-fact", `${found.moves.filter((entry) => entry.move.kind === kind).length} exports ${kind}`));
    for (const { move, label, mentioned } of found.moves) {
      if (bulk.some((kind) => kind === move.kind)) continue;
      const row = element("div", "walk-fact");
      const head = element("span", "contract-head");
      head.append(element("span", "review-label", `contract ${move.kind}: ${label}`));
      if (!mentioned) head.append(element("span", "review-flag", "not mentioned"));
      row.append(head);
      if (move.kind !== "effects" && move.before !== null && move.after !== null) {
        const diff = signatureDiff(move.before, move.after);
        const was = element("span", "contract-sig before");
        was.append(element("span", "contract-side", "before"), diff.prefix, element("mark", "removed", diff.removed), diff.suffix);
        const now = element("span", "contract-sig after");
        now.append(element("span", "contract-side", "after"), diff.prefix, element("mark", "added", diff.added), diff.suffix);
        row.append(was, now);
      } else if (move.kind !== "effects") {
        const only = element("span", "contract-sig");
        only.append(element("span", "contract-side", move.before !== null ? "was" : "now"), move.before ?? move.after ?? "");
        row.append(only);
      }
      for (const [mark, kind, labels] of [["+", "added", move.effects?.added ?? []], ["−", "removed", move.effects?.removed ?? []]] as const) {
        for (const label of labels) row.append(element("span", `walk-effect ${kind}`, `${mark} ${label}`));
      }
      rows.push(row);
    }
    return rows;
  }

  function effectRows(effects: readonly StopEffect[], choose: (button: HTMLElement, id: NodeId, range: LineRange) => void): HTMLElement[] {
    const groups = new Map<string, StopEffect[]>();
    for (const effect of effects) groups.set(`${effect.kind} ${effect.label}`, [...(groups.get(`${effect.kind} ${effect.label}`) ?? []), effect]);
    return [...groups.values()].map((calls) => {
      const { kind, label, mentioned } = calls[0]!;
      const row = element("div", "walk-fact");
      const head = element("span", "contract-head");
      head.append(element("span", "review-label", `${kind === "added" ? "new effect" : "effect removed"}: ${label}`));
      if (!mentioned) head.append(element("span", "review-flag", "not mentioned"));
      const places = element("span", "walk-calls");
      for (const call of calls) {
        if (call.kind === "removed") {
          // Its lines are the base's, so there is nothing in the shown source to band.
          places.append(element("span", "contract-where", `was in ${input.describe(call.at).label}`));
          continue;
        }
        const button = element("button", "walk-call", `${input.describe(call.at).label} · ${where(call.range)}`);
        button.type = "button";
        button.addEventListener("click", () => choose(button, call.at, call.range));
        places.append(button);
      }
      row.append(head, places);
      return row;
    });
  }

  function go(to: number): void {
    if (to === index || to < -1 || to >= stops.length) return;
    index = to;
    draw();
    input.visit(stops[index]);
  }
  back.addEventListener("click", () => go(index - 1));
  next.addEventListener("click", () => go(index + 1));
  close.addEventListener("click", () => go(-1));
  draw();
  return { step: (by) => go(Math.max(index + by, index === -1 ? -1 : 0)) };
}
