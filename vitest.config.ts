import path from "node:path"
import { defineConfig } from "vitest/config"

// DB test files that create / replace / delete THE single live system Google Drive credential
// (unique index drive_credentials_one_system_uq): they cannot run at the same time against one test database,
// so they run one after another in a second group, after every other file.
const DRIVE_SYSTEM_CREDENTIAL_DB_TESTS = [
  "src/server/drive/access-recheck.test.ts",
  "src/server/drive/health.test.ts",
  "src/server/drive/relay-links.test.ts",
  "src/server/drive/store.test.ts",
  "src/server/drive/upload-jobs.test.ts",
  "src/server/jobs/media-video-upload.integration.test.ts",
  "src/server/mcp/__tests__/flows/drive.flows.test.ts",
  "src/server/services/drive-sources.test.ts",
  "scripts/cli.integration.test.ts",
]

const shared = {
  environment: "node" as const,
  setupFiles: ["./vitest.setup.ts"],
  testTimeout: 20_000,
  restoreMocks: true,
}

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  test: {
    ...shared,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: [
            "src/**/*.test.ts",
            "src/**/*.test.tsx",
            "scripts/**/*.test.ts",
          ],
          exclude: [
            "node_modules",
            ".next",
            "dist",
            "tests/e2e/**",
            ...DRIVE_SYSTEM_CREDENTIAL_DB_TESTS,
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "drive-db-serial",
          include: DRIVE_SYSTEM_CREDENTIAL_DB_TESTS,
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
})
