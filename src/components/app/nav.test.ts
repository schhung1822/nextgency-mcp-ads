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
      "/automation-tips",
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
      "/automation-tips",
    ])
    expect(bottomMenuItemsForRole("staff").account.href).toBe("/account")
  })

  it("highlights the Menu tab only on pages inside the Menu sheet", () => {
    expect(isBottomMenuActive("/account")).toBe(true)
    expect(isBottomMenuActive("/settings")).toBe(true)
    expect(isBottomMenuActive("/users")).toBe(true)
    expect(isBottomMenuActive("/automation-tips")).toBe(true)
    expect(isBottomMenuActive("/logs")).toBe(false)
    expect(isBottomMenuActive("/")).toBe(false)
    expect(isBottomMenuActive(null)).toBe(false)
  })

  it("builds breadcrumbs from the pathname", () => {
    expect(buildBreadcrumbs("/")).toEqual([{ label: "Tổng quan" }])
    expect(buildBreadcrumbs("/connections/new")).toEqual([
      { label: "Kết nối quảng cáo", href: "/connections" },
      { label: "Tạo mới" },
    ])
    expect(buildBreadcrumbs("/mcp-servers/123")).toEqual([
      { label: "MCP", href: "/mcp-servers" },
      { label: "Chi tiết" },
    ])
  })
})
