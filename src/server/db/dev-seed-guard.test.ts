import { describe, expect, it } from "vitest"

import { devSeedRefusal } from "./dev-seed-guard"

const LOCAL = "postgres://adsmcp:pw@localhost:5433/adsmcp"

describe("devSeedRefusal", () => {
  it("allows only ALLOW_DEV_SEED=1 + loopback DB + non-production", () => {
    expect(devSeedRefusal({ ALLOW_DEV_SEED: "1", DATABASE_URL: LOCAL })).toBeNull()
    expect(devSeedRefusal({ ALLOW_DEV_SEED: "1", DATABASE_URL: "postgres://u:p@127.0.0.1:5432/db" })).toBeNull()
    expect(devSeedRefusal({ ALLOW_DEV_SEED: "1", DATABASE_URL: "postgres://u:p@[::1]:5432/db" })).toBeNull()
  })

  it("refuses production, a missing flag, remote or invalid hosts", () => {
    expect(devSeedRefusal({ ALLOW_DEV_SEED: "1", DATABASE_URL: LOCAL, NODE_ENV: "production" })).toMatch(/production/)
    expect(devSeedRefusal({ DATABASE_URL: LOCAL })).toMatch(/ALLOW_DEV_SEED/)
    expect(devSeedRefusal({ ALLOW_DEV_SEED: "true", DATABASE_URL: LOCAL })).toMatch(/ALLOW_DEV_SEED/)
    expect(devSeedRefusal({ ALLOW_DEV_SEED: "1", DATABASE_URL: "postgres://u:p@db:5432/adsmcp" })).toMatch(/"db"/)
    expect(devSeedRefusal({ ALLOW_DEV_SEED: "1", DATABASE_URL: "postgres://u:p@10.0.0.5/adsmcp" })).toMatch(/10\.0\.0\.5/)
    expect(devSeedRefusal({ ALLOW_DEV_SEED: "1", DATABASE_URL: "postgres://u:p@localhost.evil.com/x" })).not.toBeNull()
    expect(devSeedRefusal({ ALLOW_DEV_SEED: "1" })).toMatch(/DATABASE_URL/)
    expect(devSeedRefusal({ ALLOW_DEV_SEED: "1", DATABASE_URL: "::not a url" })).toMatch(/không hợp lệ/)
  })
})
