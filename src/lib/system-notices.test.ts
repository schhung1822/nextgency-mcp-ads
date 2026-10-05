import { describe, expect, it } from "vitest"

import {
  MAX_NOTICE_CHARS,
  MAX_NOTICES,
  parseNoticesPayload,
  sanitizeNoticeText,
} from "./system-notices"

describe("parseNoticesPayload (webhook answer → notices)", () => {
  it("reads the single-row answer the webhook returns today", () => {
    const row = {
      Id: 1,
      CreatedAt: "2026-10-04 04:56:53+00:00",
      UpdatedAt: "2026-10-04 04:59:18+00:00",
      content: "Test",
      status: "on",
    }
    expect(parseNoticesPayload(row)).toEqual([{ id: "n-1", content: "Test" }])
  })

  it("reads an array of rows and wrapper objects ({ list: [...] })", () => {
    const rows = [
      { Id: 1, content: "Một", status: "on" },
      { Id: 2, content: "Hai" },
    ]
    expect(parseNoticesPayload(rows).map((n) => n.content)).toEqual([
      "Một",
      "Hai",
    ])
    expect(
      parseNoticesPayload({ list: rows, pageInfo: {} }).map((n) => n.content)
    ).toEqual(["Một", "Hai"])
  })

  it("hides rows whose status is off, empty contents and exact duplicates", () => {
    const rows = [
      { Id: 1, content: "Đang bật", status: "on" },
      { Id: 2, content: "Đã tắt", status: "off" },
      { Id: 3, content: "Tắt bằng boolean", status: false },
      { Id: 4, content: "   " },
      { Id: 5, content: "Đang bật" },
      { Id: 6, content: 42 },
      "rác",
      null,
    ]
    expect(parseNoticesPayload(rows)).toEqual([
      { id: "n-1", content: "Đang bật" },
    ])
  })

  it("anything that is not a row → no notice", () => {
    for (const p of [null, "Test", 1, true, [], {}, { content: null }])
      expect(parseNoticesPayload(p)).toEqual([])
  })

  it(`keeps at most ${MAX_NOTICES} notices, in order`, () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({
      Id: i,
      content: `TB ${i}`,
    }))
    const out = parseNoticesPayload(rows)
    expect(out).toHaveLength(MAX_NOTICES)
    expect(out[0]!.content).toBe("TB 0")
  })

  it("ids stay unique when the webhook repeats one", () => {
    const out = parseNoticesPayload([
      { Id: 7, content: "A" },
      { Id: 7, content: "B" },
    ])
    expect(new Set(out.map((n) => n.id)).size).toBe(2)
  })
})

describe("sanitizeNoticeText", () => {
  it("one line: newlines/tabs collapse, control / zero-width / bidi characters are removed", () => {
    expect(sanitizeNoticeText("  Dòng 1\r\nDòng\t2\u0007​‮  ")).toBe(
      "Dòng 1 Dòng 2"
    )
  })

  it(`cuts at ${MAX_NOTICE_CHARS} characters with an ellipsis`, () => {
    const s = sanitizeNoticeText("a".repeat(MAX_NOTICE_CHARS + 50))
    expect(s.length).toBe(MAX_NOTICE_CHARS)
    expect(s.endsWith("…")).toBe(true)
  })
})
