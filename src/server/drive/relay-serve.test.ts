// /dl/<token>/<name> relay logic with the DB and Drive helpers mocked (no network, no DB).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { DEFAULT_MCP_SETTINGS, type McpGrant } from "../mcp/types"
import { DriveError } from "./errors"
import type { DriveRelayLinkRow } from "./store"
import type { DriveFile } from "./types"

vi.mock("./access-recheck", async (orig) => {
  const actual = await orig<typeof import("./access-recheck")>()
  return { ...actual, loadGrantForMcpId: vi.fn() }
})
vi.mock("./relay-guard", () => ({ isLiveRelayTokenHash: vi.fn() }))
vi.mock("./relay-links", async (orig) => {
  const actual = await orig<typeof import("./relay-links")>()
  return {
    ...actual,
    peekRelayToken: vi.fn(),
    consumeRelayToken: vi.fn(),
    decryptRelayResourceKey: vi.fn(() => "rk-1"),
  }
})
vi.mock("./store", () => ({
  loadDriveCredential: vi.fn(),
  isDriveCredentialUsable: (r: { deletedAt: Date | null; status: string }) =>
    !r.deletedAt && r.status !== "disabled",
  driveAuthForCredential: vi.fn(() => ({
    type: "service_account",
    sa: {},
    cacheKey: "drive_credential:c1",
  })),
  systemApiKeyAuth: vi.fn(),
}))
vi.mock("./files", async (orig) => {
  const actual = await orig<typeof import("./files")>()
  return {
    ...actual,
    getDriveFile: vi.fn(),
    openDriveDownload: vi.fn(),
    findAncestorIn: vi.fn(),
  }
})
vi.mock("./blocked", () => ({ loadBlockedFolderIds: vi.fn() }))

const recheck = await import("./access-recheck")
const guard = await import("./relay-guard")
const links = await import("./relay-links")
const store = await import("./store")
const files = await import("./files")
const blockedMod = await import("./blocked")
const { serveRelay, relayBody, relayRequestCountsAsFetch, RELAY_BASE_HEADERS } =
  await import("./relay-serve")
const {
  __resetRelayLimits,
  acquireRelayStream,
  relayStreamsInFlight,
  RELAY_LIMITS,
  reserveRelayBytes,
} = await import("./relay-limits")

const TOKEN = "adr_" + "A".repeat(43)
const NAME = "Video quảng cáo 01.mp4"
const URL_NAME = encodeURIComponent(NAME)

function row(over: Partial<DriveRelayLinkRow> = {}): DriveRelayLinkRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    tokenHash: links.hashRelayToken(TOKEN),
    mcpId: "m1",
    adAccountId: "a1",
    driveFileId: "FILEID1234567890",
    contentKey: "md5:abc:1000",
    access: "service_account",
    credentialId: "c1",
    sourceId: "s1",
    resourceKeyEncrypted: "v1.x",
    fileName: NAME,
    contentType: "video/mp4",
    sizeBytes: 1000,
    fetchCount: 1,
    maxFetches: 30,
    expiresAt: new Date(Date.now() + 3600_000),
    createdAt: new Date(),
    ...over,
  }
}

function grant(over: Partial<McpGrant> = {}): McpGrant {
  return {
    mcpId: "m1",
    mcpName: "MCP",
    ownerId: "u1",
    ownerEmail: "u1@example.test",
    ownerRole: "staff",
    settings: { ...DEFAULT_MCP_SETTINGS, drivePublicLinks: true },
    permissions: { meta: ["read", "create"] },
    accounts: [
      {
        id: "a1",
        connectionId: "conn1",
        platform: "meta",
        externalId: "act_1",
        name: "TKQC",
        currency: "VND",
        timezone: "Asia/Ho_Chi_Minh",
      },
    ],
    pages: [],
    notificationChannels: [],
    driveSources: [
      {
        id: "s1",
        kind: "folder",
        scope: "company",
        name: "Creative",
        googleId: "FOLDERID12345678",
        sheetGid: null,
        credentialId: "c1",
        ownerId: "admin1",
        status: "active",
        sharedDriveId: null,
        config: { recursiveDepth: 2 } as never,
      },
    ],
    drivePublicAvailable: true,
    apifyTokens: [],
    tiktokSocialAccounts: [],
    ...over,
  }
}

function driveFile(over: Partial<DriveFile> = {}): DriveFile {
  return {
    id: "FILEID1234567890",
    name: NAME,
    mimeType: "video/mp4",
    sizeBytes: 1000,
    md5: "abc",
    headRevisionId: null,
    version: "3",
    modifiedTime: null,
    parents: [],
    trashed: false,
    driveId: null,
    width: null,
    height: null,
    durationMs: null,
    canDownload: true,
    canEdit: false,
    resourceKey: null,
    shortcut: null,
    ...over,
  }
}

function bytes(n: number): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(n))
      c.close()
    },
  })
}

function fullDownload(n = 1000) {
  return {
    status: 200 as const,
    body: bytes(n),
    contentLength: n,
    contentRange: null,
    contentType: "video/mp4",
  }
}

function req(
  method: "GET" | "HEAD",
  headers: Record<string, string> = {},
  signal?: AbortSignal,
  ip = "203.0.113.7"
): Request {
  return new Request(`https://mcp.example.com/dl/${TOKEN}/${URL_NAME}`, {
    method,
    headers: { "x-forwarded-for": ip, ...headers },
    signal,
  })
}

const peek = vi.mocked(links.peekRelayToken)
const consume = vi.mocked(links.consumeRelayToken)
const getFile = vi.mocked(files.getDriveFile)
const openDl = vi.mocked(files.openDriveDownload)
const loadCred = vi.mocked(store.loadDriveCredential)
const apiKeyAuth = vi.mocked(store.systemApiKeyAuth)
const loadGrant = vi.mocked(recheck.loadGrantForMcpId)
const isLive = vi.mocked(guard.isLiveRelayTokenHash)
const ancestorIn = vi.mocked(files.findAncestorIn)
const loadBlocked = vi.mocked(blockedMod.loadBlockedFolderIds)

beforeEach(() => {
  __resetRelayLimits()
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
  peek.mockResolvedValue(row())
  consume.mockResolvedValue(row())
  loadGrant.mockResolvedValue(grant())
  isLive.mockResolvedValue(false)
  loadCred.mockResolvedValue({
    id: "c1",
    status: "active",
    deletedAt: null,
  } as never)
  apiKeyAuth.mockResolvedValue({
    type: "api_key",
    apiKey: "AIza" + "x".repeat(35),
  })
  getFile.mockResolvedValue(driveFile())
  openDl.mockImplementation(async () => fullDownload())
  ancestorIn.mockResolvedValue("FOLDERID12345678")
  loadBlocked.mockResolvedValue(new Set())
})

afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

function expectRelayHeaders(res: Response) {
  for (const [k, v] of Object.entries(RELAY_BASE_HEADERS))
    expect(res.headers.get(k), k).toBe(v)
}

describe("HEAD", () => {
  it("answers from the stored row without counting a fetch or calling Drive", async () => {
    const res = await serveRelay(req("HEAD"), TOKEN, NAME)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("video/mp4")
    expect(res.headers.get("content-length")).toBe("1000")
    expect(res.headers.get("accept-ranges")).toBe("bytes")
    expect(res.headers.get("content-md5")).toBeNull()
    expectRelayHeaders(res)
    expect(peek).toHaveBeenCalledWith(TOKEN)
    expect(consume).not.toHaveBeenCalled()
    expect(getFile).not.toHaveBeenCalled()
  })

  it("404 for an unknown / dead link or another name", async () => {
    peek.mockResolvedValueOnce(null)
    expect((await serveRelay(req("HEAD"), TOKEN, NAME)).status).toBe(404)
    expect((await serveRelay(req("HEAD"), TOKEN, "other.mp4")).status).toBe(404)
  })
})

describe("GET", () => {
  it("counts a fetch and streams the Drive body with the relay headers", async () => {
    const res = await serveRelay(req("GET"), TOKEN, NAME)
    expect(res.status).toBe(200)
    expect(consume).toHaveBeenCalledWith(TOKEN)
    expect(peek).not.toHaveBeenCalled()
    expect(res.headers.get("content-type")).toBe("video/mp4")
    expect(res.headers.get("content-length")).toBe("1000")
    expect(res.headers.get("accept-ranges")).toBe("bytes")
    expect(res.headers.get("content-range")).toBeNull()
    expect(res.headers.get("location")).toBeNull()
    expectRelayHeaders(res)
    expect((await res.arrayBuffer()).byteLength).toBe(1000)
    expect(relayStreamsInFlight().streams).toBe(0)
    expect(openDl).toHaveBeenCalledWith(
      expect.objectContaining({ type: "service_account" }),
      "FILEID1234567890",
      expect.objectContaining({ range: null, resourceKey: "rk-1" })
    )
    expect(loadGrant).toHaveBeenCalledWith("m1")
  })

  it("accepts the URL-encoded name segment", async () => {
    const res = await serveRelay(req("GET"), TOKEN, URL_NAME)
    expect(res.status).toBe(200)
    await res.arrayBuffer()
  })

  it("passes Range through → 206 with Content-Range; a range from byte 0 counts as a fetch", async () => {
    openDl.mockResolvedValueOnce({
      status: 206,
      body: bytes(100),
      contentLength: null,
      contentRange: "bytes 0-99/1000",
      contentType: "video/mp4",
    })
    const res = await serveRelay(
      req("GET", { range: "bytes=0-99" }),
      TOKEN,
      NAME
    )
    expect(res.status).toBe(206)
    expect(res.headers.get("content-range")).toBe("bytes 0-99/1000")
    expect(res.headers.get("content-length")).toBe("100")
    expect(openDl.mock.calls[0]![2]).toMatchObject({ range: "bytes=0-99" })
    expect(consume).toHaveBeenCalledTimes(1)
    expect(peek).not.toHaveBeenCalled()
    await res.arrayBuffer()
  })

  it("a range not starting at 0 is NOT counted (peek); the byte budget bounds it", async () => {
    openDl.mockResolvedValueOnce({
      status: 206,
      body: bytes(500),
      contentLength: 500,
      contentRange: "bytes 500-999/1000",
      contentType: "video/mp4",
    })
    const res = await serveRelay(
      req("GET", { range: "bytes=500-" }),
      TOKEN,
      NAME
    )
    expect(res.status).toBe(206)
    expect(peek).toHaveBeenCalledWith(TOKEN)
    expect(consume).not.toHaveBeenCalled()
    await res.arrayBuffer()
  })

  it("T-1: a counted fetch re-checks the file is still inside the granted folder (other users' personal folders pruned)", async () => {
    loadBlocked.mockResolvedValueOnce(new Set(["PERSONALFOLDER0001"]))
    const ok = await serveRelay(req("GET"), TOKEN, NAME)
    expect(ok.status).toBe(200)
    await ok.arrayBuffer()
    expect(loadBlocked).toHaveBeenCalledWith({ id: "u1", role: "staff" })
    expect(ancestorIn).toHaveBeenCalledWith(
      expect.objectContaining({ type: "service_account" }),
      expect.objectContaining({ id: "FILEID1234567890" }),
      new Set(["FOLDERID12345678"]),
      expect.objectContaining({ blocked: new Set(["PERSONALFOLDER0001"]) })
    )
    // moved out of the folder / now behind another user's personal folder → 404, nothing streamed
    ancestorIn.mockResolvedValueOnce(null)
    openDl.mockClear()
    const gone = await serveRelay(req("GET"), TOKEN, NAME)
    expect(gone.status).toBe(404)
    expect(openDl).not.toHaveBeenCalled()
  })

  it("T-1: ranged reads that are not counted do not walk the ancestors; public links never do", async () => {
    openDl.mockResolvedValueOnce({
      status: 206,
      body: bytes(500),
      contentLength: 500,
      contentRange: "bytes 500-999/1000",
      contentType: "video/mp4",
    })
    const ranged = await serveRelay(
      req("GET", { range: "bytes=500-" }),
      TOKEN,
      NAME
    )
    expect(ranged.status).toBe(206)
    await ranged.arrayBuffer()
    expect(ancestorIn).not.toHaveBeenCalled()
    consume.mockResolvedValueOnce(
      row({ access: "api_key", credentialId: null, sourceId: null })
    )
    const pub = await serveRelay(req("GET"), TOKEN, NAME)
    expect(pub.status).toBe(200)
    await pub.arrayBuffer()
    expect(ancestorIn).not.toHaveBeenCalled()
  })

  it("relayRequestCountsAsFetch: full answers and ranges from byte 0 only", () => {
    expect(relayRequestCountsAsFetch(null)).toBe(true)
    expect(relayRequestCountsAsFetch("")).toBe(true)
    expect(relayRequestCountsAsFetch("bytes=0-")).toBe(true)
    expect(relayRequestCountsAsFetch("bytes=0-99")).toBe(true)
    expect(relayRequestCountsAsFetch("bytes=00-99")).toBe(true)
    // an unusable Range is answered in full by Drive → counted
    expect(relayRequestCountsAsFetch("bytes=0-1,5-9")).toBe(true)
    expect(relayRequestCountsAsFetch("items=5-9")).toBe(true)
    expect(relayRequestCountsAsFetch("bytes=-")).toBe(true)
    expect(relayRequestCountsAsFetch("bytes=1-")).toBe(false)
    expect(relayRequestCountsAsFetch("bytes=500-999")).toBe(false)
    expect(relayRequestCountsAsFetch("bytes=-500")).toBe(false)
  })

  it("byte budget: at most 3 × size per link, refused before any Google call", async () => {
    for (let i = 0; i < 3; i++) {
      const res = await serveRelay(req("GET"), TOKEN, NAME)
      expect(res.status).toBe(200)
      await res.arrayBuffer()
    }
    openDl.mockClear()
    getFile.mockClear()
    expect((await serveRelay(req("GET"), TOKEN, NAME)).status).toBe(404)
    expect(getFile).not.toHaveBeenCalled()
    expect(openDl).not.toHaveBeenCalled()
    expect(relayStreamsInFlight().streams).toBe(0)
  })

  it("byte budget: a client hanging up early only uses what was sent", async () => {
    const key = links.hashRelayToken(TOKEN)
    const refund = reserveRelayBytes(key, 1000, 3000)!
    expect(reserveRelayBytes(key, 1000, 1)).toBeNull()
    refund(1000)
    refund(0) // once only
    expect(reserveRelayBytes(key, 1000, 2000)).not.toBeNull()
    expect(reserveRelayBytes(key, 1000, 1)).toBeNull()

    __resetRelayLimits()
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(100))
      },
    })
    openDl.mockResolvedValueOnce({
      status: 200,
      body: upstream,
      contentLength: 1000,
      contentRange: null,
      contentType: "video/mp4",
    })
    const res = await serveRelay(req("GET"), TOKEN, NAME)
    const reader = res.body!.getReader()
    expect((await reader.read()).value?.byteLength).toBe(100)
    await reader.cancel()
    // 1000 reserved, 100 sent → 2900 left of 3000
    expect(reserveRelayBytes(key, 1000, 2900)).not.toBeNull()
    expect(reserveRelayBytes(key, 1000, 1)).toBeNull()
  })

  it("416 when Drive refuses the range", async () => {
    openDl.mockRejectedValueOnce(
      new DriveError("range_not_satisfiable", { httpStatus: 416 })
    )
    const res = await serveRelay(
      req("GET", { range: "bytes=5000-" }),
      TOKEN,
      NAME
    )
    expect(res.status).toBe(416)
    expect(res.headers.get("content-range")).toBe("bytes */1000")
    expect(relayStreamsInFlight().streams).toBe(0)
  })

  it("404 on a name mismatch, a dead / used-up link or a malformed token", async () => {
    expect((await serveRelay(req("GET"), TOKEN, "khac.mp4")).status).toBe(404)
    consume.mockResolvedValueOnce(null)
    expect((await serveRelay(req("GET"), TOKEN, NAME)).status).toBe(404)
    expect((await serveRelay(req("GET"), "adr_short", NAME)).status).toBe(404)
    expect(openDl).not.toHaveBeenCalled()
    expect(relayStreamsInFlight().streams).toBe(0)
  })

  it("404 when the file content changed, it was trashed or its size differs", async () => {
    getFile.mockResolvedValueOnce(driveFile({ md5: "changed" }))
    expect((await serveRelay(req("GET"), TOKEN, NAME)).status).toBe(404)
    getFile.mockResolvedValueOnce(driveFile({ trashed: true }))
    expect((await serveRelay(req("GET"), TOKEN, NAME)).status).toBe(404)
    consume.mockResolvedValueOnce(row({ contentKey: "ver:3", sizeBytes: 999 }))
    getFile.mockResolvedValueOnce(driveFile({ md5: null }))
    expect((await serveRelay(req("GET"), TOKEN, NAME)).status).toBe(404)
    expect(openDl).not.toHaveBeenCalled()
  })

  it("404 when the credential is gone / disabled or the API key was removed; Drive errors → 404 without detail", async () => {
    loadCred.mockResolvedValueOnce(null)
    expect((await serveRelay(req("GET"), TOKEN, NAME)).status).toBe(404)
    loadCred.mockResolvedValueOnce({
      id: "c1",
      status: "disabled",
      deletedAt: null,
    } as never)
    expect((await serveRelay(req("GET"), TOKEN, NAME)).status).toBe(404)
    consume.mockResolvedValueOnce(
      row({ access: "api_key", credentialId: null, sourceId: null })
    )
    apiKeyAuth.mockResolvedValueOnce(null)
    expect((await serveRelay(req("GET"), TOKEN, NAME)).status).toBe(404)
    getFile.mockRejectedValueOnce(new DriveError("not_public"))
    const res = await serveRelay(req("GET"), TOKEN, NAME)
    expect(res.status).toBe(404)
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/)
    expect(await res.text()).toBe("Not found")
    expect(relayStreamsInFlight().streams).toBe(0)
  })

  it("L4: 404 when the MCP no longer grants the account, the source or public links", async () => {
    const cases: Array<[string, () => void]> = [
      ["MCP unusable", () => loadGrant.mockResolvedValueOnce(null)],
      [
        "source no longer granted",
        () => loadGrant.mockResolvedValueOnce(grant({ driveSources: [] })),
      ],
      [
        "source now on another credential",
        () =>
          loadGrant.mockResolvedValueOnce(
            grant({
              driveSources: [
                { ...grant().driveSources[0]!, credentialId: "c2" },
              ],
            })
          ),
      ],
      [
        "account out of scope",
        () => loadGrant.mockResolvedValueOnce(grant({ accounts: [] })),
      ],
      [
        "no create permission any more",
        () =>
          loadGrant.mockResolvedValueOnce(
            grant({ permissions: { meta: ["read"] } })
          ),
      ],
      [
        "service account link without a source",
        () => consume.mockResolvedValueOnce(row({ sourceId: null })),
      ],
      [
        "public-link switch turned off",
        () => {
          consume.mockResolvedValueOnce(
            row({ access: "api_key", credentialId: null, sourceId: null })
          )
          loadGrant.mockResolvedValueOnce(
            grant({
              settings: { ...DEFAULT_MCP_SETTINGS, drivePublicLinks: false },
            })
          )
        },
      ],
      [
        "system API key gone",
        () => {
          consume.mockResolvedValueOnce(
            row({ access: "api_key", credentialId: null, sourceId: null })
          )
          loadGrant.mockResolvedValueOnce(
            grant({ drivePublicAvailable: false })
          )
        },
      ],
    ]
    for (const [label, setup] of cases) {
      setup()
      const res = await serveRelay(req("GET"), TOKEN, NAME)
      expect(res.status, label).toBe(404)
    }
    expect(getFile).not.toHaveBeenCalled()
    expect(openDl).not.toHaveBeenCalled()
    expect(relayStreamsInFlight().streams).toBe(0)
  })

  it("api_key links read Drive with the system API key", async () => {
    consume.mockResolvedValueOnce(
      row({ access: "api_key", credentialId: null, sourceId: null })
    )
    const res = await serveRelay(req("GET"), TOKEN, NAME)
    expect(res.status).toBe(200)
    expect(openDl.mock.calls[0]![0]).toMatchObject({ type: "api_key" })
    expect(loadCred).not.toHaveBeenCalled()
    await res.arrayBuffer()
  })

  it("never serves a stored non-media type as such", async () => {
    consume.mockResolvedValueOnce(row({ contentType: "text/html" }))
    const res = await serveRelay(req("GET"), TOKEN, NAME)
    expect(res.headers.get("content-type")).toBe("application/octet-stream")
    await res.arrayBuffer()
  })

  it("429 + Retry-After past 8 streams per link (no fetch counted)", async () => {
    expect(RELAY_LIMITS.streamsPerToken).toBe(8)
    const open: Response[] = []
    for (let i = 0; i < 8; i++) {
      openDl.mockResolvedValueOnce({
        status: 200,
        body: new ReadableStream<Uint8Array>({ pull() {} }),
        contentLength: 100,
        contentRange: null,
        contentType: "video/mp4",
      })
      open.push(await serveRelay(req("GET"), TOKEN, NAME))
    }
    expect(open.every((r) => r.status === 200)).toBe(true)
    consume.mockClear()
    const res = await serveRelay(req("GET"), TOKEN, NAME)
    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).toBe("5")
    expect(consume).not.toHaveBeenCalled()
    // a client hanging up frees its slot
    await open[0]!.body!.cancel()
    expect(relayStreamsInFlight().streams).toBe(7)
    for (const r of open.slice(1)) await r.body!.cancel()
    expect(relayStreamsInFlight().streams).toBe(0)
  })

  it("32 streams per process at most", () => {
    const releases = []
    for (let i = 0; i < 32; i++)
      releases.push(acquireRelayStream(`t${i}`, `198.51.100.${i + 1}`))
    expect(releases.every(Boolean)).toBe(true)
    expect(acquireRelayStream("t-new", "192.0.2.1")).toBeNull()
    releases[5]!()
    expect(acquireRelayStream("t-new", "192.0.2.1")).not.toBeNull()
  })

  it("16 streams per client IP, IPv6 grouped by /64", () => {
    const releases = []
    for (let i = 0; i < 16; i++)
      releases.push(acquireRelayStream(`t${i}`, `2001:db8:1:2::${i + 1}`))
    expect(releases.every(Boolean)).toBe(true)
    expect(acquireRelayStream("t99", "2001:db8:1:2:ffff::1")).toBeNull()
    expect(acquireRelayStream("t99", "2001:db8:1:3::1")).not.toBeNull()
    releases[0]!()
    releases[0]!() // idempotent
    expect(acquireRelayStream("t98", "2001:db8:1:2::abcd")).not.toBeNull()
  })

  it("aborts the upstream Drive stream when the client disconnects", async () => {
    let cancelled = false
    const upstream = new ReadableStream<Uint8Array>({
      pull() {},
      cancel() {
        cancelled = true
      },
    })
    const ac = new AbortController()
    openDl.mockResolvedValueOnce({
      status: 200,
      body: upstream,
      contentLength: 1000,
      contentRange: null,
      contentType: "video/mp4",
    })
    const res = await serveRelay(req("GET", {}, ac.signal), TOKEN, NAME)
    expect(res.status).toBe(200)
    expect(relayStreamsInFlight().streams).toBe(1)
    ac.abort()
    await new Promise((r) => setTimeout(r, 0))
    expect(cancelled).toBe(true)
    expect(relayStreamsInFlight().streams).toBe(0)
  })

  it("other methods → 404", async () => {
    const r = new Request(`https://mcp.example.com/dl/${TOKEN}/${URL_NAME}`, {
      method: "POST",
    })
    expect((await serveRelay(r, TOKEN, NAME)).status).toBe(404)
  })
})

describe("unknown tokens per client (L3)", () => {
  it("after 20 misses (GET + HEAD, malformed included) unknown tokens get 429 without a DB lookup", async () => {
    peek.mockResolvedValue(null)
    consume.mockResolvedValue(null)
    for (let i = 0; i < 10; i++)
      expect((await serveRelay(req("HEAD"), TOKEN, NAME)).status).toBe(404)
    for (let i = 0; i < 5; i++)
      expect((await serveRelay(req("GET"), TOKEN, NAME)).status).toBe(404)
    for (let i = 0; i < 5; i++)
      expect((await serveRelay(req("GET"), "adr_bad", NAME)).status).toBe(404)
    peek.mockClear()
    consume.mockClear()
    const res = await serveRelay(req("GET"), TOKEN, NAME)
    expect(res.status).toBe(429)
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0)
    expect((await serveRelay(req("HEAD"), TOKEN, NAME)).status).toBe(429)
    expect(peek).not.toHaveBeenCalled()
    expect(consume).not.toHaveBeenCalled()
    expect(isLive).toHaveBeenCalledWith(links.hashRelayToken(TOKEN))
    // another client is not affected
    expect(
      (
        await serveRelay(
          req("HEAD", {}, undefined, "198.51.100.9"),
          TOKEN,
          NAME
        )
      ).status
    ).toBe(404)
  })

  it("a blocked client with the token of a live link still gets the video", async () => {
    for (let i = 0; i < 20; i++) await serveRelay(req("GET"), "adr_bad", NAME)
    isLive.mockResolvedValueOnce(true)
    const res = await serveRelay(req("GET"), TOKEN, NAME)
    expect(res.status).toBe(200)
    await res.arrayBuffer()
  })
})

describe("relayBody", () => {
  it("passes chunks through, reports the bytes sent and releases once at the end", async () => {
    const release = vi.fn()
    const onEnd = vi.fn()
    const out = relayBody(bytes(10), release, { onEnd })
    expect((await new Response(out).arrayBuffer()).byteLength).toBe(10)
    expect(release).toHaveBeenCalledTimes(1)
    expect(onEnd).toHaveBeenCalledExactlyOnceWith(10)
  })

  it("cuts a stream past its time limit (upstream cancelled, slot released)", async () => {
    let cancelled = false
    const slow = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => {})
      },
      cancel() {
        cancelled = true
      },
    })
    const release = vi.fn()
    const onEnd = vi.fn()
    const out = relayBody(slow, release, { maxMs: 20, onEnd })
    await expect(new Response(out).arrayBuffer()).rejects.toThrow()
    expect(cancelled).toBe(true)
    expect(release).toHaveBeenCalledTimes(1)
    expect(onEnd).toHaveBeenCalledExactlyOnceWith(0)
  })

  it("releases on upstream error", async () => {
    const release = vi.fn()
    const src = new ReadableStream<Uint8Array>({
      pull(c) {
        c.error(new Error("boom"))
      },
    })
    await expect(
      new Response(relayBody(src, release)).arrayBuffer()
    ).rejects.toThrow()
    expect(release).toHaveBeenCalledTimes(1)
  })
})
