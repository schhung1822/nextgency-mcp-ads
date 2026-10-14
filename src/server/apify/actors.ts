// Apify API calls used by the token services, the pool and the MCP tools (16-apify.md §4, providers/apify.md §4-§8).
// No imports from "next/*". Every answer is normalised into small typed objects: never email / proxy password from
// /users/me, never itemsPublicUrl / urlSigningSecretKey of datasets. Text written by Actors or their authors
// (statusMessage, titles, descriptions, README) is untrusted: control / bidi characters removed, capped.
// Starting a run is never blindly retried: after an ambiguous failure the recent runs of the token are checked first.
import { isDeepStrictEqual } from "node:util"

import {
  APIFY_MAX_DATASET_BYTES,
  APIFY_TIMEOUTS,
  apifyPath,
  apifyRequest,
  clampToDeadline,
  type ApifyCallOptions,
} from "./client"
import { MULTILINE_FORBIDDEN_CHARS } from "@/lib/text-safety"
import { containsSecretValue, redactString } from "@/server/audit/redact"

import { ApifyError, cleanUpstreamText, isApifyError } from "./errors"
import type { ApifyAccountInfo } from "./types"

/** Server-side ceilings for every run (16-apify.md §7): timeout ≤ 600 s, memory ≤ 4096 MB, wait ≤ 25 s. */
export const APIFY_RUN_LIMITS = {
  maxTimeoutSecs: 600,
  minMemoryMbytes: 128,
  maxMemoryMbytes: 4096,
  maxWaitForFinishSecs: 25,
  /** apify_get_run long-poll */
  maxGetRunWaitSecs: 30,
  /** dataset page size */
  maxDatasetLimit: 100,
  /** Store search with input schemas: Apify refuses limit > 10 */
  maxStoreLimit: 10,
} as const

/** A token, the caller signal and test hooks. `token` null only for public endpoints (Store, public Actor, build). */
export interface ApifyCallContext extends ApifyCallOptions {
  token: string | null
}
// note: leave ctx.timeoutMs unset for runs / long-polls - the default timeout includes waitForFinish

function requireToken(ctx: ApifyCallContext): string {
  if (!ctx.token) throw new ApifyError("token_missing")
  return ctx.token
}

/** an explicit ctx.timeoutMs (short checks, tests) wins over the call's own default (long-polls add their wait) */
function opts(ctx: ApifyCallContext, defaultTimeoutMs?: number): ApifyCallOptions {
  return {
    signal: ctx.signal,
    // clamped to ctx.deadline (when set) by the client
    deadline: ctx.deadline,
    timeoutMs: ctx.timeoutMs ?? defaultTimeoutMs,
    fetchImpl: ctx.fetchImpl,
    baseUrl: ctx.baseUrl,
  }
}

// ---- small readers for untrusted JSON ------------------------------------------------------------------------

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {}
const str = (v: unknown): string | null =>
  typeof v === "string" && v ? v : null
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null)
const iso = (v: unknown): string | null => {
  if (typeof v !== "string" || !v) return null
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}
const text = (v: unknown, max: number) => cleanUpstreamText(v, max)
/** Apify ids (user, Actor, run, dataset, build): alphanumeric, else null */
const idOf = (v: unknown): string | null =>
  typeof v === "string" && /^[A-Za-z0-9]{1,64}$/.test(v) ? v : null
/** usernames / Actor names: they become path segments ("username~name") */
const SLUG_RE = /^[A-Za-z0-9._-]{1,100}$/
/** an object key / field name from upstream, shown to the AI: cleaned like any label (null = dropped) */
const keyOf = (k: string, max = 80) => text(k, max)
/** list of untrusted strings → cleaned, non-empty, capped */
function strList(v: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return []
  return v
    .map((x) => text(x, maxLen))
    .filter((x): x is string => x !== null)
    .slice(0, maxItems)
}
/** untrusted JSON (schema defaults / enums): every string and key cleaned, ≤ 4 levels, ≤ 50 entries per level */
function safeJson(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return text(v, 300) ?? ""
  if (v === null || typeof v === "boolean") return v
  if (typeof v === "number") return Number.isFinite(v) ? v : null
  if (depth >= 4 || typeof v !== "object") return null
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => safeJson(x, depth + 1))
  const out: Obj = {}
  for (const [k, x] of Object.entries(v as Obj).slice(0, 50)) {
    const kk = keyOf(k)
    if (kk) out[kk] = safeJson(x, depth + 1)
  }
  return out
}
const UNSAFE_MULTILINE = new RegExp(MULTILINE_FORBIDDEN_CHARS.source, "gu")
/** untrusted multi-line text (README): newlines kept, control / bidi characters removed, secrets redacted, capped */
function multiline(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null
  const s = redactString(v.slice(0, max * 2))
    .replace(UNSAFE_MULTILINE, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  if (!s) return null
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

// ---------------------------------------------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------------------------------------------

/** GET /v2/users/me - only the non-secret, non-personal fields (no email, no proxy password). */
export interface ApifyUserInfo {
  apifyUserId: string
  username: string | null
  planId: string | null
  planTier: string | null
  /** plan.monthlyUsageCreditsUsd (prepaid usage) */
  monthlyUsageCreditsUsd: number | null
  /** plan.maxConcurrentActorRuns */
  maxConcurrentRuns: number | null
  isPaying: boolean | null
  /** effectivePlatformFeatures.ACTORS.isEnabled (false: the account cannot run Actors now) */
  actorsEnabled: boolean
  /** effectivePlatformFeatures.ACTORS.disabledReason (cleaned) */
  actorsDisabledReason: string | null
}

export async function getUserInfo(
  ctx: ApifyCallContext
): Promise<ApifyUserInfo> {
  const { data } = await apifyRequest<unknown>(
    requireToken(ctx),
    { method: "GET", path: apifyPath("users", "me") },
    opts(ctx)
  )
  const d = obj(data)
  const id = idOf(d.id)
  if (!id) throw new ApifyError("invalid_response")
  const plan = obj(d.plan)
  const actors = obj(obj(d.effectivePlatformFeatures).ACTORS)
  return {
    apifyUserId: id,
    username: text(d.username, 100),
    planId: text(plan.id, 50),
    planTier: text(plan.tier, 30),
    monthlyUsageCreditsUsd: num(plan.monthlyUsageCreditsUsd),
    maxConcurrentRuns: num(plan.maxConcurrentActorRuns),
    isPaying: bool(d.isPaying),
    // missing block = assume enabled (the run itself will tell otherwise)
    actorsEnabled: bool(actors.isEnabled) ?? true,
    actorsDisabledReason: text(actors.disabledReason, 300),
  }
}

/** GET /v2/users/me/limits - credit of the current usage cycle. */
export interface ApifyLimits {
  /** current.monthlyUsageUsd */
  usageUsd: number | null
  /** limits.maxMonthlyUsageUsd (hard limit) */
  limitUsd: number | null
  cycleStartAt: string | null
  /** monthlyUsageCycle.endAt: the credit resets then */
  cycleEndAt: string | null
  maxConcurrentJobs: number | null
  activeJobs: number | null
  maxMemoryGbytes: number | null
  usedMemoryGbytes: number | null
}

export async function getLimits(ctx: ApifyCallContext): Promise<ApifyLimits> {
  const { data } = await apifyRequest<unknown>(
    requireToken(ctx),
    { method: "GET", path: apifyPath("users", "me", "limits") },
    opts(ctx)
  )
  const d = obj(data)
  const cycle = obj(d.monthlyUsageCycle)
  const limits = obj(d.limits)
  const current = obj(d.current)
  return {
    usageUsd: num(current.monthlyUsageUsd),
    limitUsd: num(limits.maxMonthlyUsageUsd),
    cycleStartAt: iso(cycle.startAt),
    cycleEndAt: iso(cycle.endAt),
    maxConcurrentJobs: num(limits.maxConcurrentActorJobs),
    activeJobs: num(current.activeActorJobCount),
    maxMemoryGbytes: num(limits.maxActorMemoryGbytes),
    usedMemoryGbytes: num(current.actorMemoryGbytes),
  }
}

/** remaining credit before Apify's hard limit (null when unknown) */
export function remainingCreditUsd(l: {
  usageUsd: number | null
  limitUsd: number | null
}): number | null {
  if (l.usageUsd === null || l.limitUsd === null) return null
  return Math.max(0, Math.round((l.limitUsd - l.usageUsd) * 10_000) / 10_000)
}

/**
 * Below this remaining credit an account counts as out of credit (a run needs at least min(run cap, $0.05),
 * 16-apify.md §5). Exported for the pool and the health check.
 */
export const APIFY_MIN_CREDIT_USD = 0.05

/** users/me + users/me/limits (both free) → the account info stored on apify_tokens. */
export async function getAccountInfo(
  ctx: ApifyCallContext
): Promise<ApifyAccountInfo> {
  const [user, limits] = await Promise.all([getUserInfo(ctx), getLimits(ctx)])
  return {
    apifyUserId: user.apifyUserId,
    username: user.username,
    planId: user.planId,
    planTier: user.planTier,
    usageUsd: limits.usageUsd,
    limitUsd: limits.limitUsd,
    cycleEndAt: limits.cycleEndAt,
    actorsEnabled: user.actorsEnabled,
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Store / Actor / build
// ---------------------------------------------------------------------------------------------------------------

export interface ApifyPricingEvent {
  name: string
  title: string | null
  /** flat price, or the FREE-tier price of tiered pricing */
  priceUsd: number | null
  /** tier → price (FREE…DIAMOND) when tiered */
  tieredPriceUsd: Record<string, number> | null
  isPrimary: boolean
  isOneTime: boolean
}

export interface ApifyPricing {
  /** PAY_PER_EVENT | FREE (= pay per usage) | FLAT_PRICE_PER_MONTH (rental) | PRICE_PER_DATASET_ITEM | … */
  pricingModel: string | null
  pricePerUnitUsd: number | null
  unitName: string | null
  /** a run's maxTotalChargeUsd must be ≥ this */
  minimalMaxTotalChargeUsd: number | null
  /** PPE: platform usage (CU / proxy) is charged on top */
  platformUsagePaidByUser: boolean | null
  events: ApifyPricingEvent[]
}

function pricingOf(raw: unknown): ApifyPricing | null {
  const p = obj(raw)
  if (Object.keys(p).length === 0) return null
  const events: ApifyPricingEvent[] = []
  const charge = obj(obj(p.pricingPerEvent).actorChargeEvents)
  for (const [name, v] of Object.entries(charge).slice(0, 30)) {
    const e = obj(v)
    const tiers = obj(e.eventTieredPricingUsd)
    const tiered: Record<string, number> = {}
    for (const [tier, tv] of Object.entries(tiers)) {
      const price = num(obj(tv).tieredEventPriceUsd)
      if (price !== null && /^[A-Z]{2,12}$/.test(tier)) tiered[tier] = price
    }
    events.push({
      name: keyOf(name) ?? "event",
      title: text(e.eventTitle, 120),
      priceUsd: num(e.eventPriceUsd) ?? tiered.FREE ?? null,
      tieredPriceUsd: Object.keys(tiered).length ? tiered : null,
      isPrimary: e.isPrimaryEvent === true,
      isOneTime: e.isOneTimeEvent === true,
    })
  }
  return {
    pricingModel: text(p.pricingModel, 40),
    pricePerUnitUsd: num(p.pricePerUnitUsd),
    unitName: text(p.unitName, 40),
    minimalMaxTotalChargeUsd: num(p.minimalMaxTotalChargeUsd),
    platformUsagePaidByUser: bool(p.isPPEPlatformUsagePaidByUser),
    events,
  }
}

/** the pricing record in force: latest `startedAt` ≤ now (pricingInfos is a history) */
function currentPricing(list: unknown, now = Date.now()): ApifyPricing | null {
  if (!Array.isArray(list)) return null
  let best: { at: number; raw: unknown } | null = null
  for (const item of list) {
    const at = Date.parse(String(obj(item).startedAt ?? ""))
    const t = Number.isNaN(at) ? 0 : at
    if (t > now) continue
    if (!best || t >= best.at) best = { at: t, raw: item }
  }
  return best ? pricingOf(best.raw) : null
}

function successRate(stats: Obj): number | null {
  const r = obj(stats.publicActorRunStats30Days)
  const total = num(r.TOTAL)
  const ok = num(r.SUCCEEDED)
  if (!total || ok === null) return null
  return Math.round((ok / total) * 1000) / 1000
}

export interface ApifyStoreActor {
  /** "username~name" */
  actorId: string
  title: string | null
  description: string | null
  username: string
  name: string
  categories: string[]
  /** NONE | RESIDENTIAL_PROXY_REQUIRED | UNDER_MAINTENANCE */
  notice: string | null
  pricing: ApifyPricing | null
  totalUsers30Days: number | null
  /** SUCCEEDED / TOTAL of public runs over 30 days (0-1) */
  successRate30Days: number | null
  rating: number | null
  lastRunStartedAt: string | null
  /** only with includeInputSchema: field → type, required list */
  inputFields: { name: string; type: string | null; required: boolean }[] | null
}

function storeActorOf(raw: unknown): ApifyStoreActor | null {
  const a = obj(raw)
  const username = str(a.username)
  const name = str(a.name)
  if (!username || !name || !SLUG_RE.test(username) || !SLUG_RE.test(name))
    return null
  const stats = obj(a.stats)
  let inputFields: ApifyStoreActor["inputFields"] = null
  const schema = obj(a.inputSchema)
  if (Object.keys(schema).length) {
    const required = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((x) => typeof x === "string")
        : []
    )
    inputFields = Object.entries(obj(schema.properties))
      .slice(0, 60)
      .flatMap(([k, v]) => {
        const name = keyOf(k)
        return name
          ? [{ name, type: text(obj(v).type, 20), required: required.has(k) }]
          : []
      })
  }
  return {
    actorId: `${username}~${name}`,
    title: text(a.title, 150),
    description: text(a.description, 500),
    username,
    name,
    categories: strList(a.categories, 10, 60),
    notice: text(a.notice, 40),
    pricing: pricingOf(a.currentPricingInfo),
    totalUsers30Days: num(stats.totalUsers30Days),
    successRate30Days: successRate(stats),
    rating: num(a.actorReviewRating) ?? num(stats.actorReviewRating),
    lastRunStartedAt: iso(stats.lastRunStartedAt),
    inputFields,
  }
}

/**
 * GET /v2/store - public Actors. Apify already hides Actors "not safe to run automatically" (includeUnrunnableActors
 * stays false). limit ≤ 10 (also Apify's maximum with input schemas). includeInputSchema is undocumented: when Apify
 * refuses it (400) the search is repeated without it.
 */
export async function searchStore(
  ctx: ApifyCallContext,
  params: {
    search: string
    limit?: number
    offset?: number
    category?: string
    sortBy?: "relevance" | "popularity" | "newest" | "lastUpdate"
    includeInputSchema?: boolean
  }
): Promise<{ total: number | null; items: ApifyStoreActor[] }> {
  const limit = Math.min(
    Math.max(Math.trunc(params.limit ?? 5), 1),
    APIFY_RUN_LIMITS.maxStoreLimit
  )
  const run = async (withSchema: boolean) =>
    apifyRequest<unknown>(
      ctx.token,
      {
        method: "GET",
        path: apifyPath("store"),
        query: {
          search: params.search.slice(0, 200),
          limit,
          offset: params.offset
            ? Math.max(0, Math.trunc(params.offset))
            : undefined,
          category: params.category,
          sortBy: params.sortBy,
          includeInputSchema: withSchema ? true : undefined,
        },
      },
      opts(ctx)
    )
  let res
  try {
    res = await run(params.includeInputSchema !== false)
  } catch (e) {
    if (!(
      isApifyError(e) &&
      e.httpStatus === 400 &&
      params.includeInputSchema !== false
    ))
      throw e
    res = await run(false)
  }
  const d = obj(res.data)
  const items = (Array.isArray(d.items) ? d.items : [])
    .map(storeActorOf)
    .filter((x): x is ApifyStoreActor => x !== null)
    .slice(0, limit)
  return { total: num(d.total), items }
}

export interface ApifyActorInfo {
  /** Apify's own id (e.g. "vKg4IjxZbEYTYeW8T") */
  id: string
  /** "username~name" */
  actorId: string
  username: string
  name: string
  title: string | null
  description: string | null
  isPublic: boolean | null
  isDeprecated: boolean
  /** LIMITED_PERMISSIONS | FULL_PERMISSIONS */
  permissionLevel: string | null
  notice: string | null
  categories: string[]
  pricing: ApifyPricing | null
  defaultRunOptions: {
    timeoutSecs: number | null
    memoryMbytes: number | null
    maxTotalChargeUsd: number | null
  }
  /** AI-generated README summary (public Actors), cleaned + capped */
  readmeSummary: string | null
  totalUsers30Days: number | null
  successRate30Days: number | null
  /** Standby Actors (HTTP server) cannot be run as a batch job by these tools */
  usesStandby: boolean
}

/** GET /v2/actors/{actorId} (public Actors: token optional). */
export async function getActor(
  ctx: ApifyCallContext,
  actorId: string
): Promise<ApifyActorInfo> {
  const { data } = await apifyRequest<unknown>(
    ctx.token,
    { method: "GET", path: apifyPath("actors", actorId) },
    opts(ctx)
  )
  const a = obj(data)
  const id = idOf(a.id)
  const username = str(a.username)
  const name = str(a.name)
  if (!id || !username || !name || !SLUG_RE.test(username) || !SLUG_RE.test(name))
    throw new ApifyError("invalid_response")
  const stats = obj(a.stats)
  const dro = obj(a.defaultRunOptions)
  return {
    id,
    actorId: `${username}~${name}`,
    username,
    name,
    title: text(a.title, 150),
    description: text(a.description, 500),
    isPublic: bool(a.isPublic),
    isDeprecated: a.isDeprecated === true,
    permissionLevel: text(a.actorPermissionLevel, 40),
    notice: text(a.notice, 40),
    categories: strList(a.categories, 10, 60),
    pricing: currentPricing(a.pricingInfos),
    defaultRunOptions: {
      timeoutSecs: num(dro.timeoutSecs),
      memoryMbytes: num(dro.memoryMbytes),
      maxTotalChargeUsd: num(dro.maxTotalChargeUsd),
    },
    readmeSummary: text(a.readmeSummary, 2000),
    totalUsers30Days: num(stats.totalUsers30Days),
    successRate30Days: successRate(stats),
    usesStandby: !!a.actorStandby && obj(a.actorStandby).isEnabled === true,
  }
}

export interface ApifyInputProperty {
  name: string
  type: string | null
  title: string | null
  description: string | null
  required: boolean
  default: unknown
  enum: unknown[] | null
  editor: string | null
}

export interface ApifyBuildInfo {
  buildId: string | null
  /** properties of the Actor input schema (descriptions ≤ 500 chars, enums ≤ 50 values) */
  inputProperties: ApifyInputProperty[]
  /** README (Markdown), cleaned, ≤ 5,000 chars */
  readme: string | null
  /** fields listed by the dataset views (result fields worth asking for) */
  datasetFields: string[]
  minMemoryMbytes: number | null
  maxMemoryMbytes: number | null
  defaultMemoryMbytes: number | null
}

const README_MAX = 5_000

/** GET /v2/actors/{actorId}/builds/default - input schema + README of the default build (token optional). */
export async function getActorDefaultBuild(
  ctx: ApifyCallContext,
  actorId: string
): Promise<ApifyBuildInfo> {
  const { data } = await apifyRequest<unknown>(
    ctx.token,
    { method: "GET", path: apifyPath("actors", actorId, "builds", "default") },
    opts(ctx, APIFY_TIMEOUTS.dataMs)
  )
  const b = obj(data)
  const def = obj(b.actorDefinition)
  let schema = obj(def.input)
  if (!Object.keys(schema).length && typeof b.inputSchema === "string") {
    try {
      schema = obj(JSON.parse(b.inputSchema))
    } catch {
      schema = {}
    }
  }
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((x) => typeof x === "string")
      : []
  )
  const inputProperties = Object.entries(obj(schema.properties))
    .slice(0, 80)
    .flatMap(([k, v]) => {
      const p = obj(v)
      const name = keyOf(k)
      if (!name) return []
      const en = Array.isArray(p.enum) ? safeJson(p.enum.slice(0, 50)) : null
      const dflt = safeJson(p.default ?? null)
      return [{
        name,
        type: text(p.type, 20),
        title: text(p.title, 150),
        description: text(p.description, 500),
        required: required.has(k),
        default: JSON.stringify(dflt).length <= 500 ? dflt : null,
        enum:
          Array.isArray(en) && JSON.stringify(en).length <= 2000 ? en : null,
        editor: text(p.editor, 30),
      }]
    })
  const fields = new Set<string>()
  const views = obj(obj(obj(def.storages).dataset).views)
  for (const v of Object.values(views)) {
    const t = obj(obj(v).transformation)
    for (const f of Array.isArray(t.fields) ? t.fields : []) {
      const field = typeof f === "string" && f.length <= 100 ? keyOf(f, 100) : null
      if (field) fields.add(field)
      if (fields.size >= 60) break
    }
  }
  return {
    buildId: idOf(b.id),
    inputProperties,
    readme: multiline(b.readme, README_MAX),
    datasetFields: [...fields],
    minMemoryMbytes: num(def.minMemoryMbytes),
    maxMemoryMbytes: num(def.maxMemoryMbytes),
    defaultMemoryMbytes: num(def.defaultMemoryMbytes),
  }
}

/**
 * POST /v2/actors/{actorId}/validate-input (free, nothing runs). Resolves when valid; ApifyError "input_invalid"
 * (with Apify's explanation in `upstreamMessage`) otherwise.
 */
export async function validateActorInput(
  ctx: ApifyCallContext,
  actorId: string,
  input: Record<string, unknown>,
  o: { build?: string } = {}
): Promise<void> {
  const { data } = await apifyRequest<unknown>(
    requireToken(ctx),
    {
      method: "POST",
      path: apifyPath("actors", actorId, "validate-input"),
      query: { build: o.build },
      body: input,
      // validation has no side effect
      retry: true,
    },
    opts(ctx)
  )
  if (obj(data).valid === false)
    throw new ApifyError("input_invalid", { httpStatus: 200 })
}

// ---------------------------------------------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------------------------------------------

export const APIFY_TERMINAL_STATUSES = [
  "SUCCEEDED",
  "FAILED",
  "TIMED-OUT",
  "ABORTED",
] as const

export function isTerminalRunStatus(status: string): boolean {
  return (APIFY_TERMINAL_STATUSES as readonly string[]).includes(status)
}

export interface ApifyRun {
  id: string
  /** Apify Actor id (not "username~name") */
  actId: string | null
  /** READY / RUNNING / TIMING-OUT / ABORTING / SUCCEEDED / FAILED / TIMED-OUT / ABORTED */
  status: string
  isTerminal: boolean
  /** written by the Actor: untrusted, cleaned, ≤ 500 chars */
  statusMessage: string | null
  startedAt: string | null
  finishedAt: string | null
  defaultDatasetId: string | null
  defaultKeyValueStoreId: string | null
  /** real cost so far (may still be preliminary right after the end) */
  usageTotalUsd: number | null
  /** PPE events charged, e.g. { "result": 120 } (≤ 20 entries) */
  chargedEventCounts: Record<string, number> | null
  options: {
    timeoutSecs: number | null
    memoryMbytes: number | null
    maxTotalChargeUsd: number | null
  }
  durationMillis: number | null
  exitCode: number | null
}

const RUN_STATUS_RE = /^[A-Z-]{2,20}$/
const ID_RE = /^[A-Za-z0-9]{1,64}$/

export function runOf(raw: unknown): ApifyRun {
  const r = obj(raw)
  const id = str(r.id)
  const status = str(r.status)
  if (!id || !ID_RE.test(id) || !status || !RUN_STATUS_RE.test(status))
    throw new ApifyError("invalid_response")
  const o = obj(r.options)
  const stats = obj(r.stats)
  let charged: Record<string, number> | null = null
  const ce = obj(r.chargedEventCounts)
  for (const [k, v] of Object.entries(ce).slice(0, 20)) {
    const n = num(v)
    const name = keyOf(k)
    if (n !== null && name) (charged ??= {})[name] = n
  }
  const ds = str(r.defaultDatasetId)
  const kv = str(r.defaultKeyValueStoreId)
  return {
    id,
    actId: idOf(r.actId),
    status,
    isTerminal: isTerminalRunStatus(status),
    statusMessage: text(r.statusMessage, 500),
    startedAt: iso(r.startedAt),
    finishedAt: iso(r.finishedAt),
    defaultDatasetId: ds && ID_RE.test(ds) ? ds : null,
    defaultKeyValueStoreId: kv && ID_RE.test(kv) ? kv : null,
    usageTotalUsd: num(r.usageTotalUsd),
    chargedEventCounts: charged,
    options: {
      timeoutSecs: num(o.timeoutSecs),
      memoryMbytes: num(o.memoryMbytes),
      maxTotalChargeUsd: num(o.maxTotalChargeUsd),
    },
    durationMillis: num(stats.durationMillis),
    exitCode: num(r.exitCode),
  }
}

export interface StartRunOptions {
  /** run timeout (s), clamped to 1..600 */
  timeoutSecs: number
  /**
   * MB, rounded down to a power of two in 128..4096. ALWAYS sent: omitted = 1024 (pass the Actor's own default -
   * getActor().defaultRunOptions.memoryMbytes - for Actors outside the catalog; it is clamped the same way)
   */
  memoryMbytes?: number
  /** cost ceiling of the run (USD, > 0) - Apify aborts the run when it is reached */
  maxTotalChargeUsd: number
  /** long-poll 0..25 s (default 0) */
  waitForFinishSecs?: number
  build?: string
  /** @deprecated ignored - the start POST is never retried (kept for source compatibility) */
  deadline?: number
  /**
   * Recovery guard after an ambiguous start failure: true when this Apify run id is already recorded for ANOTHER
   * MCP (apify_runs) - such a run is never adopted nor aborted. startActorRunForMcp passes it; a throwing check
   * makes the start "uncertain" (fail safe).
   */
  isRunTaken?: (runId: string) => Promise<boolean>
  /**
   * Called when the caller aborted during the POST, after the run lookup: the run that was found (and aborted -
   * the abort answer, or the run as found when the abort failed), "none" (no run was created) or "unknown" (the
   * lookup failed). Lets the caller settle its daily-cap reservation.
   */
  onAbortRecovery?: (outcome: ApifyRun | "none" | "unknown") => void
}

export interface StartedRun extends ApifyRun {
  /** the POST failed ambiguously but this run (same Actor, same input, just started) was found and adopted */
  recovered: boolean
}

/** largest power of two ≤ mb within 128..4096 */
export function clampMemoryMbytes(mb: number): number {
  const v = Math.min(
    Math.max(Math.trunc(mb), APIFY_RUN_LIMITS.minMemoryMbytes),
    APIFY_RUN_LIMITS.maxMemoryMbytes
  )
  return 2 ** Math.floor(Math.log2(v))
}

/** USD for a query string: fixed 4 decimals (no float noise), > 0 */
export function usdParam(v: number): string {
  if (!Number.isFinite(v) || v <= 0)
    throw new ApifyError("charge_limit_invalid", { hint: null })
  return (Math.ceil(v * 10_000) / 10_000).toFixed(4)
}

/** memory of a run when the caller gives none (power of two, ≤ APIFY_RUN_LIMITS.maxMemoryMbytes) */
export const DEFAULT_RUN_MEMORY_MBYTES = 1024
/**
 * Clock skew tolerated between this server and Apify when looking for the run of an ambiguous POST: a run that
 * started more than this before our POST was sent cannot be ours.
 */
const RECOVERY_SKEW_MS = 10_000

function startQuery(o: StartRunOptions, waitSecs: number) {
  return {
    timeout: Math.min(
      Math.max(Math.trunc(o.timeoutSecs), 1),
      APIFY_RUN_LIMITS.maxTimeoutSecs
    ),
    // always sent: an Actor default can be 8-32 GB (cost = RAM x time, and RAM quota of the account)
    memory: clampMemoryMbytes(o.memoryMbytes ?? DEFAULT_RUN_MEMORY_MBYTES),
    maxTotalChargeUsd: usdParam(o.maxTotalChargeUsd),
    waitForFinish: waitSecs,
    build: o.build,
  }
}

/** failures after which the run MAY have been created: look for it, never retry the POST */
function isAmbiguous(e: unknown): boolean {
  return (
    isApifyError(e) &&
    (e.code === "timeout" ||
      e.code === "network" ||
      e.code === "upstream" ||
      e.code === "invalid_response")
  )
}

/** the Apify id of an Actor ("username~name" → GET /v2/actors; an id is returned as is) */
async function resolveActorApifyId(
  ctx: ApifyCallContext,
  actorId: string
): Promise<string> {
  if (!actorId.includes("~")) return actorId
  return (await getActor(ctx, actorId)).id
}

/**
 * The run our ambiguous POST may have created: a run of `actorId` on this token's account that started at most
 * RECOVERY_SKEW_MS before the POST was sent (`since`), whose INPUT equals `input` and that is not recorded for
 * another MCP (`isRunTaken`). Newest first, ≤ 3 inspected. Never adopts a run of somebody else with another input,
 * nor a run another MCP already owns.
 */
async function findStartedRun(
  ctx: ApifyCallContext,
  actorId: string,
  input: Record<string, unknown>,
  since: number,
  isRunTaken?: (runId: string) => Promise<boolean>
): Promise<ApifyRun | null> {
  const actId = await resolveActorApifyId(ctx, actorId)
  // 25 newest runs of the last minute: a busy shared account must not push our run out of the window
  const recent = await listRecentRuns(ctx, {
    startedAfter: new Date(since - 60_000),
    limit: 25,
  })
  const candidates = recent
    .filter(
      (r) =>
        r.actId === actId &&
        r.startedAt !== null &&
        Date.parse(r.startedAt) >= since - RECOVERY_SKEW_MS
    )
    .slice(0, 3)
  const expected = JSON.parse(JSON.stringify(input)) as unknown
  for (const c of candidates) {
    if (isRunTaken && (await isRunTaken(c.id))) continue
    let stored: unknown
    try {
      stored = (
        await apifyRequest<unknown>(
          requireToken(ctx),
          {
            method: "GET",
            path: apifyPath(
              "actor-runs",
              c.id,
              "key-value-store",
              "records",
              "INPUT"
            ),
            raw: true,
          },
          opts(ctx)
        )
      ).data
    } catch (e) {
      if (isApifyError(e) && e.code === "not_found") continue
      throw e
    }
    if (isDeepStrictEqual(stored, expected)) return getRun(ctx, c.id)
  }
  return null
}

/** fresh controller for the recovery after the caller gave up (bounded, not linked to the caller signal) */
function detached(ctx: ApifyCallContext, ms: number): ApifyCallContext {
  // still within the caller's deadline: the tool must answer in time even when cleaning up
  return { ...ctx, signal: AbortSignal.timeout(clampToDeadline(ms, ctx.deadline)) }
}

/**
 * POST /v2/actors/{actorId}/runs with server-side ceilings (timeout ≤ 600 s, memory ≤ 4096 MB - always sent,
 * maxTotalChargeUsd) and waitForFinish ≤ 25 s. The POST is NEVER retried (no idempotency key for runs: a retry after
 * a slow answer could start - and bill - a second run): after a timeout / network error / 5xx / unreadable answer the
 * token's recent runs are checked and a run of this Actor with the same input, started after the POST was sent and not
 * owned by another MCP, is adopted (`recovered: true`); otherwise ApifyError "start_uncertain" (the run may exist:
 * the caller keeps counting its cap and the AI must not retry at once). When the caller aborts during the POST, a run
 * found that way is aborted (no money wasted).
 */
export async function startActorRun(
  ctx: ApifyCallContext,
  actorId: string,
  input: Record<string, unknown>,
  o: StartRunOptions
): Promise<StartedRun> {
  const token = requireToken(ctx)
  const path = apifyPath("actors", actorId, "runs")
  let wait = Math.min(
    Math.max(Math.trunc(o.waitForFinishSecs ?? 0), 0),
    APIFY_RUN_LIMITS.maxWaitForFinishSecs
  )
  // the long-poll + its HTTP margin must end before the caller's deadline (the run itself keeps going)
  if (ctx.deadline !== undefined && Number.isFinite(ctx.deadline)) {
    const room = Math.floor(
      (ctx.deadline - Date.now() - APIFY_TIMEOUTS.longPollExtraMs - 5_000) / 1000
    )
    wait = Math.max(0, Math.min(wait, room))
  }
  const query = startQuery(o, wait)
  const sentAt = Date.now()
  try {
    const { data } = await apifyRequest<unknown>(
      token,
      { method: "POST", path, query, body: input, retry: false },
      opts(ctx, wait * 1000 + APIFY_TIMEOUTS.longPollExtraMs + 5_000)
    )
    // an unreadable 201 is ambiguous too (the run exists): handled below like a timeout
    return { ...runOf(data), recovered: false }
  } catch (e) {
    const aborted = isApifyError(e) && e.code === "aborted"
    if (!aborted && !isAmbiguous(e)) throw e
    if (aborted) {
      // the caller left: if the run was created anyway, stop it (best effort, bounded)
      let outcome: ApifyRun | "none" | "unknown" = "unknown"
      try {
        const found = await findStartedRun(
          detached(ctx, 8_000),
          actorId,
          input,
          sentAt,
          o.isRunTaken
        )
        if (!found) outcome = "none"
        else {
          outcome = found
          if (!found.isTerminal)
            outcome = await abortRun(detached(ctx, 5_000), found.id).catch(
              () => found
            )
        }
      } catch {
        // lookup failed: nothing more to do
      }
      try {
        o.onAbortRecovery?.(outcome)
      } catch {
        // a callback failure never hides the abort
      }
      throw e
    }
    const httpStatus = (e as ApifyError).httpStatus
    let found: ApifyRun | null
    try {
      found = await findStartedRun(ctx, actorId, input, sentAt, o.isRunTaken)
    } catch {
      throw new ApifyError("start_uncertain", { httpStatus })
    }
    if (found) return { ...found, recovered: true }
    throw new ApifyError("start_uncertain", { httpStatus })
  }
}

/** GET /v2/actor-runs/{runId}[?waitForFinish≤30] with the token that started the run. */
export async function getRun(
  ctx: ApifyCallContext,
  runId: string,
  o: { waitForFinishSecs?: number } = {}
): Promise<ApifyRun> {
  const wait = Math.min(
    Math.max(Math.trunc(o.waitForFinishSecs ?? 0), 0),
    APIFY_RUN_LIMITS.maxGetRunWaitSecs
  )
  const { data } = await apifyRequest<unknown>(
    requireToken(ctx),
    {
      method: "GET",
      path: apifyPath("actor-runs", runId),
      query: { waitForFinish: wait || undefined },
    },
    opts(ctx, wait ? wait * 1000 + APIFY_TIMEOUTS.longPollExtraMs : undefined)
  )
  return runOf(data)
}

export interface ApifyRunListItem {
  id: string
  actId: string | null
  status: string
  startedAt: string | null
  finishedAt: string | null
  defaultDatasetId: string | null
  usageTotalUsd: number | null
}

/** GET /v2/actor-runs?desc=1 (runs of the token's account, newest first, ≤ 50). */
export async function listRecentRuns(
  ctx: ApifyCallContext,
  o: { startedAfter?: Date; limit?: number; status?: string } = {}
): Promise<ApifyRunListItem[]> {
  const { data } = await apifyRequest<unknown>(
    requireToken(ctx),
    {
      method: "GET",
      path: apifyPath("actor-runs"),
      query: {
        desc: true,
        limit: Math.min(Math.max(Math.trunc(o.limit ?? 10), 1), 50),
        startedAfter: o.startedAfter?.toISOString(),
        status: o.status,
      },
    },
    opts(ctx)
  )
  const items = Array.isArray(obj(data).items)
    ? (obj(data).items as unknown[])
    : []
  const out: ApifyRunListItem[] = []
  for (const raw of items) {
    const r = obj(raw)
    const id = str(r.id)
    const status = str(r.status)
    if (!id || !ID_RE.test(id) || !status) continue
    const ds = str(r.defaultDatasetId)
    out.push({
      id,
      actId: idOf(r.actId),
      status,
      startedAt: iso(r.startedAt),
      finishedAt: iso(r.finishedAt),
      defaultDatasetId: ds && ID_RE.test(ds) ? ds : null,
      usageTotalUsd: num(r.usageTotalUsd),
    })
  }
  return out
}

/** POST /v2/actor-runs/{runId}/abort (idempotent: retried like a GET). */
export async function abortRun(
  ctx: ApifyCallContext,
  runId: string,
  o: { gracefully?: boolean } = {}
): Promise<ApifyRun> {
  const { data } = await apifyRequest<unknown>(
    requireToken(ctx),
    {
      method: "POST",
      path: apifyPath("actor-runs", runId, "abort"),
      query: { gracefully: o.gracefully ? true : undefined },
      retry: true,
    },
    opts(ctx)
  )
  return runOf(data)
}

// ---------------------------------------------------------------------------------------------------------------
// Dataset
// ---------------------------------------------------------------------------------------------------------------

export interface DatasetPage {
  /** raw items as returned (untrusted: the MCP tool cleans / caps them) */
  items: unknown[]
  /** X-Apify-Pagination-Total (null when absent) */
  total: number | null
  offset: number
  limit: number
}

const FIELD_RE = /^[A-Za-z0-9_.$#@-]{1,100}$/

/**
 * GET /v2/datasets/{datasetId}/items - ALWAYS with `limit` (Apify's default is "everything"), JSON. Filtering:
 * `clean` (= skipHidden + skipEmpty) by default; when `skipHidden` or `skipEmpty` is given they are sent on their own
 * (and `clean` only if asked explicitly) - e.g. `{ skipHidden: true }` keeps empty items so offsets stay stable while
 * paging. `fields` / `omit`: dot paths (≤ 30); invalid names are dropped.
 */
export async function getDatasetItems(
  ctx: ApifyCallContext,
  datasetId: string,
  o: {
    limit: number
    offset?: number
    fields?: string[]
    omit?: string[]
    clean?: boolean
    /** skip fields starting with "#" (sent alone, without `clean`) */
    skipHidden?: boolean
    /** skip empty items (sent alone, without `clean`) */
    skipEmpty?: boolean
    desc?: boolean
  }
): Promise<DatasetPage> {
  const separate = o.skipHidden !== undefined || o.skipEmpty !== undefined
  const limit = Math.min(
    Math.max(Math.trunc(o.limit), 1),
    APIFY_RUN_LIMITS.maxDatasetLimit
  )
  const offset = Math.max(0, Math.trunc(o.offset ?? 0))
  const list = (v?: string[]) => {
    const ok = (v ?? []).filter((f) => FIELD_RE.test(f)).slice(0, 30)
    return ok.length ? ok.join(",") : undefined
  }
  const res = await apifyRequest<unknown>(
    requireToken(ctx),
    {
      method: "GET",
      path: apifyPath("datasets", datasetId, "items"),
      query: {
        format: "json",
        limit,
        offset: offset || undefined,
        fields: list(o.fields),
        omit: list(o.omit),
        clean: separate
          ? o.clean === true
            ? true
            : undefined
          : o.clean === false
            ? undefined
            : true,
        skipHidden: o.skipHidden,
        skipEmpty: o.skipEmpty,
        desc: o.desc ? true : undefined,
      },
      raw: true,
      maxBytes: APIFY_MAX_DATASET_BYTES,
    },
    opts(ctx, APIFY_TIMEOUTS.dataMs)
  )
  if (!Array.isArray(res.data)) throw new ApifyError("invalid_response")
  const total = Number(res.headers.get("x-apify-pagination-total"))
  return {
    items: res.data.slice(0, limit),
    total:
      res.headers.has("x-apify-pagination-total") && Number.isFinite(total)
        ? total
        : null,
    offset,
    limit,
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Actors outside the catalog (apify_*_actor tools, admin switch): what may run, which input fields are refused
// ---------------------------------------------------------------------------------------------------------------

export type ActorRefusal =
  "full_permissions" | "deprecated" | "under_maintenance" | "rental" | "standby"

/** Reasons an Actor outside the catalog must not run (16-apify.md §4). Empty = allowed. */
export function storeActorRefusals(
  a: Pick<
    ApifyActorInfo,
    "permissionLevel" | "isDeprecated" | "notice" | "pricing" | "usesStandby"
  >
): ActorRefusal[] {
  const out: ActorRefusal[] = []
  if (a.permissionLevel === "FULL_PERMISSIONS") out.push("full_permissions")
  if (a.isDeprecated) out.push("deprecated")
  if (a.notice === "UNDER_MAINTENANCE") out.push("under_maintenance")
  if (a.pricing?.pricingModel === "FLAT_PRICE_PER_MONTH") out.push("rental")
  if (a.usesStandby) out.push("standby")
  return out
}

/** normalised key: lower case, no separators */
const flat = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "")

/** dangerousInputFields result when the input cannot be checked completely (fail closed) */
export const INPUT_UNCHECKABLE = "(input quá lớn hoặc quá sâu)"
/** largest Actor input accepted from the AI (serialized JSON, bytes) */
export const MAX_ACTOR_INPUT_BYTES = 64 * 1024
const MAX_SCAN_DEPTH = 8
const MAX_SCAN_NODES = 2_000

/** a proxy given as a URL / user:pass@host / host:port (an own proxy - not the Apify proxy settings) */
const PROXY_ADDRESS_RE = /:\/\/|@|^[^\s:/]+:\d{2,5}$/

/** key names refused anywhere in an Actor input (credentials, headers, custom code, webhooks / connectors, own proxies) */
function isDangerousKey(key: string, value: unknown): boolean {
  const k = flat(key)
  if (!k) return false
  // credentials and request headers / cookies (headers carry Authorization / Cookie) at any depth
  if (
    /(cookie|header|password|passwd|login|session|credential|secret|authorization|apikey|accesstoken|bearer)/.test(
      k
    )
  )
    return true
  if (k.endsWith("token")) return true
  // custom JavaScript / hooks run inside the Actor (pageFunction, preNavigationHooks, evaluate, customJsCode…);
  // ordinary words containing "script" (description, transcript, subscription) and *Code fields such as
  // countryCode / languageCode stay allowed
  const code = k.replace(
    /description|transcript|subscri(be|ber|bers|ption|ptions)|manuscript|postscript/g,
    ""
  )
  if (
    /(function|hook|script|evaluate)/.test(code) ||
    k === "code" ||
    /(js|custom|source|inject)code/.test(k)
  )
    return true
  if (k.includes("webhook") || k.includes("connector")) return true
  // own proxies (proxyConfiguration.proxyUrls, proxyUrl, proxy: "http://u:p@host:port"…); the Apify proxy settings
  // themselves (useApifyProxy, apifyProxyGroups, proxyCountry "VN") are fine
  if (k.startsWith("proxyurl") || k === "customproxy" || k === "proxypassword")
    return true
  if (
    k.startsWith("proxy") &&
    typeof value === "string" &&
    PROXY_ADDRESS_RE.test(value.trim())
  )
    return true
  // Apify proxy groups: only the (default) datacenter groups - RESIDENTIAL (~$8/GB) and SERP groups are billed
  // apart from the run's cost cap; anything that is not a plain group name is refused too
  if (k.includes("proxygroup")) {
    const groups = Array.isArray(value) ? value : [value]
    if (
      groups.some(
        (g) =>
          typeof g !== "string" ||
          !/^[A-Za-z0-9_-]{1,50}$/.test(g) ||
          /residential|serp/i.test(g)
      )
    )
      return true
  }
  return false
}

/**
 * Paths of refused fields / secret-looking values in an Actor input (empty = acceptable), e.g.
 * ["pageFunction", "proxyConfiguration.proxyUrls", "startUrls[0].headers"]. FAIL CLOSED: an input larger than
 * 64 KB (serialized), deeper than 8 levels, with more than 2,000 nodes or not serializable returns
 * [INPUT_UNCHECKABLE]. String values are checked with the secret patterns of src/server/audit/redact.ts
 * (Apify / Telegram / Google / Meta / OpenAI tokens, Bearer, URL passwords, signed / token query strings…).
 */
export function dangerousInputFields(input: unknown): string[] {
  let size: number
  try {
    size = Buffer.byteLength(JSON.stringify(input) ?? "", "utf8")
  } catch {
    return [INPUT_UNCHECKABLE]
  }
  if (size > MAX_ACTOR_INPUT_BYTES) return [INPUT_UNCHECKABLE]
  const out: string[] = []
  let nodes = 0
  let incomplete = false
  const walk = (v: unknown, path: string, depth: number) => {
    if (incomplete || out.length >= 20) return
    if (++nodes > MAX_SCAN_NODES) {
      incomplete = true
      return
    }
    if (typeof v === "string") {
      if (containsSecretValue(v)) out.push(path || "(input)")
      return
    }
    if (v === null || typeof v !== "object") return
    if (depth >= MAX_SCAN_DEPTH) {
      incomplete = true
      return
    }
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}[${i}]`, depth + 1))
      return
    }
    for (const [k, x] of Object.entries(v as Obj)) {
      const p = path ? `${path}.${k}` : k
      if (isDangerousKey(k, x)) out.push(p)
      else walk(x, p, depth + 1)
    }
  }
  walk(input, "", 0)
  return incomplete ? [INPUT_UNCHECKABLE, ...out] : out
}
