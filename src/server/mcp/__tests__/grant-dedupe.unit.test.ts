import { describe, expect, it } from "vitest"
import { dedupeAccounts } from "../grant"

const row = (id: string, ext: string, status: string, createdAt: string, platform = "meta") => ({
  id,
  platform,
  externalId: ext,
  connectionStatus: status,
  connectionCreatedAt: new Date(createdAt),
})

describe("dedupeAccounts (same ad account through several connections)", () => {
  it("keeps one row per platform + external id", () => {
    const out = dedupeAccounts([
      row("a", "act_1", "active", "2026-01-01"),
      row("b", "act_1", "active", "2026-02-01"),
      row("c", "act_2", "active", "2026-02-01"),
      row("d", "act_1", "active", "2026-01-01", "openai_ads"), // same id on another platform is another account
    ])
    expect(out.map((r) => r.id).sort()).toEqual(["a", "c", "d"])
  })

  it("prefers the healthiest connection, then the oldest, then the lowest id", () => {
    expect(dedupeAccounts([row("old-invalid", "x", "invalid", "2026-01-01"), row("new-active", "x", "active", "2026-03-01")]).map((r) => r.id)).toEqual(["new-active"])
    expect(dedupeAccounts([row("expiring", "x", "expiring", "2026-01-01"), row("active", "x", "active", "2026-03-01")]).map((r) => r.id)).toEqual(["active"])
    expect(dedupeAccounts([row("b-new", "x", "active", "2026-03-01"), row("a-old", "x", "active", "2026-01-01")]).map((r) => r.id)).toEqual(["a-old"])
    expect(dedupeAccounts([row("b", "x", "active", "2026-01-01"), row("a", "x", "active", "2026-01-01")]).map((r) => r.id)).toEqual(["a"])
  })

  it("is independent of the input order", () => {
    const rows = [row("1", "x", "invalid", "2026-01-01"), row("2", "x", "expiring", "2026-02-01"), row("3", "x", "active", "2026-03-01")]
    expect(dedupeAccounts(rows)[0]!.id).toBe("3")
    expect(dedupeAccounts([...rows].reverse())[0]!.id).toBe("3")
  })
})
