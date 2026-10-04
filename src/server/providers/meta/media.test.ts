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
  it("downloads the image itself and uploads base64 bytes (multipart) to /adimages", async () => {
    const m = mockGraph([
      ["GET", "https://cdn.example.com/a.png", () => ({ raw: PNG, headers: { "content-type": "image/png" } })],
      ["POST", "act_1001/adimages", () => json({ images: { bytes: { hash: "abc123hash", url: "https://scontent.example/x.png" } } })],
    ])
    const ref = await uploadMetaMedia(providerCtx(), { type: "image", url: "https://cdn.example.com/a.png" })
    expect(ref).toEqual({ type: "image", id: "abc123hash", url: "https://scontent.example/x.png" })
    const post = m.calls.find((c) => c.method === "POST")!
    expect(post.multipart).toBe(true)
    expect(post.params.bytes).toBe(Buffer.from(PNG).toString("base64"))
    expect(post.params.url).toBeUndefined()
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

  it("refuses redirects (SSRF guard bypass) and oversized files", async () => {
    mockGraph([
      ["GET", "https://cdn.example.com/r.png", () => ({ status: 302, headers: { location: "http://169.254.169.254/" }, raw: new Uint8Array() })],
      ["GET", "https://cdn.example.com/big.png", () => ({ raw: PNG, headers: { "content-type": "image/png", "content-length": String(31 * 1024 * 1024) } })],
    ])
    await expect(uploadMetaMedia(providerCtx(), { type: "image", url: "https://cdn.example.com/r.png" })).rejects.toMatchObject({ code: "invalid_request" })
    await expect(uploadMetaMedia(providerCtx(), { type: "image", url: "https://cdn.example.com/big.png" })).rejects.toMatchObject({
      userMessageVi: expect.stringMatching(/quá lớn/),
    })
  })

  it("refuses non-image content", async () => {
    mockGraph([["GET", "https://cdn.example.com/a.html", () => ({ raw: new TextEncoder().encode("<html></html>"), headers: { "content-type": "text/html" } })]])
    await expect(uploadMetaMedia(providerCtx(), { type: "image", url: "https://cdn.example.com/a.html" })).rejects.toMatchObject({ code: "invalid_request" })
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

