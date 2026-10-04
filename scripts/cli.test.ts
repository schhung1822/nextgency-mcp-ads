import { afterEach, describe, expect, it, vi } from "vitest"

import { resolveSecret } from "./cli"

const base = { argvFlag: "--client-secret", env: "TEST_CLI_SECRET", fromStdin: false, promptIfMissing: false, prompt: "" }

describe("resolveSecret (CLI secrets never need argv)", () => {
  afterEach(() => {
    delete process.env.TEST_CLI_SECRET
  })

  it("reads the environment variable", async () => {
    process.env.TEST_CLI_SECRET = "from-env"
    expect(await resolveSecret({ ...base, argv: undefined })).toBe("from-env")
  })

  it("still accepts argv but warns on stderr", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    process.env.TEST_CLI_SECRET = "from-env"
    expect(await resolveSecret({ ...base, argv: "from-argv" })).toBe("from-argv")
    expect(String(write.mock.calls[0]?.[0])).toMatch(/--client-secret.*TEST_CLI_SECRET/)
  })

  it("returns undefined when nothing is provided and no prompt is allowed", async () => {
    expect(await resolveSecret({ ...base, argv: undefined })).toBeUndefined()
  })
})
