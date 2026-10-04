import { DrizzleQueryError } from "drizzle-orm/errors"
import { describe, expect, it } from "vitest"

import { safeErrorForLog, stripQueryParams } from "./safe-error"

describe("safeErrorForLog", () => {
  it("strips the params section of Drizzle query errors and keeps the pg code", () => {
    const cause = Object.assign(new Error('duplicate key value violates unique constraint "user_email_key"'), {
      code: "23505",
      detail: "Key (email)=(victim@example.com) already exists.",
    })
    const e = new DrizzleQueryError(
      'insert into "connections" ("id","credentials_encrypted") values ($1,$2)',
      ["c0ffee", "v1.secret-ciphertext.AAAA"],
      cause
    )
    const out = safeErrorForLog(e)
    expect(out).toContain('insert into "connections"')
    expect(out).toContain("23505")
    expect(out).not.toContain("params")
    expect(out).not.toContain("secret-ciphertext")
    expect(out).not.toContain("victim@example.com")
  })

  it("redacts secrets in ordinary messages and caps the length", () => {
    const out = safeErrorForLog(new Error(`token EAA${"x".repeat(40)} rejected ${"y".repeat(1000)}`))
    expect(out).not.toMatch(/EAAx{20}/)
    expect(out.length).toBeLessThanOrEqual(500)
  })

  it("handles non-errors", () => {
    expect(safeErrorForLog(undefined)).toBe("unknown error")
    expect(safeErrorForLog({})).toBe("unknown error")
    expect(stripQueryParams("Failed query: select 1\nparams: a,b")).toBe("Failed query: select 1")
  })
})
