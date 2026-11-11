import { cityOf, reachMap, reachOf } from "../city.ts";
import type { Building, City } from "../city.ts";
import { pictureOf, tallyText } from "../compare.ts";
import type { Comparison, ContractMove } from "../compare.ts";
import { flyTarget } from "../focus.ts";
import { isCodeNode } from "../graph.ts";
import type { FileNode, Graph, LineRange, ModuleNode, NodeId, ResourceKind } from "../graph.ts";
import { commonDistrict, indexGraph, trail, zoomOut } from "../zoom.ts";
import { contractsReport, effectsChangedRows, newEffects, unmentioned, unmentionedIds } from "../review.ts";
import type { EffectRow, ReviewEntry } from "../review.ts";
import type { PseudoLine } from "../pseudo-line.ts";
import { createCityView } from "./city-view.ts";
import type { CityHandlers, CityView } from "./city-view.ts";
import { createTownView, loadSheet } from "./town-view.ts";
import { townOf } from "../town.ts";
import type { Town } from "../town.ts";
import { EFFECT_COLOR, FAIL_COLOR, LEGEND_ROLES, roleColor } from "./palette.ts";
import type { ObservedDocument } from "../observed-types.ts";
import { observedReport } from "../observed-report.ts";
import { changeNote, drawRows, loadRows, markRows } from "./code-rows.ts";
import type { CodeParts, Drawn, Loaded } from "./code-rows.ts";
import type { TestChanges } from "../test-changes-types.ts";
import { renderReview } from "./review-panel.ts";
import type { ClaimRow, LinkNote } from "./review-panel.ts";
import { renderWalkthrough } from "./walkthrough-panel.ts";
import type { Walk } from "./walkthrough-panel.ts";
import { observedAt, stopFacts, tourCoverage } from "../stops.ts";
import type { WalkNote } from "../stops.ts";
import type { Stop } from "../tour.ts";
import type { NarratedDoc } from "../narration.ts";
import { renderNarration } from "./narration-panel.ts";

const tooltip = document.querySelector<HTMLDivElement>("#tooltip")!;
const breadcrumbs = document.querySelector<HTMLElement>("#trail")!;
const legend = document.querySelector<HTMLElement>("#legend")!;
const stage = document.querySelector<HTMLElement>("#stage")!;
const resetButton = document.querySelector<HTMLButtonElement>("#reset")!;
const pixelButton = document.querySelector<HTMLButtonElement>("#pixel")!;
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
const panelMark = document.querySelector<HTMLElement>("#source-mark")!;
const panelClose = document.querySelector<HTMLButtonElement>("#source-close")!;

const graph = (await (await fetch("/graph.json")).json()) as Graph;
const comparisonResponse = await fetch("/comparison.json");
const comparison = comparisonResponse.ok
  ? ((await comparisonResponse.json()) as Comparison & { against: { ref: string; commit: string } })
  : null;
/** Narration is on offer only when the server was started with --narrate. */
const narrating = (await fetch("/narrate.json")).ok;
const picture = pictureOf(graph, comparison);
const observedResponse = await fetch("/observed.json");
const observed = observedResponse.ok ? ((await observedResponse.json()) as ObservedDocument) : null;
const observedRun = observed?.status === "ran" && comparison !== null ? observedReport(observed, picture.graph, comparison) : null;
// Ghosts are in the picture's graph, so the trail, flying and the source panel reach them too.
const nodes = new Map<NodeId, ModuleNode>(picture.graph.nodes.map((node) => [node.id, node]));
// A module removed from a file that stays has no place in the picture, but its base source is served.
const changed = new Map<NodeId, ModuleNode>((comparison?.changes ?? []).map((change) => [change.node.id, change.node]));
const tree = indexGraph(picture.graph);
let cityRoot = tree.root;
/** The district the camera frames and the names count down from; the layout never follows it. */
let focus = cityRoot;
let buildings = new Map<NodeId, Building>();
let selected: NodeId | undefined;
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

/** The town is a second picture beside the city: `?view=town` draws it, and the page's switch moves between them. */
const townMode = new URLSearchParams(location.search).get("view") === "town";
const sheet = townMode ? await loadSheet() : undefined;

const handlers: CityHandlers = {
  hover(id, at) {
    const facts = id === undefined ? undefined : describe(id);
    if (facts === undefined) {
      tooltip.style.display = "none";
      return;
    }
    tooltip.textContent = facts.join("\n");
    tooltip.style.display = "block";
    tooltip.style.left = `${Math.min(at.x + 16, window.innerWidth - tooltip.offsetWidth - 4)}px`;
    tooltip.style.top = `${Math.min(at.y + 16, window.innerHeight - tooltip.offsetHeight - 4)}px`;
  },
  click(id, clicks) {
    if (clicks > 1) return;
    cancelPending();
    const ticket = requested;
    pendingClick = setTimeout(() => {
      const node = id === undefined ? undefined : nodes.get(id);
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
    // A building is reserved for entering it; until then a double-click on one only cancels the
    // first click's selection.
    cancelPending();
    if (hit?.kind === "building" || hit?.kind === "resource") return;
    const to = hit === undefined ? zoomOut(tree, focus) : flyTarget(focus, hit.id);
    if (to !== undefined) focusOn(to);
  },
};
const townView = sheet === undefined ? undefined : createTownView(stage, handlers, sheet);
const cityView = townView === undefined ? createCityView(stage, handlers, observedRun?.failingFiles) : undefined;
const view: Omit<CityView, "show"> = townView ?? cityView!;

let chosenKind: ResourceKind | undefined;
const reaches = reachMap(picture);

/** Outlines every building that reaches `kind`, only the ones with a new edge to it under a comparison. */
function chooseResource(kind: ResourceKind | undefined): void {
  chosenKind = kind;
  const reaching = [...buildings.values()].filter((building) =>
    kind === undefined ? false : (comparison === null ? building.reach.kinds : building.reach.fresh).includes(kind),
  );
  view.highlight(reaching.map((building) => building.id), kind);
}

function describe(id: NodeId): string[] | undefined {
  const file = nodes.get(id);
  const building = buildings.get(id);
  if (file?.level !== "file" || building === undefined) return undefined;
  return [
    file.path,
    ...changeFacts(file, building),
    `role: ${file.role ?? "none"}`,
    `lines: ${file.lines}`,
    file.analysis === "analysed"
      ? `functions: ${building.functions}   classes: ${building.classes}`
      : "not analysed",
  ];
}

function changeFacts(file: FileNode, building: Building): string[] {
  const entry = picture.overlay?.entry(file.id);
  if (entry === undefined) return picture.overlay === null ? [] : ["change: unchanged"];
  const facts = [`change: ${entry.kind}`];
  if (entry.kind === "moved") facts.push(`moved from ${entry.from.path}`);
  if (entry.kind === "removed") facts.push(`removed (was ${file.lines} lines)`);
  const code = building.tally === null ? "" : tallyText(building.tally);
  if (code !== "") facts.push(`functions ${code}`);
  return facts;
}

function showLegend(city: City): void {
  const counts = city.counts;
  const roles = document.createElement("div");
  for (const role of LEGEND_ROLES) {
    const entry = document.createElement("span");
    const swatch = document.createElement("i");
    swatch.style.background = roleColor(role === "none" ? null : role);
    entry.append(swatch, role);
    roles.append(entry);
  }
  const scale = document.createElement("div");
  scale.textContent = `height: classes and functions per file, square-root scale (${counts.fewest} to ${counts.most})`;
  const effects = document.createElement("div");
  const swatch = document.createElement("i");
  swatch.style.background = EFFECT_COLOR;
  const words = document.createElement("span");
  words.textContent =
    comparison === null
      ? "plate at the edge: an outside resource \u00b7 line from the building you point at: it reaches it"
      : "plate at the edge: an outside resource \u00b7 pink post on a roof and bright pink line: a new call to it \u00b7 dim line: an old one";
  effects.append(swatch, words);
  effects.style.flexWrap = "nowrap";
  effects.style.alignItems = "flex-start";
  swatch.style.flex = "none";
  swatch.style.marginTop = "3px";
  const parts = [roles, scale, ...(city.resources.length > 0 ? [effects] : [])];
  if (observed !== null) {
    const tests = document.createElement("div");
    const flag = document.createElement("i");
    flag.style.background = FAIL_COLOR;
    const said = document.createElement("span");
    said.textContent =
      observed.status === "ran"
        ? "orange flag: a test in the file failed when main's tests ran against this change (observed, one run; evidence against mistakes, not against a hostile author)"
        : observed.status === "failed"
          ? `tests: the run failed (${observed.why})`
          : observed.status === "unreliable"
            ? `tests: results unreliable, none shown (${observed.why})`
          : `tests not run: ${observed.why}`;
    tests.append(flag, said);
    parts.push(tests);
  }
  if (comparison !== null) {
    const against = document.createElement("div");
    against.textContent = `against ${comparison.against.ref} at ${comparison.against.commit.slice(0, 7)}: dim unchanged \u00b7 bright floors of an altered file: its changed functions \u00b7 white roof added \u00b7 grey roof moved \u00b7 ghost removed`;
    parts.push(against);
  }
  legend.replaceChildren(...parts);
}

/** What the town's sprites stand for. Nothing is listed that the picture does not draw. */
function showTownLegend(town: Town): void {
  const kinds = document.createElement("div");
  kinds.textContent = "building: workshop source \u00b7 lab tests \u00b7 library docs \u00b7 shed config and build \u00b7 warehouse generated \u00b7 hut no role";
  const size = document.createElement("div");
  size.textContent = `size: classes and functions per file, square-root scale (${town.counts.fewest} to ${town.counts.most}); every file has a lot of the same size`;
  const harbour = document.createElement("div");
  harbour.textContent =
    town.piers.length === 0 && town.unpictured.length === 0
      ? "harbour: no outside resource is reached"
      : `harbour: ${town.piers.map((pier) => pier.kind).join(", ")}${town.unpictured.length > 0 ? ` (no sprite yet for ${town.unpictured.join(", ")})` : ""}`;
  const against = document.createElement("div");
  if (comparison !== null) {
    against.textContent = `against ${comparison.against.ref} at ${comparison.against.commit.slice(0, 7)}: scaffolding and crane, named: altered \u00b7 bare earth: added \u00b7 rubble: removed \u00b7 rubble with a sign: moved to the path on it \u00b7 fence and sign: a block mostly new`;
  }
  legend.replaceChildren(kinds, size, harbour, ...(comparison === null ? [] : [against]));
}

function showCity(root: NodeId): void {
  cancelPending();
  cityRoot = root;
  focus = root;
  selected = undefined;
  chosenKind = undefined;
  panel.hidden = true;
  tooltip.style.display = "none";
  const city = cityOf(picture, root);
  buildings = new Map(city.buildings.map((building) => [building.id, building]));
  if (townView !== undefined && sheet !== undefined) {
    const town = townOf(picture.graph, new Set(Object.keys(sheet.sizes)), comparison);
    townView.show(town);
    showTownLegend(town);
  } else {
    cityView?.show(city);
    showLegend(city);
  }
  showTrail();
}

/** Flies to a district inside the city; the city itself stays as it is. */
function focusOn(id: NodeId): void {
  if (id === focus) return;
  focus = id;
  showTrail();
  view.flyTo(id);
}

function resetView(): void {
  cancelPending();
  focus = cityRoot;
  showTrail();
  view.reset();
}

function showTrail(): void {
  const steps = trail(tree, focus).map((node, index, all) => {
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
  chosenKind = undefined;
  panel.hidden = true;
  view.select(undefined);
}

const sourceParts: CodeParts = { gutter: panelGutter, code: panelCode, body: panelBody, mark: panelMark };
let drawn: Drawn | undefined;

/** Scrolls the source panel to the first change in `range` (in the node, without one), banding a narrower range. */
function markLines(range: LineRange | undefined): void {
  if (drawn !== undefined) markRows(sourceParts, drawn, range);
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
}

const EXIT_KINDS: ReadonlySet<string> = new Set(["return", "throw", "break", "continue"]);

/** The function's outline above its source: a line selects its source lines, a function line also opens that node. */
function showOutline(node: ModuleNode, lines: readonly PseudoLine[]): void {
  const rows = lines.map((line) => {
    const row = document.createElement("div");
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
  if (node.id === selected) {
    markLines(marked);
    return;
  }
  const loaded = await loadRows(node.id, isCodeNode(node) ? node.range.start : 1);
  if (ticket !== requested) return;
  if (loaded === undefined) return closePanel();
  const outlined = node.level === "function" ? await fetch(`/pseudocode?id=${encodeURIComponent(node.id)}`) : undefined;
  const pseudo = outlined?.ok ? ((await outlined.json()) as { lines: PseudoLine[] }).lines : [];
  if (ticket !== requested) return;
  selected = node.id;
  showSource(node, loaded);
  showOutline(node, pseudo);
  offerNarration(node);
  markLines(marked);
  chosenKind = undefined;
  view.select(outline, isCodeNode(node) ? reachOf(reaches, node.id) : undefined);
}

/** An entry of the review panel: fly to its district, and select the file or code it names. */
function pickEntry(entry: ReviewEntry): void {
  if (entry.level === "district") {
    cancelPending();
    closePanel();
    focusOn(entry.id);
    return;
  }
  pickNode(entry.id);
}

/** A node by id, a ghost or a module removed from a surviving file included: fly to its file, select it. */
function pickNode(id: NodeId, marked?: LineRange): void {
  cancelPending();
  const ticket = requested;
  const node = nodes.get(id) ?? changed.get(id);
  if (node === undefined) return;
  const place = nodes.get(node.level === "file" ? node.id : (`file:${node.path}` as NodeId));
  if (place === undefined || place.parent === null) return;
  focusOn(place.parent);
  void select(node, ticket, place.id, marked);
}

/** The file a linked module stands in on the picture, if it has a place. */
function placeOf(id: string): NodeId | undefined {
  const node = nodes.get(id as NodeId) ?? changed.get(id as NodeId);
  if (node === undefined) return undefined;
  const place = node.level === "file" ? node.id : (`file:${node.path}` as NodeId);
  return nodes.has(place) ? place : undefined;
}

/** A claim of the review panel: outline the modules the agent linked to it, and fly to the district holding them all. */
function pickClaim(claim: ClaimRow): void {
  cancelPending();
  closePanel();
  const places = [...new Set(claim.ids.map(placeOf).filter((place): place is NodeId => place !== undefined))];
  chosenKind = undefined;
  view.highlight(places);
  const district = commonDistrict(tree, places);
  if (district !== undefined) focusOn(district);
}

/** A stop of the walkthrough: outline its nodes' files and fly to the district holding them all. Closing the tour clears the outline. */
function visitStop(stop: Stop | undefined): void {
  cancelPending();
  closePanel();
  const places = [...new Set((stop?.ids ?? []).map(placeOf).filter((place): place is NodeId => place !== undefined))];
  view.highlight(places);
  const district = commonDistrict(tree, places);
  if (district !== undefined) focusOn(district);
}

let walk: Walk | undefined;

function cyclePixel(): void {
  const divisor = view.cyclePixel();
  pixelButton.textContent = `Pixel: ${divisor === 1 ? "off" : `1/${divisor}`} (P)`;
}

panelClose.addEventListener("click", closePanel);
resetButton.addEventListener("click", resetView);
pixelButton.addEventListener("click", cyclePixel);
pixelButton.hidden = townMode;
const switchButton = document.querySelector<HTMLButtonElement>("#view-switch")!;
switchButton.textContent = townMode ? "City view" : "Town view";
switchButton.addEventListener("click", () => {
  const next = new URL(location.href);
  if (townMode) next.searchParams.delete("view");
  else next.searchParams.set("view", "town");
  location.href = next.href;
});
window.addEventListener("keydown", (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === "Escape") {
    cancelPending();
    if (selected !== undefined) closePanel();
    else if (focus !== cityRoot) focusOn(zoomOut(tree, focus));
  } else if (event.key === "r" || event.key === "R") resetView();
  else if (event.key === "p" || event.key === "P") cyclePixel();
  else if (event.key === "ArrowRight") walk?.step(1);
  else if (event.key === "ArrowLeft") walk?.step(-1);
});

if (comparison !== null) {
  const claims = (await (await fetch("/claims.json")).json()) as { description: string | null; claims: ClaimRow[]; sentences: { index: number; text: string }[]; context: { text: string }[]; link: LinkNote };
  const linked = new Set(claims.claims.flatMap((claim) => claim.ids as NodeId[]));
  const { moves } = (await (await fetch("/contracts.json")).json()) as { moves: ContractMove[] };
  const testChanges = (await (await fetch("/test-changes.json")).json()) as TestChanges;
  const review = document.querySelector<HTMLElement>("#review")!;
  review.hidden = false;
  const claimed = claims.description === null ? null : unmentioned(comparison, picture.graph, claims.description, linked);
  const effects = newEffects(comparison, picture.graph, claims.description ?? "", linked);
  renderReview(review, {
    description: claims.description,
    claims: claims.claims,
    context: claims.context,
    link: claims.link,
    pickClaim,
    unmentioned: claimed,
    contracts: contractsReport(comparison, moves, claimed === null ? new Set() : unmentionedIds(claimed), picture.graph, effectsChangedRows(comparison, picture.graph, claims.description ?? "", linked)),
    effects,
    pick: pickEntry,
    pickEffect: (row: EffectRow) => pickNode(row.id, row.range),
    pickNode,
    observed: observed === null ? null : { document: observed, report: observedRun },
    testChanges,
  });

  const tour = (await (await fetch("/walkthrough.json")).json()) as { walkthrough: WalkNote; stops: Stop[] };
  const host = document.querySelector<HTMLElement>("#walk")!;
  host.hidden = false;
  walk = renderWalkthrough(host, {
    note: tour.walkthrough,
    stops: tour.stops,
    coverage: tourCoverage(tour.stops, comparison),
    claims: claims.sentences,
    facts: (stop) => stopFacts(stop, comparison, picture.graph, moves),
    observed: (stop) => observedAt(stop, picture.graph, comparison, observed, testChanges),
    describe(id) {
      const node = nodes.get(id) ?? changed.get(id);
      if (node === undefined) return { label: id };
      return isCodeNode(node) ? { label: `${node.qualifiedName} in ${node.path}` } : { label: node.path };
    },
    rows(id) {
      const node = nodes.get(id) ?? changed.get(id);
      return loadRows(id, node !== undefined && isCodeNode(node) ? node.range.start : 1);
    },
    visit: visitStop,
  });
}
showCity(cityRoot);
