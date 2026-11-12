import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  globalIgnores(["node_modules/", "dist/", "coverage/", "test/fixtures/", "docs/design/"]),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      "max-lines": [
        "error",
        { max: 1000, skipBlankLines: false, skipComments: false },
      ],
    },
  },
  {
    files: ["src/**"],
    rules: {
      // A file path may itself contain "#", so a node's file or name comes from the node (path,
      // qualifiedName) or the graph, never from slicing its id.
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.property.name=/^(split|indexOf|lastIndexOf)$/][arguments.0.value='#']",
          message: "Read a node's file or name from the node or the graph (path, qualifiedName), not by splitting its id at '#'.",
        },
      ],
    },
  },
  {
    files: ["scripts/**"],
    languageOptions: { globals: { console: "readonly", process: "readonly" } },
  },
);
