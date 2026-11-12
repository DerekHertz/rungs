// Runs `npm ci` when node_modules doesn't hold what package-lock.json asks for, so a fresh worktree
// gets its dependencies before the first test, lint or typecheck. Plain Node only: it must run
// before any dependency exists.
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const read = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
};

/** Whether a lock entry's package can install here: an `os` or `cpu` list that excludes this platform means it is skipped by npm. */
const fitsHere = (entry) => {
  const allows = (list, value) => list === undefined || list.some((item) => (item.startsWith("!") ? item.slice(1) !== value : item === value));
  return allows(entry.os, process.platform) && allows(entry.cpu, process.arch);
};

/** Why node_modules does not match the lockfile, or undefined when it does. */
function mismatch() {
  const lock = read("package-lock.json");
  const installed = read("node_modules/.package-lock.json");
  if (lock === undefined) return undefined;
  if (installed === undefined) return "no node_modules";
  const wanted = Object.entries(lock.packages ?? {}).filter(([path]) => path.startsWith("node_modules/"));
  const wantedPaths = new Set(wanted.map(([path]) => path));
  for (const [path, entry] of wanted) {
    const got = installed.packages?.[path];
    // Only a package npm would skip on this platform may be absent.
    if (got === undefined || !existsSync(`${path}/package.json`)) {
      if (entry.optional === true && !fitsHere(entry)) continue;
      return `${path} is missing`;
    }
    if (got.version !== entry.version || got.resolved !== entry.resolved || got.integrity !== entry.integrity) return `${path} differs from the lockfile`;
  }
  for (const path of Object.keys(installed.packages ?? {})) {
    if (path.startsWith("node_modules/") && !wantedPaths.has(path)) return `${path} is no longer in the lockfile`;
  }
  return undefined;
}

const why = mismatch();
if (why !== undefined) {
  console.error(`ensure-deps: ${why}; running npm ci`);
  execSync("npm ci", { stdio: "inherit" });
}
