import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll } from "vitest";
import type { Correction } from "../src/corrections.ts";
import { extract } from "../src/extract/extract.ts";
import type { FileTree } from "../src/graph.ts";
import type { AgentRunner } from "../src/link.ts";
import { readVocabulary } from "../src/setup.ts";
import type { StoredVocabulary } from "../src/setup.ts";
import { keyOf } from "../src/vocabulary.ts";
import { vocabularyDocument } from "../src/vocabulary-doc.ts";

export const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});
export const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
};
export const identity = ["user.name=t", "user.email=t@example.com", "commit.gpgsign=false"];
export const git = (dir: string, ...args: string[]): string => execFileSync("git", [...identity.flatMap((s) => ["-c", s]), ...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
export function commit(dir: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  git(dir, "add", "--all");
  git(dir, "commit", "--quiet", "-m", "change");
}
export function repo(files: Record<string, string>): string {
  const dir = temp("streets-propose-");
  git(dir, "init", "--quiet", "--initial-branch=main");
  commit(dir, files);
  return dir;
}
export const fn = (name: string): string => `export function ${name}(a) {\n  return a;\n}\n`;

/** Six code files and no word the repository's own text shares between them: two of six map to an own term at most. */
export const poor: Record<string, string> = {
  "package.json": '{\n  "name": "zq"\n}\n',
  "README.md": "# zq\n",
  "lib/k1.js": fn("multiply") + fn("compact"),
  "lib/k2.js": fn("total") + fn("mean"),
  "lib/k3.js": fn("isoDay") + fn("daysBetween"),
  "lib/k4.js": fn("slugify") + fn("truncate"),
  "lib/k5.js": fn("toCsv") + fn("fromCsv"),
  "bin/z.js": 'import { multiply } from "../lib/k1.js";\nconsole.log(multiply(1, 2));\n',
};
export const well: Record<string, string> = {
  "package.json": '{\n  "description": "Online bookshop with a shopping cart and checkout"\n}\n',
  "README.md": "# Bookshop\n\n## Shopping cart\n\ntext\n\n## Checkout\n\ntext\n\n## Inventory\n\ntext\n",
  "src/cart/cart.js": fn("addToCart") + fn("removeFromCart"),
  "src/cart/total.js": fn("cartTotal"),
  "src/checkout/checkout.js": fn("placeOrder"),
  "src/checkout/payment.js": fn("chargeCard"),
  "src/inventory/stock.js": fn("stockLevel"),
  "src/inventory/restock.js": fn("restock"),
};

export type Terms = { name: string; description: string; files: string[] }[];
export const dates: Terms = [
  { name: "Date arithmetic", description: "Dates and the days between them.", files: ["lib/k3.js"] },
  { name: "Text shaping", description: "Slugs and truncated text.", files: ["lib/k4.js", "lib/k5.js"] },
  { name: "Number folding", description: "Totals and means over lists.", files: ["lib/k2.js", "lib/k1.js"] },
];
export interface Fake extends AgentRunner {
  calls: number;
  prompts: string[];
}
export function runner(answer: () => Promise<{ output: unknown; model: string; usd?: number | null }>): Fake {
  const fake: Fake = {
    calls: 0,
    prompts: [],
    async run(request) {
      fake.calls += 1;
      fake.prompts.push(request.prompt);
      return answer();
    },
  };
  return fake;
}
export const saying = (terms: Terms, usd: number | null | undefined = 0.0123): Fake => runner(async () => ({ output: { terms }, model: "claude-sonnet-x", ...(usd === undefined ? {} : { usd }) }));
export const read = async (dir: string, cacheDir: string): Promise<StoredVocabulary> => {
  const found = await readVocabulary(dir, cacheDir);
  if (found.kind !== "ok") throw new Error(found.kind);
  return found.stored;
};


export const stamp = { by: "Dana", at: "2026-11-12T10:00:00.000Z" };
export const dateKey = keyOf("Date arithmetic");
export const treeOf = (files: Record<string, string>): FileTree => new Map(Object.entries(files));
export const docOf = (stored: StoredVocabulary, tree: Record<string, string> = poor) => {
  const head = treeOf(tree);
  return vocabularyDocument({ kind: "ok", stored }, { graph: extract(head), tree: head });
};
export const withWord = (stored: StoredVocabulary, corrections: Correction[]): StoredVocabulary => ({ ...stored, corrections }) as StoredVocabulary;
