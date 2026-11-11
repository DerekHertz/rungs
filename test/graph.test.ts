import { describe, expect, test } from "vitest";
import { RESOURCE_ORDER, compareEdges, resourceId, serializeGraph } from "../src/graph.ts";
import type { EffectEdge, Graph, NodeId } from "../src/graph.ts";
import { qualifiedName } from "../src/graph.ts";

const TEXTS = [
  "a",
  "b",
  "a@2",
  '"a"',
  "a.b",
  "#a",
  "\\u0023a",
  "get a",
  "",
  ".",
  "@",
  "🙂",
  'a"b',
  "\\",
  "<function>",
];
const ORDINALS = [1, 2, 3];

describe("qualifiedName", () => {
  const segments = TEXTS.flatMap((text) => ORDINALS.map((ordinal) => ({ text, ordinal })));
  const paths = [
    ...segments.map((segment) => [segment]),
    ...segments.flatMap((outer) => segments.map((inner) => [outer, inner])),
  ];
  const names = paths.map((path) =>
    path.reduce((parent, { text, ordinal }) => qualifiedName(parent, text, ordinal), ""),
  );

  test("gives distinct names to distinct paths of (text, ordinal)", () => {
    expect(new Set(names).size).toBe(paths.length);
  });

  test("never contains # and is never empty", () => {
    for (const name of names) {
      expect(name).not.toContain("#");
      expect(name).not.toBe("");
    }
  });

  test("writes identifiers bare, other texts as JSON strings, and ordinals after the first", () => {
    expect(qualifiedName("", "render", 1)).toBe("render");
    expect(qualifiedName("Square", "get side", 1)).toBe('Square."get side"');
    expect(qualifiedName("Square", "#grow", 2)).toBe('Square."\\u0023grow"@2');
    expect(qualifiedName("", "map() callback", 3)).toBe('"map() callback"@3');
  });
});

describe("effect edges", () => {
  const edge = (from: string, start: number, operation: string): EffectEdge => ({
    kind: "effect",
    from: from as NodeId,
    to: resourceId("process"),
    operation,
    target: { literal: "git" },
    args: [],
    range: { start, end: start },
  });

  test("resource ids are one per kind and never a module id", () => {
    expect(RESOURCE_ORDER).toEqual(["process", "network", "queue", "file system", "timer", "code loaded at run time"]);
    expect(new Set(RESOURCE_ORDER.map(resourceId)).size).toBe(6);
    expect(resourceId("file system")).toBe("resource:file system");
  });

  test("edges sort by owner, then position, then operation", () => {
    const edges = [edge("function:b.js#f", 1, "x"), edge("function:a.js#f", 9, "x"), edge("function:a.js#f", 2, "y"), edge("function:a.js#f", 2, "x")];
    expect([...edges].sort(compareEdges).map((e) => `${e.from} ${e.range.start} ${e.operation}`)).toEqual([
      "function:a.js#f 2 x",
      "function:a.js#f 2 y",
      "function:a.js#f 9 x",
      "function:b.js#f 1 x",
    ]);
  });

  test("serializeGraph writes the edges after the nodes, sorted, targets as written", () => {
    const graph: Graph = {
      extractorVersion: "9",
      nodes: [],
      resolutions: [],
      imports: [],
      sections: [],
      manifests: [],
      edges: [
        { ...edge("function:b.js#f", 1, "x"), target: "unknown" },
        { ...edge("function:a.js#f", 1, "x"), target: "none" },
        edge("function:a.js#f", 0, "x"),
      ],
    };
    const parsed = JSON.parse(serializeGraph(graph)) as { edges: { from: string; target: unknown }[] };
    expect(parsed.edges.map((e) => [e.from, e.target])).toEqual([
      ["function:a.js#f", { literal: "git" }],
      ["function:a.js#f", "none"],
      ["function:b.js#f", "unknown"],
    ]);
    expect(Object.keys(parsed)).toEqual(["extractorVersion", "nodes", "edges", "resolutions", "imports", "sections", "manifests"]);
  });
});
