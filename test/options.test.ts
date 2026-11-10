import { resolve } from "node:path";
import { expect, test } from "vitest";
import { parseOptions } from "../src/options.ts";

test("a bare invocation plots the current folder", () => {
  expect(parseOptions([])).toEqual({ dir: resolve("."), port: 0, open: true, base: undefined });
});

test("a directory, a port and --no-open", () => {
  expect(parseOptions(["--port", "8080", "--no-open", "some/dir"])).toEqual({
    dir: resolve("some/dir"),
    port: 8080,
    open: false,
    base: undefined,
  });
});

test("compare takes the base first and the folder after it", () => {
  expect(parseOptions(["compare", "main"])).toEqual({ dir: resolve("."), port: 0, open: true, base: "main" });
  expect(parseOptions(["compare", "origin/main", "../x", "--port", "9"])).toEqual({
    dir: resolve("../x"),
    port: 9,
    open: true,
    base: "origin/main",
  });
});

test("compare without a base is a usage error", () => {
  expect(parseOptions(["compare"])).toBe("compare needs a base: rungs compare <base> [dir]");
  expect(parseOptions(["compare", "--no-open"])).toBe("compare needs a base: rungs compare <base> [dir]");
});

test("compare with too many arguments is a usage error", () => {
  expect(parseOptions(["compare", "main", "a", "b"])).toBe("expected at most one directory");
});

test("a folder named compare is reached as ./compare", () => {
  expect(parseOptions(["./compare"])).toEqual({ dir: resolve("compare"), port: 0, open: true, base: undefined });
});

test("rejects a bad port and an unknown flag", () => {
  expect(parseOptions(["--port", "70000"])).toBe("invalid port: 70000");
  expect(parseOptions(["--nope"])).toMatch(/--nope/);
  expect(parseOptions(["a", "b"])).toBe("expected at most one directory");
});
