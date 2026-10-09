// In-process Sheets budget: sliding 60 s windows, reads and writes counted separately → sheet_busy.
import { beforeEach, describe, expect, it } from "vitest"

import { DriveError } from "./errors"
import {
  __resetSheetsLimiter,
  MCP_SHEETS_PER_MIN,
  OWNER_SHEETS_PER_MIN,
  SlidingWindowLimiter,
  takeSheetsQuota,
  tryTakeMcpSheetsQuota,
  tryTakeSheetsBudget,
} from "./rate-limit"
import { DRIVE_LIMITS } from "./types"

beforeEach(() => __resetSheetsLimiter())

describe("SlidingWindowLimiter", () => {
  it("cửa sổ trượt: một lượt chỉ được trả lại sau đúng 60 s kể từ khi dùng", () => {
    let now = 0
    const l = new SlidingWindowLimiter(2, 60_000, () => now)
    expect(l.tryTake()).toBe(true)
    now = 30_000
    expect(l.tryTake()).toBe(true)
    expect(l.tryTake()).toBe(false)
    expect(l.waitMs()).toBe(30_000)
    now = 60_000
    expect(l.waitMs()).toBe(0)
    expect(l.tryTake()).toBe(true)
    expect(l.tryTake()).toBe(false)
    now = 90_000
    expect(l.tryTake()).toBe(true)
    l.reset()
    expect(l.tryTake()).toBe(true)
  })
})

describe("takeSheetsQuota", () => {
  it("đọc và ghi có hạn mức riêng; vượt → sheet_busy (thử lại được)", () => {
    for (let i = 0; i < DRIVE_LIMITS.sheetsReadsPerMin; i++)
      takeSheetsQuota("read")
    let err: unknown = null
    try {
      takeSheetsQuota("read")
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(DriveError)
    expect((err as DriveError).code).toBe("sheet_busy")
    expect((err as DriveError).retryable).toBe(true)
    expect(() => takeSheetsQuota("write")).not.toThrow()
  })
})

describe("tryTakeMcpSheetsQuota (hạn mức riêng mỗi MCP - L2)", () => {
  it("mỗi MCP tối đa MCP_SHEETS_PER_MIN lượt đọc / phút; MCP khác và lượt ghi không bị ảnh hưởng; hết 60 s thì dùng lại", () => {
    let now = 1_000
    const clock = () => now
    for (let i = 0; i < MCP_SHEETS_PER_MIN; i++)
      expect(tryTakeMcpSheetsQuota("mcp-a", "read", 1, clock)).toBe(0)
    const wait = tryTakeMcpSheetsQuota("mcp-a", "read", 1, clock)
    expect(wait).toBeGreaterThan(0)
    expect(wait).toBeLessThanOrEqual(60)
    expect(tryTakeMcpSheetsQuota("mcp-a", "write", 1, clock)).toBe(0)
    expect(tryTakeMcpSheetsQuota("mcp-b", "read", 1, clock)).toBe(0)
    now += 60_000
    expect(tryTakeMcpSheetsQuota("mcp-a", "read", 1, clock)).toBe(0)
  })

  it("lấy nhiều lượt cùng lúc: đủ thì lấy hết, thiếu thì không lấy lượt nào", () => {
    const clock = () => 5_000
    expect(
      tryTakeMcpSheetsQuota("mcp-c", "write", MCP_SHEETS_PER_MIN - 1, clock)
    ).toBe(0)
    expect(tryTakeMcpSheetsQuota("mcp-c", "write", 2, clock)).toBeGreaterThan(0)
    // the failed 2-unit take gave its first unit back
    expect(tryTakeMcpSheetsQuota("mcp-c", "write", 1, clock)).toBe(0)
    expect(tryTakeMcpSheetsQuota("mcp-c", "write", 1, clock)).toBeGreaterThan(0)
  })
})

describe("tryTakeSheetsBudget (hạn mức theo MCP + theo chủ sở hữu - T-5)", () => {
  it("nhiều MCP của cùng một người dùng chung OWNER_SHEETS_PER_MIN lượt / phút; người khác không bị ảnh hưởng", () => {
    let now = 10_000
    const clock = () => now
    expect(OWNER_SHEETS_PER_MIN).toBeGreaterThan(MCP_SHEETS_PER_MIN)
    for (let i = 0; i < MCP_SHEETS_PER_MIN; i++)
      expect(
        tryTakeSheetsBudget("o1-m1", "owner-1", "read", 1, clock)
      ).toBeNull()
    // the MCP budget is used up first
    expect(
      tryTakeSheetsBudget("o1-m1", "owner-1", "read", 1, clock)
    ).toMatchObject({ scope: "mcp" })
    const rest = OWNER_SHEETS_PER_MIN - MCP_SHEETS_PER_MIN
    for (let i = 0; i < rest; i++)
      expect(
        tryTakeSheetsBudget("o1-m2", "owner-1", "read", 1, clock)
      ).toBeNull()
    // a third MCP of the same owner: refused by the OWNER budget
    const refused = tryTakeSheetsBudget("o1-m3", "owner-1", "read", 1, clock)
    expect(refused).toMatchObject({ scope: "owner" })
    expect(refused!.waitSec).toBeGreaterThan(0)
    // the refused call gave its MCP unit back: o1-m3 still has its whole MCP budget once the owner window frees up
    expect(
      tryTakeMcpSheetsQuota("o1-m3", "read", MCP_SHEETS_PER_MIN, clock)
    ).toBe(0)
    // writes and other owners are separate
    expect(
      tryTakeSheetsBudget("o1-m4", "owner-1", "write", 1, clock)
    ).toBeNull()
    expect(tryTakeSheetsBudget("o2-m1", "owner-2", "read", 1, clock)).toBeNull()
    now += 60_000
    expect(tryTakeSheetsBudget("o1-m2", "owner-1", "read", 1, clock)).toBeNull()
  })
})
