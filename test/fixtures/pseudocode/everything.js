import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export async function everything(items, options = {}) {
  const limit = options.limit ?? 10;
  let total = 0;
  if (items.length === 0) return null;
  else if (items.length > limit && !options.force) {
    throw new Error("too many");
  } else {
    total = 1;
  }
  switch (options.mode) {
    case "fast":
    case "quick":
      total += 1;
      break;
    case "slow": {
      total += 2;
      break;
    }
    default:
      total += 3;
  }
  outer: for (let i = 0; i < items.length; i++) {
    for (const item of items[i]) {
      if (item === undefined) continue outer;
      total += item;
    }
    for (const key in options) total += key.length;
  }
  while (total > 100) total -= 1;
  do {
    total += 1;
  } while (total < 5);
  try {
    const text = readFileSync("config.json", "utf8");
    execFileSync("git", ["status"]);
    total += text.length;
  } catch (error) {
    total = -1;
  } finally {
    total += 1;
  }
  const helper = (x) => x + total;
  const loaded = await Promise.resolve(helper(1));
  const response = await fetch("https://example.test/api");
  for await (const chunk of response.body) total += chunk.length;
  return items.map((item) => item * loaded);
}

export function* counter(n) {
  for (let i = 0; i < n; i++) yield i;
  yield* [1, 2];
}

export const short = (a) => a + 1;

export function straight(a, b) {
  const c = a + b;
  const d = c * 2;
  // a comment between statements
  return d;
}

export function paramEffect(path = readFileSync("default.txt", "utf8")) {
  return path;
}
