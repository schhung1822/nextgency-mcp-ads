// Google service-account access tokens (self-signed RS256 JWT → jwt-bearer grant, node:crypto only - no
// google-auth-library). Shared by Google Ads (scope adwords) and Google Drive / Sheets.
// No `sub` claim (no domain-wide delegation). Tokens are cached in memory until 5 minutes before expiry; the cache
// key holds the caller's key, the key identity AND the scopes, so one service account used for Google Ads and Drive
// never shares a token with the wrong scope. No imports from "next/*". The private key is never logged nor put in
// an error message.
import { createPrivateKey, createSign } from "node:crypto"
import { drive as dm } from "@/lib/i18n/vi/drive"
import { redactString } from "@/server/audit/redact"
import type { GoogleServiceAccount } from "../drive/types"

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"

const EARLY_REFRESH_MS = 5 * 60_000
const JWT_LIFETIME_S = 3600
const TOKEN_TIMEOUT_MS = 30_000
/** retries after the first attempt for 429 / 5xx answers */
const TOKEN_RETRIES = 2

export type GoogleAuthErrorCode =
  | "invalid_json"
  | "invalid_grant"
  | "invalid_scope"
  | "unauthorized_client"
  | "network"
  | "upstream"

/** Neutral error: callers map it to their own error type (ProviderError for Google Ads, DriveError for Drive). */
export class GoogleAuthError extends Error {
  readonly code: GoogleAuthErrorCode
  readonly httpStatus: number | null
  /** Google's error_description, already redacted (never contains the key) */
  readonly detail: string | null
  /** raw OAuth `error` field of the token endpoint answer (invalid_grant, invalid_client…), when there was one */
  readonly oauthError: string | null
  /** request id header of the token endpoint answer */
  readonly requestId: string | null
  /** network error: the attempt timed out (vs. connection failure) */
  readonly timedOut: boolean
  /** Vietnamese explanation (set for invalid_json) */
  readonly userMessageVi: string | null
  constructor(
    code: GoogleAuthErrorCode,
    o: {
      message?: string
      httpStatus?: number | null
      detail?: string | null
      oauthError?: string | null
      requestId?: string | null
      timedOut?: boolean
      userMessageVi?: string | null
      cause?: unknown
    } = {}
  ) {
    super(
      o.message ?? `google auth ${code}`,
      o.cause === undefined ? undefined : { cause: o.cause }
    )
    this.name = "GoogleAuthError"
    this.code = code
    this.httpStatus = o.httpStatus ?? null
    this.detail = o.detail ?? null
    this.oauthError = o.oauthError ?? null
    this.requestId = o.requestId ?? null
    this.timedOut = o.timedOut ?? false
    this.userMessageVi = o.userMessageVi ?? null
  }
}

export function isGoogleAuthError(e: unknown): e is GoogleAuthError {
  return e instanceof GoogleAuthError
}

// ---------------------------------------------------------------------------
// Service account JSON
// ---------------------------------------------------------------------------

const sa = dm.serviceAccount

function invalidJson(message: string, userMessageVi: string): GoogleAuthError {
  return new GoogleAuthError("invalid_json", { message, userMessageVi })
}

/** "\\n" written literally (env files, copy-paste) → real newlines */
function normalizePem(key: string): string {
  return key.replace(/\\n/g, "\n").trim() + "\n"
}

/**
 * Parse + validate a service account JSON key (type service_account, client_email, private_key PEM that node can
 * load). Anything else → GoogleAuthError("invalid_json") with a Vietnamese message; the input is never echoed.
 */
export function parseServiceAccountJson(raw: string): GoogleServiceAccount {
  let parsed: unknown
  try {
    parsed = JSON.parse(String(raw ?? "").trim())
  } catch {
    throw invalidJson("service account JSON: not JSON", sa.notJson)
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw invalidJson("service account JSON: not an object", sa.notJson)
  const o = parsed as Record<string, unknown>
  if (o.type !== "service_account")
    throw invalidJson(
      "service account JSON: type is not service_account",
      sa.notServiceAccount
    )
  const clientEmail =
    typeof o.client_email === "string" ? o.client_email.trim() : ""
  if (
    !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clientEmail) ||
    clientEmail.length > 320
  )
    throw invalidJson(
      "service account JSON: missing client_email",
      sa.missingEmail
    )
  const rawKey = typeof o.private_key === "string" ? o.private_key : ""
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(rawKey))
    throw invalidJson(
      "service account JSON: missing private_key",
      sa.missingKey
    )
  const privateKey = normalizePem(rawKey)
  try {
    const k = createPrivateKey(privateKey)
    if (k.asymmetricKeyType !== "rsa") throw new Error("not rsa")
  } catch {
    // the cause (node's parser error) is dropped on purpose: never risk echoing key material
    throw invalidJson("service account JSON: unreadable private_key", sa.badKey)
  }
  const str = (v: unknown) =>
    typeof v === "string" && v.trim() !== "" ? v.trim() : null
  return {
    clientEmail,
    privateKey,
    privateKeyId: str(o.private_key_id),
    projectId: str(o.project_id),
  }
}

// ---------------------------------------------------------------------------
// JWT
// ---------------------------------------------------------------------------

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url")
}

export interface GoogleJwtClaims {
  iss: string
  scope: string
  aud: string
  iat: number
  exp: number
}

/**
 * Self-signed assertion for the jwt-bearer grant. `aud` is always Google's token endpoint (never token_uri from the
 * JSON). An unusable private key → GoogleAuthError("invalid_json").
 */
export function signGoogleJwt(
  account: Pick<
    GoogleServiceAccount,
    "clientEmail" | "privateKey" | "privateKeyId"
  >,
  scopes: readonly string[],
  nowMs = Date.now()
): string {
  const iat = Math.floor(nowMs / 1000)
  const header: Record<string, string> = { alg: "RS256", typ: "JWT" }
  if (account.privateKeyId) header.kid = account.privateKeyId
  const claims: GoogleJwtClaims = {
    iss: account.clientEmail,
    scope: scopes.join(" "),
    aud: GOOGLE_TOKEN_URL,
    iat,
    exp: iat + JWT_LIFETIME_S,
  }
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`
  try {
    const signer = createSign("RSA-SHA256")
    signer.update(signingInput)
    signer.end()
    const signature = signer
      .sign(account.privateKey.replace(/\\n/g, "\n"))
      .toString("base64url")
    return `${signingInput}.${signature}`
  } catch {
    throw invalidJson(
      "Cannot sign service account JWT (invalid private_key)",
      sa.badKey
    )
  }
}

// ---------------------------------------------------------------------------
// Token cache
// ---------------------------------------------------------------------------

export interface GoogleAccessToken {
  accessToken: string
  /** epoch ms */
  expiresAt: number
}

/** One finished HTTP exchange with the token endpoint (Google Ads reports it as an upstream event). */
export interface GoogleTokenExchange {
  method: "POST"
  url: string
  status: number
  durationMs: number
  requestId: string | null
}

export interface GoogleTokenOptions {
  /** owner of the token (connection / drive credential id): part of the cache key */
  cacheKey: string
  signal?: AbortSignal
  /** ignore (and replace) the cached token */
  forceRefresh?: boolean
  /** tests */
  now?: () => number
  onExchange?: (e: GoogleTokenExchange) => void
}

const cache = new Map<string, GoogleAccessToken>()
const inflight = new Map<string, Promise<GoogleAccessToken>>()

/** `${cacheKey}|${clientEmail}|${privateKeyId ?? key length}|${sorted scopes}` - never contains key material. */
export function googleTokenCacheKey(
  account: Pick<
    GoogleServiceAccount,
    "clientEmail" | "privateKey" | "privateKeyId"
  >,
  scopes: readonly string[],
  cacheKey: string
): string {
  const scopeKey = [...new Set(scopes)].sort().join(" ")
  return `${cacheKey}|${account.clientEmail}|${account.privateKeyId ?? account.privateKey.length}|${scopeKey}`
}

/** Access token + expiry (cached until 5 minutes before expiry, concurrent mints de-duplicated). */
export async function getGoogleAccessTokenInfo(
  account: GoogleServiceAccount,
  scopes: readonly string[],
  opts: GoogleTokenOptions
): Promise<GoogleAccessToken> {
  const now = opts.now ?? Date.now
  const key = googleTokenCacheKey(account, scopes, opts.cacheKey)
  if (opts.forceRefresh) cache.delete(key)
  else {
    const hit = cache.get(key)
    if (hit && hit.expiresAt - EARLY_REFRESH_MS > now()) return hit
  }
  const pending = inflight.get(key)
  if (pending) return pending
  const p = mintToken(account, scopes, opts, now)
    .then((t) => {
      cache.set(key, t)
      return t
    })
    .finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

/**
 * Access token for `scopes`, cached in memory until 5 minutes before expiry. The cache key MUST include the
 * scopes and the key identity (client_email + private_key_id), so the same service account used for Google Ads
 * and Drive never shares a token with the wrong scope.
 */
export async function getGoogleAccessToken(
  account: GoogleServiceAccount,
  scopes: readonly string[],
  opts: { cacheKey: string; signal?: AbortSignal; forceRefresh?: boolean }
): Promise<string> {
  return (await getGoogleAccessTokenInfo(account, scopes, opts)).accessToken
}

/** Drop every cached token whose cache key is `cacheKey` (credential replaced / revoked). */
export function invalidateGoogleAccessTokens(cacheKey: string): void {
  const prefix = `${cacheKey}|`
  for (const k of [...cache.keys()]) if (k.startsWith(prefix)) cache.delete(k)
}

/** test helper */
export function __clearGoogleTokenCache(): void {
  cache.clear()
  inflight.clear()
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

interface TokenResponse {
  access_token?: unknown
  expires_in?: unknown
  error?: unknown
  error_description?: unknown
}

let retryBaseMs = 1_000
/** tests: shorter backoff */
export function __setGoogleTokenRetryBaseMs(ms: number): void {
  if (process.env.NODE_ENV !== "test" && !process.env.VITEST)
    throw new Error("__setGoogleTokenRetryBaseMs is test-only")
  retryBaseMs = ms
}

const aborted = () =>
  new GoogleAuthError("network", { message: "Google token request aborted" })

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(aborted())
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(aborted())
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function oauthCode(error: string | null): GoogleAuthErrorCode {
  if (error === "invalid_grant") return "invalid_grant"
  if (error === "invalid_scope") return "invalid_scope"
  if (error === "invalid_client" || error === "unauthorized_client")
    return "unauthorized_client"
  return "upstream"
}

async function mintToken(
  account: GoogleServiceAccount,
  scopes: readonly string[],
  opts: GoogleTokenOptions,
  now: () => number
): Promise<GoogleAccessToken> {
  for (let attempt = 0; ; attempt++) {
    const body = new URLSearchParams()
    body.set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer")
    body.set("assertion", signGoogleJwt(account, scopes, now()))
    const timeout = AbortSignal.timeout(TOKEN_TIMEOUT_MS)
    const signal = opts.signal
      ? AbortSignal.any([opts.signal, timeout])
      : timeout
    const started = Date.now()
    let res: Response
    try {
      res = await fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body,
        signal,
        redirect: "manual",
      })
    } catch (e) {
      opts.onExchange?.({
        method: "POST",
        url: GOOGLE_TOKEN_URL,
        status: 0,
        durationMs: Date.now() - started,
        requestId: null,
      })
      // no retry after a network error / timeout (a slow token endpoint must not eat the caller budget)
      const timedOut = timeout.aborted && !opts.signal?.aborted
      throw new GoogleAuthError("network", {
        message: `Google token request failed: ${redactString((e as Error)?.message ?? "error")}`,
        timedOut,
      })
    }
    const requestId =
      res.headers.get("x-request-id") ?? res.headers.get("request-id") ?? null
    let text = ""
    try {
      text = await res.text()
    } catch {
      text = ""
    }
    opts.onExchange?.({
      method: "POST",
      url: GOOGLE_TOKEN_URL,
      status: res.status,
      durationMs: Date.now() - started,
      requestId,
    })
    let b: TokenResponse = {}
    try {
      const j: unknown = text ? JSON.parse(text) : {}
      if (j && typeof j === "object") b = j as TokenResponse
    } catch {
      b = {}
    }
    if (
      res.status === 200 &&
      typeof b.access_token === "string" &&
      b.access_token
    ) {
      const ttl =
        typeof b.expires_in === "number" && b.expires_in > 0
          ? b.expires_in
          : 3600
      return { accessToken: b.access_token, expiresAt: now() + ttl * 1000 }
    }
    const transient = res.status === 429 || res.status >= 500
    if (transient && attempt < TOKEN_RETRIES) {
      await sleep(retryBaseMs * 2 ** attempt, opts.signal)
      continue
    }
    const oauthError =
      typeof b.error === "string" ? b.error.slice(0, 100) : null
    const detail =
      typeof b.error_description === "string"
        ? redactString(b.error_description).slice(0, 300)
        : null
    throw new GoogleAuthError(oauthCode(oauthError), {
      message:
        `Google token endpoint error ${res.status}: ${oauthError ?? "-"} ${detail ?? ""}`.trim(),
      httpStatus: res.status,
      oauthError,
      detail,
      requestId,
    })
  }
}
