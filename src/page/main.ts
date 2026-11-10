import { isCodeNode, lineCount } from "../graph.ts";
import type { Graph, ModuleNode, NodeId, Role } from "../graph.ts";
import { LABEL_BAND, layout, leafWeight, reservesLabelBand } from "../layout.ts";
import type { Rect } from "../layout.ts";
import { indexGraph, trail, zoomOut, zoomTarget } from "../zoom.ts";

interface Style {
  readonly fill: string;
  readonly edge: string;
  readonly text: string;
}

const BACKGROUND = "#10141a";

// Okabe-Ito, so the picture stays readable with any colour vision. Colour means one thing here,
// a file's role; levels are told apart by frames and a slight depth shade.
const ROLE_COLORS: Readonly<Record<Role | "none", string>> = {
  source: "#56B4E9",
  tests: "#009E73",
  docs: "#F0E442",
  config: "#0072B2",
  generated: "#D55E00",
  none: "#c9ced6",
};

const ROLE_NAMES: readonly (Role | "none")[] = ["source", "tests", "docs", "config", "generated", "none"];

// How far the role colour is mixed toward the background at each depth.
const DEPTH_SHADE: Readonly<Record<"file" | "class" | "function", number>> = {
  file: 0.25,
  class: 0.4,
  function: 0.52,
};

const PACKAGE_FILL = "#1d2a24";
const FOLDER_FILL = "#1a222e";

function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)) as [number, number, number];
}

function mix(hex: string, toward: string, amount: number): string {
  const from = rgb(hex);
  const to = rgb(toward);
  return `rgb(${from.map((channel, at) => Math.round(channel + (to[at]! - channel) * amount)).join(",")})`;
}

function luminance(color: string): number {
  const [r, g, b] = (color.startsWith("#") ? rgb(color) : color.slice(4, -1).split(",").map(Number)).map((channel) => {
    const unit = (channel ?? 0) / 255;
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function inkOn(fill: string): string {
  return luminance(fill) > 0.18 ? "#10141a" : "#f4f7fa";
}

function roleKey(role: Role | null): Role | "none" {
  return role ?? "none";
}

function roleStyle(role: Role | null, level: "file" | "class" | "function"): Style {
  const color = ROLE_COLORS[roleKey(role)];
  const fill = mix(color, BACKGROUND, DEPTH_SHADE[level]);
  return { fill, edge: mix(color, BACKGROUND, 0.7), text: inkOn(fill) };
}

function containerStyle(node: ModuleNode, dominant: Role | "none"): Style {
  const fill = node.level === "package" ? PACKAGE_FILL : FOLDER_FILL;
  return { fill, edge: mix(ROLE_COLORS[dominant], BACKGROUND, 0.25), text: "#b8c8de" };
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
const roleByPath = new Map<string, Role | null>();
const dominantRole = new Map<NodeId, Role | "none">();
tallyRoles();
let zoomRoot = tree.root;
let rects: Rect[] = [];
let selected: NodeId | undefined;
let requested = 0;
let pendingClick: ReturnType<typeof setTimeout> | undefined;

// Browsers don't expose the system's double-click interval; a click waits this long so that a
// double-click only zooms, and a panel opened by its first click can't take its second.
const DOUBLE_CLICK_MS = 250;

// Every user action starts here, so the latest one wins: a click still waiting out its
// double-click window, and any source request in flight, are dropped.
function cancelPending(): void {
  clearTimeout(pendingClick);
  requested++;
}

// The role covering the most area under each package and folder, which tints its frame. A
// generated file counts at its capped weight, as the layout draws it.
function tallyRoles(): void {
  const totals = new Map<NodeId, Map<Role | "none", number>>();
  for (const node of graph.nodes) {
    if (node.level !== "file") continue;
    roleByPath.set(node.path, node.role);
    const weight = leafWeight(node);
    for (let id: NodeId | null = node.parent; id !== null; id = nodes.get(id)!.parent) {
      const byRole = totals.get(id) ?? new Map<Role | "none", number>();
      byRole.set(roleKey(node.role), (byRole.get(roleKey(node.role)) ?? 0) + weight);
      totals.set(id, byRole);
    }
  }
  for (const [id, byRole] of totals) {
    let best: Role | "none" = "none";
    let bestLines = 0;
    for (const role of ROLE_NAMES) {
      const lines = byRole.get(role) ?? 0;
      if (lines > bestLines) [best, bestLines] = [role, lines];
    }
    dominantRole.set(id, best);
  }
}

function hatch(stroke: string): CanvasPattern {
  const tile = document.createElement("canvas");
  tile.width = tile.height = 6;
  const pen = tile.getContext("2d")!;
  pen.strokeStyle = stroke;
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
    step.addEventListener("click", () => {
      cancelPending();
      zoomTo(node.id);
    });
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
  cancelPending();
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

async function select(node: ModuleNode, ticket: number): Promise<void> {
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
  const hatches = { dark: hatch("rgba(0,0,0,0.22)"), light: hatch("rgba(255,255,255,0.2)") };

  rects = layout(graph, zoomRoot, width, height);
  if (selected !== undefined && !rects.some((rect) => rect.id === selected)) {
    selected = undefined;
    panel.hidden = true;
  }
  const hasPlacedChildren = new Set(rects.map((rect) => nodes.get(rect.id)!.parent));
  for (const rect of rects) {
    const node = nodes.get(rect.id)!;
    const role = isCodeNode(node) ? (roleByPath.get(node.path) ?? null) : node.level === "file" ? node.role : null;
    const style =
      node.level === "package" || node.level === "folder"
        ? containerStyle(node, dominantRole.get(node.id) ?? "none")
        : roleStyle(role, node.level);
    const x = Math.round(rect.x);
    const y = Math.round(rect.y);
    const w = Math.round(rect.x + rect.w) - x;
    const h = Math.round(rect.y + rect.h) - y;
    context.fillStyle = style.fill;
    context.fillRect(x, y, w, h);
    const notAnalysed = node.level === "file" && node.analysis === "not analysed";
    if (notAnalysed) {
      context.fillStyle = style.text === "#10141a" ? hatches.dark : hatches.light;
      context.fillRect(x, y, w, h);
    }
    context.strokeStyle = style.edge;
    if (node.level === "package" || node.level === "folder") {
      context.lineWidth = 2;
      context.strokeRect(x + 1, y + 1, w - 2, h - 2);
      context.lineWidth = 1;
    } else {
      context.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    }

    if (node.level === "package" || node.level === "folder") {
      if (reservesLabelBand(rect)) label([displayName(node)], { ...rect, h: LABEL_BAND }, style.text);
    } else if (hasPlacedChildren.has(node.id)) {
      label([displayName(node)], { ...rect, h: LABEL_BAND }, style.text);
    } else if (node.level === "file") {
      label(notAnalysed ? [node.name, "not analysed"] : [node.name], rect, style.text);
    } else {
      label([displayName(node)], rect, style.text);
    }
  }

  const outlined = rects.find((rect) => rect.id === selected);
  if (outlined !== undefined) {
    context.lineWidth = 2;
    context.strokeStyle = "#ffffff";
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
  if (node.level === "file") facts.push(node.analysis);
  if (isCodeNode(node) || node.level === "file") {
    const role = isCodeNode(node) ? roleByPath.get(node.path) : node.role;
    facts.push(`role: ${role ?? "none"}`);
  }
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
  cancelPending();
  const ticket = requested;
  pendingClick = setTimeout(() => {
    if (node === undefined || node.level === "package" || node.level === "folder") closePanel();
    else void select(node, ticket);
  }, DOUBLE_CLICK_MS);
});
panelClose.addEventListener("click", closePanel);
canvas.addEventListener("dblclick", (event) => {
  cancelPending();
  const hit = rectAt(event);
  const target = hit && zoomTarget(tree, zoomRoot, hit.id);
  if (target !== undefined) zoomTo(target);
});
window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  cancelPending();
  if (selected !== undefined) closePanel();
  else zoomTo(zoomOut(tree, zoomRoot));
});
const legend = document.querySelector<HTMLElement>("#legend")!;
legend.replaceChildren(
  ...ROLE_NAMES.map((role) => {
    const entry = document.createElement("span");
    const swatch = document.createElement("i");
    swatch.style.background = ROLE_COLORS[role];
    entry.append(swatch, role);
    return entry;
  }),
);
window.addEventListener("resize", draw);
draw();
