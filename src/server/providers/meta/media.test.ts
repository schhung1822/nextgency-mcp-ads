import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { __resetBuckets } from "../rate-limit"
import { isProviderError } from "../errors"
import { MEDIA_DEADLINE } from "../media-deadline"
import { META_TIMINGS } from "./client"
import {
  classifyVideoStatus,
  getMetaMediaStatus,
  META_VIDEO,
  metaVideoCoverUri,
  uniqueVideoName,
  uploadMetaCoverFromUri,
  uploadMetaMedia,
} from "./media"
import { graphError, json, mockGraph, providerCtx } from "./test-utils"

const saved = { ...META_TIMINGS }
const savedVideo = { ...META_VIDEO }
const savedDeadline = { ...MEDIA_DEADLINE }
beforeEach(() => {
  __resetBuckets()
  META_TIMINGS.pollIntervalMs = 1
  META_TIMINGS.videoMaxWaitMs = 100
})
afterEach(() => {
  Object.assign(META_TIMINGS, saved)
  Object.assign(META_VIDEO, savedVideo)
  Object.assign(MEDIA_DEADLINE, savedDeadline)
  vi.unstubAllGlobals()
})

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
    expect(m.calls[0].params.file_url).toBe("https://cdn.example.com/v.mp4")
    // D8: unique, recognisable library name sent as name AND title
    expect(m.calls[0].params.name).toMatch(/^Clip · [0-9a-f]{6}$/)
    expect(m.calls[0].params.title).toBe(m.calls[0].params.name)
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
    expect(m.calls[0].params.file_url).toBe("https://app.example.com/dl/adr_x/clip.mp4")
    expect(m.calls[0].params.name).toMatch(/^clip\.mp4 · [0-9a-f]{6}$/)
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
/** Wrap the installed fetch mock: matching requests hang until their signal aborts (a create call that times out). */
function hangWhen(pred: (url: string, init?: RequestInit) => boolean) {
  const inner = globalThis.fetch;
  const wrapped = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (pred(url, init)) {
      return new Promise<Response>((_, reject) => {
        const s = init?.signal;
        if (s?.aborted) return reject(s.reason);
        s?.addEventListener("abort", () => reject(s.reason));
      });
    }
    return inner(input, init);
  });
  vi.stubGlobal("fetch", wrapped);
  return wrapped;
}

const isVideoCreate = (url: string, init?: RequestInit) =>
  (init?.method ?? "GET") === "POST" && url.includes("/advideos");

describe("uploadMetaMedia - unique name + recovery after an ambiguous timeout (D8)", () => {
  beforeEach(() => {
    MEDIA_DEADLINE.marginMs = 0;
    MEDIA_DEADLINE.minCreateCallMs = 10;
    META_VIDEO.recoveryLookupMs = 2_000;
  });

  it("uniqueVideoName: recognisable base + 6 hex chars, different every time, ≤ 255 chars", () => {
    const a = uniqueVideoName("Clip hè 2026");
    const b = uniqueVideoName("Clip hè 2026");
    expect(a).toMatch(/^Clip hè 2026 · [0-9a-f]{6}$/);
    expect(a).not.toBe(b);
    expect(uniqueVideoName(undefined)).toMatch(/^video · [0-9a-f]{6}$/);
    expect(uniqueVideoName("x".repeat(400)).length).toBeLessThanOrEqual(255);
  });

  it("timeout → the video is found again by its unique title: id + recovered: true, the create call is never re-sent", async () => {
    let lookedUp: Record<string, string> | null = null;
    mockGraph([
      [
        "GET",
        "act_1001/advideos",
        (c) => {
          lookedUp = c.params;
          return json({
            data: [
              {
                id: "901",
                title: c.params.title,
                created_time: new Date()
                  .toISOString()
                  .replace(/\.\d+Z$/, "+0000"),
              },
              {
                id: "902",
                title: `${c.params.title} (copy)`,
                created_time: new Date().toISOString(),
              },
            ],
          });
        },
      ],
    ]);
    const f = hangWhen(isVideoCreate);
    const ref = await uploadMetaMedia(providerCtx(), {
      type: "video",
      url: "https://app.example.com/dl/adr_x/clip.mp4",
      fileName: "clip.mp4",
      deadlineAt: Date.now() + 80,
    });
    expect(ref).toEqual({
      type: "video",
      id: "901",
      url: null,
      processing: true,
      recovered: true,
    });
    expect(lookedUp!.title).toMatch(/^clip\.mp4 · [0-9a-f]{6}$/);
    expect(lookedUp!.fields).toBe("id,title,created_time");
    const creates = f.mock.calls.filter(([u, i]) =>
      isVideoCreate(String(u), i),
    );
    expect(creates).toHaveLength(1);
  });

  it("timeout + no single match (none, several, too old, lookup error) → the usual 'có thể đã tạo' error", async () => {
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    const answers: ((title: string) => unknown)[] = [
      () => json({ data: [] }),
      // S-L4: a single title match without a (valid) created_time is not taken
      (t) => json({ data: [{ id: "4", title: t }] }),
      (t) => json({ data: [{ id: "5", title: t, created_time: "not a date" }] }),
      (t) =>
        json({
          data: [
            { id: "1", title: t },
            { id: "2", title: t },
          ],
        }),
      (t) => json({ data: [{ id: "3", title: t, created_time: old }] }),
      () => graphError(100, 1),
    ];
    for (const answer of answers) {
      mockGraph([
        [
          "GET",
          "act_1001/advideos",
          (c) => answer(c.params.title) as ReturnType<typeof json>,
        ],
      ]);
      hangWhen(isVideoCreate);
      await expect(
        uploadMetaMedia(providerCtx(), {
          type: "video",
          url: "https://cdn.example.com/v.mp4",
          deadlineAt: Date.now() + 80,
        }),
      ).rejects.toMatchObject({
        code: "timeout",
        retryable: false,
        userMessageVi: expect.stringMatching(/có thể đã tạo/),
      });
      vi.unstubAllGlobals();
    }
  });
});

describe("video status (D7)", () => {
  it("classifyVideoStatus: ready / processing (+progress) / error with phase messages / expired / unknown", () => {
    expect(classifyVideoStatus({ video_status: "ready" })).toMatchObject({
      kind: "ready",
      progress: 100,
    });
    expect(
      classifyVideoStatus({
        video_status: "processing",
        processing_progress: 42.4,
      }),
    ).toMatchObject({
      kind: "processing",
      progress: 42,
    });
    const err = classifyVideoStatus({
      video_status: "error",
      processing_phase: {
        status: "error",
        errors: [
          {
            code: 1,
            message: "Resolution too low see https://x.example/a?sig=1",
          },
        ],
      },
    });
    expect(err.kind).toBe("failed");
    expect(err.error).toContain("Resolution too low");
    expect(err.error).not.toContain("https://");
    expect(classifyVideoStatus({ video_status: "expired" })).toMatchObject({
      kind: "failed",
      error: expect.stringMatching(/hết hạn/),
    });
    // a phase in error while video_status still says processing
    expect(
      classifyVideoStatus({
        video_status: "processing",
        uploading_phase: { status: "error" },
      }).kind,
    ).toBe("failed");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      classifyVideoStatus({ video_status: "upload_failed_new" }).kind,
    ).toBe("processing");
    expect(classifyVideoStatus(undefined).kind).toBe("processing");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("polling: an expired video fails fast with video_failed (no wait until the deadline)", async () => {
    META_TIMINGS.videoMaxWaitMs = 60_000;
    mockGraph([
      ["POST", "act_1001/advideos", () => json({ id: "560" })],
      ["GET", "560", () => json({ status: { video_status: "expired" } })],
    ]);
    const started = Date.now();
    const e = await uploadMetaMedia(providerCtx(), {
      type: "video",
      url: "https://cdn.example.com/v.mp4",
    }).catch((x: unknown) => x);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(isProviderError(e) && e.toJSON().code).toBe("video_failed");
    expect(isProviderError(e) && e.userMessageVi).toMatch(/hết hạn/);
  });

  it("polling: error carries Meta's phase error message; an unknown status keeps polling until ready", async () => {
    mockGraph([
      ["POST", "act_1001/advideos", () => json({ id: "561" })],
      [
        "GET",
        "561",
        () =>
          json({
            status: {
              video_status: "error",
              processing_phase: {
                status: "error",
                errors: [{ code: 7, message: "Video quá ngắn" }],
              },
            },
          }),
      ],
    ]);
    await expect(
      uploadMetaMedia(providerCtx(), {
        type: "video",
        url: "https://cdn.example.com/v.mp4",
      }),
    ).rejects.toMatchObject({
      userMessageVi: expect.stringContaining("Video quá ngắn"),
      toolCode: "video_failed",
    });
    let n = 0;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockGraph([
      ["POST", "act_1001/advideos", () => json({ id: "562" })],
      [
        "GET",
        "562",
        () =>
          json({
            status: { video_status: ++n < 3 ? "something_new" : "ready" },
          }),
      ],
    ]);
    expect(
      await uploadMetaMedia(providerCtx(), {
        type: "video",
        url: "https://cdn.example.com/v.mp4",
      }),
    ).toEqual({
      type: "video",
      id: "562",
      url: null,
    });
    warn.mockRestore();
  });

  it("getMetaMediaStatus: live status, progress, thumbnail presence; verifyAccount checks the account library", async () => {
    const m = mockGraph([
      [
        "GET",
        "700",
        () =>
          json({
            status: { video_status: "processing", processing_progress: 30 },
          }),
      ],
      [
        "GET",
        "701",
        () =>
          json({
            status: { video_status: "ready" },
            thumbnails: {
              data: [{ uri: "https://scontent.fbcdn.net/t.jpg?oh=1&oe=2" }],
            },
          }),
      ],
      ["GET", "702", () => json({ status: { video_status: "error" } })],
      [
        "GET",
        "act_1001/advideos",
        (c) =>
          json({
            data: c.params.filtering.includes("701") ? [{ id: "701" }] : [],
          }),
      ],
    ]);
    expect(
      await getMetaMediaStatus(providerCtx(), { type: "video", id: "700" }),
    ).toEqual({
      type: "video",
      id: "700",
      status: "processing",
      progressPercent: 30,
      error: null,
      hasThumbnail: null,
    });
    expect(m.calls.some((c) => c.path === "act_1001/advideos")).toBe(false);
    const ready = await getMetaMediaStatus(providerCtx(), {
      type: "video",
      id: "701",
      verifyAccount: true,
    });
    expect(ready).toMatchObject({ status: "ready", hasThumbnail: true });
    // the signed thumbnail URL is never part of the status
    expect(JSON.stringify(ready)).not.toContain("fbcdn");
    expect(
      JSON.parse(
        m.calls.find((c) => c.path === "act_1001/advideos")!.params.filtering,
      ),
    ).toEqual([{ field: "id", operator: "IN", value: ["701"] }]);
    expect(
      (await getMetaMediaStatus(providerCtx(), { type: "video", id: "702" }))
        .status,
    ).toBe("failed");
    await expect(
      getMetaMediaStatus(providerCtx(), {
        type: "video",
        id: "700",
        verifyAccount: true,
      }),
    ).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      getMetaMediaStatus(providerCtx(), { type: "video", id: "abc" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });
});

describe("automatic video cover (D1-D3)", () => {
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]);

  it("metaVideoCoverUri: preferred thumbnail, else the first, else picture of a READY video", async () => {
    mockGraph([
      [
        "GET",
        "800",
        () =>
          json({
            status: { video_status: "ready" },
            picture: "https://scontent.fbcdn.net/pic.jpg",
            thumbnails: {
              data: [
                { uri: "https://scontent.fbcdn.net/a.jpg" },
                { uri: "https://scontent.fbcdn.net/b.jpg", is_preferred: true },
              ],
            },
          }),
      ],
      [
        "GET",
        "801",
        () =>
          json({
            status: { video_status: "ready" },
            thumbnails: { data: [{ uri: "https://scontent.fbcdn.net/a.jpg" }] },
          }),
      ],
      [
        "GET",
        "802",
        () =>
          json({
            status: { video_status: "ready" },
            picture: "https://scontent.fbcdn.net/pic.jpg",
            thumbnails: { data: [] },
          }),
      ],
      [
        "GET",
        "803",
        () =>
          json({ status: { video_status: "ready" }, thumbnails: { data: [] } }),
      ],
    ]);
    expect(await metaVideoCoverUri(providerCtx(), "800")).toBe(
      "https://scontent.fbcdn.net/b.jpg",
    );
    expect(await metaVideoCoverUri(providerCtx(), "801")).toBe(
      "https://scontent.fbcdn.net/a.jpg",
    );
    expect(await metaVideoCoverUri(providerCtx(), "802")).toBe(
      "https://scontent.fbcdn.net/pic.jpg",
    );
    await expect(metaVideoCoverUri(providerCtx(), "803")).rejects.toMatchObject(
      { toolCode: "video_thumbnail_missing" },
    );
  });

  it("a processing video never yields Meta's placeholder picture: video_processing (with %); failed → video_failed", async () => {
    mockGraph([
      [
        "GET",
        "810",
        () =>
          json({
            status: { video_status: "processing", processing_progress: 55 },
            picture: "https://scontent.fbcdn.net/placeholder.jpg",
          }),
      ],
      ["GET", "811", () => json({ status: { video_status: "error" } })],
    ]);
    const e = await metaVideoCoverUri(providerCtx(), "810").catch(
      (x: unknown) => x,
    );
    expect(isProviderError(e) && e.toJSON()).toMatchObject({
      code: "video_processing",
      retryable: false,
    });
    expect(isProviderError(e) && e.userMessageVi).toContain("55%");
    await expect(metaVideoCoverUri(providerCtx(), "811")).rejects.toMatchObject(
      { toolCode: "video_failed" },
    );
  });

  it("uploadMetaCoverFromUri: downloads through opts.fetchImage (never fetch itself) and uploads the bytes → hash", async () => {
    const m = mockGraph([
      [
        "POST",
        "act_1001/adimages",
        () =>
          json({
            images: { bytes: { hash: "c0ffee00c0ffee00c0ffee00c0ffee00" } },
          }),
      ],
    ]);
    const fetchImage = vi.fn(async () => ({
      bytes: JPEG,
      contentType: "image/jpeg",
    }));
    const uri = "https://scontent.fbcdn.net/b.jpg?oh=abc&oe=def";
    expect(await uploadMetaCoverFromUri(providerCtx(), uri, fetchImage)).toBe(
      "c0ffee00c0ffee00c0ffee00c0ffee00",
    );
    expect(fetchImage).toHaveBeenCalledWith(uri, {
      maxBytes: 30 * 1024 * 1024,
    });
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]!.params.bytes).toBe(Buffer.from(JPEG).toString("base64"));
    expect(JSON.stringify(m.calls[0]!.params)).not.toContain("fbcdn");
  });

  it("a failed download → video_cover_failed without the uri; no fetchImage → refused before anything is sent", async () => {
    const m = mockGraph([]);
    const uri = "https://scontent.fbcdn.net/b.jpg?oh=SECRETSIG";
    const e = await uploadMetaCoverFromUri(providerCtx(), uri, async () => {
      throw new Error(`HTTP 403 for ${uri}`);
    }).catch((x: unknown) => x);
    expect(isProviderError(e) && e.toJSON().code).toBe("video_cover_failed");
    expect(JSON.stringify(isProviderError(e) && e.toJSON())).not.toContain(
      "SECRETSIG",
    );
    expect((e as Error).cause).toBeUndefined();
    await expect(
      uploadMetaCoverFromUri(providerCtx(), uri, undefined),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(m.calls).toHaveLength(0);
  });
});
