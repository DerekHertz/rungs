import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { EXTRACTOR_VERSION, extract } from "../src/extract/extract.ts";
import { serializeGraph } from "../src/graph.ts";
import { readFixtureTree } from "./fixture-tree.ts";

const fixture = fileURLToPath(new URL("fixtures/small", import.meta.url));
const goldenPath = fileURLToPath(new URL("golden/small.json", import.meta.url));
const ledgerPath = fileURLToPath(new URL("extractor-versions.json", import.meta.url));

const serialized = serializeGraph(extract(readFixtureTree(fixture)));

describe("the extractor on the small fixture", () => {
  test("matches the committed golden graph (UPDATE_GOLDEN=1 rewrites it)", () => {
    if (process.env.UPDATE_GOLDEN === "1") writeFileSync(goldenPath, serialized);
    expect(serialized).toBe(readFileSync(goldenPath, "utf8"));
  });

  test("output is fixed for this extractor version", () => {
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as Record<string, string>;
    const hash = createHash("sha256").update(serialized).digest("hex");
    expect(
      ledger[EXTRACTOR_VERSION],
      `Extractor output changed or EXTRACTOR_VERSION ${EXTRACTOR_VERSION} has no ledger entry. ` +
        `Bump EXTRACTOR_VERSION in src/extract/extract.ts and append "<new version>": "<hash>" ` +
        `to test/extractor-versions.json, where the hash is the sha256 of the new output ` +
        `(currently ${hash} for version ${EXTRACTOR_VERSION}). Never edit an existing entry.`,
    ).toBe(hash);
  });

  test("ledger entries are append-only, so no two versions share an output", () => {
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as Record<string, string>;
    const hashes = Object.values(ledger);
    expect(new Set(hashes).size).toBe(hashes.length);
  });
});

describe("extract", () => {
  const graph = extract(
    new Map([
      ["package.json", "{}\n"],
      ["a.ts", "one\ntwo\n"],
      ["lib/b.md", "x"],
      ["lib/pkg/package.json", "{}"],
      ["lib/pkg/c.js", ""],
    ]),
  );
  const byPath = (level: string, path: string) =>
    graph.nodes.find((node) => node.level === level && node.path === path);

  test("nests packages, folders and files by containment", () => {
    expect(byPath("package", "")?.parent).toBeNull();
    expect(byPath("folder", "lib")?.parent).toBe(byPath("package", "")?.id);
    expect(byPath("package", "lib/pkg")?.parent).toBe(byPath("folder", "lib")?.id);
    expect(byPath("file", "lib/pkg/c.js")?.parent).toBe(byPath("package", "lib/pkg")?.id);
  });

  test("counts lines, and containers sum their descendants", () => {
    expect(byPath("file", "a.ts")?.lines).toBe(2);
    expect(byPath("file", "lib/b.md")?.lines).toBe(1);
    expect(byPath("file", "lib/pkg/c.js")?.lines).toBe(0);
    expect(byPath("folder", "lib")?.lines).toBe(2);
    expect(byPath("package", "")?.lines).toBe(5);
  });

  test("marks only files with a language adapter as analysed", () => {
    expect(byPath("file", "a.ts")).toMatchObject({ analysis: "analysed" });
    expect(byPath("file", "lib/pkg/c.js")).toMatchObject({ analysis: "analysed" });
    expect(byPath("file", "lib/b.md")).toMatchObject({ analysis: "not analysed" });
    expect(byPath("file", "package.json")).toMatchObject({ analysis: "not analysed" });
  });

  test("does not depend on the order of the file tree", () => {
    const tree = readFixtureTree(fixture);
    expect(extract(new Map([...tree].reverse()))).toEqual(extract(tree));
  });
});
