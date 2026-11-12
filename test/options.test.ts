import { resolve } from "node:path";
import { expect, test } from "vitest";
import { parseOptions } from "../src/options.ts";

test("a bare invocation plots the current folder", () => {
  expect(parseOptions([])).toEqual({ dir: resolve("."), port: 0, open: true, base: undefined, description: undefined, link: false, relink: false, walkthrough: false, rewalk: false, narrate: false, renarrate: false, judge: false, tests: "off" });
});

test("a directory, a port and --no-open", () => {
  expect(parseOptions(["--port", "8080", "--no-open", "some/dir"])).toEqual({
    dir: resolve("some/dir"),
    port: 8080,
    open: false,
    base: undefined,
    description: undefined,
    link: false,
    relink: false,
    walkthrough: false,
    rewalk: false,
    narrate: false,
    renarrate: false, judge: false,
    tests: "off",
  });
});

test("compare takes the base first and the folder after it", () => {
  expect(parseOptions(["compare", "main"])).toEqual({ dir: resolve("."), port: 0, open: true, base: "main", description: undefined, link: false, relink: false, walkthrough: false, rewalk: false, narrate: false, renarrate: false, judge: false, tests: "off" });
  expect(parseOptions(["compare", "origin/main", "../x", "--port", "9"])).toEqual({
    dir: resolve("../x"),
    port: 9,
    open: true,
    base: "origin/main",
    description: undefined,
    link: false,
    relink: false,
    walkthrough: false,
    rewalk: false,
    narrate: false,
    renarrate: false, judge: false,
    tests: "off",
  });
});

test("compare without a base is a usage error", () => {
  expect(parseOptions(["compare"])).toBe("compare needs a base: streets compare <base> [dir]");
  expect(parseOptions(["compare", "--no-open"])).toBe("compare needs a base: streets compare <base> [dir]");
});

test("compare with too many arguments is a usage error", () => {
  expect(parseOptions(["compare", "main", "a", "b"])).toBe("expected at most one directory");
});

test("a folder named compare is reached as ./compare", () => {
  expect(parseOptions(["./compare"])).toEqual({ dir: resolve("compare"), port: 0, open: true, base: undefined, description: undefined, link: false, relink: false, walkthrough: false, rewalk: false, narrate: false, renarrate: false, judge: false, tests: "off" });
});

test("rejects a bad port and an unknown flag", () => {
  expect(parseOptions(["--port", "70000"])).toBe("invalid port: 70000");
  expect(parseOptions(["--nope"])).toMatch(/--nope/);
  expect(parseOptions(["a", "b"])).toBe("expected at most one directory");
});

test("compare takes --description with a file or - for stdin", () => {
  expect(parseOptions(["compare", "main", "--description", "pr.md"])).toMatchObject({ base: "main", description: "pr.md" });
  expect(parseOptions(["compare", "main", "--description", "-"])).toMatchObject({ description: "-" });
});

test("--description without compare is a usage error", () => {
  expect(parseOptions(["--description", "pr.md"])).toBe("--description needs compare: streets compare <base> --description <file>");
});

test("--link and --relink need compare and a description; --relink implies --link", () => {
  expect(parseOptions(["compare", "main", "--description", "pr.md", "--link"])).toMatchObject({ link: true, relink: false, walkthrough: false, rewalk: false, narrate: false, renarrate: false, judge: false, tests: "off" });
  expect(parseOptions(["compare", "main", "--description", "pr.md", "--relink"])).toMatchObject({ link: true, relink: true });
  expect(parseOptions(["compare", "main", "--link"])).toBe("--link needs a description: streets compare <base> --description <file> --link");
  // With no compare, --link serves the PR picker: a picked PR's body is the description.
  expect(parseOptions(["--link"])).toMatchObject({ link: true, base: undefined, pr: undefined, tests: "off" });
  expect(parseOptions(["compare", "main", "--relink"])).toBe("--link needs a description: streets compare <base> --description <file> --link");
});

test("--run-tests runs the head tree's tests in a sandbox; --run-tests-unsandboxed allows running without one", () => {
  expect(parseOptions(["compare", "main", "--run-tests"])).toMatchObject({ base: "main", tests: "sandboxed" });
  expect(parseOptions(["compare", "main", "--run-tests-unsandboxed"])).toMatchObject({ tests: "unsandboxed allowed" });
  expect(parseOptions(["compare", "main", "--run-tests", "--run-tests-unsandboxed"])).toMatchObject({ tests: "unsandboxed allowed" });
  // A PR picked from the list is untrusted code: the picker never runs its tests.
  expect(parseOptions(["--run-tests"])).toBe("--run-tests needs compare: streets compare <base> --run-tests (a PR picked from the list never runs tests: streets compare --pr <n> --run-tests)");
  expect(parseOptions(["--run-tests-unsandboxed"])).toMatch(/^--run-tests needs compare/);
});

test("--walkthrough and --rewalk need compare, with or without a description; --rewalk implies --walkthrough", () => {
  expect(parseOptions(["compare", "main"])).toMatchObject({ walkthrough: false, rewalk: false, narrate: false, renarrate: false, judge: false });
  expect(parseOptions(["compare", "main", "--walkthrough"])).toMatchObject({ walkthrough: true, rewalk: false, link: false });
  expect(parseOptions(["compare", "main", "--rewalk"])).toMatchObject({ walkthrough: true, rewalk: true });
  // With no compare they serve the PR picker.
  expect(parseOptions(["--walkthrough"])).toMatchObject({ walkthrough: true, base: undefined });
  expect(parseOptions(["--rewalk"])).toMatchObject({ walkthrough: true, rewalk: true });
});

test("--narrate and --renarrate need compare; --renarrate implies --narrate; neither is on by default", () => {
  expect(parseOptions(["compare", "main"])).toMatchObject({ narrate: false, renarrate: false, judge: false });
  expect(parseOptions(["compare", "main", "--narrate"])).toMatchObject({ narrate: true, renarrate: false, judge: false });
  expect(parseOptions(["compare", "main", "--renarrate"])).toMatchObject({ narrate: true, renarrate: true });
  expect(parseOptions(["--narrate"])).toBe("--narrate needs compare: streets compare <base> --narrate");
  expect(parseOptions(["--renarrate"])).toBe("--narrate needs compare: streets compare <base> --narrate");
});

test("--judge turns judged checks on, and needs compare", () => {
  expect(parseOptions(["compare", "main", "--judge"])).toMatchObject({ judge: true });
  expect(parseOptions(["compare", "main"])).toMatchObject({ judge: false });
  expect(parseOptions(["--judge"])).toMatch(/--judge needs compare/);
});
