import { describe, expect, test } from "vitest";
import { extract } from "../src/extract/extract.ts";
import { roleOf } from "../src/extract/roles.ts";
import type { Role } from "../src/graph.ts";

describe("the role of a file", () => {
  const cases: [string, boolean, Role | null][] = [
    ["package-lock.json", false, "generated"],
    ["pkg/yarn.lock", false, "generated"],
    ["pnpm-lock.yaml", false, "generated"],
    ["test/a.ts", true, "tests"],
    ["tests/a.ts", true, "tests"],
    ["src/__tests__/a.ts", true, "tests"],
    ["src/a.test.ts", true, "tests"],
    ["src/a.spec.tsx", true, "tests"],
    ["src/a.test.snap", false, "tests"],
    ["README.md", false, "docs"],
    ["docs/guide.txt", false, "docs"],
    ["packages/x/docs/img.png", false, "docs"],
    ["package.json", false, "config"],
    ["packages/x/package.json", false, "config"],
    ["tsconfig.json", false, "config"],
    ["tsconfig.build.json", false, "config"],
    ["vitest.config.ts", true, "config"],
    ["eslint.config.js", true, "config"],
    ["a.config.mjs", true, "config"],
    ["a.config.cjs", true, "config"],
    ["a.config.json", false, "config"],
    [".github/workflows/ci.yml", false, "config"],
    [".gitignore", false, "config"],
    [".gitattributes", false, "config"],
    [".npmrc", false, "config"],
    [".nvmrc", false, "config"],
    [".editorconfig", false, "config"],
    ["src/a.ts", true, "source"],
    ["lib/b.js", true, "source"],
    ["src/a.config.css", false, null],
    ["assets/logo.svg", false, null],
    ["src/data.yaml", false, null],
    ["my-yarn.lock", false, null],
    ["Makefile", false, null],
    ["contest/a.ts", true, "source"],
    ["src/protest.ts", true, "source"],
    // A rule earlier in the table wins over a later one.
    ["docs/x.test.ts", true, "tests"],
    ["test/fixtures/package.json", false, "tests"],
    ["test/README.md", false, "tests"],
    ["docs/vitest.config.ts", true, "docs"],
    [".github/ci.test.ts", true, "tests"],
    ["docs/package-lock.json", false, "generated"],
    ["test/package-lock.json", false, "generated"],
    [".github/package-lock.json", false, "generated"],
    ["vitest.config.ts", true, "config"],
    ["extension/vendor/mermaid.min.js", true, "generated"],
    ["dist/app.min.js", true, "generated"],
    ["site/style.min.css", false, "generated"],
    ["vendor/lib.js", true, "generated"],
    ["vendors/lib.js", true, "generated"],
    ["a/third_party/x/y.ts", true, "generated"],
    ["third-party/x.js", true, "generated"],
    ["vendor/README.md", false, "generated"],
    // A vendored file stays generated whatever else it would be.
    ["vendor/pkg/test/a.test.js", true, "generated"],
    ["vendor/pkg/package.json", false, "generated"],
    ["docs/vendor/a.js", true, "generated"],
    ["src/a.min.js.map", false, null],
    ["src/admin.js", true, "source"],
    ["src/vendor.ts", true, "source"],
    ["src/vendored/a.ts", true, "source"],
    ["src/min.js", true, "source"],
    ["src/a.min.ts", true, "source"],
  ];

  test.each(cases)("%s (analysed: %s) is %s", (path, analysed, role) => {
    expect(roleOf(path, analysed)).toBe(role);
  });
});

describe("the role on extracted files", () => {
  const graph = extract(
    new Map([
      ["package.json", "{}\n"],
      ["package-lock.json", "{}\n"],
      ["src/a.ts", "one\n"],
      ["src/a.test.ts", "one\n"],
      ["docs/notes.md", "x"],
      ["assets/logo.svg", "<svg/>"],
    ]),
  );
  const roleAt = (path: string) => {
    const node = graph.nodes.find((candidate) => candidate.level === "file" && candidate.path === path);
    return node?.level === "file" ? node.role : undefined;
  };

  test("is carried by every file node", () => {
    expect(roleAt("package.json")).toBe("config");
    expect(roleAt("package-lock.json")).toBe("generated");
    expect(roleAt("src/a.ts")).toBe("source");
    expect(roleAt("src/a.test.ts")).toBe("tests");
    expect(roleAt("docs/notes.md")).toBe("docs");
  });

  test("is null for a file the table does not recognise, never a guess", () => {
    expect(roleAt("assets/logo.svg")).toBeNull();
  });
});
