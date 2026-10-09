// Drive files: metadata normalisation, folder listing query (escaping, families, corpora, paging), downloads
// (Range, 206/416, no retry, size cap), shortcuts, ancestor walk (cycles, depth, hidden parents), content key,
// service-account check, thumbnails (host / type / size limits).
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { __clearGoogleTokenCache } from "../google/service-account"
import {
  FILE_ID,
  googleError,
  isToken,
  json,
  keyAuth,
  mockGoogleFetch,
  rawFile,
  saAuth,
  streamResponse,
  type GoogleCall,
} from "./__fixtures__/google-fetch"
import { __setDriveRetryBaseMs } from "./client"
import { DriveError } from "./errors"
import {
  buildFolderQuery,
  checkServiceAccountAccess,
  downloadDriveBytes,
  DRIVE_FILE_FIELDS,
  driveContentKey,
  fetchDriveThumbnail,
  findAncestorIn,
  getDriveFile,
  listAncestorIds,
  listDriveFolder,
  normalizeDriveFile,
  openDriveDownload,
  readDriveRange,
  resolveShortcut,
} from "./files"
import { DRIVE_FOLDER_MIME, DRIVE_SHORTCUT_MIME, type DriveFile } from "./types"

const api = (c: GoogleCall) => !isToken(c)
const fileIdOf = (c: GoogleCall) =>
  decodeURIComponent(c.url.pathname.split("/files/")[1] ?? "")

async function driveErr(p: Promise<unknown>): Promise<DriveError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x
  )
  expect(e).toBeInstanceOf(DriveError)
  return e as DriveError
}

function file(over: Partial<DriveFile> = {}): DriveFile {
  return { ...normalizeDriveFile(rawFile()), ...over }
}

beforeEach(() => {
  __clearGoogleTokenCache()
  __setDriveRetryBaseMs(1)
})
afterEach(() => __setDriveRetryBaseMs(1_000))

describe("getDriveFile", () => {
  it("gọi files.get với fields + supportsAllDrives và chuẩn hoá kết quả", async () => {
    const m = mockGoogleFetch()
    m.on(api, () =>
      json(
        rawFile({
          videoMediaMetadata: {
            width: 1920,
            height: 1080,
            durationMillis: "15000",
          },
          imageMediaMetadata: undefined,
          mimeType: "video/mp4",
          size: "52428800",
          driveId: "0AsharedDrive",
          resourceKey: "0-rk",
        })
      )
    )
    const f = await getDriveFile(saAuth(), FILE_ID, { resourceKey: "0-rk" })
    const c = m.api()[0]!
    expect(c.url.origin + c.url.pathname).toBe(
      `https://www.googleapis.com/drive/v3/files/${FILE_ID}`
    )
    expect(c.url.searchParams.get("fields")).toBe(DRIVE_FILE_FIELDS)
    expect(c.url.searchParams.get("supportsAllDrives")).toBe("true")
    expect(c.headers["x-goog-drive-resource-keys"]).toBe(`${FILE_ID}/0-rk`)
    expect(f).toMatchObject({
      id: FILE_ID,
      mimeType: "video/mp4",
      sizeBytes: 52428800,
      width: 1920,
      height: 1080,
      durationMs: 15000,
      driveId: "0AsharedDrive",
      canDownload: true,
      canEdit: false,
      trashed: false,
      parents: ["folderParent0001"],
      shortcut: null,
      version: "7",
    })
  })

  it("mã không hợp lệ → invalid_link, không gọi Google", async () => {
    const m = mockGoogleFetch()
    expect(
      (await driveErr(getDriveFile(keyAuth(), "../etc/passwd"))).code
    ).toBe("invalid_link")
    expect((await driveErr(getDriveFile(keyAuth(), "short"))).code).toBe(
      "invalid_link"
    )
    expect(m.calls).toHaveLength(0)
  })

  it("404: service account → not_found, API key → not_public", async () => {
    const m = mockGoogleFetch()
    m.on(api, () => googleError(404, "notFound"))
    expect((await driveErr(getDriveFile(saAuth(), FILE_ID))).code).toBe(
      "not_found"
    )
    expect((await driveErr(getDriveFile(keyAuth(), FILE_ID))).code).toBe(
      "not_public"
    )
  })

  it("normalizeDriveFile: thiếu trường → giá trị mặc định an toàn", () => {
    const f = normalizeDriveFile({
      id: "x1234567890",
      mimeType: DRIVE_FOLDER_MIME,
    })
    expect(f).toMatchObject({
      sizeBytes: null,
      md5: null,
      parents: [],
      canDownload: false,
      width: null,
      shortcut: null,
    })
    expect(
      normalizeDriveFile({ id: "x1234567890", size: "-5" }).sizeBytes
    ).toBeNull()
    expect(() => normalizeDriveFile({})).toThrow(DriveError)
  })
})

describe("listDriveFolder", () => {
  it("buildFolderQuery: thư mục, loại, tên (escape \\ và '), modifiedTime chuẩn RFC 3339", () => {
    expect(buildFolderQuery("folder123456")).toBe(
      "'folder123456' in parents and trashed = false"
    )
    expect(buildFolderQuery("folder123456", { family: "image" })).toBe(
      "'folder123456' in parents and trashed = false and mimeType contains 'image/'"
    )
    expect(
      buildFolderQuery("folder123456", { family: "all", includeFolders: true })
    ).toBe(
      `'folder123456' in parents and trashed = false and (mimeType contains 'image/' or mimeType contains 'video/' or mimeType = '${DRIVE_FOLDER_MIME}')`
    )
    expect(
      buildFolderQuery("folder123456", {
        family: "video",
        nameContains: "Tuần 41' or name contains 'x\\",
        modifiedAfter: "2026-10-01T07:00:00+07:00",
      })
    ).toBe(
      "'folder123456' in parents and trashed = false and mimeType contains 'video/' and name contains 'Tuần 41\\' or name contains \\'x\\\\' and modifiedTime > '2026-10-01T00:00:00.000Z'"
    )
    expect(() =>
      buildFolderQuery("folder123456", { modifiedAfter: "hôm qua" })
    ).toThrow(TypeError)
  })

  it("service account: corpora=user, includeItemsFromAllDrives, orderBy, pageSize giới hạn 1000", async () => {
    const m = mockGoogleFetch()
    m.on(api, () =>
      json({
        files: [rawFile(), rawFile({ id: "second123456" })],
        nextPageToken: "tok2",
      })
    )
    const page = await listDriveFolder(saAuth(), "folder123456", {
      pageSize: 5000,
      pageToken: "tok1",
      family: "image",
    })
    const q = m.api()[0]!.url.searchParams
    expect(q.get("corpora")).toBe("user")
    expect(q.has("driveId")).toBe(false)
    expect(q.get("includeItemsFromAllDrives")).toBe("true")
    expect(q.get("supportsAllDrives")).toBe("true")
    expect(q.get("orderBy")).toBe("folder,modifiedTime desc")
    expect(q.get("pageSize")).toBe("1000")
    expect(q.get("pageToken")).toBe("tok1")
    expect(q.get("fields")).toBe(`nextPageToken,files(${DRIVE_FILE_FIELDS})`)
    expect(page.files.map((f) => f.id)).toEqual([FILE_ID, "second123456"])
    expect(page.nextPageToken).toBe("tok2")
  })

  it("Shared drive → corpora=drive&driveId; API key → không corpora; mặc định 100", async () => {
    const m = mockGoogleFetch()
    m.on(api, () => json({ files: [] }))
    await listDriveFolder(saAuth(), "folder123456", {
      driveId: "0AsharedDrive",
    })
    await listDriveFolder(keyAuth(), "folder123456", { resourceKey: "0-frk" })
    const [a, b] = m.api()
    expect(a!.url.searchParams.get("corpora")).toBe("drive")
    expect(a!.url.searchParams.get("driveId")).toBe("0AsharedDrive")
    expect(a!.url.searchParams.get("pageSize")).toBe("100")
    expect(b!.url.searchParams.has("corpora")).toBe(false)
    expect(b!.headers["x-goog-drive-resource-keys"]).toBe("folder123456/0-frk")
    expect(b!.headers.authorization).toBeUndefined()
  })

  it("liệt kê là lệnh đọc → được thử lại khi 429", async () => {
    const m = mockGoogleFetch()
    m.once(api, () => googleError(429, "rateLimitExceeded"))
    m.on(api, () => json({ files: [] }))
    expect((await listDriveFolder(keyAuth(), "folder123456")).files).toEqual([])
    expect(m.api()).toHaveLength(2)
  })
})

describe("openDriveDownload / downloadDriveBytes", () => {
  it("alt=media, chuyển tiếp Range → 206 + Content-Range, trả stream", async () => {
    const m = mockGoogleFetch()
    m.on(api, () =>
      streamResponse([new Uint8Array([1, 2, 3])], 206, {
        "content-length": "3",
        "content-range": "bytes 0-2/10",
        "content-type": "video/mp4",
      })
    )
    const dl = await openDriveDownload(saAuth(), FILE_ID, {
      range: "bytes=0-2",
      resourceKey: "0-rk",
    })
    const c = m.api()[0]!
    expect(c.url.searchParams.get("alt")).toBe("media")
    expect(c.url.searchParams.get("supportsAllDrives")).toBe("true")
    expect(c.headers.range).toBe("bytes=0-2")
    expect(c.headers["x-goog-drive-resource-keys"]).toBe(`${FILE_ID}/0-rk`)
    expect(dl).toMatchObject({
      status: 206,
      contentLength: 3,
      contentRange: "bytes 0-2/10",
      contentType: "video/mp4",
    })
    expect(Buffer.from(await new Response(dl.body).arrayBuffer())).toEqual(
      Buffer.from([1, 2, 3])
    )
  })

  it("L9: xin bytes gốc (Accept-Encoding: identity); câu trả lời bị nén → upstream_error", async () => {
    const m = mockGoogleFetch()
    m.once(api, () =>
      streamResponse([new Uint8Array([1])], 200, { "content-length": "1" })
    )
    await openDriveDownload(saAuth(), FILE_ID)
    expect(m.api()[0]!.headers["accept-encoding"]).toBe("identity")
    m.once(api, () =>
      streamResponse([new Uint8Array([1])], 200, { "content-encoding": "gzip" })
    )
    expect((await driveErr(openDriveDownload(saAuth(), FILE_ID))).code).toBe(
      "upstream_error"
    )
  })

  it("readDriveRange: Range đúng đoạn, kiểm 206 + Content-Range + độ dài", async () => {
    const m = mockGoogleFetch()
    m.once(api, () =>
      streamResponse([new Uint8Array([7, 8]), new Uint8Array([9])], 206, {
        "content-length": "3",
        "content-range": "bytes 10-12/100",
      })
    )
    const buf = await readDriveRange(saAuth(), FILE_ID, 10, 13, {
      resourceKey: "0-rk",
    })
    expect(buf).toEqual(Buffer.from([7, 8, 9]))
    const c = m.api()[0]!
    expect(c.headers.range).toBe("bytes=10-12")
    expect(c.headers["accept-encoding"]).toBe("identity")
    expect(c.headers["x-goog-drive-resource-keys"]).toBe(`${FILE_ID}/0-rk`)

    // 200 (Range ignored), another range, a short body → upstream_error
    m.once(api, () =>
      streamResponse([new Uint8Array(3)], 200, { "content-length": "3" })
    )
    expect(
      (await driveErr(readDriveRange(saAuth(), FILE_ID, 10, 13))).code
    ).toBe("upstream_error")
    m.once(api, () =>
      streamResponse([new Uint8Array(3)], 206, {
        "content-range": "bytes 11-13/100",
      })
    )
    expect(
      (await driveErr(readDriveRange(saAuth(), FILE_ID, 10, 13))).code
    ).toBe("upstream_error")
    m.once(api, () =>
      streamResponse([new Uint8Array(2)], 206, {
        "content-range": "bytes 10-12/100",
      })
    )
    const short = await driveErr(readDriveRange(saAuth(), FILE_ID, 10, 13))
    expect(short.code).toBe("upstream_error")
    expect(short.retryable).toBe(true)
    // more bytes than asked → refused while reading
    m.once(api, () =>
      streamResponse([new Uint8Array(5)], 206, {
        "content-range": "bytes 10-12/100",
      })
    )
    expect(
      (await driveErr(readDriveRange(saAuth(), FILE_ID, 10, 13))).code
    ).toBe("too_large")
  })

  it("readDriveRange: đoạn không hợp lệ / quá 32 MB → lỗi, không gọi Google", async () => {
    const m = mockGoogleFetch()
    await expect(readDriveRange(saAuth(), FILE_ID, 5, 5)).rejects.toThrow(
      RangeError
    )
    await expect(readDriveRange(saAuth(), FILE_ID, -1, 5)).rejects.toThrow(
      RangeError
    )
    await expect(
      readDriveRange(saAuth(), FILE_ID, 0, 32 * 1024 * 1024 + 1)
    ).rejects.toThrow(RangeError)
    expect(m.api()).toHaveLength(0)
  })

  it("Range không hợp lệ / nhiều đoạn bị bỏ qua", async () => {
    const m = mockGoogleFetch()
    m.on(api, () => streamResponse([], 200))
    for (const r of ["bytes=0-1,5-6", "items=0-1", "bytes=abc"])
      await openDriveDownload(keyAuth(), FILE_ID, { range: r })
    expect(m.api().every((c) => c.headers.range === undefined)).toBe(true)
  })

  it("416 → range_not_satisfiable; 503 không thử lại", async () => {
    const m = mockGoogleFetch()
    m.once(api, () => json({}, 416))
    m.once(api, () => json({}, 503))
    expect(
      (
        await driveErr(
          openDriveDownload(keyAuth(), FILE_ID, { range: "bytes=99-" })
        )
      ).code
    ).toBe("range_not_satisfiable")
    expect((await driveErr(openDriveDownload(keyAuth(), FILE_ID))).code).toBe(
      "upstream_error"
    )
    expect(m.api()).toHaveLength(2)
  })

  it("Google Docs → not_downloadable; file độc hại → abusive_file", async () => {
    const m = mockGoogleFetch()
    m.once(api, () => googleError(403, "fileNotDownloadable"))
    m.once(api, () => googleError(403, "cannotDownloadAbusiveFile"))
    expect((await driveErr(openDriveDownload(saAuth(), FILE_ID))).code).toBe(
      "not_downloadable"
    )
    expect((await driveErr(openDriveDownload(saAuth(), FILE_ID))).code).toBe(
      "abusive_file"
    )
  })

  it("downloadDriveBytes: đủ bytes khi dưới giới hạn", async () => {
    const m = mockGoogleFetch()
    m.on(api, () =>
      streamResponse([Buffer.alloc(4, 1), Buffer.alloc(4, 2)], 200, {
        "content-length": "8",
      })
    )
    const b = await downloadDriveBytes(keyAuth(), FILE_ID, { maxBytes: 8 })
    expect(b.length).toBe(8)
  })

  it("downloadDriveBytes: Content-Length vượt giới hạn → too_large (không đọc body)", async () => {
    const m = mockGoogleFetch()
    m.on(api, () =>
      streamResponse([Buffer.alloc(4)], 200, { "content-length": "999999" })
    )
    expect(
      (await driveErr(downloadDriveBytes(keyAuth(), FILE_ID, { maxBytes: 10 })))
        .code
    ).toBe("too_large")
  })

  it("downloadDriveBytes: vượt giới hạn khi đang tải (không có Content-Length) → too_large, huỷ request", async () => {
    const m = mockGoogleFetch()
    let upstream: AbortSignal | null = null
    let pulls = 0
    m.on(api, (c) => {
      upstream = c.signal
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(ctl) {
            pulls++
            ctl.enqueue(Buffer.alloc(6))
          },
        })
      )
    })
    expect(
      (await driveErr(downloadDriveBytes(keyAuth(), FILE_ID, { maxBytes: 10 })))
        .code
    ).toBe("too_large")
    expect(upstream!.aborted).toBe(true)
    expect(pulls).toBeLessThan(5)
  })
})

describe("resolveShortcut", () => {
  it("lối tắt → metadata của file đích (resource key của đích)", async () => {
    const m = mockGoogleFetch()
    m.on(api, () => json(rawFile({ id: "target123456" })))
    const sc = file({
      id: "shortcut12345",
      mimeType: DRIVE_SHORTCUT_MIME,
      shortcut: {
        targetId: "target123456",
        targetMimeType: "image/jpeg",
        targetResourceKey: "0-trk",
      },
    })
    const t = await resolveShortcut(saAuth(), sc)
    expect(t.id).toBe("target123456")
    expect(m.api()[0]!.headers["x-goog-drive-resource-keys"]).toBe(
      "target123456/0-trk"
    )
  })

  it("file thường trả nguyên; lối tắt thiếu đích → not_found", async () => {
    const m = mockGoogleFetch()
    const f = file()
    expect(await resolveShortcut(saAuth(), f)).toBe(f)
    expect(
      (
        await driveErr(
          resolveShortcut(
            saAuth(),
            file({ mimeType: DRIVE_SHORTCUT_MIME, shortcut: null })
          )
        )
      ).code
    ).toBe("not_found")
    expect(m.calls).toHaveLength(0)
  })
})

describe("findAncestorIn / listAncestorIds", () => {
  /** parent graph: id → parents; missing = 404 (hidden) */
  function tree(
    m: ReturnType<typeof mockGoogleFetch>,
    graph: Record<string, string[] | "forbidden" | "error">
  ) {
    m.on(api, (c) => {
      const id = fileIdOf(c)
      const g = graph[id]
      if (g === undefined) return googleError(404, "notFound")
      if (g === "forbidden")
        return googleError(403, "insufficientFilePermissions")
      if (g === "error") return googleError(400, "invalid")
      return json({ id, parents: g })
    })
  }

  it("cha trực tiếp không cần gọi Google; tổ tiên xa hơn đi từng cấp", async () => {
    const m = mockGoogleFetch()
    tree(m, { parentA00001: ["grandB00001"], grandB00001: ["rootC000001"] })
    const f = file({ parents: ["parentA00001"] })
    expect(await findAncestorIn(saAuth(), f, new Set(["parentA00001"]))).toBe(
      "parentA00001"
    )
    expect(m.api()).toHaveLength(0)
    expect(await findAncestorIn(saAuth(), f, new Set(["rootC000001"]))).toBe(
      "rootC000001"
    )
    expect(m.api().map(fileIdOf)).toEqual(["parentA00001", "grandB00001"])
    expect(m.api()[0]!.url.searchParams.get("fields")).toBe("id,parents")
  })

  it("thư mục là chính nguồn được cấp → chính nó", async () => {
    mockGoogleFetch()
    const folder = file({
      id: "folderX00001",
      mimeType: DRIVE_FOLDER_MIME,
      parents: [],
    })
    expect(
      await findAncestorIn(saAuth(), folder, new Set(["folderX00001"]))
    ).toBe("folderX00001")
    // a FILE with that id does not count (only folders are sources)
    expect(
      await findAncestorIn(
        saAuth(),
        file({ id: "folderX00001", parents: [] }),
        new Set(["folderX00001"])
      )
    ).toBeNull()
  })

  it("vòng lặp parents không lặp vô hạn", async () => {
    const m = mockGoogleFetch()
    tree(m, { loopA000001: ["loopB000001"], loopB000001: ["loopA000001"] })
    expect(
      await findAncestorIn(
        saAuth(),
        file({ parents: ["loopA000001"] }),
        new Set(["nowhere00001"])
      )
    ).toBeNull()
    expect(m.api()).toHaveLength(2)
  })

  it("giới hạn độ sâu", async () => {
    const m = mockGoogleFetch()
    const graph: Record<string, string[]> = {}
    for (let i = 1; i <= 15; i++)
      graph[`level${String(i).padStart(7, "0")}`] = [
        `level${String(i + 1).padStart(7, "0")}`,
      ]
    tree(m, graph)
    const f = file({ parents: ["level0000001"] })
    expect(
      await findAncestorIn(saAuth(), f, new Set(["level0000003"]), {
        maxDepth: 3,
      })
    ).toBe("level0000003")
    expect(
      await findAncestorIn(saAuth(), f, new Set(["level0000004"]), {
        maxDepth: 3,
      })
    ).toBeNull()
    const before = m.api().length
    const ids = await listAncestorIds(saAuth(), f)
    expect(ids).toHaveLength(10)
    expect(ids[0]).toBe("level0000001")
    expect(m.api().length - before).toBe(9)
  })

  it("cấp cha không thấy được (404/403) kết thúc nhánh đó im lặng; nhánh khác vẫn đi tiếp", async () => {
    const m = mockGoogleFetch()
    tree(m, { visible0001: ["company00001"], hidden00001: "forbidden" })
    const f = file({ parents: ["hidden00001", "missing00001", "visible0001"] })
    expect(await findAncestorIn(keyAuth(), f, new Set(["company00001"]))).toBe(
      "company00001"
    )
    expect(await listAncestorIds(saAuth(), f)).toEqual([
      "hidden00001",
      "missing00001",
      "visible0001",
      "company00001",
    ])
  })

  it("H1: nhánh đi qua thư mục bị chặn trước khi gặp nguồn → không tính; nhánh khác vẫn tính", async () => {
    const m = mockGoogleFetch()
    tree(m, {
      personal0001: ["company00001"],
      other0000001: ["company00001"],
      company00001: [],
    })
    const blocked = new Set(["personal0001"])
    // only path: file → personal (blocked) → company
    expect(
      await findAncestorIn(
        saAuth(),
        file({ parents: ["personal0001"] }),
        new Set(["company00001"]),
        { blocked }
      )
    ).toBeNull()
    // the blocked folder is not expanded
    expect(m.api().map(fileIdOf)).not.toContain("personal0001")
    // a second, clean path to the same source still counts
    expect(
      await findAncestorIn(
        saAuth(),
        file({ parents: ["personal0001", "other0000001"] }),
        new Set(["company00001"]),
        { blocked }
      )
    ).toBe("company00001")
    // a candidate that is itself in the blocked set still counts (granted on its own)
    expect(
      await findAncestorIn(
        saAuth(),
        file({ parents: ["personal0001"] }),
        new Set(["personal0001"]),
        { blocked }
      )
    ).toBe("personal0001")
    // a blocked folder resolved itself → null
    expect(
      await findAncestorIn(
        saAuth(),
        file({
          id: "personal0001",
          mimeType: DRIVE_FOLDER_MIME,
          parents: ["company00001"],
        }),
        new Set(["company00001"]),
        { blocked }
      )
    ).toBeNull()
    // without the option: unchanged behaviour
    expect(
      await findAncestorIn(
        saAuth(),
        file({ parents: ["personal0001"] }),
        new Set(["company00001"])
      )
    ).toBe("company00001")
  })

  it("lỗi khác (vd. 400 / quota) không bị nuốt", async () => {
    const m = mockGoogleFetch()
    tree(m, { parentA00001: "error" })
    expect(
      (
        await driveErr(
          findAncestorIn(
            saAuth(),
            file({ parents: ["parentA00001"] }),
            new Set(["x0000000001"])
          )
        )
      ).code
    ).toBe("upstream_error")
  })
})

describe("driveContentKey", () => {
  it("md5 > headRevisionId > version", () => {
    expect(driveContentKey(file())).toBe(
      "md5:0123456789abcdef0123456789abcdef:204800"
    )
    expect(driveContentKey(file({ md5: null }))).toBe("rev:rev-1:204800")
    expect(driveContentKey(file({ md5: null, headRevisionId: null }))).toBe(
      "ver:7"
    )
    expect(driveContentKey(file({ sizeBytes: null }))).toBe("ver:7")
    expect(
      driveContentKey(file({ md5: null, headRevisionId: null, version: null }))
    ).toBeNull()
  })
})

describe("checkServiceAccountAccess", () => {
  it("xin token mới + files.list pageSize=1", async () => {
    const m = mockGoogleFetch()
    m.on(api, () => json({ files: [] }))
    const auth = saAuth()
    await checkServiceAccountAccess(auth)
    await checkServiceAccountAccess(auth)
    expect(m.tokenCalls()).toHaveLength(2)
    const c = m.api()[0]!
    expect(c.url.pathname).toBe("/drive/v3/files")
    expect(c.url.searchParams.get("pageSize")).toBe("1")
    expect(c.url.searchParams.get("fields")).toBe("files(id)")
  })

  it("API chưa bật → api_disabled; khoá bị thu hồi → auth_failed; API key → not_configured", async () => {
    const m = mockGoogleFetch()
    m.once(api, () => googleError(403, "accessNotConfigured"))
    expect((await driveErr(checkServiceAccountAccess(saAuth()))).code).toBe(
      "api_disabled"
    )
    m.once(isToken, () =>
      json(
        { error: "invalid_grant", error_description: "Invalid JWT Signature." },
        400
      )
    )
    expect((await driveErr(checkServiceAccountAccess(saAuth()))).code).toBe(
      "auth_failed"
    )
    expect((await driveErr(checkServiceAccountAccess(keyAuth()))).code).toBe(
      "not_configured"
    )
  })
})

describe("fetchDriveThumbnail", () => {
  const THUMB = "https://lh3.googleusercontent.com/drive-storage/abc=s220"

  it("tải thumbnailLink bằng cùng thông tin xác thực", async () => {
    const m = mockGoogleFetch()
    m.on(
      (c) => c.url.hostname === "www.googleapis.com",
      () => json({ id: FILE_ID, thumbnailLink: THUMB })
    )
    m.on(
      (c) => c.url.hostname === "lh3.googleusercontent.com",
      () =>
        streamResponse([Buffer.from([0xff, 0xd8, 0xff])], 200, {
          "content-type": "image/jpeg",
        })
    )
    const t = await fetchDriveThumbnail(saAuth(), FILE_ID)
    expect(t).toEqual({
      contentType: "image/jpeg",
      bytes: Buffer.from([0xff, 0xd8, 0xff]),
    })
    const meta = m.api()[0]!
    expect(meta.url.searchParams.get("fields")).toBe("id,thumbnailLink")
    const img = m.api()[1]!
    expect(img.headers.authorization).toBe("Bearer ya29.test-token-1")
  })

  it("API key không đi theo tới googleusercontent.com", async () => {
    const m = mockGoogleFetch()
    m.on(
      (c) => c.url.hostname === "www.googleapis.com",
      () => json({ thumbnailLink: THUMB })
    )
    m.on(
      (c) => c.url.hostname === "lh3.googleusercontent.com",
      () =>
        streamResponse([Buffer.from("x")], 200, { "content-type": "image/png" })
    )
    await fetchDriveThumbnail(keyAuth(), FILE_ID)
    expect(m.api()[1]!.url.searchParams.has("key")).toBe(false)
    expect(m.api()[1]!.headers.authorization).toBeUndefined()
  })

  it.each([
    ["không có thumbnailLink", {}],
    ["host lạ", { thumbnailLink: "https://evil.example/x.jpg" }],
    ["http", { thumbnailLink: "http://lh3.googleusercontent.com/x" }],
  ] as [string, Record<string, string>][])("%s → null", async (_, meta) => {
    const m = mockGoogleFetch()
    m.on(
      (c) => c.url.hostname === "www.googleapis.com",
      () => json(meta)
    )
    expect(await fetchDriveThumbnail(saAuth(), FILE_ID)).toBeNull()
    expect(m.api()).toHaveLength(1)
  })

  it("không phải ảnh / quá 1 MB / 404 → null", async () => {
    const m = mockGoogleFetch()
    m.on(
      (c) => c.url.hostname === "www.googleapis.com",
      () => json({ thumbnailLink: THUMB })
    )
    m.once(
      (c) => c.url.hostname === "lh3.googleusercontent.com",
      () =>
        streamResponse([Buffer.from("<svg/>")], 200, {
          "content-type": "image/svg+xml",
        })
    )
    m.once(
      (c) => c.url.hostname === "lh3.googleusercontent.com",
      () =>
        streamResponse(
          [Buffer.alloc(600 * 1024), Buffer.alloc(600 * 1024)],
          200,
          { "content-type": "image/jpeg" }
        )
    )
    m.once(
      (c) => c.url.hostname === "lh3.googleusercontent.com",
      () => new Response("gone", { status: 404 })
    )
    expect(await fetchDriveThumbnail(saAuth(), FILE_ID)).toBeNull()
    expect(await fetchDriveThumbnail(saAuth(), FILE_ID)).toBeNull()
    expect(await fetchDriveThumbnail(saAuth(), FILE_ID)).toBeNull()
  })
})
