import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { MEDIA_DEADLINE, POLL_CALL_TIMEOUT } from "../media-deadline"
import { __resetBuckets } from "../rate-limit"
import type { ChunkedVideoUploadRequest } from "../types"
import { META_TIMINGS } from "./client"
import {
  META_CHUNKED,
  META_VIDEO,
  resendRange,
  uploadMetaMedia,
  uploadMetaVideoChunked,
} from "./media"
import {
  graphError,
  json,
  mockGraph,
  providerCtx,
  type RecordedCall,
} from "./test-utils"

const savedTimings = { ...META_TIMINGS }
const savedChunked = { ...META_CHUNKED }
const savedDeadline = { ...MEDIA_DEADLINE }
const savedPoll = { ...POLL_CALL_TIMEOUT }
const savedVideo = { ...META_VIDEO }
beforeEach(() => {
  __resetBuckets()
  META_TIMINGS.pollIntervalMs = 5
  META_TIMINGS.videoMaxWaitMs = 200
  META_CHUNKED.retryDelayMs = 1
  META_CHUNKED.readPieceBytes = 8
  MEDIA_DEADLINE.marginMs = 0
  MEDIA_DEADLINE.minCreateCallMs = 10
})
afterEach(() => {
  Object.assign(META_TIMINGS, savedTimings)
  Object.assign(META_CHUNKED, savedChunked)
  Object.assign(MEDIA_DEADLINE, savedDeadline)
  Object.assign(POLL_CALL_TIMEOUT, savedPoll)
  Object.assign(META_VIDEO, savedVideo)
  vi.unstubAllGlobals()
})

const FILE = Buffer.from(Array.from({ length: 50 }, (_, i) => i))

function request(over: Partial<ChunkedVideoUploadRequest> = {}) {
  const reads: [number, number][] = []
  const progress: number[] = []
  const r: ChunkedVideoUploadRequest = {
    fileName: "clip.mp4",
    sizeBytes: FILE.length,
    md5: null,
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

/** Offsets Meta returns after each transfer (strings like the real API). */
function nextRange(start: number): {
  start_offset: string
  end_offset: string
} {
  const s = Math.min(start + 20, FILE.length)
  return {
    start_offset: String(s),
    end_offset: String(Math.min(s + 20, FILE.length)),
  }
}

function phase(c: RecordedCall) {
  return c.params.upload_phase
}

/** FormData bodies the fetch mock received for transfer calls. */
function transferForms(fetchMock: ReturnType<typeof vi.fn>): FormData[] {
  return fetchMock.mock.calls
    .map((args) => (args[1] as RequestInit | undefined)?.body)
    .filter(
      (b): b is FormData =>
        b instanceof FormData && b.get("upload_phase") === "transfer"
    )
}

/** Wrap the installed fetch mock: matching requests hang until their signal aborts (timeouts). */
function hangWhen(pred: (url: string, init?: RequestInit) => boolean) {
  const inner = globalThis.fetch
  const wrapped = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    if (pred(url, init)) {
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

describe("uploadMetaVideoChunked - resumable upload_phase start/transfer/finish", () => {
  it("uploads every chunk at the offsets Meta returns, finishes with title, then polls status", async () => {
    const m = mockGraph([
      [
        "POST",
        "act_1001/advideos",
        (c) => {
          if (phase(c) === "start")
            return json({
              upload_session_id: "sess1",
              video_id: "vid1",
              start_offset: "0",
              end_offset: "20",
            })
          if (phase(c) === "transfer")
            return json(nextRange(Number(c.params.start_offset)))
          if (phase(c) === "finish") return json({ success: true })
          return json({ error: { message: "unexpected", code: 100 } }, 400)
        },
      ],
      ["GET", "vid1", () => json({ status: { video_status: "ready" } })],
    ])
    const { r, reads, progress } = request({ name: "Video tuần 41" })
    const ref = await uploadMetaVideoChunked(providerCtx(), r)
    expect(ref).toEqual({ type: "video", id: "vid1", url: null })

    const posts = m.calls.filter((c) => c.method === "POST")
    expect(posts.map(phase)).toEqual([
      "start",
      "transfer",
      "transfer",
      "transfer",
      "finish",
    ])
    expect(
      posts.every((c) => c.url.hostname === "graph-video.facebook.com")
    ).toBe(true)
    expect(posts[0].params).toMatchObject({
      upload_phase: "start",
      file_size: "50",
    })
    expect(posts.slice(1, 4).map((c) => c.params.start_offset)).toEqual([
      "0",
      "20",
      "40",
    ])
    expect(
      posts
        .slice(1, 4)
        .every((c) => c.multipart && c.params.upload_session_id === "sess1")
    ).toBe(true)
    expect(posts[4].params).toMatchObject({
      upload_phase: "finish",
      upload_session_id: "sess1",
      title: "Video tuần 41",
    })
    // read in pieces of readPieceBytes (8), exact ranges
    expect(reads[0]).toEqual([0, 8])
    expect(reads.at(-1)).toEqual([48, 50])
    // chunk bytes are exactly the requested range
    const forms = transferForms(m.fetchMock)
    const chunks = await Promise.all(
      forms.map(async (f) =>
        Buffer.from(await (f.get("video_file_chunk") as File).arrayBuffer())
      )
    )
    expect(chunks.map((b) => b.length)).toEqual([20, 20, 10])
    expect(Buffer.concat(chunks)).toEqual(FILE)
    expect((forms[0].get("video_file_chunk") as File).name).toBe("clip.mp4")
    expect(progress).toEqual([20, 40, 50, 50])
    // token never in the chunk form beyond the auth field
    expect(posts[1].params.access_token).toBeDefined()
  })

  it("re-sends the SAME chunk after a transient 5xx error (never restarts the upload)", async () => {
    let failOnce = true
    const m = mockGraph([
      [
        "POST",
        "act_1001/advideos",
        (c) => {
          if (phase(c) === "start")
            return json({
              upload_session_id: "s",
              video_id: "v2",
              start_offset: "0",
              end_offset: "20",
            })
          if (phase(c) === "transfer") {
            if (c.params.start_offset === "20" && failOnce) {
              failOnce = false
              return json(
                {
                  error: { message: "temporary", code: 2, is_transient: true },
                },
                500
              )
            }
            return json(nextRange(Number(c.params.start_offset)))
          }
          return json({ success: true })
        },
      ],
      ["GET", "v2", () => json({ status: { video_status: "ready" } })],
    ])
    const { r } = request()
    await uploadMetaVideoChunked(providerCtx(), r)
    const transfers = m.calls
      .filter((c) => phase(c) === "transfer")
      .map((c) => c.params.start_offset)
    expect(transfers).toEqual(["0", "20", "20", "40"])
    expect(m.calls.filter((c) => phase(c) === "start")).toHaveLength(1)
  })

  it("gives up after chunkRetries failures of one chunk, cancels the session and never finishes", async () => {
    const m = mockGraph([
      [
        "POST",
        "act_1001/advideos",
        (c) => {
          if (phase(c) === "start")
            return json({
              upload_session_id: "s",
              video_id: "v3",
              start_offset: "0",
              end_offset: "20",
            })
          if (phase(c) === "transfer")
            return json(
              { error: { message: "down", code: 2, is_transient: true } },
              500
            )
          return json({ success: true })
        },
      ],
    ])
    const { r } = request()
    await expect(
      uploadMetaVideoChunked(providerCtx(), r)
    ).rejects.toMatchObject({ code: "upstream_error" })
    expect(m.calls.filter((c) => phase(c) === "transfer")).toHaveLength(
      1 + META_CHUNKED.chunkRetries
    )
    expect(m.calls.filter((c) => phase(c) === "cancel")).toHaveLength(1)
    expect(m.calls.filter((c) => phase(c) === "finish")).toHaveLength(0)
  })

  it("does not retry a non-transient error (e.g. invalid parameter)", async () => {
    const m = mockGraph([
      [
        "POST",
        "act_1001/advideos",
        (c) => {
          if (phase(c) === "start")
            return json({
              upload_session_id: "s",
              video_id: "v4",
              start_offset: "0",
              end_offset: "20",
            })
          if (phase(c) === "transfer") return graphError(100)
          return json({ success: true })
        },
      ],
    ])
    await expect(
      uploadMetaVideoChunked(providerCtx(), request().r)
    ).rejects.toMatchObject({ code: "invalid_request" })
    expect(m.calls.filter((c) => phase(c) === "transfer")).toHaveLength(1)
    expect(m.calls.filter((c) => phase(c) === "cancel")).toHaveLength(1)
  })

  it("follows Meta's 1363037 range correction (error_data offsets)", async () => {
    let corrected = false
    const m = mockGraph([
      [
        "POST",
        "act_1001/advideos",
        (c) => {
          if (phase(c) === "start")
            return json({
              upload_session_id: "s",
              video_id: "v5",
              start_offset: "0",
              end_offset: "20",
            })
          if (phase(c) === "transfer") {
            if (c.params.start_offset === "20" && !corrected) {
              corrected = true
              return graphError(6001, 1363037, {
                error_data: JSON.stringify({
                  start_offset: "10",
                  end_offset: "30",
                }),
              })
            }
            const s = Number(c.params.start_offset)
            if (s === 10) return json({ start_offset: "30", end_offset: "50" })
            return json(nextRange(s))
          }
          return json({ success: true })
        },
      ],
      ["GET", "v5", () => json({ status: { video_status: "ready" } })],
    ])
    const { r, reads } = request()
    await uploadMetaVideoChunked(providerCtx(), r)
    expect(
      m.calls
        .filter((c) => phase(c) === "transfer")
        .map((c) => c.params.start_offset)
    ).toEqual(["0", "20", "10", "30"])
    expect(reads).toContainEqual([10, 18])
  })

  it("refuses offsets outside the file", async () => {
    mockGraph([
      [
        "POST",
        "act_1001/advideos",
        (c) => {
          if (phase(c) === "start")
            return json({
              upload_session_id: "s",
              video_id: "v6",
              start_offset: "0",
              end_offset: "999",
            })
          return json({ success: true })
        },
      ],
    ])
    await expect(
      uploadMetaVideoChunked(providerCtx(), request().r)
    ).rejects.toMatchObject({
      code: "upstream_error",
      userMessageVi: expect.stringMatching(/offset/),
    })
  })

  it("T-4: a chunk is capped at 64 MB - a larger range asked by Meta is refused before reading, the session cancelled", async () => {
    expect(savedChunked.maxChunkBytes).toBe(64 * 1024 * 1024)
    META_CHUNKED.maxChunkBytes = 16
    const m = mockGraph([
      [
        "POST",
        "act_1001/advideos",
        (c) => {
          if (phase(c) === "start")
            return json({
              upload_session_id: "s",
              video_id: "v7",
              start_offset: "0",
              end_offset: "20",
            })
          return json({ success: true })
        },
      ],
    ])
    const { r, reads } = request()
    await expect(uploadMetaVideoChunked(providerCtx(), r)).rejects.toMatchObject({
      code: "upstream_error",
    })
    expect(reads).toEqual([])
    const phases = m.calls.filter((c) => c.method === "POST").map(phase)
    expect(phases).toEqual(["start", "cancel"])
  })

  it("refuses a short read from the source (file changed)", async () => {
    mockGraph([
      [
        "POST",
        "act_1001/advideos",
        (c) =>
          phase(c) === "start"
            ? json({
                upload_session_id: "s",
                video_id: "v7",
                start_offset: "0",
                end_offset: "20",
              })
            : json({ success: true }),
      ],
    ])
    const { r } = request({ readChunk: async () => Buffer.alloc(3) })
    await expect(
      uploadMetaVideoChunked(providerCtx(), r)
    ).rejects.toMatchObject({ code: "upstream_error" })
  })

  it("returns processing: true when Meta is still processing at deadlineAt", async () => {
    META_TIMINGS.pollIntervalMs = 10
    mockGraph([
      [
        "POST",
        "act_1001/advideos",
        (c) => {
          if (phase(c) === "start")
            return json({
              upload_session_id: "s",
              video_id: "v8",
              start_offset: "0",
              end_offset: "50",
            })
          if (phase(c) === "transfer")
            return json({ start_offset: "50", end_offset: "50" })
          return json({ success: true })
        },
      ],
      ["GET", "v8", () => json({ status: { video_status: "processing" } })],
    ])
    META_CHUNKED.readPieceBytes = 64
    const started = Date.now()
    const ref = await uploadMetaVideoChunked(
      providerCtx(),
      request({ deadlineAt: Date.now() + 80 }).r
    )
    expect(ref).toEqual({
      type: "video",
      id: "v8",
      url: null,
      processing: true,
    })
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it("finish: a timed-out finish is retried and accepted when Meta already processes the video", async () => {
    META_CHUNKED.phaseTimeoutMs = 50
    let finishes = 0
    mockGraph([
      [
        "POST",
        "act_1001/advideos",
        (c) => {
          if (phase(c) === "start")
            return json({
              upload_session_id: "s",
              video_id: "v9",
              start_offset: "0",
              end_offset: "50",
            })
          if (phase(c) === "transfer")
            return json({ start_offset: "50", end_offset: "50" })
          finishes++
          return graphError(100) // the session is already finished
        },
      ],
      ["GET", "v9", () => json({ status: { video_status: "ready" } })],
    ])
    let hung = false
    hangWhen((_u, init) => {
      const b = init?.body
      if (
        !hung &&
        b instanceof URLSearchParams &&
        b.get("upload_phase") === "finish"
      ) {
        hung = true
        return true
      }
      return false
    })
    META_CHUNKED.readPieceBytes = 64
    const ref = await uploadMetaVideoChunked(providerCtx(), request().r)
    expect(ref).toEqual({ type: "video", id: "v9", url: null })
    expect(finishes).toBe(1)
  })

  it("rejects a bad size / non-video content type before calling Meta", async () => {
    const m = mockGraph([])
    await expect(
      uploadMetaVideoChunked(providerCtx(), request({ sizeBytes: 0 }).r)
    ).rejects.toMatchObject({ code: "invalid_request" })
    await expect(
      uploadMetaVideoChunked(
        providerCtx(),
        request({ contentType: "image/png" }).r
      )
    ).rejects.toMatchObject({
      code: "invalid_request",
    })
    expect(m.calls).toHaveLength(0)
  })

  it("is registered on the provider", async () => {
    const { metaProvider } = await import("./index")
    expect(metaProvider.uploadVideoChunked).toBe(uploadMetaVideoChunked)
  })
})

describe("resendRange", () => {
  it("parses error_data offsets only for subcode 1363037", () => {
    expect(
      resendRange({
        error_subcode: 1363037,
        error_data: { start_offset: "5", end_offset: "9" },
      })
    ).toEqual({ start: 5, end: 9 })
    expect(
      resendRange({
        error_subcode: 1363037,
        error_data: '{"start_offset":1,"end_offset":2}',
      })
    ).toEqual({ start: 1, end: 2 })
    expect(
      resendRange({ error_subcode: 1363037, error_data: "not json" })
    ).toBeNull()
    expect(
      resendRange({
        error_subcode: 33,
        error_data: { start_offset: "5", end_offset: "9" },
      })
    ).toBeNull()
  })
})

describe("uploadMetaMedia - deadlineAt", () => {
  const PNG = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3, 4,
  ])

  it("does not send the create call when the deadline is (almost) reached", async () => {
    const m = mockGraph([
      ["POST", "act_1001/advideos", () => json({ id: "1" })],
    ])
    await expect(
      uploadMetaMedia(providerCtx(), {
        type: "video",
        url: "https://cdn.example.com/v.mp4",
        deadlineAt: Date.now() + 5,
      })
    ).rejects.toMatchObject({
      code: "timeout",
      userMessageVi: expect.stringMatching(/chưa tạo/),
    })
    expect(m.calls).toHaveLength(0)
  })

  it("video create timing out at the deadline → 'có thể đã tạo' error, sent once (no retry)", async () => {
    // the recovery lookup by title (D8) hangs too here: it gives up after its own short timeout
    META_VIDEO.recoveryLookupMs = 50
    mockGraph([])
    const f = hangWhen(() => true)
    const started = Date.now()
    await expect(
      uploadMetaMedia(providerCtx(), {
        type: "video",
        url: "https://cdn.example.com/v.mp4",
        deadlineAt: Date.now() + 80,
      })
    ).rejects.toMatchObject({
      code: "timeout",
      retryable: false,
      userMessageVi: expect.stringMatching(/có thể đã tạo trên nền tảng/),
    })
    expect(Date.now() - started).toBeLessThan(2_000)
    // one create call (never re-sent) + one GET advideos?title= lookup
    expect(f).toHaveBeenCalledTimes(2)
    const [createUrl, createInit] = f.mock.calls[0]!
    expect(String(createUrl)).toContain("/act_1001/advideos")
    expect((createInit as RequestInit).method).toBe("POST")
    const lookup = new URL(String(f.mock.calls[1]![0]))
    expect(lookup.pathname).toMatch(/\/act_1001\/advideos$/)
    expect(lookup.searchParams.get("title")).toMatch(/ · [0-9a-f]{6}$/)
  })

  it("image create timing out → 'có thể đã tạo' error, sent once", async () => {
    mockGraph([])
    const f = hangWhen(() => true)
    await expect(
      uploadMetaMedia(providerCtx(), {
        type: "image",
        url: "drive:x",
        bytes: PNG,
        deadlineAt: Date.now() + 60,
      })
    ).rejects.toMatchObject({
      code: "timeout",
      userMessageVi: expect.stringMatching(/kiểm tra thư viện media/),
    })
    expect(f).toHaveBeenCalledTimes(1)
  })

  it("polling stops at deadlineAt even when maxWaitMs is larger", async () => {
    META_TIMINGS.pollIntervalMs = 10
    mockGraph([
      ["POST", "act_1001/advideos", () => json({ id: "77" })],
      ["GET", "77", () => json({ status: { video_status: "processing" } })],
    ])
    const started = Date.now()
    const ref = await uploadMetaMedia(providerCtx(), {
      type: "video",
      url: "https://cdn.example.com/v.mp4",
      maxWaitMs: 60_000,
      deadlineAt: Date.now() + 60,
    })
    expect(ref).toEqual({
      type: "video",
      id: "77",
      url: null,
      processing: true,
    })
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it("a slow status call returns the id with processing: true instead of failing", async () => {
    POLL_CALL_TIMEOUT.minMs = 20
    POLL_CALL_TIMEOUT.maxMs = 40
    mockGraph([["POST", "act_1001/advideos", () => json({ id: "78" })]])
    hangWhen((url) => url.includes("/78"))
    const ref = await uploadMetaMedia(providerCtx(), {
      type: "video",
      url: "https://cdn.example.com/v.mp4",
      deadlineAt: Date.now() + 5_000,
    })
    expect(ref).toEqual({
      type: "video",
      id: "78",
      url: null,
      processing: true,
    })
  })

  it("without deadlineAt the own timeout and maxWaitMs keep working", async () => {
    const m = mockGraph([
      ["POST", "act_1001/advideos", () => json({ id: "79" })],
      ["GET", "79", () => json({ status: { video_status: "ready" } })],
    ])
    const ref = await uploadMetaMedia(providerCtx(), {
      type: "video",
      url: "https://cdn.example.com/v.mp4",
      maxWaitMs: 100,
    })
    expect(ref).toEqual({ type: "video", id: "79", url: null })
    expect(m.calls).toHaveLength(2)
  })
})
