import { execFile, spawn } from "node:child_process";
import { chmodSync, constants, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, rm, writeFile } from "node:fs/promises";
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
  /**
   * Set when the step left a process running behind it. Only a run outside bwrap can: it is
   * killed when it can be found, and says so here either way.
   */
  readonly leftover?: string;
}

/**
 * A file read back from the out folder. The run wrote that folder, so anything there that is not
 * a plain file under its expected name is `unreadable`, and is never read as data.
 */
export type Collected =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "too large"; readonly bytes: number }
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable"; readonly why: string };

export interface Run {
  /** The steps that ran: each one after the first ran because the one before exited 0 in time. */
  readonly steps: readonly StepResult[];
  readonly collected: ReadonlyMap<string, Collected>;
  /** Where the copy was; it is gone once the run returns. */
  readonly root: string;
  /** Where the steps found things. */
  readonly places: Places;
}

export interface RunRequest {
  readonly tree: FileTree;
  /** Paths of the tree written executable; a file tree holds text, not modes. */
  readonly executable?: ReadonlySet<string>;
  readonly isolation: Isolation;
  readonly steps: (places: Places) => readonly Step[];
  /** Files given to the steps at `places.tools`. */
  readonly tools?: FileTree;
  /** Names of files in `places.out` to read back: plain names, never paths. */
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
  const collect = request.collect ?? [];
  for (const name of collect) {
    if (name === "" || name === "." || name === ".." || /[/\\\0]/.test(name)) {
      throw new Error(`a collected file must be a plain name in the out folder: ${JSON.stringify(name)}`);
    }
  }
  const root = await mkdtemp(join(tmpdir(), "rungs-run-"));
  let child: ReturnType<typeof spawn> | undefined;
  const interrupted = (signal: NodeJS.Signals) => {
    if (child?.pid !== undefined) killTree(child.pid);
    killStrays(root);
    removeSync(root);
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", interrupted).once("SIGTERM", interrupted);
  try {
    const host = { work: join(root, "work"), out: join(root, "out"), tools: join(root, "tools") };
    await writeTree(host.work, request.tree, request.executable ?? new Set());
    await writeTree(host.tools, request.tools ?? new Map(), new Set());
    for (const dir of [host.out, join(root, "home"), join(root, "tmp")]) await mkdir(dir);
    const outMade = await lstat(host.out);
    const node = process.execPath;
    const npm = join(dirname(node), "..", "lib", "node_modules", "npm");
    const { isolation } = request;
    const places: Places = isolation.kind === "bwrap" ? INSIDE : { ...host, node, npm: join(npm, "bin", "npm-cli.js") };
    const steps = request.steps(places);
    const deadline = Date.now() + request.timeoutMs;
    const results: StepResult[] = [];
    for (const step of steps) {
      const argv = isolation.kind === "bwrap" ? [isolation.path, ...bwrapArgs(host, node, npm, step.network), "--", ...step.argv] : [...step.argv];
      const { open, ...finished } = await runStep(argv, host.work, deadline, request.outputBytes, isolation, root, (spawned) => {
        child = spawned;
      });
      // In bwrap the namespace dies with the step. Outside it a process can leave the step's group.
      const killed = isolation.kind === "bwrap" ? 0 : killStrays(root);
      const leftover =
        killed > 0
          ? `${killed} ${killed === 1 ? "process" : "processes"} outlived the step and ${killed === 1 ? "was" : "were"} killed`
          : open
            ? "something the step started kept its output open, and no process could be found to kill"
            : undefined;
      const result: StepResult = leftover === undefined ? finished : { ...finished, leftover };
      results.push(result);
      if (result.exitCode !== 0 || result.timedOut) break;
    }
    const collected = new Map<string, Collected>();
    const swapped = outFolderSwapped(outMade, await lstat(host.out).catch(() => undefined));
    for (const name of collect) {
      collected.set(name, swapped === undefined ? await collectFile(join(host.out, name), request.collectBytes ?? 64 << 20) : { kind: "unreadable", why: swapped });
    }
    return { steps: results, collected, root, places };
  } finally {
    process.off("SIGINT", interrupted).off("SIGTERM", interrupted);
    if (request.isolation.kind !== "bwrap") killStrays(root);
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
  root: string,
  started: (child: ReturnType<typeof spawn>) => void,
): Promise<StepResult & { readonly open: boolean }> {
  const [command, ...args] = argv;
  if (command === undefined) throw new Error("a step has no command");
  const begun = Date.now();
  const env = isolation.kind === "bwrap" ? {} : { ...ENV, [RUN_MARK]: root, HOME: join(cwd, "..", "home"), TMPDIR: join(cwd, "..", "tmp"), PATH: `${dirname(process.execPath)}:/usr/bin:/bin` };
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
    // The step is over when it exits or is killed. A process it left behind may hold its output
    // open for ever, so the output gets a moment to close and is then let go.
    let timedOut = false;
    let exitCode: number | null = null;
    let settled = false;
    let letGo: NodeJS.Timeout | undefined;
    const finish = (open: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(letGo);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ exitCode: timedOut ? null : exitCode, timedOut, ms: Date.now() - begun, output: Buffer.concat(chunks).toString("utf8"), truncated, open });
    };
    const over = () => {
      letGo ??= setTimeout(() => finish(true), OUTPUT_GRACE_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) killTree(child.pid);
      over();
    }, Math.max(0, deadline - Date.now()));
    child.on("error", (error) => {
      clearTimeout(timer);
      clearTimeout(letGo);
      reject(error);
    });
    child.on("exit", (code) => {
      exitCode = code;
      over();
    });
    child.on("close", (code) => {
      exitCode = code;
      finish(false);
    });
  });
}

/** How long a finished step's output may stay open before the run stops waiting for it. */
const OUTPUT_GRACE_MS = 1000;
/** Names the run to every process an unsandboxed step starts, so those left behind can be found. */
const RUN_MARK = "RUNGS_RUN";

/**
 * Kills what an unsandboxed run left behind and returns how many: every process of this user
 * that still carries the run's mark or still works inside its folder. A process that dropped
 * both cannot be found this way; nor can any where there is no /proc.
 */
function killStrays(root: string): number {
  const found = new Set<number>();
  for (let pass = 0; pass < 3; pass += 1) {
    let pids: number[];
    try {
      pids = readdirSync("/proc").filter((name) => /^\d+$/.test(name)).map(Number);
    } catch {
      return found.size;
    }
    const fresh = pids.filter((pid) => pid !== process.pid && !found.has(pid) && belongsTo(pid, root));
    if (fresh.length === 0) break;
    for (const pid of fresh) {
      found.add(pid);
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
  return found.size;
}

function belongsTo(pid: number, root: string): boolean {
  try {
    const cwd = readlinkSync(`/proc/${pid}/cwd`);
    if (cwd === root || cwd.startsWith(`${root}/`)) return true;
    return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(`${RUN_MARK}=${root}`);
  } catch {
    return false;
  }
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

async function writeTree(dir: string, tree: FileTree, executable: ReadonlySet<string>): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const [path, text] of tree) {
    const file = join(dir, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text, { mode: executable.has(path) ? 0o755 : 0o644 });
  }
}

// A run outside bwrap can reach the out folder from above and put another in its place.
function outFolderSwapped(made: Stats, now: Stats | undefined): string | undefined {
  if (now === undefined) return "the out folder is gone";
  if (!now.isDirectory()) return "the out folder is no longer a folder";
  if (now.uid !== process.getuid?.()) return "the out folder belongs to someone else";
  if (now.dev !== made.dev || now.ino !== made.ino) return "the out folder is not the one the run was given";
  return undefined;
}

/**
 * Reads one file the run left behind, trusting nothing about it. The path is opened without
 * following a link in its last part, and never waits on a pipe. Every check after that is made on
 * the open file, so the file checked is the file read.
 */
async function collectFile(path: string, limit: number): Promise<Collected> {
  const unreadable = (why: string): Collected => ({ kind: "unreadable", why });
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "missing" };
    return unreadable(code === "ELOOP" ? "it is a symbolic link" : `it cannot be opened (${code ?? "unknown error"})`);
  }
  try {
    const info = await file.stat();
    if (!info.isFile()) return unreadable("it is not a regular file");
    if (info.nlink !== 1) return unreadable("it is another name for a file elsewhere");
    if (info.size > limit) return { kind: "too large", bytes: info.size };
    // The size is only what the file claimed a moment ago: read no more than that, whatever it is now.
    const buffer = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length !== info.size) return unreadable("it changed while it was being read");
    return { kind: "text", text: buffer.toString("utf8", 0, length) };
  } catch (error) {
    return unreadable(`it cannot be read (${(error as NodeJS.ErrnoException).code ?? "unknown error"})`);
  } finally {
    await file.close();
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

// The same removal for a run being interrupted, which cannot wait.
function removeSync(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    try {
      unlockSync(root);
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Best effort while the process is being stopped.
    }
  }
}

function unlockSync(dir: string): void {
  chmodSync(dir, 0o700);
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (lstatSync(path).isDirectory()) unlockSync(path);
  }
}
