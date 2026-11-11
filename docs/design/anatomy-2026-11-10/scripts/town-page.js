// Mockup only. Browser code: assembles a town from pre-rendered sprites and real repo facts.
// No 3D and no model here: every building is a sprite placed by a fact.
const DATA = JSON.parse(document.getElementById("data").textContent);
const SHEET = DATA.sheet;
const FAR = DATA.far === true;
const PPU = 48, A = PPU * Math.SQRT1_2, B = A / 2, RISE = PPU * Math.cos(Math.PI / 6);
const C = { sea: "#12304a", seaLight: "#1d4a6e", sand: "#5d6072", sandDark: "#3d4050", grass: "#2f5240", grassLight: "#3a6650", pad: "#3b674c", padLight: "#4a7d5d", road: "#474c59", roadLight: "#5a606e", kerb: "#7d8494", wood: "#7a5a3a", woodDark: "#5a4028", quay: "#6b7080" };

const images = {};
await Promise.all(Object.entries(DATA.images).map(([name, src]) => new Promise((done) => { const img = new Image(); img.onload = done; img.src = src; images[name] = img; })));

// Lay the blocks out on the ground: X runs right and towards the viewer, Y runs right and away.
const LOT = 4.3, GAP = 3.2;
const blocks = DATA.town.map((n) => { const cols = Math.ceil(Math.sqrt(n.files.length * 1.4)), rows = Math.ceil(n.files.length / cols); return { ...n, cols, rows, w: cols * LOT + 1, d: rows * LOT + 1 }; }).sort((p, q) => q.d - p.d || q.w - p.w);
const target = Math.sqrt(blocks.reduce((s, b) => s + (b.w + GAP) * (b.d + GAP), 0)) * 1.3;
let bx = 0, bz = 0, rowD = 0, W = 0;
for (const b of blocks) {
  if (bx > 0 && bx + b.w > target) { bx = 0; bz += rowD + GAP; rowD = 0; }
  b.x = bx; b.z = bz; bx += b.w + GAP; rowD = Math.max(rowD, b.d); W = Math.max(W, bx - GAP);
}
const D = bz + rowD;
// A block at layout (x, z) sits at ground (X, Y) = (x - W/2, D/2 - z): rows nearer the viewer have smaller Y.
const ground = (x, z) => [x - W / 2, D / 2 - z];
const AX = (W / 2) * 1.38 + 6, AY = (D / 2) * 1.38 + 6;
const coast = (scale) => Array.from({ length: 120 }, (_, i) => { const t = (i / 120) * Math.PI * 2, r = 1 + 0.07 * Math.sin(3 * t + 1) + 0.05 * Math.sin(7 * t + 2) + 0.03 * Math.sin(11 * t); return [Math.cos(t) * AX * r * scale, Math.sin(t) * AY * r * scale]; });

const flat = (X, Y, Z = 0) => [(X + Y) * A, (X - Y) * B - Z * RISE];
const shore = coast(1).map(([X, Y]) => flat(X, Y));
const minX = Math.min(...shore.map((p) => p[0])) - 420, maxX = Math.max(...shore.map((p) => p[0])) + 520;
const minY = Math.min(...shore.map((p) => p[1])) - 420, maxY = Math.max(...shore.map((p) => p[1])) + 220;
const canvas = document.getElementById("view");
canvas.width = Math.ceil(maxX - minX); canvas.height = Math.ceil(maxY - minY);
const ctx = canvas.getContext("2d");
ctx.imageSmoothingEnabled = false;
const at = (X, Y, Z = 0) => { const [sx, sy] = flat(X, Y, Z); return [Math.round(sx - minX), Math.round(sy - minY)]; };

let seed = 7;
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
function fill(points, colour, speck, density = 0.02) {
  ctx.beginPath();
  points.forEach(([X, Y], i) => { const [sx, sy] = at(X, Y); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
  ctx.closePath();
  ctx.fillStyle = colour; ctx.fill();
  if (!speck) return;
  ctx.save(); ctx.clip();
  const xs = points.map(([X, Y]) => at(X, Y)[0]), ys = points.map(([X, Y]) => at(X, Y)[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  ctx.fillStyle = speck;
  for (let i = 0; i < (x1 - x0) * (y1 - y0) * density / 4; i++) ctx.fillRect(x0 + Math.floor(rand() * (x1 - x0) / 2) * 2, y0 + Math.floor(rand() * (y1 - y0) / 2) * 2, rand() < 0.3 ? 4 : 2, 2);
  ctx.restore();
}
const rect = (X0, Y0, X1, Y1) => [[X0, Y0], [X1, Y0], [X1, Y1], [X0, Y1]];

// Sea, island, roads and lots.
ctx.fillStyle = C.sea; ctx.fillRect(0, 0, canvas.width, canvas.height);
ctx.fillStyle = C.seaLight;
for (let i = 0; i < canvas.width * canvas.height / 5200; i++) { const x = Math.floor(rand() * canvas.width / 2) * 2, y = Math.floor(rand() * canvas.height / 2) * 2; ctx.fillRect(x, y, 6 + Math.floor(rand() * 5) * 2, 2); }
ctx.save(); ctx.translate(0, 16); fill(coast(1), C.sandDark); ctx.restore();
fill(coast(1), C.sand, C.sandDark, 0.03);
fill(coast(0.95), C.grass, C.grassLight, 0.035);
{
  const [X0, Y0] = ground(-GAP / 2, D + GAP / 2), [X1, Y1] = ground(W + GAP / 2, -GAP / 2);
  fill(rect(X0, Y0, X1, Y1), C.road, C.roadLight, 0.03);
}
const hx = AX * 1.04 - 3;
fill(rect(hx - 2.6, -DATA.ports.length * 2.2 - 1, hx + 2.6, DATA.ports.length * 2.2 + 1), C.quay, C.roadLight, 0.03);
DATA.ports.forEach((kind, i) => { const Y = (i - (DATA.ports.length - 1) / 2) * 4.4; ctx.save(); ctx.translate(0, 8); fill(rect(hx + 2.6, Y - 1.3, hx + 9.5, Y - 0.3), C.woodDark); ctx.restore(); fill(rect(hx + 2.6, Y - 1.3, hx + 9.5, Y - 0.3), C.wood, C.woodDark, 0.05); });

const things = [];   // { name, X, Y } drawn back to front
const glows = [];
const labels = [];
const put = (name, X, Y, bias = 0) => things.push({ name, X, Y, key: X - Y + bias });
let index = 0;
for (const b of blocks) {
  const [X0, Yb] = ground(b.x, b.z), [X1, Yf] = ground(b.x + b.w, b.z + b.d);
  fill(rect(X0 - 0.18, Yf - 0.18, X1 + 0.18, Yb + 0.18), C.kerb);
  fill(rect(X0, Yf, X1, Yb), C.pad, C.padLight, 0.04);
  {
    const total = b.files.length, fresh = b.files.filter((f) => f.change === "added").length, touched = b.files.filter((f) => f.change !== "added" && f.change !== "unchanged").length;
    const text = b.name + (fresh ? ` \u00b7 ${fresh} new` : "") + (touched ? ` \u00b7 ${touched} altered` : "");
    labels.push({ text, X: (X0 + X1) / 2, Y: FAR ? (Yb + Yf) / 2 : Yb + 0.9, Z: FAR ? 7 : 0, kind: "folder", cls: fresh || touched ? "hot" : "place" });
    // A folder that is mostly new is fenced off and signed, so it reads from far away.
    if (fresh > total / 2) {
      for (let X = X0; X < X1 - 0.01; X += 1) { put("fence-x", X + 0.5, Yf - 0.4); put("fence-x", X + 0.5, Yb + 0.4); }
      for (let Y = Yf; Y < Yb - 0.01; Y += 1) { put("fence-y", X0 - 0.4, Y + 0.5); put("fence-y", X1 + 0.4, Y + 0.5); }
      put("sign", X1 + 1.7, Yf - 1.5);
      if (!FAR) labels.push({ text: `${b.name} \u00b7 ${fresh} new`, X: X1 + 1.7, Y: Yf - 1.5, Z: 3.6, kind: "sign", cls: "hot" });
      console.log("SIGN " + b.name + " " + at(X1 + 1.7, Yf - 1.5).join(" "));
    }
  }
  b.files.forEach((f, i) => {
    const col = i % b.cols, row = Math.floor(i / b.cols);
    const [X, Y] = ground(b.x + 0.5 + col * LOT + LOT / 2, b.z + 0.5 + row * LOT + LOT / 2);
    const floors = 1 + Math.min(2, Math.round(Math.sqrt(f.fns) / 2.2));
    const sprite = { source: "workshop-" + floors, tests: "lab-" + Math.min(2, floors), docs: "library", config: "shed", generated: "warehouse" }[f.role] ?? "hut";
    put(sprite, X, Y);
    if (f.change === "added") fill(rect(X - LOT / 2 + 0.25, Y - LOT / 2 + 0.25, X + LOT / 2 - 0.25, Y + LOT / 2 - 0.25), "#6b5236", "#4f3b26", 0.07);
    else if (f.change !== "unchanged") {
      const overlay = /-(\d)$/.test(sprite) ? "scaffold-" + sprite.slice(-1) : sprite === "shed" || sprite === "hut" ? "scaffold-small" : "scaffold-low";
      put(overlay, X, Y, 0.01);
      put("crane", X - 1.75, Y + 1.75, -0.2);
      labels.push({ text: f.name, X: X - 1.75, Y: Y + 1.75, Z: 8.9, kind: "file", cls: "hot" });
    }
    index++;
  });
  for (let i = b.files.length; i < b.cols * b.rows; i++) { const col = i % b.cols, row = Math.floor(i / b.cols); const [X, Y] = ground(b.x + 0.5 + col * LOT + LOT / 2, b.z + 0.5 + row * LOT + LOT / 2); put("tree", X - 0.6, Y + 0.3); put("tree", X + 0.7, Y - 0.5); }
  put("tree", X0 + 0.5, Yb - 0.5);
  for (const [lx, lz] of [[b.x + b.w + 0.8, b.z + b.d + 0.8], [b.x - 0.8, b.z + b.d + 0.8]]) { const [X, Y] = ground(lx, lz); put("lamp", X, Y); glows.push([X + 0.35, Y]); }
}
DATA.ports.forEach((kind, i) => {
  const Y = (i - (DATA.ports.length - 1) / 2) * 4.4, name = "port-" + kind.replace(" ", "-");
  put(name, hx - 0.3, Y);
  labels.push({ text: kind, X: hx - 0.3, Y, Z: SHEET[name] ? SHEET[name].oy / RISE + 0.3 : 5, cls: "port" });
});
for (let i = 0; i < 46; i++) { const t = rand() * Math.PI * 2, r = 0.8 + rand() * 0.12, X = Math.cos(t) * AX * r * 0.9, Y = Math.sin(t) * AY * r * 0.9; const [gx, gz] = [X + W / 2, D / 2 - Y]; if (gx > -GAP && gx < W + GAP && gz > -GAP && gz < D + GAP) continue; if (Math.abs(X - hx) < 5 && Math.abs(Y) < DATA.ports.length * 2.4 + 2) continue; put("tree", X, Y); }

// Pools of lamp light on the ground, then everything standing on it, back to front.
ctx.globalCompositeOperation = "lighter";
for (const [X, Y] of glows) { const [sx, sy] = at(X, Y); const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, 90); g.addColorStop(0, "rgba(255,214,107,0.34)"); g.addColorStop(1, "rgba(255,214,107,0)"); ctx.save(); ctx.translate(sx, sy); ctx.scale(1, 0.5); ctx.translate(-sx, -sy); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(sx, sy, 90, 0, Math.PI * 2); ctx.fill(); ctx.restore(); }
ctx.globalCompositeOperation = "source-over";
things.sort((p, q) => p.key - q.key);
for (const t of things) {
  const s = SHEET[t.name], img = images[t.name];
  if (!s || !img) { console.error("missing sprite", t.name); continue; }
  const [sx, sy] = at(t.X, t.Y);
  ctx.drawImage(img, Math.round(sx - s.ox), Math.round(sy - s.oy));
}
// Names. From far away only folders are named, in large type; file names appear close up.
ctx.textBaseline = "middle"; ctx.textAlign = "center";
for (const l of labels) {
  if (FAR && l.kind === "file") continue;
  const size = FAR ? (l.kind === "folder" ? (l.cls === "hot" ? 70 : 54) : 44) : l.kind === "sign" ? 30 : 22;
  ctx.font = `600 ${size}px ui-monospace, Menlo, Consolas, monospace`;
  const [sx, sy] = at(l.X, l.Y, l.Z), w = Math.ceil(ctx.measureText(l.text).width) + Math.round(size * 0.8), h = Math.round(size * 1.45);
  ctx.fillStyle = "rgba(5,7,10,0.86)"; ctx.fillRect(Math.round(sx - w / 2), Math.round(sy - h / 2), w, h);
  ctx.lineWidth = Math.max(2, Math.round(size / 11)); ctx.strokeStyle = l.cls === "hot" ? "#ff5fa8" : l.cls === "port" ? "#7d8494" : "#39424e";
  ctx.strokeRect(Math.round(sx - w / 2) + 1, Math.round(sy - h / 2) + 1, w - 2, h - 2);
  ctx.fillStyle = l.cls === "port" ? "#c9ced6" : "#f2f4f7"; ctx.fillText(l.text, sx, sy + 1);
}
{
  const [sx, sy] = at(hx + 12, -DATA.ports.length * 2.2 - 6);
  ctx.font = "italic 22px ui-monospace, Menlo, Consolas, monospace"; ctx.fillStyle = "#d7e6f2"; ctx.fillText("the sea: the outside world", sx, sy);
}
window.__ready = true;
