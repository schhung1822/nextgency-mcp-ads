// Unit tests of the Drive service error mapping (DB behaviour of the credentials is covered in drive-sources.test.ts:
// the system credential is a singleton, so all DB tests of the Drive services run in one file, in order).
import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import { drive } from "@/lib/i18n/vi/drive"
import { driveUi } from "@/lib/i18n/vi/drive-ui"
import { DriveError } from "@/server/drive/errors"
import { GoogleAuthError } from "@/server/google/service-account"

import {
  driveErrorMessage,
  DriveServiceError,
  isConfigProblem,
  toDriveServiceError,
} from "./drive-credentials"

describe("Drive service error mapping", () => {
  it("DriveError → Vietnamese message + hint, on the requested field", () => {
    const e = toDriveServiceError(
      new DriveError("api_disabled"),
      "serviceAccountJson"
    )
    expect(e).toBeInstanceOf(DriveServiceError)
    expect(e.message).toBe(
      `${drive.errors.api_disabled.message} ${drive.errors.api_disabled.hint}`
    )
    expect(e.fieldErrors).toEqual({ serviceAccountJson: e.message })
  })

  it("GoogleAuthError (invalid_grant, invalid_json) → auth_failed / its own Vietnamese message", () => {
    expect(driveErrorMessage(new GoogleAuthError("invalid_grant"))).toContain(
      drive.errors.auth_failed.message
    )
    expect(
      driveErrorMessage(
        new GoogleAuthError("invalid_json", { userMessageVi: "JSON hỏng" })
      )
    ).toContain("JSON hỏng")
    expect(isConfigProblem(new GoogleAuthError("invalid_grant"))).toBe(true)
    expect(isConfigProblem(new GoogleAuthError("network"))).toBe(false)
  })

  it("retryable Drive errors are not configuration problems; unknown errors stay generic (never echoed)", () => {
    expect(isConfigProblem(new DriveError("rate_limited"))).toBe(false)
    expect(isConfigProblem(new DriveError("not_found"))).toBe(true)
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const e = toDriveServiceError(
      new Error("boom -----BEGIN PRIVATE KEY----- secret")
    )
    expect(e.message).toBe(driveUi.service.googleUnavailable)
    expect(e.message).not.toContain("PRIVATE")
    spy.mockRestore()
    const same = new DriveServiceError("x")
    expect(toDriveServiceError(same)).toBe(same)
  })
})
