import { describe, expect, it } from "vitest"

import {
  BOTTOM_NAV_ITEMS,
  bottomMenuItemsForRole,
  buildBreadcrumbs,
  isBottomMenuActive,
  isNavActive,
  navItemsForRole,
} from "./nav"

describe("nav", () => {
  it("hides admin items from staff", () => {
    expect(navItemsForRole("staff").admin).toEqual([])
    expect(navItemsForRole("admin").admin.map((i) => i.href)).toEqual([
      "/users",
      "/settings",
    ])
    expect(navItemsForRole("staff").main.map((i) => i.href)).toEqual([
      "/",
      "/connections",
      "/mcp-servers",
      "/logs",
      "/tips/automation",
    ])
  })

  it("computes the active item from the pathname", () => {
    expect(isNavActive("/", "/")).toBe(true)
    expect(isNavActive("/connections", "/")).toBe(false)
    expect(isNavActive("/connections/abc", "/connections")).toBe(true)
    expect(isNavActive("/connections/", "/connections")).toBe(true)
    expect(isNavActive("/connectionsx", "/connections")).toBe(false)
    expect(isNavActive(null, "/")).toBe(false)
    expect(isNavActive("/mcp-servers/abc", "/mcp-servers")).toBe(true)
    expect(isNavActive("/mcp/amcp_key", "/mcp-servers")).toBe(false)
    // Mẹo sử dụng: href /tips/automation, active on every tip under /tips
    expect(isNavActive("/tips/automation", "/tips/automation")).toBe(true)
    expect(isNavActive("/tips/bulk-ads", "/tips/automation")).toBe(true)
    expect(isNavActive("/tips/ad-check/", "/tips/automation")).toBe(true)
    expect(isNavActive("/tipsx", "/tips/automation")).toBe(false)
    expect(isNavActive("/automation-tips", "/tips/automation")).toBe(false)
  })

  it("keeps the phone bottom bar on the four main pages", () => {
    expect(BOTTOM_NAV_ITEMS.map((i) => [i.label, i.href])).toEqual([
      ["Tổng quan", "/"],
      ["Kết nối", "/connections"],
      ["MCP", "/mcp-servers"],
      ["Nhật ký", "/logs"],
    ])
  })

  it("puts admin pages in the Menu sheet for admins only", () => {
    expect(bottomMenuItemsForRole("admin").admin.map((i) => i.href)).toEqual([
      "/users",
      "/settings",
    ])
    expect(bottomMenuItemsForRole("staff").admin).toEqual([])
    expect(bottomMenuItemsForRole("staff").main.map((i) => i.href)).toEqual([
      "/tips/automation",
    ])
    expect(bottomMenuItemsForRole("staff").account.href).toBe("/account")
  })

  it("highlights the Menu tab only on pages inside the Menu sheet", () => {
    expect(isBottomMenuActive("/account")).toBe(true)
    expect(isBottomMenuActive("/settings")).toBe(true)
    expect(isBottomMenuActive("/users")).toBe(true)
    expect(isBottomMenuActive("/tips/automation")).toBe(true)
    expect(isBottomMenuActive("/tips/ad-check")).toBe(true)
    expect(isBottomMenuActive("/logs")).toBe(false)
    expect(isBottomMenuActive("/")).toBe(false)
    expect(isBottomMenuActive(null)).toBe(false)
  })

  it("builds breadcrumbs from the pathname", () => {
    expect(buildBreadcrumbs("/")).toEqual([{ label: "Tổng quan" }])
    expect(buildBreadcrumbs("/connections/new")).toEqual([
      { label: "Kết nối", href: "/connections" },
      { label: "Tạo mới" },
    ])
    expect(buildBreadcrumbs("/tips/bulk-ads")).toEqual([
      { label: "Mẹo sử dụng", href: "/tips/automation" },
      { label: "Tạo quảng cáo số lượng lớn" },
    ])
    expect(buildBreadcrumbs("/tips/automation")).toEqual([
      { label: "Mẹo sử dụng", href: "/tips/automation" },
      { label: "Chạy tự động" },
    ])
    expect(buildBreadcrumbs("/mcp-servers/123")).toEqual([
      { label: "MCP", href: "/mcp-servers" },
      { label: "Chi tiết" },
    ])
  })
})
