// Drive / Sheets errors with a Vietnamese message + hint (i18n: src/lib/i18n/vi/drive.ts `errors`).
// Messages never contain a URL, a token, an API key or a resource key. No imports from "next/*".
import { drive as m } from "@/lib/i18n/vi/drive"

export type DriveErrorCode = keyof typeof m.errors

export class DriveError extends Error {
  readonly code: DriveErrorCode
  readonly userMessageVi: string
  readonly hintVi: string | null
  /** HTTP status returned by Google, when there was one */
  readonly httpStatus: number | null
  /** safe to retry later (rate limits, 5xx, timeouts) */
  readonly retryable: boolean

  constructor(
    code: DriveErrorCode,
    o: {
      message?: string
      hint?: string | null
      httpStatus?: number | null
      retryable?: boolean
      cause?: unknown
    } = {}
  ) {
    const d = m.errors[code]
    super(
      `drive ${code}`,
      o.cause === undefined ? undefined : { cause: o.cause }
    )
    this.name = "DriveError"
    this.code = code
    this.userMessageVi = o.message ?? d.message
    this.hintVi = o.hint === undefined ? d.hint : o.hint
    this.httpStatus = o.httpStatus ?? null
    this.retryable =
      o.retryable ??
      (code === "rate_limited" ||
        code === "sheet_busy" ||
        code === "timeout" ||
        code === "upstream_error")
  }
}

export function isDriveError(e: unknown): e is DriveError {
  return e instanceof DriveError
}
