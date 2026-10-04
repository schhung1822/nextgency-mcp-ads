import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import packageJson from "../../package.json"
import { getAppVersion } from "./app-version"

describe("getAppVersion", () => {
  it("ưu tiên APP_BUILD_VERSION, bỏ chữ v", () => {
    expect(getAppVersion({ APP_BUILD_VERSION: "v1.4.2" })).toBe("1.4.2")
    expect(getAppVersion({ APP_BUILD_VERSION: "1.4.2" })).toBe("1.4.2")
  })

  it("rơi về package.json khi biến trống hoặc không có", () => {
    expect(getAppVersion({})).toBe(packageJson.version)
    expect(getAppVersion({ APP_BUILD_VERSION: "   " })).toBe(packageJson.version)
  })

  it("giữ nguyên giá trị không phải semver (dev) sau khi làm sạch", () => {
    expect(getAppVersion({ APP_BUILD_VERSION: "dev" })).toBe("dev")
    expect(getAppVersion({ APP_BUILD_VERSION: "<script>x</script>" })).toBe("scriptxscript")
    expect(getAppVersion({ APP_BUILD_VERSION: "a".repeat(100) })).toHaveLength(32)
  })

  it("bản 1.2.3-rc1 (pre-release) không được coi là phát hành nhưng vẫn hiển thị được", () => {
    expect(getAppVersion({ APP_BUILD_VERSION: "v1.2.3-rc1" })).toBe("v1.2.3-rc1")
  })
})
