// Public video relay GET|HEAD /dl/<token>/<name> (15-google-drive-media.md §8, GD5). The ad platform (Meta file_url /
// TikTok video_url) fetches the video from our domain; we stream it from Google Drive without buffering it.
// - Unknown / malformed / dead tokens are counted per client (GET + HEAD); a blocked client only reaches the DB with
//   the token of a live link (relay-guard.ts), else 429 (security review L3).
// - HEAD: peek (no fetch counted), answers from the stored row (no Google call).
// - GET: per-link / per-client / process-wide stream slots → a fetch is COUNTED only without Range or for a range
//   starting at byte 0 (other ranges: peek; API review #4) → byte budget (≤ 3 × size per link) → MCP grant re-checked
//   (account + "create", folder source still granted / public-link switch still on; L4) → credential still usable →
//   Drive metadata re-checked (same content_key, not trashed) → on a COUNTED fetch of a folder-source link: the file
//   still sits inside the granted folder, not behind another user's personal folder (T-1) → files.get?alt=media with
//   the client's Range →
//   200/206/416, each stream cut after RELAY_LIMITS.maxStreamMs.
// Any other failure → 404 text/plain (no redirect, no detail). The token / URL is never logged.
// Thin route: src/app/dl/[token]/[name]/route.ts. No imports from "next/*".
import { safeErrorForLog } from "../audit/safe-error"
import { clientIpFromHeaders } from "../mcp/net"
import type { McpGrant } from "../mcp/types"

import { driveUseStillGranted, loadGrantForMcpId } from "./access-recheck"
import { loadBlockedFolderIds } from "./blocked"
import { isDriveError } from "./errors"
import {
  driveContentKey,
  findAncestorIn,
  getDriveFile,
  openDriveDownload,
} from "./files"
import { isLiveRelayTokenHash } from "./relay-guard"
import {
  acquireRelayStream,
  recordRelayMiss,
  relayBudgetExhausted,
  relayMissBlocked,
  RELAY_LIMITS,
  reserveRelayBytes,
  type RelayStreamRelease,
} from "./relay-limits"
import {
  consumeRelayToken,
  decryptRelayResourceKey,
  hashRelayToken,
  isRelayTokenFormat,
  peekRelayToken,
} from "./relay-links"
import {
  driveAuthForCredential,
  isDriveCredentialUsable,
  loadDriveCredential,
  systemApiKeyAuth,
  type DriveRelayLinkRow,
} from "./store"
import type { DriveAuth, DriveDownload, DriveFile } from "./types"

/** Headers of every relay answer (doc 15 §8). next.config.ts sets the same CSP / Referrer-Policy for /dl/*. */
export const RELAY_BASE_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; sandbox",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "X-Robots-Tag": "noindex",
  "Referrer-Policy": "no-referrer",
}

export const RELAY_RETRY_AFTER_SECONDS = 5

const SAFE_CONTENT_TYPE = /^(video|image)\/[a-z0-9.+-]{1,60}$/i
const CONTENT_RANGE = /^bytes (\d{1,15})-(\d{1,15})\/(\d{1,15}|\*)$/
/** the single-range grammar files.ts forwards to Drive (anything else is answered in full) */
const SINGLE_RANGE = /^bytes=(\d{1,15})?-(\d{0,15})$/

function textResponse(
  status: number,
  body: string,
  extra: Record<string, string> = {}
): Response {
  return new Response(body, {
    status,
    headers: {
      ...RELAY_BASE_HEADERS,
      "Content-Type": "text/plain; charset=utf-8",
      ...extra,
    },
  })
}

const notFound = () => textResponse(404, "Not found")

const tooMany = (retryAfterSec: number = RELAY_RETRY_AFTER_SECONDS) =>
  textResponse(429, "Too many requests", {
    "Retry-After": String(retryAfterSec),
  })

/**
 * Does this GET count as one fetch of the link? Only a full download (no / unusable Range → full answer) or a range
 * starting at byte 0: a platform reading a video in pieces costs one fetch, not one per piece (the byte budget bounds
 * the pieces).
 */
export function relayRequestCountsAsFetch(range: string | null): boolean {
  const m = SINGLE_RANGE.exec(range?.trim() ?? "")
  if (!m || (m[1] === undefined && m[2] === "")) return true
  return m[1] !== undefined && Number(m[1]) === 0
}

function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s)
  } catch {
    return null
  }
}

/** The URL segment must be the stored (already sanitised) file name; accepts the raw or the decoded segment. */
function nameMatches(
  row: Pick<DriveRelayLinkRow, "fileName">,
  name: string
): boolean {
  return name === row.fileName || safeDecode(name) === row.fileName
}

/** Stored type re-checked: only image/* or video/* is ever served as such. */
function contentTypeOf(row: Pick<DriveRelayLinkRow, "contentType">): string {
  return SAFE_CONTENT_TYPE.test(row.contentType)
    ? row.contentType.toLowerCase()
    : "application/octet-stream"
}

/** How the link was created: the granted folder's service account (still usable) or the system API key. */
async function authForLink(row: DriveRelayLinkRow): Promise<DriveAuth | null> {
  if (row.access === "api_key") return systemApiKeyAuth()
  if (row.access !== "service_account" || !row.credentialId) return null
  const cred = await loadDriveCredential(row.credentialId)
  if (!cred || !isDriveCredentialUsable(cred)) return null
  return driveAuthForCredential(cred)
}

/**
 * L4: the MCP still grants the account, the folder source / the public-link switch the link was created with.
 * Returns the grant when it does, else null.
 */
async function stillGranted(row: DriveRelayLinkRow): Promise<McpGrant | null> {
  const grant = await loadGrantForMcpId(row.mcpId)
  if (!grant) return null
  const ok = driveUseStillGranted(grant, {
    adAccountId: row.adAccountId,
    access: row.access,
    credentialId: row.credentialId,
    // null for public links (api_key)
    sourceId: row.sourceId,
  })
  return ok ? grant : null
}

/**
 * T-1: a folder-source (service_account) link's file still sits inside the granted folder - not moved out, nor behind
 * another user's personal folder registered since (walk pruned there). Public (api_key) links: nothing to walk.
 */
async function stillInsideSource(
  grant: McpGrant,
  row: DriveRelayLinkRow,
  auth: DriveAuth,
  file: DriveFile,
  signal: AbortSignal
): Promise<boolean> {
  if (row.access !== "service_account") return true
  const source = grant.driveSources.find(
    (s) => s.id === row.sourceId && s.kind === "folder"
  )
  if (!source) return false
  const blocked = await loadBlockedFolderIds({
    id: grant.ownerId,
    role: grant.ownerRole,
  })
  const match = await findAncestorIn(auth, file, new Set([source.googleId]), {
    blocked,
    signal,
  })
  return match !== null
}

/** Content-Length of the answer: Drive's, else computed from Content-Range (206) or the file size (200). */
function contentLengthOf(
  dl: DriveDownload,
  fileSize: number | null
): number | null {
  if (dl.contentLength !== null) return dl.contentLength
  if (dl.status === 206) {
    const m = CONTENT_RANGE.exec(dl.contentRange ?? "")
    if (!m) return null
    const len = Number(m[2]) - Number(m[1]) + 1
    return len > 0 ? len : null
  }
  return fileSize
}

export interface RelayBodyOptions {
  /** the request's signal (client gone → upstream cancelled) */
  signal?: AbortSignal
  /** the stream is cut (errored) after this long (default RELAY_LIMITS.maxStreamMs) */
  maxMs?: number
  /** called once when the stream ends for any reason, with the bytes passed on to the client */
  onEnd?: (sentBytes: number) => void
}

/**
 * Pass the upstream body through chunk by chunk (pull-based: nothing is read ahead of the client). The stream slot
 * is released when the body ends, errors, is cancelled by the runtime (client gone), the request is aborted or the
 * time limit is reached; cancelling / cutting also aborts the Drive request.
 */
export function relayBody(
  src: ReadableStream<Uint8Array>,
  release: RelayStreamRelease,
  opts: RelayBodyOptions = {}
): ReadableStream<Uint8Array> {
  const { signal } = opts
  const reader = src.getReader()
  let done = false
  let sent = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const finish = () => {
    if (done) return
    done = true
    clearTimeout(timer)
    signal?.removeEventListener("abort", onAbort)
    try {
      opts.onEnd?.(sent)
    } finally {
      release()
    }
  }
  const onAbort = () => {
    finish()
    void reader.cancel().catch(() => {})
  }
  if (signal?.aborted) onAbort()
  else signal?.addEventListener("abort", onAbort, { once: true })
  return new ReadableStream<Uint8Array>(
    {
      start(ctrl) {
        if (done) return
        timer = setTimeout(() => {
          if (done) return
          finish()
          void reader.cancel().catch(() => {})
          try {
            ctrl.error(new Error("relay stream time limit"))
          } catch {
            // already closed
          }
        }, opts.maxMs ?? RELAY_LIMITS.maxStreamMs)
        timer.unref?.()
      },
      async pull(ctrl) {
        try {
          const r = await reader.read()
          // cut by the time limit / client gone while reading: the stream is already errored / cancelled
          if (done) return
          if (r.done) {
            finish()
            ctrl.close()
          } else {
            sent += r.value.byteLength
            ctrl.enqueue(r.value)
          }
        } catch (e) {
          if (done) return
          finish()
          ctrl.error(e)
        }
      },
      cancel(reason) {
        finish()
        return reader.cancel(reason).catch(() => {})
      },
    },
    { highWaterMark: 0 }
  )
}

function logFailure(e: unknown): void {
  // DriveError messages are fixed strings (no URL / token / key); anything else goes through the redactor
  if (isDriveError(e)) console.warn(`[dl] relay refused: drive ${e.code}`)
  else console.error(`[dl] relay error: ${safeErrorForLog(e)}`)
}

async function serveHead(
  token: string,
  name: string,
  ip: string | null
): Promise<Response> {
  const row = await peekRelayToken(token)
  if (!row || !nameMatches(row, name)) {
    recordRelayMiss(ip)
    return notFound()
  }
  return new Response(null, {
    status: 200,
    headers: {
      ...RELAY_BASE_HEADERS,
      "Content-Type": contentTypeOf(row),
      "Content-Length": String(row.sizeBytes),
      "Accept-Ranges": "bytes",
    },
  })
}

async function serveGet(
  req: Request,
  token: string,
  name: string,
  ip: string | null
): Promise<Response> {
  const tokenKey = hashRelayToken(token)
  const release = acquireRelayStream(tokenKey, ip)
  if (!release) return tooMany()
  let handedOver = false
  try {
    const range = req.headers.get("range")
    const counted = relayRequestCountsAsFetch(range)
    const row = counted
      ? await consumeRelayToken(token)
      : await peekRelayToken(token)
    if (!row || !nameMatches(row, name)) {
      recordRelayMiss(ip)
      return notFound()
    }
    if (relayBudgetExhausted(tokenKey, row.sizeBytes)) return notFound()
    const grant = await stillGranted(row)
    if (!grant) return notFound()
    const auth = await authForLink(row)
    if (!auth) return notFound()
    const resourceKey = decryptRelayResourceKey(row)
    const file = await getDriveFile(auth, row.driveFileId, {
      resourceKey,
      signal: req.signal,
    })
    if (
      file.trashed ||
      driveContentKey(file) !== row.contentKey ||
      (file.sizeBytes !== null && file.sizeBytes !== row.sizeBytes)
    ) {
      return notFound()
    }
    // the ancestor walk costs Drive calls: only on requests counted as a fetch (a ranged read follows one)
    if (
      counted &&
      !(await stillInsideSource(grant, row, auth, file, req.signal))
    )
      return notFound()
    let dl: DriveDownload
    try {
      dl = await openDriveDownload(auth, row.driveFileId, {
        range,
        resourceKey,
        signal: req.signal,
      })
    } catch (e) {
      if (isDriveError(e) && e.code === "range_not_satisfiable") {
        return textResponse(416, "Range not satisfiable", {
          "Content-Range": `bytes */${row.sizeBytes}`,
        })
      }
      throw e
    }
    const headers: Record<string, string> = {
      ...RELAY_BASE_HEADERS,
      "Content-Type": contentTypeOf(row),
      "Accept-Ranges": "bytes",
    }
    const length = contentLengthOf(dl, file.sizeBytes)
    if (length !== null) headers["Content-Length"] = String(length)
    if (dl.status === 206) {
      if (!dl.contentRange || !CONTENT_RANGE.test(dl.contentRange)) {
        await dl.body.cancel().catch(() => {})
        return notFound()
      }
      headers["Content-Range"] = dl.contentRange
    }
    // byte budget: reserve what this answer may send, give back what was not sent when it ends
    const refund = reserveRelayBytes(
      tokenKey,
      row.sizeBytes,
      length ?? row.sizeBytes
    )
    if (!refund) {
      await dl.body.cancel().catch(() => {})
      return notFound()
    }
    handedOver = true
    const body = relayBody(dl.body, release, {
      signal: req.signal,
      onEnd: refund,
    })
    return new Response(body, { status: dl.status, headers })
  } catch (e) {
    logFailure(e)
    return notFound()
  } finally {
    if (!handedOver) release()
  }
}

/** GET / HEAD of /dl/<token>/<name>. Never throws. */
export async function serveRelay(
  req: Request,
  token: string,
  name: string
): Promise<Response> {
  try {
    if (req.method !== "GET" && req.method !== "HEAD") return notFound()
    const ip = clientIpFromHeaders(req.headers)
    if (!isRelayTokenFormat(token) || typeof name !== "string" || !name) {
      recordRelayMiss(ip)
      return notFound()
    }
    // a blocked client (too many unknown tokens): only tokens of live links go on to the normal lookup
    const blocked = relayMissBlocked(ip)
    if (!blocked.ok && !(await isLiveRelayTokenHash(hashRelayToken(token))))
      return tooMany(blocked.retryAfterSec)
    if (req.method === "HEAD") return await serveHead(token, name, ip)
    return await serveGet(req, token, name, ip)
  } catch (e) {
    logFailure(e)
    return notFound()
  }
}
