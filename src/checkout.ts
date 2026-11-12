import { execFile, spawn } from "node:child_process";
import { lstat, mkdtemp, readFile, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { promisify } from "node:util";
import type { FileTree } from "./graph.ts";

const execFileAsync = promisify(execFile);

/**
 * Config for every git command here. The tree may be a pull request's: its repository config can name an fsmonitor script
 * or a hooks folder that lives in the PR's own files, and neither may run.
 */
const SAFE = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

/** How a git command is run: the `-c` settings before it and the environment it gets. */
interface GitMode {
  readonly config: readonly string[];
  readonly env: () => NodeJS.ProcessEnv;
}
const COMPARE_MODE: GitMode = { config: SAFE, env: () => process.env };
/**
 * For a read that must never leave the machine or run what a repository names: nothing is fetched
 * (a promisor remote's lazy fetch is off, and no transport, `ext::` included, is allowed), on top
 * of SAFE. `readBase` does not use it: it reads a checkout of a partial clone, which needs the
 * lazy fetch.
 */
const OBJECTS_ONLY: GitMode = { config: [...SAFE, "-c", "protocol.allow=never", "-c", "protocol.ext.allow=never"], env: () => ({ ...process.env, GIT_NO_LAZY_FETCH: "1" }) };
const gitFile = (args: readonly string[], options: { cwd: string; maxBuffer: number; env?: NodeJS.ProcessEnv }, mode: GitMode = COMPARE_MODE) =>
  execFileAsync("git", [...mode.config, ...args], { ...options, env: options.env ?? mode.env(), encoding: "utf8" });

export async function readCheckout(dir: string): Promise<FileTree> {
  const listed = await listFiles(dir);
  const paths = [...new Set(listed.split("\0").filter((path) => path !== ""))].sort();
  const tree = new Map<string, string>();
  const linkedFolders = new Map<string, Promise<boolean>>();
  const isLinkedFolder = (folder: string): Promise<boolean> => {
    let linked = linkedFolders.get(folder);
    if (linked === undefined) {
      linked = isSymbolicLink(join(dir, folder));
      linkedFolders.set(folder, linked);
    }
    return linked;
  };
  for (const path of paths) {
    if (await isBehindSymbolicLink(path, isLinkedFolder)) continue;
    const text = await readWorkingFile(join(dir, path));
    if (text !== undefined) tree.set(path, text);
  }
  return tree;
}

async function listFiles(dir: string): Promise<string> {
  try {
    const args = ["ls-files", "-z", "--cached", "--others", "--exclude-standard"];
    return (await gitFile(args, { cwd: dir, maxBuffer: 1 << 30 })).stdout;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(`cannot list the files of ${dir}: ${stderr || (error as Error).message}`, {
      cause: error,
    });
  }
}

// The index still lists files deleted from the working tree or whose folder became a file, and
// submodules are listed as directories; none has text to read. A symlink's text is its target,
// as git stores it.
async function readWorkingFile(path: string): Promise<string | undefined> {
  try {
    if ((await lstat(path)).isSymbolicLink()) return await readlink(path, "utf8");
    return await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") return undefined;
    throw error;
  }
}

// Git treats an indexed file whose folder was replaced by a symlink as deleted.
async function isBehindSymbolicLink(
  path: string,
  isLinkedFolder: (folder: string) => Promise<boolean>,
): Promise<boolean> {
  const parts = path.split("/").slice(0, -1);
  for (let depth = 1; depth <= parts.length; depth++) {
    if (await isLinkedFolder(posix.join(...parts.slice(0, depth)))) return true;
  }
  return false;
}

async function isSymbolicLink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

/** The paths of `tree` that are executable files in `dir`; a symlink never is. */
export async function readExecutables(dir: string, tree: FileTree): Promise<ReadonlySet<string>> {
  const executable = new Set<string>();
  for (const path of tree.keys()) {
    try {
      const info = await lstat(join(dir, path));
      if (info.isFile() && (info.mode & 0o111) !== 0) executable.add(path);
    } catch {
      // Gone since the tree was read: nothing to mark.
    }
  }
  return executable;
}

export type BaseProblem =
  | "not-a-repository"
  | "unborn-head"
  | "unknown-ref"
  | "no-common-history"
  | "shallow-clone";

/** The base asked for can't be read: the message is one line, fit to print as is. */
export class BaseUnavailable extends Error {
  readonly reason: BaseProblem;

  constructor(reason: BaseProblem, message: string) {
    super(message);
    this.name = "BaseUnavailable";
    this.reason = reason;
  }
}

export interface Base {
  /** The merge base of HEAD and the ref: the commit GitHub diffs a pull request against. */
  readonly commit: string;
  /** What a checkout of `commit` would hold, shaped exactly as readCheckout shapes a tree. */
  readonly tree: FileTree;
  /** The paths of `tree` git records as executable (mode 100755) at `commit`: the base's own, whatever the working tree says now. */
  readonly executable: ReadonlySet<string>;
}

export async function readBase(dir: string, ref: string): Promise<Base> {
  const prefix = await prefixOf(dir);
  return readCommit(dir, await mergeBase(dir, ref), prefix);
}

/**
 * What `ref` itself holds, not the merge base `readBase` finds: the tip of a branch. For what is
 * stored once per repository rather than compared against a head. The files are read from git's
 * objects as they are stored: no checkout, so no smudge filter, attribute-driven conversion or
 * other program the repository's configuration names ever runs.
 */
export async function readRef(dir: string, ref: string): Promise<RefBase> {
  const prefix = await prefixOf(dir, OBJECTS_ONLY);
  const tip = await git(dir, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], OBJECTS_ONLY);
  if (tip === undefined) throw new BaseUnavailable("unknown-ref", `unknown base "${ref}": not a commit in ${dir}`);
  const commit = tip.trim();
  const entries = await listCommit(dir, commit, prefix, OBJECTS_ONLY);
  const blobs = await readBlobs(dir, entries.map((entry) => entry.sha));
  const tree = new Map<string, string>();
  const unavailable: { path: string; sha: string }[] = [];
  for (const entry of entries) {
    const text = blobs.get(entry.sha);
    if (text === undefined) unavailable.push({ path: entry.path, sha: entry.sha });
    else tree.set(entry.path, text);
  }
  return { commit, tree, executable: executableOf(entries, tree), unavailable };
}

/** What `readRef` read. A file whose object this clone does not hold is in `unavailable`, never in `tree`: it was not fetched, and it is not empty. */
export interface RefBase extends Base {
  readonly unavailable: readonly { readonly path: string; /** The object's name, which says which version is missing. */ readonly sha: string }[];
}

const executableOf = (entries: readonly Entry[], tree: FileTree): ReadonlySet<string> => new Set(entries.filter((entry) => entry.executable && tree.has(entry.path)).map((entry) => entry.path));

/** The text of each blob by its object name, from `git cat-file --batch`: the stored bytes, with no filter applied. A blob this clone lacks is left out, and git is not allowed to fetch it. */
async function readBlobs(dir: string, shas: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(shas)];
  const out = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn("git", [...OBJECTS_ONLY.config, "cat-file", "--batch"], { cwd: dir, env: OBJECTS_ONLY.env(), stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => (err += chunk));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`cannot read the files of ${dir}: ${err.trim() || `git exited ${code}`}`))));
    child.stdin.on("error", () => {});
    child.stdin.end(unique.map((sha) => `${sha}\n`).join(""));
  });
  const blobs = new Map<string, string>();
  let at = 0;
  for (const sha of unique) {
    const end = out.indexOf(0x0a, at);
    const header = end < 0 ? [] : out.toString("utf8", at, end).split(" ");
    if (header[0] === sha && header[1] === "missing") {
      at = end + 1;
      continue;
    }
    if (header[0] !== sha || header[1] !== "blob") throw new Error(`cannot read the files of ${dir}: git answered ${JSON.stringify(header.join(" "))} for ${sha}`);
    const size = Number(header[2]);
    blobs.set(sha, out.toString("utf8", end + 1, end + 1 + size));
    at = end + 1 + size + 1;
  }
  return blobs;
}

async function readCommit(dir: string, commit: string, prefix: string): Promise<Base> {
  const entries = await listCommit(dir, commit, prefix);
  const tree = new Map<string, string>();
  await withCheckout(dir, commit, entries, async (root) => {
    for (const entry of entries) {
      const text = await readWorkingFile(join(root, entry.full));
      if (text !== undefined) tree.set(entry.path, text);
    }
  });
  return { commit, tree, executable: executableOf(entries, tree) };
}

interface Entry {
  /** Path as readCheckout keys it: relative to the folder git was started in. */
  readonly path: string;
  /** Path from the repository root. */
  readonly full: string;
  /** Git's mode for the path is 100755. */
  readonly executable: boolean;
  /** The blob's object name. */
  readonly sha: string;
}

async function prefixOf(dir: string, mode: GitMode = COMPARE_MODE): Promise<string> {
  const prefix = await git(dir, ["rev-parse", "--show-prefix"], mode);
  if (prefix === undefined) throw new BaseUnavailable("not-a-repository", `${dir} is not a git repository`);
  return prefix.replace(/\n$/, "");
}

async function mergeBase(dir: string, ref: string): Promise<string> {
  const head = await git(dir, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (head === undefined) {
    throw new BaseUnavailable(
      "unborn-head",
      "the checkout has no commits yet, so there is no base to compare against",
    );
  }
  const tip = await git(dir, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
  const shallow = (await git(dir, ["rev-parse", "--is-shallow-repository"]))?.trim() === "true";
  if (tip === undefined) {
    const hint = shallow ? `; this clone is shallow, fetch it first: git fetch origin ${ref}` : "";
    throw new BaseUnavailable("unknown-ref", `unknown base "${ref}": not a commit in ${dir}${hint}`);
  }
  const base = (await git(dir, ["merge-base", "HEAD", tip.trim()]))?.trim();
  if (base) return base;
  if (shallow) {
    throw new BaseUnavailable(
      "shallow-clone",
      `no common ancestor of HEAD and "${ref}" in this shallow clone; run git fetch --unshallow (or --deepen=<n>)`,
    );
  }
  throw new BaseUnavailable("no-common-history", `HEAD and "${ref}" share no history`);
}

async function git(dir: string, args: string[], mode: GitMode = COMPARE_MODE): Promise<string | undefined> {
  try {
    return (await gitFile(args, { cwd: dir, maxBuffer: 1 << 30 }, mode)).stdout;
  } catch (error) {
    if (typeof (error as { code?: unknown }).code === "number") return undefined;
    throw error;
  }
}

// Submodules (mode 160000) are skipped: readCheckout finds no file text for them either.
async function listCommit(dir: string, commit: string, prefix: string, mode: GitMode = COMPARE_MODE): Promise<Entry[]> {
  let listed: string;
  try {
    const args = ["ls-tree", "-r", "-z", "--full-name", commit];
    listed = (await gitFile(args, { cwd: dir, maxBuffer: 1 << 30 }, mode)).stdout;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(`cannot list the files of ${commit} in ${dir}: ${stderr || (error as Error).message}`, {
      cause: error,
    });
  }
  const entries: Entry[] = [];
  for (const record of listed.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, sha] = record.slice(0, tab).split(" ");
    if (type !== "blob") continue;
    const full = record.slice(tab + 1);
    entries.push({ path: full.slice(prefix.length), full, executable: mode === "100755", sha: sha! });
  }
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// A checkout of the commit into a temporary folder through a temporary index, so git itself
// applies the conversions a checkout would (eol, smudge filters) and file contents never take part
// in any framing. Attributes come from the commit, not the working tree (git 2.40 and later). The
// repository's own index and working tree are untouched.
async function withCheckout(
  dir: string,
  commit: string,
  entries: readonly Entry[],
  read: (root: string) => Promise<void>,
): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), "streets-base-"));
  try {
    const top = (await gitOrFail(dir, ["rev-parse", "--show-toplevel"], commit)).replace(/\n$/, "");
    const root = join(scratch, "tree");
    const env = { ...process.env, GIT_INDEX_FILE: join(scratch, "index"), GIT_ATTR_SOURCE: commit };
    await gitOrFail(top, ["read-tree", commit], commit, env);
    const paths = entries.map((entry) => `${entry.full}\0`).join("");
    await gitOrFail(top, ["checkout-index", `--prefix=${root}/`, "-z", "--stdin"], commit, env, paths);
    await read(root);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function gitOrFail(
  dir: string,
  args: string[],
  commit: string,
  env?: NodeJS.ProcessEnv,
  input?: string,
): Promise<string> {
  try {
    const child = gitFile(args, { cwd: dir, env, maxBuffer: 1 << 30 });
    if (input !== undefined) child.child.stdin?.end(input);
    return (await child).stdout;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(`cannot read the files of ${commit} in ${dir}: ${stderr || (error as Error).message}`, {
      cause: error,
    });
  }
}
