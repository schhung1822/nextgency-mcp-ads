import { describe, expect, it } from "vitest"

import {
  compareSemver,
  compareVersions,
  displayVersion,
  isNewerVersion,
  parseSemver,
  pickLatestTag,
  versionFromTag,
} from "./version"

describe("parseSemver (chặt: chỉ MAJOR.MINOR.PATCH)", () => {
  it("đọc đúng bản hợp lệ", () => {
    expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 })
    expect(parseSemver("0.0.0")).toEqual({ major: 0, minor: 0, patch: 0 })
    expect(parseSemver("10.20.300")).toEqual({ major: 10, minor: 20, patch: 300 })
  })

  it.each(["v1.2.3", "1.2", "1.2.3.4", "1.2.3-rc1", "1.2.3+build", "01.2.3", "1.02.3", "1.2.-3", "", " 1.2.3", "1.2.3\n", "dev", "1.2.x", "1234567890.0.0"])(
    "từ chối %j",
    (v) => {
      expect(parseSemver(v)).toBeNull()
    }
  )
})

describe("versionFromTag", () => {
  it("bắt buộc có v và bỏ qua pre-release", () => {
    expect(versionFromTag("v1.2.0")).toBe("1.2.0")
    expect(versionFromTag("1.2.0")).toBeNull()
    expect(versionFromTag("v1.2.0-rc.1")).toBeNull()
    expect(versionFromTag("release-1.2.0")).toBeNull()
    expect(versionFromTag("vv1.2.0")).toBeNull()
  })
})

describe("so sánh phiên bản", () => {
  it("so từng thành phần theo số, không theo chữ", () => {
    expect(compareVersions("1.10.0", "1.9.9")).toBeGreaterThan(0)
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0)
    expect(compareVersions("0.9.9", "1.0.0")).toBeLessThan(0)
    expect(compareSemver({ major: 2, minor: 0, patch: 0 }, { major: 1, minor: 99, patch: 99 })).toBeGreaterThan(0)
  })

  it("null khi một bên không phải semver", () => {
    expect(compareVersions("dev", "1.0.0")).toBeNull()
    expect(compareVersions("1.0.0", "1.0.0-rc1")).toBeNull()
  })

  it("isNewerVersion chỉ true khi cả hai hợp lệ và mới hơn", () => {
    expect(isNewerVersion("1.3.0", "1.2.0")).toBe(true)
    expect(isNewerVersion("1.2.0", "1.2.0")).toBe(false)
    expect(isNewerVersion("1.1.0", "1.2.0")).toBe(false)
    expect(isNewerVersion("1.3.0", "dev")).toBe(false)
    expect(isNewerVersion("garbage", "1.2.0")).toBe(false)
  })
})

describe("pickLatestTag", () => {
  it("chọn tag semver cao nhất, bỏ qua tag lạ và pre-release", () => {
    expect(pickLatestTag(["v1.2.0", "v1.10.0", "v1.9.0", "v2.0.0-rc1", "nightly", "1.99.0"])).toEqual({
      tag: "v1.10.0",
      version: "1.10.0",
    })
    expect(pickLatestTag(["nightly", "main"])).toBeNull()
    expect(pickLatestTag([])).toBeNull()
  })
})

describe("displayVersion", () => {
  it("thêm v cho bản phát hành, giữ nguyên dev", () => {
    expect(displayVersion("1.2.0")).toBe("v1.2.0")
    expect(displayVersion("dev")).toBe("dev")
  })
})
