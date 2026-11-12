import { execFile, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** What `gh pr view --json` is asked for: nothing the reviewer's own `gh` login could not read. */
const FIELDS = "number,title,url,headRefOid,baseRefName,baseRefOid,body,state";
/** The title is untrusted text in a header; this much of it is shown. */
const TITLE_LIMIT = 120;

/** One command run: its stdout, or a throw carrying the stderr and `code` ("ENOENT" when the program is missing). */
export type Runner = (args: readonly string[], cwd: string) => Promise<string>;

export interface Runners {
  readonly gh: Runner;
  readonly git: Runner;
}

const run =
  (program: string): Runner =>
  async (args, cwd) => (await execFileAsync(program, [...args], { cwd, maxBuffer: 1 << 28 })).stdout;

export const systemRunners: Runners = { gh: run("gh"), git: run("git") };

/** The pull request can't be opened: the message is one line, fit to print as is. */
export class PullRequestUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PullRequestUnavailable";
  }
}

/** What the page header says about the pull request. */
export interface PullRequestInfo {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  /** The fetched head commit. */
  readonly head: string;
  readonly state: string;
}

export interface OpenedPullRequest {
  /** A scratch worktree of the head, under the cache directory. */
  readonly dir: string;
  /** The base's tip commit as just fetched, to give readBase as the ref. */
  readonly baseTip: string;
  /** The base's name, as the page says it. */
  readonly baseRef: string;
  readonly pr: PullRequestInfo;
  /** The PR body, untrusted data like any description. */
  readonly description: string;
  /** The repository's name, for the page. */
  readonly repo: string;
  /** Said once on stderr when the PR is closed or merged; the run goes on. */
  readonly note: string | undefined;
  /** Removes the scratch worktree; safe to call twice. */
  remove(): Promise<void>;
  /** The same, synchronously, for a process that is exiting. */
  removeSync(): void;
}

const stderrOf = (error: unknown): string => {
  const said = (error as { stderr?: unknown }).stderr;
  return (typeof said === "string" ? said : "").trim().split("\n")[0] ?? "";
};

async function readPullRequest(number: number, cwd: string, gh: Runner): Promise<Record<string, unknown>> {
  let out: string;
  try {
    out = await gh(["pr", "view", String(number), "--json", FIELDS], cwd);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") {
      throw new PullRequestUnavailable("--pr needs the GitHub CLI: install gh (https://cli.github.com) and run gh auth login");
    }
    const said = stderrOf(error);
    if (/gh auth login|not logged in|authentication|GH_TOKEN/i.test(said)) {
      throw new PullRequestUnavailable("gh is not logged in: run gh auth login");
    }
    if (/could not resolve|no pull requests? found|not found/i.test(said)) {
      throw new PullRequestUnavailable(`pull request #${number} not found in this repository`);
    }
    throw new PullRequestUnavailable(`gh could not read pull request #${number}: ${said || (error as Error).message}`);
  }
  try {
    const parsed: unknown = JSON.parse(out);
    if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>;
  } catch {
    // fall through to the one message below
  }
  throw new PullRequestUnavailable(`gh gave an answer for pull request #${number} that is not JSON`);
}

const field = (value: unknown, name: string, number: number): string => {
  if (typeof value !== "string") throw new PullRequestUnavailable(`gh gave pull request #${number} no ${name}`);
  return value;
};
export interface OpenOptions {
  readonly number: number;
  /** A folder inside the user's repository. */
  readonly cwd: string;
  /** The cache directory; scratch worktrees live in <cache>/pull-requests. */
  readonly cacheDir: string;
  readonly runners?: Runners;
  /** Distinguishes two runs at once; derived from the process by default. */
  readonly token?: string;
  /**
   * Called before the scratch worktree is created, with the function that removes it however far
   * the run got, so a signal or exit at any later moment can clean up.
   */
  readonly register?: (removeSync: () => void) => void;
}

/** "github.com/o/r" from an https, ssh or local-path remote URL, so two spellings of one repository compare equal. */
export function repositoryKey(url: string): string {
  return url
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/^[^@/]+@/, "")
    .replace(/^([^/:]+):(?!\/)/, "$1/")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .replace(/^\/+/, "")
    .toLowerCase();
}

/** What to fetch from: a remote of the user's that is the repository gh resolved, else that repository's own URL. */
async function sourceOf(prUrl: string, number: number, top: string, git: Runner): Promise<string> {
  const repoUrl = prUrl.replace(new RegExp(`/pull/${number}/?$`), "");
  const wanted = repositoryKey(repoUrl);
  let listing = "";
  try {
    listing = await git(["remote", "-v"], top);
  } catch {
    // No remotes to match: fetch from the URL.
  }
  for (const line of listing.split("\n")) {
    const [name, url, kind] = line.split(/\s+/);
    if (name !== undefined && url !== undefined && kind === "(fetch)" && repositoryKey(url) === wanted) return name;
  }
  return repoUrl;
}

/** Pull-request scratch worktrees left by a process that no longer runs (killed, power loss). */
async function sweepStale(root: string, top: string, git: Runner): Promise<void> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return;
  }
  for (const name of names) {
    const pid = /^pr-\d+-(\d+)-/.exec(name)?.[1];
    if (pid === undefined) continue;
    try {
      process.kill(Number(pid), 0);
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") continue;
    }
    const stale = join(root, name);
    try {
      await git(["worktree", "remove", "--force", stale], top);
    } catch {
      // Not this repository's, or already half gone: the folder goes either way.
    }
    await rm(stale, { recursive: true, force: true });
  }
  try {
    await git(["worktree", "prune"], top);
  } catch {
    // Nothing more to do.
  }
}

/**
 * Opens a pull request for review without touching the user's working tree, index, branch or
 * stash: the PR is read with `gh`, its head and its base are fetched from the repository gh
 * resolved (checked against the commits gh names) into the object store, and the head is checked
 * out in a detached scratch worktree.
 */
export async function openPullRequest(options: OpenOptions): Promise<OpenedPullRequest> {
  const { number, cwd, cacheDir } = options;
  const { gh, git } = options.runners ?? systemRunners;
  let top: string;
  try {
    top = (await git(["rev-parse", "--show-toplevel"], cwd)).trim();
  } catch {
    throw new PullRequestUnavailable(`${cwd} is not a git repository: run --pr inside the repository the pull request belongs to`);
  }
  const view = await readPullRequest(number, top, gh);
  const title = field(view.title, "title", number).replace(/\s+/g, " ").trim().slice(0, TITLE_LIMIT);
  const baseRef = field(view.baseRefName, "base branch", number);
  const state = field(view.state, "state", number);
  const url = field(view.url, "url", number);
  const sha = (value: unknown): string | undefined => (typeof value === "string" && /^[0-9a-f]{40}$/.test(value) ? value : undefined);
  const headOid = sha(view.headRefOid);
  if (headOid === undefined) throw new PullRequestUnavailable(`gh gave pull request #${number} no head commit`);
  // A merged PR's base branch has moved on to include it, so from the branch's tip the merge base is the head itself and nothing differs; the base the PR was reviewed against is GitHub's baseRefOid.
  const fixedBase = state === "OPEN" ? undefined : sha(view.baseRefOid);
  const body = typeof view.body === "string" ? view.body : "";
  const note = state === "OPEN" ? undefined : `pull request #${number} is ${state.toLowerCase()}, not open; comparing it against the base it had`;

  const root = join(cacheDir, "pull-requests");
  const dir = join(root, `pr-${number}-${options.token ?? `${process.pid}-${Date.now().toString(36)}`}`);
  await mkdir(root, { recursive: true });
  await sweepStale(root, top, git);
  let finished = false;
  const removeArgs = ["worktree", "remove", "--force", dir];
  const remove = async (): Promise<void> => {
    if (finished) return;
    finished = true;
    try {
      await git(removeArgs, top);
    } catch {
      // Never made, or already gone: the folder and the entry are dropped below either way.
    }
    await rm(dir, { recursive: true, force: true });
    try {
      await git(["worktree", "prune"], top);
    } catch {
      // Nothing more to do.
    }
  };
  const removeSync = (): void => {
    if (finished) return;
    finished = true;
    spawnSync("git", removeArgs, { cwd: top, stdio: "ignore" });
    rmSync(dir, { recursive: true, force: true });
    spawnSync("git", ["worktree", "prune"], { cwd: top, stdio: "ignore" });
  };
  options.register?.(removeSync);
  try {
    const source = await sourceOf(url, number, top, git);
    try {
      await git(["worktree", "add", "--detach", "--no-checkout", dir], top);
    } catch (error) {
      throw new PullRequestUnavailable(`cannot make a scratch worktree for pull request #${number}: ${stderrOf(error) || (error as Error).message}`);
    }
    let head: string;
    try {
      await git(["fetch", "--quiet", source, `pull/${number}/head`], dir);
      head = (await git(["rev-parse", "--verify", "FETCH_HEAD^{commit}"], dir)).trim();
    } catch (error) {
      throw new PullRequestUnavailable(`cannot fetch the head of pull request #${number} from ${source} (pull/${number}/head): ${stderrOf(error) || (error as Error).message}`);
    }
    if (head !== headOid) {
      throw new PullRequestUnavailable(`${source} has pull/${number}/head at ${head.slice(0, 7)} but gh says pull request #${number} is at ${headOid.slice(0, 7)}: another repository's pull request, or it just moved; run again`);
    }
    try {
      await git(["checkout", "--quiet", "--detach", head], dir);
    } catch (error) {
      throw new PullRequestUnavailable(`cannot check out the head of pull request #${number}: ${stderrOf(error) || (error as Error).message}`);
    }
    let baseTip: string;
    try {
      await git(["fetch", "--quiet", source, fixedBase ?? baseRef], dir);
      baseTip = (await git(["rev-parse", "--verify", "FETCH_HEAD^{commit}"], dir)).trim();
    } catch (error) {
      throw new PullRequestUnavailable(`cannot fetch the base ${fixedBase === undefined ? `"${baseRef}"` : fixedBase.slice(0, 7)} of pull request #${number} from ${source}: ${stderrOf(error) || (error as Error).message}`);
    }
    if (fixedBase !== undefined && baseTip !== fixedBase) {
      throw new PullRequestUnavailable(`${source} gave ${baseTip.slice(0, 7)} for the base of pull request #${number}, not the ${fixedBase.slice(0, 7)} gh names`);
    }
    const repo = top.split(/[\\/]/).filter((part) => part !== "").pop() ?? top;
    return { dir, baseTip, baseRef, pr: { number, title, url, head, state }, description: body, repo, note, remove, removeSync };
  } catch (error) {
    await remove();
    throw error;
  }
}
