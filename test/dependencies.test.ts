import { describe, expect, test } from "vitest";
import { compare, serializeComparison } from "../src/compare.ts";
import type { Comparison } from "../src/compare.ts";
import { extract } from "../src/extract/extract.ts";
import { dependencyMentioned, dependencyReview, unmentioned } from "../src/review.ts";
import { unmentionedSummary } from "../src/review-summary.ts";
import type { FileTree } from "../src/graph.ts";

const treeOf = (files: Record<string, string>): FileTree => new Map(Object.entries(files));
const manifest = (value: object): string => `${JSON.stringify(value, null, 2)}\n`;
const compareTrees = (before: Record<string, string>, after: Record<string, string>): Comparison => compare(extract(treeOf(before)), extract(treeOf(after)));
const lines = (n: number): string => `${"x\n".repeat(n)}`;

describe("the extractor reads dependencies from package.json", () => {
  test("every list, name and range as written, sorted by list then name", () => {
    const graph = extract(
      treeOf({
        "package.json": manifest({
          devDependencies: { vitest: "^2.0.0" },
          dependencies: { zod: "~3.0.0", a: "latest" },
          peerDependencies: { react: ">=18" },
          optionalDependencies: { fsevents: "2" },
        }),
      }),
    );
    expect(graph.manifests).toEqual([
      {
        file: "file:package.json",
        path: "package.json",
        readable: true,
        declared: [
          { name: "a", range: "latest", list: "dependencies" },
          { name: "zod", range: "~3.0.0", list: "dependencies" },
          { name: "vitest", range: "^2.0.0", list: "devDependencies" },
          { name: "react", range: ">=18", list: "peerDependencies" },
          { name: "fsevents", range: "2", list: "optionalDependencies" },
        ],
      },
    ]);
  });

  test("a lockfile is never read", () => {
    const graph = extract(treeOf({ "package.json": "{}", "package-lock.json": manifest({ dependencies: { left: "1" }, packages: { "": { dependencies: { left: "1" } } } }) }));
    expect(graph.manifests.map((m) => m.declared)).toEqual([[]]);
  });

  test("a malformed package.json is unreadable and declares nothing; odd entries are kept with an unknown range, not guessed", () => {
    const graph = extract(
      treeOf({
        "package.json": "{ not json",
        "a/package.json": "[1, 2]",
        "b/package.json": manifest({ dependencies: { good: "1", number: 2, nested: { x: 1 }, nothing: null }, devDependencies: ["x"], peerDependencies: "y" }),
        "c/package.json": `\uFEFF${manifest({ dependencies: { bom: "1" } })}`,
      }),
    );
    expect(graph.manifests.map((m) => [m.path, m.readable, m.declared.map((d) => d.name)])).toEqual([
      ["a/package.json", false, []],
      ["b/package.json", true, ["good", "nested", "nothing", "number"]],
      ["c/package.json", true, ["bom"]],
      ["package.json", false, []],
    ]);
  });
});

describe("compare lists dependency changes", () => {
  test("added, removed, a range changed and a list changed", () => {
    const result = compareTrees(
      { "package.json": manifest({ dependencies: { gone: "1", up: "^1.0.0", moved: "1" }, devDependencies: { same: "1" } }) },
      { "package.json": manifest({ dependencies: { up: "^2.0.0", fresh: "3" }, devDependencies: { same: "1", moved: "1" } }) },
    );
    expect(result.dependencies.map((d) => [d.kind, d.name, d.before.map((x) => `${x.list} ${x.range}`), d.after.map((x) => `${x.list} ${x.range}`)])).toEqual([
      ["added", "fresh", [], ["dependencies 3"]],
      ["removed", "gone", ["dependencies 1"], []],
      ["changed", "moved", ["dependencies 1"], ["devDependencies 1"]],
      ["changed", "up", ["dependencies ^1.0.0"], ["dependencies ^2.0.0"]],
    ]);
  });

  test("no change, no entry; a moved package.json changes nothing by moving", () => {
    const text = manifest({ dependencies: { a: "1" } });
    expect(compareTrees({ "package.json": text }, { "package.json": text }).dependencies).toEqual([]);
    expect(compareTrees({ "old/package.json": text }, { "new/package.json": text }).dependencies).toEqual([]);
  });

  test("a new or deleted package.json adds or removes everything it declares", () => {
    const text = manifest({ dependencies: { a: "1" } });
    expect(compareTrees({ "x.ts": "" }, { "x.ts": "", "pkg/package.json": text }).dependencies.map((d) => [d.kind, d.path, d.name])).toEqual([["added", "pkg/package.json", "a"]]);
    expect(compareTrees({ "x.ts": "", "pkg/package.json": text }, { "x.ts": "" }).dependencies.map((d) => [d.kind, d.path, d.name])).toEqual([["removed", "pkg/package.json", "a"]]);
  });

  test("a package.json that turns malformed invents no removals, and one that is repaired no additions", () => {
    const good = manifest({ dependencies: { a: "1" } });
    expect(compareTrees({ "package.json": good }, { "package.json": "{ oops" }).dependencies).toEqual([]);
    expect(compareTrees({ "package.json": "{ oops" }, { "package.json": good }).dependencies).toEqual([]);
  });
});

describe("an entry whose range is not a string", () => {
  test("is recorded as declared with an unknown range, so it is never a removal", () => {
    const graph = extract(treeOf({ "package.json": manifest({ dependencies: { foo: 2, bar: "1" } }) }));
    expect(graph.manifests[0]!.declared).toEqual([
      { name: "bar", range: "1", list: "dependencies" },
      { name: "foo", range: null, list: "dependencies" },
    ]);
    const result = compareTrees({ "package.json": manifest({ dependencies: { foo: "1" } }) }, { "package.json": manifest({ dependencies: { foo: 2 } }) });
    expect(result.dependencies.map((d) => [d.kind, d.name, d.after[0]?.range])).toEqual([["changed", "foo", null]]);
    const back = compareTrees({ "package.json": manifest({ dependencies: { foo: 2 } }) }, { "package.json": manifest({ dependencies: { foo: "1" } }) });
    expect(back.dependencies.map((d) => [d.kind, d.before[0]?.range, d.after[0]?.range])).toEqual([["changed", null, "1"]]);
    expect(compareTrees({ "package.json": manifest({ dependencies: { foo: 2 } }) }, { "package.json": manifest({ dependencies: { foo: 3 } }) }).dependencies).toEqual([]);
  });
});

describe("dependencyMentioned", () => {
  test("by name, whole", () => {
    expect(dependencyMentioned("drops `three` and `@types/three`", "three")).toBe(true);
    expect(dependencyMentioned("drops `three` and `@types/three`", "@types/three")).toBe(true);
    expect(dependencyMentioned("drops three.", "three")).toBe(true);
    expect(dependencyMentioned("drops @types/three", "three")).toBe(false);
    expect(dependencyMentioned("drops three-stdlib and three.js", "three")).toBe(false);
    expect(dependencyMentioned("", "three")).toBe(false);
  });
});

describe("dependencyReview", () => {
  const before = {
    "package.json": manifest({ dependencies: { three: "^0.160.0" }, devDependencies: { "@types/three": "^0.160.0", keep: "1" } }),
    "package-lock.json": lines(70),
    "src/a.ts": "export const a = 1;\n",
  };
  const after = { ...before, "package.json": manifest({ devDependencies: { keep: "1" } }), "package-lock.json": lines(5) };
  const result = compareTrees(before, after);

  test("lists what the description does not name, with the lockfile under it", () => {
    const review = dependencyReview(result, "Fixes things.");
    expect(review.none.map((row) => [row.change.kind, row.change.name, row.id])).toEqual([
      ["removed", "@types/three", "file:package.json"],
      ["removed", "three", "file:package.json"],
    ]);
    expect(review.lockfiles.map((entry) => [entry.label, entry.level === "file" ? entry.change : ""])).toEqual([["package-lock.json", "altered"]]);
  });

  test("a mentioned dependency is not listed, and every one mentioned lists nothing at all", () => {
    expect(dependencyReview(result, "Removes `three`.").none.map((row) => row.change.name)).toEqual(["@types/three"]);
    const all = dependencyReview(result, "Removes `three` and `@types/three`.");
    expect(all.none).toEqual([]);
    expect(all.lockfiles).toEqual([]);
  });

  test("a lockfile the description names is not listed under them", () => {
    expect(dependencyReview(result, "Updates package-lock.json.").lockfiles).toEqual([]);
  });

  test("the lockfile leaves the file list when a dependency changed, and stays when none did", () => {
    const graph = extract(treeOf(after));
    const names = (comparison: Comparison): string[] => unmentioned(comparison, graph, "Nothing relevant.").entries.map((entry) => entry.label);
    expect(names(result)).toEqual(["package.json"]);
    const edited = compareTrees(before, { ...before, "package-lock.json": lines(5) });
    expect(edited.dependencies).toEqual([]);
    expect(names(edited)).toEqual(["package-lock.json"]);
  });

  test("a lockfile whose dependency changes are all mentioned counts as mentioned, never lost to a path that says nothing", () => {
    const one = compareTrees(
      { "package.json": manifest({ dependencies: { foo: "1" } }), "package-lock.json": lines(3) },
      { "package.json": manifest({ dependencies: { foo: "2" } }), "package-lock.json": lines(4) },
    );
    const graph = extract(treeOf({ "package.json": "{}" }));
    const text = "Update foo in package.json.";
    expect(dependencyReview(one, text)).toEqual({ none: [], lockfiles: [] });
    expect(unmentioned(one, graph, text).entries).toEqual([]);
    // Not mentioned: dependency and lockfile are both listed, once each.
    expect(dependencyReview(one, "Other.").lockfiles.map((e) => e.label)).toEqual(["package-lock.json"]);
    expect(unmentioned(one, graph, "Other.").entries.map((e) => e.label)).toEqual(["package.json"]);
  });

  test("a lockfile follows only the dependency changes of the package.json in its own folder", () => {
    const files = (a: string, b: string) => ({
      "package.json": manifest({ dependencies: { root: a } }),
      "package-lock.json": lines(Number(a) + 2),
      "pkg/package.json": manifest({ dependencies: { inner: b } }),
      "pkg/package-lock.json": lines(Number(b) + 2),
    });
    const graph = extract(treeOf({ "package.json": "{}" }));
    const only = compareTrees(files("1", "1"), { ...files("1", "2"), "package-lock.json": lines(9) });
    // pkg changed a dependency; the root lockfile changed with no root dependency change.
    const review = dependencyReview(only, "");
    expect(review.lockfiles.map((e) => e.label)).toEqual(["pkg/package-lock.json"]);
    expect(unmentioned(only, graph, "").entries.map((e) => e.label)).toEqual(["package-lock.json", "pkg/package.json"]);
  });

  test("a lockfile under an unmentioned dependency counts as one uncovered file, and the empty state may not claim otherwise", () => {
    const changed = compareTrees(
      { "package.json": manifest({ dependencies: { foo: "1" } }), "package-lock.json": lines(3) },
      { "package.json": manifest({ dependencies: { foo: "2" } }), "package-lock.json": lines(4) },
    );
    const graph = extract(treeOf({ "package.json": "{}" }));
    const result = unmentioned(changed, graph, "Update package.json.");
    expect(result.changedFiles).toBe(2);
    expect(result.entries).toEqual([]);
    expect(result.dependencyLockfiles).toBe(1);
    expect(result.unmentionedFiles).toBe(1);
    // Mentioned dependency: the lockfile is explained, nothing is uncovered.
    const explained = unmentioned(changed, graph, "Update foo in package.json.");
    expect(explained.dependencyLockfiles).toBe(0);
    expect(explained.unmentionedFiles).toBe(0);
  });

  test("a malformed package.json lists no dependency", () => {
    const broken = compareTrees(before, { ...before, "package.json": "{ broken" });
    expect(dependencyReview(broken, "").none).toEqual([]);
  });
});

test("the Unmentioned summary counts dependency changes", () => {
  expect(unmentionedSummary({ files: 1, calls: 0, dependencies: 2 })).toBe("1 file · 2 dependency changes");
  expect(unmentionedSummary({ files: null, calls: 0, dependencies: 1 })).toBe("1 dependency change");
  expect(unmentionedSummary({ files: 0, calls: 0, dependencies: 0 })).toBe("nothing");
});

describe("a package.json whose only change is mentioned dependency changes is covered", () => {
  const withTexts = (before: Record<string, string>, after: Record<string, string>): { comparison: Comparison; names: (text: string) => string[] } => {
    const head = extract(treeOf(after));
    const comparison = compare(extract(treeOf(before)), head, { base: treeOf(before), head: treeOf(after) });
    return { comparison, names: (text) => unmentioned(comparison, head, text).entries.map((entry) => entry.label) };
  };
  const base = { name: "x", scripts: { test: "vitest" }, dependencies: { three: "1", other: "1" } };
  const run = (next: object, lock = false) =>
    withTexts(
      { "package.json": manifest(base), ...(lock ? { "package-lock.json": lines(3) } : {}) },
      { "package.json": manifest(next), ...(lock ? { "package-lock.json": lines(4) } : {}) },
    );

  test("covered when every dependency change is named, listed when one is not", () => {
    const { names } = run({ ...base, dependencies: { other: "1" }, devDependencies: { vitest: "2" } }, true);
    expect(names("Drops three, adds vitest.")).toEqual([]);
    expect(names("Drops three.")).toEqual(["package.json"]);
  });

  test("formatting and key order are no change", () => {
    const head = JSON.stringify({ dependencies: { other: "1" }, scripts: base.scripts, name: "x" });
    const { comparison, names } = withTexts({ "package.json": manifest(base) }, { "package.json": head });
    expect(comparison.dependencyOnlyManifests).toEqual(["package.json"]);
    expect(names("Drops three.")).toEqual([]);
  });

  test("another change stays listed", () => {
    const { names } = run({ ...base, dependencies: { other: "1" }, scripts: { test: "jest" } });
    expect(names("Drops three.")).toEqual(["package.json"]);
    expect(run({ ...base, dependencies: { other: "1" }, version: "2" }).names("Drops three.")).toEqual(["package.json"]);
  });

  test("a side that does not parse stays listed", () => {
    const { names } = withTexts({ "package.json": manifest(base) }, { "package.json": "{ not json" });
    expect(names("three")).toEqual(["package.json"]);
  });

  test("without file texts nothing is decided", () => {
    const comparison = compareTrees({ "package.json": manifest(base) }, { "package.json": manifest({ ...base, dependencies: { other: "1" } }) });
    expect(comparison.dependencyOnlyManifests).toEqual([]);
  });
});

describe("a package.json stays listed when the dependency diff cannot see its change", () => {
  const run = (before: object, after: object, text: string): string[] => {
    const a = { "package.json": manifest(before) };
    const b = { "package.json": manifest(after) };
    const head = extract(treeOf(b));
    const comparison = compare(extract(treeOf(a)), head, { base: treeOf(a), head: treeOf(b) });
    return unmentioned(comparison, head, text).entries.map((entry) => entry.label);
  };

  test("a non-string range changing beside a mentioned one", () => {
    expect(run({ dependencies: { three: "1", other: 1 } }, { dependencies: { three: "2", other: 2 } }, "Update three.")).toEqual(["package.json"]);
    expect(run({ dependencies: { three: "1" } }, { dependencies: { three: "2" } }, "Update three.")).toEqual([]);
  });

  test("a dependency list that is not an object changing", () => {
    expect(run({ dependencies: { three: "1" }, devDependencies: "x" }, { dependencies: { three: "2" }, devDependencies: "y" }, "Update three.")).toEqual(["package.json"]);
  });

  test("the comparison serializes dependencyOnlyManifests", () => {
    const a = { "package.json": manifest({ dependencies: { three: "1" } }) };
    const b = { "package.json": manifest({ dependencies: { three: "2" } }) };
    const comparison = compare(extract(treeOf(a)), extract(treeOf(b)), { base: treeOf(a), head: treeOf(b) });
    expect(JSON.parse(serializeComparison(comparison)).dependencyOnlyManifests).toEqual(["package.json"]);
    const bare = compare(extract(treeOf(a)), extract(treeOf(b)));
    expect(JSON.parse(serializeComparison(bare)).dependencyOnlyManifests).toEqual([]);
  });
});

describe("a package.json is read by its own keys only", () => {
  const raw = (before: string, after: string, text: string): string[] => {
    const a = { "package.json": before };
    const b = { "package.json": after };
    const head = extract(treeOf(b));
    const comparison = compare(extract(treeOf(a)), head, { base: treeOf(a), head: treeOf(b) });
    return unmentioned(comparison, head, text).entries.map((entry) => entry.label);
  };

  test("an own __proto__ key is a change, not an inherited one", () => {
    expect(raw('{"custom":{"__proto__":{}},"dependencies":{"three":"1"}}', '{"custom":{"other":42},"dependencies":{"three":"2"}}', "Update three.")).toEqual(["package.json"]);
  });

  test("a dependency named constructor is added and removed like any other", () => {
    expect(raw('{"dependencies":{}}', '{"dependencies":{"constructor":"1.0.0"}}', "Add constructor.")).toEqual([]);
    expect(raw('{"dependencies":{"constructor":"1.0.0"}}', '{"dependencies":{}}', "Remove constructor.")).toEqual([]);
  });
});
