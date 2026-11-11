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
);
