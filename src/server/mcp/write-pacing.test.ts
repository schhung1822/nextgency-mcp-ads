import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { McpToolError } from "./errors"
import {
  __resetWritePacing,
  acquireWritePacing,
  MAX_WAIT_MS,
} from "./write-pacing"

const MCP = "00000000-0000-4000-8000-0000000000p1"
const OTHER = "00000000-0000-4000-8000-0000000000p2"
const live = () => new AbortController().signal

/** settle pending promise callbacks without moving the fake clock */
const flush = () => vi.advanceTimersByTimeAsync(0)

describe("write pacing (settings.writeDelaySeconds)", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-14T03:00:00Z"))
    __resetWritePacing()
  })
  afterEach(() => {
    __resetWritePacing()
    vi.useRealTimers()
  })

  it("delay 0 (off / basic mode) never waits and keeps no state", async () => {
    for (let i = 0; i < 5; i++) {
      const a = await acquireWritePacing(MCP, 0, live())
      expect(a.waitedMs).toBe(0)
      a.release(true)
    }
  })

  it("the first write runs at once; the next one waits the delay counted from when the previous one FINISHED", async () => {
    const first = await acquireWritePacing(MCP, 5, live())
    expect(first.waitedMs).toBe(0)
    await vi.advanceTimersByTimeAsync(2_000) // the write itself takes 2 s
    first.release(true)

    let got: Awaited<ReturnType<typeof acquireWritePacing>> | null = null
    void acquireWritePacing(MCP, 5, live()).then((a) => (got = a))
    await vi.advanceTimersByTimeAsync(4_999)
    expect(got).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(got).not.toBeNull()
    expect(got!.waitedMs).toBe(5_000)
    got!.release(true)
  })

  it("nothing executed (preview / replay / refusal) does not start a cooldown", async () => {
    const a = await acquireWritePacing(MCP, 10, live())
    a.release(false)
    const b = await acquireWritePacing(MCP, 10, live())
    expect(b.waitedMs).toBe(0)
    b.release(true)
  })

  it("concurrent writes of one MCP run one at a time, FIFO, each the delay after the previous", async () => {
    const order: number[] = []
    const runs = [1, 2, 3].map((n) =>
      acquireWritePacing(MCP, 3, live()).then((a) => {
        order.push(n)
        const at = Date.now()
        a.release(true)
        return at
      })
    )
    await vi.advanceTimersByTimeAsync(10_000)
    const times = await Promise.all(runs)
    expect(order).toEqual([1, 2, 3])
    expect(times[1]! - times[0]!).toBe(3_000)
    expect(times[2]! - times[1]!).toBe(3_000)
  })

  it("other MCPs are not paced by this one", async () => {
    const a = await acquireWritePacing(MCP, 30, live())
    a.release(true)
    const b = await acquireWritePacing(OTHER, 30, live())
    expect(b.waitedMs).toBe(0)
    b.release(true)
  })

  it("the cap is 30 s (ChatGPT cuts a tool call at 60 s)", () => {
    expect(MAX_WAIT_MS).toBe(30_000)
  })

  it("a queued call whose turn does not come within the cap is refused with write_cooldown (the queue keeps working)", async () => {
    // a long-running write holds the lane past the 30 s cap
    const holder = await acquireWritePacing(MCP, 20, live())
    const queuedErr = acquireWritePacing(MCP, 20, live()).then(
      () => null,
      (e: unknown) => e
    )
    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS)
    const e = await queuedErr
    expect(e).toBeInstanceOf(McpToolError)
    expect(e).toMatchObject({ code: "write_cooldown", logStatus: "rate_limited" })
    expect((e as McpToolError).messageVi).toMatch(/CHƯA được thực hiện/)
    // no confirmation flow → no confirm_token wording in the hint
    expect((e as McpToolError).hint).not.toMatch(/confirm_token/)
    holder.release(true)
    // the lane is free again: the next caller only waits the delay
    let got: Awaited<ReturnType<typeof acquireWritePacing>> | null = null
    void acquireWritePacing(MCP, 20, live()).then((x) => (got = x))
    await vi.advanceTimersByTimeAsync(20_000)
    expect(got).not.toBeNull()
    got!.release(true)
  })

  it("refuses at once when the writes ahead already make the cap impossible (no pointless wait)", async () => {
    const holder = await acquireWritePacing(MCP, 20, live())
    // 1 ahead × 20 s fits; 2 ahead × 20 s = 40 s does not
    const first = acquireWritePacing(MCP, 20, live())
    const t0 = Date.now()
    const e = await acquireWritePacing(MCP, 20, live(), undefined, { confirmable: true }).catch((x: unknown) => x)
    expect(Date.now() - t0).toBe(0)
    expect(e).toMatchObject({ code: "write_cooldown" })
    expect((e as McpToolError).hint).toMatch(/confirm_token vẫn dùng được/)
    holder.release(true)
    await vi.advanceTimersByTimeAsync(20_000)
    ;(await first).release(true)
  })

  it("the largest delay (30 s) fits the cap: a write right after another waits the full delay", async () => {
    const a = await acquireWritePacing(MCP, 30, live())
    a.release(true)
    let got: Awaited<ReturnType<typeof acquireWritePacing>> | null = null
    void acquireWritePacing(MCP, 30, live()).then((x) => (got = x))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(got).not.toBeNull()
    expect(got!.waitedMs).toBe(30_000)
    got!.release(true)
  })

  it("a smaller per-call cap (media uploads) refuses instead of eating the upload's time", async () => {
    const a = await acquireWritePacing(MCP, 10, live())
    a.release(true)
    const e = await acquireWritePacing(MCP, 10, live(), 5_000).catch((x: unknown) => x)
    expect(e).toMatchObject({ code: "write_cooldown" })
    // the refusal did not start a new cooldown: 10 s after the first write the lane is free at once
    await vi.advanceTimersByTimeAsync(10_000)
    const b = await acquireWritePacing(MCP, 10, live(), 5_000)
    expect(b.waitedMs).toBe(0)
    b.release(true)
  })

  it("a wall clock stepping back never turns into a wait longer than the delay", async () => {
    const a = await acquireWritePacing(MCP, 5, live())
    a.release(true)
    vi.setSystemTime(new Date(Date.now() - 10 * 60_000))
    let got: Awaited<ReturnType<typeof acquireWritePacing>> | null = null
    void acquireWritePacing(MCP, 5, live()).then((x) => (got = x))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(got).not.toBeNull()
    got!.release(true)
  })

  it("a request cancelled while waiting leaves the queue, never runs, and does not block the next one", async () => {
    const a = await acquireWritePacing(MCP, 5, live())
    a.release(true)
    const ctl = new AbortController()
    const waiting = acquireWritePacing(MCP, 5, ctl.signal).then(
      () => "ran",
      (e: unknown) => e
    )
    await vi.advanceTimersByTimeAsync(1_000)
    ctl.abort()
    const e = await waiting
    expect(e).toMatchObject({ code: "write_cancelled" })
    // the cooldown from the first write still applies to the next caller (≈ 4 s left), no deadlock
    let got: Awaited<ReturnType<typeof acquireWritePacing>> | null = null
    void acquireWritePacing(MCP, 5, live()).then((x) => (got = x))
    await vi.advanceTimersByTimeAsync(4_000)
    expect(got).not.toBeNull()
    got!.release(true)
  })

  it("a request cancelled while queued behind another write is removed from the queue", async () => {
    const holder = await acquireWritePacing(MCP, 2, live())
    const ctl = new AbortController()
    const cancelled = acquireWritePacing(MCP, 2, ctl.signal).then(
      () => "ran",
      (e: unknown) => e
    )
    const order: string[] = []
    const third = acquireWritePacing(MCP, 2, live()).then((x) => {
      order.push("third")
      return x
    })
    await flush()
    ctl.abort()
    expect(await cancelled).toMatchObject({ code: "write_cancelled" })
    holder.release(true)
    await vi.advanceTimersByTimeAsync(2_000)
    const t = await third
    expect(order).toEqual(["third"])
    t.release(true)
  })

  it("an already aborted signal is refused at once", async () => {
    const ctl = new AbortController()
    ctl.abort()
    await expect(acquireWritePacing(MCP, 5, ctl.signal)).rejects.toMatchObject({
      code: "write_cancelled",
    })
  })

  it("release is idempotent (a double release never hands the lane to two writers)", async () => {
    const a = await acquireWritePacing(MCP, 1, live())
    const order: string[] = []
    const b = acquireWritePacing(MCP, 1, live()).then((x) => {
      order.push("b")
      return x
    })
    const c = acquireWritePacing(MCP, 1, live()).then((x) => {
      order.push("c")
      return x
    })
    a.release(true)
    a.release(true)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(order).toEqual(["b"])
    ;(await b).release(true)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(order).toEqual(["b", "c"])
    ;(await c).release(true)
  })
})
