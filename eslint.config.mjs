// eslint.config.mjs
import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  {
    ignores: ["**/*.js", "scripts/**/*.ts"],
  },
  ...obsidianmd.configs.recommended,

  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { project: "./tsconfig.json" },
      globals: {
        activeWindow: "readonly",
        activeDocument: "readonly",
        console: "readonly",
        window: "readonly",
        document: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
      },
    },

    // Optional project overrides
    rules: {
      "obsidianmd/ui/sentence-case": [
        "warn",
        {
          brands: ["Obsidian", "Snipd"],
          acronyms: ["OK", "README", "README.md"],
          enforceCamelCaseLower: true,
        },
      ],
    },
  },
]);