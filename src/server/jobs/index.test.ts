import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

import { JOBS, jobTimezone, mapLimit } from "./index"

describe("job registry", () => {
  it("có tokens.health mỗi 6 giờ và accounts.sync 02:30 giờ Việt Nam", () => {
    const health = JOBS.find((j) => j.name === "tokens.health")
    const sync = JOBS.find((j) => j.name === "accounts.sync")
    expect(health?.cron).toBe("0 */6 * * *")
    expect(sync?.cron).toBe("30 2 * * *")
    expect(jobTimezone(sync!)).toBe("Asia/Ho_Chi_Minh")
  })

  it("có update.check kiểm tra bản phát hành mỗi 6 giờ (lệch phút với tokens.health)", () => {
    const job = JOBS.find((j) => j.name === "update.check")
    expect(job?.cron).toBe("20 */6 * * *")
    expect(job?.queue?.retryLimit).toBe(0)
  })

  it("có drive.health mỗi 6 giờ phút 40 và drive.cleanup 03:50 hằng ngày", () => {
    expect(JOBS.find((j) => j.name === "drive.health")?.cron).toBe("40 */6 * * *")
    expect(JOBS.find((j) => j.name === "drive.cleanup")?.cron).toBe("50 3 * * *")
  })

  it("có apify.health mỗi 6 giờ phút 10 (kiểm tra token Apify + dọn apify_runs)", () => {
    const job = JOBS.find((j) => j.name === "apify.health")
    expect(job?.cron).toBe("10 */6 * * *")
    expect(job?.queue?.retryLimit).toBe(1)
  })

  it("tên job hợp lệ cho pg-boss và không trùng; cron 5 trường; tz là IANA hợp lệ", () => {
    const names = JOBS.map((j) => j.name)
    expect(new Set(names).size).toBe(names.length)
    for (const j of JOBS) {
      expect(j.name).toMatch(/^[\w.\-/]+$/)
      expect(typeof j.handler).toBe("function")
      if (j.cron) expect(j.cron.trim().split(/\s+/)).toHaveLength(5)
      expect(() => new Intl.DateTimeFormat("en-US", { timeZone: jobTimezone(j) })).not.toThrow()
    }
  })

  it("code job không import next/* hoặc server-only (được bundle vào worker)", () => {
    const dir = import.meta.dirname
    const files: string[] = []
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = path.join(d, f)
        if (statSync(p).isDirectory()) walk(p)
        else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) files.push(p)
      }
    }
    walk(dir)
    expect(files.length).toBeGreaterThan(3)
    for (const f of files) {
      const src = readFileSync(f, "utf8")
      expect(src, f).not.toMatch(/from\s+["'](next(\/[^"']*)?|server-only)["']/)
      expect(src, f).not.toMatch(/from\s+["']@\/server\/(services|actions|auth)\//)
    }
  })
})

describe("mapLimit", () => {
  it("giữ thứ tự kết quả và không vượt giới hạn song song", async () => {
    let inFlight = 0
    let peak = 0
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return n * 2
    })
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14])
    expect(peak).toBeLessThanOrEqual(3)
  })

  it("dừng nhận việc mới khi bị huỷ", async () => {
    const ac = new AbortController()
    const seen: number[] = []
    await mapLimit(
      [1, 2, 3, 4],
      1,
      async (n) => {
        seen.push(n)
        if (n === 2) ac.abort()
      },
      ac.signal
    )
    expect(seen).toEqual([1, 2])
  })
})
