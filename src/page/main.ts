import { isCodeNode, lineCount } from "../graph.ts";
import type { Graph, ModuleNode, NodeId } from "../graph.ts";
import { LABEL_BAND, layout, reservesLabelBand } from "../layout.ts";
import type { Rect } from "../layout.ts";
import { indexGraph, trail, zoomOut, zoomTarget } from "../zoom.ts";

interface Style {
  readonly fill: string;
  readonly edge: string;
  readonly text: string;
}

type Look = "package" | "folder" | "analysed" | "not analysed" | "generated" | "class" | "function";

const STYLES: Readonly<Record<Look, Style>> = {
  package: { fill: "#1d3b2a", edge: "#3f7a55", text: "#b9e4c6" },
  folder: { fill: "#1f2a3a", edge: "#3e5677", text: "#b8c8de" },
  analysed: { fill: "#2f6f8f", edge: "#173a4b", text: "#eaf6fc" },
  "not analysed": { fill: "#3a3a3a", edge: "#232323", text: "#a8a8a8" },
  generated: { fill: "#2c2733", edge: "#1c1921", text: "#9a92a8" },
  class: { fill: "#8a5a2b", edge: "#47301a", text: "#fbefdc" },
  function: { fill: "#6b5aa8", edge: "#352d55", text: "#f1eefb" },
};

function lookOf(node: ModuleNode): Look {
  if (node.level !== "file") return node.level;
  return node.generated ? "generated" : node.analysis;
}

function displayName(node: ModuleNode): string {
  return node.path === "" ? "/" : node.name;
}

const canvas = document.querySelector<HTMLCanvasElement>("#picture")!;
const tooltip = document.querySelector<HTMLDivElement>("#tooltip")!;
const breadcrumbs = document.querySelector<HTMLElement>("#trail")!;
const panel = document.querySelector<HTMLElement>("#source")!;
const panelTitle = document.querySelector<HTMLElement>("#source-title")!;
const panelFacts = document.querySelector<HTMLElement>("#source-facts")!;
const panelGutter = document.querySelector<HTMLElement>("#source-gutter")!;
const panelCode = document.querySelector<HTMLElement>("#source-code")!;
const panelBody = document.querySelector<HTMLElement>("#source-body")!;
const panelClose = document.querySelector<HTMLButtonElement>("#source-close")!;
const context = canvas.getContext("2d")!;

const graph = (await (await fetch("/graph.json")).json()) as Graph;
const nodes = new Map<NodeId, ModuleNode>(graph.nodes.map((node) => [node.id, node]));
const tree = indexGraph(graph);
let zoomRoot = tree.root;
let rects: Rect[] = [];
let selected: NodeId | undefined;
let requested = 0;
let pendingClick: ReturnType<typeof setTimeout> | undefined;

// Browsers don't expose the system's double-click interval; a click waits this long so that a
// double-click only zooms, and a panel opened by its first click can't take its second.
const DOUBLE_CLICK_MS = 250;

function hatch(): CanvasPattern {
  const tile = document.createElement("canvas");
  tile.width = tile.height = 6;
  const pen = tile.getContext("2d")!;
  pen.strokeStyle = "#555";
  pen.beginPath();
  pen.moveTo(0, 6);
  pen.lineTo(6, 0);
  pen.stroke();
  return context.createPattern(tile, "repeat")!;
}

function fitText(text: string, width: number): string {
  if (context.measureText(text).width <= width) return text;
  for (let length = text.length - 1; length > 0; length--) {
    const clipped = `${text.slice(0, length)}…`;
    if (context.measureText(clipped).width <= width) return clipped;
  }
  return "";
}

function label(lines: readonly string[], rect: Rect, color: string): void {
  context.fillStyle = color;
  lines.forEach((line, index) => {
    const y = rect.y + 3 + index * 12;
    if (y + 11 > rect.y + rect.h) return;
    const text = fitText(line, rect.w - 6);
    if (text !== "") context.fillText(text, rect.x + 3, y);
  });
}

function zoomTo(id: NodeId): void {
  if (id === zoomRoot) return;
  zoomRoot = id;
  tooltip.style.display = "none";
  draw();
}

function showTrail(): void {
  const steps = trail(tree, zoomRoot).map((node, index, all) => {
    const name = displayName(node);
    if (index === all.length - 1) {
      const here = document.createElement("span");
      here.textContent = name;
      return here;
    }
    const step = document.createElement("button");
    step.textContent = name;
    step.addEventListener("click", () => zoomTo(node.id));
    return step;
  });
  breadcrumbs.replaceChildren(
    ...steps.flatMap((step, index) => {
      if (index === 0) return [step];
      const arrow = document.createElement("i");
      arrow.textContent = "\u203A";
      return [arrow, step];
    }),
  );
}

function closePanel(): void {
  clearTimeout(pendingClick);
  requested++;
  selected = undefined;
  panel.hidden = true;
  draw();
}

function showSource(node: ModuleNode, text: string): void {
  const first = isCodeNode(node) ? node.range.start : 1;
  const lines = text.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  const last = first + lines.length - 1;
  panelTitle.textContent = isCodeNode(node) ? `${node.level} ${node.qualifiedName}` : `file ${node.path}`;
  panelFacts.textContent = isCodeNode(node)
    ? `${node.path} \u00B7 lines ${node.range.start}-${node.range.end}`
    : text === ""
      ? `${node.path} \u00B7 empty`
      : `lines ${first}-${last}`;
  panelGutter.textContent = lines.map((_, index) => first + index).join("\n");
  panelCode.textContent = text;
  panelBody.scrollTop = panelBody.scrollLeft = 0;
  panel.hidden = false;
}

async function select(node: ModuleNode): Promise<void> {
  const ticket = ++requested;
  if (node.id === selected) return;
  const response = await fetch(`/source?id=${encodeURIComponent(node.id)}`);
  if (ticket !== requested) return;
  if (!response.ok) return closePanel();
  const text = await response.text();
  if (ticket !== requested) return;
  selected = node.id;
  showSource(node, text);
  draw();
}

function draw(): void {
  showTrail();
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const scale = window.devicePixelRatio;
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.font = "11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  context.textBaseline = "top";
  const pattern = hatch();

  rects = layout(graph, zoomRoot, width, height);
  if (selected !== undefined && !rects.some((rect) => rect.id === selected)) {
    selected = undefined;
    panel.hidden = true;
  }
  const hasPlacedChildren = new Set(rects.map((rect) => nodes.get(rect.id)!.parent));
  for (const rect of rects) {
    const node = nodes.get(rect.id)!;
    const look = lookOf(node);
    const style = STYLES[look];
    const x = Math.round(rect.x);
    const y = Math.round(rect.y);
    const w = Math.round(rect.x + rect.w) - x;
    const h = Math.round(rect.y + rect.h) - y;
    context.fillStyle = style.fill;
    context.fillRect(x, y, w, h);
    if (look === "not analysed") {
      context.fillStyle = pattern;
      context.fillRect(x, y, w, h);
    }
    context.strokeStyle = style.edge;
    context.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

    if (node.level === "package" || node.level === "folder") {
      if (reservesLabelBand(rect)) label([displayName(node)], { ...rect, h: LABEL_BAND }, style.text);
    } else if (hasPlacedChildren.has(node.id)) {
      label([displayName(node)], { ...rect, h: LABEL_BAND }, style.text);
    } else if (node.level === "file") {
      label(look === "analysed" ? [node.name] : [node.name, look], rect, style.text);
    } else {
      label([displayName(node)], rect, style.text);
    }
  }

  const outlined = rects.find((rect) => rect.id === selected);
  if (outlined !== undefined) {
    context.lineWidth = 2;
    context.strokeStyle = "#ffd84a";
    const x = Math.round(outlined.x);
    const y = Math.round(outlined.y);
    const w = Math.round(outlined.x + outlined.w) - x;
    const h = Math.round(outlined.y + outlined.h) - y;
    context.strokeRect(x + 1, y + 1, w - 2, h - 2);
    context.lineWidth = 1;
  }
}

function rectAt(event: MouseEvent): Rect | undefined {
  const bounds = canvas.getBoundingClientRect();
  const x = event.clientX - bounds.left;
  const y = event.clientY - bounds.top;
  return rects.findLast((rect) => x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h);
}

canvas.addEventListener("mousemove", (event) => {
  const hit = rectAt(event);
  const node = hit && nodes.get(hit.id);
  if (node === undefined) {
    tooltip.style.display = "none";
    return;
  }
  const facts = isCodeNode(node)
    ? [`${node.level} ${node.name}`, node.path, `${lineCount(node)} lines`, `lines ${node.range.start}-${node.range.end}`]
    : [`${node.level} ${node.path === "" ? "/" : node.path}`, `${lineCount(node)} lines`];
  if (node.level === "file") facts.push(node.generated ? "generated" : node.analysis);
  tooltip.textContent = facts.join("\n");
  tooltip.style.display = "block";
  tooltip.style.left = `${Math.min(event.clientX + 12, window.innerWidth - tooltip.offsetWidth - 4)}px`;
  tooltip.style.top = `${Math.min(event.clientY + 12, window.innerHeight - tooltip.offsetHeight - 4)}px`;
});
canvas.addEventListener("mouseleave", () => {
  tooltip.style.display = "none";
});
canvas.addEventListener("click", (event) => {
  if (event.detail > 1) return;
  const hit = rectAt(event);
  const node = hit && nodes.get(hit.id);
  clearTimeout(pendingClick);
  pendingClick = setTimeout(() => {
    if (node === undefined || node.level === "package" || node.level === "folder") closePanel();
    else void select(node);
  }, DOUBLE_CLICK_MS);
});
panelClose.addEventListener("click", closePanel);
canvas.addEventListener("dblclick", (event) => {
  clearTimeout(pendingClick);
  const hit = rectAt(event);
  const target = hit && zoomTarget(tree, zoomRoot, hit.id);
  if (target !== undefined) zoomTo(target);
});
window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (selected !== undefined) closePanel();
  else zoomTo(zoomOut(tree, zoomRoot));
});
window.addEventListener("resize", draw);
draw();
