import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { DerivedFact } from "../src/harm-catalogue.ts";
import { DERIVED_FACTS, HARM_CATALOGUE, HARM_CATALOGUE_VERSION, harmKind, serializeHarmCatalogue } from "../src/harm-catalogue.ts";
import { RESOURCE_ORDER } from "../src/graph.ts";

const ledgerPath = fileURLToPath(new URL("harm-catalogue-versions.json", import.meta.url));

const SECURITY = [
  "access control",
  "cryptography and secrets",
  "injection",
  "insecure design",
  "misconfiguration",
  "vulnerable dependencies",
  "authentication",
  "supply chain and build integrity",
  "logging",
  "server-side request forgery",
];
const OTHER = ["data loss or corruption", "privacy", "availability", "money", "compatibility for callers", "what users see"];

describe("the harm catalogue", () => {
  test("holds the ten OWASP security kinds and the six others, each once", () => {
    expect(HARM_CATALOGUE.filter((kind) => kind.group === "security").map((kind) => kind.name)).toEqual(SECURITY);
    expect(HARM_CATALOGUE.filter((kind) => kind.group === "other").map((kind) => kind.name)).toEqual(OTHER);
    const ids = HARM_CATALOGUE.map((kind) => kind.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
    expect(harmKind("injection")?.name).toBe("injection");
    expect(harmKind("__proto__")).toBeUndefined();
  });

  test("each security kind carries OWASP's official 2021 name and id, once each", () => {
    const owasp = HARM_CATALOGUE.filter((kind) => kind.group === "security").map((kind) => kind.owasp);
    expect(owasp).toEqual([
      "A01:2021 Broken Access Control",
      "A02:2021 Cryptographic Failures",
      "A03:2021 Injection",
      "A04:2021 Insecure Design",
      "A05:2021 Security Misconfiguration",
      "A06:2021 Vulnerable and Outdated Components",
      "A07:2021 Identification and Authentication Failures",
      "A08:2021 Software and Data Integrity Failures",
      "A09:2021 Security Logging and Monitoring Failures",
      "A10:2021 Server-Side Request Forgery (SSRF)",
    ]);
    expect(new Set(owasp).size).toBe(10);
    expect(HARM_CATALOGUE.filter((kind) => kind.group === "other").every((kind) => kind.owasp === undefined)).toBe(true);
    expect(HARM_CATALOGUE.map((kind) => kind.id).filter((id) => id.includes("failures"))).toEqual(["software-and-data-integrity-failures", "security-logging-and-monitoring-failures"]);
  });

  test("every kind has short, plain criteria for yes and for no", () => {
    for (const kind of HARM_CATALOGUE) {
      for (const text of [kind.yes, kind.no]) {
        expect(text.trim(), kind.id).toBe(text);
        expect(text.length, kind.id).toBeGreaterThan(20);
        expect(text.length, `${kind.id} is too long to be a question's criteria`).toBeLessThanOrEqual(300);
      }
      expect(kind.yes, kind.id).not.toBe(kind.no);
    }
  });

  test("no criterion exempts a case that a real harm also fits, and every no also says no safeguard changes", () => {
    for (const kind of HARM_CATALOGUE) {
      expect(kind.no, kind.id).not.toMatch(/harmless|rebuilt|rebuild|recoverable|offline|in the background/i);
      expect(kind.no, `${kind.id}: a "no" is a change with no path to the harm and no change to a safeguard`).toMatch(/\b(?:changes (?:no|none|nothing)|no change)\b/i);
    }
    // A mitigation (an escaping function, an allow-list) that is written or changed is a yes.
    expect(harmKind("injection")?.yes).toMatch(/escap/i);
    expect(harmKind("server-side-request-forgery")?.yes).toMatch(/allow-list/i);
    expect(harmKind("data-loss-or-corruption")?.yes).toMatch(/even if/i);
    // A loosened safeguard is a yes wherever the harm lands: validation upstream of storage, retention and consent.
    expect(harmKind("data-loss-or-corruption")?.yes).toMatch(/validat/i);
    expect(harmKind("data-loss-or-corruption")?.no).toMatch(/validat|safeguard/i);
    expect(harmKind("privacy")?.yes).toMatch(/retention/i);
    expect(harmKind("privacy")?.yes).toMatch(/consent/i);
    expect(harmKind("privacy")?.no).toMatch(/retention/i);
    expect(harmKind("privacy")?.no).toMatch(/consent/i);
    for (const kind of HARM_CATALOGUE) expect(kind.no, `${kind.id}: a "no" must also rule out a changed check`).toMatch(/\b(?:check|checks|safeguard|limit|validation|validates|protection|setting|step|rule|escaping)\b/i);
    expect(harmKind("availability")?.yes).toMatch(/loop/i);
  });

  test("the integrity and logging kinds keep OWASP's scope", () => {
    expect(harmKind("software-and-data-integrity-failures")?.yes).toMatch(/deserializ/i);
    expect(harmKind("software-and-data-integrity-failures")?.yes).toMatch(/update/i);
    expect(harmKind("security-logging-and-monitoring-failures")?.yes).toMatch(/alert/i);
  });

  test("names no repository", () => {
    expect(serializeHarmCatalogue()).not.toMatch(/systems-to-streets|docviz|DerekHertz/i);
  });

  test("a kind says whether code answers it exactly or it needs judgement, and points at derived facts by name", () => {
    // No kind is answered by code alone yet: a dependency change is exact, "vulnerable" is not, and a malformed manifest is unknown, never "no change".
    expect(HARM_CATALOGUE.filter((kind) => kind.answer === "code")).toEqual([]);
    expect(harmKind("vulnerable-dependencies")).toMatchObject({ answer: "judgement", facts: ["dependency changes"] });
    for (const kind of HARM_CATALOGUE) {
      expect(["code", "judgement"]).toContain(kind.answer);
      if (kind.answer === "code") expect(kind.facts.length, `${kind.id}: code answers it from a derived fact`).toBeGreaterThan(0);
      for (const fact of kind.facts) expect(Object.hasOwn(DERIVED_FACTS, fact), `${kind.id}: ${fact}`).toBe(true);
    }
  });

  test("each derived fact names a function that exists and, for an effect, one of the resource kinds", async () => {
    expect(Object.keys(DERIVED_FACTS).sort()).toEqual(["dependency changes", "effects on a process", "effects on the file system", "effects on the network"]);
    for (const [name, fact] of Object.entries(DERIVED_FACTS as Readonly<Record<string, DerivedFact>>)) {
      const loaded = (await import(`../${fact.module}`)) as Record<string, unknown>;
      expect(typeof loaded[fact.function], name).toBe("function");
      if (fact.resource !== undefined) expect(RESOURCE_ORDER, name).toContain(fact.resource);
    }
  });

  test("a catalogue change needs a version bump and a ledger entry", () => {
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as Record<string, string>;
    const hash = createHash("sha256").update(serializeHarmCatalogue()).digest("hex");
    expect(
      ledger[String(HARM_CATALOGUE_VERSION)],
      `The harm catalogue changed or HARM_CATALOGUE_VERSION ${HARM_CATALOGUE_VERSION} has no entry. Bump ` +
        `HARM_CATALOGUE_VERSION and append "<new version>": "<hash>" to test/harm-catalogue-versions.json ` +
        `(currently ${hash} for version ${HARM_CATALOGUE_VERSION}). Never edit an existing entry.`,
    ).toBe(hash);
  });

  test("the ledger holds one entry per version, counting up from 1", () => {
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as Record<string, string>;
    const versions = Object.keys(ledger).map(Number);
    expect(versions).toEqual(versions.map((_, index) => index + 1));
    expect(versions.at(-1)).toBe(HARM_CATALOGUE_VERSION);
  });
});
