import { describe, expect, it } from "vitest"

import { ProviderError } from "./errors"
import {
  checkOffsets,
  createOnce,
  createTimeoutMs,
  pollCallTimeoutMs,
  processingDeadline,
  readExact,
} from "./media-deadline"

describe("media-deadline", () => {
  const now = 1_000_000

  it("createTimeoutMs = min(own, deadlineAt - now - 1 s); refuses when < 2 s is left", () => {
    expect(createTimeoutMs("meta", 120_000)).toBe(120_000)
    expect(createTimeoutMs("meta", 120_000, now + 30_000, now)).toBe(29_000)
    expect(createTimeoutMs("meta", 10_000, now + 30_000, now)).toBe(10_000)
    expect(() => createTimeoutMs("tiktok", 60_000, now + 2_500, now)).toThrow(
      ProviderError
    )
  })

  it("processingDeadline: deadlineAt wins over maxWaitMs; maxWaitMs <= 0 or a passed deadline → null", () => {
    expect(
      processingDeadline(
        { deadlineAt: now + 5_000, maxWaitMs: 60_000 },
        60_000,
        now
      )
    ).toBe(now + 4_000)
    expect(
      processingDeadline({ deadlineAt: now + 500 }, 60_000, now)
    ).toBeNull()
    expect(processingDeadline({ maxWaitMs: 100 }, 60_000, now)).toBe(now + 100)
    expect(processingDeadline({}, 60_000, now)).toBe(now + 60_000)
    expect(processingDeadline({ maxWaitMs: 0 }, 60_000, now)).toBeNull()
  })

  it("pollCallTimeoutMs is clamped to [1 s, 15 s]", () => {
    expect(pollCallTimeoutMs(now + 100, now)).toBe(1_000)
    expect(pollCallTimeoutMs(now + 5_000, now)).toBe(5_000)
    expect(pollCallTimeoutMs(now + 600_000, now)).toBe(15_000)
  })

  it("createOnce turns a timeout into a non-retryable 'may have been created' error", async () => {
    const timeout = new ProviderError({
      platform: "meta",
      code: "timeout",
      message: "t",
      userMessageVi: "t",
      retryable: true,
    })
    await expect(
      createOnce("meta", () => Promise.reject(timeout))
    ).rejects.toMatchObject({
      code: "timeout",
      retryable: false,
      userMessageVi: expect.stringMatching(
        /có thể đã tạo trên nền tảng - kiểm tra thư viện media/
      ),
    })
    const other = new ProviderError({
      platform: "meta",
      code: "invalid_request",
      message: "x",
      userMessageVi: "x",
    })
    await expect(createOnce("meta", () => Promise.reject(other))).rejects.toBe(
      other
    )
  })

  it("readExact reads in pieces and checks the length; checkOffsets bounds the server's range", async () => {
    const src = Buffer.from("abcdefghij")
    const calls: [number, number][] = []
    const buf = await readExact(
      "meta",
      async (s, e) => (calls.push([s, e]), src.subarray(s, e)),
      1,
      9,
      3
    )
    expect(buf.toString()).toBe("bcdefghi")
    expect(calls).toEqual([
      [1, 4],
      [4, 7],
      [7, 9],
    ])
    await expect(
      readExact("meta", async () => Buffer.alloc(1), 0, 5, 10)
    ).rejects.toMatchObject({ code: "upstream_error" })
    expect(() => checkOffsets("tiktok", 0, 10, 10, 10)).not.toThrow()
    expect(() => checkOffsets("tiktok", 5, 5, 10, 10)).toThrow()
    expect(() => checkOffsets("tiktok", 0, 11, 10, 20)).toThrow()
    expect(() => checkOffsets("tiktok", 0, 10, 10, 5)).toThrow()
  })
})
