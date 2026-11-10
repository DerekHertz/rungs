import { describe, expect, test } from "vitest";
import { extract } from "../src/extract/extract.ts";
import { resourceId, resourcesOf } from "../src/graph.ts";

/** The effect edges of one file as "owner | operation | target", in graph order. */
function effectsOf(source: string, path = "a.mjs"): string[] {
  const graph = extract(new Map([[path, source]]));
  return graph.edges.map((edge) => {
    const owner = edge.from.includes("#") ? edge.from.slice(edge.from.indexOf("#") + 1) : "(file)";
    const target = typeof edge.target === "string" ? edge.target : JSON.stringify(edge.target.literal);
    return `${owner} | ${edge.to.slice("resource:".length)} | ${edge.operation} | ${target}`;
  });
}

describe("effect edges: what resolves", () => {
  const cases: [string, string, string[]][] = [
    [
      "a named import",
      'import { execFileSync } from "node:child_process";\nfunction f() { execFileSync("git", ["status"]); }',
      ['f | process | child_process execFileSync | "git"'],
    ],
    [
      "an aliased import and a bare module name",
      'import { spawn as run } from "child_process";\nfunction f() { run("tar"); }',
      ['f | process | child_process spawn | "tar"'],
    ],
    [
      "a default import",
      'import cp from "node:child_process";\nfunction f() { cp.exec("ls -l"); }',
      ['f | process | child_process exec | "ls -l"'],
    ],
    [
      "a namespace import",
      'import * as fs from "node:fs";\nfunction f() { fs.readFileSync("x.txt"); }',
      ['f | file system | fs readFileSync | "x.txt"'],
    ],
    [
      "fs.promises through a named import",
      'import { promises as fsp } from "node:fs";\nasync function f() { await fsp.writeFile("out"); }',
      ['f | file system | fs/promises writeFile | "out"'],
    ],
    [
      "fs.promises through a namespace",
      'import fs from "node:fs";\nasync function f() { await fs.promises.readFile("in"); }',
      ['f | file system | fs/promises readFile | "in"'],
    ],
    [
      "a const require",
      'const cp = require("child_process");\nfunction f() { cp.spawnSync("which", ["git"]); }',
      ['f | process | child_process spawnSync | "which"'],
    ],
    [
      "a destructured require",
      'const { readFile, writeFile: put } = require("fs/promises");\nfunction f() { readFile("a"); put("b"); }',
      ['f | file system | fs/promises readFile | "a"', 'f | file system | fs/promises writeFile | "b"'],
    ],
    [
      "an inline require",
      'function f() { require("node:fs").mkdirSync("d"); }',
      ['f | file system | fs mkdirSync | "d"'],
    ],
    [
      "a const alias of an import",
      'import { execSync } from "child_process";\nconst sh = execSync;\nfunction f() { sh("pwd"); }',
      ['f | process | child_process execSync | "pwd"'],
    ],
    [
      "util.promisify of a catalog function",
      'import { execFile } from "child_process";\nimport { promisify } from "util";\nconst run = promisify(execFile);\nasync function f() { await run("git"); }',
      ['f | process | child_process execFile | "git"'],
    ],
    [
      "globals",
      "function f() {\n fetch(u);\n setTimeout(g, 1);\n setInterval(g, 1);\n setImmediate(g);\n}",
      [
        "f | network | fetch | unknown",
        "f | timer | setTimeout | none",
        "f | timer | setInterval | none",
        "f | timer | setImmediate | none",
      ],
    ],
    [
      "globalThis and window members",
      'function f() { globalThis.fetch("https://api.typesafe.ai/x"); window.setTimeout(g, 1); }',
      ['f | network | fetch | "https://api.typesafe.ai/x"', "f | timer | setTimeout | none"],
    ],
    [
      "constructors",
      'function f() {\n new WebSocket("wss://x");\n new EventSource(u);\n new XMLHttpRequest();\n}',
      ['f | network | WebSocket | "wss://x"', "f | network | EventSource | unknown", "f | network | XMLHttpRequest | none"],
    ],
    [
      "a worker thread",
      'import { Worker } from "node:worker_threads";\nfunction f() { new Worker("./w.js"); }',
      ['f | process | worker_threads Worker | "./w.js"'],
    ],
    [
      "process.kill and process.exit",
      "function f(pid) {\n process.kill(pid);\n process.exit(1);\n}",
      ["f | process | process kill | unknown", "f | process | process exit | none"],
    ],
    [
      "a server, whose target is none, and a request with a template",
      'import http from "node:http";\nfunction f() { http.createServer(h); http.get(`http://localhost:3000`); http.request(`http://${host}/`); }',
      [
        "f | network | http createServer | none",
        'f | network | http get | "http://localhost:3000"',
        "f | network | http request | unknown",
      ],
    ],
    [
      "rename names its second argument",
      'import { rename, copyFileSync } from "node:fs";\nfunction f() {\n rename("a", "b");\n copyFileSync("c", "d");\n}',
      ['f | file system | fs rename | "b"', 'f | file system | fs copyFileSync | "d"'],
    ],
    [
      "timers/promises",
      'import { setTimeout as sleep } from "node:timers/promises";\nasync function f() { await sleep(5); }',
      ["f | timer | timers/promises setTimeout | none"],
    ],
    [
      "a missing, spread or computed argument is unknown",
      'import { spawn } from "child_process";\nfunction f(a) { spawn(); spawn(...a); spawn(a.b); spawn(cmd()); }',
      [
        "f | process | child_process spawn | unknown",
        "f | process | child_process spawn | unknown",
        "f | process | child_process spawn | unknown",
        "f | process | child_process spawn | unknown",
      ],
    ],
  ];
  test.each(cases)("%s", (_name, source, expected) => {
    expect(effectsOf(source)).toEqual(expected);
  });
});

describe("effect edges: what never resolves", () => {
  const cases: [string, string][] = [
    ["a parameter shadowing an import", 'import { spawn } from "child_process";\nfunction f(spawn) { spawn("x"); }'],
    ["a local function shadowing a global", "function f() { function fetch() {}\n fetch(1); }"],
    ["a let alias", 'import { spawn } from "child_process";\nlet s = spawn;\nfunction f() { s("x"); }'],
    ["a var require", 'var cp = require("child_process");\nfunction f() { cp.spawn("x"); }'],
    ["a computed member", 'import fs from "fs";\nfunction f(n) { fs[n]("x"); }'],
    ["a method on a returned object", 'function f() { const s = make();\n s.listen(1); s.close(); }'],
    ["a member that is not in the catalog", 'import fs from "fs";\nfunction f() { fs.constants; process.env.X; console.log(1); }'],
    ["a module that is not in the catalog", 'import { exec } from "some-lib";\nfunction f() { exec("x"); }'],
    ["createRequire", 'import { createRequire } from "module";\nconst require = createRequire(import.meta.url);\nfunction f() { require("fs").readFileSync("a"); }'],
    ["a dynamic import", 'async function f() { const { readFile } = await import("node:fs/promises"); readFile("a"); }'],
    ["a method named like a catalog entry", "function f(o) { o.spawn('x'); o.fetch(1); }"],
    ["a declaration file", "export declare function f(): void;"],
  ];
  test.each(cases)("%s", (_name, source) => {
    expect(effectsOf(source)).toEqual([]);
  });

  test("a declaration file has none", () => {
    expect(effectsOf('import { spawn } from "child_process";\nspawn("x");', "a.d.ts")).toEqual([]);
  });
});

describe("effect edges: attribution", () => {
  test("goes to the innermost function, the callback included, and the file at top level", () => {
    const source = [
      'import http from "node:http";',
      'import { readFile } from "node:fs/promises";',
      'process.exit(2);',
      "export function start() {",
      "  http.createServer((req, res) => {",
      '    readFile("page.html");',
      "  });",
      "}",
      "class C {",
      '  field = fetch("https://x");',
      "  m() { setTimeout(g, 1); }",
      "}",
    ].join("\n");
    expect(effectsOf(source)).toEqual([
      'C | network | fetch | "https://x"',
      "(file) | process | process exit | none",
      "C.m | timer | setTimeout | none",
      "start | network | http createServer | none",
      'start."createServer() callback" | file system | fs/promises readFile | "page.html"',
    ]);
  });

  test("records the call's own lines", () => {
    const graph = extract(
      new Map([["a.mjs", 'import { spawn } from "child_process";\nfunction f() {\n  spawn(\n    "git",\n  );\n}\n']]),
    );
    expect(graph.edges.map((edge) => edge.range)).toEqual([{ start: 3, end: 5 }]);
  });

  test("resources are derived from the edges, in the fixed order", () => {
    const graph = extract(new Map([["a.mjs", "function f() { setTimeout(g); fetch(u); process.exit(); }"]]));
    expect(resourcesOf(graph)).toEqual(["process", "network", "timer"]);
    expect(graph.edges.every((edge) => edge.to === resourceId(edge.to.slice("resource:".length) as never))).toBe(true);
    expect(extract(new Map([["a.mjs", "function f() {}"]])).edges).toEqual([]);
  });

  test("does not depend on the order of the file tree", () => {
    const tree = new Map([
      ["a.mjs", 'import { spawn } from "child_process";\nexport function a() { spawn("a"); }'],
      ["b.cjs", 'const fs = require("fs");\nfunction b() { fs.readFileSync("b"); }'],
    ]);
    expect(extract(new Map([...tree].reverse()))).toEqual(extract(tree));
  });
});

describe("effect edges: globals other files assign", () => {
  test("a global another file assigns to is still the global", () => {
    const graph = extract(
      new Map([
        ["a.mjs", "export function f() {\n  fetch(u);\n  setTimeout(g, 1);\n}\n"],
        ["b.mjs", "globalThis.fetch = () => 1;\nglobalThis.setTimeout = () => 2;\n"],
      ]),
    );
    expect(graph.edges.map((edge) => `${edge.from} ${edge.operation}`)).toEqual([
      "function:a.mjs#f fetch",
      "function:a.mjs#f setTimeout",
    ]);
  });

  test("a repository declaration in another script is not the global", () => {
    const graph = extract(
      new Map([
        ["a.ts", "const fetch = (x: string) => {};\n"],
        ["b.ts", 'function f() {\n  fetch("fake");\n}\n'],
      ]),
    );
    expect(graph.edges).toEqual([]);
  });

  test("window and self assignments leave the global a global", () => {
    const graph = extract(
      new Map([
        ["a.mjs", "window.fetch = () => 1;\nself.setTimeout = () => 2;\n"],
        ["b.mjs", "export function f() {\n  fetch(u);\n  setTimeout(g, 1);\n}\n"],
      ]),
    );
    expect(graph.edges.map((edge) => edge.operation)).toEqual(["fetch", "setTimeout"]);
  });
});
