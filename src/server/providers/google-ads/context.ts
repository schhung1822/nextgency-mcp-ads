import { ProviderError } from "../errors"
import type { ConnectionContext, ProviderContext } from "../types"
import { GoogleAdsClient, type ClientOptions } from "./client"
import type { GoogleAdsCredentials } from "./credentials"
import { normalizeCustomerId } from "./gaql"

export type GCtx = ProviderContext<GoogleAdsCredentials>

const clientOverrides: { opts: ClientOptions } = { opts: {} }

/** test hook: e.g. { retries: 0 } */
export function __setClientOptions(opts: ClientOptions) {
  clientOverrides.opts = opts
}

export function clientFor(ctx: ConnectionContext<GoogleAdsCredentials> | GCtx): GoogleAdsClient {
  return new GoogleAdsClient(
    {
      connectionId: ctx.connectionId,
      credentials: ctx.credentials,
      connectionMeta: ctx.connectionMeta,
      signal: ctx.signal,
      onUpstream: ctx.onUpstream,
    },
    clientOverrides.opts
  )
}

export function customerIdOf(ctx: GCtx): string {
  const cid = normalizeCustomerId(ctx.account.externalId)
  const allow = ctx.credentials.customer_ids
  if (allow?.length && !allow.includes(cid) && cid !== ctx.credentials.login_customer_id) {
    throw new ProviderError({
      platform: "google_ads",
      code: "permission_denied",
      message: `Customer ${cid} is not in the connection allow-list`,
      userMessageVi: "Tài khoản này không nằm trong danh sách customer ID được phép của kết nối.",
    })
  }
  return cid
}

export function invalidRequest(message: string, userMessageVi: string, hint?: string): ProviderError {
  return new ProviderError({ platform: "google_ads", code: "invalid_request", message, userMessageVi, hint })
}

export function notFound(what: string, id: string): ProviderError {
  return new ProviderError({
    platform: "google_ads",
    code: "not_found",
    message: `${what} ${id} not found`,
    userMessageVi: `Không tìm thấy ${what} ${id}.`,
    hint: "Gọi ads_list_objects để lấy đúng id.",
  })
}
