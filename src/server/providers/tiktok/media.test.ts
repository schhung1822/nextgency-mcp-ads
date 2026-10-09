import { createHash } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { __resetBuckets } from "../rate-limit"
import { fail, makeCtx, mockTikTok, ok } from "./__fixtures__/mock-fetch"
import {
  TIKTOK_IMAGE_MAX_BYTES,
  tiktokImageType,
  uploadTikTokMedia,
  VIDEO_POLL,
} from "./media"

const JPG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 3, 4, 5,
])
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3, 4,
])
const WEBP = new Uint8Array([
  ...Buffer.from("RIFF"),
  0,
  0,
  0,
  0,
  ...Buffer.from("WEBP"),
  1,
  2,
  3,
  4,
])

const saved = { ...VIDEO_POLL }
beforeEach(() => {
  __resetBuckets()
  VIDEO_POLL.intervalMs = 5
  VIDEO_POLL.timeoutMs = 200
})
afterEach(() => {
  Object.assign(VIDEO_POLL, saved)
  vi.unstubAllGlobals()
})

function formOf(m: ReturnType<typeof mockTikTok>, n = 0): FormData {
  const init = m.fetchMock.mock.calls[n][1] as RequestInit
  expect(init.body).toBeInstanceOf(FormData)
  return init.body as FormData
}

describe("tiktokImageType", () => {
  it("accepts JPEG and PNG only", () => {
    expect(tiktokImageType(JPG)).toBe("image/jpeg")
    expect(tiktokImageType(PNG)).toBe("image/png")
    expect(tiktokImageType(WEBP)).toBeNull()
    expect(tiktokImageType(new TextEncoder().encode("<html>"))).toBeNull()
  })
})

describe("uploadTikTokMedia - image bytes (UPLOAD_BY_FILE)", () => {
  it("posts multipart with advertiser_id, upload_type, file_name, MD5 image_signature and image_file; never fetches the URL", async () => {
    const m = mockTikTok({
      "POST /file/image/ad/upload/": ok({
        image_id: "ad-img-1",
        image_url: "https://p16.tiktokcdn.com/x.jpg",
      }),
    })
    const ref = await uploadTikTokMedia(makeCtx(), {
      type: "image",
      url: "drive:1AbCdEf",
      bytes: JPG,
      contentType: "image/jpeg",
      fileName: "Banner tuần 41.jpeg",
    })
    expect(ref).toEqual({
      type: "image",
      id: "ad-img-1",
      url: "https://p16.tiktokcdn.com/x.jpg",
    })
    expect(m.calls).toHaveLength(1)
    expect(m.calls[0].url).toMatch(
      /\/open_api\/v1\.3\/file\/image\/ad\/upload\/$/
    )
    expect(m.calls[0].headers["access-token"]).toBe("tok_test_abcdef123456")
    // fetch sets the multipart boundary itself - no JSON content-type forced
    expect(m.calls[0].headers["content-type"]).toBeUndefined()
    const form = formOf(m)
    expect(form.get("advertiser_id")).toBe("7100000000000000001")
    expect(form.get("upload_type")).toBe("UPLOAD_BY_FILE")
    expect(form.get("image_signature")).toBe(
      createHash("md5").update(JPG).digest("hex")
    )
    const fileName = form.get("file_name") as string
    expect(fileName).toMatch(/^Banner tuần 41_\d{14}_[0-9a-f]{6}$/)
    expect(fileName.length).toBeLessThanOrEqual(100)
    const file = form.get("image_file") as File
    expect(file).toBeInstanceOf(Blob)
    expect(file.name).toBe(`${fileName}.jpg`)
    expect(file.type).toBe("image/jpeg")
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(JPG)
    expect(form.get("image_url")).toBeNull()
    expect(m.calls.some((c) => c.url.includes("drive"))).toBe(false)
  })

  it("prefers the explicit name over fileName and uses the png extension for PNG bytes", async () => {
    const m = mockTikTok({
      "POST /file/image/ad/upload/": ok({ image_id: "img-2" }),
    })
    const ref = await uploadTikTokMedia(makeCtx(), {
      type: "image",
      url: "https://x.example/a",
      bytes: PNG,
      name: "Ảnh chính",
      fileName: "ignored.png",
    })
    expect(ref).toEqual({ type: "image", id: "img-2", url: null })
    const form = formOf(m)
    expect(form.get("file_name")).toMatch(/^Ảnh chính_/)
    expect((form.get("image_file") as File).name).toMatch(/\.png$/)
  })

  it("retries once with a fresh file_name on 40911 (duplicate name), rebuilding the form", async () => {
    const m = mockTikTok({
      "POST /file/image/ad/upload/": (_c: unknown, nth: number) =>
        nth === 0
          ? fail(40911, "file name duplicated")
          : ok({ image_id: "img-3" }),
    })
    const ref = await uploadTikTokMedia(makeCtx(), {
      type: "image",
      url: "x",
      bytes: JPG,
      fileName: "a.jpg",
    })
    expect(ref.id).toBe("img-3")
    expect(m.calls).toHaveLength(2)
    expect(formOf(m, 0).get("file_name")).not.toBe(
      formOf(m, 1).get("file_name")
    )
    expect(formOf(m, 1).get("image_signature")).toBe(
      formOf(m, 0).get("image_signature")
    )
  })

  it("refuses non JPG/PNG bytes (WebP) and oversized bytes without calling TikTok", async () => {
    const m = mockTikTok({
      "POST /file/image/ad/upload/": ok({ image_id: "never" }),
    })
    await expect(
      uploadTikTokMedia(makeCtx(), { type: "image", url: "x", bytes: WEBP })
    ).rejects.toMatchObject({
      code: "invalid_request",
      userMessageVi: expect.stringMatching(/JPG\/PNG/),
    })
    const big = new Uint8Array(TIKTOK_IMAGE_MAX_BYTES + 1)
    big.set(JPG)
    await expect(
      uploadTikTokMedia(makeCtx(), { type: "image", url: "x", bytes: big })
    ).rejects.toMatchObject({
      code: "invalid_request",
      userMessageVi: expect.stringMatching(/quá lớn/),
    })
    expect(m.calls).toHaveLength(0)
  })

  it("is not retried on a server error (upload may have been stored)", async () => {
    const m = mockTikTok({
      "POST /file/image/ad/upload/": fail(50000, "system error"),
    })
    await expect(
      uploadTikTokMedia(makeCtx(), { type: "image", url: "x", bytes: JPG })
    ).rejects.toMatchObject({ code: "upstream_error" })
    expect(m.calls).toHaveLength(1)
  })
})

describe("uploadTikTokMedia - URL paths (unchanged)", () => {
  it("image without bytes: JSON UPLOAD_BY_URL with image_url", async () => {
    const m = mockTikTok({
      "POST /file/image/ad/upload/": ok({
        image_id: "img-u",
        image_url: "https://p16/x.jpg",
      }),
    })
    const ref = await uploadTikTokMedia(makeCtx(), {
      type: "image",
      url: "https://cdn.example.com/pic.jpg",
    })
    expect(ref).toEqual({
      type: "image",
      id: "img-u",
      url: "https://p16/x.jpg",
    })
    expect(m.calls[0].body).toMatchObject({
      advertiser_id: "7100000000000000001",
      upload_type: "UPLOAD_BY_URL",
      image_url: "https://cdn.example.com/pic.jpg",
    })
    expect(m.calls[0].body?.file_name).toMatch(/^pic_\d{14}_[0-9a-f]{6}$/)
    expect(m.calls[0].headers["content-type"]).toBe("application/json")
  })

  it("refuses a non-http URL when there are no bytes", async () => {
    const m = mockTikTok({})
    await expect(
      uploadTikTokMedia(makeCtx(), { type: "image", url: "ftp://x/a.jpg" })
    ).rejects.toMatchObject({ code: "invalid_request" })
    expect(m.calls).toHaveLength(0)
  })

  it("video: UPLOAD_BY_URL with video_url (bytes ignored), then polls /file/video/ad/info/ until listed", async () => {
    const m = mockTikTok({
      "POST /file/video/ad/upload/": ok([
        { video_id: "v-1", video_cover_url: "https://p16/cover.jpg" },
      ]),
      "GET /file/video/ad/info/": (_c: unknown, nth: number) =>
        nth === 0
          ? fail(40901, "transcoding")
          : ok({
              list: [
                {
                  video_id: "v-1",
                  displayable: true,
                  preview_url: "https://p16/prev.mp4",
                },
              ],
            }),
    })
    const ref = await uploadTikTokMedia(makeCtx(), {
      type: "video",
      url: "https://app.example.com/dl/adr_x/clip.mp4",
      fileName: "clip.mp4",
      bytes: JPG,
    })
    expect(ref).toEqual({
      type: "video",
      id: "v-1",
      url: "https://p16/prev.mp4",
    })
    expect(ref.processing).toBeUndefined()
    const post = m.callsTo("POST /file/video/ad/upload/")[0]
    expect(post.body).toMatchObject({
      upload_type: "UPLOAD_BY_URL",
      video_url: "https://app.example.com/dl/adr_x/clip.mp4",
    })
    expect(post.body?.file_name).toMatch(/^clip_\d{14}_/)
    expect(m.callsTo("GET /file/video/ad/info/")).toHaveLength(2)
    expect(m.callsTo("GET /file/video/ad/info/")[0].query.video_ids).toEqual([
      "v-1",
    ])
  })
})

describe("uploadTikTokMedia - video wait budget (maxWaitMs)", () => {
  const routes = (displayable: boolean) => ({
    "POST /file/video/ad/upload/": ok([
      { video_id: "v-2", video_cover_url: "https://p16/cover.jpg" },
    ]),
    "GET /file/video/ad/info/": ok({
      list: displayable ? [{ video_id: "v-2", displayable: true }] : [],
    }),
  })

  it("returns processing: true with the id when the budget ends before transcoding finishes", async () => {
    VIDEO_POLL.intervalMs = 10
    const m = mockTikTok(routes(false))
    const started = Date.now()
    const ref = await uploadTikTokMedia(makeCtx(), {
      type: "video",
      url: "https://x.example/v.mp4",
      maxWaitMs: 60,
    })
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(ref).toEqual({
      type: "video",
      id: "v-2",
      url: "https://p16/cover.jpg",
      processing: true,
    })
    const polls = m.callsTo("GET /file/video/ad/info/").length
    expect(polls).toBeGreaterThanOrEqual(2)
    expect(polls).toBeLessThanOrEqual(10)
  })

  it("maxWaitMs <= 0: no polling at all", async () => {
    const m = mockTikTok(routes(true))
    const ref = await uploadTikTokMedia(makeCtx(), {
      type: "video",
      url: "https://x.example/v.mp4",
      maxWaitMs: 0,
    })
    expect(ref).toMatchObject({ id: "v-2", processing: true })
    expect(m.callsTo("GET /file/video/ad/info/")).toHaveLength(0)
  })

  it("without maxWaitMs uses the default budget (VIDEO_POLL.timeoutMs)", async () => {
    VIDEO_POLL.timeoutMs = 40
    VIDEO_POLL.intervalMs = 10
    mockTikTok(routes(false))
    const started = Date.now()
    const ref = await uploadTikTokMedia(makeCtx(), {
      type: "video",
      url: "https://x.example/v.mp4",
    })
    expect(ref.processing).toBe(true)
    expect(Date.now() - started).toBeGreaterThanOrEqual(35)
  })
})
