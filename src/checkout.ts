import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { FileTree } from "./graph.ts";

const execFileAsync = promisify(execFile);

export async function readCheckout(dir: string): Promise<FileTree> {
  const { stdout } = await execFileAsync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: dir, maxBuffer: 1 << 30 },
  );
  const paths = [...new Set(stdout.split("\0").filter((path) => path !== ""))].sort();
  const tree = new Map<string, string>();
  for (const path of paths) {
    const text = await readWorkingFile(join(dir, path));
    if (text !== undefined) tree.set(path, text);
  }
  return tree;
}

// The index still lists files deleted from the working tree, and submodules are listed as
// directories; neither has text to read.
async function readWorkingFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EISDIR") return undefined;
    throw error;
  }
}
