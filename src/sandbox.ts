import { execFile, spawn } from "node:child_process";
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, rmSync, unlinkSync } from "node:fs";
import type { Stats } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, normalize } from "node:path";
import { promisify } from "node:util";
import type { FileTree } from "./graph.ts";
import { cacheDirectory } from "./link.ts";

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
  /** The install's own folder; the steps never see it. */
  readonly install: string;
  /** Where a step writes its report, when the run asked for one. */
  readonly report: string;
  readonly node: string;
  /** npm's command-line script, run with `node`. */
  readonly npm: string;
}

/** A command run in the copy. It never gets the network: only the install does. */
export interface Step {
  readonly argv: readonly string[];
}

/**
 * Fetching dependencies is the one command that gets the network, so it is kept away from the
 * tree. It runs before the steps in a folder that holds only `files`: the copy and the out folder
 * are not there, so nothing the tree wrote can be read as settings or run. When it exits 0 its
 * `node_modules` moves into the copy.
 */
export interface Install {
  readonly files: FileTree;
  readonly argv: (places: Places) => readonly string[];
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
  /** The install, when one was asked for. No step runs unless it exited 0 in time. */
  readonly install?: StepResult;
  /** The steps that ran: each one after the first ran because the one before exited 0 in time. */
  readonly steps: readonly StepResult[];
  readonly collected: ReadonlyMap<string, Collected>;
  /** What the steps wrote to `places.report`, when the run asked for a report. */
  readonly report?: Extract<Collected, { kind: "text" | "too large" }>;
  /** Where the copy was; it is gone once the run returns. */
  readonly root: string;
  /** Where the steps found things. */
  readonly places: Places;
}

export interface RunRequest {
  readonly tree: FileTree;
  /** Paths of the tree written executable; a file tree holds text, not modes. */
  readonly executable?: ReadonlySet<string>;
  /**
   * Paths of the tree the steps may read and not change. In bwrap each is mounted read-only over
   * its place in the copy, so a step can neither write it, remove it, replace it nor move it, and
   * the folder around it stays writable. Outside bwrap each is only made mode 0444, which the
   * step's own user can undo.
   */
  readonly pinned?: ReadonlySet<string>;
  readonly isolation: Isolation;
  readonly install?: Install;
  readonly steps: (places: Places) => readonly Step[];
  /** Files given to the steps at `places.tools`. */
  readonly tools?: FileTree;
  /**
   * Gives each step an open file at `places.report` and returns what was written to it. Unlike a
   * file in `places.out`, it has no name anywhere and belongs to the step's first process alone:
   * node closes it to the processes it starts, and in bwrap it runs from a copy of node that
   * cannot be read, which makes the kernel refuse every other process a way in through /proc or
   * ptrace. So a test runner can report here what the tests it runs cannot rewrite. Outside bwrap
   * the file is still nameless, but a step's processes can reach each other.
   */
  readonly report?: boolean;
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
  install: "/install",
  report: "/dev/fd/3",
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
  for (const path of [...request.tree.keys(), ...(request.install?.files.keys() ?? [])]) {
    const normal = normalize(path);
    if (isAbsolute(path) || normal === ".." || normal.startsWith("../")) {
      throw new Error(`the tree holds a path outside itself: ${JSON.stringify(path)}`);
    }
  }
  for (const path of request.pinned ?? []) {
    if (!request.tree.has(path)) throw new Error(`a pinned file is not in the tree: ${JSON.stringify(path)}`);
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
    const host = { work: join(root, "work"), out: join(root, "out"), tools: join(root, "tools"), install: join(root, "install"), pinned: join(root, "pinned") };
    const pinned = [...(request.pinned ?? [])].sort();
    await writeTree(host.work, request.tree, request.executable ?? new Set());
    await writeTree(host.pinned, new Map(pinned.map((path) => [path, request.tree.get(path) ?? ""])), request.executable ?? new Set());
    if (request.isolation.kind !== "bwrap") for (const path of pinned) await chmod(join(host.work, path), request.executable?.has(path) ? 0o555 : 0o444);
    await writeTree(host.tools, request.tools ?? new Map(), new Set());
    await writeTree(host.install, request.install?.files ?? new Map(), new Set());
    for (const dir of [host.out, join(root, "home"), join(root, "tmp")]) await mkdir(dir);
    const outMade = await lstat(host.out);
    const { isolation } = request;
    // Outside bwrap nothing is kept from a step anyway, and a process the host cannot read is one
    // it could not find to kill, so only the sandbox runs the unreadable copy.
    const node = request.report && isolation.kind === "bwrap" ? await unreadableNode(root) : process.execPath;
    const npm = join(dirname(process.execPath), "..", "lib", "node_modules", "npm");
    const places: Places = isolation.kind === "bwrap" ? INSIDE : { ...host, node, npm: join(npm, "bin", "npm-cli.js"), report: INSIDE.report };
    const limit = request.collectBytes ?? 64 << 20;
    const report = request.report ? { chunks: [] as Buffer[], bytes: 0, limit } : undefined;
    const deadline = Date.now() + request.timeoutMs;
    const run = async (argv: readonly string[], room: Room): Promise<StepResult> => {
      const command = isolation.kind === "bwrap" ? [isolation.path, ...bwrapArgs(host, node, npm, room, pinned), "--", ...argv] : [...argv];
      const { open, ...finished } = await runStep(command, host[room], deadline, request.outputBytes, isolation, root, room === "work" ? report : undefined, (spawned) => {
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
      return leftover === undefined ? finished : { ...finished, leftover };
    };
    const succeeded = (result: StepResult) => result.exitCode === 0 && !result.timedOut;
    const install = request.install === undefined ? undefined : await run(request.install.argv(places), "install");
    const results: StepResult[] = [];
    if (install === undefined || succeeded(install)) {
      if (install !== undefined) await moveModules(host.install, host.work);
      for (const step of request.steps(places)) {
        const result = await run(step.argv, "work");
        results.push(result);
        if (!succeeded(result)) break;
      }
    }
    const collected = new Map<string, Collected>();
    const swapped = outFolderSwapped(outMade, await lstat(host.out).catch(() => undefined));
    for (const name of collect) {
      collected.set(name, swapped === undefined ? await collectFile(join(host.out, name), limit) : { kind: "unreadable", why: swapped });
    }
    const reported: Run["report"] =
      report === undefined ? undefined : report.bytes > limit ? { kind: "too large", bytes: report.bytes } : { kind: "text", text: Buffer.concat(report.chunks).toString("utf8") };
    return { ...(install === undefined ? {} : { install }), steps: results, collected, ...(reported === undefined ? {} : { report: reported }), root, places };
  } finally {
    process.off("SIGINT", interrupted).off("SIGTERM", interrupted);
    if (request.isolation.kind !== "bwrap") killStrays(root);
    await remove(root);
  }
}

/** Where a command runs: the install's folder, with the network, or the copy, with none. */
type Room = "install" | "work";

function bwrapArgs(host: Record<Room | "out" | "tools" | "pinned", string>, node: string, npm: string, room: Room, pinned: readonly string[]): string[] {
  const args = ["--unshare-all", "--die-with-parent", "--new-session", "--clearenv"];
  for (const dir of SYSTEM) args.push("--ro-bind-try", dir, dir);
  for (const name of ETC) args.push("--ro-bind-try", `/etc/${name}`, `/etc/${name}`);
  args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", ENV.HOME);
  args.push("--ro-bind", node, INSIDE.node, "--ro-bind-try", npm, dirname(dirname(INSIDE.npm)));
  args.push("--ro-bind", host.tools, INSIDE.tools);
  // The network and the tree's files are never in the same room.
  if (room === "install") args.push("--share-net", "--bind", host.install, INSIDE.install, "--chdir", INSIDE.install);
  else {
    args.push("--bind", host.work, INSIDE.work, "--bind", host.out, INSIDE.out);
    // A folder that is a mount point cannot be renamed or removed, so a pinned file's place cannot
    // be given to another file by moving the folders above it away.
    const above = new Set(pinned.flatMap((path) => path.split("/").slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join("/"))));
    for (const dir of [...above].sort()) args.push("--bind", join(host.work, dir), join(INSIDE.work, dir));
    for (const path of pinned) args.push("--ro-bind", join(host.pinned, path), join(INSIDE.work, path));
    args.push("--chdir", INSIDE.work);
  }
  for (const [name, value] of Object.entries({ ...ENV, PATH: `${dirname(INSIDE.node)}:/usr/bin:/bin` })) args.push("--setenv", name, value);
  return args;
}

// Moving a name never follows a link, and only a real folder is moved: whatever else the install
// left behind stays where no step can see it.
async function moveModules(install: string, work: string): Promise<void> {
  const from = join(install, "node_modules");
  const info = await lstat(from).catch(() => undefined);
  if (info === undefined || !info.isDirectory()) return;
  const to = join(work, "node_modules");
  await rm(to, { recursive: true, force: true });
  await rename(from, to);
}

function runStep(
  argv: readonly string[],
  cwd: string,
  deadline: number,
  limit: number,
  isolation: Isolation,
  root: string,
  report: { chunks: Buffer[]; bytes: number; readonly limit: number } | undefined,
  started: (child: ReturnType<typeof spawn>) => void,
): Promise<StepResult & { readonly open: boolean }> {
  const [command, ...args] = argv;
  if (command === undefined) throw new Error("a step has no command");
  const begun = Date.now();
  const env = isolation.kind === "bwrap" ? {} : { ...ENV, [RUN_MARK]: root, HOME: join(cwd, "..", "home"), TMPDIR: join(cwd, "..", "tmp"), PATH: `${dirname(process.execPath)}:/usr/bin:/bin` };
  return new Promise((resolve, reject) => {
    // The report is a file with no name: made in the run's folder, outside every place a step can
    // see, and unlinked before the step starts. Only the open file is handed on.
    const reported = report === undefined ? undefined : openSync(join(root, "report"), constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o600);
    if (reported !== undefined) unlinkSync(join(root, "report"));
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe", ...(reported === undefined ? [] : [reported])], detached: true });
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
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
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
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (report !== undefined && reported !== undefined) {
        const size = fstatSync(reported).size;
        report.bytes += size;
        if (report.bytes <= report.limit) {
          const buffer = Buffer.alloc(size);
          let length = 0;
          while (length < size) {
            const read = readSync(reported, buffer, length, size - length, length);
            if (read === 0) break;
            length += read;
          }
          report.chunks.push(buffer.subarray(0, length));
        }
        closeSync(reported);
      }
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

/**
 * A copy of this node that its owner may run but not read. The kernel treats a process started
 * from a program it could not read as one whose memory must not leak: no other process without
 * privileges, the user's own included, may open its /proc entries or trace it. That is what keeps
 * a step's report from the processes the step starts. The copy is made once and kept in the
 * cache; where the cache cannot be written it is made in the run's own folder.
 */
async function unreadableNode(root: string): Promise<string> {
  const source = await stat(process.execPath);
  const name = `node-${process.version}-${source.size}-${Math.floor(source.mtimeMs)}`;
  const mine = (info: Stats) => info.isFile() && info.uid === process.getuid?.() && (info.mode & 0o7777) === 0o111 && info.size === source.size;
  for (const dir of [cacheDirectory(process.env, homedir()), root]) {
    const kept = join(dir, name);
    try {
      if (mine(await lstat(kept))) return kept;
    } catch {
      // Not made yet.
    }
    try {
      await mkdir(dir, { recursive: true });
      const making = `${kept}.${process.pid}.tmp`;
      await rm(making, { force: true });
      await copyFile(process.execPath, making);
      await chmod(making, 0o111);
      await rename(making, kept);
      return kept;
    } catch {
      // Try the next place.
    }
  }
  throw new Error("could not make an unreadable copy of node for the run");
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
