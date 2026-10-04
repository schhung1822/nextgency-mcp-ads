import path from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "scripts/**/*.test.ts"],
    exclude: ["node_modules", ".next", "dist", "tests/e2e/**"],
    setupFiles: ["./vitest.setup.ts"],
    testTimeout: 20_000,
    restoreMocks: true,
  },
})
