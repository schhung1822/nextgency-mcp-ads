import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { __resetBuckets } from "../rate-limit"
import { __clearTokenCache } from "./auth"
import { uploadMedia } from "./media"
import { mockFetch, providerCtx, saCredentials } from "./__fixtures__/mock-fetch"

beforeEach(() => {
  __clearTokenCache()
  __resetBuckets()
})
afterEach(() => vi.unstubAllGlobals())

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])

describe("google ads uploadMedia with pre-fetched bytes", () => {
  it("refuses without bytes (never downloads the URL itself)", async () => {
    const m = mockFetch()
    await expect(uploadMedia(providerCtx(saCredentials()), { type: "image", url: "https://x.example/a.png" })).rejects.toMatchObject({
      code: "invalid_request",
      userMessageVi: "Lỗi nội bộ: ảnh chưa được tải qua bộ lọc an toàn.",
    })
    expect(m.calls).toHaveLength(0)
  })

  it("uploads the bytes handed over by mcp-core and never fetches the URL", async () => {
    const m = mockFetch()
    m.on((c) => c.url.endsWith("/assets:mutate"), { body: { results: [{ resourceName: "customers/1234567890/assets/77" }] } })
    const ref = await uploadMedia(providerCtx(saCredentials()), { type: "image", url: "https://rebind.example/a.png", bytes: PNG, contentType: "image/png" })
    expect(ref.id).toBe("customers/1234567890/assets/77")
    expect(m.calls.some((c) => c.url.includes("rebind.example"))).toBe(false)
    const mutate = m.api().find((c) => c.url.endsWith("/assets:mutate"))!
    expect(JSON.stringify(mutate.body)).toContain(Buffer.from(PNG).toString("base64"))
  })

  it("still validates pre-fetched bytes (type and 5 MB limit)", async () => {
    mockFetch()
    await expect(
      uploadMedia(providerCtx(saCredentials()), { type: "image", url: "https://x.example/a", bytes: new TextEncoder().encode("<svg/>") })
    ).rejects.toMatchObject({ code: "invalid_request" })
    const big = new Uint8Array(5 * 1024 * 1024 + 1)
    big.set(PNG)
    await expect(uploadMedia(providerCtx(saCredentials()), { type: "image", url: "https://x.example/a", bytes: big })).rejects.toMatchObject({
      code: "invalid_request",
    })
  })
})
