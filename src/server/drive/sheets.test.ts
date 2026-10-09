// Sheets: A1 notation (quoted titles), tab lookup by gid, row reads (ranges, FORMATTED_VALUE, empty rows skipped,
// nextRow), 30 s read cache (per credential, fresh bypass, invalidated by writes), RAW batchUpdate body,
// in-process budget (sheet_busy before calling Google) and Google 429 → sheet_busy.
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { __clearGoogleTokenCache } from "../google/service-account"
import {
  googleError,
  isToken,
  json,
  mockGoogleFetch,
  saAuth,
  type GoogleCall,
} from "./__fixtures__/google-fetch"
import { __setDriveRetryBaseMs } from "./client"
import { DriveError } from "./errors"
import { __resetSheetsLimiter } from "./rate-limit"
import {
  __clearSheetsCache,
  a1Cell,
  a1Rows,
  columnLetter,
  getSheetMeta,
  readSheetCells,
  readSheetRows,
  writeSheetCells,
} from "./sheets"
import { DRIVE_LIMITS } from "./types"

const SHEET_ID = "1SpReAdShEeTiD_abcdefghijk"
const api = (c: GoogleCall) => !isToken(c)

async function driveErr(p: Promise<unknown>): Promise<DriveError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x
  )
  expect(e).toBeInstanceOf(DriveError)
  return e as DriveError
}

beforeEach(() => {
  __clearGoogleTokenCache()
  __clearSheetsCache()
  __resetSheetsLimiter()
  __setDriveRetryBaseMs(1)
})
afterEach(() => __setDriveRetryBaseMs(1_000))

describe("A1", () => {
  it("columnLetter", () => {
    expect([1, 2, 26, 27, 52, 53, 702, 703, 18278].map(columnLetter)).toEqual([
      "A",
      "B",
      "Z",
      "AA",
      "AZ",
      "BA",
      "ZZ",
      "AAA",
      "ZZZ",
    ])
    expect(() => columnLetter(0)).toThrow(RangeError)
    expect(() => columnLetter(1.5)).toThrow(RangeError)
  })

  it("a1Cell / a1Rows luôn đặt tên tab trong nháy đơn, nhân đôi nháy bên trong", () => {
    expect(a1Cell("It's", 2, 2)).toBe("'It''s'!B2")
    expect(a1Cell("Creative tuần 41", 6, 12)).toBe("'Creative tuần 41'!F12")
    expect(a1Cell("Sheet1", 1, 1)).toBe("'Sheet1'!A1")
    expect(a1Rows("A!B", 2, 51)).toBe("'A!B'!2:51")
    expect(() => a1Cell("x", 1, 0)).toThrow(RangeError)
  })
})

describe("getSheetMeta", () => {
  const meta = {
    properties: { title: "Creative Q4" },
    sheets: [
      {
        properties: {
          sheetId: 0,
          title: "Tổng",
          gridProperties: { rowCount: 1000 },
        },
      },
      {
        properties: {
          sheetId: 123456,
          title: "Tuần 41",
          gridProperties: { rowCount: 250 },
        },
      },
    ],
  }

  it("tìm tab theo gid (tên tab có thể đổi)", async () => {
    const m = mockGoogleFetch()
    m.on(api, () => json(meta))
    expect(await getSheetMeta(saAuth(), SHEET_ID, 123456)).toEqual({
      spreadsheetTitle: "Creative Q4",
      title: "Tuần 41",
      gid: 123456,
      rowCount: 250,
    })
    const c = m.api()[0]!
    expect(c.url.origin + c.url.pathname).toBe(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}`
    )
    expect(c.url.searchParams.get("fields")).toBe(
      "properties.title,sheets.properties(sheetId,title,gridProperties.rowCount)"
    )
    expect(c.headers.authorization).toMatch(/^Bearer /)
  })

  it("gid không còn → sheet_tab_not_found; mã sheet sai → invalid_link", async () => {
    const m = mockGoogleFetch()
    m.on(api, () => json(meta))
    expect((await driveErr(getSheetMeta(saAuth(), SHEET_ID, 999))).code).toBe(
      "sheet_tab_not_found"
    )
    expect((await driveErr(getSheetMeta(saAuth(), "bad", 0))).code).toBe(
      "invalid_link"
    )
  })

  it("không có quyền → permission_denied", async () => {
    const m = mockGoogleFetch()
    m.on(api, () => googleError(403, null, { status: "PERMISSION_DENIED" }))
    expect((await driveErr(getSheetMeta(saAuth(), SHEET_ID, 0))).code).toBe(
      "permission_denied"
    )
  })
})

describe("readSheetRows", () => {
  it("batchGet dòng tiêu đề + vùng dữ liệu, FORMATTED_VALUE, bỏ dòng trống, đánh số dòng đúng", async () => {
    const m = mockGoogleFetch()
    m.on(api, () =>
      json({
        valueRanges: [
          {
            range: "'Tuần 41'!1:1",
            values: [["Link Drive", "Trạng thái", "Số"]],
          },
          {
            range: "'Tuần 41'!2:6",
            values: [
              ["https://drive.google.com/file/d/x", "Chờ lên", 5],
              [],
              ["", ""],
              ["b", null],
            ],
          },
        ],
      })
    )
    const r = await readSheetRows(saAuth(), SHEET_ID, "Tuần 41", {
      headerRow: 1,
      maxRows: 5,
    })
    const c = m.api()[0]!
    expect(c.url.pathname).toBe(`/v4/spreadsheets/${SHEET_ID}/values:batchGet`)
    expect(c.url.searchParams.getAll("ranges")).toEqual([
      "'Tuần 41'!1:1",
      "'Tuần 41'!2:6",
    ])
    expect(c.url.searchParams.get("valueRenderOption")).toBe("FORMATTED_VALUE")
    expect(c.url.searchParams.get("majorDimension")).toBe("ROWS")
    expect(r.header).toEqual(["Link Drive", "Trạng thái", "Số"])
    expect(r.rows).toEqual([
      {
        rowNumber: 2,
        cells: ["https://drive.google.com/file/d/x", "Chờ lên", "5"],
      },
      { rowNumber: 5, cells: ["b", ""] },
    ])
    // 4 rows returned for 5 asked: the sheet ends inside the range
    expect(r.nextRow).toBeNull()
  })

  it("startRow + nextRow khi vùng đầy", async () => {
    const m = mockGoogleFetch()
    m.on(api, () =>
      json({ valueRanges: [{ values: [["h"]] }, { values: [["a"], ["b"]] }] })
    )
    const r = await readSheetRows(saAuth(), SHEET_ID, "S", {
      headerRow: 3,
      startRow: 10,
      maxRows: 2,
    })
    expect(m.api()[0]!.url.searchParams.getAll("ranges")).toEqual([
      "'S'!3:3",
      "'S'!10:11",
    ])
    expect(r.rows.map((x) => x.rowNumber)).toEqual([10, 11])
    expect(r.nextRow).toBe(12)
    // startRow above the header is clamped below it
    await readSheetRows(saAuth(), SHEET_ID, "S", {
      headerRow: 3,
      startRow: 1,
      maxRows: 2,
    })
    expect(m.api()[1]!.url.searchParams.getAll("ranges")[1]).toBe("'S'!4:5")
  })

  it("cache 30 s theo (credential, sheet, vùng); fresh bỏ qua cache; kết quả trả về là bản sao", async () => {
    const m = mockGoogleFetch()
    m.on(api, () =>
      json({ valueRanges: [{ values: [["h"]] }, { values: [["a"]] }] })
    )
    const a = await readSheetRows(saAuth("drive_credential:1"), SHEET_ID, "S", {
      headerRow: 1,
      maxRows: 10,
    })
    a.rows[0]!.cells[0] = "mutated"
    const b = await readSheetRows(saAuth("drive_credential:1"), SHEET_ID, "S", {
      headerRow: 1,
      maxRows: 10,
    })
    expect(b.rows[0]!.cells[0]).toBe("a")
    expect(m.api()).toHaveLength(1)
    await readSheetRows(saAuth("drive_credential:2"), SHEET_ID, "S", {
      headerRow: 1,
      maxRows: 10,
    })
    expect(m.api()).toHaveLength(2)
    await readSheetRows(saAuth("drive_credential:1"), SHEET_ID, "S", {
      headerRow: 1,
      maxRows: 10,
      fresh: true,
    })
    expect(m.api()).toHaveLength(3)
  })
})

describe("readSheetCells", () => {
  it("đọc từng ô, không cache", async () => {
    const m = mockGoogleFetch()
    m.on(api, () => json({ valueRanges: [{ values: [["link-1"]] }, {}] }))
    const ranges = [a1Cell("S", 1, 2), a1Cell("S", 1, 3)]
    expect(await readSheetCells(saAuth(), SHEET_ID, ranges)).toEqual([
      "link-1",
      "",
    ])
    expect(await readSheetCells(saAuth(), SHEET_ID, ranges)).toEqual([
      "link-1",
      "",
    ])
    expect(m.api()).toHaveLength(2)
    expect(m.api()[0]!.url.searchParams.getAll("ranges")).toEqual([
      "'S'!A2",
      "'S'!A3",
    ])
    expect(await readSheetCells(saAuth(), SHEET_ID, [])).toEqual([])
  })
})

describe("writeSheetCells", () => {
  it("values:batchUpdate với RAW (công thức lưu dạng chữ), giá trị là chuỗi", async () => {
    const m = mockGoogleFetch()
    m.on(api, () => json({ totalUpdatedCells: 2 }))
    await writeSheetCells(saAuth(), SHEET_ID, [
      { range: "'S'!F2", values: [["Đã lên"]] },
      { range: "'S'!G2", values: [['=IMPORTXML("https://evil","//a")']] },
    ])
    const c = m.api()[0]!
    expect(c.method).toBe("POST")
    expect(c.url.pathname).toBe(
      `/v4/spreadsheets/${SHEET_ID}/values:batchUpdate`
    )
    expect(c.headers["content-type"]).toBe("application/json")
    expect(JSON.parse(c.body!)).toEqual({
      valueInputOption: "RAW",
      includeValuesInResponse: false,
      data: [
        { range: "'S'!F2", majorDimension: "ROWS", values: [["Đã lên"]] },
        {
          range: "'S'!G2",
          majorDimension: "ROWS",
          values: [['=IMPORTXML("https://evil","//a")']],
        },
      ],
    })
  })

  it("ghi xong thì xoá cache đọc của sheet đó", async () => {
    const m = mockGoogleFetch()
    m.on(
      (c) => api(c) && c.method === "GET",
      () => json({ valueRanges: [{ values: [["h"]] }, { values: [["a"]] }] })
    )
    m.on(
      (c) => api(c) && c.method === "POST",
      () => json({})
    )
    const read = () =>
      readSheetRows(saAuth(), SHEET_ID, "S", { headerRow: 1, maxRows: 5 })
    await read()
    await read()
    await writeSheetCells(saAuth(), SHEET_ID, [
      { range: "'S'!B2", values: [["x"]] },
    ])
    await read()
    expect(m.api().filter((c) => c.method === "GET")).toHaveLength(2)
  })
})

describe("hạn mức Sheets", () => {
  it(`quá ${DRIVE_LIMITS.sheetsReadsPerMin} lượt đọc / phút → sheet_busy, không gọi Google`, async () => {
    const m = mockGoogleFetch()
    m.on(api, () => json({ valueRanges: [] }))
    for (let i = 0; i < DRIVE_LIMITS.sheetsReadsPerMin; i++)
      await readSheetCells(saAuth(), SHEET_ID, ["'S'!A1"])
    const e = await driveErr(readSheetCells(saAuth(), SHEET_ID, ["'S'!A1"]))
    expect(e.code).toBe("sheet_busy")
    expect(e.retryable).toBe(true)
    expect(m.api()).toHaveLength(DRIVE_LIMITS.sheetsReadsPerMin)
    // writes have their own budget
    await writeSheetCells(saAuth(), SHEET_ID, [
      { range: "'S'!A1", values: [["x"]] },
    ])
  })

  it("Google trả 429 (hết thử lại) → sheet_busy", async () => {
    const m = mockGoogleFetch()
    m.on(api, () => googleError(429, "rateLimitExceeded"))
    expect(
      (await driveErr(readSheetCells(saAuth(), SHEET_ID, ["'S'!A1"]))).code
    ).toBe("sheet_busy")
    expect(m.api()).toHaveLength(3)
  })
})
