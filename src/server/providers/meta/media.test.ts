import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { __resetBuckets } from "../rate-limit"
import { META_TIMINGS } from "./client"
import { uploadMetaMedia } from "./media"
import { json, mockGraph, providerCtx } from "./test-utils"

const saved = { ...META_TIMINGS }
beforeEach(() => {
  __resetBuckets()
  META_TIMINGS.pollIntervalMs = 1
  META_TIMINGS.videoMaxWaitMs = 100
})
afterEach(() => Object.assign(META_TIMINGS, saved))

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3, 4])

describe("uploadMetaMedia", () => {
  it("uploads the pre-fetched bytes as base64 (multipart) to /adimages", async () => {
    const m = mockGraph([
      ["POST", "act_1001/adimages", () => json({ images: { bytes: { hash: "abc123hash", url: "https://scontent.example/x.png" } } })],
    ])
    const ref = await uploadMetaMedia(providerCtx(), { type: "image", url: "https://cdn.example.com/a.png", bytes: PNG, contentType: "image/png" })
    expect(ref).toEqual({ type: "image", id: "abc123hash", url: "https://scontent.example/x.png" })
    const post = m.calls.find((c) => c.method === "POST")!
    expect(post.multipart).toBe(true)
    expect(post.params.bytes).toBe(Buffer.from(PNG).toString("base64"))
    expect(post.params.url).toBeUndefined()
  })

  it("refuses an image without pre-fetched bytes and never fetches the URL itself (no unguarded download)", async () => {
    const m = mockGraph([
      ["GET", "https://cdn.example.com/a.png", () => ({ raw: PNG, headers: { "content-type": "image/png" } })],
      ["POST", "act_1001/adimages", () => json({ images: { bytes: { hash: "never", url: null } } })],
    ])
    await expect(uploadMetaMedia(providerCtx(), { type: "image", url: "https://cdn.example.com/a.png" })).rejects.toMatchObject({
      code: "invalid_request",
      userMessageVi: expect.stringMatching(/bộ lọc an toàn/),
    })
    expect(m.calls).toHaveLength(0)
  })

  it("uses bytes pre-fetched by mcp-core and never fetches the URL itself (no DNS-rebinding window)", async () => {
    const m = mockGraph([["POST", "act_1001/adimages", () => json({ images: { bytes: { hash: "h2", url: null } } })]])
    const ref = await uploadMetaMedia(providerCtx(), { type: "image", url: "https://rebind.example/a.png", bytes: PNG, contentType: "image/png" })
    expect(ref.id).toBe("h2")
    expect(m.calls.some((c) => String(c.url ?? c.path ?? "").includes("rebind.example"))).toBe(false)
    expect(m.calls).toHaveLength(1)
    expect(m.calls[0].params.bytes).toBe(Buffer.from(PNG).toString("base64"))
    // pre-fetched bytes are still checked
    await expect(
      uploadMetaMedia(providerCtx(), { type: "image", url: "https://rebind.example/a.png", bytes: new TextEncoder().encode("<html>"), contentType: "text/html" })
    ).rejects.toMatchObject({ code: "invalid_request" })
  })

  it("refuses oversized pre-fetched bytes", async () => {
    const m = mockGraph([["POST", "act_1001/adimages", () => json({ images: { bytes: { hash: "never", url: null } } })]])
    const big = new Uint8Array(30 * 1024 * 1024 + 1)
    big.set(PNG)
    await expect(uploadMetaMedia(providerCtx(), { type: "image", url: "https://cdn.example.com/big.png", bytes: big, contentType: "image/png" })).rejects.toMatchObject({
      code: "invalid_request",
      userMessageVi: expect.stringMatching(/quá lớn/),
    })
    expect(m.calls).toHaveLength(0)
  })

  it("refuses non-image content even when the server claims image/*", async () => {
    mockGraph([])
    await expect(
      uploadMetaMedia(providerCtx(), { type: "image", url: "https://cdn.example.com/a.png", bytes: new TextEncoder().encode("<html></html>"), contentType: "image/png" })
    ).rejects.toMatchObject({ code: "invalid_request" })
  })

  it("video: posts file_url and polls status until ready", async () => {
    let polls = 0
    const m = mockGraph([
      ["POST", "act_1001/advideos", () => json({ id: "555" })],
      ["GET", "555", () => json({ status: { video_status: ++polls < 2 ? "processing" : "ready" } })],
    ])
    const ref = await uploadMetaMedia(providerCtx(), { type: "video", url: "https://cdn.example.com/v.mp4", name: "Clip" })
    expect(ref).toEqual({ type: "video", id: "555", url: null })
    expect(m.calls[0].params).toMatchObject({ file_url: "https://cdn.example.com/v.mp4", name: "Clip" })
    expect(polls).toBe(2)
  })
})


describe("uploadMetaMedia - Drive inputs (fileName, maxWaitMs, processing)", () => {
  it("image bytes do not need an http(s) URL (informational only)", async () => {
    const m = mockGraph([["POST", "act_1001/adimages", () => json({ images: { bytes: { hash: "h3", url: null } } })]])
    const ref = await uploadMetaMedia(providerCtx(), { type: "image", url: "drive:1AbC", bytes: PNG, contentType: "image/png", fileName: "a.png" })
    expect(ref).toEqual({ type: "image", id: "h3", url: null })
    expect(m.calls).toHaveLength(1)
  })

  it("video still requires an http(s) URL", async () => {
    const m = mockGraph([])
    await expect(uploadMetaMedia(providerCtx(), { type: "video", url: "drive:1AbC" })).rejects.toMatchObject({ code: "invalid_request" })
    expect(m.calls).toHaveLength(0)
  })

  it("video: falls back to fileName for the library name", async () => {
    const m = mockGraph([
      ["POST", "act_1001/advideos", () => json({ id: "556" })],
      ["GET", "556", () => json({ status: { video_status: "ready" } })],
    ])
    await uploadMetaMedia(providerCtx(), { type: "video", url: "https://app.example.com/dl/adr_x/clip.mp4", fileName: "clip.mp4" })
    expect(m.calls[0].params).toMatchObject({ file_url: "https://app.example.com/dl/adr_x/clip.mp4", name: "clip.mp4" })
  })

  it("video: honours maxWaitMs and returns processing: true when Meta is still processing", async () => {
    META_TIMINGS.videoMaxWaitMs = 60_000
    META_TIMINGS.pollIntervalMs = 10
    const m = mockGraph([
      ["POST", "act_1001/advideos", () => json({ id: "557" })],
      ["GET", "557", () => json({ status: { video_status: "processing" } })],
    ])
    const started = Date.now()
    const ref = await uploadMetaMedia(providerCtx(), { type: "video", url: "https://cdn.example.com/v.mp4", maxWaitMs: 50 })
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(ref).toEqual({ type: "video", id: "557", url: null, processing: true })
    expect(m.calls.filter((c) => c.method === "GET").length).toBeGreaterThanOrEqual(2)
  })

  it("video: maxWaitMs <= 0 skips polling", async () => {
    const m = mockGraph([["POST", "act_1001/advideos", () => json({ id: "558" })]])
    const ref = await uploadMetaMedia(providerCtx(), { type: "video", url: "https://cdn.example.com/v.mp4", maxWaitMs: 0 })
    expect(ref).toEqual({ type: "video", id: "558", url: null, processing: true })
    expect(m.calls).toHaveLength(1)
  })

  it("video: default budget (META_TIMINGS.videoMaxWaitMs) when maxWaitMs is omitted", async () => {
    META_TIMINGS.videoMaxWaitMs = 30
    META_TIMINGS.pollIntervalMs = 10
    mockGraph([
      ["POST", "act_1001/advideos", () => json({ id: "559" })],
      ["GET", "559", () => json({ status: { video_status: "processing" } })],
    ])
    const ref = await uploadMetaMedia(providerCtx(), { type: "video", url: "https://cdn.example.com/v.mp4" })
    expect(ref.processing).toBe(true)
  })
})
