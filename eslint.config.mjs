import { defineConfig, globalIgnores } from "eslint/config"
import nextVitals from "eslint-config-next/core-web-vitals"
import nextTs from "eslint-config-next/typescript"

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "tests/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  {
    // Framework-agnostic server code: must run in the worker, CLI and tests (and be portable to Hono).
    files: [
      "src/server/providers/**/*.ts",
      "src/server/mcp/**/*.ts",
      "src/server/crypto/**/*.ts",
      "src/server/audit/redact.ts",
      "src/server/audit/cap-json.ts",
      "src/server/drive/**",
      "src/server/google/**",
      "src/server/net/**",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: ["next", "next/*"], message: "Không import next/* trong code server dùng chung (providers/mcp/crypto)." }] },
      ],
    },
  },
  {
    // Client components must not reach into server code (type-only imports are fine).
    files: ["src/components/**/*.tsx"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/server/*"],
              allowTypeImports: true,
              message: "Component không được import code server (chỉ được import type).",
            },
          ],
        },
      ],
    },
  },
  globalIgnores([".claude/**", ".next/**", "out/**", "build/**", "dist/**", "next-env.d.ts", "drizzle/**", "src/components/_blocks-reference/**"]),
])

export default eslintConfig
