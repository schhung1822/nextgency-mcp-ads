import { describe, expect, it } from "vitest"

import { explainDockerFailure, lastOutputLine } from "./updater-core"

describe("explainDockerFailure (admin-facing reason of a failed docker command)", () => {
  it("denied: names the credential directory the updater really uses", () => {
    const why = explainDockerFailure(
      ["Error response from daemon: error from registry: denied"],
      { credDir: "/home/deploy/.docker" }
    )
    expect(why).toContain("/home/deploy/.docker")
    expect(why).toContain("read:packages")
    expect(why).toContain("UPDATER_DOCKER_CONFIG")
  })

  it("denied without a known directory falls back to the default location hint", () => {
    expect(
      explainDockerFailure(["unauthorized: authentication required"], {
        credDir: null,
      })
    ).toContain("/root/.docker")
  })

  it.each([
    ["manifest unknown", "manifest unknown"],
    ["toomanyrequests: retry later", "toomanyrequests"],
    ["write /var/lib/docker/tmp: no space left on device", "hết dung lượng"],
    ["dial tcp: lookup ghcr.io: no such host", "lỗi mạng"],
  ])("%s", (line, expected) => {
    expect(explainDockerFailure([line], { credDir: null })).toContain(expected)
  })

  it("unknown output → null (the caller shows the raw last line)", () => {
    expect(
      explainDockerFailure(["something odd happened"], { credDir: null })
    ).toBeNull()
    expect(
      lastOutputLine(["$ docker pull x", "something odd happened", ""])
    ).toBe("something odd happened")
    expect(lastOutputLine(["x".repeat(300)])!.length).toBe(181)
  })
})
