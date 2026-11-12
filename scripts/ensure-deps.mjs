// Runs `npm ci` when node_modules is missing or was installed from another package-lock.json, so a
// fresh worktree gets its dependencies before the first test, lint or typecheck. Plain Node only:
// it must run before any dependency exists.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const read = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
};
const lock = read("package-lock.json");
const installed = read("node_modules/.package-lock.json");
const wanted = Object.entries(lock?.packages ?? {}).filter(([path]) => path.startsWith("node_modules/"));
// An optional package (another platform's binary) is legitimately absent.
const stale = installed === undefined || wanted.some(([path, entry]) => {
  const got = installed.packages?.[path];
  return got === undefined ? entry.optional !== true : got.version !== entry.version;
});
if (stale) {
  console.error("ensure-deps: node_modules does not match package-lock.json; running npm ci");
  execSync("npm ci", { stdio: "inherit" });
}
