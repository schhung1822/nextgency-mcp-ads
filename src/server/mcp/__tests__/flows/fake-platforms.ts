// Fake providers for the END-TO-END flow tests: one per platform, driven by the REAL services
// (previewConnection / createConnection / syncConnectionAccounts …) and the REAL MCP endpoint.
//
// On top of the in-memory fake from ../fake-provider.ts (objects, reports, writes, extensions) these add what
// the connection flow needs:
//  - credentials are `{ token }`; every token is registered by the test with `world.registerToken()` and decides
//    what `validateCredentials()` / `listAccounts()` answer (accounts in several currencies / time zones,
//    expiry, revoked token, transient failure);
//  - every `getReport()` is recorded (account, time zone, resolved date range, cursor) so tests can assert
//    per-account date resolution and pagination.
import type { DateRange, AdAccountInfo, AdsProvider, Platform, ReportLevel } from "../../../providers/types"
import { ProviderError } from "../../../providers/errors"
import { createFakeProvider, newFakeState, type FakeState } from "../fake-provider"

export interface TokenSpec {
  /** accounts `listAccounts()` returns for this token */
  accounts: AdAccountInfo[]
  /** `validateCredentials().tokenExpiresAt` (null = never expires) */
  expiresAt?: Date | null
  /** false → validateCredentials answers `valid: false` */
  valid?: boolean
  /** throw ProviderError(auth_invalid) from validate (a revoked token) */
  authError?: boolean
  /** throw ProviderError(upstream_error) from validate (transient) */
  transientError?: boolean
  scopes?: string[] | null
  warnings?: string[]
}

export interface ReportCall {
  platform: Platform
  account: string
  timezone: string
  range: DateRange
  level: ReportLevel
  granularity: string
  cursor: string | null
  limit: number
}

export interface FlowsState extends FakeState {
  tokens: Map<string, TokenSpec>
  reportCalls: ReportCall[]
  validations: { platform: Platform; token: string }[]
}

export function newFlowsState(): FlowsState {
  return { ...newFakeState(), tokens: new Map(), reportCalls: [], validations: [] }
}

const key = (platform: Platform, token: string) => `${platform}:${token}`

export function createFlowsProvider(platform: Platform, state: FlowsState): AdsProvider {
  const base = createFakeProvider(platform, state)
  const specOf = (token: string): TokenSpec | undefined => state.tokens.get(key(platform, token))
  return {
    ...base,
    credentialFields: [{ key: "token", label: "Token", type: "secret", required: true }],
    guide: { summary: `fake ${platform}`, steps: [] },
    parseCredentials(raw) {
      const t = (raw as { token?: unknown } | null)?.token
      if (typeof t !== "string" || t.trim().length < 3) {
        throw new ProviderError({
          platform,
          code: "invalid_credentials_input",
          message: "bad credentials input",
          userMessageVi: "Token không hợp lệ.",
        })
      }
      return { token: t.trim() }
    },
    credentialHint: (c) => `…${(c as { token: string }).token.slice(-4)}`,
    async validateCredentials(ctx) {
      const token = (ctx.credentials as { token: string }).token
      state.validations.push({ platform, token })
      const spec = specOf(token)
      if (!spec) {
        return { valid: false, tokenExpiresAt: null, scopes: null, warnings: ["Token không hợp lệ (fake)."], meta: {} }
      }
      if (spec.authError) {
        throw new ProviderError({ platform, code: "auth_invalid", message: "token revoked", userMessageVi: "Token đã bị thu hồi." })
      }
      if (spec.transientError) {
        throw new ProviderError({ platform, code: "upstream_error", message: "503", userMessageVi: "Nền tảng đang lỗi.", retryable: true })
      }
      return {
        valid: spec.valid ?? true,
        tokenExpiresAt: spec.expiresAt ?? null,
        scopes: spec.scopes ?? null,
        warnings: spec.warnings ?? (spec.valid === false ? ["Token không hợp lệ (fake)."] : []),
        meta: { fake: true },
      }
    },
    async listAccounts(ctx) {
      const token = (ctx.credentials as { token: string }).token
      return specOf(token)?.accounts ?? []
    },
    async getReport(ctx, q) {
      state.reportCalls.push({
        platform,
        account: ctx.account.externalId,
        timezone: ctx.account.timezone,
        range: q.dateRange,
        level: q.level,
        granularity: q.granularity,
        cursor: q.cursor ?? null,
        limit: q.limit,
      })
      return base.getReport(ctx, q)
    },
  }
}

export function accountInfo(
  externalId: string,
  o: Partial<AdAccountInfo> & { name?: string } = {}
): AdAccountInfo {
  return {
    externalId,
    name: o.name ?? `Tài khoản ${externalId}`,
    currency: o.currency ?? "VND",
    timezone: o.timezone ?? "Asia/Ho_Chi_Minh",
    status: o.status ?? "active",
    statusRaw: o.statusRaw ?? "ACTIVE",
    isManager: o.isManager,
    parentExternalId: o.parentExternalId,
    extra: o.extra,
  }
}
