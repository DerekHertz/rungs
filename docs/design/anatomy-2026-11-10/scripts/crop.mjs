// Cuts a full-resolution detail out of the assembled town picture.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const [, , source, out, x, y, w, h, scale = "1"] = process.argv;
const { chromium } = createRequire("/home/dhertzell/docviz/package.json")("playwright");
const browser = await chromium.launch();
const tab = await browser.newPage();
const src = "data:image/png;base64," + readFileSync(source).toString("base64");
const png = await tab.evaluate(async ([data, cx, cy, cw, ch, k]) => {
  const img = new Image();
  await new Promise((done) => { img.onload = done; img.src = data; });
  const c = document.createElement("canvas");
  const ww = cw || img.width, hh = ch || img.height;
  c.width = Math.round(ww * k); c.height = Math.round(hh * k);
  c.getContext("2d").drawImage(img, cx, cy, ww, hh, 0, 0, c.width, c.height);
  return c.toDataURL("image/png");
}, [src, Number(x), Number(y), Number(w), Number(h), Number(scale)]);
writeFileSync(out, Buffer.from(png.split(",")[1], "base64"));
await browser.close();
