import { execFile, spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, normalize } from "node:path";
import { promisify } from "node:util";
import type { FileTree } from "./graph.ts";

const execFileAsync = promisify(execFile);

/**
 * How a run is kept from the machine. `bwrap` (bubblewrap) runs it in new user, pid, mount and
 * network namespaces whose root holds only the system's programs, node, and the copy: the user's
 * files, sockets and network are not there to reach. `unsandboxed` only copies the tree and strips
 * the environment, so the run can reach anything the user can.
 */
export type Isolation = { readonly kind: "bwrap"; readonly path: string } | { readonly kind: "unsandboxed" };

export type Sandbox = Extract<Isolation, { kind: "bwrap" }> | { readonly kind: "none"; readonly why: string };

/** Where a step finds things, as the run sees them. */
export interface Places {
  /** The copy of the tree, and every step's working folder. */
  readonly work: string;
  /** A writable folder whose files are collected after the run. */
  readonly out: string;
  /** Files `tools` gave the run, read-only. */
  readonly tools: string;
  readonly node: string;
  /** npm's command-line script, run with `node`. */
  readonly npm: string;
}

export interface Step {
  readonly argv: readonly string[];
  /** Only an install step should get the network; the run's own code never should. */
  readonly network: boolean;
}

export interface StepResult {
  /** Null when the step was killed. */
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly ms: number;
  /** Standard output and error as they arrived, cut at the run's output limit. */
  readonly output: string;
  readonly truncated: boolean;
}

export type Collected =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "too large"; readonly bytes: number }
  | { readonly kind: "missing" };

export interface Run {
  /** The steps that ran: each one after the first ran because the one before exited 0 in time. */
  readonly steps: readonly StepResult[];
  readonly collected: ReadonlyMap<string, Collected>;
  /** Where the copy was; it is gone once the run returns. */
  readonly root: string;
}

export interface RunRequest {
  readonly tree: FileTree;
  readonly isolation: Isolation;
  readonly steps: (places: Places) => readonly Step[];
  /** Files given to the steps at `places.tools`. */
  readonly tools?: FileTree;
  /** Names of files in `places.out` to read back. */
  readonly collect?: readonly string[];
  /** One wall-clock limit for all the steps together. */
  readonly timeoutMs: number;
  readonly outputBytes: number;
  readonly collectBytes?: number;
}

/** The only variables a run sees; nothing of the user's environment is passed on. */
const ENV = { HOME: "/tmp/home", TMPDIR: "/tmp", LANG: "C.UTF-8", CI: "1", NO_COLOR: "1" };
const INSIDE: Places = {
  work: "/work",
  out: "/out",
  tools: "/rungs/tools",
  node: "/rungs/bin/node",
  npm: "/rungs/npm/bin/npm-cli.js",
};
const SYSTEM = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64"];
const ETC = ["passwd", "group", "hosts", "nsswitch.conf", "resolv.conf", "ssl", "ca-certificates", "localtime"];

/** Bubblewrap on PATH, if it can start a namespace here; else why not. */
export async function detectSandbox(env: NodeJS.ProcessEnv = process.env): Promise<Sandbox> {
  const path = (env.PATH ?? "").split(delimiter).map((dir) => join(dir, "bwrap")).find((file) => file.startsWith("/") && existsSync(file));
  if (path === undefined) return { kind: "none", why: "bwrap is not on PATH" };
  try {
    await execFileAsync(path, ["--unshare-all", "--die-with-parent", "--ro-bind", "/", "/", "true"], { timeout: 10_000 });
    return { kind: "bwrap", path };
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    return { kind: "none", why: `bwrap cannot create namespaces here: ${stderr || (error as Error).message}` };
  }
}

/** The sandbox to run in, or why the run is refused. A person may choose to run without one. */
export function chooseIsolation(sandbox: Sandbox, allowUnsandboxed: boolean): { isolation: Isolation } | { refused: string } {
  if (sandbox.kind === "bwrap") return { isolation: sandbox };
  if (allowUnsandboxed) return { isolation: { kind: "unsandboxed" } };
  return { refused: `no sandbox to run the tests in (${sandbox.why}); --run-tests-unsandboxed runs them anyway` };
}

/**
 * Writes `tree` to a fresh temporary folder, runs the steps there one after another under
 * `isolation` with a stripped environment, and removes the folder whatever happens. A step runs
 * only when the one before it exited 0 within the time left.
 */
export async function runIsolated(request: RunRequest): Promise<Run> {
  for (const path of request.tree.keys()) {
    const normal = normalize(path);
    if (isAbsolute(path) || normal === ".." || normal.startsWith("../")) {
      throw new Error(`the tree holds a path outside itself: ${JSON.stringify(path)}`);
    }
  }
  const root = await mkdtemp(join(tmpdir(), "rungs-run-"));
  let child: ReturnType<typeof spawn> | undefined;
  const interrupted = (signal: NodeJS.Signals) => {
    if (child?.pid !== undefined) killTree(child.pid);
    removeSync(root);
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", interrupted).once("SIGTERM", interrupted);
  try {
    const host = { work: join(root, "work"), out: join(root, "out"), tools: join(root, "tools") };
    await writeTree(host.work, request.tree);
    await writeTree(host.tools, request.tools ?? new Map());
    for (const dir of [host.out, join(root, "home"), join(root, "tmp")]) await mkdir(dir);
    const node = process.execPath;
    const npm = join(dirname(node), "..", "lib", "node_modules", "npm");
    const { isolation } = request;
    const places: Places = isolation.kind === "bwrap" ? INSIDE : { ...host, node, npm: join(npm, "bin", "npm-cli.js") };
    const steps = request.steps(places);
    const deadline = Date.now() + request.timeoutMs;
    const results: StepResult[] = [];
    for (const step of steps) {
      const argv = isolation.kind === "bwrap" ? [isolation.path, ...bwrapArgs(host, node, npm, step.network), "--", ...step.argv] : [...step.argv];
      const result = await runStep(argv, host.work, deadline, request.outputBytes, isolation, (spawned) => {
        child = spawned;
      });
      results.push(result);
      if (result.exitCode !== 0 || result.timedOut) break;
    }
    const collected = new Map<string, Collected>();
    for (const name of request.collect ?? []) collected.set(name, await collectFile(join(host.out, name), request.collectBytes ?? 64 << 20));
    return { steps: results, collected, root };
  } finally {
    process.off("SIGINT", interrupted).off("SIGTERM", interrupted);
    await remove(root);
  }
}

function bwrapArgs(host: { work: string; out: string; tools: string }, node: string, npm: string, network: boolean): string[] {
  const args = ["--unshare-all", "--die-with-parent", "--new-session", "--clearenv"];
  if (network) args.push("--share-net");
  for (const dir of SYSTEM) args.push("--ro-bind-try", dir, dir);
  for (const name of ETC) args.push("--ro-bind-try", `/etc/${name}`, `/etc/${name}`);
  args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", ENV.HOME);
  args.push("--ro-bind", node, INSIDE.node, "--ro-bind-try", npm, dirname(dirname(INSIDE.npm)));
  args.push("--ro-bind", host.tools, INSIDE.tools, "--bind", host.work, INSIDE.work, "--bind", host.out, INSIDE.out);
  args.push("--chdir", INSIDE.work);
  for (const [name, value] of Object.entries({ ...ENV, PATH: `${dirname(INSIDE.node)}:/usr/bin:/bin` })) args.push("--setenv", name, value);
  return args;
}

function runStep(
  argv: readonly string[],
  cwd: string,
  deadline: number,
  limit: number,
  isolation: Isolation,
  started: (child: ReturnType<typeof spawn>) => void,
): Promise<StepResult> {
  const [command, ...args] = argv;
  if (command === undefined) throw new Error("a step has no command");
  const begun = Date.now();
  const env = isolation.kind === "bwrap" ? {} : { ...ENV, HOME: join(cwd, "..", "home"), TMPDIR: join(cwd, "..", "tmp"), PATH: `${dirname(process.execPath)}:/usr/bin:/bin` };
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    started(child);
    const chunks: Buffer[] = [];
    let kept = 0;
    let truncated = false;
    const take = (chunk: Buffer) => {
      const room = limit - kept;
      if (chunk.length > room) truncated = true;
      if (room <= 0) return;
      const part = chunk.subarray(0, room);
      chunks.push(part);
      kept += part.length;
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) killTree(child.pid);
    }, Math.max(0, deadline - Date.now()));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: timedOut ? null : code,
        timedOut,
        ms: Date.now() - begun,
        output: Buffer.concat(chunks).toString("utf8"),
        truncated,
      });
    });
  });
}

// The step leads its own process group. Under bwrap that group is bwrap alone, and its death
// kills the namespace's first process (--die-with-parent), and with it every process inside.
function killTree(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

async function writeTree(dir: string, tree: FileTree): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const [path, text] of tree) {
    const file = join(dir, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);
  }
}

async function collectFile(path: string, limit: number): Promise<Collected> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return { kind: "missing" };
    if (info.size > limit) return { kind: "too large", bytes: info.size };
    return { kind: "text", text: await readFile(path, "utf8") };
  } catch {
    return { kind: "missing" };
  }
}

// The run may have left folders it can't be removed from; give every folder back its owner's rights first.
async function remove(root: string): Promise<void> {
  try {
    await rm(root, { recursive: true, force: true });
  } catch {
    await unlock(root);
    await rm(root, { recursive: true, force: true });
  }
}

async function unlock(dir: string): Promise<void> {
  await chmod(dir, 0o700);
  for (const entry of await readdir(dir)) {
    const path = join(dir, entry);
    if ((await lstat(path)).isDirectory()) await unlock(path);
  }
}

function removeSync(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Best effort while the process is being stopped.
  }
}
