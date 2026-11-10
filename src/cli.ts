#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { readCheckout } from "./checkout.ts";
import { serve } from "./server.ts";

const USAGE = "usage: rungs [dir] [--port <n>] [--no-open]";

interface Options {
  readonly dir: string;
  readonly port: number;
  readonly open: boolean;
}

function parseOptions(argv: readonly string[]): Options | string {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        port: { type: "string", default: "0" },
        "no-open": { type: "boolean", default: false },
      },
    });
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) return `invalid port: ${values.port}`;
    if (positionals.length > 1) return "expected at most one directory";
    return { dir: resolve(positionals[0] ?? "."), port, open: !values["no-open"] };
  } catch (error) {
    return (error as Error).message;
  }
}

const OPENERS: Partial<Record<NodeJS.Platform, (url: string) => [string, string[]]>> = {
  darwin: (url) => ["open", [url]],
  win32: (url) => ["cmd", ["/c", "start", "", url]],
  linux: (url) => (process.env.WSL_DISTRO_NAME ? ["wslview", [url]] : ["xdg-open", [url]]),
};

function openBrowser(url: string): void {
  const opener = OPENERS[process.platform];
  if (opener === undefined) return;
  const [command, args] = opener(url);
  spawn(command, args, { stdio: "ignore", detached: true })
    .on("error", () => {})
    .unref();
}

const options = parseOptions(process.argv.slice(2));
if (typeof options === "string") {
  console.error(`${options}\n${USAGE}`);
  process.exit(2);
}

try {
  const tree = await readCheckout(options.dir);
  const server = await serve(tree, options.port);
  console.log(`Rungs is showing ${tree.size} files from ${options.dir} at ${server.url}`);
  if (options.open) openBrowser(server.url);
} catch (error) {
  console.error(`rungs: ${(error as Error).message}`);
  process.exit(1);
}
