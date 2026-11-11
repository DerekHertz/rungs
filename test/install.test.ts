import { expect, test } from "vitest";
import { installArgv, installFiles } from "../src/observed.ts";

const SHA512 = `sha512-${"A".repeat(86)}==`;
const tarball = (name: string, version = "1.0.0") => `https://registry.npmjs.org/${name}/-/${name.split("/").at(-1)}-${version}.tgz`;
const entry = (name: string, extra: object = {}) => ({ version: "1.0.0", resolved: tarball(name), integrity: SHA512, ...extra });

function tree(manifest: object, packages: object, lock: object = {}): Map<string, string> {
  return new Map([
    ["package.json", JSON.stringify({ name: "probe", version: "1.0.0", scripts: { test: "node --test", preinstall: "./payload.sh" }, ...manifest })],
    ["package-lock.json", JSON.stringify({ name: "probe", version: "1.0.0", lockfileVersion: 3, requires: true, packages, ...lock })],
    [".npmrc", "git=/work/payload.sh\n"],
    ["payload.sh", "#!/bin/sh\n"],
    ["node_modules/dep/index.js", "planted\n"],
  ]);
}

const refusal = (manifest: object, packages: object, lock: object = {}) => {
  const result = installFiles(tree(manifest, packages, lock));
  return "refused" in result ? result.refused : result;
};

test("the install is given two files Rungs wrote itself: the dependencies asked for and the lockfile's registry entries", () => {
  const result = installFiles(
    tree(
      { dependencies: { dep: "^1.0.0", other: "npm:@scope/real@~2.1" }, devDependencies: { tool: "latest" }, workspaces: ["packages/*"], config: { x: 1 } },
      {
        "": { name: "probe", version: "1.0.0", dependencies: { dep: "^1.0.0", other: "npm:@scope/real@~2.1" }, devDependencies: { tool: "latest" } },
        "node_modules/dep": entry("dep", { dependencies: { inner: ">=1 <3 || 4.x" }, hasInstallScript: true, surprise: "git+ssh://x" }),
        "node_modules/dep/node_modules/inner": entry("inner", { dev: true }),
        "node_modules/other": entry("@scope/real", { name: "@scope/real", bundleDependencies: ["packed"] }),
        "node_modules/other/node_modules/packed": { version: "1.0.0", inBundle: true },
        "node_modules/tool": entry("tool", { dev: true, bin: { tool: "cli.js" } }),
      },
      { dependencies: { dep: { version: "git+ssh://git@example.com/a/b.git" } } },
    ),
  );
  if ("refused" in result) throw new Error(result.refused);
  expect([...result.files.keys()]).toEqual(["package.json", "package-lock.json"]);
  expect(JSON.parse(result.files.get("package.json") ?? "")).toEqual({
    name: "probe",
    version: "1.0.0",
    dependencies: { dep: "^1.0.0", other: "npm:@scope/real@~2.1" },
    devDependencies: { tool: "latest" },
  });
  const lock = JSON.parse(result.files.get("package-lock.json") ?? "");
  expect(Object.keys(lock)).toEqual(["name", "version", "lockfileVersion", "requires", "packages"]);
  expect(lock.lockfileVersion).toBe(3);
  expect(lock.packages["node_modules/dep"]).toEqual(entry("dep", { dependencies: { inner: ">=1 <3 || 4.x" }, hasInstallScript: true }));
  expect(lock.packages["node_modules/other/node_modules/packed"]).toEqual({ version: "1.0.0", inBundle: true });
  expect(lock.packages["node_modules/tool"]).toEqual(entry("tool", { dev: true, bin: { tool: "cli.js" } }));
});

test("a lockfile entry that is not a registry tarball with a sha512 hash is refused, and the refusal names it", () => {
  const git = "git+ssh://git@github.com/a/b.git#0123456789abcdef0123456789abcdef01234567";
  const dep = { dependencies: { dep: "1.0.0" } };
  const root = { "": { name: "probe", version: "1.0.0", ...dep } };
  const cases: [string, object, object, string][] = [
    ["git", dep, { ...root, "node_modules/dep": { version: "1.0.0", resolved: git } }, `package-lock.json: node_modules/dep is a git dependency (${JSON.stringify(git)})`],
    ["git with a hash", dep, { ...root, "node_modules/dep": { version: "1.0.0", resolved: git, integrity: SHA512 } }, `package-lock.json: node_modules/dep is a git dependency (${JSON.stringify(git)})`],
    ["file", dep, { ...root, "node_modules/dep": { version: "1.0.0", resolved: "file:../dep.tgz", integrity: SHA512 } }, 'package-lock.json: node_modules/dep is a file dependency ("file:../dep.tgz")'],
    ["link", dep, { ...root, "node_modules/dep": { resolved: "dep", link: true } }, "package-lock.json: node_modules/dep is a link to a folder"],
    ["folder", dep, { ...root, dep: { version: "1.0.0" }, "node_modules/dep": entry("dep") }, 'package-lock.json: "dep" is a folder in the tree, not a package in node_modules'],
    ["climbing", dep, { ...root, "node_modules/../../dep": entry("dep") }, 'package-lock.json: "node_modules/../../dep" is a folder in the tree, not a package in node_modules'],
    ["remote", dep, { ...root, "node_modules/dep": entry("dep", { resolved: "https://example.com/dep-1.0.0.tgz" }) }, 'package-lock.json: node_modules/dep comes from outside the registry ("https://example.com/dep-1.0.0.tgz")'],
    ["lookalike host", dep, { ...root, "node_modules/dep": entry("dep", { resolved: "https://registry.npmjs.org.example.com/dep/-/dep-1.0.0.tgz" }) }, 'package-lock.json: node_modules/dep comes from outside the registry ("https://registry.npmjs.org.example.com/dep/-/dep-1.0.0.tgz")'],
    ["user in host", dep, { ...root, "node_modules/dep": entry("dep", { resolved: "https://registry.npmjs.org@example.com/dep/-/dep-1.0.0.tgz" }) }, 'package-lock.json: node_modules/dep comes from outside the registry ("https://registry.npmjs.org@example.com/dep/-/dep-1.0.0.tgz")'],
    ["http", dep, { ...root, "node_modules/dep": entry("dep", { resolved: "http://registry.npmjs.org/dep/-/dep-1.0.0.tgz" }) }, 'package-lock.json: node_modules/dep comes from outside the registry ("http://registry.npmjs.org/dep/-/dep-1.0.0.tgz")'],
    ["no address", dep, { ...root, "node_modules/dep": { version: "1.0.0", integrity: SHA512 } }, "package-lock.json: node_modules/dep has no registry address"],
    ["no hash", dep, { ...root, "node_modules/dep": { version: "1.0.0", resolved: tarball("dep") } }, "package-lock.json: node_modules/dep has no sha512 integrity hash"],
    ["weak hash", dep, { ...root, "node_modules/dep": entry("dep", { integrity: "sha1-2jmj7l5rSw0yVb/vlWAYkK/YBwk=" }) }, "package-lock.json: node_modules/dep has no sha512 integrity hash"],
    ["bundled with an address", dep, { ...root, "node_modules/dep": { version: "1.0.0", inBundle: true, resolved: git } }, `package-lock.json: node_modules/dep is a git dependency (${JSON.stringify(git)})`],
    ["odd version", dep, { ...root, "node_modules/dep": entry("dep", { version: git }) }, "package-lock.json: node_modules/dep has no plain version"],
    // npm fetches whatever a dependency asks for when the entry beside it does not satisfy it.
    ["asked for from git, in the lockfile", dep, { ...root, "node_modules/dep": entry("dep", { dependencies: { inner: git } }), "node_modules/inner": entry("inner") }, `package-lock.json: node_modules/dep asks for "inner" from ${JSON.stringify(git)}, which is not a registry version`],
    ["asked for from GitHub, optional", dep, { ...root, "node_modules/dep": entry("dep", { optionalDependencies: { inner: "user/repo" } }) }, 'package-lock.json: node_modules/dep asks for "inner" from "user/repo", which is not a registry version'],
    ["asked for from a folder, in the root entry", dep, { "": { name: "probe", dependencies: { dep: "file:dep" } }, "node_modules/dep": entry("dep") }, 'package-lock.json: the root asks for "dep" from "file:dep", which is not a registry version'],
    ["asked for from git, in package.json", { dependencies: { dep: git } }, { ...root, "node_modules/dep": entry("dep") }, `package.json asks for "dep" from ${JSON.stringify(git)}, which is not a registry version`],
    ["asked for from a URL, in devDependencies", { devDependencies: { dep: "https://example.com/dep.tgz" } }, { ...root, "node_modules/dep": entry("dep") }, 'package.json asks for "dep" from "https://example.com/dep.tgz", which is not a registry version'],
    ["an alias of git", { dependencies: { dep: "npm:dep@git+ssh://x" } }, { ...root, "node_modules/dep": entry("dep") }, 'package.json asks for "dep" from "npm:dep@git+ssh://x", which is not a registry version'],
    ["override from git", { ...dep, overrides: { dep: { inner: git } } }, { ...root, "node_modules/dep": entry("dep") }, `package.json asks for "inner" from ${JSON.stringify(git)}, which is not a registry version`],
    ["override selector", { ...dep, overrides: { "dep@github:a/b": "1.0.0" } }, { ...root, "node_modules/dep": entry("dep") }, 'package.json asks for "dep" from "github:a/b", which is not a registry version'],
  ];
  for (const [name, manifest, packages, expected] of cases) expect([name, refusal(manifest, packages)]).toEqual([name, expected]);
});

test("a lockfile Rungs cannot read entry by entry is refused", () => {
  const dep = { dependencies: { dep: "1.0.0" } };
  expect(refusal(dep, { "node_modules/dep": entry("dep") }, { lockfileVersion: 1 })).toBe("package-lock.json has lockfileVersion 1; Rungs installs only from versions 2 and 3");
  expect(refusal(dep, [])).toBe("package-lock.json lists no packages");
  expect(refusal(dep, { "node_modules/dep": "git+ssh://x" })).toBe("package-lock.json: node_modules/dep is not an entry");
  expect(refusal({ dependencies: ["dep"] }, {})).toBe("package.json's dependencies are not a table of names and versions");
  expect(refusal({ dependencies: { dep: 1 } }, {})).toBe('package.json asks for "dep" from 1, which is not a registry version');
  const broken = tree(dep, {});
  broken.set("package-lock.json", "{ not json");
  expect(installFiles(broken)).toEqual({ refused: "package-lock.json is not valid JSON" });
  const long = `git+ssh://${"x".repeat(500)}`;
  const told = refusal(dep, { "node_modules/dep": { version: "1.0.0", resolved: long } });
  expect(typeof told === "string" && told.length).toBeLessThan(250);
});

test("npm-shrinkwrap.json is the lockfile when the tree has one, as it is for npm", () => {
  const files = tree({}, { "node_modules/dep": { version: "1.0.0", resolved: "git+ssh://x" } });
  files.set("npm-shrinkwrap.json", files.get("package-lock.json")?.replace("git+ssh://x", "git+ssh://y") ?? "");
  expect(installFiles(files)).toEqual({ refused: 'npm-shrinkwrap.json: node_modules/dep is a git dependency ("git+ssh://y")' });
});

test("npm is told every setting that could name a program or a place, and to read none from files", () => {
  const places = { work: "/work", out: "/out", tools: "/rungs/tools", install: "/install", report: "/dev/fd/3", node: "/rungs/bin/node", npm: "/rungs/npm/bin/npm-cli.js" };
  expect(installArgv(places, "https://registry.npmjs.org/")).toEqual([
    "/rungs/bin/node",
    "/rungs/npm/bin/npm-cli.js",
    "ci",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--userconfig=/rungs/tools/npmrc-user",
    "--globalconfig=/rungs/tools/npmrc-global",
    "--registry=https://registry.npmjs.org/",
    "--git=/usr/bin/false",
    "--shell=/usr/bin/false",
    "--script-shell=/usr/bin/false",
  ]);
});

// An alias installs a registry package under another name. Its tarball is a lockfile entry like any
// other, so the gate lets an alias through exactly when what it names is the registry.
test('an npm alias such as "x": "npm:other@1" is let through: it is another registry package, and its lockfile entry is still checked', () => {
  const manifest = { dependencies: { x: "npm:other@1", scoped: "npm:@scope/pkg@^1.2.3", bare: "npm:plain" } };
  const packages = {
    "": { name: "probe", version: "1.0.0", dependencies: manifest.dependencies },
    "node_modules/x": entry("other", { name: "other" }),
    "node_modules/scoped": entry("@scope/pkg", { name: "@scope/pkg" }),
    "node_modules/bare": entry("plain", { name: "plain" }),
  };
  const result = installFiles(tree(manifest, packages));
  if ("refused" in result) throw new Error(result.refused);
  expect(JSON.parse(result.files.get("package.json") ?? "").dependencies).toEqual(manifest.dependencies);
  expect(JSON.parse(result.files.get("package-lock.json") ?? "").packages["node_modules/x"]).toEqual(entry("other", { name: "other" }));
});

test("an alias cannot name anything but a registry package", () => {
  const git = "git+ssh://git@github.com/a/b.git#0123456789abcdef0123456789abcdef01234567";
  const root = (dependencies: object) => ({ "": { name: "probe", version: "1.0.0", dependencies }, "node_modules/x": entry("other") });
  const cases: [string, string][] = [
    ["a git url", `npm:other@${git}`],
    ["a GitHub shorthand", "npm:other@github:a/b"],
    ["a URL", "npm:other@https://example.com/other.tgz"],
    ["a folder", "npm:other@file:../other"],
    ["a path in place of a name", "npm:./other"],
    ["an alias of an alias", "npm:other@npm:inner@1"],
    ["a scheme in place of npm", "git:other@1"],
  ];
  for (const [name, spec] of cases) {
    expect([name, refusal({ dependencies: { x: spec } }, root({ x: spec }))]).toEqual([name, `package.json asks for "x" from ${JSON.stringify(spec)}, which is not a registry version`]);
  }
  // The lockfile entry under an alias is held to the same rule as any other.
  const manifest = { dependencies: { x: "npm:other@1" } };
  expect(refusal(manifest, { ...root(manifest.dependencies), "node_modules/x": entry("other", { resolved: git }) })).toBe(`package-lock.json: node_modules/x is a git dependency (${JSON.stringify(git)})`);
  expect(refusal(manifest, { ...root(manifest.dependencies), "node_modules/x": entry("other", { dependencies: { inner: "npm:inner@github:a/b" } }) })).toBe(
    'package-lock.json: node_modules/x asks for "inner" from "npm:inner@github:a/b", which is not a registry version',
  );
});
