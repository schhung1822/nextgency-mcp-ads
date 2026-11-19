// "Miễn trừ trách nhiệm" popup: the pure gating rules (read to the end + minimum time → checkbox → confirm), the
// reading progress, the one-shot handoff from the /connections/new chooser, and the content pin (changing the text
// without a new version must fail here).
import { createHash } from "node:crypto"

import { describe, expect, it } from "vitest"

import { disclaimers as t } from "@/lib/i18n/vi/disclaimers"

import {
  acceptDisclaimerSchema,
  DISCLAIMER_HANDOFF_MS,
  DISCLAIMER_KINDS,
  DISCLAIMER_MIN_READ_MS,
  DISCLAIMER_VERSIONS,
  disclaimerGate,
  disclaimerVersionDate,
  handoffAccepted,
  isCurrentDisclaimerVersion,
  readProgress,
} from "./disclaimers"

const T0 = 1_760_000_000_000

describe("disclaimerGate - chặn cho tới khi đọc hết và đủ thời gian", () => {
  it("mới mở: chưa tick được, đếm ngược đủ thời gian tối thiểu (10 giây)", () => {
    expect(DISCLAIMER_MIN_READ_MS).toBe(10_000)
    expect(
      disclaimerGate({
        reachedEnd: false,
        openedAt: T0,
        now: T0,
        checked: false,
      })
    ).toEqual({
      secondsLeft: 10,
      canCheck: false,
      canConfirm: false,
    })
  })

  it("đã kéo hết nhưng chưa đủ thời gian: vẫn khoá ô xác nhận, đếm ngược làm tròn lên", () => {
    const g = disclaimerGate({
      reachedEnd: true,
      openedAt: T0,
      now: T0 + 9_001,
      checked: true,
    })
    expect(g).toEqual({ secondsLeft: 1, canCheck: false, canConfirm: false })
    expect(
      disclaimerGate({
        reachedEnd: true,
        openedAt: T0,
        now: T0 + 4_200,
        checked: false,
      }).secondsLeft
    ).toBe(6)
  })

  it("đủ thời gian nhưng chưa kéo hết nội dung: vẫn khoá (đồng hồ không thay được việc đọc)", () => {
    const g = disclaimerGate({
      reachedEnd: false,
      openedAt: T0,
      now: T0 + 60 * 60_000,
      checked: true,
    })
    expect(g).toEqual({ secondsLeft: 0, canCheck: false, canConfirm: false })
  })

  it("đọc hết + đủ thời gian: tick được; nút xác nhận chỉ bật khi đã tick", () => {
    const base = {
      reachedEnd: true,
      openedAt: T0,
      now: T0 + DISCLAIMER_MIN_READ_MS,
    }
    expect(disclaimerGate({ ...base, checked: false })).toEqual({
      secondsLeft: 0,
      canCheck: true,
      canConfirm: false,
    })
    expect(disclaimerGate({ ...base, checked: true })).toEqual({
      secondsLeft: 0,
      canCheck: true,
      canConfirm: true,
    })
  })

  it("đang gửi xác nhận: không bấm lại được", () => {
    const g = disclaimerGate({
      reachedEnd: true,
      openedAt: T0,
      now: T0 + 20_000,
      checked: true,
      pending: true,
    })
    expect(g.canConfirm).toBe(false)
    expect(g.canCheck).toBe(true)
  })

  it("đồng hồ lùi (now < openedAt) không mở khoá sớm", () => {
    expect(
      disclaimerGate({
        reachedEnd: true,
        openedAt: T0,
        now: T0 - 50_000,
        checked: true,
      })
    ).toMatchObject({
      secondsLeft: 10,
      canConfirm: false,
    })
  })

  it("thời gian tối thiểu đổi được qua tham số (mặc định là hằng số dùng chung)", () => {
    expect(
      disclaimerGate({
        reachedEnd: true,
        openedAt: T0,
        now: T0 + 2_000,
        checked: true,
        minReadMs: 30_000,
      }).secondsLeft
    ).toBe(28)
  })
})

describe("readProgress", () => {
  it("tính phần trăm đã cuộn, kẹp trong 0-100", () => {
    expect(readProgress(0, 2000, 500)).toBe(0)
    expect(readProgress(750, 2000, 500)).toBe(50)
    expect(readProgress(1500, 2000, 500)).toBe(100)
    expect(readProgress(1600, 2000, 500)).toBe(100)
    expect(readProgress(-20, 2000, 500)).toBe(0)
  })

  it("nội dung vừa khung (không cuộn được) = 100%", () => {
    expect(readProgress(0, 400, 400)).toBe(100)
    expect(readProgress(0, 401, 400)).toBe(100)
  })
})

describe("phiên bản và dữ liệu gửi lên", () => {
  it("chỉ phiên bản hiện tại được coi là hợp lệ", () => {
    for (const k of DISCLAIMER_KINDS) {
      expect(isCurrentDisclaimerVersion(k, DISCLAIMER_VERSIONS[k])).toBe(true)
      expect(isCurrentDisclaimerVersion(k, "2020-01-01")).toBe(false)
    }
  })

  it("schema chỉ nhận loại đã biết và chuỗi phiên bản ngắn", () => {
    expect(
      acceptDisclaimerSchema.safeParse({
        kind: "connection",
        version: "2026-10-10",
      }).success
    ).toBe(true)
    expect(
      acceptDisclaimerSchema.safeParse({ kind: "mcp", version: " 2026-10-10 " })
        .data?.version
    ).toBe("2026-10-10")
    expect(
      acceptDisclaimerSchema.safeParse({
        kind: "telegram",
        version: "2026-10-10",
      }).success
    ).toBe(false)
    expect(
      acceptDisclaimerSchema.safeParse({ kind: "mcp", version: "" }).success
    ).toBe(false)
    expect(
      acceptDisclaimerSchema.safeParse({ kind: "mcp", version: "x".repeat(33) })
        .success
    ).toBe(false)
    expect(acceptDisclaimerSchema.safeParse({}).success).toBe(false)
  })

  it("ngày phiên bản hiển thị dạng dd/mm/yyyy", () => {
    expect(disclaimerVersionDate("2026-10-10")).toBe("10/10/2026")
    expect(disclaimerVersionDate("v2")).toBe("v2")
  })
})

describe("handoffAccepted - chuyển xác nhận từ trang chọn loại kết nối sang Telegram / Google Drive", () => {
  const v = DISCLAIMER_VERSIONS.connection
  const raw = (o: Record<string, unknown>) =>
    JSON.stringify({
      kind: "connection",
      version: v,
      at: T0,
      to: "/connections/drive/new",
      ...o,
    })

  it("hợp lệ: đúng loại, đúng trang đích, phiên bản hiện tại, trong 2 phút", () => {
    expect(
      handoffAccepted(
        raw({}),
        "connection",
        "/connections/drive/new",
        T0 + 1_000
      )
    ).toBe(true)
    expect(
      handoffAccepted(
        raw({}),
        "connection",
        "/connections/drive/new",
        T0 + DISCLAIMER_HANDOFF_MS
      )
    ).toBe(true)
  })

  it("từ chối: quá hạn, sai trang, sai loại, phiên bản cũ, thời gian tương lai, dữ liệu hỏng", () => {
    expect(
      handoffAccepted(
        raw({}),
        "connection",
        "/connections/drive/new",
        T0 + DISCLAIMER_HANDOFF_MS + 1
      )
    ).toBe(false)
    expect(
      handoffAccepted(
        raw({}),
        "connection",
        "/connections/telegram/new",
        T0 + 1_000
      )
    ).toBe(false)
    expect(
      handoffAccepted(raw({}), "mcp", "/connections/drive/new", T0 + 1_000)
    ).toBe(false)
    expect(
      handoffAccepted(
        raw({ version: "2020-01-01" }),
        "connection",
        "/connections/drive/new",
        T0 + 1_000
      )
    ).toBe(false)
    expect(
      handoffAccepted(
        raw({ at: T0 + 10_000 }),
        "connection",
        "/connections/drive/new",
        T0
      )
    ).toBe(false)
    expect(
      handoffAccepted(
        raw({ at: "soon" }),
        "connection",
        "/connections/drive/new",
        T0
      )
    ).toBe(false)
    expect(
      handoffAccepted("{", "connection", "/connections/drive/new", T0)
    ).toBe(false)
    expect(
      handoffAccepted(null, "connection", "/connections/drive/new", T0)
    ).toBe(false)
  })
})

describe("nội dung miễn trừ trách nhiệm", () => {
  // Sửa chữ trong src/lib/i18n/vi/disclaimers.ts mà KHÔNG tăng DISCLAIMER_VERSIONS → test này đỏ. Khi đổi nội dung:
  // tăng phiên bản (mọi người phải xác nhận lại) rồi cập nhật mã băm ở đây.
  const PINNED: Record<string, string> = {
    "connection@2026-10-10": "5e2a881d5823066e",
    "connection@2026-10-14": "6205490ab098ecb4",
    "mcp@2026-10-10": "77eb64190b243d8a",
    "connection@2026-11-19": "43627e4f006aa80f",
    "mcp@2026-11-19": "9b817bcbfe9604b0",
  }

  it("mỗi phiên bản khớp đúng nội dung đã duyệt (đổi chữ phải tăng phiên bản)", () => {
    for (const k of DISCLAIMER_KINDS) {
      const hash = createHash("sha256")
        .update(JSON.stringify(t.docs[k]))
        .digest("hex")
        .slice(0, 16)
      expect(hash, `${k}@${DISCLAIMER_VERSIONS[k]}`).toBe(
        PINNED[`${k}@${DISCLAIMER_VERSIONS[k]}`]
      )
    }
  })

  it("có đủ các mục bắt buộc", () => {
    const text = (k: "connection" | "mcp") => JSON.stringify(t.docs[k])
    for (const k of DISCLAIMER_KINDS) {
      const s = text(k)
      for (const must of [
        "Đơn vị vận hành",
        "Nextgency",
        "trong phạm vi pháp luật cho phép",
        "bồi hoàn",
        "địa chỉ IP",
        "phiên bản",
        "GMV Max",
      ])
        expect(s.toLowerCase(), `${k}: ${must}`).toContain(must.toLowerCase())
      // product name; the legal roles stay "Đơn vị vận hành" (operator, data controller) / Nextgency (developer)
      expect(s, `${k}: tên hệ thống`).toContain(
        "hệ thống Ads MCP Simple by Nextgency (“Hệ thống”)"
      )
      expect(s.toLowerCase(), `${k}: tên phần mềm`).toContain(
        "phần mềm ads mcp simple by nextgency do **nextgency** phát triển"
      )
      expect(s).not.toMatch(/Ads MCP(?! Simple by Nextgency)/)
      // shown once per version
      expect(s, `${k}: một lần mỗi phiên bản`).toContain(
        "chỉ cần xác nhận một lần cho mỗi phiên bản"
      )
    }
    // K1: quyền tối thiểu của app TikTok
    expect(text("connection")).toContain("GMV MAX → Session")
    expect(text("connection")).toContain("Exclusive Authorization")
    // K2: AI có thể sai, prompt injection, link MCP như mật khẩu, GMV Max chạy ngay, xoá không hoàn tác
    for (const must of [
      "prompt injection",
      "như mật khẩu",
      "tiêu tiền NGAY",
      "không hoàn tác",
      "không có người giám sát",
    ])
      expect(text("mcp"), must).toContain(must)
  })

  it("mục được đánh số liên tục, id không trùng", () => {
    for (const k of DISCLAIMER_KINDS) {
      const secs = t.docs[k].sections
      secs.forEach((s, i) =>
        expect(s.title.startsWith(`${i + 1}. `), s.title).toBe(true)
      )
      expect(new Set(secs.map((s) => s.id)).size).toBe(secs.length)
    }
  })
})
