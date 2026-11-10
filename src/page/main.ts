import { cityOf } from "../city.ts";
import type { Building, City } from "../city.ts";
import { flyTarget } from "../focus.ts";
import { isCodeNode } from "../graph.ts";
import type { Graph, ModuleNode, NodeId } from "../graph.ts";
import { indexGraph, trail, zoomOut } from "../zoom.ts";
import { createCityView } from "./city-view.ts";
import { LEGEND_ROLES, roleColor } from "./palette.ts";

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
const panelClose = document.querySelector<HTMLButtonElement>("#source-close")!;

const graph = (await (await fetch("/graph.json")).json()) as Graph;
const nodes = new Map<NodeId, ModuleNode>(graph.nodes.map((node) => [node.id, node]));
const tree = indexGraph(graph);
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

const view = createCityView(stage, {
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
  doubleClick(hit) {
    // A building is reserved for entering it; until then a double-click on one only cancels the
    // first click's selection.
    cancelPending();
    if (hit?.kind === "building") return;
    const to = hit === undefined ? zoomOut(tree, focus) : flyTarget(focus, hit.id);
    if (to !== undefined) focusOn(to);
  },
});

function describe(id: NodeId): string[] | undefined {
  const file = nodes.get(id);
  const building = buildings.get(id);
  if (file?.level !== "file" || building === undefined) return undefined;
  return [
    file.path,
    `role: ${file.role ?? "none"}`,
    `lines: ${file.lines}`,
    file.analysis === "analysed"
      ? `functions: ${building.functions}   classes: ${building.classes}`
      : "not analysed",
  ];
}

function showLegend(counts: City["counts"]): void {
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
  legend.replaceChildren(roles, scale);
}

function showCity(root: NodeId): void {
  cancelPending();
  cityRoot = root;
  focus = root;
  selected = undefined;
  panel.hidden = true;
  tooltip.style.display = "none";
  const city = cityOf(graph, root);
  buildings = new Map(city.buildings.map((building) => [building.id, building]));
  view.show(city);
  showLegend(city.counts);
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
  selected = undefined;
  panel.hidden = true;
  view.select(undefined);
}

function showSource(node: ModuleNode, text: string): void {
  const first = isCodeNode(node) ? node.range.start : 1;
  const lines = text.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  const last = first + lines.length - 1;
  panelTitle.textContent = isCodeNode(node) ? `${node.level} ${node.qualifiedName}` : `file ${node.path}`;
  panelFacts.textContent = isCodeNode(node)
    ? `${node.path} · lines ${node.range.start}-${node.range.end}`
    : text === ""
      ? `${node.path} · empty`
      : `lines ${first}-${last}`;
  panelGutter.textContent = lines.map((_, index) => first + index).join("\n");
  panelCode.textContent = text;
  panelBody.scrollTop = panelBody.scrollLeft = 0;
  panel.hidden = false;
}

async function select(node: ModuleNode, ticket: number): Promise<void> {
  if (node.id === selected) return;
  const response = await fetch(`/source?id=${encodeURIComponent(node.id)}`);
  if (ticket !== requested) return;
  if (!response.ok) return closePanel();
  const text = await response.text();
  if (ticket !== requested) return;
  selected = node.id;
  showSource(node, text);
  view.select(node.id);
}

function cyclePixel(): void {
  const divisor = view.cyclePixel();
  pixelButton.textContent = `Pixel: ${divisor === 1 ? "off" : `1/${divisor}`} (P)`;
}

panelClose.addEventListener("click", closePanel);
resetButton.addEventListener("click", resetView);
pixelButton.addEventListener("click", cyclePixel);
window.addEventListener("keydown", (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === "Escape") {
    cancelPending();
    if (selected !== undefined) closePanel();
    else if (focus !== cityRoot) focusOn(zoomOut(tree, focus));
  } else if (event.key === "r" || event.key === "R") resetView();
  else if (event.key === "p" || event.key === "P") cyclePixel();
});

showCity(cityRoot);
