import { resolve } from "node:path";
import { parseArgs } from "node:util";

export const USAGE = "usage: streets [dir] [--link] [--walkthrough] [--port <n>] [--no-open]   (no PR: lists the open PRs to pick from, through gh)\n       streets compare <base> [dir] [--description <file>|-] [--link] [--relink]\n         [--walkthrough] [--rewalk] [--narrate] [--renarrate] [--run-tests|--run-tests-unsandboxed] [--judge] [--port <n>] [--no-open]\n       streets compare --pr <n> [--link] [--relink] [--walkthrough] [--rewalk] [--narrate] [--renarrate]\n         [--run-tests|--run-tests-unsandboxed] [--judge] [--port <n>] [--no-open]\n       streets setup [dir] [--base <ref>]   (builds and stores the repository's vocabulary from its base; default: the default branch)";

export interface Options {
  readonly dir: string;
  readonly port: number;
  readonly open: boolean;
  /** Set by `streets compare <base>`: what to compare the checkout against. */
  readonly base: string | undefined;
  /** Set by `--pr <n>`: compare this pull request's head against its base, with its body as the description. */
  readonly pr: number | undefined;
  /** Set by `--description`: a file holding the change's description, or "-" for stdin. */
  readonly description: string | undefined;
  /** Set by `--link`: ask an agent to link each claim in the description to the modules it describes. */
  readonly link: boolean;
  /** Set by `--relink`: ask again even when the cache holds an answer. Implies `link`. */
  readonly relink: boolean;
  /** Set by `--walkthrough`: ask an agent for a tour of the change, stop by stop. */
  readonly walkthrough: boolean;
  /** Set by `--rewalk`: ask again even when the cache holds a tour. Implies `walkthrough`. */
  readonly rewalk: boolean;
  /**
   * Set by `--run-tests`: run the checkout's tests once, in a sandbox. `--run-tests-unsandboxed`
   * also runs them when no sandbox is available.
   */
  readonly tests: "off" | "sandboxed" | "unsandboxed allowed";
  /** Set by `--narrate`: offer an agent's narration of a function beside its pseudocode, and write it ahead of time for the functions in contracts moved. */
  readonly narrate: boolean;
  /** Set by `--renarrate`: write narration again even when the cache holds it. Implies `narrate`. */
  readonly renarrate: boolean;
  /** Set by `--judge`: let judged checks send source text to TypeSafe's Jev. Off unless given. */
  readonly judge: boolean;
  /** Set by `streets setup`: build and store the repository's vocabulary instead of serving a page. Absent otherwise. `base` is then `--base`. */
  readonly setup?: true;
}

/** The options, or a one-line usage error. */
export function parseOptions(argv: readonly string[]): Options | string {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        port: { type: "string", default: "0" },
        "no-open": { type: "boolean", default: false },
        description: { type: "string" },
        pr: { type: "string" },
        link: { type: "boolean", default: false },
        relink: { type: "boolean", default: false },
        walkthrough: { type: "boolean", default: false },
        rewalk: { type: "boolean", default: false },
        "run-tests": { type: "boolean", default: false },
        "run-tests-unsandboxed": { type: "boolean", default: false },
        narrate: { type: "boolean", default: false },
        renarrate: { type: "boolean", default: false },
        judge: { type: "boolean", default: false },
        base: { type: "string" },
      },
    });
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) return `invalid port: ${values.port}`;
    const comparing = positionals[0] === "compare";
    const setup = positionals[0] === "setup";
    if (values.base !== undefined && !setup) return "--base is for setup: streets setup --base <ref> (compare takes its base as an argument)";
    const [base, ...rest] = comparing ? positionals.slice(1) : setup ? [values.base, ...positionals.slice(1)] : [undefined, ...positionals];
    let pr: number | undefined;
    if (values.pr !== undefined) {
      pr = Number(values.pr);
      if (!/^[1-9]\d*$/.test(values.pr) || !Number.isSafeInteger(pr)) return `invalid pull request number: ${values.pr}`;
      if (!comparing) return "--pr needs compare: streets compare --pr <n>";
      if (base !== undefined) return "--pr takes the base from the pull request and runs inside its repository: drop the base and directory, streets compare --pr <n>";
      if (values.description !== undefined) return "--pr takes the description from the pull request: drop --description";
    }
    if (comparing && base === undefined && pr === undefined) return "compare needs a base: streets compare <base> [dir]";
    if (values.description !== undefined && !comparing) {
      return "--description needs compare: streets compare <base> --description <file>";
    }
    const link = values.link || values.relink;
    if (comparing && link && values.description === undefined && pr === undefined) return "--link needs a description: streets compare <base> --description <file> --link";
    const walkthrough = values.walkthrough || values.rewalk;
    const tests = values["run-tests-unsandboxed"] ? "unsandboxed allowed" : values["run-tests"] ? "sandboxed" : "off";
    if (tests !== "off" && !comparing) return "--run-tests needs compare: streets compare <base> --run-tests (a PR picked from the list never runs tests: streets compare --pr <n> --run-tests)";
    const narrate = values.narrate || values.renarrate;
    if (narrate && !comparing) return "--narrate needs compare: streets compare <base> --narrate";
    if (values.judge && !comparing) return "--judge needs compare: streets compare <base> --judge";
    if (setup && link) return "--link needs compare: streets compare <base> --description <file> --link";
    if (setup && walkthrough) return "--walkthrough needs compare: streets compare <base> --walkthrough";
    if (rest.length > 1) return "expected at most one directory";
    return { ...(setup ? { setup: true as const } : {}), dir: resolve(rest[0] ?? "."), port, open: !values["no-open"], base, pr, description: values.description, link, relink: values.relink, tests, walkthrough, rewalk: values.rewalk, narrate, renarrate: values.renarrate, judge: values.judge };
  } catch (error) {
    return (error as Error).message;
  }
}
