import { describe, expect, it } from "vitest"

import { getStatusMeta, statusValues, type StatusKind } from "./status"

describe("getStatusMeta", () => {
  it("maps connection statuses", () => {
    expect(getStatusMeta("connection", "active")).toEqual({
      label: "Hoạt động",
      tone: "success",
    })
    expect(getStatusMeta("connection", "expiring")).toEqual({
      label: "Sắp hết hạn",
      tone: "warning",
    })
    expect(getStatusMeta("connection", "invalid")).toEqual({
      label: "Lỗi xác thực",
      tone: "danger",
    })
    expect(getStatusMeta("connection", "disabled")).toEqual({
      label: "Đã tắt",
      tone: "neutral",
    })
  })

  it("maps MCP, log, object and account statuses", () => {
    expect(getStatusMeta("mcp", "expired")).toEqual({
      label: "Hết hạn",
      tone: "warning",
    })
    expect(getStatusMeta("log", "rate_limited")).toEqual({
      label: "Vượt giới hạn",
      tone: "warning",
    })
    expect(getStatusMeta("log", "pending_confirmation")).toEqual({
      label: "Chờ xác nhận",
      tone: "info",
    })
    expect(getStatusMeta("log", "denied").tone).toBe("danger")
    expect(getStatusMeta("object", "paused")).toEqual({
      label: "Tạm dừng",
      tone: "neutral",
    })
    expect(getStatusMeta("object", "rejected").tone).toBe("danger")
    expect(getStatusMeta("account", "pending")).toEqual({
      label: "Đang chờ",
      tone: "info",
    })
  })

  it("falls back to a neutral 'Không rõ' for unknown values", () => {
    expect(getStatusMeta("connection", "weird")).toEqual({
      label: "Không rõ",
      tone: "neutral",
    })
    // prototype keys must not leak through
    expect(getStatusMeta("log", "toString")).toEqual({
      label: "Không rõ",
      tone: "neutral",
    })
  })

  it("has a Vietnamese label for every status value", () => {
    const kinds: StatusKind[] = [
      "connection",
      "mcp",
      "log",
      "object",
      "account",
    ]
    for (const kind of kinds) {
      for (const s of statusValues(kind)) {
        const meta = getStatusMeta(kind, s)
        expect(meta.label, `${kind}.${s}`).not.toBe(s)
        expect(meta.label.length).toBeGreaterThan(0)
      }
    }
  })
})
