import { createHash } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { MEDIA_DEADLINE, POLL_CALL_TIMEOUT } from "../media-deadline"
import { __resetBuckets } from "../rate-limit"
import type { ChunkedVideoUploadRequest } from "../types"
import { fail, makeCtx, mockTikTok, ok } from "./__fixtures__/mock-fetch"
import {
  TIKTOK_CHUNKED,
  uploadTikTokMedia,
  uploadTikTokVideoChunked,
  VIDEO_POLL,
} from "./media"

const savedPoll = { ...VIDEO_POLL }
const savedChunked = { ...TIKTOK_CHUNKED }
const savedDeadline = { ...MEDIA_DEADLINE }
const savedPollCall = { ...POLL_CALL_TIMEOUT }
beforeEach(() => {
  __resetBuckets()
  VIDEO_POLL.intervalMs = 5
  VIDEO_POLL.timeoutMs = 200
  TIKTOK_CHUNKED.retryDelayMs = 1
  MEDIA_DEADLINE.marginMs = 0
  MEDIA_DEADLINE.minCreateCallMs = 10
})
afterEach(() => {
  Object.assign(VIDEO_POLL, savedPoll)
  Object.assign(TIKTOK_CHUNKED, savedChunked)
  Object.assign(MEDIA_DEADLINE, savedDeadline)
  Object.assign(POLL_CALL_TIMEOUT, savedPollCall)
  vi.unstubAllGlobals()
})

const FILE = Buffer.from(Array.from({ length: 50 }, (_, i) => 255 - i))
const md5 = (b: Uint8Array) => createHash("md5").update(b).digest("hex")

function request(over: Partial<ChunkedVideoUploadRequest> = {}) {
  const reads: [number, number][] = []
  const progress: number[] = []
  const r: ChunkedVideoUploadRequest = {
    fileName: "Quảng cáo 41.mp4",
    sizeBytes: FILE.length,
    md5: md5(FILE),
    contentType: "video/mp4",
    readChunk: async (s, e) => {
      reads.push([s, e])
      return FILE.subarray(s, e)
    },
    onProgress: (n) => progress.push(n),
    ...over,
  }
  return { r, reads, progress }
}

/** TikTok's transfer answer = offsets of the NEXT chunk (equal when done). */
function after(start: number) {
  const s = Math.min(start + 20, FILE.length)
  return ok({
    start_offset: s,
    end_offset: s === FILE.length ? s : Math.min(s + 20, FILE.length),
  })
}

function forms(m: ReturnType<typeof mockTikTok>): FormData[] {
  return m.fetchMock.mock.calls
    .filter((c) => String(c[0]).includes("/file/transfer/upload/"))
    .map((c) => (c[1] as RequestInit).body as FormData)
}

function startOffsetOf(m: ReturnType<typeof mockTikTok>, nth: number): number {
  return Number(forms(m)[nth]?.get("start_offset"))
}

function happyRoutes(
  transfer?: (nth: number, m: () => ReturnType<typeof mockTikTok>) => unknown
) {
  let ref: ReturnType<typeof mockTikTok> | null = null
  const routes = {
    "POST /file/start/upload/": ok({
      upload_id: "up-1",
      file_name: "x",
      start_offset: 0,
      end_offset: 20,
    }),
    "POST /file/transfer/upload/": (_c: unknown, nth: number) =>
      transfer ? transfer(nth, () => ref!) : after(startOffsetOf(ref!, nth)),
    "POST /file/finish/upload/": ok({
      file_id: "file-9",
      file_name: "x",
      size: 50,
    }),
    "POST /file/video/ad/upload/": ok([
      { video_id: "v-9", video_cover_url: "https://p16/cover.jpg" },
    ]),
    "GET /file/video/ad/info/": ok({
      list: [
        {
          video_id: "v-9",
          displayable: true,
          preview_url: "https://p16/p.mp4",
        },
      ],
    }),
  }
  ref = mockTikTok(routes)
  return ref
}

/** Matching requests hang until their signal aborts (timeouts). */
function hangWhen(pred: (url: string) => boolean) {
  const inner = globalThis.fetch
  const wrapped = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    if (pred(url)) {
      return new Promise<Response>((_, reject) => {
        const s = init?.signal
        if (s?.aborted) return reject(s.reason)
        s?.addEventListener("abort", () => reject(s.reason))
      })
    }
    return inner(input, init)
  })
  vi.stubGlobal("fetch", wrapped)
  return wrapped
}

describe("uploadTikTokVideoChunked - file/start → transfer → finish → UPLOAD_BY_FILE_ID", () => {
  it("uploads each chunk with its MD5 signature at TikTok's offsets, then creates the video from file_id", async () => {
    const m = happyRoutes()
    const { r, reads, progress } = request()
    const ref = await uploadTikTokVideoChunked(makeCtx(), r)
    expect(ref).toEqual({ type: "video", id: "v-9", url: "https://p16/p.mp4" })

    const start = m.callsTo("POST /file/start/upload/")[0]
    expect(start.body).toMatchObject({
      advertiser_id: "7100000000000000001",
      size: 50,
      content_type: "video",
    })
    expect(String(start.body?.name)).toMatch(
      /^Quảng cáo 41_\d{14}_[0-9a-f]{6}$/
    )
    expect(start.headers["access-token"]).toBe("tok_test_abcdef123456")

    const fs = forms(m)
    expect(fs.map((f) => f.get("start_offset"))).toEqual(["0", "20", "40"])
    const chunks = await Promise.all(
      fs.map(async (f) =>
        Buffer.from(await (f.get("file") as File).arrayBuffer())
      )
    )
    expect(Buffer.concat(chunks)).toEqual(FILE)
    fs.forEach((f, i) => {
      expect(f.get("advertiser_id")).toBe("7100000000000000001")
      expect(f.get("upload_id")).toBe("up-1")
      expect(f.get("signature")).toBe(md5(chunks[i]))
    })
    expect((fs[0].get("file") as File).name).toBe("Quảng cáo 41.mp4")
    expect(reads).toEqual([
      [0, 20],
      [20, 40],
      [40, 50],
    ])
    expect(progress).toEqual([20, 40, 50, 50])

    expect(m.callsTo("POST /file/finish/upload/")[0].body).toEqual({
      advertiser_id: "7100000000000000001",
      upload_id: "up-1",
    })
    const create = m.callsTo("POST /file/video/ad/upload/")[0]
    expect(create.body).toMatchObject({
      upload_type: "UPLOAD_BY_FILE_ID",
      file_id: "file-9",
    })
    expect(String(create.body?.file_name)).toMatch(/^Quảng cáo 41_/)
    expect(create.body?.video_url).toBeUndefined()
  })

  it("accepts the PascalCase keys shown in TikTok's start example", async () => {
    const routes = {
      "POST /file/start/upload/": ok({
        UploadId: "up-P",
        StartOffset: 0,
        EndOffset: 50,
      }),
      "POST /file/transfer/upload/": ok({ start_offset: 50, end_offset: 50 }),
      "POST /file/finish/upload/": ok({ file_id: "f-P" }),
      "POST /file/video/ad/upload/": ok([{ video_id: "v-P" }]),
      "GET /file/video/ad/info/": ok({
        list: [{ video_id: "v-P", displayable: true }],
      }),
    }
    const m2 = mockTikTok(routes)
    const ref = await uploadTikTokVideoChunked(makeCtx(), request().r)
    expect(ref.id).toBe("v-P")
    const f = m2.fetchMock.mock.calls.find((c) =>
      String(c[0]).includes("/file/transfer/upload/")
    )![1] as RequestInit
    expect((f.body as FormData).get("upload_id")).toBe("up-P")
  })

  it("re-sends the same chunk after a 5xx-class code or an MD5 mismatch (40900), never restarting the upload", async () => {
    const m = happyRoutes((nth, get) => {
      if (nth === 1) return fail(50000, "system error")
      if (nth === 2) return fail(40900, "signature mismatch")
      return after(startOffsetOf(get(), nth))
    })
    await uploadTikTokVideoChunked(makeCtx(), request().r)
    expect(forms(m).map((f) => f.get("start_offset"))).toEqual([
      "0",
      "20",
      "20",
      "20",
      "40",
    ])
    expect(m.callsTo("POST /file/start/upload/")).toHaveLength(1)
  })

  it("fails after chunkRetries re-sends of one chunk and never finishes", async () => {
    const m = happyRoutes(() => fail(50002, "busy"))
    await expect(
      uploadTikTokVideoChunked(makeCtx(), request().r)
    ).rejects.toMatchObject({ code: "upstream_error" })
    expect(forms(m)).toHaveLength(1 + TIKTOK_CHUNKED.chunkRetries)
    expect(m.callsTo("POST /file/finish/upload/")).toHaveLength(0)
    expect(m.callsTo("POST /file/video/ad/upload/")).toHaveLength(0)
  })

  it("does not retry a validation error", async () => {
    const m = happyRoutes(() => fail(40002, "bad param"))
    await expect(
      uploadTikTokVideoChunked(makeCtx(), request().r)
    ).rejects.toMatchObject({ code: "invalid_request" })
    expect(forms(m)).toHaveLength(1)
  })

  it("UPLOAD_BY_FILE_ID retries once with a fresh file_name on 40911", async () => {
    const routes = {
      "POST /file/start/upload/": ok({
        upload_id: "u",
        start_offset: 0,
        end_offset: 50,
      }),
      "POST /file/transfer/upload/": ok({ start_offset: 50, end_offset: 50 }),
      "POST /file/finish/upload/": ok({ file_id: "f" }),
      "POST /file/video/ad/upload/": (_c: unknown, nth: number) =>
        nth === 0 ? fail(40911, "dup") : ok([{ video_id: "v-d" }]),
      "GET /file/video/ad/info/": ok({ list: [{ video_id: "v-d" }] }),
    }
    const m2 = mockTikTok(routes)
    const ref = await uploadTikTokVideoChunked(makeCtx(), request().r)
    expect(ref.id).toBe("v-d")
    const creates = m2.callsTo("POST /file/video/ad/upload/")
    expect(creates).toHaveLength(2)
    expect(creates[0].body?.file_name).not.toBe(creates[1].body?.file_name)
  })

  it("UPLOAD_BY_FILE_ID timing out → 'có thể đã tạo' error, sent once (creates a new video_id each time)", async () => {
    TIKTOK_CHUNKED.phaseTimeoutMs = 60
    mockTikTok({
      "POST /file/start/upload/": ok({
        upload_id: "u",
        start_offset: 0,
        end_offset: 50,
      }),
      "POST /file/transfer/upload/": ok({ start_offset: 50, end_offset: 50 }),
      "POST /file/finish/upload/": ok({ file_id: "f" }),
    })
    const f = hangWhen((u) => u.includes("/file/video/ad/upload/"))
    await expect(
      uploadTikTokVideoChunked(makeCtx(), request().r)
    ).rejects.toMatchObject({
      code: "timeout",
      retryable: false,
      userMessageVi: expect.stringMatching(/có thể đã tạo trên nền tảng/),
    })
    expect(
      f.mock.calls.filter((c) =>
        String(c[0]).includes("/file/video/ad/upload/")
      )
    ).toHaveLength(1)
  })

  it("returns processing: true when transcoding is not done at deadlineAt", async () => {
    VIDEO_POLL.intervalMs = 10
    mockTikTok({
      "POST /file/start/upload/": ok({
        upload_id: "u",
        start_offset: 0,
        end_offset: 50,
      }),
      "POST /file/transfer/upload/": ok({ start_offset: 50, end_offset: 50 }),
      "POST /file/finish/upload/": ok({ file_id: "f" }),
      "POST /file/video/ad/upload/": ok([
        { video_id: "v-p", video_cover_url: "https://p16/c.jpg" },
      ]),
      "GET /file/video/ad/info/": fail(40901, "transcoding"),
    })
    const started = Date.now()
    const ref = await uploadTikTokVideoChunked(
      makeCtx(),
      request({ deadlineAt: Date.now() + 60 }).r
    )
    expect(ref).toEqual({
      type: "video",
      id: "v-p",
      url: "https://p16/c.jpg",
      processing: true,
    })
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it("refuses offsets outside the file and an invalid request without calling TikTok", async () => {
    mockTikTok({
      "POST /file/start/upload/": ok({
        upload_id: "u",
        start_offset: 0,
        end_offset: 999,
      }),
    })
    await expect(
      uploadTikTokVideoChunked(makeCtx(), request().r)
    ).rejects.toMatchObject({ code: "upstream_error" })
    const m = mockTikTok({})
    await expect(
      uploadTikTokVideoChunked(makeCtx(), request({ sizeBytes: -1 }).r)
    ).rejects.toMatchObject({ code: "invalid_request" })
    await expect(
      uploadTikTokVideoChunked(
        makeCtx(),
        request({ contentType: "text/html" }).r
      )
    ).rejects.toMatchObject({
      code: "invalid_request",
    })
    expect(m.calls).toHaveLength(0)
  })

  it("is registered on the provider", async () => {
    const { tiktokProvider } = await import("./index")
    expect(tiktokProvider.uploadVideoChunked).toBe(uploadTikTokVideoChunked)
  })
})

describe("uploadTikTokMedia - deadlineAt", () => {
  const JPG = new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 3, 4, 5,
  ])

  it("video URL upload timing out at the deadline → 'có thể đã tạo' error, no retry", async () => {
    mockTikTok({})
    const f = hangWhen(() => true)
    const started = Date.now()
    await expect(
      uploadTikTokMedia(makeCtx(), {
        type: "video",
        url: "https://x.example/v.mp4",
        deadlineAt: Date.now() + 80,
      })
    ).rejects.toMatchObject({
      code: "timeout",
      userMessageVi: expect.stringMatching(/kiểm tra thư viện media/),
    })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(f).toHaveBeenCalledTimes(1)
  })

  it("image bytes: no call at all when the deadline is (almost) reached", async () => {
    const m = mockTikTok({
      "POST /file/image/ad/upload/": ok({ image_id: "never" }),
    })
    await expect(
      uploadTikTokMedia(makeCtx(), {
        type: "image",
        url: "x",
        bytes: JPG,
        deadlineAt: Date.now() + 5,
      })
    ).rejects.toMatchObject({
      code: "timeout",
      userMessageVi: expect.stringMatching(/chưa tạo/),
    })
    expect(m.calls).toHaveLength(0)
  })

  it("image bytes timing out → 'có thể đã tạo' error, sent once", async () => {
    mockTikTok({})
    const f = hangWhen(() => true)
    await expect(
      uploadTikTokMedia(makeCtx(), {
        type: "image",
        url: "x",
        bytes: JPG,
        deadlineAt: Date.now() + 60,
      })
    ).rejects.toMatchObject({ code: "timeout", retryable: false })
    expect(f).toHaveBeenCalledTimes(1)
  })

  it("polling stops at deadlineAt even when maxWaitMs is larger", async () => {
    VIDEO_POLL.intervalMs = 10
    mockTikTok({
      "POST /file/video/ad/upload/": ok([{ video_id: "v-dl" }]),
      "GET /file/video/ad/info/": ok({ list: [] }),
    })
    const started = Date.now()
    const ref = await uploadTikTokMedia(makeCtx(), {
      type: "video",
      url: "https://x.example/v.mp4",
      maxWaitMs: 60_000,
      deadlineAt: Date.now() + 60,
    })
    expect(ref).toMatchObject({ id: "v-dl", processing: true })
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it("a slow status call returns the id with processing: true", async () => {
    POLL_CALL_TIMEOUT.minMs = 20
    POLL_CALL_TIMEOUT.maxMs = 40
    mockTikTok({ "POST /file/video/ad/upload/": ok([{ video_id: "v-slow" }]) })
    hangWhen((u) => u.includes("/file/video/ad/info/"))
    const ref = await uploadTikTokMedia(makeCtx(), {
      type: "video",
      url: "https://x.example/v.mp4",
      deadlineAt: Date.now() + 5_000,
    })
    expect(ref).toMatchObject({ id: "v-slow", processing: true })
  })
})
