import { defineConfig } from "drizzle-kit"

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema/index.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
  // keep pg-boss's schema and runtime log partitions out of drizzle-kit
  schemaFilter: ["public"],
  tablesFilter: ["*", "!*_p2*", "!*_default"],
  casing: "snake_case",
  strict: true,
  verbose: true,
})
