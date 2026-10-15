// v1.1.2: SSRF-guarded download of platform image URLs (Meta video thumbnails - D2, S-L2 host allowlist, C-M3 cover
// slot) and the Drive-ref handling of the generic extension wrapper (D5: logged as file ids, confirmation bound to the
// resolved file id + version - S-L5).
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("@/server/net/ssrf", async (orig) => {
  const mod = await orig<typeof import("@/server/net/ssrf")>()
  return { ...mod, safeFetch: vi.fn() }
})

import { safeFetch } from "@/server/net/ssrf"
import { withMediaSlot } from "@/server/net/media-slots"
import { fetchPlatformImage, withCoverSlot } from "../tools/common/upload-media"
import { bindDriveRef, extensionLogArgs } from "../tools/extensions"

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8])
const URI =
  "https://scontent.xx.fbcdn.net/v/t15/thumb.jpg?oh=SIGNED&oe=6720AB00"
const env = (mcpId = "mcp-cover-1") => ({
  signal: new AbortController().signal,
  grant: { mcpId } as never,
})
const ok = (finalUrl = URI) => ({
  status: 200,
  headers: {},
  finalUrl,
  body: JPEG,
})

describe("fetchPlatformImage (MutationOptions.fetchImage)", () => {
  beforeEach(() => vi.mocked(safeFetch).mockReset())

  it("one guarded GET: https only, size-capped, bounded by the call deadline; returns the bytes + sniffed type", async () => {
    vi.mocked(safeFetch).mockResolvedValue(ok())
    const e = env()
    const img = await fetchPlatformImage(e, Date.now() + 50_000)(URI, {
      maxBytes: 30 * 1024 * 1024,
    })
    expect(img.contentType).toBe("image/jpeg")
    expect(Buffer.from(img.bytes)).toEqual(JPEG)
    expect(safeFetch).toHaveBeenCalledTimes(1)
    expect(vi.mocked(safeFetch).mock.calls[0]![1]).toMatchObject({
      method: "GET",
      readBody: true,
      httpsOnly: true,
      maxBytes: 30 * 1024 * 1024,
      totalTimeoutMs: 20_000,
      signal: e.signal,
    })
    // close to the deadline: the download gets only what is left (≥ 1 s), the upload reserve is kept
    vi.mocked(safeFetch).mockClear()
    await fetchPlatformImage(e, Date.now() + 20_000)(URI, { maxBytes: 1024 })
    expect(
      (vi.mocked(safeFetch).mock.calls[0]![1] as { totalTimeoutMs: number })
        .totalTimeoutMs
    ).toBeLessThanOrEqual(5_000)
  })

  it("S-L2: only Meta CDN hosts, first URL and final hop (a redirect elsewhere is refused)", async () => {
    vi.mocked(safeFetch).mockResolvedValue(ok())
    for (const bad of [
      "https://evil.example/x.jpg",
      "http://scontent.xx.fbcdn.net/x.jpg",
      "https://fbcdn.net.evil.example/x.jpg",
    ]) {
      await expect(
        fetchPlatformImage(env(), Date.now() + 50_000)(bad, { maxBytes: 1024 })
      ).rejects.toMatchObject({ code: "url_not_allowed" })
    }
    expect(safeFetch).not.toHaveBeenCalled()
    vi.mocked(safeFetch).mockResolvedValueOnce(
      ok("https://attacker.example/landed.jpg")
    )
    await expect(
      fetchPlatformImage(env(), Date.now() + 50_000)(URI, { maxBytes: 1024 })
    ).rejects.toMatchObject({ code: "url_not_allowed" })
    for (const good of [
      "https://lookaside.facebook.com/x.jpg",
      "https://cdn.fbsbx.com/x.jpg",
    ]) {
      vi.mocked(safeFetch).mockResolvedValueOnce(ok(good))
      await expect(
        fetchPlatformImage(env(), Date.now() + 50_000)(good, { maxBytes: 1024 })
      ).resolves.toMatchObject({ contentType: "image/jpeg" })
    }
  })

  it("non-2xx, empty or non-image content is refused - the error never carries the URL", async () => {
    const answers = [
      { status: 403, headers: {}, finalUrl: URI, body: null },
      { status: 200, headers: {}, finalUrl: URI, body: Buffer.alloc(0) },
      {
        status: 200,
        headers: {},
        finalUrl: URI,
        body: Buffer.from("<html>nope</html>"),
      },
    ]
    for (const a of answers) {
      vi.mocked(safeFetch).mockResolvedValueOnce(a)
      const e = await fetchPlatformImage(env(), Date.now() + 50_000)(URI, {
        maxBytes: 1024,
      }).catch((x: unknown) => x)
      expect(e).toBeInstanceOf(Error)
      expect(
        JSON.stringify({ m: (e as Error).message, ...(e as object) })
      ).not.toContain("SIGNED")
    }
  })
})

describe("withCoverSlot (C-M3)", () => {
  it("does not share the MCP's ads_upload_media slot; waits for a parallel cover of the same MCP instead of failing at once", async () => {
    // an ads_upload_media of the same MCP holds the MCP key: a cover still runs
    let release!: () => void
    const upload = withMediaSlot(
      () => new Promise<void>((r) => (release = r)),
      { key: "mcp-slot-a" }
    )
    await expect(
      withCoverSlot("mcp-slot-a", Date.now() + 50_000, async () => "cover")
    ).resolves.toBe("cover")
    release()
    await upload
    // a cover in progress for the same MCP: the second one waits, then runs
    let releaseCover!: () => void
    const first = withCoverSlot(
      "mcp-slot-b",
      Date.now() + 50_000,
      () => new Promise<string>((r) => (releaseCover = () => r("one")))
    )
    setTimeout(() => releaseCover(), 300)
    await expect(
      withCoverSlot("mcp-slot-b", Date.now() + 50_000, async () => "two")
    ).resolves.toBe("two")
    await expect(first).resolves.toBe("one")
  })

  it("still busy when the wait ends → media_busy (rate_limited)", async () => {
    let release!: () => void
    const held = withCoverSlot(
      "mcp-slot-c",
      Date.now() + 50_000,
      () => new Promise<void>((r) => (release = r))
    )
    // deadline close: almost no wait allowed
    await expect(
      withCoverSlot("mcp-slot-c", Date.now() + 15_100, async () => 1)
    ).rejects.toMatchObject({ code: "media_busy", logStatus: "rate_limited" })
    release()
    await held
  })
})

describe("extension wrapper: Drive refs", () => {
  const FILE = "1AbCdEfGhIjKlMnOpQrStUvWxYz012345"
  const args = {
    account_id: "act_1",
    name: "QC",
    creative: {
      type: "video",
      video_id: "555",
      image_url: "https://cdn.example.com/a.jpg?token=abc",
      image_drive_file: `https://drive.google.com/file/d/${FILE}/view?resourcekey=0-SECRETRK`,
    },
  }

  it("logged args keep the Drive file id only (no resource key) and strip media URL queries", () => {
    const out = extensionLogArgs(args) as typeof args
    expect(out.creative.image_drive_file).toBe(FILE)
    expect(out.creative.image_url).toBe(
      "https://cdn.example.com/a.jpg?[redacted]"
    )
    expect(JSON.stringify(out)).not.toContain("SECRETRK")
    expect(
      extensionLogArgs({ creative: { image_drive_file: "drf_abc.def" } })
    ).toEqual({ creative: { image_drive_file: "drf_[redacted]" } })
  })

  it("confirmation args carry the resolved file id + version, whatever form the AI used; another version never matches (S-L5)", () => {
    const a = bindDriveRef(args, FILE, "md5abc:r1")
    const b = bindDriveRef(
      { ...args, creative: { ...args.creative, image_drive_file: FILE } },
      FILE,
      "md5abc:r1"
    )
    expect(a).toEqual(b)
    expect((a as typeof args).creative.image_drive_file).toBe(
      `drive:${FILE}@md5abc:r1`
    )
    expect((a as typeof args).creative.image_url).toBe(args.creative.image_url)
    expect(bindDriveRef(args, FILE, "md5zzz:r2")).not.toEqual(a)
  })
})

describe("tool error mapping of provider toolCodes (S-L1)", () => {
  it("payload.code = toolCode; log status and default hints follow the generic code; withErrorAudit keeps it", async () => {
    const { ProviderError, withErrorAudit } =
      await import("@/server/providers/errors")
    const { mapToolError } = await import("../errors")
    const pe = new ProviderError({
      platform: "meta",
      code: "not_found",
      toolCode: "video_missing_x",
      message: "x",
      userMessageVi: "Không thấy.",
    })
    const m = mapToolError(pe)
    expect(m.payload.code).toBe("video_missing_x")
    expect(m.payload.hint).toBe("Gọi ads_list_objects để lấy đúng id.")
    expect(m.logStatus).toBe("error")
    const inv = mapToolError(
      new ProviderError({
        platform: "meta",
        code: "invalid_request",
        toolCode: "video_processing",
        message: "p",
        userMessageVi: "Đang xử lý.",
      })
    )
    expect(inv.logStatus).toBe("invalid_request")
    expect(inv.payload.code).toBe("video_processing")
    const audited = withErrorAudit(pe, "meta", { errorCode: "x", changes: [] })
    expect(audited.toolCode).toBe("video_missing_x")
  })
})
