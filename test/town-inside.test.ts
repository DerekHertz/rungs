import { describe, expect, test } from "vitest";
import { compare, pictureOf } from "../src/compare.ts";
import { extract } from "../src/extract/extract.ts";
import type { FileTree, Graph, NodeId } from "../src/graph.ts";
import { insideOf, marksOf, objectSpriteName, roomNamesAt, ROOM_STEPS, sideOfLines } from "../src/town-inside.ts";

const SHEET = new Set([
  "floor", "floor-changed", "wall-x", "wall-y", "door-outside", "cone",
  "object-process", "object-network", "object-file-system", "object-queue", "object-timer", "object-dynamic-load",
]);

const treeOf = (files: Record<string, string>): FileTree => new Map(Object.entries(files));
const FILE = "file:a.js" as NodeId;

const SOURCE = `const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
function quiet() { return 1; }
function runGit() { return execFileSync("git", ["status"]); }
function load() { return fs.readFileSync("x"); }
exports.runGit = runGit;
class Box { open() { return fs.readFileSync("y"); } }
`;

const graph = extract(treeOf({ "a.js": SOURCE }));

describe("insideOf", () => {
  test("is a pure function of the graph", () => {
    expect(insideOf(graph, FILE, SHEET)).toEqual(insideOf(structuredClone(graph), FILE, new Set([...SHEET].reverse())));
  });

  test("has one room per function and method, in source order", () => {
    const inside = insideOf(graph, FILE, SHEET)!;
    expect(inside.rooms.map((room) => room.name)).toEqual(["quiet", "runGit", "load", "Box.open"]);
  });

  test("gives each room a floor tile per interior tile and walls round it, none doubled", () => {
    const inside = insideOf(graph, FILE, SHEET)!;
    expect(inside.floors).toHaveLength(inside.rooms.reduce((sum, room) => sum + room.side * room.side, 0));
    const keys = inside.walls.map((wall) => `${wall.sprite === "wall-y" ? "y" : "x"}|${wall.X}|${wall.Y}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(inside.floors.map((tile) => `${tile.X}|${tile.Y}`)).size).toBe(inside.floors.length);
  });

  test("puts a door on the outer wall of an exported function's room only", () => {
    const inside = insideOf(graph, FILE, SHEET)!;
    const doors = inside.walls.filter((wall) => wall.sprite === "door-outside");
    expect(doors.map((door) => door.room)).toEqual([`function:a.js#runGit`]);
    const room = inside.rooms.find((candidate) => candidate.name === "runGit")!;
    expect(doors[0]!.Y).toBe(room.Y0 - 0.5);
    expect(room.exported).toBe(true);
    expect(inside.rooms.filter((candidate) => candidate.exported)).toHaveLength(1);
  });

  test("puts each outside call in the room of the function that makes it, as its kind's object", () => {
    const inside = insideOf(graph, FILE, SHEET)!;
    const byName = new Map(inside.rooms.map((room) => [room.name, room]));
    expect(byName.get("quiet")!.objects).toHaveLength(0);
    expect(byName.get("runGit")!.objects.map((object) => [object.sprite, object.target])).toEqual([["object-process", '"git"']]);
    expect(byName.get("load")!.objects.map((object) => object.sprite)).toEqual(["object-file-system"]);
    expect(byName.get("Box.open")!.objects.map((object) => object.sprite)).toEqual(["object-file-system"]);
  });

  test("keeps objects on their room's tiles, off its door tile, and apart", () => {
    const inside = insideOf(graph, FILE, SHEET)!;
    for (const room of inside.rooms) {
      const seen = new Set<string>();
      for (const object of room.objects) {
        expect(object.X).toBeGreaterThanOrEqual(room.X0);
        expect(object.X).toBeLessThanOrEqual(room.X0 + room.side - 1);
        expect(object.Y).toBeGreaterThanOrEqual(room.Y0);
        expect(object.Y).toBeLessThanOrEqual(room.Y0 + room.side - 1);
        expect(seen.has(`${object.X}|${object.Y}`)).toBe(false);
        seen.add(`${object.X}|${object.Y}`);
        if (room.exported) expect([object.X, object.Y]).not.toEqual([room.X0 + Math.floor(room.side / 2), room.Y0]);
      }
    }
  });

  test("grows a room until its objects fit", () => {
    const calls = Array.from({ length: 12 }, (_, i) => `setTimeout(() => {}, ${i});`).join("\n");
    const busy = extract(treeOf({ "a.js": `function busy() {\n${calls}\n}\n` }));
    const room = insideOf(busy, FILE, SHEET)!.rooms[0]!;
    expect(room.objects).toHaveLength(12);
    expect(room.side * room.side).toBeGreaterThanOrEqual(12);
    expect(new Set(room.objects.map((object) => `${object.X}|${object.Y}`)).size).toBe(12);
  });

  test("steps a room's side with its function's lines", () => {
    expect(sideOfLines(1)).toBe(ROOM_STEPS[0]!.side);
    expect(sideOfLines(11)).toBe(ROOM_STEPS[1]!.side);
    expect(sideOfLines(500)).toBe(ROOM_STEPS.at(-1)!.side);
    const body = Array.from({ length: 40 }, (_, i) => `  const v${i} = ${i};`).join("\n");
    const sized = extract(treeOf({ "a.js": `function small() {}\nfunction big() {\n${body}\n}\n` }));
    const rooms = insideOf(sized, FILE, SHEET)!.rooms;
    expect(rooms[0]!.side).toBeLessThan(rooms[1]!.side);
  });

  test("wraps rows so that no room overlaps another and every row has a street between", () => {
    const many = extract(treeOf({ "a.js": Array.from({ length: 20 }, (_, i) => `function f${i}() {}`).join("\n") + "\n" }));
    const inside = insideOf(many, FILE, SHEET)!;
    expect(inside.rooms).toHaveLength(20);
    expect(new Set(inside.floors.map((tile) => `${tile.X}|${tile.Y}`)).size).toBe(inside.floors.length);
    const ys = [...new Set(inside.rooms.map((room) => room.Y0))];
    expect(ys.length).toBeGreaterThan(1);
  });

  test("shows calls made outside any function in a top-level room, and no such room otherwise", () => {
    const withTop = extract(treeOf({ "a.js": `const { execFileSync } = require("node:child_process");\nexecFileSync("ls");\nfunction f() {}\n` }));
    const rooms = insideOf(withTop, FILE, SHEET)!.rooms;
    expect(rooms.map((room) => room.name)).toEqual(["f", "top level"]);
    expect(rooms[1]!.objects).toHaveLength(1);
    expect(insideOf(graph, FILE, SHEET)!.rooms.some((room) => room.topLevel)).toBe(false);
  });

  test("gives a nested function a room of its own, with the calls it makes, ordered by source position", () => {
    const nested = extract(treeOf({ "a.js": `function outer() {\n  setTimeout(() => {}, 1);\n  function inner() {\n    fetch("/inner");\n  }\n}\n` }));
    const inside = insideOf(nested, FILE, SHEET)!;
    expect(inside.rooms.map((room) => room.name)).toEqual(["outer", 'outer."setTimeout() callback"', "outer.inner"]);
    expect(inside.rooms[0]!.objects.map((object) => object.sprite)).toEqual(["object-timer"]);
    expect(inside.rooms[2]!.objects.map((object) => [object.sprite, object.target])).toEqual([["object-network", '"/inner"']]);
  });

  test("draws nothing for a kind the sheet has no object for, and says so", () => {
    const sheet = new Set([...SHEET].filter((name) => name !== "object-process"));
    const inside = insideOf(graph, FILE, sheet)!;
    expect(inside.rooms.find((room) => room.name === "runGit")!.objects).toHaveLength(0);
    expect(inside.unpictured).toEqual(["process"]);
  });

  test("is undefined for something that is not a file", () => {
    expect(insideOf(graph, "function:a.js#quiet" as NodeId, SHEET)).toBeUndefined();
  });

  test("maps a kind to its object, code loaded at run time to the hatch", () => {
    expect(objectSpriteName("file system")).toBe("object-file-system");
    expect(objectSpriteName("code loaded at run time")).toBe("object-dynamic-load");
  });

  test("names rooms only close in", () => {
    expect(roomNamesAt(0.2)).toBe(false);
    expect(roomNamesAt(1.2)).toBe(true);
  });
});

describe("insideOf under a comparison", () => {
  const HEAD = `const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
function quiet() { return 1; }
function runGit() { return execFileSync("git", ["status", "-s"]); }
function load() { return fs.readFileSync("x"); }
function fresh() { return fs.writeFileSync("z", "1"); }
exports.runGit = runGit;
class Box { open() { return fs.readFileSync("y"); } }
`;
  const headGraph: Graph = extract(treeOf({ "a.js": HEAD }));
  const comparison = compare(graph, headGraph);
  const overlay = pictureOf(headGraph, comparison).overlay!;
  const marks = marksOf(comparison, overlay, FILE, "a.js");
  const inside = insideOf(headGraph, FILE, SHEET, marks)!;
  const room = (name: string) => inside.rooms.find((candidate) => candidate.name === name)!;

  test("gives a changed or new function's room the changed floor and cones, and no other", () => {
    expect(room("runGit").changed).toBe(true);
    expect(room("fresh").changed).toBe(true);
    expect(room("quiet").changed).toBe(false);
    expect(room("load").changed).toBe(false);
    const changedRooms = new Set(inside.floors.filter((tile) => tile.sprite === "floor-changed").map((tile) => tile.room));
    expect([...changedRooms].sort()).toEqual(["function:a.js#fresh", "function:a.js#runGit"]);
    expect(new Set(inside.cones.map((cone) => cone.room))).toEqual(changedRooms);
    expect(inside.cones.filter((cone) => cone.room === "function:a.js#runGit")).toHaveLength(2);
  });

  test("rings a new call and one whose arguments changed, and names its target", () => {
    const git = room("runGit").objects[0]!;
    expect(git.altered).toBe(true);
    expect(git.name).toBe("git");
    const write = room("fresh").objects[0]!;
    expect(write.altered).toBe(true);
    expect(write.name).toBe("z");
    expect(room("load").objects[0]!.altered).toBe(false);
    expect(room("load").objects[0]!.name).toBeNull();
  });

  test("rings only the call that changed when two calls share a line", () => {
    const one = extract(treeOf({ "a.js": `function f() { fetch("/a", { method: "GET" }); fetch("/b"); }\n` }));
    const two = extract(treeOf({ "a.js": `function f() { fetch("/a", { method: "POST" }); fetch("/b"); }\n` }));
    const change = compare(one, two);
    const there = insideOf(two, FILE, SHEET, marksOf(change, pictureOf(two, change).overlay!, FILE, "a.js"))!;
    expect(there.rooms[0]!.objects.map((object) => [object.target, object.altered])).toEqual([['"/a"', true], ['"/b"', false]]);
  });

  describe("calls that share a line are matched exactly, occurrence by occurrence (#125)", () => {
    /** The calls of the one function `f`, in source order, as [arguments, rung]. */
    const rung = (before: string, after: string): [string, boolean][] => {
      const one = extract(treeOf({ "a.js": `function f() { ${before} }\n` }));
      const two = extract(treeOf({ "a.js": `function f() { ${after} }\n` }));
      const change = compare(one, two);
      const there = insideOf(two, FILE, SHEET, marksOf(change, pictureOf(two, change).overlay!, FILE, "a.js"))!;
      return there.rooms[0]!.objects.map((object, index) => [`${index}`, object.altered]);
    };
    test("removing an argument rings only the call that lost it", () => {
      expect(rung('fetch("/a", opts); fetch("/a", other);', 'fetch("/a"); fetch("/a", other);')).toEqual([["0", true], ["1", false]]);
    });
    test("a call added after an identical one on the line rings only the added call", () => {
      expect(rung('fetch("/a");', 'fetch("/a"); fetch("/a", opts);')).toEqual([["0", false], ["1", true]]);
      expect(rung('fetch("/a");', 'fetch("/a", opts); fetch("/a");')).toEqual([["0", true], ["1", false]]);
    });
    test("an identical call added on the line rings the later one", () => {
      expect(rung('fetch("/a");', 'fetch("/a"); fetch("/a");')).toEqual([["0", false], ["1", true]]);
    });
    test("calls pair with their identical twin first, so the odd one out rings", () => {
      expect(rung('fetch("/a", b); fetch("/a");', 'fetch("/a"); fetch("/a");')).toEqual([["0", false], ["1", true]]);
    });
    test("an added argument still rings the call, and a call that did not change does not", () => {
      expect(rung('fetch("/a", opts); fetch("/a", other);', 'fetch("/a", opts, 1); fetch("/a", other);')).toEqual([["0", true], ["1", false]]);
      expect(rung('fetch("/a", opts); fetch("/a", other);', 'fetch("/a", opts); fetch("/a", other);')).toEqual([["0", false], ["1", false]]);
    });
  });

  test("rings but never names a call in a file that did not exist", () => {
    const added = compare(extract(treeOf({ "b.js": "x\n" })), headGraph);
    const newOverlay = pictureOf(headGraph, added).overlay!;
    const newMarks = marksOf(added, newOverlay, FILE, "a.js");
    expect(newMarks.existed).toBe(false);
    const there = insideOf(headGraph, FILE, SHEET, newMarks)!;
    const objects = there.rooms.flatMap((candidate) => candidate.objects);
    expect(objects.length).toBeGreaterThan(0);
    expect(objects.every((object) => object.altered)).toBe(true);
    expect(objects.every((object) => object.name === null)).toBe(true);
  });

  test("marks nothing without a comparison", () => {
    const plain = insideOf(headGraph, FILE, SHEET)!;
    expect(plain.cones).toHaveLength(0);
    expect(plain.floors.every((tile) => tile.sprite === "floor")).toBe(true);
    expect(plain.rooms.flatMap((candidate) => candidate.objects).every((object) => !object.altered && object.name === null)).toBe(true);
  });
});
