// Shared media semaphore: neutral MediaBusyError reasons, and ONE pool for Telegram (wrapper in
// notifications/media.ts) and Drive (this module).
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  isTelegramMediaError,
  withMediaSlot as withTelegramMediaSlot,
} from "../notifications/media"
import {
  isMediaBusyError,
  MEDIA_SLOTS,
  MediaBusyError,
  withMediaSlot,
} from "./media-slots"

afterEach(() => vi.useRealTimers())

describe("withMediaSlot (chung)", () => {
  it("key đang bận → MediaBusyError('key') ngay, không chạy admit", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const first = withMediaSlot(() => gate, { key: "mcp-a" })
    const admit = vi.fn(async () => {})
    const e = await withMediaSlot(async () => 1, { key: "mcp-a", admit }).catch(
      (x: unknown) => x
    )
    expect(isMediaBusyError(e) && e.reason).toBe("key")
    expect(admit).not.toHaveBeenCalled()
    release()
    await first
  })

  it("hết chỗ quá 5 s → MediaBusyError('process')", async () => {
    vi.useFakeTimers()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const holders = Array.from({ length: MEDIA_SLOTS.concurrent }, () =>
      withMediaSlot(() => gate)
    )
    const waiting = withMediaSlot(async () => "late").catch((x: unknown) => x)
    await vi.advanceTimersByTimeAsync(MEDIA_SLOTS.waitMs + 1)
    const e = await waiting
    expect(e).toBeInstanceOf(MediaBusyError)
    expect((e as MediaBusyError).reason).toBe("process")
    release()
    await Promise.all(holders)
  })

  it("Telegram và Drive dùng chung 1 bể: Drive giữ hết chỗ → Telegram phải chờ rồi báo telegram_busy", async () => {
    vi.useFakeTimers()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const drive = Array.from({ length: MEDIA_SLOTS.concurrent }, () =>
      withMediaSlot(() => gate)
    )
    const tg = withTelegramMediaSlot(async () => "tg").catch((x: unknown) => x)
    await vi.advanceTimersByTimeAsync(MEDIA_SLOTS.waitMs + 1)
    const e = await tg
    expect(isTelegramMediaError(e) && e.code).toBe("telegram_busy")
    release()
    await Promise.all(drive)
    expect(await withTelegramMediaSlot(async () => "ok")).toBe("ok")
  })

  it("Telegram và Drive dùng chung khoá MCP", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const drive = withMediaSlot(() => gate, { key: "mcp-shared" })
    const e = await withTelegramMediaSlot(async () => 1, {
      key: "mcp-shared",
    }).catch((x: unknown) => x)
    expect(isTelegramMediaError(e) && e.code).toBe("telegram_busy")
    release()
    await drive
  })
})
