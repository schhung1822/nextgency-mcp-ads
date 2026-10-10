import { describe, expect, it } from "vitest"

import { tiktokGmvMax, tiktokGmvMaxMcp } from "@/lib/i18n/vi/tiktok-gmv-max"
import {
  defaultMcpFormValues,
  type McpFormValues,
} from "@/lib/schemas/mcp-servers"

import {
  gmvMaxFlagsFromMeta,
  gmvMaxSwitchState,
  selectedGmvMaxAccounts,
} from "./tiktok-gmv-max"

const ACCOUNTS = [
  { id: "a1", externalId: "7001", name: "Shop A" },
  { id: "a2", externalId: "7002", name: "Không shop" },
  { id: "a3", externalId: "7003", name: "Shop C" },
]

describe("gmvMaxFlagsFromMeta", () => {
  it("map advertiserId → ad account; bỏ tài khoản không có cửa hàng", () => {
    const meta = {
      appId: "x",
      gmvMax: {
        checkedAt: "2026-10-10T00:00:00Z",
        advertisers: [
          { advertiserId: "7001", shops: 2, ready: 1 },
          { advertiserId: "7002", shops: 0, ready: 0 },
          { advertiserId: "7003", shops: 1, ready: 0 },
          { advertiserId: "9999", shops: 3, ready: 3 },
        ],
        notChecked: 0,
        permissionDenied: false,
        failed: false,
      },
    }
    expect(gmvMaxFlagsFromMeta(meta, ACCOUNTS)).toEqual({
      a1: { shops: 2, ready: 1 },
      a3: { shops: 1, ready: 0 },
    })
  })

  it("meta thiếu / sai kiểu → không có cờ (không ném lỗi)", () => {
    for (const meta of [
      null,
      undefined,
      "x",
      {},
      { gmvMax: null },
      { gmvMax: { advertisers: "x" } },
      {
        gmvMax: {
          advertisers: [
            null,
            1,
            { advertiserId: "7001", shops: "2", ready: -1 },
          ],
        },
      },
    ]) {
      expect(gmvMaxFlagsFromMeta(meta, ACCOUNTS)).toEqual({})
    }
  })
})

function withTiktok(
  connections: {
    connectionId: string
    mode: "all" | "pick"
    accountIds: string[]
  }[],
  enabled = true
): McpFormValues {
  const v = defaultMcpFormValues()
  v.platforms.tiktok = { enabled, connections, permissions: ["read"] }
  return v
}

const CONNS = [
  {
    id: "c1",
    platform: "tiktok",
    accounts: ACCOUNTS.map(({ id, name }) => ({ id, name })),
  },
  {
    id: "m1",
    platform: "meta",
    accounts: [{ id: "a1", name: "Meta trùng id" }],
  },
]
const FLAGS = { a1: { shops: 2, ready: 1 }, a3: { shops: 1, ready: 0 } }

describe("selectedGmvMaxAccounts", () => {
  it("cả kết nối (all) → mọi tài khoản có GMV Max", () => {
    const r = selectedGmvMaxAccounts(
      withTiktok([{ connectionId: "c1", mode: "all", accountIds: [] }]),
      CONNS,
      FLAGS
    )
    expect(r.map((a) => a.name)).toEqual(["Shop A", "Shop C"])
  })

  it("chọn từng tài khoản → chỉ tài khoản đã chọn", () => {
    const r = selectedGmvMaxAccounts(
      withTiktok([
        { connectionId: "c1", mode: "pick", accountIds: ["a2", "a3"] },
      ]),
      CONNS,
      FLAGS
    )
    expect(r).toEqual([{ id: "a3", name: "Shop C", shops: 1, ready: 0 }])
  })

  it("TikTok chưa bật / kết nối lạ / không phải TikTok → rỗng", () => {
    expect(
      selectedGmvMaxAccounts(
        withTiktok(
          [{ connectionId: "c1", mode: "all", accountIds: [] }],
          false
        ),
        CONNS,
        FLAGS
      )
    ).toEqual([])
    expect(
      selectedGmvMaxAccounts(
        withTiktok([
          { connectionId: "zz", mode: "all", accountIds: [] },
          { connectionId: "m1", mode: "all", accountIds: [] },
        ]),
        CONNS,
        FLAGS
      )
    ).toEqual([])
  })
})

describe("gmvMaxSwitchState - chỉ quản trị viên bật được", () => {
  it("admin: luôn đổi được", () => {
    for (const savedOn of [false, true])
      for (const checked of [false, true])
        expect(gmvMaxSwitchState({ isAdmin: true, savedOn, checked })).toEqual({
          disabled: false,
          locked: false,
        })
  })

  it("nhân viên, chưa được bật: khoá ở trạng thái tắt", () => {
    expect(
      gmvMaxSwitchState({ isAdmin: false, savedOn: false, checked: false })
    ).toEqual({
      disabled: true,
      locked: true,
    })
    // a stray "on" can still be turned off
    expect(
      gmvMaxSwitchState({ isAdmin: false, savedOn: false, checked: true })
    ).toEqual({
      disabled: false,
      locked: true,
    })
  })

  it("nhân viên, quản trị viên đã bật: tắt được (và bật lại giá trị đã lưu trước khi lưu)", () => {
    for (const checked of [false, true])
      expect(
        gmvMaxSwitchState({ isAdmin: false, savedOn: true, checked })
      ).toEqual({
        disabled: false,
        locked: false,
      })
  })
})

describe("chuỗi GMV Max theo quy tắc mới", () => {
  it("không còn câu 'AI không được' của giai đoạn 1; nêu quản trị viên + xác nhận 2 bước + chạy ngay", () => {
    const all = JSON.stringify(tiktokGmvMax)
    expect(all).not.toContain("**không được** đổi ngân sách")
    expect(all).toContain("quản trị viên")
    expect(all).toContain("xác nhận 2 bước")
    expect(tiktokGmvMax.caution.runsNow).toContain("CHẠY NGAY")
    expect(tiktokGmvMaxMcp.staffLocked).toBe(
      "Chỉ quản trị viên bật được - nhờ quản trị viên mở MCP này để bật."
    )
    expect(tiktokGmvMaxMcp.switchLabel).toBe(
      "Cho phép AI thay đổi GMV Max (TikTok Shop)"
    )
  })

  it("bước cấp quyền yêu cầu tick tất cả, kể cả mọi ô con GMV MAX", () => {
    const scope = tiktokGmvMax.scope.steps.map((s) => s.text).join(" ")
    for (const k of [
      "tất cả",
      "Store Management",
      "Identity And Video",
      "Session",
      "Exclusive Authorization",
      "custom anchor",
      "GMV MAX Report",
      "Onsite Commerce Store",
    ])
      expect(scope).toContain(k)
  })
})
