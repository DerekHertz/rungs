import { reachMap } from "../reach.ts";
import { pictureOf } from "../compare.ts";
import type { Comparison } from "../compare.ts";
import { escapeStep, flyTarget } from "../focus.ts";
import { isCodeNode } from "../graph.ts";
import type { Edge, FileNode, Graph, LineRange, ModuleNode, NodeId, ResourceKind } from "../graph.ts";
import { commonDistrict, indexGraph, trail, zoomOut } from "../zoom.ts";
import type { ReviewEntry } from "../review.ts";
import type { PseudoLine } from "../pseudo-line.ts";
import { createTownView, loadSheet } from "./town-view.ts";
import type { CameraState } from "./town-view.ts";
import type { TownHandlers } from "./town-view.ts";
import { townOf, withGhosts } from "../town.ts";
import { importanceOf, reachedFrom } from "../importance.ts";
import type { WayIn } from "../importance.ts";
import { insideOf, marksOf } from "../town-inside.ts";
import { createTownInsideView } from "./town-inside-view.ts";
import type { PullRequestName } from "../arrival.ts";
import { setUpReview } from "./review-setup.ts";
import { hoverFacts } from "./hover-facts.ts";
import { showTownLegend } from "./legend-panel.ts";
import { showTooltip } from "./tooltip-card.ts";
import type { Lot } from "../town.ts";
import type { ObservedDocument } from "../observed-types.ts";
import { observedReport } from "../observed-report.ts";
import { markFailedLine, renderFailure } from "./failure-panel.ts";
import { changeNote, collapseRows, drawRows, loadRows, markRows, revealRange } from "./code-rows.ts";
import type { CodeParts, Drawn, Fold, Loaded } from "./code-rows.ts";
import { renderFileWhy } from "./file-why-panel.ts";
import type { Neighbours } from "./file-why-panel.ts";
import type { FileWhy } from "../defining.ts";
import type { TestChanges } from "../test-changes-types.ts";
import type { RiskItem } from "../risks.ts";
import { NO_TEST_MARKS, testMarks } from "../test-marks.ts";
import type { TestMark } from "../test-marks.ts";
import type { ClaimRow, ReviewHandle, ReviewSnapshot } from "./review-panel.ts";
import { enterStop, leaveTour, stopRow } from "../tour-selection.ts";
import type { SavedSelection } from "../tour-selection.ts";
import type { Walk } from "./walkthrough-panel.ts";
import type { Stop } from "../tour.ts";
import type { NarratedDoc } from "../narration.ts";
import { renderNarration } from "./narration-panel.ts";
import { activatable } from "./activatable.ts";
import { mountPicker } from "./pr-picker.ts";
import { backLabel, firstView, nextView } from "../narrow-view.ts";
import type { ViewEvent, ViewState } from "../narrow-view.ts";
import { isTyping, searchEntries } from "../find-files.ts";
import { wireFind } from "./find-panel.ts";
import type { FileHit } from "./find-panel.ts";

const tooltip = document.querySelector<HTMLDivElement>("#tooltip")!;
const breadcrumbs = document.querySelector<HTMLElement>("#trail")!;
const legend = document.querySelector<HTMLElement>("#legend")!;
const stage = document.querySelector<HTMLElement>("#stage")!;
const resetButton = document.querySelector<HTMLButtonElement>("#reset")!;
const panel = document.querySelector<HTMLElement>("#source")!;
const panelTitle = document.querySelector<HTMLElement>("#source-title")!;
const panelFacts = document.querySelector<HTMLElement>("#source-facts")!;
const panelGutter = document.querySelector<HTMLElement>("#source-gutter")!;
const panelCode = document.querySelector<HTMLElement>("#source-code")!;
const panelBody = document.querySelector<HTMLElement>("#source-body")!;
const outlinePane = document.querySelector<HTMLElement>("#outline")!;
const narrateToggle = document.querySelector<HTMLLabelElement>("#narrate-toggle")!;
const narrateBox = narrateToggle.querySelector("input")!;
const narrationPane = document.querySelector<HTMLElement>("#narration")!;
const failurePane = document.querySelector<HTMLElement>("#failure")!;
const panelClose = document.querySelector<HTMLButtonElement>("#source-close")!;
const backButton = document.querySelector<HTMLButtonElement>("#source-back")!;
const viewSwitch = document.querySelector<HTMLElement>("#views")!;
const findBox = document.querySelector<HTMLInputElement>("#find")!;
const findResults = document.querySelector<HTMLElement>("#find-results")!;
const findStatus = document.querySelector<HTMLElement>("#find-status")!;
/** The width at and below which the page shows one view at a time. Keep it equal to the media query in index.html. */
const narrowScreen = window.matchMedia("(max-width: 700px)");

const graph = (await (await fetch("/graph.json")).json()) as Graph;
const comparisonResponse = await fetch("/comparison.json");
const comparison = comparisonResponse.ok
  ? ((await comparisonResponse.json()) as Comparison & { against: { ref: string; commit: string; pr?: PullRequestName } })
  : null;
/** Narration is on offer only when the server was started with --narrate. */
const narrating = (await fetch("/narrate.json")).ok;
const picture = pictureOf(graph, comparison);
/** The base's outside calls in removed files: the picture's graph restores the removed nodes but keeps only the head's edges. */
const ghostEdges: readonly Edge[] = comparison === null ? [] : (await (await fetch("/ghost-edges.json")).json() as { edges: Edge[] }).edges;
const testChanges = comparison === null ? null : ((await (await fetch("/test-changes.json")).json()) as TestChanges);
/** The test files the change weakened or edited, which the town flags and whose weakened tests' rooms are marked. */
const marksOfTests = comparison === null || testChanges === null ? NO_TEST_MARKS : testMarks(testChanges);
const observedResponse = await fetch("/observed.json");
const observed = observedResponse.ok ? ((await observedResponse.json()) as ObservedDocument) : null;
const observedRun = observed?.status === "ran" && comparison !== null ? observedReport(observed, picture.graph, comparison) : null;
// Ghosts are in the picture's graph, so the trail, flying and the source panel reach them too.
const nodes = new Map<NodeId, ModuleNode>(picture.graph.nodes.map((node) => [node.id, node]));
// A module removed from a file that stays has no place in the picture, but its base source is served.
const changed = new Map<NodeId, ModuleNode>((comparison?.changes ?? []).map((change) => [change.node.id, change.node]));
// The old path of a moved file stands in the town as rubble but not in the picture's graph: its nodes can still be selected.
for (const change of comparison?.changes ?? []) if (change.kind === "moved" && !nodes.has(change.from.id)) changed.set(change.from.id, change.from);
/** The files a moved path left behind: in the town as rubble, so what is reported on them can be selected. */
const ghostFiles = new Map<NodeId, ModuleNode>(comparison === null ? [] : withGhosts(picture.graph, comparison).graph.nodes.filter((node) => node.level === "file" && !nodes.has(node.id)).map((node) => [node.id, node]));
const tree = indexGraph(picture.graph);
const townRoot = tree.root;
/** The folder the camera frames; the layout never follows it. */
let focus = townRoot;
/** True while the camera is off `focus`'s folder framing: on a block with no folder to focus (rubble only), or on the yard a removed file's rubble stands in. Cleared only when folder framing is restored. */
let alone = false;
let lots = new Map<NodeId, Lot>();
let selected: NodeId | undefined;
/** The files a manually picked risk or claim outlines, until something else is picked. */
let shownPlaces: readonly NodeId[] | undefined;
let requested = 0;
let pendingClick: ReturnType<typeof setTimeout> | undefined;

// Browsers don't expose the system's double-click interval; a click waits this long so that a
// double-click never also selects, and a panel opened by its first click can't take its second.
const DOUBLE_CLICK_MS = 250;

// Every user action starts here, so the latest one wins: a click still waiting out its
// double-click window, and any source request in flight, are dropped.
function cancelPending(): void {
  clearTimeout(pendingClick);
  requested++;
}

const sheet = await loadSheet();
const waysIn = ((await (await fetch("/ways-in.json")).json()) as { waysIn: WayIn[] }).waysIn;
/** The files a comparison's base had and the head lacks: a ghost has no place in reach. */
const ghostIds = new Set<NodeId>((comparison?.changes ?? []).flatMap((change) => (change.kind === "removed" && change.node.level === "file" ? [change.node.id] : change.kind === "moved" && change.from.level === "file" ? [change.from.id] : [])));
const reachedByWays = new Set([...reachedFrom(picture.graph, waysIn.map((way) => way.id)), ...ghostIds]);
const importance = importanceOf(picture.graph);

const reaches = reachMap(picture);

const handlers: TownHandlers = {
  hover(id, at) {
    const facts = id === undefined ? undefined : hoverFor(id);
    if (facts === undefined) {
      tooltip.style.display = "none";
      return;
    }
    showTooltip(tooltip, facts.join("\n"), at);
  },
  click(id, clicks) {
    if (clicks > 1) return;
    endTour();
    cancelPending();
    const ticket = requested;
    pendingClick = setTimeout(() => {
      const node = id === undefined ? undefined : (nodes.get(id) ?? ghostFiles.get(id));
      if (node === undefined) closePanel();
      else void select(node, ticket);
    }, DOUBLE_CLICK_MS);
  },
  resource(kind) {
    cancelPending();
    closePanel();
    chooseResource(chosenKind === kind ? undefined : kind);
  },
  doubleClick(hit) {
    // A double-click on a building opens its inside.
    cancelPending();
    if (hit?.kind === "building") openInside(hit.id);
    if (hit?.kind === "building" || hit?.kind === "resource") return;
    // A block only a moved file's old path stands in has no node in the picture's graph to focus: frame it alone.
    if (hit?.kind === "district" && !nodes.has(hit.id)) {
      alone = true;
      townView.flyTo(hit.id);
      return;
    }
    const to = hit === undefined ? zoomOut(tree, focus) : flyTarget(focus, hit.id);
    // From a block framed alone, leaving always moves the camera, even back to the folder `focus` already names.
    if (to !== undefined) focusOn(to);
    else if (alone) focusOn(focus, []);
  },
};
const flagged = new Map<NodeId, TestMark>([...marksOfTests.files].map(([path, mark]) => [`file:${path}` as NodeId, mark] as const).filter(([id]) => nodes.has(id)));
const townView = createTownView(stage, handlers, sheet, observedRun?.failingFiles, reaches, flagged);
const hoverFor = hoverFacts({ nodes, ghostFiles, lots: () => lots, picture, importance, waysIn, reachedByWays, marks: marksOfTests, observedRun });
const insideView = createTownInsideView(
    stage,
    {
      pick(id, lines) {
        cancelPending();
        const ticket = requested;
        const node = nodes.get(id);
        if (node === undefined) return;
        insideView.select(id);
        void select(node, ticket, node.id, lines);
      },
      hover(text, at) {
        if (text === undefined || at === undefined) {
          tooltip.style.display = "none";
          return;
        }
        showTooltip(tooltip, text, at);
      },
    },
    sheet,
  );
let insideFile: NodeId | undefined;

let chosenKind: ResourceKind | undefined;

/** Outlines every building that reaches `kind`, only the ones with a new edge to it under a comparison. */
function chooseResource(kind: ResourceKind | undefined): void {
  chosenKind = kind;
  const reaching = [...reaches]
    .filter(([id, reach]) => kind !== undefined && nodes.get(id)?.level === "file" && (comparison === null ? reach.kinds : reach.fresh).includes(kind))
    .map(([id]) => id);
  townView.highlight(reaching, kind);
}

/** The full list of files resting on `file`, in the pane the outline uses, each one opening on a click. */
function showRests(file: ModuleNode): boolean {
  const above = (importance.get(file.id) ?? []).map((id) => nodes.get(id)).filter((node): node is ModuleNode => node !== undefined);
  if (file.level !== "file" || above.length === 0) return false;
  const head = document.createElement("div");
  head.className = "outline-line";
  head.textContent = `${above.length} files rest on this one, through imports`;
  const rows = above.map((node) => {
    const row = activatable(document.createElement("div"));
    row.className = "outline-line";
    row.textContent = node.path;
    row.addEventListener("click", () => pickNode(node.id));
    return row;
  });
  outlinePane.replaceChildren(head, ...rows);
  return true;
}

/** Opens a file walls down over the town: its functions as rooms, its outside calls as objects. */
function openInside(fileId: NodeId): void {
  const file = nodes.get(fileId);
  if (file?.level !== "file") return;
  const marks = comparison === null || picture.overlay === null ? null : { ...marksOf(comparison, picture.overlay, file.id, file.path), tests: marksOfTests.tests.get(file.path) };
  const inside = insideOf(ghostEdges.length === 0 ? picture.graph : { ...picture.graph, edges: [...picture.graph.edges, ...ghostEdges] }, file.id, new Set(Object.keys(sheet.sizes)), marks);
  if (inside === undefined) return;
  closePanel();
  tooltip.style.display = "none";
  insideFile = file.id;
  legend.hidden = true;
  insideView.open(inside);
  showTrail();
}

/** Closes the inside and shows the town again, as it was. */
function leaveInside(): void {
  if (insideFile === undefined) return;
  closePanel();
  insideFile = undefined;
  insideView.close();
  legend.hidden = false;
  showTrail();
}

function showTown(): void {
  insideFile = undefined;
  insideView.close();
  legend.hidden = false;
  cancelPending();
  focus = townRoot;
  alone = false;
  selected = undefined;
  chosenKind = undefined;
  panel.hidden = true;
  tooltip.style.display = "none";
  const town = townOf(picture.graph, new Set(Object.keys(sheet.sizes)), comparison, waysIn, new Set(marksOfTests.files.keys()));
  lots = new Map(town.lots.map((lot) => [lot.id, lot]));
  townView.show(town);
  showTownLegend(legend, town, { comparison, observedRan: observed?.status === "ran", flagged, reaches });
  showTrail();
}

/**
 * Flies to a folder's block; the town itself stays as it is. `standing` names files whose rubble may stand
 * elsewhere than their folder (a yard): the camera then frames where their lots are, and `id` stays the trail's folder.
 */
function focusOn(id: NodeId, standing?: readonly NodeId[]): void {
  const wasAlone = alone;
  const displaced = standing !== undefined && standing.length > 0;
  alone = displaced;
  if (id === focus && !wasAlone && standing === undefined) return;
  focus = id;
  showTrail();
  if (displaced) townView.frame(standing);
  else townView.flyTo(id);
}

/** The files among these whose lot is rubble: only those can stand somewhere other than their folder. */
const rubbleAmong = (ids: readonly NodeId[]): readonly NodeId[] | undefined => (ids.some((id) => ghostIds.has(id)) ? ids : undefined);

function resetView(): void {
  leaveInside();
  cancelPending();
  focus = townRoot;
  alone = false;
  showTrail();
  townView.reset();
}

function showTrail(): void {
  const steps = trail(tree, insideFile ?? focus).map((node, index, all) => {
    const name = node.path === "" ? "/" : node.name;
    if (index === all.length - 1) {
      const here = document.createElement("span");
      here.textContent = name;
      return here;
    }
    const step = document.createElement("button");
    step.textContent = name;
    step.addEventListener("click", () => {
      cancelPending();
      leaveInside();
      focusOn(node.id);
    });
    return step;
  });
  breadcrumbs.replaceChildren(
    ...steps.flatMap((step, index) => {
      if (index === 0) return [step];
      const arrow = document.createElement("i");
      arrow.textContent = "›";
      return [arrow, step];
    }),
  );
}

function closePanel(): void {
  cancelPending();
  narrationTicket++;
  selected = undefined;
  shownPlaces = undefined;
  chosenKind = undefined;
  panel.hidden = true;
  setView({ type: "closed" });
  townView.select(undefined);
  insideView.select(undefined);
}

/** The reviewer closes the evidence (Back, the close button, Esc): it closes and focus returns to what opened it. */
function dismiss(): void {
  closePanel();
  const to = opener;
  opener = undefined;
  // On a narrow screen the list comes back exactly as it was, so focus must not scroll it.
  if (to?.isConnected === true) to.focus({ preventScroll: narrowScreen.matches });
}

/** A pick that only outlines places opens no evidence, so a narrow screen shows the town to make it visible; the list keeps its row and scroll. */
function showPick(): void {
  if (narrowScreen.matches) setView({ type: "show", view: "town", evidence: selected !== undefined });
}

/** The control that was focused when the evidence opened, which gets focus back when it closes. */
let opener: HTMLElement | undefined;
function rememberOpener(): void {
  const now = document.activeElement;
  if (now instanceof HTMLElement && now !== document.body && !panel.contains(now)) opener = now;
  else if (selected === undefined) opener = undefined;
}

let viewState: ViewState = firstView(false);

function setView(event: ViewEvent): void {
  viewState = nextView(viewState, event);
  paintViews();
}

/** The one view a narrow screen shows, and the switch that reaches the others. */
function paintViews(): void {
  document.body.dataset.view = viewState.view;
  for (const button of viewSwitch.querySelectorAll<HTMLButtonElement>("button")) {
    const view = button.dataset.view;
    button.setAttribute("aria-pressed", String(view === viewState.view));
    button.hidden = view === "list" && !viewState.hasList;
    const none = view === "evidence" && selected === undefined;
    button.setAttribute("aria-disabled", String(none));
    button.title = none ? "Select a file or a test first" : "";
  }
  backButton.textContent = `\u2039 ${backLabel(viewState.from, reviewHandle?.snapshot().open)}`;
}

viewSwitch.addEventListener("click", (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>("button");
  const view = button?.dataset.view;
  if (view !== "list" && view !== "town" && view !== "evidence") return;
  setView({ type: "show", view, evidence: selected !== undefined });
});
backButton.addEventListener("click", dismiss);

const sourceParts: CodeParts = { gutter: panelGutter, code: panelCode, body: panelBody };
let drawn: Drawn | undefined;

/** Scrolls the source panel to the first change in `range` (in the node, without one), banding a narrower range. */
function markLines(range: LineRange | undefined): void {
  if (drawn === undefined) return;
  // A mark on lines folded away opens the fold first, so it has somewhere to land.
  if (range !== undefined) revealRange(drawn, folds, range);
  markRows(sourceParts, drawn, range);
}

const whyPane = document.querySelector<HTMLElement>("#why")!;
/** The runs of the open file's source folded away behind its defining blocks. */
let folds: Fold[] = [];

/** A file under a comparison says why it matters and lists its defining blocks; their lines are open, the rest folded. */
async function showWhy(node: ModuleNode, ticket: number): Promise<FileWhy | undefined> {
  folds = [];
  whyPane.hidden = true;
  if (comparison === null || node.level !== "file") return undefined;
  const response = await fetch(`/file-why?id=${encodeURIComponent(node.id)}`);
  if (!response.ok || ticket !== requested) return undefined;
  return (await response.json()) as FileWhy;
}

function drawWhy(found: FileWhy): void {
  if (drawn === undefined) return;
  renderFileWhy(whyPane, found, {
    graph: picture.graph,
    pickBlock: (block) => markLines(block.range),
    pickNode: (id, marked) => {
      const target = nodes.get(id);
      // A block of the open file stays inside it, so its panel stays: its lines are marked.
      if (target !== undefined && isCodeNode(target) && selected === `file:${target.path}`) markLines(marked ?? target.range);
      else pickNode(id, marked);
    },
    neighbours: async (id) => {
      const answer = await fetch(`/calls?id=${encodeURIComponent(id)}`);
      return answer.ok ? ((await answer.json()) as Neighbours) : undefined;
    },
  });
  folds = collapseRows(drawn, (found.defining.length > 0 ? found.defining : found.other).map((block) => block.range));
}

function showSource(node: ModuleNode, { rows, tooLarge }: Loaded): void {
  const numbered = rows.flatMap((row) => (row.line === undefined ? [] : [row.line]));
  panelTitle.textContent = isCodeNode(node) ? `${node.level} ${node.qualifiedName}` : `file ${node.path}`;
  panelFacts.textContent = isCodeNode(node)
    ? `${node.path} · lines ${node.range.start}-${node.range.end}`
    : numbered.length === 0
      ? `${node.path} · empty`
      : `lines ${numbered[0]}-${numbered.at(-1)}`;
  const note = changeNote(rows, tooLarge);
  if (note !== undefined) {
    const small = document.createElement("span");
    small.className = "changed-note";
    small.textContent = note;
    panelFacts.append(" · ", small);
  }
  drawn = drawRows(sourceParts, rows);
  outlinePane.hidden = true;
  panel.hidden = false;
  setView({ type: "opened" });
  // The row that opened it is out of sight on a narrow screen, so focus moves to the way back.
  if (narrowScreen.matches && viewState.view === "evidence") backButton.focus();
}

const EXIT_KINDS: ReadonlySet<string> = new Set(["return", "throw", "break", "continue"]);

/** The function's outline above its source: a line selects its source lines, a function line also opens that node. */
function showOutline(node: ModuleNode, lines: readonly PseudoLine[]): void {
  // A file in the town has no outline: its pane lists the files that rest on it, and nothing may clear that.
  if (showRests(node)) {
    outlinePane.hidden = false;
    return;
  }
  const rows = lines.map((line) => {
    const row = activatable(document.createElement("div"));
    row.className = "outline-line";
    row.style.paddingLeft = `calc(10px + ${line.depth * 1.6}ch)`;
    const at = document.createElement("span");
    at.className = "at";
    at.textContent = line.range.start === line.range.end ? `L${line.range.start}` : `L${line.range.start}-${line.range.end}`;
    const text = document.createElement("span");
    text.className = EXIT_KINDS.has(line.kind) ? "exit" : line.kind === "effect" ? "effect" : line.kind === "straight" ? "quiet" : "";
    text.textContent = line.text;
    row.append(at, text);
    row.addEventListener("click", () => {
      for (const other of outlinePane.children) other.classList.toggle("on", other === row);
      markLines(line.range);
    });
    if (line.node !== undefined) {
      const open = document.createElement("button");
      open.type = "button";
      open.textContent = "open";
      const target = line.node;
      open.addEventListener("click", (event) => {
        event.stopPropagation();
        pickNode(target);
      });
      row.append(open);
    }
    return row;
  });
  outlinePane.replaceChildren(...rows);
  outlinePane.hidden = rows.length === 0;
}

let narrationTicket = 0;

/** Narration is never on by default, nor kept from one function to the next: each opens with it off. */
function offerNarration(node: ModuleNode): void {
  narrationTicket++;
  narrateBox.checked = false;
  narrationPane.hidden = true;
  const removed = comparison?.changes.some((change) => change.node.id === node.id && change.kind === "removed") === true;
  narrateToggle.hidden = !(narrating && node.level === "function" && !removed);
  narrateBox.onchange = () => {
    if (narrateBox.checked) void narrateFunction(node, false);
    else {
      narrationTicket++;
      narrationPane.hidden = true;
    }
  };
}

async function narrateFunction(node: ModuleNode, fresh: boolean): Promise<void> {
  const ticket = ++narrationTicket;
  const actions = {
    again: () => void narrateFunction(node, true),
    pick(sentence: { from: number; to: number; range: LineRange }, row: HTMLElement) {
      for (const other of narrationPane.children) other.classList.toggle("on", other === row);
      outlinePane.querySelectorAll(".outline-line").forEach((line, index) => line.classList.toggle("on", index >= sentence.from && index <= sentence.to));
      markLines(sentence.range);
    },
  };
  renderNarration(narrationPane, { state: "loading" }, actions);
  let doc: NarratedDoc;
  try {
    const response = await fetch(`/narration?id=${encodeURIComponent(node.id)}${fresh ? "&fresh=1" : ""}`, { method: "POST" });
    doc = response.ok ? ((await response.json()) as NarratedDoc) : { tier: "claimed", id: node.id, status: "failed", message: `the server answered ${response.status}` };
  } catch {
    doc = { tier: "claimed", id: node.id, status: "failed", message: "the server did not answer" };
  }
  if (ticket !== narrationTicket) return;
  renderNarration(narrationPane, doc.status === "ok" ? { state: "ok", doc } : { state: "failed", message: doc.message }, actions);
}

/** Selects `node`, showing its source and outlining `outline` on the picture. */
async function select(node: ModuleNode, ticket: number, outline: NodeId = node.id, marked?: LineRange): Promise<void> {
  endTour();
  rememberOpener();
  if (node.id === selected) {
    markLines(marked);
    // A narrow screen on the town or the list asked for what is already open.
    setView({ type: "opened" });
    return;
  }
  const loaded = await loadRows(node.id, isCodeNode(node) ? node.range.start : 1);
  if (ticket !== requested) return;
  if (loaded === undefined) return closePanel();
  const outlined = node.level === "function" ? await fetch(`/pseudocode?id=${encodeURIComponent(node.id)}`) : undefined;
  const pseudo = outlined?.ok ? ((await outlined.json()) as { lines: PseudoLine[] }).lines : [];
  if (ticket !== requested) return;
  const why = await showWhy(node, ticket);
  if (ticket !== requested) return;
  selected = node.id;
  showSource(node, loaded);
  if (why !== undefined) drawWhy(why);
  showOutline(node, pseudo);
  offerNarration(node);
  // A file opens on its first defining block when nothing else was asked for.
  markLines(marked ?? why?.defining[0]?.range);
  showFailure(node);
  chosenKind = undefined;
  townView.select(outline, reaches.get(node.id));
  // A function lights the harbour structures it reaches; a file or class lights none.
  const reach = node.level === "function" ? reaches.get(node.id) : undefined;
  if (reach !== undefined) townView.highlight([], reach.kinds);
}

/** An entry of the review panel: fly to its district, and select the file or code it names. */
function pickEntry(entry: ReviewEntry): void {
  endTour();
  if (entry.level === "district" || entry.level === "moves") showPick();
  if (entry.level === "district") {
    leaveInside();
    cancelPending();
    closePanel();
    focusOn(entry.id);
    return;
  }
  if (entry.level === "moves") {
    pickPlaces(entry.children.map((child) => child.id));
    return;
  }
  // A section has no place in the picture: it selects its file.
  pickNode(entry.level === "section" ? (`file:${entry.path}` as NodeId) : entry.id, undefined, entry.folded);
}

/** A node by id, a ghost or a module removed from a surviving file included: fly to its file, select it. */
function pickNode(id: NodeId, marked?: LineRange, also: readonly NodeId[] = []): void {
  endTour();
  cancelPending();
  const node = nodes.get(id) ?? changed.get(id);
  if (node === undefined) return;
  const place = placeNode(node);
  if (place === undefined || place.parent === null) return;
  // A node in the file that is open stays inside and selects its room; one anywhere else leaves first.
  const stay = insideFile === place.id;
  if (!stay) leaveInside();
  const ticket = requested;
  if (stay) insideView.select(node.id, also);
  else if (nodes.has(place.parent)) focusOn(place.parent, rubbleAmong([place.id]));
  // The folder a moved file left may be gone from the picture (the trail has no step for it): frame the rubble where it stands.
  else {
    // Framed alone like a double-clicked rubble block, so Esc and a background double-click zoom back out to `focus`.
    alone = true;
    townView.frame([place.id]);
  }
  void select(node, ticket, place.id, marked);
}

/** The file `node` stands in, its lot in the town included when that is the rubble a moved file left. */
function placeNode(node: ModuleNode): FileNode | undefined {
  const id = node.level === "file" ? node.id : (`file:${node.path}` as NodeId);
  const found = nodes.get(id) ?? ghostFiles.get(id);
  return found?.level === "file" ? found : undefined;
}

/** The file a linked module stands in on the picture, if it has a place. */
function placeOf(id: string): NodeId | undefined {
  const node = nodes.get(id as NodeId) ?? changed.get(id as NodeId);
  return node === undefined ? undefined : placeNode(node)?.id;
}

/** A claim of the review panel: outline the modules the agent linked to it, and fly to the district holding them all. */
function pickClaim(claim: ClaimRow): void {
  endTour();
  showPick();
  if (claim.ids.length === 0) {
    // No places: nothing stays lit from the claim before.
    leaveInside();
    cancelPending();
    closePanel();
    chosenKind = undefined;
    townView.highlight([]);
    return;
  }
  pickPlaces(claim.ids);
}

/** Outline the files of `ids` and fly to the district holding them all. */
function pickPlaces(ids: readonly string[]): void {
  endTour();
  leaveInside();
  cancelPending();
  closePanel();
  const places = [...new Set(ids.map(placeOf).filter((place): place is NodeId => place !== undefined))];
  chosenKind = undefined;
  shownPlaces = places;
  townView.highlight(places);
  const district = commonDistrict(tree, places);
  if (district !== undefined) focusOn(district, rubbleAmong(places));
}

/** What the reviewer had selected by hand before the tour: the open file or the outlined places, where the camera was, and the sidebar. */
interface Manual {
  readonly camera: CameraState;
  readonly selected: NodeId | undefined;
  readonly places: readonly NodeId[] | undefined;
  readonly focus: NodeId;
  readonly alone: boolean;
  readonly review: ReviewSnapshot | undefined;
}
let manual: SavedSelection<Manual>;

/** The reviewer picked something while the tour was open: the tour closes and that pick stands, with nothing to restore. */
function endTour(): void {
  if (manual === undefined) return;
  manual = undefined;
  setView({ type: "tour-ended", resume: false });
  walk?.end();
}

/** Clear the outline a claim, risk or stop put on the town. */
function clearOutline(): void {
  shownPlaces = undefined;
  townView.highlight([]);
}
let reviewHandle: ReviewHandle | undefined;
let risks: readonly RiskItem[] = [];

/** Put back what the reviewer had picked before the tour. */
function restoreManual(saved: Manual): void {
  if (saved.selected !== undefined) pickNode(saved.selected);
  else if (saved.places !== undefined) pickPlaces(saved.places);
  else {
    closePanel();
    clearOutline();
  }
  // pickPlaces and pickNode do not touch the sidebar, so it comes back from its own snapshot.
  if (saved.review !== undefined) reviewHandle?.restore(saved.review);
  // The camera goes back last, as it was, however the picks above sent it.
  focus = saved.focus;
  alone = saved.alone;
  showTrail();
  townView.setCameraState(saved.camera);
}

/** A stop of the walkthrough: outline its nodes' files and fly to the district holding them all. Closing the tour clears the outline. */
function visitStop(stop: Stop | undefined): void {
  if (stop === undefined) {
    const left = leaveTour(manual);
    manual = left.state;
    leaveInside();
    cancelPending();
    closePanel();
    setView({ type: "tour-ended", resume: true });
    clearOutline();
    if (left.restore !== undefined) restoreManual(left.restore.value);
    return;
  }
  manual = enterStop(manual, () => ({ camera: townView.cameraState(), selected, places: selected === undefined && townView.isDimming() ? shownPlaces : undefined, focus, alone, review: reviewHandle?.snapshot() }));
  leaveInside();
  cancelPending();
  closePanel();
  const places = [...new Set(stop.ids.map(placeOf).filter((place): place is NodeId => place !== undefined))];
  const held = stop.ids.flatMap((id) => {
    const node = nodes.get(id) ?? changed.get(id);
    return node === undefined ? [] : [{ id, path: node.path, level: node.level }];
  });
  const row = stopRow(held, risks);
  reviewHandle?.selectRisk(row === undefined ? undefined : risks[row]);
  townView.highlight(places);
  const district = commonDistrict(tree, places);
  if (district !== undefined) focusOn(district, rubbleAmong(places));
  // The town is where the stop's outline is, so a narrow screen shows it.
  setView({ type: "tour-started" });
}

let walk: Walk | undefined;

panelClose.addEventListener("click", dismiss);
resetButton.addEventListener("click", resetView);
window.addEventListener("keydown", (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  // Letters and arrows typed into the search are text, not shortcuts.
  if (isTyping(event.target as Element | null) && event.key !== "Escape") return;
  if (event.key === "/") {
    event.preventDefault();
    findBox.focus();
    findBox.select();
  } else if (event.key === "Escape") {
    cancelPending();
    if (insideFile !== undefined) leaveInside();
    else if (selected === undefined && townView.isDimming()) clearOutline();
    else if (selected !== undefined) dismiss();
    else {
      const to = escapeStep(focus, alone, townRoot, (id) => zoomOut(tree, id));
      if (to !== undefined) focusOn(to, alone ? [] : undefined);
    }
  } else if (event.key === "r" || event.key === "R") resetView();
  else if (event.key === "ArrowRight") walk?.step(1);
  else if (event.key === "ArrowLeft") walk?.step(-1);
});

if (comparison !== null && testChanges !== null) {
  await setUpReview(
    { comparison, graph: picture.graph, testChanges, observed, observedRun, nodes, changed },
    {
      pickClaim,
      pickEntry,
      pickNode,
      pickPlaces,
      showPick,
      visitStop,
      tourOpen: () => manual !== undefined,
      endTour,
      clearOutline,
      shown: () => {
        viewState = firstView(true);
      },
      risksLoaded: (loaded) => {
        risks = loaded;
      },
      reviewDrawn: (handle) => {
        reviewHandle = handle;
      },
      walkDrawn: (made) => {
        walk = made;
      },
    },
  );
}

/** Every file of the picture, the ones a move left behind included: the search reaches each, with or without a risk. */
const movedTo = new Map<string, { id: string; path: string }>((comparison?.changes ?? []).flatMap((change) => (change.kind === "moved" && change.from.level === "file" ? [[change.from.id, { id: change.node.id, path: change.node.path }] as const] : [])));
const fileHits = searchEntries([...new Map([...nodes, ...ghostFiles]).values()].filter((node): node is FileNode => node.level === "file"), (id) => picture.overlay?.entry(id as NodeId)?.kind, movedTo, picture.overlay !== null) as FileHit[];
// A result selects the file the way clicking its building does, and flies the camera to it so it is in view.
wireFind({ box: findBox, results: findResults, status: findStatus, files: fileHits, choose: (hit) => pickNode(hit.id) });

paintViews();
showTown();
void mountPicker(document.getElementById("pr-picker")!);

/** A test function that failed in the run: what the runner gave of the failure, and the line its stack named marked in the source. */
function showFailure(node: ModuleNode): void {
  const results = observed?.status === "ran" && isCodeNode(node) && node.level === "function" ? observed.tests[node.id] : undefined;
  if (drawn === undefined || results === undefined || !isCodeNode(node)) {
    failurePane.hidden = true;
    return;
  }
  const shown = drawn;
  const mark = renderFailure(failurePane, results, node.range, (line) => markFailedLine(sourceParts, shown, line));
  markFailedLine(sourceParts, shown, mark);
}
