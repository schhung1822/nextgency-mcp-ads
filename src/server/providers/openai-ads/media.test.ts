import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { __resetBuckets } from "../rate-limit"
import { __setRetryDelayScale, type OpenAIAdsClientCtx } from "./client"
import {
  multipartFileName,
  OPENAI_IMAGE_MAX_BYTES,
  openaiImageType,
  uploadMedia,
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
const GIF = new Uint8Array([...Buffer.from("GIF89a"), 1, 2, 3, 4])

const API_KEY = "sk-ads-test-0123456789abcdef"
const ctx: OpenAIAdsClientCtx = {
  credentials: { apiKey: API_KEY } as OpenAIAdsClientCtx["credentials"],
}

interface Seen {
  url: string
  method: string
  headers: Headers
  body: unknown
}

function mockFetch(responder: (n: number) => Response) {
  const seen: Seen[] = []
  const fetchMock = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(input),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: init?.body,
      })
      return responder(seen.length)
    }
  )
  vi.stubGlobal("fetch", fetchMock)
  return seen
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-request-id": "req_1" },
  })
}

beforeEach(() => {
  __resetBuckets()
  __setRetryDelayScale(0)
})
afterEach(() => {
  __setRetryDelayScale(1)
  vi.unstubAllGlobals()
})

describe("openaiImageType / multipartFileName", () => {
  it("accepts JPEG, PNG and WebP only", () => {
    expect(openaiImageType(JPG)).toBe("image/jpeg")
    expect(openaiImageType(PNG)).toBe("image/png")
    expect(openaiImageType(WEBP)).toBe("image/webp")
    expect(openaiImageType(GIF)).toBeNull()
  })

  it("strips paths, quotes and control characters and fixes the extension", () => {
    expect(multipartFileName('../a/"Ảnh\r\nchính".PNG', "image/png")).toBe(
      "_Ảnh_chính_.png"
    )
    expect(multipartFileName("C:\\x\\banner.jpeg", "image/webp")).toBe(
      "banner.webp"
    )
    expect(multipartFileName(undefined, "image/jpeg")).toBe("image.jpg")
  })
})

describe("uploadMedia (OpenAI Ads) - bytes → multipart `file`", () => {
  it("posts multipart/form-data with only a binary `file` part; never sends or returns the URL", async () => {
    const seen = mockFetch(() => json({ file_id: "file_901" }))
    const ref = await uploadMedia(ctx, {
      type: "image",
      url: "https://drive.google.com/file/d/1Abc/view",
      bytes: PNG,
      fileName: "Banner.png",
    })
    expect(ref).toEqual({ type: "image", id: "file_901", url: null })
    expect(seen).toHaveLength(1)
    expect(seen[0].url).toBe("https://api.ads.openai.com/v1/upload")
    expect(seen[0].method).toBe("POST")
    expect(seen[0].headers.get("authorization")).toBe(`Bearer ${API_KEY}`)
    expect(seen[0].headers.get("content-type")).toBeNull() // boundary set by fetch
    const form = seen[0].body as FormData
    expect(form).toBeInstanceOf(FormData)
    expect([...form.keys()]).toEqual(["file"])
    const file = form.get("file") as File
    expect(file.name).toBe("Banner.png")
    expect(file.type).toBe("image/png")
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PNG)
    expect(JSON.stringify([...form.entries()].map(([k]) => k))).not.toContain(
      "image_url"
    )
  })

  it("refuses unsupported formats and oversized bytes without calling OpenAI", async () => {
    const seen = mockFetch(() => json({ file_id: "never" }))
    await expect(
      uploadMedia(ctx, { type: "image", url: "x", bytes: GIF })
    ).rejects.toMatchObject({
      code: "invalid_request",
      userMessageVi: expect.stringMatching(/JPEG\/PNG\/WebP/),
    })
    const big = new Uint8Array(OPENAI_IMAGE_MAX_BYTES + 1)
    big.set(JPG)
    await expect(
      uploadMedia(ctx, { type: "image", url: "x", bytes: big })
    ).rejects.toMatchObject({
      code: "invalid_request",
      userMessageVi: expect.stringMatching(/quá lớn/),
    })
    expect(seen).toHaveLength(0)
  })

  it("maps HTTP 413 to an image-size message", async () => {
    mockFetch(() =>
      json(
        {
          error: {
            message: "Request entity too large",
            type: "invalid_request_error",
            code: null,
          },
        },
        413
      )
    )
    await expect(
      uploadMedia(ctx, { type: "image", url: "x", bytes: JPG })
    ).rejects.toMatchObject({
      code: "invalid_request",
      userMessageVi: expect.stringMatching(/Ảnh quá lớn/),
    })
  })

  it("resends the same multipart body after a 429", async () => {
    const seen = mockFetch((n) =>
      n === 1
        ? json({ error: { message: "slow down", type: "rate_limit" } }, 429)
        : json({ file_id: "file_2" })
    )
    const ref = await uploadMedia(ctx, {
      type: "image",
      url: "x",
      bytes: WEBP,
      name: "Ảnh",
    })
    expect(ref.id).toBe("file_2")
    expect(seen).toHaveLength(2)
    expect(((seen[1].body as FormData).get("file") as File).name).toBe(
      "Ảnh.webp"
    )
  })

  it("is not retried blindly after a 5xx (the upload may have been stored)", async () => {
    const seen = mockFetch(() =>
      json({ error: { message: "oops", type: "server_error" } }, 500)
    )
    await expect(
      uploadMedia(ctx, { type: "image", url: "x", bytes: JPG })
    ).rejects.toMatchObject({ retryable: false })
    expect(seen).toHaveLength(1)
  })
})

describe("uploadMedia (OpenAI Ads) - URL path (unchanged)", () => {
  it("posts JSON {image_url} and returns the URL", async () => {
    const seen = mockFetch(() => json({ file_id: "file_u" }))
    const ref = await uploadMedia(ctx, {
      type: "image",
      url: "https://cdn.example.com/a.png",
    })
    expect(ref).toEqual({
      type: "image",
      id: "file_u",
      url: "https://cdn.example.com/a.png",
    })
    expect(seen[0].headers.get("content-type")).toBe("application/json")
    expect(JSON.parse(seen[0].body as string)).toEqual({
      image_url: "https://cdn.example.com/a.png",
    })
  })

  it("refuses videos (bytes or not) without calling OpenAI", async () => {
    const seen = mockFetch(() => json({ file_id: "never" }))
    await expect(
      uploadMedia(ctx, { type: "video", url: "https://x.example/v.mp4" })
    ).rejects.toMatchObject({ code: "unsupported" })
    await expect(
      uploadMedia(ctx, { type: "video", url: "x", bytes: JPG })
    ).rejects.toMatchObject({ code: "unsupported" })
    expect(seen).toHaveLength(0)
  })
})
