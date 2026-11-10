#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { text } from "node:stream/consumers";
import { readBase, readCheckout } from "./checkout.ts";
import { parseOptions, USAGE } from "./options.ts";
import { serve } from "./server.ts";

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
  if (options.base === undefined) {
    const server = await serve(tree, options.port);
    console.log(`Rungs is showing ${tree.size} files from ${options.dir} at ${server.url}`);
    if (options.open) openBrowser(server.url);
  } else {
    const base = await readBase(options.dir, options.base);
    const against = { ...base, ref: options.base };
    const description =
      options.description === undefined
        ? undefined
        : options.description === "-"
          ? await text(process.stdin)
          : await readFile(options.description, "utf8");
    const server = await serve(tree, options.port, against, description);
    const counts = { added: 0, altered: 0, removed: 0, moved: 0 };
    for (const change of server.comparison?.changes ?? []) {
      if (change.node.level === "file") counts[change.kind] += 1;
    }
    console.log(
      `Rungs is comparing ${tree.size.toLocaleString("en-US")} files in ${options.dir} (uncommitted changes included) against ${options.base} at ${base.commit.slice(0, 7)} (merge base): ${counts.added} files added, ${counts.altered} altered, ${counts.removed} removed, ${counts.moved} moved`,
    );
    console.log(server.url);
    if (options.open) openBrowser(server.url);
  }
} catch (error) {
  console.error(`rungs: ${(error as Error).message}`);
  process.exit(1);
}
