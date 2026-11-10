import { describe, expect, test } from "vitest";
import { hullOf, occluders, visibleNames } from "../src/screen.ts";
import type { Box, Name, Projected } from "../src/screen.ts";

const VIEWPORT: Box = { x: 0, y: 0, w: 1000, h: 700 };

function name(id: string, at: Partial<Box>, weight: number, region = Infinity): Name {
  return { id, box: { x: 100, y: 100, w: 80, h: 20, ...at }, weight, region };
}

describe("visibleNames", () => {
  test("keeps every name when none touch", () => {
    const names = [name("a", { x: 0 }, 1), name("b", { x: 200 }, 2), name("c", { y: 300 }, 3)];
    expect([...visibleNames(names, VIEWPORT)].sort()).toEqual(["a", "b", "c"]);
  });

  test("hides the smaller region's name where two overlap, whatever the order", () => {
    const big = name("big", { x: 100 }, 900);
    const small = name("small", { x: 140 }, 40);
    expect([...visibleNames([big, small], VIEWPORT)]).toEqual(["big"]);
    expect([...visibleNames([small, big], VIEWPORT)]).toEqual(["big"]);
  });

  test("keeps a smaller name that only touches a name that was itself hidden", () => {
    const winner = name("winner", { x: 100 }, 100);
    const middle = name("middle", { x: 170 }, 50);
    const far = name("far", { x: 240 }, 10);
    expect([...visibleNames([winner, middle, far], VIEWPORT)].sort()).toEqual(["far", "winner"]);
  });

  test("keeps a gap between names, so pills never touch", () => {
    const left = name("left", { x: 100, w: 80 }, 2);
    const right = name("right", { x: 182, w: 80 }, 1);
    expect([...visibleNames([left, right], VIEWPORT)]).toEqual(["left"]);
    expect([...visibleNames([left, { ...right, box: { ...right.box, x: 190 } }], VIEWPORT)].sort()).toEqual(["left", "right"]);
  });

  test("breaks a tie by the order given", () => {
    const first = name("first", { x: 100 }, 5);
    const second = name("second", { x: 110 }, 5);
    expect([...visibleNames([first, second], VIEWPORT)]).toEqual(["first"]);
  });

  test("drops a name much wider than its region on screen, and keeps one that fits", () => {
    const tiny = name("tiny", { w: 120 }, 1, 20);
    const roomy = name("roomy", { x: 400, w: 120 }, 1, 100);
    expect([...visibleNames([tiny, roomy], VIEWPORT)]).toEqual(["roomy"]);
  });

  test("lets a name that was dropped for its width stop hiding others", () => {
    const wide = name("wide", { w: 200 }, 100, 10);
    const near = name("near", { x: 150 }, 1);
    expect([...visibleNames([wide, near], VIEWPORT)]).toEqual(["near"]);
  });

  test("hides a name outside the viewport, and keeps one half inside", () => {
    const off = name("off", { x: 1100 }, 1);
    const edge = name("edge", { x: 960 }, 1);
    expect([...visibleNames([off, edge], VIEWPORT)]).toEqual(["edge"]);
  });

  test("a name with no region to fit, such as a file's, beats any district's", () => {
    const district = name("district", { x: 100 }, 1_000_000, 500);
    const file = name("file", { x: 120 }, Infinity);
    expect([...visibleNames([district, file], VIEWPORT)]).toEqual(["file"]);
  });
});

function square(x: number, y: number, size: number): Box {
  return { x, y, w: size, h: size };
}

function corners(box: Box): Projected["corners"] {
  return [
    { x: box.x, y: box.y },
    { x: box.x + box.w, y: box.y },
    { x: box.x + box.w, y: box.y + box.h },
    { x: box.x, y: box.y + box.h },
  ];
}

function projected(id: string, box: Box, depth: number): Projected {
  return { id, corners: corners(box), depth };
}

describe("occluders", () => {
  const target = projected("target", square(100, 100, 100), 50);

  test("names the buildings nearer the camera that overlap the target on screen", () => {
    const front = projected("front", square(150, 150, 100), 20);
    expect(occluders(target, [front])).toEqual(["front"]);
  });

  test("leaves alone a building that is behind, however much it overlaps", () => {
    const behind = projected("behind", square(150, 150, 100), 80);
    expect(occluders(target, [behind])).toEqual([]);
  });

  test("leaves alone a building at the same depth", () => {
    expect(occluders(target, [projected("level", square(150, 150, 100), 50)])).toEqual([]);
  });

  test("leaves alone a nearer building that is elsewhere on screen", () => {
    expect(occluders(target, [projected("away", square(400, 400, 100), 10)])).toEqual([]);
  });

  test("ignores a nearer building that only touches the target's edge", () => {
    const touching = projected("touching", square(200, 100, 100), 10);
    const grazing = projected("grazing", square(199, 100, 100), 10);
    expect(occluders(target, [touching, grazing])).toEqual([]);
  });

  test("counts an overlap of more than a few pixels", () => {
    expect(occluders(target, [projected("over", square(190, 100, 100), 10)])).toEqual(["over"]);
  });

  test("never names the target itself", () => {
    expect(occluders(target, [target])).toEqual([]);
  });

  test("tests the true outline, not its bounding box: a corner that leaves a gap does not overlap", () => {
    const diamond: Projected = {
      id: "diamond",
      corners: [
        { x: 300, y: 100 },
        { x: 400, y: 200 },
        { x: 300, y: 300 },
        { x: 200, y: 200 },
      ],
      depth: 10,
    };
    const corner = projected("corner", square(200, 100, 40), 50);
    expect(occluders(corner, [diamond])).toEqual([]);
    const inside = projected("inside", square(250, 150, 100), 50);
    expect(occluders(inside, [diamond])).toEqual(["diamond"]);
  });

  test("keeps the order the buildings were given in", () => {
    const a = projected("a", square(120, 120, 50), 10);
    const b = projected("b", square(160, 160, 50), 30);
    expect(occluders(target, [b, a])).toEqual(["b", "a"]);
  });
});

describe("hullOf", () => {
  test("is the convex outline of the points, without the ones inside", () => {
    const hull = hullOf([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 5, y: 5 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]);
    expect(hull).toHaveLength(4);
    expect(hull).not.toContainEqual({ x: 5, y: 5 });
  });
});
