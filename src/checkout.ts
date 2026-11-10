import { execFile } from "node:child_process";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { FileTree } from "./graph.ts";

const execFileAsync = promisify(execFile);

export async function readCheckout(dir: string): Promise<FileTree> {
  const listed = await listFiles(dir);
  const paths = [...new Set(listed.split("\0").filter((path) => path !== ""))].sort();
  const tree = new Map<string, string>();
  for (const path of paths) {
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
