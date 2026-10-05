import { describe, expect, it } from "vitest"

import { hasSamplePostgresPassword, isAcceptableAuthUrl, parseEnv } from "./env"

const BASE = {
  DATABASE_URL: "postgres://u:p@localhost:5433/db",
  BETTER_AUTH_SECRET: "x".repeat(40),
  ENCRYPTION_KEYS: "1:abc",
  MCP_KEY_PEPPER: "y".repeat(40),
}

describe("env validation", () => {
  it("production requires an https BETTER_AUTH_URL (loopback allowed for smoke tests)", () => {
    expect(isAcceptableAuthUrl("https://ads.example.com", "production")).toBe(true)
    expect(isAcceptableAuthUrl("http://ads.example.com", "production")).toBe(false)
    expect(isAcceptableAuthUrl("http://localhost:3000", "production")).toBe(true)
    expect(isAcceptableAuthUrl("http://127.0.0.1:3000", "production")).toBe(true)
    expect(isAcceptableAuthUrl("http://ads.example.com", "development")).toBe(true)
    expect(parseEnv({ ...BASE, NODE_ENV: "production", BETTER_AUTH_URL: "http://ads.example.com" }).success).toBe(false)
    expect(parseEnv({ ...BASE, NODE_ENV: "production", BETTER_AUTH_URL: "https://ads.example.com" }).success).toBe(true)
  })

  it("SETUP_TOKEN: empty = disabled, otherwise at least 24 characters", () => {
    expect(parseEnv({ ...BASE, SETUP_TOKEN: "" }).success).toBe(true)
    expect(parseEnv({ ...BASE }).success).toBe(true)
    expect(parseEnv({ ...BASE, SETUP_TOKEN: "short-token" }).success).toBe(false)
    expect(parseEnv({ ...BASE, SETUP_TOKEN: "a".repeat(24) }).success).toBe(true)
  })

  it("sample PostgreSQL password change-me is detected (warning only, never rejected)", () => {
    const url = "postgres://adsmcp:change-me@db:5432/adsmcp"
    expect(hasSamplePostgresPassword(url)).toBe(true)
    expect(hasSamplePostgresPassword("postgres://adsmcp:Zx81kQ@db:5432/adsmcp")).toBe(false)
    expect(parseEnv({ ...BASE, DATABASE_URL: url }).success).toBe(true)
  })
})
