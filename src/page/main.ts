import type { Graph, ModuleNode, NodeId } from "../graph.ts";
import { LABEL_BAND, layout, reservesLabelBand } from "../layout.ts";
import type { Rect } from "../layout.ts";

interface Style {
  readonly fill: string;
  readonly edge: string;
  readonly text: string;
}

type Look = "package" | "folder" | "analysed" | "not analysed";

const STYLES: Readonly<Record<Look, Style>> = {
  package: { fill: "#1d3b2a", edge: "#3f7a55", text: "#b9e4c6" },
  folder: { fill: "#1f2a3a", edge: "#3e5677", text: "#b8c8de" },
  analysed: { fill: "#2f6f8f", edge: "#173a4b", text: "#eaf6fc" },
  "not analysed": { fill: "#3a3a3a", edge: "#232323", text: "#a8a8a8" },
};

function lookOf(node: ModuleNode): Look {
  return node.level === "file" ? node.analysis : node.level;
}

function displayName(node: ModuleNode): string {
  return node.path === "" ? "/" : node.name;
}

const canvas = document.querySelector<HTMLCanvasElement>("#picture")!;
const tooltip = document.querySelector<HTMLDivElement>("#tooltip")!;
const context = canvas.getContext("2d")!;

const graph = (await (await fetch("/graph.json")).json()) as Graph;
const nodes = new Map<NodeId, ModuleNode>(graph.nodes.map((node) => [node.id, node]));
let rects: Rect[] = [];

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

function draw(): void {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const scale = window.devicePixelRatio;
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.font = "11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  context.textBaseline = "top";
  const pattern = hatch();

  rects = layout(graph, width, height);
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

    if (node.level !== "file") {
      if (reservesLabelBand(rect)) label([displayName(node)], { ...rect, h: LABEL_BAND }, style.text);
    } else {
      label(look === "not analysed" ? [node.name, "not analysed"] : [node.name], rect, style.text);
    }
  }
}

canvas.addEventListener("mousemove", (event) => {
  const hit = rects.findLast(
    (rect) =>
      event.clientX >= rect.x &&
      event.clientX < rect.x + rect.w &&
      event.clientY >= rect.y &&
      event.clientY < rect.y + rect.h,
  );
  const node = hit && nodes.get(hit.id);
  if (node === undefined) {
    tooltip.style.display = "none";
    return;
  }
  const facts = [`${node.level} ${node.path === "" ? "/" : node.path}`, `${node.lines} lines`];
  if (node.level === "file") facts.push(node.analysis);
  tooltip.textContent = facts.join("\n");
  tooltip.style.display = "block";
  tooltip.style.left = `${Math.min(event.clientX + 12, window.innerWidth - tooltip.offsetWidth - 4)}px`;
  tooltip.style.top = `${Math.min(event.clientY + 12, window.innerHeight - tooltip.offsetHeight - 4)}px`;
});
canvas.addEventListener("mouseleave", () => {
  tooltip.style.display = "none";
});
window.addEventListener("resize", draw);
draw();
