import { resolve } from "node:path";
import { parseArgs } from "node:util";

export const USAGE = "usage: rungs [dir] [--port <n>] [--no-open]\n       rungs compare <base> [dir] [--description <file>|-] [--port <n>] [--no-open]";

export interface Options {
  readonly dir: string;
  readonly port: number;
  readonly open: boolean;
  /** Set by `rungs compare <base>`: what to compare the checkout against. */
  readonly base: string | undefined;
  /** Set by `--description`: a file holding the change's description, or "-" for stdin. */
  readonly description: string | undefined;
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
      },
    });
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) return `invalid port: ${values.port}`;
    const comparing = positionals[0] === "compare";
    const [base, ...rest] = comparing ? positionals.slice(1) : [undefined, ...positionals];
    if (comparing && base === undefined) return "compare needs a base: rungs compare <base> [dir]";
    if (values.description !== undefined && !comparing) {
      return "--description needs compare: rungs compare <base> --description <file>";
    }
    if (rest.length > 1) return "expected at most one directory";
    return { dir: resolve(rest[0] ?? "."), port, open: !values["no-open"], base, description: values.description };
  } catch (error) {
    return (error as Error).message;
  }
}
