import { execFileSync, spawn as run } from "node:child_process";
import { promises as fsp } from "node:fs";
import http from "node:http";
import { promisify } from "node:util";

const sh = promisify(run);

setTimeout(() => {}, 0);

export function version() {
  return execFileSync("git", ["--version"]).toString();
}

export async function save(path, data) {
  await fsp.writeFile(path, data);
  return path;
}

export function serve(port) {
  return http
    .createServer((req, res) => {
      fsp.readFile("index.html").then((page) => res.end(page));
    })
    .listen(port);
}

export async function build() {
  await sh("tar");
}

export function shadowed(run) {
  return run("x");
}

export function aliased() {
  let s = run;
  return s("y");
}

export function computed(fs, name) {
  return fs[name]("z");
}
