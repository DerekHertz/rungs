import { execFile } from "node:child_process";
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

// The index still lists files deleted from the working tree, and submodules are listed as
// directories; neither has text to read. A symlink's text is its target, as git stores it.
async function readWorkingFile(path: string): Promise<string | undefined> {
  try {
    if ((await lstat(path)).isSymbolicLink()) return await readlink(path, "utf8");
    return await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EISDIR") return undefined;
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
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
