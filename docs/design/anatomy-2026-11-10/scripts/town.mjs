// Mockup only: writes one self-contained page that assembles docviz#9's town from the sprite
// sheet, then saves the assembled canvas as a PNG.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const here = new URL(".", import.meta.url).pathname;
const [, , , PORT = "4331", TITLE = "docviz#9"] = process.argv;
const graph = await (await fetch(`http://127.0.0.1:${PORT}/graph.json`)).json();
const comparison = await (await fetch(`http://127.0.0.1:${PORT}/comparison.json`)).json();

const changeOf = new Map(comparison.changes.filter((c) => c.node.level === "file").map((c) => [c.node.path, c.kind]));
const fns = new Map();
for (const n of graph.nodes) if (n.level === "function" || n.level === "class") fns.set(n.path, (fns.get(n.path) ?? 0) + 1);
const byTop = new Map();
for (const n of graph.nodes) {
  if (n.level !== "file") continue;
  const top = n.path.includes("/") ? n.path.split("/")[0] : "root files";
  const file = { name: n.path.split("/").pop(), role: n.role ?? "none", fns: n.role === "generated" ? 0 : fns.get(n.path) ?? 0, change: changeOf.get(n.path) ?? "unchanged" };
  byTop.set(top, [...(byTop.get(top) ?? []), file]);
}
const town = [...byTop].map(([name, files]) => ({ name, files: files.sort((a, b) => b.fns - a.fns) }));
const ports = ["process", "network", "file system", "timer"].filter((kind) => graph.edges.some((e) => e.to === "resource:" + kind));

const sheet = JSON.parse(readFileSync(here + "town/sprites.json", "utf8"));
const images = Object.fromEntries(readdirSync(here + "town").filter((f) => f.endsWith(".png")).map((f) => [f.slice(0, -4), "data:image/png;base64," + readFileSync(here + "town/" + f).toString("base64")]));
const far = process.argv[5] === "far";
const data = JSON.stringify({ town, ports, sheet, images, far }).replace(/</g, "\\u003c");
const page = readFileSync(here + "town-page.js", "utf8");
const out = process.argv[2];
writeFileSync(out, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sprite town</title>
<style>
body{margin:0;background:#0b1020;color:#d6dae0;font:14px/1.45 ui-monospace,Menlo,Consolas,monospace}
main{padding:12px}h1{font-size:16px;font-weight:600;margin:0 0 4px}p{margin:0 0 8px;color:#9aa1ab;max-width:100ch}
.scroll{overflow:auto;border:1px solid #232a33;max-height:86vh}
canvas{display:block;image-rendering:pixelated}
</style></head><body><main>
<h1>${TITLE} as a town, assembled from Blender sprites</h1>
<p>Every building is a pre-rendered sprite placed by a fact: its kind from the file's role, its size from the file's function count. An altered file gets scaffolding, a crane and its name; a new file stands on bare earth. Scroll to look around; this is the picture at full size.</p>
<div class="scroll"><canvas id="view"></canvas></div>
</main>
<script type="application/json" id="data">${data}</script>
<script type="module">${page}</script>
</body></html>`);

const { chromium } = createRequire("/home/dhertzell/docviz/package.json")("playwright");
const browser = await chromium.launch({ args: ["--allow-file-access-from-files"] });
const tab = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
tab.on("console", (m) => { if (m.type() === "error" || m.text().startsWith("SIGN")) console.log(m.text().slice(0, 300)); });
tab.on("pageerror", (e) => console.log("pageerror:", String(e).slice(0, 400)));
await tab.goto("file://" + out);
await tab.waitForFunction("window.__ready === true", null, { timeout: 60000 });
const png = await tab.evaluate(() => document.getElementById("view").toDataURL("image/png"));
writeFileSync(out.replace(/\.html$/, ".png"), Buffer.from(png.split(",")[1], "base64"));
console.log(await tab.evaluate(() => `${document.getElementById("view").width}x${document.getElementById("view").height}`));
await browser.close();
