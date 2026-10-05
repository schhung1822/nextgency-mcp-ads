// Release check against GitHub + the app_settings keys of the update system (.claude/docs/10-update-system.md §3).
// Shared by the worker job `update.check` and the web service (src/server/services/updates.ts), so it must stay
// framework-free: no `next/*`, no `server-only`.
//
// app_settings keys (internal: NOT in SETTING_SCHEMAS, so the Settings form / getAllSettings never touch them):
//   update_latest        { version, tag, publishedAt, notes (<= 4000 chars, plain text), url, checkedAt }
//   update_check_error   { at, message }   last failed check (message is ours, in Vietnamese, never contains the token)
//   updater_heartbeat    { at, version, composeProject }   written by the `updater` service every 30 s
import { eq, inArray } from "drizzle-orm"
import { z } from "zod"

import { updates as t } from "@/lib/i18n/vi/updates"
import type { LatestRelease, UpdateCheckFailure } from "@/lib/update-types"
import { pickLatestTag, versionFromTag } from "@/lib/version"
import { db, type Tx } from "@/server/db/client"
import { appSettings } from "@/server/db/schema"

export const UPDATE_LATEST_KEY = "update_latest"
export const UPDATE_CHECK_ERROR_KEY = "update_check_error"
export const UPDATER_HEARTBEAT_KEY = "updater_heartbeat"

export const DEFAULT_UPDATE_REPO = "notivn/ads-mcp-simple"
export const NOTES_MAX_CHARS = 4000
export const GITHUB_TIMEOUT_MS = 10_000

const REPO_RE = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/
/** GitHub answers are small JSON documents; anything bigger is not what we asked for */
const MAX_RESPONSE_CHARS = 1_000_000
/** Redirects are followed by hand (the Authorization header must never leave api.github.com) */
const GITHUB_API_ORIGIN = "https://api.github.com"
const MAX_REDIRECTS = 2

/** owner/name where neither part is only dots ("." / "..": they would collapse the URL path) */
export function isValidRepo(repo: string): boolean {
  return REPO_RE.test(repo) && repo.split("/").every((p) => !/^\.+$/.test(p))
}

export type UpdateCheckErrorCode =
  | "bad_repo"
  | "no_release"
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "unavailable"
  | "timeout"
  | "network"
  | "bad_response"

/** Expected failure of a release check; `message` is a safe Vietnamese sentence (never contains the token). */
export class UpdateCheckError extends Error {
  constructor(
    public readonly code: UpdateCheckErrorCode,
    message: string
  ) {
    super(message)
    this.name = "UpdateCheckError"
  }
}

export interface UpdateSource {
  repo: string
  /** optional fine-grained read-only token for a private repository */
  token: string | null
}

/** `UPDATE_REPO` (default notivn/ads-mcp-simple) + optional `UPDATE_GITHUB_TOKEN`. */
export function readUpdateSource(env: Record<string, string | undefined> = process.env): UpdateSource {
  const repo = env.UPDATE_REPO?.trim() || DEFAULT_UPDATE_REPO
  const token = env.UPDATE_GITHUB_TOKEN?.trim() || null
  return { repo, token }
}

export interface FetchLatestOptions {
  source?: UpdateSource
  /** injectable for tests */
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** e.g. the worker shutdown signal */
  signal?: AbortSignal
  now?: Date
}

const releaseSchema = z.object({
  tag_name: z.string().min(1).max(200),
  body: z.string().nullish(),
  html_url: z.string().nullish(),
  published_at: z.string().nullish(),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
})
const tagsSchema = z.array(z.object({ name: z.string().max(200) }))

/** Release notes -> plain text <= 4000 chars (control characters removed; the UI renders it escaped). */
export function sanitizeNotes(body: string | null | undefined): string {
  const s = (body ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "").trim()
  if (s.length <= NOTES_MAX_CHARS) return s
  let cut = s.slice(0, NOTES_MAX_CHARS - 1)
  const last = cut.charCodeAt(cut.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1) // do not split a surrogate pair
  return `${cut.trimEnd()}…`
}

function isoOrNull(v: string | null | undefined): string | null {
  if (!v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function formatReset(resetEpochSec: number, now: Date): string {
  const mins = Math.max(1, Math.ceil((resetEpochSec * 1000 - now.getTime()) / 60_000))
  return mins >= 60 ? `${Math.ceil(mins / 60)} giờ` : `${mins} phút`
}

/** Map a non-OK GitHub response (other than 404, handled by the caller) to a friendly error. */
async function errorForStatus(res: Response, now: Date): Promise<UpdateCheckError> {
  const status = res.status
  if (status === 401) return new UpdateCheckError("unauthorized", t.github.unauthorized)
  if (status === 403 || status === 429) {
    const remaining = res.headers.get("x-ratelimit-remaining")
    const retryAfter = res.headers.get("retry-after")
    let limited = status === 429 || remaining === "0" || retryAfter !== null
    if (!limited) {
      try {
        const body = (await res.clone().text()).slice(0, 2000).toLowerCase()
        limited = body.includes("rate limit")
      } catch {
        /* body unreadable: treat as plain forbidden */
      }
    }
    if (limited) {
      const reset = Number(res.headers.get("x-ratelimit-reset"))
      if (Number.isFinite(reset) && reset > 0) return new UpdateCheckError("rate_limited", t.github.rateLimitedAt(formatReset(reset, now)))
      return new UpdateCheckError("rate_limited", t.github.rateLimited)
    }
    return new UpdateCheckError("forbidden", t.github.forbidden)
  }
  return new UpdateCheckError("unavailable", t.github.unavailable)
}

/**
 * Newest release of the repository. Prefers GET /releases/latest (published, non-draft, non-pre-release); when
 * there is no release - or its tag is not a strict `vX.Y.Z` - falls back to the highest strict-semver tag.
 * Throws UpdateCheckError. The token goes only into the Authorization header and never into a message.
 */
export async function fetchLatestRelease(opts: FetchLatestOptions = {}): Promise<LatestRelease> {
  const source = opts.source ?? readUpdateSource()
  const doFetch = opts.fetchImpl ?? fetch
  const now = opts.now ?? new Date()
  if (!isValidRepo(source.repo)) throw new UpdateCheckError("bad_repo", t.github.badRepo)
  const base = `https://api.github.com/repos/${source.repo}`

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "ads-mcp-update-check",
  }
  if (source.token) headers.Authorization = `Bearer ${source.token}`

  const get = async (path: string): Promise<{ status: number; res: Response }> => {
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? GITHUB_TIMEOUT_MS)
    const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout
    let url = `${base}${path}`
    // a renamed/transferred repository answers 301 -> api.github.com/repositories/<id>/...: follow only that
    for (let hop = 0; ; hop++) {
      let res: Response
      try {
        res = await doFetch(url, { headers, signal, cache: "no-store", redirect: "manual" })
      } catch (e) {
        const name = (e as { name?: string } | null)?.name
        if (name === "TimeoutError" || (name === "AbortError" && timeout.aborted)) throw new UpdateCheckError("timeout", t.github.timeout)
        throw new UpdateCheckError("network", t.github.network)
      }
      if (res.status < 300 || res.status >= 400) return { status: res.status, res }
      await res.body?.cancel().catch(() => {})
      const location = res.headers.get("location")
      let next: URL | null = null
      try {
        next = location ? new URL(location, url) : null
      } catch {
        // malformed Location header
      }
      if (hop >= MAX_REDIRECTS || next?.origin !== GITHUB_API_ORIGIN) {
        throw new UpdateCheckError("unavailable", t.github.unavailable)
      }
      url = next.toString()
    }
  }
  const readJson = async (res: Response): Promise<unknown> => {
    try {
      const declared = Number(res.headers.get("content-length"))
      if (Number.isFinite(declared) && declared > MAX_RESPONSE_CHARS) throw new Error("too large")
      const text = await res.text()
      if (text.length > MAX_RESPONSE_CHARS) throw new Error("too large")
      return JSON.parse(text) as unknown
    } catch {
      throw new UpdateCheckError("bad_response", t.github.badResponse)
    }
  }

  // 1) /releases/latest
  const latest = await get("/releases/latest")
  if (latest.status === 200) {
    const parsed = releaseSchema.safeParse(await readJson(latest.res))
    if (!parsed.success) throw new UpdateCheckError("bad_response", t.github.badResponse)
    const r = parsed.data
    const version = r.draft || r.prerelease ? null : versionFromTag(r.tag_name)
    if (version) {
      const url = r.html_url && r.html_url.startsWith("https://github.com/") ? r.html_url : `https://github.com/${source.repo}/releases/tag/${r.tag_name}`
      return {
        version,
        tag: r.tag_name,
        publishedAt: isoOrNull(r.published_at),
        notes: sanitizeNotes(r.body),
        url,
        checkedAt: now.toISOString(),
      }
    }
    // a release exists but its tag is not vX.Y.Z -> look at the tags
  } else if (latest.status !== 404) {
    throw await errorForStatus(latest.res, now)
  }

  // 2) fallback: highest strict-semver tag
  const tags = await get("/tags?per_page=100")
  if (tags.status === 404) throw new UpdateCheckError("no_release", t.github.noRelease)
  if (tags.status !== 200) throw await errorForStatus(tags.res, now)
  const parsedTags = tagsSchema.safeParse(await readJson(tags.res))
  if (!parsedTags.success) throw new UpdateCheckError("bad_response", t.github.badResponse)
  const best = pickLatestTag(parsedTags.data.map((x) => x.name))
  if (!best) throw new UpdateCheckError("no_release", t.github.noRelease)
  return {
    version: best.version,
    tag: best.tag,
    publishedAt: null,
    notes: "",
    url: `https://github.com/${source.repo}/releases/tag/${best.tag}`,
    checkedAt: now.toISOString(),
  }
}

// ---------------------------------------------------------------------------
// app_settings storage
// ---------------------------------------------------------------------------

const latestStored = z.object({
  version: z.string(),
  tag: z.string(),
  publishedAt: z.string().nullable(),
  notes: z.string(),
  url: z.string(),
  checkedAt: z.string(),
})
const errorStored = z.object({ at: z.string(), message: z.string() })
const heartbeatStored = z.object({
  at: z.string(),
  version: z.string().nullish(),
  composeProject: z.string().nullish(),
})

export interface UpdateSettingsSnapshot {
  latest: LatestRelease | null
  checkError: UpdateCheckFailure | null
  heartbeat: { at: string; version: string | null } | null
}

/** One query for the three internal keys; malformed values are ignored (treated as absent). */
export async function readUpdateSettings(tx: Tx | typeof db = db): Promise<UpdateSettingsSnapshot> {
  const rows = await tx
    .select({ key: appSettings.key, value: appSettings.value })
    .from(appSettings)
    .where(inArray(appSettings.key, [UPDATE_LATEST_KEY, UPDATE_CHECK_ERROR_KEY, UPDATER_HEARTBEAT_KEY]))
  const by = new Map(rows.map((r) => [r.key, r.value]))
  const latest = latestStored.safeParse(by.get(UPDATE_LATEST_KEY))
  const err = errorStored.safeParse(by.get(UPDATE_CHECK_ERROR_KEY))
  const hb = heartbeatStored.safeParse(by.get(UPDATER_HEARTBEAT_KEY))
  return {
    latest: latest.success ? latest.data : null,
    checkError: err.success ? err.data : null,
    heartbeat: hb.success ? { at: hb.data.at, version: hb.data.version ?? null } : null,
  }
}

/** Only the stored latest release (cheap query for the layout). */
export async function readLatestRelease(tx: Tx | typeof db = db): Promise<LatestRelease | null> {
  const rows = await tx.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, UPDATE_LATEST_KEY)).limit(1)
  const p = latestStored.safeParse(rows[0]?.value)
  return p.success ? p.data : null
}

async function upsert(tx: Tx | typeof db, key: string, value: unknown, now: Date) {
  await tx
    .insert(appSettings)
    .values({ key, value, updatedBy: null, updatedAt: now })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedBy: null, updatedAt: now } })
}

/** Successful check: store the release and clear the last error. */
export async function persistCheckSuccess(tx: Tx | typeof db, release: LatestRelease, now = new Date()): Promise<void> {
  await upsert(tx, UPDATE_LATEST_KEY, release, now)
  await tx.delete(appSettings).where(eq(appSettings.key, UPDATE_CHECK_ERROR_KEY))
}

/** Failed check: remember why (the previous `update_latest` is kept). */
export async function persistCheckFailure(tx: Tx | typeof db, message: string, now = new Date()): Promise<void> {
  const value: UpdateCheckFailure = { at: now.toISOString(), message }
  await upsert(tx, UPDATE_CHECK_ERROR_KEY, value, now)
}

export type UpdateCheckResult = { ok: true; release: LatestRelease } | { ok: false; code: UpdateCheckErrorCode; message: string }

/** Fetch only (no DB): never throws. */
export async function checkLatestRelease(opts: FetchLatestOptions = {}): Promise<UpdateCheckResult> {
  try {
    return { ok: true, release: await fetchLatestRelease(opts) }
  } catch (e) {
    if (e instanceof UpdateCheckError) return { ok: false, code: e.code, message: e.message }
    return { ok: false, code: "network", message: t.github.network }
  }
}

/** Store a check result (call inside the caller's transaction when it also writes an activity log). */
export async function persistCheckResult(tx: Tx | typeof db, result: UpdateCheckResult, now = new Date()): Promise<void> {
  if (result.ok) await persistCheckSuccess(tx, result.release, now)
  else await persistCheckFailure(tx, result.message, now)
}

/** Fetch + store (used by the worker job). */
export async function runUpdateCheck(opts: FetchLatestOptions = {}): Promise<UpdateCheckResult> {
  const result = await checkLatestRelease(opts)
  await persistCheckResult(db, result, opts.now ?? new Date())
  return result
}
