import { execFile, spawn } from "node:child_process";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join, posix } from "node:path";
import { promisify } from "node:util";
import type { FileTree } from "./graph.ts";

const execFileAsync = promisify(execFile);

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
    return (await execFileAsync("git", args, { cwd: dir, maxBuffer: 1 << 30 })).stdout;
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
}

export async function readBase(dir: string, ref: string): Promise<Base> {
  const prefix = await prefixOf(dir);
  const commit = await mergeBase(dir, ref);
  const entries = await listCommit(dir, commit, prefix);
  const isLink = (entry: Entry) => entry.mode === "120000";
  const [files, links] = await Promise.all([
    readBlobs(dir, commit, entries.filter((entry) => !isLink(entry)), true),
    readBlobs(dir, commit, entries.filter(isLink), false),
  ]);
  const texts = new Map([...files, ...links]);
  const tree = new Map<string, string>();
  for (const path of [...texts.keys()].sort()) tree.set(path, texts.get(path) as string);
  return { commit, tree };
}

interface Entry {
  readonly mode: string;
  readonly blob: string;
  /** Path as readCheckout keys it: relative to the folder git was started in. */
  readonly path: string;
  /** Path from the repository root, which is how attributes are looked up. */
  readonly full: string;
}

async function prefixOf(dir: string): Promise<string> {
  const prefix = await git(dir, ["rev-parse", "--show-prefix"]);
  if (prefix === undefined) throw new BaseUnavailable("not-a-repository", `${dir} is not a git repository`);
  return prefix.trim();
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

async function git(dir: string, args: string[]): Promise<string | undefined> {
  try {
    return (await execFileAsync("git", args, { cwd: dir, maxBuffer: 1 << 30 })).stdout;
  } catch (error) {
    if (typeof (error as { code?: unknown }).code === "number") return undefined;
    throw error;
  }
}

// Submodules (mode 160000) are skipped: readCheckout finds no file text for them either.
async function listCommit(dir: string, commit: string, prefix: string): Promise<Entry[]> {
  let listed: string;
  try {
    const args = ["ls-tree", "-r", "-z", "--full-name", commit];
    listed = (await execFileAsync("git", args, { cwd: dir, maxBuffer: 1 << 30 })).stdout;
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
    const [mode, type, blob] = record.slice(0, tab).split(" ") as [string, string, string];
    if (type !== "blob") continue;
    const full = record.slice(tab + 1);
    entries.push({ mode, blob, path: full.slice(prefix.length), full });
  }
  return entries;
}

// One `git cat-file --batch` process answers every request. With --filters git converts each blob
// the way a checkout would (eol, smudge filters) but still reports the unconverted size, so the
// reply is framed by the next header, which starts with the next blob's id, never by that size.
// Attributes come from the commit being read, not from the working tree (git 2.40 and later).
async function readBlobs(
  dir: string,
  commit: string,
  entries: readonly Entry[],
  filters: boolean,
): Promise<Map<string, string>> {
  if (entries.length === 0) return new Map();
  const args = ["cat-file", "--batch", "-Z", ...(filters ? ["--filters"] : [])];
  const child = spawn("git", args, {
    cwd: dir,
    env: { ...process.env, GIT_ATTR_SOURCE: commit },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
  const closed = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  child.stdin.on("error", () => {});
  child.stdin.end(entries.map((entry) => `${filters ? `${entry.blob} ${entry.full}` : entry.blob}\0`).join(""));
  const code = await closed;
  if (code !== 0) {
    const stderr = Buffer.concat(err).toString("utf8").trim();
    throw new Error(`cannot read the files of ${commit} in ${dir}: ${stderr || `git exited ${code}`}`);
  }
  return framed(Buffer.concat(out), entries, commit);
}

function framed(output: Buffer, entries: readonly Entry[], commit: string): Map<string, string> {
  const texts = new Map<string, string>();
  let at = 0;
  for (const [index, entry] of entries.entries()) {
    const header = Buffer.from(`${entry.blob} blob `);
    const headerEnd = output.indexOf(0, at);
    const next = entries[index + 1];
    const start = headerEnd + 1;
    const end =
      next === undefined ? output.length - 1 : output.indexOf(Buffer.from(`\0${next.blob} blob `), start);
    const inOrder = headerEnd >= 0 && output.subarray(at, at + header.length).equals(header) && end >= start;
    if (!inOrder) throw new Error(`cannot read the files of ${commit}: git answered out of order`);
    texts.set(entry.path, output.toString("utf8", start, end));
    at = end + 1;
  }
  return texts;
}
