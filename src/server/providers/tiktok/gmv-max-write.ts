// TikTok GMV Max (TikTok Shop) - WRITES, opened behind the admin-only MCP switch "tiktok_gmv_max_write"
// (MutationOptions.gmvMaxWrite; contract C1-C8 of the GMV Max phase 2 plan, providers/tiktok.md §8).
// Endpoints (v1.3, official docs read 2026-10-10):
//   POST /campaign/gmv_max/update/           (1822001009002497) incremental: budget, roas_bid (≤1 decimal), auto_budget,
//                                            promotion_days, item_group_ids, schedule_type / schedule_end_time, name
//   POST /campaign/gmv_max/create/           (1822000988713089) request_id (64-bit int string, 10 s dedup) - the
//                                            campaign starts ENABLED (no paused option); schedule_start_time may be
//                                            in the future (≤ 2028-01-01, ≥ now - 12 h)
//   POST /campaign/gmv_max/creative/update/  (1861260625563202) REMOVE / ADD posts, ≤400 per call, campaign active,
//                                            Product: AUTO_SELECTION + spu_id_list per post
//   POST /campaign/status/update/            (1739320994354178) ENABLE / DISABLE / DELETE, 1-20 ids
//   GET  /gmv_max/store/shop_ad_usage_check/ (1822001084174338) promote_all_products_allowed, is_running_custom_shop_ads
//   GET  /gmv_max/occupied_custom_shop_ads/list/ (1822001136924674) not used (VSA/PSA/LSA occupancy → warnings only)
//   GET  /gmv_max/identity/get/              (1822001101474882) identities + product/live availability
//   GET  /gmv_max/bid/recommend/             (1822001024720897) recommended roas_bid + daily budget (major units)
//   GET  /store/product/get/                 (1793482248880130) products; ad_creation_eligible GMV_MAX →
//                                            gmv_max_ads_status OCCUPIED / UNOCCUPIED; item_group_ids filter ≤10
// Every write: gate (opts.gmvMaxWrite) → reads → checks → strict daily-spend guard (opts.dailySpendGuard) when spend can
// start or rise → dryRun returns the preview → execute. mcp-core forces two-step confirmation for all of them (C4).
// Temporary media URLs (profile images, covers, product images) are never returned.
import { z } from "zod"
import { todayInTz } from "../dates"
import { isProviderError, ProviderError, withErrorAudit } from "../errors"
import { num, roundMoney } from "../money"
import {
  STARTED_MAX_DAILY_SPEND_FIELD,
  STARTED_SPEND_UNCERTAIN_LOG_CODE,
  type AdObjectDetail,
  type AlwaysConfirmOp,
  type BudgetUpdate,
  type CopyRequest,
  type CopyResult,
  type DailySpendCheck,
  type FieldChange,
  type MutationOptions,
  type MutationResult,
  type ObjectUpdate,
  type ProviderContext,
  type ProviderExtension,
  type StartedSpendEntry,
  type StartedSpendReservation,
  type TargetStatus,
} from "../types"
import {
  apiMoney,
  chunk,
  formatTikTokTime,
  invalid,
  normalizeStatus,
  parseTikTokTime,
  statusRaw,
  str,
  tiktokTimeToIso,
  ttFromCtx,
  ttGet,
  ttPost,
  tzOffsetMs,
  type Raw,
  type TT,
} from "./api"
import { makeRequestId } from "./client"
import { isUncertainCreateError } from "./create-checked"
import type { TikTokCredentials } from "./credentials"
import {
  fetchGmvMaxInfo,
  fetchGmvMaxStoresRaw,
  GMV_MAX_TYPES,
  gmvMaxStatus,
  gmvMaxWorstCaseDaily,
  listGmvMaxCampaignsRaw,
  mapGmvMaxIdentity,
  mapGmvMaxInfo,
  mapGmvMaxShop,
  pickGmvMaxStoreRow,
  rememberGmvMaxPresence,
  type GmvMaxDailySpend,
  type GmvMaxType,
} from "./gmv-max"
import {
  detectGmvMaxCampaigns,
  gmvMaxCheckFailure,
  gmvMaxErrorText,
  gmvMaxStatusPermissionWarning,
  gmvMaxStatusUnverifiedWarning,
  isGmvMaxCandidate,
} from "./gmv-max-detect"
import {
  GMV_MAX_BOOST_WARNING,
  GMV_MAX_BUDGET_EFFECT_NOTE,
  GMV_MAX_CAUTION,
  GMV_MAX_COPY_NOT_COPIED_NOTE,
  GMV_MAX_CREATIVES_WARNING,
  GMV_MAX_DELETE_WARNING,
  GMV_MAX_GUARD_MISSING,
  GMV_MAX_LEGACY_AUTO_BUDGET_ON,
  GMV_MAX_LOCKED_HINT,
  GMV_MAX_OCCUPIED_HINT,
  GMV_MAX_PRODUCTS_EDIT_WARNING,
  GMV_MAX_PROMO_ALREADY_OFF,
  GMV_MAX_READBACK_CHECK_HINT,
  GMV_MAX_ROI_HISTORY_SCOPE,
  GMV_MAX_ROI_PROTECTION_NOTE,
  GMV_MAX_ROI_RAISE_WARNING,
  GMV_MAX_ROI_SECOND_LOWER_WARNING,
  GMV_MAX_RUNS_NOW_WARNING,
  GMV_MAX_STARTED_HISTORY_UNAVAILABLE,
  GMV_MAX_UNCONFIRMED_HINT,
  gmvMaxBoostDefaultsNote,
  gmvMaxBudgetUnverifiedMessage,
  gmvMaxConfirmReason,
  gmvMaxCopyAllProductsMessage,
  gmvMaxCopyCustomPostsMessage,
  gmvMaxCopyDeletedMessage,
  gmvMaxDeletedDespiteError,
  gmvMaxEnableWarning,
  gmvMaxLockedMessage,
  gmvMaxNotDeliveringMessage,
  gmvMaxPauseNotApplied,
  gmvMaxPauseWarning,
  gmvMaxProductsRemovedWarning,
  gmvMaxReadBackMismatch,
  gmvMaxReadBackOverspend,
  gmvMaxReadBackUnavailable,
  gmvMaxRoasRoundedWarning,
  gmvMaxRoiLiveTodayWarning,
  gmvMaxRoiRecentWarning,
  gmvMaxScopeHint,
  gmvMaxStartedTotalLabel,
  gmvMaxStartedTotalNote,
  gmvMaxUnconfirmedMessage,
} from "./gmv-max-text"

/** campaign_name limit of TikTok campaigns (/campaign/create/: ≤512); the GMV Max create doc states none - UNVERIFIED. */
export const GMV_MAX_NAME_MAX = 512
/**
 * item_group_ids per create / update: the doc tables still say 50 but the API changelog of 2026-03-06 raised the limit
 * to 400 (newer than the tables) → 400. TikTok refuses anything above its real limit (no partial write).
 */
export const GMV_MAX_ITEM_GROUPS_MAX = 400
/** /gmv_max/bid/recommend/ item_group_ids max size (doc 1822001024720897: 50). */
export const GMV_MAX_BID_RECOMMEND_ITEMS_MAX = 50
/** item_list (CUSTOM_SELECTION posts) of create / update: max size 50. */
export const GMV_MAX_ITEM_LIST_MAX = 50
/** /campaign/gmv_max/creative/update/ item_list max size. */
export const GMV_MAX_CREATIVES_MAX = 400
/** identity_list of a Product GMV Max campaign (AUTO_SELECTION): 0-20. */
export const GMV_MAX_IDENTITIES_MAX = 20
/** Documented defaults (create doc 1822000988713089) of auto_budget / promotion_days when a value is not sent. */
export const GMV_MAX_BOOST_DEFAULT_PCT = 50
export const GMV_MAX_BOOST_DEFAULT_LIMIT = 10
export const GMV_MAX_PROMO_DEFAULT_MULTIPLIER = 90
/** Clock skew accepted between our send time and TikTok's create_time when looking up an uncertain create. */
const CREATE_LOOKUP_SKEW_MS = 2 * 60_000
/** schedule_start_time: "cannot be later than 2028-01-01 00:00:00"; end: "cannot be later than 2038-01-01 00:00:00". */
const START_LIMIT = Date.parse("2028-01-01T00:00:00Z")
const END_LIMIT = Date.parse("2038-01-01T00:00:00Z")
/** Absolute-value writes (budget, ROI, lists, status) are idempotent → safe to retry on transient errors. */
const IDEMPOTENT_RETRIES = 2
/** Info calls spent to name the campaign that occupies a product. */
const MAX_CONFLICT_INFO = 10
/** ROI history look-back (Product: 3 full days rule → 5 calendar days are enough). */
const ROI_HISTORY_HOURS = 24 * 5

const numericId = z.string().regex(/^\d+$/, { error: "Id phải là chuỗi số." })
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { error: "Ngày dạng YYYY-MM-DD." })

/** ROI target: positive, at most one decimal place (docs: "kept to up to one decimal place", e.g. 3.2, 3). */
export const roasBidSchema = z
  .number()
  .positive()
  .max(1000)
  .refine((v) => Math.abs(v * 10 - Math.round(v * 10)) < 1e-9, {
    error: "ROI mục tiêu tối đa 1 chữ số thập phân (vd 3.2).",
  })

/** ROI target as sent upstream (one decimal, no float noise). */
export function roasValue(v: number): number {
  return Math.round(v * 10) / 10
}

function moneyOf(v: unknown, currency: string): number | null {
  return roundMoney(num(v), currency)
}

function fmt(v: number | null, currency: string): string {
  if (v === null) return "-"
  return `${new Intl.NumberFormat("vi-VN").format(roundMoney(v, currency) as number)} ${currency}`
}

function objectOf(v: unknown): Raw {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : {}
}

function idList(v: unknown): string[] {
  return Array.isArray(v)
    ? v.map((x) => String(x)).filter((x) => /^\d+$/.test(x))
    : []
}

// ---------------------------------------------------------------------------
// Gate + guard (C3, C5)
// ---------------------------------------------------------------------------

/** C3: refusal of any write on GMV Max campaigns when the MCP switch is off. */
export function gmvMaxLockedError(ids: string[]): ProviderError {
  return new ProviderError({
    platform: "tiktok",
    code: "feature_not_enabled",
    message: `gmv_max_locked: GMV Max writes are not enabled for this MCP (campaign ${ids.join(", ")})`,
    userMessageVi: gmvMaxLockedMessage(ids.join(", ")),
    hint: GMV_MAX_LOCKED_HINT,
    retryable: false,
  })
}

/** C3: only an explicit true (set by mcp-core from the grant) lets a GMV Max write through. */
export function assertGmvMaxWriteAllowed(
  opts: MutationOptions,
  ids: string[]
): void {
  if (opts.gmvMaxWrite !== true) throw gmvMaxLockedError(ids)
}

/**
 * C4 defence in depth: a GMV Max write is EXECUTED only through a consumed two-step confirmation (opts.confirmed, set
 * by mcp-core from the consumed confirm_token). Previews (dryRun) pass. Even if mcp-core's always-confirm hook ever
 * misses a GMV Max campaign, nothing is sent to TikTok without the user's explicit confirmation.
 */
export function assertGmvMaxConfirmed(
  opts: MutationOptions,
  ids: string[]
): void {
  if (opts.dryRun || opts.confirmed === true) return
  throw new ProviderError({
    platform: "tiktok",
    code: "feature_not_enabled",
    message: `gmv_max_unconfirmed: GMV Max write without a consumed two-step confirmation (campaign ${ids.join(", ")})`,
    userMessageVi: gmvMaxUnconfirmedMessage(ids.join(", ")),
    hint: GMV_MAX_UNCONFIRMED_HINT,
    retryable: false,
  })
}

/** Gate of every GMV Max write: the admin switch (C3), then - on execution - the consumed confirmation (C4). */
export function assertGmvMaxWrite(opts: MutationOptions, ids: string[]): void {
  assertGmvMaxWriteAllowed(opts, ids)
  assertGmvMaxConfirmed(opts, ids)
}

/** A campaign starting (or raising its worst case) now: `id` = campaign id, null for a create (keyed by `key`). */
export interface StartingSpend {
  id: string | null
  amount: number
  /** ledger / log key of a create whose campaign id is not known yet (startedRequestKey) */
  key?: string
}

/** S5 result: preview notes + (execution only) the ledger reservation the caller settles / releases. */
export interface StartedCheck {
  notes: string[]
  reservation: StartedSpendReservation | null
}

/** Ledger / log key of a GMV Max create before its campaign id is known (L1: also the object_id of its error row). */
export function startedRequestKey(requestId: string): string {
  return `gmv_max_request:${requestId}`
}

/**
 * S5: the GMV Max campaigns THIS MCP made start running (or raised while running) on this ad account in the last 24 h
 * (create / copy / enable / raise, recorded as STARTED_MAX_DAILY_SPEND_FIELD changes + live reservations) + the
 * campaigns starting now must fit the MCP daily cap. A campaign counts once (its largest recorded worst case; campaign
 * ids starting now replace their old entry - a create's request key never does). Missing / failing history → refused
 * (fail closed). On EXECUTION the read + check + reservation run under the per MCP + ad account lock of mcp-core
 * (opts.startedSpendLedger, M1) and the reservation is returned: the caller settles it (create: request key → id) or
 * releases it on a definite failure. Returns a preview note when earlier starts were counted.
 */
export async function assertStartedWithinCap(
  tt: TT,
  opts: MutationOptions,
  starting: StartingSpend[]
): Promise<StartedCheck> {
  const guardMissing = (what: string) =>
    new ProviderError({
      platform: "tiktok",
      code: "feature_not_enabled",
      message: `GMV Max start without ${what} (fail closed)`,
      userMessageVi: GMV_MAX_GUARD_MISSING,
      retryable: false,
    })
  const read = opts.startedSpend24h
  if (typeof read !== "function") throw guardMissing("startedSpend24h")
  const ledger = opts.dryRun ? null : opts.startedSpendLedger
  if (!opts.dryRun && !ledger) throw guardMissing("startedSpendLedger")
  const check = async (): Promise<StartedCheck> => {
    let rows: StartedSpendEntry[]
    try {
      rows = await read()
    } catch (e) {
      throw new ProviderError({
        platform: "tiktok",
        code: "upstream_error",
        message: "GMV Max started-spend history unavailable (fail closed)",
        userMessageVi: GMV_MAX_STARTED_HISTORY_UNAVAILABLE,
        retryable: true,
        cause: e,
      })
    }
    const byId = new Map<string, number>()
    for (const r of rows) {
      if (Number.isFinite(r.amount) && r.amount >= 0)
        byId.set(r.objectId, Math.max(byId.get(r.objectId) ?? 0, r.amount))
    }
    for (const s of starting) if (s.id) byId.delete(s.id)
    const notes: string[] = []
    if (byId.size) {
      const prior = roundMoney(
        [...byId.values()].reduce((a, b) => a + b, 0),
        tt.currency
      ) as number
      const now = starting.reduce((a, s) => a + s.amount, 0)
      const total = roundMoney(prior + now, tt.currency) as number
      spendGuard(opts)([
        {
          label: gmvMaxStartedTotalLabel(byId.size, fmt(prior, tt.currency)),
          amount: total,
          currency: tt.currency,
        },
      ])
      notes.push(
        gmvMaxStartedTotalNote(
          byId.size,
          fmt(prior, tt.currency),
          fmt(total, tt.currency)
        )
      )
    }
    const reservation = ledger
      ? ledger.reserve(
          starting
            .map((s) => ({ objectId: s.id ?? s.key ?? "", amount: s.amount }))
            .filter((s) => s.objectId)
        )
      : null
    return { notes, reservation }
  }
  return ledger ? ledger.exclusive(check) : check()
}

/**
 * L1 / M2: a write that may have started (or raised) spend failed with an UNKNOWN outcome → the reservation is kept
 * (24 h) and the error carries the started change + STARTED_SPEND_UNCERTAIN_LOG_CODE so its mcp_call_logs row is
 * counted by startedSpend24h. A definite failure releases the reservation and is rethrown unchanged.
 */
function startFailed(
  e: unknown,
  reservation: StartedSpendReservation | null,
  changes: FieldChange[]
): unknown {
  if (!reservation) return e
  if (!isUncertainCreateError(e)) {
    reservation.release()
    return e
  }
  return withErrorAudit(e, "tiktok", {
    errorCode: STARTED_SPEND_UNCERTAIN_LOG_CODE,
    changes,
  })
}

/**
 * M2: the worst-case daily spend of a RUNNING GMV Max campaign rises (budget / auto budget / promotion days) → the new
 * worst case replaces the campaign in the cumulative 24 h cap (S5; counted even when this MCP did not start it). null
 * when nothing rises or the campaign is paused (switching it on later goes through the enable check).
 */
async function raiseStartedCheck(
  tt: TT,
  opts: MutationOptions,
  id: string,
  info: Raw,
  row: Raw | undefined,
  nextWorst: number,
  currentWorst: number
): Promise<StartedCheck | null> {
  if (!(nextWorst > currentWorst) || !isRunning(info, row)) return null
  return assertStartedWithinCap(tt, opts, [{ id, amount: nextWorst }])
}

/** M2 after the write: the reservation keeps the larger of the approved and read-back worst case → started change. */
function settleRaise(
  raise: StartedCheck,
  id: string,
  name: string | null,
  approved: number,
  readBack: number | null
): FieldChange {
  const amount = Math.max(approved, readBack ?? 0)
  raise.reservation?.settle(id, { objectId: id, amount })
  return startedChange(id, name, amount)
}

/** Is a GMV Max campaign (info) running - i.e. not paused? Unknown → running (fail closed). */
function isRunning(info: Raw, row?: Raw): boolean {
  return (
    (str(info.operation_status) ?? str(row?.operation_status)) !== "DISABLE"
  )
}

/** Change row recording the worst-case daily spend of a GMV Max campaign that starts running now (S5). */
export function startedChange(
  id: string,
  name: string | null,
  amount: number
): FieldChange {
  return {
    objectId: id,
    objectName: name,
    level: "campaign",
    field: STARTED_MAX_DAILY_SPEND_FIELD,
    before: null,
    after: amount,
  }
}

/** /campaign/gmv_max/info/ after a write (A2); null when it cannot be read (the caller warns). */
async function readBackInfo(tt: TT, id: string): Promise<Raw | null> {
  try {
    return await fetchGmvMaxInfo(tt, id)
  } catch {
    return null
  }
}

function sameMoney(a: unknown, b: number, currency: string): boolean {
  const x = moneyOf(a, currency)
  return x !== null && x === roundMoney(b, currency)
}

function sameIds(a: unknown, b: string[]): boolean {
  const x = new Set(idList(a))
  return x.size === new Set(b).size && b.every((id) => x.has(id))
}

/**
 * A2: compare what TikTok reports after a write with what was sent. Mismatches → red warnings; a read-back whose
 * worst-case daily spend is ABOVE what the guard approved → error telling the user to check / pause in TikTok Ads
 * Manager (`approvedMaxDaily` null = do not compare spend).
 */
export async function verifyGmvMaxWrite(
  tt: TT,
  id: string,
  expect: {
    budget?: number
    roas_bid?: number
    item_group_ids?: string[]
    auto_budget?: Raw
    promotion_days?: Raw
    operation_status?: "ENABLE" | "DISABLE"
  },
  approvedMaxDaily: number | null,
  /**
   * "throw": an overspend read-back is an error (updates); "warn": it becomes the FIRST warning (create / copy: the
   * campaign exists and runs - its id must reach the user). `out.worst` receives the read-back worst case.
   */
  mode: "throw" | "warn" = "throw",
  out: { worst: number | null } = { worst: null }
): Promise<string[]> {
  const got = await readBackInfo(tt, id)
  if (!got) return [gmvMaxReadBackUnavailable(id)]
  const diffs: string[] = []
  if (
    expect.budget !== undefined &&
    !sameMoney(got.budget, expect.budget, tt.currency)
  )
    diffs.push(
      `ngân sách ngày ${fmt(moneyOf(got.budget, tt.currency), tt.currency)} (đã gửi ${fmt(expect.budget, tt.currency)})`
    )
  if (expect.roas_bid !== undefined && num(got.roas_bid) !== expect.roas_bid)
    diffs.push(
      `ROI mục tiêu ${num(got.roas_bid) ?? "-"} (đã gửi ${expect.roas_bid})`
    )
  if (
    expect.item_group_ids &&
    !sameIds(got.item_group_ids, expect.item_group_ids)
  )
    diffs.push(
      `danh sách sản phẩm ${idList(got.item_group_ids).length} sản phẩm (đã gửi ${expect.item_group_ids.length})`
    )
  const boost = (
    label: string,
    sent: Raw | undefined,
    have: unknown,
    key: "auto_budget_enabled" | "is_enabled"
  ) => {
    if (!sent) return
    const h = objectOf(have)
    if ((h[key] === true) !== (sent[key] === true))
      diffs.push(
        `${label} ${h[key] === true ? "đang BẬT" : "đang tắt"} (đã gửi ${sent[key] === true ? "bật" : "tắt"})`
      )
    if (sent[key] === true) {
      for (const k of [
        "budget_increase_percentage",
        "increase_limit",
      ] as const) {
        if (
          sent[k] !== undefined &&
          num(h[k]) !== null &&
          num(h[k]) !== sent[k]
        )
          diffs.push(`${label} ${k} = ${num(h[k])} (đã gửi ${String(sent[k])})`)
      }
    }
  }
  boost(
    "tăng ngân sách tự động",
    expect.auto_budget,
    got.auto_budget,
    "auto_budget_enabled"
  )
  boost(
    "ngày khuyến mãi",
    expect.promotion_days,
    got.promotion_days,
    "is_enabled"
  )
  if (
    expect.operation_status &&
    str(got.operation_status) &&
    got.operation_status !== expect.operation_status
  )
    diffs.push(
      `trạng thái ${str(got.operation_status)} (mong đợi ${expect.operation_status})`
    )
  if (approvedMaxDaily !== null) {
    const worst = gmvMaxWorstCaseDaily(
      got,
      tt.currency
    ).max_possible_daily_spend
    out.worst = worst
    if (worst !== null && worst > approvedMaxDaily && mode === "warn") {
      return [
        gmvMaxReadBackOverspend(
          id,
          fmt(worst, tt.currency),
          fmt(approvedMaxDaily, tt.currency),
          diffs.join("; ")
        ),
      ]
    }
    if (worst !== null && worst > approvedMaxDaily) {
      throw new ProviderError({
        platform: "tiktok",
        code: "upstream_error",
        message: `GMV Max read-back of ${id}: worst-case daily spend ${worst} above the approved ${approvedMaxDaily}`,
        userMessageVi: gmvMaxReadBackOverspend(
          id,
          fmt(worst, tt.currency),
          fmt(approvedMaxDaily, tt.currency),
          diffs.join("; ")
        ),
        hint: GMV_MAX_READBACK_CHECK_HINT,
        retryable: false,
      })
    }
  }
  return diffs.length ? [gmvMaxReadBackMismatch(id, diffs.join("; "))] : []
}

/** C5: the strict daily-spend guard of mcp-core; missing → refuse (fail closed). */
function spendGuard(opts: MutationOptions): (items: DailySpendCheck[]) => void {
  if (typeof opts.dailySpendGuard === "function") return opts.dailySpendGuard
  return () => {
    throw new ProviderError({
      platform: "tiktok",
      code: "feature_not_enabled",
      message: "GMV Max write without dailySpendGuard (fail closed)",
      userMessageVi: GMV_MAX_GUARD_MISSING,
      retryable: false,
    })
  }
}

function conflict(
  userMessageVi: string,
  hint = GMV_MAX_OCCUPIED_HINT
): ProviderError {
  return new ProviderError({
    platform: "tiktok",
    code: "conflict",
    message: "GMV Max pre-check failed (occupied / unavailable asset)",
    userMessageVi,
    hint,
    retryable: false,
  })
}

/** Budget of a GMV Max campaign could not be read (activation / worst-case checks fail closed). */
function budgetUnverified(e: unknown, id: string): ProviderError {
  if (isProviderError(e) && e.code === "auth_invalid") return e
  const denied = isProviderError(e) && e.code === "permission_denied"
  return new ProviderError({
    platform: "tiktok",
    code: denied ? "permission_denied" : "upstream_error",
    message: `GMV Max info unavailable for campaign ${id} (worst-case daily spend)`,
    userMessageVi: gmvMaxBudgetUnverifiedMessage(id),
    hint: denied
      ? gmvMaxScopeHint("/campaign/gmv_max/info/")
      : e
        ? `TikTok: ${gmvMaxErrorText(e)}`.slice(0, 400)
        : undefined,
    retryable: denied ? false : isProviderError(e) ? e.retryable : true,
    upstream: isProviderError(e) ? e.upstream : undefined,
    cause: e ?? undefined,
  })
}

// ---------------------------------------------------------------------------
// Lookup: which campaign ids are GMV Max (rows of /campaign/get/ + ids absent from it)
// ---------------------------------------------------------------------------

export interface GmvMaxHit {
  id: string
  type: GmvMaxType
  /** /campaign/get/ row, or the /gmv_max/campaign/get/ row when /campaign/get/ did not return the campaign */
  row: Raw
}

/**
 * Full /gmv_max/campaign/get/ rows of ids that /campaign/get/ did not return (GMV Max campaigns may be absent there).
 * Passes: default primary_status, then STATUS_DISABLE (the default is undocumented); PRODUCT then LIVE; ≤100 ids/call.
 */
async function fetchGmvMaxRows(
  tt: TT,
  ids: string[]
): Promise<Map<string, { type: GmvMaxType; row: Raw }>> {
  const out = new Map<string, { type: GmvMaxType; row: Raw }>()
  for (const primary of [null, "STATUS_DISABLE"] as const) {
    for (const type of GMV_MAX_TYPES) {
      const remaining = ids.filter((id) => !out.has(id))
      if (!remaining.length) return out
      for (const batch of chunk(remaining, 100)) {
        const extra: Raw = { campaign_ids: batch }
        if (primary) extra.primary_status = primary
        const { list } = await listGmvMaxCampaignsRaw(
          tt,
          type,
          extra,
          batch.length
        )
        for (const row of list) {
          const id = str(row.campaign_id)
          if (id && batch.includes(id) && !out.has(id))
            out.set(id, { type, row })
        }
      }
    }
  }
  return out
}

/**
 * GMV Max campaigns among `ids`. `found` = /campaign/get/ rows by id: candidates there are cross-checked
 * (detectGmvMaxCampaigns), ids absent from it are looked up in /gmv_max/campaign/get/. Non-candidates cost nothing.
 * Throws the client's ProviderError when a check call fails - callers fail closed.
 */
export async function lookupGmvMaxCampaigns(
  tt: TT,
  ids: string[],
  found: Map<string, Raw>,
  /**
   * true: a failed lookup of ids ABSENT from /campaign/get/ leaves them unresolved (the caller then reports
   * "not found" and writes nothing) instead of throwing. Candidates present in /campaign/get/ always throw.
   */
  softMissing = false
): Promise<Map<string, GmvMaxHit>> {
  const hits = new Map<string, GmvMaxHit>()
  const uniq = [...new Set(ids.map(String))]
  const candRows = uniq
    .map((id) => found.get(id))
    .filter((r): r is Raw => !!r && isGmvMaxCandidate(r))
  const missing = uniq.filter((id) => !found.has(id) && /^\d+$/.test(id))
  if (candRows.length) {
    const types = await detectGmvMaxCampaigns(tt, candRows)
    for (const r of candRows) {
      const id = String(r.campaign_id)
      const t = types.get(id)
      if (t) hits.set(id, { id, type: t, row: r })
    }
  }
  if (missing.length) {
    let rows: Map<string, { type: GmvMaxType; row: Raw }> = new Map()
    try {
      rows = await fetchGmvMaxRows(tt, missing)
    } catch (e) {
      if (!softMissing || (isProviderError(e) && e.code === "auth_invalid"))
        throw e
    }
    for (const [id, v] of rows) hits.set(id, { id, type: v.type, row: v.row })
  }
  if (hits.size) rememberGmvMaxPresence(tt, true)
  return hits
}

/** One campaign: its GMV Max hit, or null when it is not GMV Max. A failed check → refusal (fail closed). */
export async function gmvMaxHitFor(
  tt: TT,
  id: string,
  found: Raw | null,
  softMissing = false
): Promise<GmvMaxHit | null> {
  if (found && !isGmvMaxCandidate(found)) return null
  try {
    const map = found ? new Map([[String(id), found]]) : new Map<string, Raw>()
    return (
      (await lookupGmvMaxCampaigns(tt, [String(id)], map, softMissing)).get(
        String(id)
      ) ?? null
    )
  } catch (e) {
    throw gmvMaxCheckFailure(e, String(id))
  }
}

/** A GMV Max campaign that must exist (GMV-Max-only tools). */
async function requireGmvMaxCampaign(tt: TT, id: string): Promise<GmvMaxHit> {
  const hit = await gmvMaxHitFor(tt, id, null)
  if (!hit) {
    throw new ProviderError({
      platform: "tiktok",
      code: "not_found",
      message: `GMV Max campaign ${id} not found`,
      userMessageVi: `Không tìm thấy chiến dịch GMV Max ${id} trong tài khoản quảng cáo này.`,
      hint: "Xem danh sách bằng tiktok_gmv_max_campaigns.",
    })
  }
  return hit
}

function isDeleted(row: Raw): boolean {
  return (
    normalizeStatus(row.operation_status, row.secondary_status) === "deleted"
  )
}

// ---------------------------------------------------------------------------
// Worst-case daily spend after a change (C5)
// ---------------------------------------------------------------------------

/** Boost object without the values TikTok computes from the CURRENT budget (stale after a change). */
function stripComputed(b: unknown): Raw | undefined {
  if (!b || typeof b !== "object" || Array.isArray(b)) return undefined
  const {
    maximum_budget: _m,
    next_increase: _n,
    current_budget: _c,
    ...rest
  } = b as Raw
  return rest
}

/**
 * Worst-case spend of one day after changing the daily budget and/or the boosts (keys as sent to
 * /campaign/gmv_max/update/). Unknown percentage / limit of an enabled boost → 31 × budget (gmvMaxWorstCaseDaily).
 */
export function gmvMaxWorstCaseAfter(
  info: Raw,
  patch: { budget?: number; auto_budget?: Raw; promotion_days?: Raw },
  currency: string
): GmvMaxDailySpend {
  const budgetChanged = patch.budget !== undefined
  const merge = (current: unknown, next: Raw | undefined) =>
    next
      ? { ...(stripComputed(current) ?? {}), ...next }
      : budgetChanged
        ? stripComputed(current)
        : current
  return gmvMaxWorstCaseDaily(
    {
      ...info,
      budget: budgetChanged ? patch.budget : info.budget,
      auto_budget: merge(info.auto_budget, patch.auto_budget),
      promotion_days: merge(info.promotion_days, patch.promotion_days),
    },
    currency
  )
}

// ---------------------------------------------------------------------------
// Generic write routing: ads_set_status / ads_update_budget / ads_update_object / ads_delete_object / ads_copy_object
// ---------------------------------------------------------------------------

export interface GmvMaxStatusPlan {
  /** GMV Max rows for ids that /campaign/get/ did not return */
  rows: Map<string, Raw>
  /** ids handled as GMV Max (detected, or - switch on - unverifiable candidates, fail closed) */
  gmvIds: Set<string>
  /** warnings that apply when an unverifiable candidate is changed */
  warnings: string[]
}

/**
 * ads_set_status on campaigns: which are GMV Max (C3: switch off → refused, also for on/off). Candidates = found rows
 * (not deleted) that are candidates + ids absent from /campaign/get/. Check failure: switch off → refused (fail
 * closed); switch on → candidates handled as GMV Max (warnings, always confirmed) unless an id is missing entirely.
 */
export async function planGmvMaxStatus(
  tt: TT,
  ids: string[],
  found: Map<string, Raw>,
  opts: MutationOptions,
  status: TargetStatus
): Promise<GmvMaxStatusPlan> {
  const uniq = [...new Set(ids.map(String))]
  const target = status === "active" ? "ENABLE" : "DISABLE"
  // only campaigns that would change are checked (already in the target state / deleted → nothing is sent)
  const candIds = uniq.filter((id) => {
    const r = found.get(id)
    return (
      !!r &&
      isGmvMaxCandidate(r) &&
      !isDeleted(r) &&
      r.operation_status !== target
    )
  })
  const missing = uniq.filter((id) => !found.has(id))
  if (!candIds.length && !missing.length)
    return { rows: new Map(), gmvIds: new Set(), warnings: [] }
  let hits: Map<string, GmvMaxHit>
  try {
    hits = await lookupGmvMaxCampaigns(
      tt,
      [...candIds, ...missing],
      found,
      true
    )
  } catch (e) {
    const all = [...candIds, ...missing]
    if (opts.gmvMaxWrite !== true || missing.length)
      throw gmvMaxCheckFailure(e, all.join(", "))
    const denied = isProviderError(e) && e.code === "permission_denied"
    return {
      rows: new Map(),
      gmvIds: new Set(candIds),
      warnings: [
        denied
          ? gmvMaxStatusPermissionWarning(candIds)
          : gmvMaxStatusUnverifiedWarning(candIds),
      ],
    }
  }
  const gmvIds = new Set(
    [...hits.keys()].filter(
      (id) => !(found.has(id) && isDeleted(found.get(id)!))
    )
  )
  if (gmvIds.size) assertGmvMaxWriteAllowed(opts, [...gmvIds])
  const rows = new Map<string, Raw>()
  for (const id of missing) {
    const h = hits.get(id)
    if (h) rows.set(id, h.row)
  }
  return { rows, gmvIds, warnings: [] }
}

/**
 * Effects of a status change on the GMV Max campaigns that will actually change (`changing` ids): pause / enable
 * warnings, and - when switching ON - the WORST-CASE daily spend of each must fit the MCP daily cap (strict guard,
 * fail closed when the budget cannot be read), and together with the GMV Max campaigns this MCP started in the last
 * 24 h (S5). Execution needs the consumed confirmation (C4). Runs on preview and execution. `started` = worst-case
 * daily spend of each campaign switched on (recorded as STARTED_MAX_DAILY_SPEND_FIELD changes by the caller);
 * `reservation` (execution) = the S5 ledger reservation of those ids - the caller releases the ids TikTok definitely
 * did not switch on (gmvMaxStatusFailed).
 */
export async function gmvMaxStatusEffects(
  tt: TT,
  changing: string[],
  plan: GmvMaxStatusPlan,
  status: TargetStatus,
  opts: MutationOptions
): Promise<{
  warnings: string[]
  started: Map<string, number>
  reservation: StartedSpendReservation | null
}> {
  const started = new Map<string, number>()
  let reservation: StartedSpendReservation | null = null
  const ids = changing.filter((id) => plan.gmvIds.has(id))
  if (!ids.length) return { warnings: [], started, reservation }
  assertGmvMaxWrite(opts, ids)
  const warnings = [
    ...plan.warnings,
    ...ids.map(status === "active" ? gmvMaxEnableWarning : gmvMaxPauseWarning),
  ]
  if (status === "active") {
    const guard = spendGuard(opts)
    const items: DailySpendCheck[] = []
    for (const id of ids) {
      let info: Raw
      try {
        info = await fetchGmvMaxInfo(tt, id)
      } catch (e) {
        throw budgetUnverified(e, id)
      }
      const w = gmvMaxWorstCaseDaily(info, tt.currency)
      if (w.max_possible_daily_spend === null) throw budgetUnverified(null, id)
      items.push({
        label: `Mức chi tối đa có thể mỗi ngày của chiến dịch GMV Max ${id}`,
        amount: w.max_possible_daily_spend,
        currency: tt.currency,
      })
      started.set(id, w.max_possible_daily_spend)
      if (w.max_possible_daily_spend > (w.daily_budget ?? 0)) {
        warnings.push(
          `${id}: ngân sách ngày ${fmt(w.daily_budget, tt.currency)}; chi tiêu tối đa có thể mỗi ngày ${fmt(w.max_possible_daily_spend, tt.currency)}. ${w.notes.join(" ")}`.trim()
        )
      }
    }
    guard(items)
    // S5: cumulative with the GMV Max campaigns this MCP made start running in the last 24 h
    const cap = await assertStartedWithinCap(
      tt,
      opts,
      [...started].map(([id, amount]) => ({ id, amount }))
    )
    warnings.push(...cap.notes)
    reservation = cap.reservation
  }
  return { warnings, started, reservation }
}

/**
 * ads_set_status (enable) failed after the S5 reservation: a definite failure releases it; an UNKNOWN outcome keeps it
 * and makes the error row carry the started changes (L1).
 */
export function gmvMaxStatusFailed(
  e: unknown,
  reservation: StartedSpendReservation | null,
  started: Map<string, number>,
  names: Map<string, string | null>
): unknown {
  return startFailed(
    e,
    reservation,
    [...started].map(([id, amount]) =>
      startedChange(id, names.get(id) ?? null, amount)
    )
  )
}

/**
 * A2 for ads_set_status: re-read the operation status of the GMV Max campaigns just changed. A pause that did not
 * take effect is reported loudly (the campaign keeps spending); other mismatches / unreadable campaigns → warnings.
 */
export async function verifyGmvMaxStatus(
  tt: TT,
  ids: string[],
  status: TargetStatus
): Promise<string[]> {
  const want = status === "active" ? "ENABLE" : "DISABLE"
  const out: string[] = []
  for (const id of ids) {
    const got = await readBackInfo(tt, id)
    if (!got) {
      out.push(gmvMaxReadBackUnavailable(id))
      continue
    }
    const op = str(got.operation_status)
    if (op && op !== want) {
      out.push(
        want === "DISABLE"
          ? gmvMaxPauseNotApplied(id, op)
          : gmvMaxReadBackMismatch(id, `trạng thái ${op} (mong đợi ${want})`)
      )
    }
  }
  return out
}

/**
 * AdsProvider.mustAlwaysConfirm for TikTok campaigns (C4): every write that touches a GMV Max campaign is confirmed.
 * `ids` = the ids to check (status: only those that would change; ids absent from /campaign/get/ included).
 * A failed check → the candidates must be confirmed (fail closed); an invalid token is rethrown.
 */
export async function gmvMaxConfirmReasons(
  tt: TT,
  ids: string[],
  found: Map<string, Raw>,
  op: AlwaysConfirmOp
): Promise<string[]> {
  // S1: a deleted row is skipped only for on/off (nothing is sent for it); copy / update / delete of a deleted GMV Max
  // campaign stay confirmed (the adapter refuses them, but confirmation must never depend on that)
  const statusOp = op === "active" || op === "paused"
  const cand = [...new Set(ids.map(String))].filter((id) => {
    const r = found.get(id)
    return !r || (isGmvMaxCandidate(r) && !(statusOp && isDeleted(r)))
  })
  if (!cand.length) return []
  try {
    const hits = await lookupGmvMaxCampaigns(tt, cand, found)
    const gmv = cand.filter((id) => hits.has(id))
    if (op === "active") return gmv.map(gmvMaxEnableWarning)
    if (op === "paused") return gmv.map(gmvMaxPauseWarning)
    return gmv.map(gmvMaxConfirmReason)
  } catch (e) {
    if (isProviderError(e) && e.code === "auth_invalid") throw e
    const denied = isProviderError(e) && e.code === "permission_denied"
    const perId =
      op === "active"
        ? gmvMaxEnableWarning
        : op === "paused"
          ? gmvMaxPauseWarning
          : gmvMaxConfirmReason
    return [
      denied
        ? gmvMaxStatusPermissionWarning(cand)
        : gmvMaxStatusUnverifiedWarning(cand),
      ...cand.map(perId),
    ]
  }
}

/**
 * ads_get_object on a TikTok campaign that is GMV Max: detail built from /gmv_max/campaign/get/ +
 * /campaign/gmv_max/info/ (daily budget → ads_update_budget's % guardrail works on the GMV Max base budget). Returns
 * null when the campaign is not GMV Max or (reads) the check fails - the caller keeps its generic behaviour.
 * `forWrite` (ads_update_budget's guard, S6): a failed check of a CANDIDATE row or of its info throws instead
 * (fail closed: a generic /campaign/get/ budget must never become the baseline of a GMV Max budget change).
 */
export async function gmvMaxObjectDetail(
  tt: TT,
  id: string,
  found: Raw | null,
  forWrite = false
): Promise<AdObjectDetail | null> {
  if (found && !isGmvMaxCandidate(found)) return null
  let hit: GmvMaxHit | null
  try {
    hit =
      (
        await lookupGmvMaxCampaigns(
          tt,
          [id],
          found ? new Map([[id, found]]) : new Map(),
          // ids absent from /campaign/get/: unresolved → "not found" (nothing is written)
          true
        )
      ).get(id) ?? null
  } catch (e) {
    if (forWrite) throw gmvMaxCheckFailure(e, id)
    return null
  }
  if (!hit) return null
  let info: Raw | null = null
  try {
    info = await fetchGmvMaxInfo(tt, id)
  } catch (e) {
    if (forWrite) throw budgetUnverified(e, id)
    info = null
  }
  const cur = tt.currency
  const st = gmvMaxStatus(hit.row.operation_status, hit.row.secondary_status)
  const worst = info ? gmvMaxWorstCaseDaily(info, cur) : null
  const daily = worst?.daily_budget ?? null
  const op = str(hit.row.operation_status)
  return {
    id,
    level: "campaign",
    name: str(hit.row.campaign_name) ?? id,
    status: st.status,
    statusRaw: statusRaw(hit.row),
    budget:
      daily !== null && daily > 0
        ? { type: "daily", amount: daily, currency: cur, level: "campaign" }
        : null,
    objective: str(hit.row.objective_type) ?? "PRODUCT_SALES",
    startTime: info ? tiktokTimeToIso(info.schedule_start_time) : null,
    endTime:
      info && info.schedule_type !== "SCHEDULE_FROM_NOW"
        ? tiktokTimeToIso(info.schedule_end_time)
        : null,
    createdTime: tiktokTimeToIso(hit.row.create_time),
    extra: {
      gmv_max: hit.type,
      ...(op === "ENABLE"
        ? { configuredStatus: "active" }
        : op === "DISABLE"
          ? { configuredStatus: "paused" }
          : {}),
      target_roi: info ? num(info.roas_bid) : null,
      max_possible_daily_spend: worst?.max_possible_daily_spend ?? null,
      note: "Chiến dịch GMV Max (TikTok Shop): chi tiết đầy đủ bằng tiktok_gmv_max_campaigns (include_details), chỉ số bằng tiktok_gmv_max_report.",
      ...(info
        ? {}
        : {
            details_error:
              "Không đọc được /campaign/gmv_max/info/ (ngân sách / ROI).",
          }),
    },
    config: info ? { gmv_max: mapGmvMaxInfo(info, cur, tt.timezone) } : {},
    children: [],
  }
}

/** ads_update_budget on a GMV Max campaign (daily budget via /campaign/gmv_max/update/). null = not GMV Max. */
export async function routeGmvMaxBudget(
  tt: TT,
  u: BudgetUpdate,
  found: Raw | null,
  opts: MutationOptions
): Promise<MutationResult | null> {
  if (u.level !== "campaign") return null
  const hit = await gmvMaxHitFor(tt, u.id, found, true)
  if (!hit) return null
  assertGmvMaxWrite(opts, [u.id])
  if (isDeleted(hit.row)) throw invalid(`Chiến dịch ${u.id} đã bị xoá.`)
  if (u.type !== "daily")
    throw invalid(
      "Chiến dịch GMV Max chỉ có ngân sách ngày (daily).",
      "Gọi lại với budget_type=daily."
    )
  const amount = apiMoney(u.amount, tt.currency)
  let info: Raw
  try {
    info = await fetchGmvMaxInfo(tt, u.id)
  } catch (e) {
    throw budgetUnverified(e, u.id)
  }
  const before = moneyOf(info.budget, tt.currency)
  if (before === null || !(before > 0)) throw budgetUnverified(null, u.id)
  // S6: the % limit + 24 h cumulative rule of the MCP against the GMV Max budget read HERE (not getObject)
  if (typeof opts.budgetChangeGuard !== "function") {
    throw new ProviderError({
      platform: "tiktok",
      code: "feature_not_enabled",
      message: "GMV Max budget change without budgetChangeGuard (fail closed)",
      userMessageVi: GMV_MAX_GUARD_MISSING,
      retryable: false,
    })
  }
  await opts.budgetChangeGuard({
    current: before,
    next: amount,
    currency: tt.currency,
  })
  const current = gmvMaxWorstCaseDaily(info, tt.currency)
  const worst = gmvMaxWorstCaseAfter(info, { budget: amount }, tt.currency)
  const maxDaily = worst.max_possible_daily_spend ?? amount
  const currentMax = current.max_possible_daily_spend ?? before
  // A3: only a HIGHER worst case must fit the cap (a decrease is never blocked by the cap)
  if (maxDaily > currentMax) {
    spendGuard(opts)([
      {
        label: `Mức chi tối đa có thể mỗi ngày của chiến dịch GMV Max ${u.id} với ngân sách mới`,
        amount: maxDaily,
        currency: tt.currency,
      },
    ])
  }
  // M2: a running campaign whose worst case rises - the new worst case enters the cumulative 24 h cap (S5)
  const raise = await raiseStartedCheck(
    tt,
    opts,
    u.id,
    info,
    hit.row,
    maxDaily,
    currentMax
  )
  const warnings = [GMV_MAX_BUDGET_EFFECT_NOTE, ...(raise?.notes ?? [])]
  if (info.auto_budget_enabled === true)
    warnings.push(GMV_MAX_LEGACY_AUTO_BUDGET_ON)
  if (maxDaily > amount) {
    warnings.push(
      `Đang bật tăng ngân sách tự động / ngày khuyến mãi: với ngân sách mới ${fmt(amount, tt.currency)}, chi tiêu tối đa có thể mỗi ngày ${fmt(maxDaily, tt.currency)}. ${worst.notes.join(" ")}`.trim()
    )
  }
  const changes: FieldChange[] = [
    {
      objectId: u.id,
      objectName: str(hit.row.campaign_name),
      level: "campaign",
      field: "daily_budget",
      before,
      after: amount,
    },
  ]
  if (opts.dryRun)
    return { preview: true, changes, warnings, effectiveAt: null }
  const name = str(hit.row.campaign_name)
  const out = { worst: null as number | null }
  try {
    await ttPost(
      tt,
      "campaign/gmv_max/update",
      { advertiser_id: tt.advertiserId, campaign_id: u.id, budget: amount },
      { retries: IDEMPOTENT_RETRIES }
    )
    // A2: read back (an unexpected higher worst case → error asking to check / pause in TikTok Ads Manager)
    warnings.push(
      ...(await verifyGmvMaxWrite(
        tt,
        u.id,
        { budget: amount },
        Math.max(maxDaily, currentMax),
        "throw",
        out
      ))
    )
  } catch (e) {
    throw startFailed(e, raise?.reservation ?? null, [
      startedChange(u.id, name, Math.max(maxDaily, out.worst ?? 0)),
    ])
  }
  if (raise) changes.push(settleRaise(raise, u.id, name, maxDaily, out.worst))
  return { preview: false, changes, warnings, effectiveAt: null }
}

/** ads_update_object on a GMV Max campaign: name and end time only (/campaign/gmv_max/update/). null = not GMV Max. */
export async function routeGmvMaxObjectUpdate(
  tt: TT,
  u: ObjectUpdate,
  found: Raw | null,
  opts: MutationOptions & { now?: Date }
): Promise<MutationResult | null> {
  if (u.level !== "campaign") return null
  const hit = await gmvMaxHitFor(tt, u.id, found, true)
  if (!hit) return null
  assertGmvMaxWrite(opts, [u.id])
  if (isDeleted(hit.row)) throw invalid(`Chiến dịch ${u.id} đã bị xoá.`)
  const now = opts.now ?? new Date()
  const c = u.changes
  const unsupported = (["startTime", "bidAmount", "finalUrl"] as const).filter(
    (k) => c[k] !== undefined
  )
  if (unsupported.length) {
    throw invalid(
      `Chiến dịch GMV Max ${u.id}: ads_update_object chỉ đổi được tên và ngày kết thúc (không đổi được ${unsupported.join(", ")}).`,
      "ROI mục tiêu / tăng ngân sách tự động / ngày khuyến mãi / sản phẩm: dùng tiktok_gmv_max_update; ngân sách ngày: ads_update_budget. TikTok không cho đổi ngày bắt đầu của chiến dịch GMV Max."
    )
  }
  const body: Raw = { advertiser_id: tt.advertiserId, campaign_id: u.id }
  const changes: FieldChange[] = []
  const name = str(hit.row.campaign_name)
  if (c.name !== undefined) {
    const next = c.name.trim()
    if (!next || next.length > GMV_MAX_NAME_MAX)
      throw invalid(`Tên chiến dịch phải có 1-${GMV_MAX_NAME_MAX} ký tự.`)
    body.campaign_name = next
    changes.push({
      objectId: u.id,
      objectName: name,
      level: "campaign",
      field: "name",
      before: name,
      after: next,
    })
  }
  if (c.endTime !== undefined) {
    const info = await fetchGmvMaxInfo(tt, u.id)
    const beforeEnd =
      info.schedule_type === "SCHEDULE_FROM_NOW"
        ? null
        : tiktokTimeToIso(info.schedule_end_time)
    if (c.endTime === null) {
      body.schedule_type = "SCHEDULE_FROM_NOW"
      changes.push({
        objectId: u.id,
        objectName: name,
        level: "campaign",
        field: "end_time",
        before: beforeEnd,
        after: null,
      })
    } else {
      const end = new Date(c.endTime)
      if (Number.isNaN(end.getTime()))
        throw invalid(`Thời gian không hợp lệ: ${c.endTime}.`)
      if (end.getTime() <= now.getTime())
        throw invalid("Ngày kết thúc phải ở tương lai.")
      if (end.getTime() > END_LIMIT)
        throw invalid("Ngày kết thúc không được sau 2038-01-01.")
      const start = parseTikTokTime(info.schedule_start_time)
      if (start && end.getTime() <= start.getTime())
        throw invalid("Ngày kết thúc phải sau ngày bắt đầu của chiến dịch.")
      body.schedule_type = "SCHEDULE_START_END"
      body.schedule_end_time = formatTikTokTime(end)
      changes.push({
        objectId: u.id,
        objectName: name,
        level: "campaign",
        field: "end_time",
        before: beforeEnd,
        after: end.toISOString(),
      })
    }
  }
  if (!changes.length) throw invalid("Không có trường nào cần sửa.")
  const warnings =
    c.endTime !== undefined
      ? [
          "Chiến dịch GMV Max ngừng chạy khi tới ngày kết thúc (giờ UTC gửi lên TikTok).",
        ]
      : []
  if (opts.dryRun) return { preview: true, changes, warnings }
  await ttPost(tt, "campaign/gmv_max/update", body, {
    retries: IDEMPOTENT_RETRIES,
  })
  return { preview: false, changes, warnings }
}

/** ads_delete_object on a GMV Max campaign (/campaign/status/update/ DELETE). null = not GMV Max. */
export async function routeGmvMaxDelete(
  tt: TT,
  id: string,
  found: Raw | null,
  opts: MutationOptions
): Promise<MutationResult | null> {
  const hit = await gmvMaxHitFor(tt, id, found, true)
  if (!hit) return null
  assertGmvMaxWrite(opts, [id])
  const before = gmvMaxStatus(
    hit.row.operation_status,
    hit.row.secondary_status
  ).status
  if (before === "deleted") {
    return {
      preview: !!opts.dryRun,
      changes: [],
      warnings: [`Chiến dịch ${id} đã bị xoá trước đó.`],
    }
  }
  const changes: FieldChange[] = [
    {
      objectId: id,
      objectName: str(hit.row.campaign_name),
      level: "campaign",
      field: "status",
      before,
      after: "deleted",
    },
  ]
  const warnings = [
    "Xoá trên TikTok là vĩnh viễn, không hoàn tác được.",
    GMV_MAX_DELETE_WARNING,
  ]
  if (opts.dryRun) return { preview: true, changes, warnings }
  // A9: DELETE is not retried (a retry after a lost answer would hit an already deleted campaign); on any error the
  // status is read back - deleted → success with a warning, otherwise the original error
  let res: { data?: { campaign_ids?: unknown } }
  try {
    res = await ttPost<{ campaign_ids?: unknown }>(
      tt,
      "campaign/status/update",
      {
        advertiser_id: tt.advertiserId,
        campaign_ids: [id],
        operation_status: "DELETE",
      },
      { retries: 0 }
    )
  } catch (e) {
    if (isProviderError(e) && e.code === "auth_invalid") throw e
    if (await isGmvMaxDeleted(tt, hit.type, id)) {
      return {
        preview: false,
        changes,
        warnings: [...warnings, gmvMaxDeletedDespiteError(id)],
      }
    }
    throw e
  }
  const done = res.data?.campaign_ids
  if (Array.isArray(done) && done.length && !done.map(String).includes(id)) {
    throw new ProviderError({
      platform: "tiktok",
      code: "upstream_error",
      message: `TikTok did not delete GMV Max campaign ${id}`,
      userMessageVi: `TikTok không xoá được chiến dịch GMV Max ${id}.`,
      retryable: false,
    })
  }
  return { preview: false, changes, warnings }
}

/** /gmv_max/campaign/get/ with primary_status STATUS_DELETE lists the campaign (best effort: false on failure). */
async function isGmvMaxDeleted(
  tt: TT,
  type: GmvMaxType,
  id: string
): Promise<boolean> {
  try {
    const { list } = await listGmvMaxCampaignsRaw(
      tt,
      type,
      { campaign_ids: [id], primary_status: "STATUS_DELETE" },
      1
    )
    return list.some((r) => String(r.campaign_id ?? "") === id)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Create (tiktok_gmv_max_create) and copy (ads_copy_object) - shared core
// ---------------------------------------------------------------------------

export interface GmvMaxCreatePlan {
  type: GmvMaxType
  storeId: string
  name: string
  /** daily budget, major units */
  budget: number
  roasBid: number
  /** PRODUCT: "all" or SPU ids */
  products: "all" | string[] | null
  /** PRODUCT AUTO_SELECTION: video sources (0-20); LIVE: the one LIVE source */
  identityIds: string[]
  /** PRODUCT */
  videoMode: "AUTO_SELECTION" | "CUSTOM_SELECTION"
  /** CUSTOM_SELECTION posts (copy only, already in the request shape) */
  itemList?: Raw[]
  affiliatePosts?: boolean
  start: Date
  end: Date | null
}

interface PreparedCreate {
  /** request body without request_id */
  body: Raw
  warnings: string[]
  /** worst-case daily spend approved by the guards (a new campaign: its daily budget) */
  maxDaily: number
  /** execution: request_id sent to TikTok (64-bit int string from the idempotency key) */
  requestId: string | null
  /** execution: S5 ledger reservation keyed startedRequestKey(requestId) - settled / released by the caller */
  reservation: StartedSpendReservation | null
}

/** Shop of the ad account from /gmv_max/store/list/ (must be GMV-Max-ready for THIS advertiser). */
async function readyShop(tt: TT, storeId: string): Promise<{ bcId: string }> {
  // several rows per store (owner / partner BCs): the row usable by THIS ad account (A10)
  const raw = pickGmvMaxStoreRow(
    await fetchGmvMaxStoresRaw(tt, tt.advertiserId),
    storeId,
    tt.advertiserId
  )
  if (!raw) {
    throw invalid(
      `Không thấy cửa hàng ${storeId} trong danh sách cửa hàng GMV Max của tài khoản QC này.`,
      "Xem cửa hàng bằng tiktok_gmv_max_shops."
    )
  }
  const shop = mapGmvMaxShop(raw, tt.advertiserId)
  if (!shop.ready) {
    throw invalid(
      `Cửa hàng ${storeId} chưa sẵn sàng GMV Max cho tài khoản QC này. ${shop.issues.join(" ")}`.trim(),
      "Xem chi tiết bằng tiktok_gmv_max_shops; cấp quyền GMV Max cho tài khoản QC trong Business Center / Seller Center."
    )
  }
  const bcId = str(raw.store_authorized_bc_id) ?? shop.business_center.bc_id
  if (!bcId)
    throw invalid(
      `TikTok không trả Business Center của cửa hàng ${storeId} (store_authorized_bc_id) nên chưa thực hiện được.`
    )
  return { bcId }
}

/** Enabled GMV Max campaigns of a shop (best effort: [] when the call fails). */
async function enabledCampaignIds(
  tt: TT,
  type: GmvMaxType,
  storeId: string,
  exclude?: string
): Promise<string[]> {
  try {
    const { list } = await listGmvMaxCampaignsRaw(
      tt,
      type,
      { store_ids: [storeId], primary_status: "STATUS_DELIVERY_OK" },
      20
    )
    return list
      .map((r) => String(r.campaign_id ?? ""))
      .filter((id) => id && id !== exclude)
  } catch {
    return []
  }
}

/** Enabled Product GMV Max campaigns of the shop that use one of `productIds` (best effort, ≤10 info calls). */
async function campaignsUsingProducts(
  tt: TT,
  storeId: string,
  productIds: string[],
  exclude?: string
): Promise<string[]> {
  const out: string[] = []
  for (const id of (
    await enabledCampaignIds(tt, "PRODUCT", storeId, exclude)
  ).slice(0, MAX_CONFLICT_INFO)) {
    try {
      const info = await fetchGmvMaxInfo(tt, id)
      const items = idList(info.item_group_ids)
      if (
        info.product_specific_type === "ALL" ||
        items.some((p) => productIds.includes(p))
      )
        out.push(id)
    } catch {
      // best effort
    }
  }
  return out
}

/** /store/product/get/ rows of `ids` with GMV Max eligibility (item_group_ids filter ≤10 per call). */
export async function fetchStoreProducts(
  tt: TT,
  storeId: string,
  bcId: string,
  ids: string[]
): Promise<Map<string, Raw>> {
  const out = new Map<string, Raw>()
  for (const batch of chunk([...new Set(ids)], 10)) {
    const res = await ttGet<{ store_products?: Raw[] }>(
      tt,
      "store/product/get",
      {
        bc_id: bcId,
        store_id: storeId,
        advertiser_id: tt.advertiserId,
        filtering: { item_group_ids: batch, ad_creation_eligible: "GMV_MAX" },
        page: 1,
        page_size: 100,
      }
    )
    for (const p of Array.isArray(res.data.store_products)
      ? res.data.store_products
      : []) {
      const id = str(p.item_group_id)
      if (id && batch.includes(id)) out.set(id, p)
    }
  }
  return out
}

/**
 * Products to promote (create / copy / update add): each must exist, be AVAILABLE and UNOCCUPIED (each product can be in
 * only ONE enabled Product GMV Max campaign - guide 1822009220448257 step 1.ii). Occupied → refused naming the
 * campaign(s) when found. Products running VSA/PSA → warning (they will be paused in every ad account).
 */
async function checkProducts(
  tt: TT,
  storeId: string,
  bcId: string,
  ids: string[],
  warnings: string[],
  exclude?: string
): Promise<void> {
  if (!ids.length) return
  const rows = await fetchStoreProducts(tt, storeId, bcId, ids)
  const missing = ids.filter((id) => !rows.has(id))
  if (missing.length) {
    throw invalid(
      `Không tìm thấy sản phẩm ${missing.join(", ")} trong cửa hàng ${storeId}.`,
      "Lấy item_group_id bằng tiktok_gmv_max_products."
    )
  }
  const unavailable = ids.filter((id) => rows.get(id)!.status !== "AVAILABLE")
  if (unavailable.length) {
    throw invalid(
      `Sản phẩm ${unavailable.join(", ")} không dùng được cho quảng cáo (status khác AVAILABLE).`,
      "Chọn sản phẩm khác bằng tiktok_gmv_max_products."
    )
  }
  const occupied = ids.filter(
    (id) => rows.get(id)!.gmv_max_ads_status !== "UNOCCUPIED"
  )
  if (occupied.length) {
    const by = await campaignsUsingProducts(tt, storeId, occupied, exclude)
    throw conflict(
      `Sản phẩm ${occupied.join(", ")} đang nằm trong chiến dịch Product GMV Max đang bật${by.length ? ` (${by.join(", ")})` : " khác"} - mỗi sản phẩm chỉ được ở 1 chiến dịch Product GMV Max đang bật.`
    )
  }
  const running = ids.filter(
    (id) => rows.get(id)!.is_running_custom_shop_ads === true
  )
  if (running.length) {
    warnings.push(
      `Sản phẩm ${running.join(", ")} đang chạy quảng cáo Video/Product Shopping (VSA/PSA) - chiến dịch GMV Max sẽ tự tạm dừng các quảng cáo đó ở MỌI tài khoản QC; TikTok không tự bật lại.`
    )
  }
}

/** identity_list entry in the request shape (doc 1822000988713089: conditional bc / shop / store ids). */
function identityPayload(o: Raw): Raw {
  const out: Raw = {
    identity_id: String(o.identity_id),
    identity_type: str(o.identity_type),
  }
  if (o.identity_type === "BC_AUTH_TT") {
    if (str(o.identity_authorized_bc_id))
      out.identity_authorized_bc_id = str(o.identity_authorized_bc_id)
    if (str(o.identity_authorized_shop_id))
      out.identity_authorized_shop_id = str(o.identity_authorized_shop_id)
  }
  if (o.identity_type === "TTS_TT" && str(o.store_id))
    out.store_id = str(o.store_id)
  return out
}

/** Identities (video sources / LIVE source) must be available for this GMV Max type (/gmv_max/identity/get/). */
async function checkIdentities(
  tt: TT,
  type: GmvMaxType,
  storeId: string,
  bcId: string,
  ids: string[],
  warnings: string[],
  exclude?: string
): Promise<Raw[]> {
  if (!ids.length) return []
  const res = await ttGet<{ identity_list?: Raw[] }>(
    tt,
    "gmv_max/identity/get",
    {
      advertiser_id: tt.advertiserId,
      store_id: storeId,
      store_authorized_bc_id: bcId,
    }
  )
  const list = Array.isArray(res.data.identity_list)
    ? res.data.identity_list
    : []
  const out: Raw[] = []
  for (const id of ids) {
    const o = list.find((x) => String(x.identity_id ?? "") === id)
    if (!o) {
      throw invalid(
        `Tài khoản TikTok (identity) ${id} không thuộc cửa hàng ${storeId} hoặc chưa được cấp cho GMV Max.`,
        "Xem danh sách bằng tiktok_gmv_max_identities."
      )
    }
    if (type === "PRODUCT" && o.product_gmv_max_available !== true) {
      throw invalid(
        `Tài khoản TikTok ${id} chưa dùng được cho Product GMV Max.`,
        "Chọn tài khoản có product_gmv_max_available=true (tiktok_gmv_max_identities)."
      )
    }
    if (type === "LIVE") {
      if (o.live_gmv_max_available !== true) {
        if (o.unavailable_reason === "OCCUPIED") {
          if (o.is_running_custom_shop_ads === true) {
            throw conflict(
              `Tài khoản TikTok ${id} đang được dùng trong quảng cáo LIVE Shopping đang bật - tạm dừng nhóm quảng cáo đó trước khi tạo LIVE GMV Max.`,
              "Tìm quảng cáo đang dùng trong TikTok Ads Manager (hoặc /gmv_max/occupied_custom_shop_ads/list/), tạm dừng rồi thử lại."
            )
          }
          const by = await enabledCampaignIds(tt, "LIVE", storeId, exclude)
          throw conflict(
            `Tài khoản TikTok ${id} đang được dùng trong chiến dịch LIVE GMV Max đang bật${by.length ? ` (${by.join(", ")})` : ""} - mỗi tài khoản TikTok chỉ ở 1 chiến dịch LIVE GMV Max đang bật.`
          )
        }
        throw invalid(
          `Tài khoản TikTok ${id} chưa được cấp quyền cho LIVE GMV Max.`,
          "Xem tiktok_gmv_max_identities (unavailable_reason)."
        )
      }
      if (o.is_running_custom_shop_ads === true) {
        warnings.push(
          `Tài khoản TikTok ${id} đang chạy quảng cáo LIVE Shopping - chiến dịch LIVE GMV Max có thể tự tạm dừng các quảng cáo đó ở MỌI tài khoản QC.`
        )
      }
    }
    out.push(identityPayload(o))
  }
  return out
}

/**
 * Pre-checks + request body of a GMV Max create (C6). Order: shop ready for THIS advertiser → products / shop usage →
 * identities → schedule → strict daily-cap guard (the campaign spends from its start). Throws on any failure.
 */
async function prepareGmvMaxCreate(
  tt: TT,
  plan: GmvMaxCreatePlan,
  opts: MutationOptions,
  now: Date,
  exclude?: string
): Promise<PreparedCreate> {
  const warnings = [GMV_MAX_RUNS_NOW_WARNING]
  const { bcId } = await readyShop(tt, plan.storeId)
  const body: Raw = {
    advertiser_id: tt.advertiserId,
    store_id: plan.storeId,
    store_authorized_bc_id: bcId,
    shopping_ads_type: plan.type,
  }
  if (plan.type === "PRODUCT") {
    if (plan.products === "all") {
      const usage = (
        await ttGet<Raw>(tt, "gmv_max/store/shop_ad_usage_check", {
          advertiser_id: tt.advertiserId,
          store_id: plan.storeId,
        })
      ).data
      if (usage.promote_all_products_allowed !== true) {
        const by = await enabledCampaignIds(
          tt,
          "PRODUCT",
          plan.storeId,
          exclude
        )
        throw conflict(
          `Cửa hàng ${plan.storeId} không tạo được chiến dịch Product GMV Max "tất cả sản phẩm"${by.length ? `: đang có chiến dịch Product GMV Max bật (${by.join(", ")})` : " (TikTok báo promote_all_products_allowed = false)"}.`
        )
      }
      if (usage.is_running_custom_shop_ads === true) {
        warnings.push(
          'Cửa hàng đang có quảng cáo Video/Product Shopping (VSA/PSA) đang bật - chiến dịch GMV Max "tất cả sản phẩm" sẽ tự tạm dừng các quảng cáo đó ở MỌI tài khoản QC; TikTok không tự bật lại.'
        )
      }
      body.product_specific_type = "ALL"
    } else {
      const ids = [...new Set(plan.products ?? [])]
      if (!ids.length)
        throw invalid(
          'Cần chọn sản phẩm: products = "all" hoặc danh sách item_group_id.'
        )
      if (ids.length > GMV_MAX_ITEM_GROUPS_MAX)
        throw invalid(
          `Tối đa ${GMV_MAX_ITEM_GROUPS_MAX} sản phẩm mỗi chiến dịch.`
        )
      await checkProducts(tt, plan.storeId, bcId, ids, warnings, exclude)
      body.product_specific_type = "CUSTOMIZED_PRODUCTS"
      body.item_group_ids = ids
    }
    body.product_video_specific_type = plan.videoMode
  }
  const identityIds = [...new Set(plan.identityIds)]
  if (plan.type === "LIVE" && identityIds.length !== 1)
    throw invalid(
      "LIVE GMV Max cần đúng 1 tài khoản TikTok làm nguồn LIVE (identity_ids)."
    )
  if (plan.type === "PRODUCT" && identityIds.length > GMV_MAX_IDENTITIES_MAX)
    throw invalid(
      `Tối đa ${GMV_MAX_IDENTITIES_MAX} tài khoản TikTok làm nguồn video.`
    )
  const identities = await checkIdentities(
    tt,
    plan.type,
    plan.storeId,
    bcId,
    identityIds,
    warnings,
    exclude
  )
  if (
    plan.type === "LIVE" ||
    (plan.videoMode === "AUTO_SELECTION" && identities.length)
  )
    body.identity_list = identities
  if (
    plan.type === "PRODUCT" &&
    plan.videoMode === "AUTO_SELECTION" &&
    !identities.length
  ) {
    warnings.push(
      "Không chọn tài khoản TikTok nguồn video: TikTok dùng ảnh sản phẩm làm quảng cáo (và bài đăng affiliate nếu bật)."
    )
  }
  if (plan.type === "PRODUCT" && plan.videoMode === "CUSTOM_SELECTION") {
    if (!plan.itemList?.length)
      throw invalid(
        "Chiến dịch chọn video thủ công cần danh sách bài đăng (item_list)."
      )
    if (plan.itemList.length > GMV_MAX_ITEM_LIST_MAX)
      throw invalid(
        `Chiến dịch chọn video thủ công có ${plan.itemList.length} bài đăng - TikTok chỉ nhận tối đa ${GMV_MAX_ITEM_LIST_MAX} bài đăng (item_list) khi tạo.`,
        "Sao chép trong TikTok Ads Manager, hoặc tạo mới bằng tiktok_gmv_max_create (tự chọn video)."
      )
    body.item_list = plan.itemList
  }
  if (
    plan.type === "PRODUCT" &&
    plan.videoMode === "AUTO_SELECTION" &&
    plan.affiliatePosts !== undefined
  ) {
    body.affiliate_posts_enabled = plan.affiliatePosts
  }
  body.optimization_goal = "VALUE"
  body.deep_bid_type = "VO_MIN_ROAS"
  body.roas_bid = roasValue(plan.roasBid)
  body.budget = apiMoney(plan.budget, tt.currency)
  // schedule (UTC+0): start ≥ now - 12 h per doc; we never backdate more than a few minutes, ≤ 2028-01-01
  const start = plan.start.getTime() < now.getTime() ? now : plan.start
  if (plan.start.getTime() < now.getTime() - 10 * 60_000)
    throw invalid("Thời gian bắt đầu không được ở quá khứ.")
  if (start.getTime() >= START_LIMIT)
    throw invalid(
      "Thời gian bắt đầu phải trước 2028-01-01 (giới hạn của TikTok)."
    )
  body.schedule_start_time = formatTikTokTime(start)
  if (plan.end) {
    if (plan.end.getTime() <= start.getTime() + 60 * 60_000)
      throw invalid(
        "Thời gian kết thúc phải sau thời gian bắt đầu ít nhất 1 giờ."
      )
    if (plan.end.getTime() > END_LIMIT)
      throw invalid("Thời gian kết thúc không được sau 2038-01-01.")
    body.schedule_type = "SCHEDULE_START_END"
    body.schedule_end_time = formatTikTokTime(plan.end)
  } else {
    body.schedule_type = "SCHEDULE_FROM_NOW"
  }
  if (start.getTime() > now.getTime() + 5 * 60_000) {
    warnings.push(
      `Chiến dịch được tạo ngay nhưng chỉ bắt đầu phân phối từ ${accountLocal(start, tt.timezone)} (giờ tài khoản ${tt.timezone}).`
    )
  }
  const name = plan.name.trim()
  if (!name || name.length > GMV_MAX_NAME_MAX)
    throw invalid(`Tên chiến dịch phải có 1-${GMV_MAX_NAME_MAX} ký tự.`)
  body.campaign_name = name
  // a new GMV Max campaign starts with promotion days / auto budget OFF (doc defaults) → worst case = daily budget
  const maxDaily = body.budget as number
  spendGuard(opts)([
    {
      label:
        "Ngân sách ngày của chiến dịch GMV Max mới (chạy ngay sau khi tạo)",
      amount: maxDaily,
      currency: tt.currency,
    },
  ])
  // S5: together with the GMV Max campaigns this MCP made start running on this ad account in the last 24 h; on
  // execution the new campaign is reserved under its request key (M1) until its id is known
  const requestId = opts.dryRun
    ? null
    : makeRequestId(opts.idempotencyKey, "gmv_max_create")
  const cap = await assertStartedWithinCap(tt, opts, [
    {
      id: null,
      amount: maxDaily,
      ...(requestId ? { key: startedRequestKey(requestId) } : {}),
    },
  ])
  warnings.push(...cap.notes)
  return { body, warnings, maxDaily, requestId, reservation: cap.reservation }
}

/** Date → "YYYY-MM-DD HH:MM" in the account time zone. */
function accountLocal(d: Date, timezone: string): string {
  return new Date(d.getTime() + tzOffsetMs(timezone, d))
    .toISOString()
    .slice(0, 16)
    .replace("T", " ")
}

/** "YYYY-MM-DD HH:MM[:SS]" in the account time zone, or ISO 8601 with offset → Date (null when invalid). */
export function parseAccountTime(s: string, timezone: string): Date | null {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
    s.trim()
  )
  if (m) {
    const asUtc = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4] ?? "00"}Z`)
    if (!Number.isFinite(asUtc)) return null
    // wall-clock in the account tz → instant (re-evaluated once for DST changes)
    let t = asUtc - tzOffsetMs(timezone, new Date(asUtc))
    t = asUtc - tzOffsetMs(timezone, new Date(t))
    return new Date(t)
  }
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(s.trim())) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

function uncertainGmvCreate(
  e: unknown,
  name: string,
  detail: string,
  /** L1: the started change of the campaign that may be running (logged with STARTED_SPEND_UNCERTAIN_LOG_CODE) */
  started?: FieldChange
): ProviderError {
  const pe = isProviderError(e) ? e : null
  return new ProviderError({
    ...(started
      ? {
          audit: {
            errorCode: STARTED_SPEND_UNCERTAIN_LOG_CODE,
            changes: [started],
          },
        }
      : {}),
    platform: "tiktok",
    code: pe?.code ?? "upstream_error",
    message: `TikTok GMV Max create outcome unknown: ${pe?.message ?? String(e)}`,
    userMessageVi: `TikTok không phản hồi rõ khi tạo chiến dịch GMV Max (${pe ? gmvMaxErrorText(pe) : "lỗi mạng"}). ${detail}`,
    retryable: false,
    hint: `Có thể chiến dịch GMV Max "${name.slice(0, 80)}" đã được tạo và ĐANG CHẠY - kiểm tra bằng tiktok_gmv_max_campaigns (hoặc TikTok Ads Manager) trước khi thử lại để tránh tạo trùng.`,
    upstream: pe?.upstream,
    cause: e,
  })
}

/**
 * S7: GMV Max campaigns of THIS shop named exactly `name` and created at/after `sinceMs` (= the moment the create
 * was sent minus a small clock skew), newest first. Anything older is NOT ours (no id is reported for it).
 */
async function findCreatedGmvMax(
  tt: TT,
  plan: GmvMaxCreatePlan,
  name: string,
  sinceMs: number
): Promise<string[]> {
  const { list } = await listGmvMaxCampaignsRaw(
    tt,
    plan.type,
    {
      store_ids: [plan.storeId],
      campaign_name: name,
      creation_filter_start_time: formatTikTokTime(new Date(sinceMs)),
    },
    50
  )
  return list
    .map((o) => ({
      id: str(o.campaign_id),
      name: str(o.campaign_name),
      store: str(o.store_id),
      t: parseTikTokTime(o.create_time)?.getTime() ?? null,
    }))
    .filter(
      (
        o
      ): o is {
        id: string
        name: string | null
        store: string | null
        t: number
      } =>
        !!o.id &&
        o.name === name &&
        o.t !== null &&
        o.t >= sinceMs &&
        (o.store === null || o.store === plan.storeId)
    )
    .sort((a, b) => b.t - a.t)
    .map((o) => o.id)
}

/**
 * POST /campaign/gmv_max/create/ with request_id (deterministic from the MCP idempotency key) and the create retry
 * policy (only throttles inside the 10 s dedup window). NO blind retry: after an uncertain failure (timeout / 5xx /
 * network / 40050) the campaign is looked up by name + creation time; found → its id + warning; else a
 * non-retryable error telling the user to check first.
 */
async function executeGmvMaxCreate(
  tt: TT,
  prepared: PreparedCreate,
  plan: GmvMaxCreatePlan,
  opts: MutationOptions,
  warnings: string[]
): Promise<string> {
  const name = String(prepared.body.campaign_name)
  const requestId =
    prepared.requestId ?? makeRequestId(opts.idempotencyKey, "gmv_max_create")
  const body = { request_id: requestId, ...prepared.body }
  const reservation = prepared.reservation
  const key = startedRequestKey(requestId)
  // L1: the campaign may be running although the outcome is unknown → its reservation stays (24 h) and the error row
  // carries this started change (object_id = the request key) so the cumulative cap keeps counting it
  const uncertainStarted = startedChange(key, name, prepared.maxDaily)
  const started = Date.now()
  let failure: unknown
  try {
    const res = await ttPost<Raw>(tt, "campaign/gmv_max/create", body, {
      create: true,
    })
    const id = str(res.data?.campaign_id)
    if (id) return id
    failure = new ProviderError({
      platform: "tiktok",
      code: "upstream_error",
      message: "GMV Max create answered without campaign_id",
      userMessageVi: "TikTok không trả campaign_id",
    })
  } catch (e) {
    if (!isUncertainCreateError(e)) {
      // definite rejection: nothing was created → the S5 reservation is released
      reservation?.release()
      throw e
    }
    failure = e
  }
  let found: string[]
  try {
    found = await findCreatedGmvMax(
      tt,
      plan,
      name,
      started - CREATE_LOOKUP_SKEW_MS
    )
  } catch {
    throw uncertainGmvCreate(
      failure,
      name,
      "Không kiểm tra lại được danh sách chiến dịch GMV Max.",
      uncertainStarted
    )
  }
  if (!found.length)
    throw uncertainGmvCreate(
      failure,
      name,
      "Chưa thấy chiến dịch GMV Max mới cùng tên (TikTok có thể hiển thị trễ).",
      uncertainStarted
    )
  warnings.push(
    found.length === 1
      ? `TikTok phản hồi lỗi/timeout nhưng chiến dịch GMV Max đã được tạo (id ${found[0]}) - dùng id tìm thấy, không tạo lại.`
      : `TikTok phản hồi lỗi/timeout; tìm thấy ${found.length} chiến dịch GMV Max mới cùng tên (id ${found.join(", ")}) - dùng id mới nhất ${found[0]}; kiểm tra và xoá bản thừa (ĐANG CHẠY) ngay.`
  )
  return found[0]!
}

function createSummary(
  plan: GmvMaxCreatePlan,
  body: Raw,
  currency: string
): string {
  const products =
    plan.type === "LIVE"
      ? "LIVE"
      : body.product_specific_type === "ALL"
        ? "tất cả sản phẩm"
        : `${(body.item_group_ids as string[]).length} sản phẩm`
  return `GMV Max ${plan.type} (${products}), ngân sách ngày ${fmt(body.budget as number, currency)}, ROI mục tiêu ${body.roas_bid}, CHẠY NGAY`
}

/** ads_copy_object on a GMV Max campaign (C6): /campaign/gmv_max/info/ → create with the same settings. null = not GMV Max. */
export async function routeGmvMaxCopy(
  tt: TT,
  r: CopyRequest,
  found: Raw | null,
  opts: MutationOptions & { now?: Date }
): Promise<CopyResult | null> {
  if (r.level !== "campaign") return null
  const hit = await gmvMaxHitFor(tt, r.id, found, true)
  if (!hit) return null
  assertGmvMaxWrite(opts, [r.id])
  // S1: never copy a deleted GMV Max campaign (the copy would start RUNNING)
  if (isDeleted(hit.row)) throw invalid(gmvMaxCopyDeletedMessage(r.id))
  const now = opts.now ?? new Date()
  const info = await fetchGmvMaxInfo(tt, r.id)
  // A5: campaign-level customized posts cannot be carried over (exclusive to the source; feature being deprecated)
  if (
    str(info.campaign_custom_anchor_video_id) ||
    (Array.isArray(info.custom_anchor_video_list) &&
      info.custom_anchor_video_list.length > 0)
  ) {
    throw invalid(gmvMaxCopyCustomPostsMessage(r.id))
  }
  const type: GmvMaxType =
    info.shopping_ads_type === "LIVE"
      ? "LIVE"
      : info.shopping_ads_type === "PRODUCT"
        ? "PRODUCT"
        : hit.type
  if (
    type === "PRODUCT" &&
    info.product_specific_type !== "CUSTOMIZED_PRODUCTS"
  ) {
    throw conflict(
      gmvMaxCopyAllProductsMessage(r.id),
      "Dùng tiktok_gmv_max_create với sản phẩm khác (xem tiktok_gmv_max_products)."
    )
  }
  const storeId = str(info.store_id)
  const budget = moneyOf(info.budget, tt.currency)
  const roas = num(info.roas_bid)
  if (
    !storeId ||
    budget === null ||
    !(budget > 0) ||
    roas === null ||
    !(roas > 0)
  ) {
    throw invalid(
      `Không đọc đủ cài đặt của chiến dịch GMV Max ${r.id} (cửa hàng / ngân sách / ROI) để sao chép.`
    )
  }
  const warnings: string[] = [GMV_MAX_COPY_NOT_COPIED_NOTE]
  // A5: TikTok keeps ROI targets to one decimal - never round silently
  if (roasValue(roas) !== roas)
    warnings.push(gmvMaxRoasRoundedWarning(roas, roasValue(roas)))
  if (r.deep)
    warnings.push(
      "GMV Max không có nhóm quảng cáo / quảng cáo - deep không áp dụng."
    )
  const src = str(hit.row.campaign_name) ?? r.id
  const suffix = r.nameSuffix ?? " - bản sao"
  const prefix = r.namePrefix ?? ""
  const room = Math.max(1, GMV_MAX_NAME_MAX - prefix.length - suffix.length)
  const videoMode =
    info.product_video_specific_type === "CUSTOM_SELECTION"
      ? "CUSTOM_SELECTION"
      : "AUTO_SELECTION"
  const identities = Array.isArray(info.identity_list)
    ? (info.identity_list as Raw[])
    : []
  const endSrc =
    info.schedule_type === "SCHEDULE_START_END"
      ? parseTikTokTime(info.schedule_end_time)
      : null
  const end =
    endSrc && endSrc.getTime() > now.getTime() + 2 * 60 * 60_000 ? endSrc : null
  if (endSrc && !end)
    warnings.push(
      "Ngày kết thúc của chiến dịch gốc đã qua (hoặc quá gần) - bản sao chạy không có ngày kết thúc."
    )
  const itemList =
    type === "PRODUCT" &&
    videoMode === "CUSTOM_SELECTION" &&
    Array.isArray(info.item_list)
      ? (info.item_list as Raw[]).map((it) => ({
          item_id: str(it.item_id),
          spu_id_list: idList(it.spu_id_list),
          identity_info: identityPayload(objectOf(it.identity_info)),
          video_info: { video_id: str(objectOf(it.video_info).video_id) },
        }))
      : undefined
  const plan: GmvMaxCreatePlan = {
    type,
    storeId,
    name: `${prefix}${src.slice(0, room)}${suffix}`,
    budget,
    roasBid: roasValue(roas),
    products: type === "PRODUCT" ? idList(info.item_group_ids) : null,
    identityIds:
      type === "LIVE" || videoMode === "AUTO_SELECTION"
        ? identities.map((i) => String(i.identity_id ?? "")).filter(Boolean)
        : [],
    videoMode,
    itemList,
    affiliatePosts:
      typeof info.affiliate_posts_enabled === "boolean"
        ? info.affiliate_posts_enabled
        : undefined,
    start: now,
    end,
  }
  // the source campaign itself (when enabled) occupies its products / LIVE identity → refused here (C6)
  const prepared = await prepareGmvMaxCreate(tt, plan, opts, now)
  warnings.unshift(...prepared.warnings)
  if (opts.dryRun) {
    warnings.push(
      `Bản sao: ${createSummary(plan, prepared.body, tt.currency)}.`
    )
    return {
      preview: true,
      mode: "emulated",
      rootNewId: null,
      mappings: [{ level: "campaign", sourceId: r.id, newId: null }],
      warnings,
      newStatus: "active",
    }
  }
  const newId = await executeGmvMaxCreate(tt, prepared, plan, opts, warnings)
  // A2: read back the new campaign; S5: its worst-case daily spend is recorded for the cumulative cap
  const recorded = await verifyCreated(tt, newId, prepared, warnings)
  settleCreated(prepared, newId, recorded)
  return {
    preview: false,
    mode: "emulated",
    rootNewId: newId,
    mappings: [{ level: "campaign", sourceId: r.id, newId }],
    warnings,
    newStatus: "active",
    extraChanges: [startedChange(newId, plan.name, recorded)],
  }
}

/** S5: the request-keyed reservation of a create now belongs to the new campaign id (amount = recorded worst case). */
function settleCreated(
  prepared: PreparedCreate,
  newId: string,
  recorded: number
): void {
  if (prepared.reservation && prepared.requestId)
    prepared.reservation.settle(startedRequestKey(prepared.requestId), {
      objectId: newId,
      amount: recorded,
    })
}

/**
 * A2 after a create / copy: compare the new campaign with the request (budget, ROI, products, ENABLE). An overspend
 * read-back becomes the FIRST warning (the campaign exists and runs). Returns the worst-case daily spend to record
 * (the larger of the approved one and the read-back).
 */
async function verifyCreated(
  tt: TT,
  id: string,
  prepared: PreparedCreate,
  warnings: string[]
): Promise<number> {
  const out = { worst: null as number | null }
  const body = prepared.body
  const found = await verifyGmvMaxWrite(
    tt,
    id,
    {
      budget: body.budget as number,
      roas_bid: body.roas_bid as number,
      ...(Array.isArray(body.item_group_ids)
        ? { item_group_ids: body.item_group_ids as string[] }
        : {}),
    },
    prepared.maxDaily,
    "warn",
    out
  )
  warnings.unshift(...found)
  return Math.max(prepared.maxDaily, out.worst ?? 0)
}

// ---------------------------------------------------------------------------
// ROI history warnings (C7)
// ---------------------------------------------------------------------------

function daysBetween(a: string, b: string): number {
  return Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000
  )
}

/**
 * Warnings for an ROI target change, from OUR history (successful roas_bid changes through any MCP of this app):
 * Product changed < 3 full days ago → strong warning; LIVE changed today (account tz) → strong warning; manual raise /
 * second lowering today → loses today's ROI protection. Warn, never block (owner decision).
 */
export async function gmvMaxRoiWarnings(
  tt: TT,
  id: string,
  type: GmvMaxType,
  before: number | null,
  after: number,
  opts: MutationOptions,
  now: Date
): Promise<string[]> {
  const out: string[] = []
  let history: { at: Date; before: unknown; after: unknown }[] = []
  try {
    history = opts.fieldHistory
      ? await opts.fieldHistory({
          objectId: id,
          field: "roas_bid",
          sinceHours: ROI_HISTORY_HOURS,
        })
      : []
  } catch {
    history = []
  }
  const today = todayInTz(tt.timezone, now)
  const dayOf = (d: Date) => todayInTz(tt.timezone, d)
  const todays = history.filter((h) => dayOf(h.at) === today)
  if (type === "PRODUCT" && history.length) {
    const lastDay = dayOf(history[0]!.at)
    const fullDays = Math.max(0, daysBetween(lastDay, today) - 1)
    if (fullDays < 3) out.push(gmvMaxRoiRecentWarning(id, lastDay, fullDays))
  }
  if (type === "LIVE" && todays.length)
    out.push(gmvMaxRoiLiveTodayWarning(id, todays.length))
  if (before !== null && after > before) out.push(GMV_MAX_ROI_RAISE_WARNING)
  if (
    before !== null &&
    after < before &&
    todays.some((h) => {
      const b = num(h.before)
      const a = num(h.after)
      return a !== null && b !== null && a < b
    })
  ) {
    out.push(GMV_MAX_ROI_SECOND_LOWER_WARNING)
  }
  out.push(GMV_MAX_ROI_PROTECTION_NOTE, GMV_MAX_ROI_HISTORY_SCOPE)
  return out
}

// ---------------------------------------------------------------------------
// MCP tools (registered through tiktokExtensions)
// ---------------------------------------------------------------------------

export type GmvWriteResult = MutationResult & { payload?: Raw }

const boostInput = {
  budget_increase_percentage: z
    .number()
    .int()
    .min(50)
    .max(300)
    .optional()
    .describe("% tăng mỗi lần (50-300)"),
  increase_limit: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe("số lần tăng tối đa mỗi ngày (1-10)"),
}

export const gmvMaxUpdateInput = z
  .object({
    campaign_id: numericId.describe(
      "Id chiến dịch GMV Max (tiktok_gmv_max_campaigns)"
    ),
    roas_bid: roasBidSchema
      .optional()
      .describe("ROI mục tiêu mới (tối đa 1 chữ số thập phân)"),
    auto_budget: z
      .object({ enabled: z.boolean(), ...boostInput })
      .optional()
      .describe("Tăng ngân sách tự động ngày thường"),
    promotion_days: z
      .object({
        enabled: z.boolean(),
        use_tiktok_shop_schedule: z
          .boolean()
          .optional()
          .describe("Dùng lịch ngày khuyến mãi của TikTok Shop"),
        custom_schedule: z
          .array(z.object({ start_date: isoDate, end_date: isoDate }))
          .max(50)
          .optional()
          .describe(
            "Ngày khuyến mãi tự chọn - THAY THẾ toàn bộ danh sách hiện tại (giờ tài khoản; start_date < end_date, không ở quá khứ, không trước ngày bắt đầu chiến dịch). Có custom_schedule mà không truyền use_tiktok_shop_schedule → chỉ dùng các ngày tự chọn"
          ),
        roi_reduction_pct: z
          .union([z.literal(10), z.literal(20), z.literal(30)])
          .optional()
          .describe("Hạ ROI mục tiêu trong ngày khuyến mãi (%)"),
        ...boostInput,
      })
      .optional(),
    item_group_ids: z
      .array(numericId)
      .min(1)
      .max(GMV_MAX_ITEM_GROUPS_MAX)
      .optional()
      .describe(
        "Danh sách sản phẩm (SPU) MỚI ĐẦY ĐỦ - thay thế danh sách hiện tại (chỉ chiến dịch Product chọn sản phẩm cụ thể)"
      ),
  })
  .refine(
    (v) =>
      v.roas_bid !== undefined ||
      v.auto_budget !== undefined ||
      v.promotion_days !== undefined ||
      v.item_group_ids !== undefined,
    {
      error:
        "Cần ít nhất một trong: roas_bid, auto_budget, promotion_days, item_group_ids.",
    }
  )
export type GmvMaxUpdateInput = z.infer<typeof gmvMaxUpdateInput>

function describeBoost(
  b: unknown,
  enabledKey: "auto_budget_enabled" | "is_enabled",
  /** A11: the legacy root auto_budget_enabled flag (budget × 10) is on */
  legacy = false
): string {
  const o = objectOf(b)
  const legacyNote = legacy
    ? " (+ tăng ngân sách tự động kiểu cũ đang bật, tới 10 lần)"
    : ""
  if (o[enabledKey] !== true) return `tắt${legacyNote}`
  const pct = num(o.budget_increase_percentage)
  const limit = num(o.increase_limit)
  return `bật${pct !== null ? ` +${pct}%` : ""}${limit !== null ? ` × tối đa ${limit} lần/ngày` : ""}${legacyNote}`
}

/** Integer in the documented range, else null. */
function boostValue(v: unknown, min: number, max: number): number | null {
  const n = num(v)
  return n !== null && Number.isInteger(n) && n >= min && n <= max ? n : null
}

/** "YYYY-MM-DD" prefix of a TikTok date / time string (info custom_schedule_list start_time / end_time). */
function dateOnly(v: unknown): string | null {
  const s = str(v)
  const m = s ? /^(\d{4}-\d{2}-\d{2})/.exec(s) : null
  return m ? m[1]! : null
}

const PROMO_MULTIPLIERS = new Set([90, 80, 70])

/** % and limit to SEND for a boost: input → current (valid range) → documented defaults (50 / 10). */
function boostLevels(
  current: Raw,
  input: { budget_increase_percentage?: number; increase_limit?: number }
): { pct: number; limit: number; defaulted: boolean } {
  const curPct = boostValue(current.budget_increase_percentage, 50, 300)
  const curLimit = boostValue(current.increase_limit, 1, 10)
  const pct = input.budget_increase_percentage ?? curPct
  const limit = input.increase_limit ?? curLimit
  return {
    pct: pct ?? GMV_MAX_BOOST_DEFAULT_PCT,
    limit: limit ?? GMV_MAX_BOOST_DEFAULT_LIMIT,
    defaulted: pct === null || limit === null,
  }
}

/**
 * A1: the COMPLETE auto_budget object to send (TikTok's update is incremental per field; a partial object could reset
 * the omitted values): enabled + budget_increase_percentage + increase_limit, merged input → current → defaults. These
 * exact values feed the worst-case guard.
 */
export function buildAutoBudgetPayload(
  current: unknown,
  input: {
    enabled: boolean
    budget_increase_percentage?: number
    increase_limit?: number
  },
  notes: string[] = []
): Raw {
  const lv = boostLevels(objectOf(current), input)
  if (input.enabled && lv.defaulted)
    notes.push(
      gmvMaxBoostDefaultsNote("Tăng ngân sách tự động", lv.pct, lv.limit)
    )
  return {
    auto_budget_enabled: input.enabled,
    budget_increase_percentage: lv.pct,
    increase_limit: lv.limit,
  }
}

export interface PromotionDaysInput {
  enabled: boolean
  use_tiktok_shop_schedule?: boolean
  custom_schedule?: { start_date: string; end_date: string }[]
  roi_reduction_pct?: 10 | 20 | 30
  budget_increase_percentage?: number
  increase_limit?: number
}

/**
 * A1 / A8: the COMPLETE promotion_days object to send, merged from the current info and the input:
 * - enable / change: is_enabled, auto_schedule_enabled (explicit input → false when only custom dates are given →
 *   current → true), custom_schedule_list (input replaces the list; else the current ranges converted from
 *   start_time / end_time, past ranges dropped, running ranges start today), roas_bid_multiplier (input → current →
 *   90), budget_increase_percentage / increase_limit (input → current → 50 / 10). Custom ranges: start ≥ today, start ≥
 *   the campaign start date, start < end (account time zone).
 * - disable: null when it is already off ("When promotion_days is specified, is_enabled will be automatically set to
 *   true" - nothing is sent); else the current values with is_enabled false (even if TikTok ignored the flag, the
 *   spend settings stay the ones already running).
 */
export function buildPromotionDaysPayload(
  current: unknown,
  input: PromotionDaysInput,
  ctx: { today: string; campaignStartDate: string | null },
  notes: string[] = []
): Raw | null {
  const cur = objectOf(current)
  const lv = boostLevels(cur, input)
  const curMultiplier = num(cur.roas_bid_multiplier)
  const multiplier =
    input.roi_reduction_pct !== undefined
      ? 100 - input.roi_reduction_pct
      : curMultiplier !== null && PROMO_MULTIPLIERS.has(curMultiplier)
        ? curMultiplier
        : GMV_MAX_PROMO_DEFAULT_MULTIPLIER
  const floor =
    ctx.campaignStartDate && ctx.campaignStartDate > ctx.today
      ? ctx.campaignStartDate
      : ctx.today
  const curRanges = (
    Array.isArray(cur.custom_schedule_list)
      ? (cur.custom_schedule_list as unknown[])
      : []
  )
    .map((r) => {
      const o = objectOf(r)
      return {
        start: dateOnly(o.start_time ?? o.start_date),
        end: dateOnly(o.end_time ?? o.end_date),
      }
    })
    .filter((r): r is { start: string; end: string } => !!r.start && !!r.end)
  // past ranges dropped; a running range restarts today (TikTok refuses start dates in the past)
  const keptRanges = curRanges
    .filter((r) => r.end > floor)
    .map((r) => ({
      start_date: r.start < floor ? floor : r.start,
      end_date: r.end,
    }))
  const curAuto =
    typeof cur.auto_schedule_enabled === "boolean"
      ? cur.auto_schedule_enabled
      : null

  if (!input.enabled) {
    if (cur.is_enabled !== true) return null
    const out: Raw = {
      is_enabled: false,
      roas_bid_multiplier: multiplier,
      budget_increase_percentage: lv.pct,
      increase_limit: lv.limit,
    }
    if (curAuto === true) out.auto_schedule_enabled = true
    if (keptRanges.length) out.custom_schedule_list = keptRanges
    return out
  }

  let ranges = keptRanges
  if (input.custom_schedule !== undefined) {
    for (const s of input.custom_schedule) {
      if (s.start_date >= s.end_date)
        throw invalid(
          `Ngày khuyến mãi ${s.start_date} → ${s.end_date}: ngày bắt đầu phải TRƯỚC ngày kết thúc (khoảng kết thúc lúc 00:00 của ngày kết thúc, giờ tài khoản).`
        )
      if (s.start_date < ctx.today)
        throw invalid(
          `Ngày khuyến mãi ${s.start_date} đã qua (hôm nay ${ctx.today}, giờ tài khoản).`
        )
      if (ctx.campaignStartDate && s.start_date < ctx.campaignStartDate)
        throw invalid(
          `Ngày khuyến mãi ${s.start_date} trước ngày bắt đầu của chiến dịch (${ctx.campaignStartDate}, giờ tài khoản) - TikTok không nhận.`
        )
    }
    ranges = input.custom_schedule.map((s) => ({
      start_date: s.start_date,
      end_date: s.end_date,
    }))
  }
  const auto =
    input.use_tiktok_shop_schedule ??
    (input.custom_schedule !== undefined ? false : (curAuto ?? true))
  if (!auto && !ranges.length) {
    throw invalid(
      "Không dùng lịch TikTok Shop thì cần ít nhất 1 khoảng ngày khuyến mãi còn hiệu lực (custom_schedule).",
      "Truyền custom_schedule (ngày ở tương lai, giờ tài khoản) hoặc use_tiktok_shop_schedule=true."
    )
  }
  if (lv.defaulted)
    notes.push(gmvMaxBoostDefaultsNote("Ngày khuyến mãi", lv.pct, lv.limit))
  const out: Raw = {
    is_enabled: true,
    auto_schedule_enabled: auto,
    roas_bid_multiplier: multiplier,
    budget_increase_percentage: lv.pct,
    increase_limit: lv.limit,
  }
  // the list is sent whenever it has ranges, or to clear ranges that exist now
  if (ranges.length || curRanges.length) out.custom_schedule_list = ranges
  return out
}

export async function runGmvMaxUpdate(
  ctx: ProviderContext<TikTokCredentials>,
  input: GmvMaxUpdateInput,
  opts: MutationOptions & { now?: Date }
): Promise<GmvWriteResult> {
  const tt = ttFromCtx(ctx)
  const now = opts.now ?? new Date()
  const id = input.campaign_id
  const hit = await requireGmvMaxCampaign(tt, id)
  assertGmvMaxWrite(opts, [id])
  if (isDeleted(hit.row)) throw invalid(`Chiến dịch ${id} đã bị xoá.`)
  const info = await fetchGmvMaxInfo(tt, id)
  const name = str(hit.row.campaign_name)
  const body: Raw = { advertiser_id: tt.advertiserId, campaign_id: id }
  const changes: FieldChange[] = []
  const warnings: string[] = []
  const legacy = info.auto_budget_enabled === true
  const change = (field: string, before: unknown, after: unknown) =>
    changes.push({
      objectId: id,
      objectName: name,
      level: "campaign",
      field,
      before,
      after,
    })

  if (input.roas_bid !== undefined) {
    if (str(info.deep_bid_type) && info.deep_bid_type !== "VO_MIN_ROAS") {
      throw invalid(
        `Chiến dịch ${id} không dùng ROI mục tiêu (deep_bid_type khác VO_MIN_ROAS).`
      )
    }
    const next = roasValue(input.roas_bid)
    const before = num(info.roas_bid)
    body.roas_bid = next
    change("roas_bid", before, next)
    warnings.push(
      ...(await gmvMaxRoiWarnings(tt, id, hit.type, before, next, opts, now))
    )
  }

  if (input.auto_budget) {
    const payload = buildAutoBudgetPayload(
      info.auto_budget,
      input.auto_budget,
      warnings
    )
    body.auto_budget = payload
    change(
      "auto_budget",
      describeBoost(info.auto_budget, "auto_budget_enabled", legacy),
      describeBoost(payload, "auto_budget_enabled", legacy)
    )
  }

  if (input.promotion_days) {
    const startAt = parseTikTokTime(info.schedule_start_time)
    const payload = buildPromotionDaysPayload(
      info.promotion_days,
      input.promotion_days,
      {
        today: todayInTz(tt.timezone, now),
        campaignStartDate: startAt ? todayInTz(tt.timezone, startAt) : null,
      },
      warnings
    )
    if (payload) {
      body.promotion_days = payload
      change(
        "promotion_days",
        describeBoost(info.promotion_days, "is_enabled"),
        describeBoost(payload, "is_enabled")
      )
    } else {
      warnings.push(GMV_MAX_PROMO_ALREADY_OFF)
    }
  }

  if (input.item_group_ids) {
    if (
      info.shopping_ads_type !== "PRODUCT" ||
      info.product_specific_type !== "CUSTOMIZED_PRODUCTS"
    ) {
      throw invalid(
        `Chiến dịch ${id} không phải Product GMV Max chọn sản phẩm cụ thể - không đổi danh sách sản phẩm được.`,
        'Chiến dịch "tất cả sản phẩm" hoặc LIVE không có danh sách sản phẩm để sửa.'
      )
    }
    const current = idList(info.item_group_ids)
    const next = [...new Set(input.item_group_ids)]
    const added = next.filter((p) => !current.includes(p))
    const removed = current.filter((p) => !next.includes(p))
    const storeId = str(info.store_id)
    const bcId = str(info.store_authorized_bc_id)
    if (added.length) {
      if (!storeId || !bcId)
        throw invalid(
          `Không đọc được cửa hàng của chiến dịch ${id} để kiểm tra sản phẩm mới.`
        )
      await checkProducts(tt, storeId, bcId, added, warnings, id)
    }
    body.item_group_ids = next
    change("item_group_ids", current, next)
    // A4: full replacement - every product that leaves the campaign is listed in the preview
    if (removed.length) warnings.push(gmvMaxProductsRemovedWarning(removed))
    warnings.push(GMV_MAX_PRODUCTS_EDIT_WARNING)
  }

  if (!changes.length)
    throw invalid("Không có thay đổi nào cần gửi lên TikTok.")

  // A3: the cap applies only when the worst-case daily spend RISES (lowering / switching off is never blocked)
  const currentWorst = gmvMaxWorstCaseDaily(info, tt.currency)
  let approved = currentWorst.max_possible_daily_spend
  let raise: StartedCheck | null = null
  if (body.auto_budget || body.promotion_days) {
    const worst = gmvMaxWorstCaseAfter(
      info,
      {
        auto_budget: body.auto_budget as Raw | undefined,
        promotion_days: body.promotion_days as Raw | undefined,
      },
      tt.currency
    )
    const maxDaily = worst.max_possible_daily_spend
    if (maxDaily === null) throw budgetUnverified(null, id)
    if (maxDaily > (currentWorst.max_possible_daily_spend ?? 0)) {
      spendGuard(opts)([
        {
          label: `Mức chi tối đa có thể mỗi ngày của chiến dịch GMV Max ${id} sau thay đổi`,
          amount: maxDaily,
          currency: tt.currency,
        },
      ])
    }
    // M2: a running campaign whose worst case rises - the new worst case enters the cumulative 24 h cap (S5)
    raise = await raiseStartedCheck(
      tt,
      opts,
      id,
      info,
      hit.row,
      maxDaily,
      currentWorst.max_possible_daily_spend ?? 0
    )
    if (raise) warnings.push(...raise.notes)
    approved = Math.max(maxDaily, approved ?? 0)
    const enabling =
      (body.auto_budget as Raw | undefined)?.auto_budget_enabled === true ||
      (body.promotion_days as Raw | undefined)?.is_enabled === true
    if (enabling) warnings.push(GMV_MAX_BOOST_WARNING)
    warnings.push(
      `Ngân sách ngày ${fmt(worst.daily_budget, tt.currency)}; chi tiêu tối đa có thể mỗi ngày: trước ${fmt(currentWorst.max_possible_daily_spend, tt.currency)}, sau thay đổi ${fmt(maxDaily, tt.currency)}. ${worst.notes.join(" ")}`.trim()
    )
  }
  if (legacy) warnings.push(GMV_MAX_LEGACY_AUTO_BUDGET_ON)

  const payload = { ...body }
  delete payload.advertiser_id
  if (opts.dryRun) return { preview: true, changes, warnings, payload }
  const out = { worst: null as number | null }
  try {
    await ttPost(tt, "campaign/gmv_max/update", body, {
      retries: IDEMPOTENT_RETRIES,
    })
    // A2: read back what TikTok applied (an unexpected higher worst case → error: check / pause in Ads Manager)
    warnings.push(
      ...(await verifyGmvMaxWrite(
        tt,
        id,
        {
          ...(body.roas_bid !== undefined
            ? { roas_bid: body.roas_bid as number }
            : {}),
          ...(body.item_group_ids
            ? { item_group_ids: body.item_group_ids as string[] }
            : {}),
          ...(body.auto_budget
            ? { auto_budget: body.auto_budget as Raw }
            : {}),
          ...(body.promotion_days
            ? { promotion_days: body.promotion_days as Raw }
            : {}),
        },
        approved,
        "throw",
        out
      ))
    )
  } catch (e) {
    throw startFailed(e, raise?.reservation ?? null, [
      startedChange(id, name, Math.max(approved ?? 0, out.worst ?? 0)),
    ])
  }
  if (raise)
    changes.push(settleRaise(raise, id, name, approved ?? 0, out.worst))
  return { preview: false, changes, warnings, payload }
}

export const gmvMaxCreativesInput = z.object({
  campaign_id: numericId.describe("Id chiến dịch GMV Max đang bật"),
  action: z
    .enum(["remove", "add"])
    .describe("remove = gỡ video khỏi chiến dịch; add = thêm lại video đã gỡ"),
  items: z
    .array(
      z.object({
        item_id: numericId.describe(
          "Id bài đăng TikTok (item_id từ tiktok_gmv_max_report level creative)"
        ),
        spu_ids: z
          .array(numericId)
          .min(1)
          .max(50)
          .optional()
          .describe(
            "Product: id sản phẩm (item_group_id) gắn với bài đăng - bắt buộc"
          ),
      })
    )
    .min(1)
    .max(GMV_MAX_CREATIVES_MAX),
})
export type GmvMaxCreativesInput = z.infer<typeof gmvMaxCreativesInput>

/**
 * A7: /gmv_max/campaign/get/ with primary_status STATUS_DELIVERY_OK must list the campaign, and its secondary status
 * (when returned) must be CAMPAIGN_STATUS_ENABLE (doc 1757239620352002, GMV Max table). A failed check refuses.
 */
async function assertGmvMaxDelivering(tt: TT, hit: GmvMaxHit): Promise<void> {
  let row: Raw | undefined
  try {
    const { list } = await listGmvMaxCampaignsRaw(
      tt,
      hit.type,
      { campaign_ids: [hit.id], primary_status: "STATUS_DELIVERY_OK" },
      1
    )
    row = list.find((r) => String(r.campaign_id ?? "") === hit.id)
  } catch (e) {
    throw gmvMaxCheckFailure(e, hit.id)
  }
  const secondary = row ? str(row.secondary_status) : null
  if (!row || (secondary && secondary !== "CAMPAIGN_STATUS_ENABLE")) {
    throw invalid(
      gmvMaxNotDeliveringMessage(
        hit.id,
        secondary ?? str(hit.row.secondary_status)
      ),
      "Xem trạng thái bằng tiktok_gmv_max_campaigns; chỉ gỡ / thêm video khi chiến dịch đang phân phối."
    )
  }
}

export async function runGmvMaxCreatives(
  ctx: ProviderContext<TikTokCredentials>,
  input: GmvMaxCreativesInput,
  opts: MutationOptions
): Promise<GmvWriteResult> {
  const tt = ttFromCtx(ctx)
  const id = input.campaign_id
  const hit = await requireGmvMaxCampaign(tt, id)
  assertGmvMaxWrite(opts, [id])
  if (hit.row.operation_status !== "ENABLE" || isDeleted(hit.row)) {
    throw invalid(
      gmvMaxNotDeliveringMessage(
        id,
        str(hit.row.secondary_status) ?? str(hit.row.operation_status)
      )
    )
  }
  // A7: the doc requires an ACTIVE campaign (primary status STATUS_DELIVERY_OK = secondary CAMPAIGN_STATUS_ENABLE),
  // not only "switched on" - a campaign that is on but not delivering (out of budget, shop unavailable...) is refused
  await assertGmvMaxDelivering(tt, hit)
  const info = await fetchGmvMaxInfo(tt, id)
  const product = (str(info.shopping_ads_type) ?? hit.type) === "PRODUCT"
  if (product && info.product_video_specific_type !== "AUTO_SELECTION") {
    throw invalid(
      `Chiến dịch ${id} chọn video thủ công (CUSTOM_SELECTION) - TikTok chỉ cho gỡ / thêm video của chiến dịch tự chọn video (AUTO_SELECTION).`
    )
  }
  const seen = new Set<string>()
  const items = input.items.filter((it) =>
    seen.has(it.item_id) ? false : (seen.add(it.item_id), true)
  )
  if (product) {
    const noSpu = items
      .filter((it) => !it.spu_ids?.length)
      .map((it) => it.item_id)
    if (noSpu.length) {
      throw invalid(
        `Chiến dịch Product GMV Max cần spu_ids cho mỗi bài đăng (thiếu ở ${noSpu.slice(0, 5).join(", ")}).`,
        "Lấy item_group_id của bài đăng bằng tiktok_gmv_max_report level creative (hoặc product)."
      )
    }
  }
  const action = input.action === "remove" ? "REMOVE" : "ADD"
  const body: Raw = {
    advertiser_id: tt.advertiserId,
    campaign_id: id,
    action,
    item_list: items.map((it) => ({
      item_id: it.item_id,
      ...(product ? { spu_id_list: [...new Set(it.spu_ids)] } : {}),
    })),
  }
  const on = "đang dùng"
  const off = "đã gỡ (EXCLUDED)"
  const changes: FieldChange[] = items.map((it) => ({
    objectId: id,
    objectName: str(hit.row.campaign_name),
    level: "campaign",
    field: `creative:${it.item_id}`,
    before: action === "REMOVE" ? on : off,
    after: action === "REMOVE" ? off : on,
  }))
  const warnings = [GMV_MAX_CREATIVES_WARNING]
  const payload = { ...body }
  delete payload.advertiser_id
  if (opts.dryRun) return { preview: true, changes, warnings, payload }
  await ttPost(tt, "campaign/gmv_max/creative/update", body, {
    retries: IDEMPOTENT_RETRIES,
  })
  return { preview: false, changes, warnings, payload }
}

const timeInput = z
  .string()
  .trim()
  .max(40)
  .describe('Giờ tài khoản "YYYY-MM-DD HH:MM" hoặc ISO 8601 có múi giờ')

export const gmvMaxCreateInput = z.object({
  type: z
    .enum(["PRODUCT", "LIVE"])
    .describe("PRODUCT = GMV Max sản phẩm, LIVE = GMV Max LIVE"),
  store_id: numericId.describe(
    "Id cửa hàng (tiktok_gmv_max_shops, phải ready)"
  ),
  name: z.string().trim().min(1).max(GMV_MAX_NAME_MAX),
  budget: z
    .number()
    .positive()
    .max(1e13)
    .describe("Ngân sách ngày, đơn vị chính của tiền tệ tài khoản"),
  roas_bid: roasBidSchema.describe(
    "ROI mục tiêu (tối đa 1 chữ số thập phân) - xem tiktok_gmv_max_bid_recommend"
  ),
  products: z
    .union([
      z.literal("all"),
      z.array(numericId).min(1).max(GMV_MAX_ITEM_GROUPS_MAX),
    ])
    .optional()
    .describe(
      'PRODUCT: "all" (tất cả sản phẩm) hoặc danh sách item_group_id (tiktok_gmv_max_products, AVAILABLE + UNOCCUPIED)'
    ),
  identity_ids: z
    .array(numericId)
    .max(GMV_MAX_IDENTITIES_MAX)
    .optional()
    .describe(
      "PRODUCT: tài khoản TikTok làm nguồn video (0-20); LIVE: đúng 1 tài khoản nguồn LIVE (tiktok_gmv_max_identities)"
    ),
  affiliate_posts: z
    .boolean()
    .optional()
    .describe("PRODUCT: dùng bài đăng affiliate (mặc định của TikTok: bật)"),
  start_time: timeInput
    .optional()
    .describe("Bắt đầu phân phối (giờ tài khoản); bỏ trống = ngay"),
  end_time: timeInput
    .optional()
    .describe("Kết thúc (giờ tài khoản); bỏ trống = chạy liên tục"),
})
export type GmvMaxCreateInput = z.infer<typeof gmvMaxCreateInput>

export async function runGmvMaxCreate(
  ctx: ProviderContext<TikTokCredentials>,
  input: GmvMaxCreateInput,
  opts: MutationOptions & { now?: Date }
): Promise<GmvWriteResult> {
  const tt = ttFromCtx(ctx)
  assertGmvMaxWrite(opts, ["mới"])
  const now = opts.now ?? new Date()
  if (input.type === "PRODUCT" && input.products === undefined) {
    throw invalid(
      'PRODUCT GMV Max cần products: "all" hoặc danh sách item_group_id.'
    )
  }
  if (input.type === "LIVE" && input.products !== undefined)
    throw invalid("LIVE GMV Max không chọn sản phẩm (products).")
  const start = input.start_time
    ? parseAccountTime(input.start_time, tt.timezone)
    : now
  if (!start)
    throw invalid(`Thời gian bắt đầu không hợp lệ: ${input.start_time}.`)
  const end = input.end_time
    ? parseAccountTime(input.end_time, tt.timezone)
    : null
  if (input.end_time && !end)
    throw invalid(`Thời gian kết thúc không hợp lệ: ${input.end_time}.`)
  const plan: GmvMaxCreatePlan = {
    type: input.type,
    storeId: input.store_id,
    name: input.name,
    budget: input.budget,
    roasBid: input.roas_bid,
    products: input.type === "PRODUCT" ? (input.products ?? null) : null,
    identityIds: input.identity_ids ?? [],
    videoMode: "AUTO_SELECTION",
    affiliatePosts: input.affiliate_posts,
    start,
    end,
  }
  const prepared = await prepareGmvMaxCreate(tt, plan, opts, now)
  const warnings = [...prepared.warnings]
  const payload = { ...prepared.body }
  delete payload.advertiser_id
  const summary = createSummary(plan, prepared.body, tt.currency)
  if (opts.dryRun) {
    return {
      preview: true,
      changes: [
        {
          objectId: "(mới)",
          objectName: plan.name,
          level: "campaign",
          field: "create",
          before: null,
          after: summary,
        },
      ],
      warnings,
      payload,
    }
  }
  const newId = await executeGmvMaxCreate(tt, prepared, plan, opts, warnings)
  // A2: read back the new campaign; S5: its worst-case daily spend is recorded for the cumulative cap
  const recorded = await verifyCreated(tt, newId, prepared, warnings)
  settleCreated(prepared, newId, recorded)
  return {
    preview: false,
    changes: [
      {
        objectId: newId,
        objectName: plan.name,
        level: "campaign",
        field: "created",
        before: null,
        after: summary,
      },
      startedChange(newId, plan.name, recorded),
    ],
    warnings,
    createdIds: [newId],
    payload,
  }
}

// --- read helpers for the write tools ---------------------------------------------------------------------------

export const gmvMaxProductsInput = z.object({
  store_id: numericId.describe("Id cửa hàng (tiktok_gmv_max_shops)"),
  product_name: z.string().trim().min(1).max(200).optional(),
  item_group_ids: z.array(numericId).min(1).max(10).optional(),
  only_usable: z
    .boolean()
    .default(false)
    .describe(
      "Chỉ sản phẩm dùng được cho chiến dịch Product GMV Max mới (AVAILABLE + UNOCCUPIED)"
    ),
  limit: z.number().int().min(1).max(500).default(100),
})
export type GmvMaxProductsInput = z.infer<typeof gmvMaxProductsInput>

export async function runGmvMaxProducts(
  ctx: ProviderContext<TikTokCredentials>,
  input: GmvMaxProductsInput
): Promise<Raw> {
  const tt = ttFromCtx(ctx)
  const raw = pickGmvMaxStoreRow(
    await fetchGmvMaxStoresRaw(tt, tt.advertiserId),
    input.store_id,
    tt.advertiserId
  )
  if (!raw)
    throw invalid(
      `Không thấy cửa hàng ${input.store_id} trong danh sách cửa hàng GMV Max của tài khoản QC này.`,
      "Xem tiktok_gmv_max_shops."
    )
  const shop = mapGmvMaxShop(raw, tt.advertiserId)
  const bcId = str(raw.store_authorized_bc_id) ?? shop.business_center.bc_id
  if (!bcId)
    throw invalid(
      `TikTok không trả Business Center của cửa hàng ${input.store_id}.`
    )
  const filtering: Raw = { ad_creation_eligible: "GMV_MAX" }
  if (input.product_name) filtering.product_name = input.product_name
  if (input.item_group_ids) filtering.item_group_ids = input.item_group_ids
  const rows: Raw[] = []
  let total = 0
  for (let page = 1; page <= 50; page++) {
    const res = await ttGet<{
      store_products?: Raw[]
      page_info?: { total_number?: number; total_page?: number }
    }>(tt, "store/product/get", {
      bc_id: bcId,
      store_id: input.store_id,
      advertiser_id: tt.advertiserId,
      filtering,
      page,
      page_size: 100,
    })
    const list = Array.isArray(res.data.store_products)
      ? res.data.store_products
      : []
    rows.push(...list)
    total =
      Number(res.data.page_info?.total_number ?? rows.length) || rows.length
    if (
      rows.length >= input.limit ||
      !list.length ||
      page >= Number(res.data.page_info?.total_page ?? 0)
    )
      break
  }
  const products = rows
    .map((p) => ({
      item_group_id: str(p.item_group_id),
      title: str(p.title)?.slice(0, 200) ?? null,
      status: str(p.status),
      gmv_max_ads_status: str(p.gmv_max_ads_status),
      is_running_custom_shop_ads:
        typeof p.is_running_custom_shop_ads === "boolean"
          ? p.is_running_custom_shop_ads
          : null,
      usable_for_new_gmv_max:
        p.status === "AVAILABLE" && p.gmv_max_ads_status === "UNOCCUPIED",
      category: str(p.category),
      min_price: num(p.min_price),
      max_price: num(p.max_price),
      price_currency: str(p.currency),
      historical_sales: num(p.historical_sales),
      quantity: num(p.quantity),
    }))
    .filter((p) => !input.only_usable || p.usable_for_new_gmv_max)
  const list = products.slice(0, input.limit)
  return {
    store_id: input.store_id,
    products: list,
    count: list.length,
    total_in_shop: total,
    truncated: products.length > input.limit || total > rows.length,
    notes: [
      "gmv_max_ads_status OCCUPIED = sản phẩm đang ở 1 chiến dịch Product GMV Max đang bật (có thể của chính tài khoản này); mỗi sản phẩm chỉ được ở 1 chiến dịch Product GMV Max đang bật.",
      "is_running_custom_shop_ads = true: sản phẩm đang chạy quảng cáo Video/Product Shopping - đưa vào GMV Max sẽ tự tạm dừng các quảng cáo đó ở mọi tài khoản QC.",
      "Giá theo tiền tệ của cửa hàng (price_currency).",
    ],
    caution: GMV_MAX_CAUTION,
  }
}

export const gmvMaxIdentitiesInput = z.object({
  store_id: numericId.describe("Id cửa hàng (tiktok_gmv_max_shops)"),
})

export async function runGmvMaxIdentities(
  ctx: ProviderContext<TikTokCredentials>,
  input: { store_id: string }
): Promise<Raw> {
  const tt = ttFromCtx(ctx)
  const { bcId } = await readyShopForRead(tt, input.store_id)
  const res = await ttGet<{ identity_list?: Raw[] }>(
    tt,
    "gmv_max/identity/get",
    {
      advertiser_id: tt.advertiserId,
      store_id: input.store_id,
      store_authorized_bc_id: bcId,
    }
  )
  const identities = (
    Array.isArray(res.data.identity_list) ? res.data.identity_list : []
  )
    .slice(0, 200)
    .map((o) => ({
      ...mapGmvMaxIdentity(o),
      product_gmv_max_available: o.product_gmv_max_available === true,
      live_gmv_max_available: o.live_gmv_max_available === true,
      unavailable_reason: str(o.unavailable_reason),
      is_running_custom_shop_ads: o.is_running_custom_shop_ads === true,
    }))
  return {
    store_id: input.store_id,
    identities,
    count: identities.length,
    notes: [
      "PRODUCT: tài khoản có product_gmv_max_available=true dùng làm nguồn video (identity_ids của tiktok_gmv_max_create, tối đa 20).",
      "LIVE: cần đúng 1 tài khoản có live_gmv_max_available=true; OCCUPIED = đang ở chiến dịch LIVE GMV Max / LIVE Shopping đang bật.",
    ],
    caution: GMV_MAX_CAUTION,
  }
}

/** Store + its authorized Business Center for read tools (the shop does not need to be ready). */
async function readyShopForRead(
  tt: TT,
  storeId: string
): Promise<{ bcId: string }> {
  // several rows per store (owner / partner BCs): the row usable by THIS ad account (A10)
  const raw = pickGmvMaxStoreRow(
    await fetchGmvMaxStoresRaw(tt, tt.advertiserId),
    storeId,
    tt.advertiserId
  )
  if (!raw)
    throw invalid(
      `Không thấy cửa hàng ${storeId} trong danh sách cửa hàng GMV Max của tài khoản QC này.`,
      "Xem tiktok_gmv_max_shops."
    )
  const bcId =
    str(raw.store_authorized_bc_id) ??
    mapGmvMaxShop(raw, tt.advertiserId).business_center.bc_id
  if (!bcId)
    throw invalid(`TikTok không trả Business Center của cửa hàng ${storeId}.`)
  return { bcId }
}

export const gmvMaxBidRecommendInput = z.object({
  store_id: numericId.describe("Id cửa hàng (tiktok_gmv_max_shops)"),
  type: z.enum(["PRODUCT", "LIVE"]),
  item_group_ids: z
    .array(numericId)
    .min(1)
    .max(GMV_MAX_BID_RECOMMEND_ITEMS_MAX)
    .optional()
    .describe("PRODUCT: sản phẩm cụ thể; bỏ trống = tất cả sản phẩm"),
  identity_id: numericId
    .optional()
    .describe("LIVE: tài khoản TikTok nguồn LIVE (bắt buộc)"),
})
export type GmvMaxBidRecommendInput = z.infer<typeof gmvMaxBidRecommendInput>

export async function runGmvMaxBidRecommend(
  ctx: ProviderContext<TikTokCredentials>,
  input: GmvMaxBidRecommendInput
): Promise<Raw> {
  const tt = ttFromCtx(ctx)
  if (input.type === "LIVE" && !input.identity_id)
    throw invalid("LIVE cần identity_id (tiktok_gmv_max_identities).")
  const query: Raw = {
    advertiser_id: tt.advertiserId,
    store_id: input.store_id,
    shopping_ads_type: input.type,
    optimization_goal: "VALUE",
  }
  if (input.type === "PRODUCT" && input.item_group_ids)
    query.item_group_ids = input.item_group_ids
  if (input.type === "LIVE") query.identity_id = input.identity_id
  const res = await ttGet<Raw>(tt, "gmv_max/bid/recommend", query)
  return {
    store_id: input.store_id,
    type: input.type,
    recommended_roas_bid: num(res.data.roas_bid),
    recommended_daily_budget: moneyOf(res.data.budget, tt.currency),
    currency: tt.currency,
    notes: [
      "ROI khuyến nghị dựa trên ROI trung bình của ngành hàng; ngân sách dựa trên chi tiêu 14 ngày gần nhất (TikTok).",
      "Chỉ là gợi ý - tạo / đổi bằng tiktok_gmv_max_create / tiktok_gmv_max_update (cần quản trị viên bật quyền GMV Max cho MCP).",
    ],
    caution: GMV_MAX_CAUTION,
  }
}

const WRITE_PREREQ =
  "Chỉ có khi quản trị viên đã bật quyền thay đổi GMV Max cho MCP. Luôn cần xác nhận 2 bước: lần gọi đầu trả preview + confirm_token; chỉ gọi lại với confirm_token khi người dùng đồng ý rõ ràng."

export const gmvMaxWriteExtensions: ProviderExtension<TikTokCredentials>[] = [
  {
    name: "tiktok_gmv_max_products",
    permission: "read",
    title: "Sản phẩm cho GMV Max (TikTok Shop)",
    description:
      "Dùng khi cần danh sách sản phẩm (SPU, item_group_id) của một cửa hàng TikTok Shop và sản phẩm nào còn dùng được cho chiến dịch Product GMV Max (AVAILABLE + UNOCCUPIED), sản phẩm nào đang nằm trong chiến dịch Product GMV Max đang bật hoặc đang chạy quảng cáo Video/Product Shopping. " +
      "Gọi ads_list_accounts và tiktok_gmv_max_shops trước để có account_id và store_id. Chỉ đọc. Cần quyền Onsite Commerce Store cho developer app.",
    input: gmvMaxProductsInput,
    write: false,
    run: (ctx, input) => runGmvMaxProducts(ctx, input as GmvMaxProductsInput),
  },
  {
    name: "tiktok_gmv_max_identities",
    permission: "read",
    title: "Tài khoản TikTok cho GMV Max",
    description:
      "Dùng khi cần danh sách tài khoản TikTok (identity) của cửa hàng dùng được cho GMV Max: nguồn video của Product GMV Max, nguồn LIVE của LIVE GMV Max (đang bị chiếm hay chưa được cấp quyền). " +
      "Gọi ads_list_accounts và tiktok_gmv_max_shops trước. Chỉ đọc.",
    input: gmvMaxIdentitiesInput,
    write: false,
    run: (ctx, input) =>
      runGmvMaxIdentities(ctx, input as { store_id: string }),
  },
  {
    name: "tiktok_gmv_max_bid_recommend",
    permission: "read",
    title: "ROI và ngân sách khuyến nghị (GMV Max)",
    description:
      "Dùng khi cần ROI mục tiêu và ngân sách ngày TikTok khuyến nghị cho một chiến dịch GMV Max (Product: tất cả hoặc một số sản phẩm; LIVE: theo tài khoản TikTok nguồn LIVE). " +
      "Gọi ads_list_accounts, tiktok_gmv_max_shops (và tiktok_gmv_max_products / tiktok_gmv_max_identities) trước. Chỉ đọc; tiền theo đơn vị chính của tiền tệ tài khoản.",
    input: gmvMaxBidRecommendInput,
    write: false,
    run: (ctx, input) =>
      runGmvMaxBidRecommend(ctx, input as GmvMaxBidRecommendInput),
  },
  {
    name: "tiktok_gmv_max_update",
    permission: "update",
    title: "Sửa chiến dịch GMV Max",
    description:
      "Dùng khi người dùng yêu cầu rõ ràng đổi ROI mục tiêu (roas_bid), bật/tắt tăng ngân sách tự động (auto_budget), ngày khuyến mãi (promotion_days) hoặc danh sách sản phẩm (item_group_ids, thay thế toàn bộ) của một chiến dịch GMV Max. " +
      "Ngân sách ngày đổi bằng ads_update_budget; tên / ngày kết thúc bằng ads_update_object; bật/tắt bằng ads_set_status. " +
      "TikTok khuyên giữ mỗi mức ROI ít nhất 3 ngày trọn vẹn (LIVE tối đa 1 lần/ngày); tăng ROI hoặc giảm lần 2 trong ngày, sửa sản phẩm làm mất Bảo vệ ROI ngày đó. Bật tăng ngân sách tự động / ngày khuyến mãi cần trần ngân sách ngày đủ cho mức chi tối đa có thể (tới ~31 lần ngân sách). " +
      "Gọi ads_list_accounts và tiktok_gmv_max_campaigns (include_details) trước. " +
      WRITE_PREREQ,
    input: gmvMaxUpdateInput,
    write: true,
    requiresSetting: "tiktok_gmv_max_write",
    alwaysConfirm: true,
    // ROI is a ratio (not money); the worst-case spend of auto budget / promotion days goes through dailySpendGuard
    moneyOf: () => [],
    run: (ctx, input, opts) =>
      runGmvMaxUpdate(ctx, input as GmvMaxUpdateInput, opts),
  },
  {
    name: "tiktok_gmv_max_creatives",
    permission: "update",
    title: "Gỡ / thêm lại video GMV Max",
    description:
      "Dùng khi người dùng yêu cầu rõ ràng gỡ video (bài đăng) khỏi một chiến dịch GMV Max đang phân phối (Active), hoặc thêm lại video đã gỡ (tối đa 400 mỗi lần). Product GMV Max: chiến dịch phải tự chọn video (AUTO_SELECTION) và mỗi bài đăng cần spu_ids. " +
      "Lấy item_id / item_group_id bằng tiktok_gmv_max_report level creative. Sau khi gỡ, chờ khoảng 20 phút rồi kiểm tra trạng thái video (EXCLUDED). " +
      WRITE_PREREQ,
    input: gmvMaxCreativesInput,
    write: true,
    requiresSetting: "tiktok_gmv_max_write",
    alwaysConfirm: true,
    moneyOf: () => [],
    run: (ctx, input, opts) =>
      runGmvMaxCreatives(ctx, input as GmvMaxCreativesInput, opts),
  },
  {
    name: "tiktok_gmv_max_create",
    permission: "create",
    title: "Tạo chiến dịch GMV Max (chạy ngay)",
    description:
      "Dùng khi người dùng yêu cầu rõ ràng tạo chiến dịch GMV Max mới (Product: tất cả hoặc các sản phẩm chọn; LIVE: 1 tài khoản TikTok nguồn LIVE). CẢNH BÁO: chiến dịch GMV Max tạo qua API CHẠY NGAY (TikTok không cho tạo ở trạng thái tạm dừng; có thể hẹn giờ bắt đầu bằng start_time) và có thể tự tạm dừng quảng cáo Shop khác dùng cùng cửa hàng / sản phẩm / tài khoản TikTok ở mọi tài khoản QC. " +
      "Kiểm tra trước: cửa hàng sẵn sàng cho tài khoản QC này, mỗi sản phẩm chỉ ở 1 chiến dịch Product GMV Max đang bật. Ngân sách ngày phải nằm trong trần ngân sách ngày của MCP (bắt buộc có trần), tính cộng dồn với các chiến dịch GMV Max MCP này đã cho chạy trong 24 giờ qua. " +
      "Gọi trước: ads_list_accounts, tiktok_gmv_max_shops, tiktok_gmv_max_products / tiktok_gmv_max_identities, tiktok_gmv_max_bid_recommend. Sao chép chiến dịch GMV Max có sẵn: ads_copy_object. " +
      WRITE_PREREQ,
    input: gmvMaxCreateInput,
    write: true,
    requiresSetting: "tiktok_gmv_max_write",
    alwaysConfirm: true,
    createsActive: true,
    moneyOf: (raw) => {
      const input = raw as GmvMaxCreateInput
      return [{ kind: "daily_budget", amount: input.budget, field: "budget" }]
    },
    run: (ctx, input, opts) =>
      runGmvMaxCreate(ctx, input as GmvMaxCreateInput, opts),
  },
]
