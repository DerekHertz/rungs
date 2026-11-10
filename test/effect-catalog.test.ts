import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { EFFECT_ENTRIES, TRANSPARENT_WRAPPERS, effectKey, serializeCatalog } from "../src/extract/javascript-effects-catalog.ts";
import { EXTRACTOR_VERSION } from "../src/extract/extract.ts";
import { RESOURCE_ORDER } from "../src/graph.ts";

const ledgerPath = fileURLToPath(new URL("effect-catalog-versions.json", import.meta.url));

describe("the effect catalog", () => {
  test("every key is unique and every resource is one of the five", () => {
    const keys = EFFECT_ENTRIES.map(effectKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const entry of EFFECT_ENTRIES) expect(RESOURCE_ORDER).toContain(entry.resource);
  });

  test("holds no module with a node: prefix, and no entry for console, env, os, crypto, path or url", () => {
    for (const entry of EFFECT_ENTRIES) {
      expect(entry.module?.startsWith("node:") ?? false).toBe(false);
      expect(["console", "os", "crypto", "path", "url"]).not.toContain(entry.module);
    }
    expect(EFFECT_ENTRIES.some((entry) => entry.name === "env")).toBe(false);
  });

  test("names promisify as its one transparent wrapper", () => {
    expect(TRANSPARENT_WRAPPERS).toEqual([{ module: "util", name: "promisify", target: 0 }]);
  });

  test("a catalog change needs an extractor version bump and a ledger entry", () => {
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as Record<string, string>;
    const hash = createHash("sha256").update(serializeCatalog()).digest("hex");
    expect(
      ledger[EXTRACTOR_VERSION],
      `The effect catalog changed or EXTRACTOR_VERSION ${EXTRACTOR_VERSION} has no entry. Bump ` +
        `EXTRACTOR_VERSION and append "<new version>": "<hash>" to test/effect-catalog-versions.json ` +
        `(currently ${hash} for version ${EXTRACTOR_VERSION}). Never edit an existing entry.`,
    ).toBe(hash);
  });
});
