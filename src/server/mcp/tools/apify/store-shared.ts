// Helpers of the Actors-outside-the-catalog tools (apify_search_actors / apify_get_actor / apify_run_actor; admin
// switch apify_store_actors, 16-apify.md §7): actor id parsing, refusal reasons, pricing summary, refused input fields.
// Everything read from the Store (titles, descriptions, READMEs, input schemas) is untrusted text: cleaned + capped.
import { z } from "zod"

import {
  dangerousInputFields,
  type ActorRefusal,
  type ApifyPricing,
} from "@/server/apify/actors"
import { findForbiddenInputKeys } from "@/server/apify/catalog"

import { invalid } from "../../errors"
import { jsonLength, MAX_STRUCTURED_CHARS } from "../../tool"
import { cleanLabel } from "./shared"

/** "username~name" or "username/name" (Store naming) */
const ACTOR_ID_RE =
  /^([A-Za-z0-9][A-Za-z0-9._-]{0,99})[~/]([A-Za-z0-9][A-Za-z0-9._-]{0,99})$/

export const actorIdSchema = z
  .string()
  .trim()
  .min(3)
  .max(201)
  .describe(
    'Mã Actor dạng "tên-người-dùng~tên-actor" (lấy từ apify_search_actors), vd apify~website-content-crawler'
  )

/** "username~name" or an invalid_request error */
export function normalizeActorId(raw: string): string {
  const m = ACTOR_ID_RE.exec(raw.trim())
  if (!m) {
    throw invalid(
      "apify_actor_id_invalid",
      "Mã Actor không hợp lệ.",
      'Dùng dạng "tên-người-dùng~tên-actor" như apify_search_actors trả về.'
    )
  }
  return `${m[1]}~${m[2]}`
}

export const REFUSAL_VI: Record<ActorRefusal, string> = {
  full_permissions:
    "Actor cần quyền đầy đủ trên tài khoản Apify (full permissions)",
  deprecated: "Actor đã ngừng hỗ trợ",
  under_maintenance: "Actor đang bảo trì",
  rental: "Actor thuê theo tháng (rental)",
  standby: "Actor chạy dạng máy chủ Standby, không chạy theo lần được",
}

/** dangerous / forbidden keys + secret-looking values of an Actor input, as dotted paths (empty = acceptable) */
export function refusedInputPaths(input: unknown): string[] {
  return [
    ...new Set([
      ...dangerousInputFields(input),
      ...findForbiddenInputKeys(input),
    ]),
  ].slice(0, 20)
}

/** true when an input field NAME alone would be refused (shown to the AI in apify_get_actor) */
export function isRefusedFieldName(name: string): boolean {
  return refusedInputPaths({ [name]: null }).length > 0
}

/** pay-per-usage (no PPE events): Apify bills compute units, maxTotalChargeUsd may not apply (16-apify.md §7) */
export function isPayPerUsage(p: ApifyPricing | null): boolean {
  return !p || p.pricingModel === null || p.pricingModel === "FREE"
}

/**
 * The run is billed by platform usage (security M2): pay-per-usage, or pay-per-event whose platform usage is paid by
 * the user (`isPPEPlatformUsagePaidByUser` true or unknown) - the cost cap then also bounds the timeout.
 */
export function isUsageBilled(p: ApifyPricing | null): boolean {
  return isPayPerUsage(p) || p?.platformUsagePaidByUser !== false
}

/**
 * Short, cleaned summary of an Actor input for the confirmation preview: top-level keys (≤ 30) with a one-line
 * preview of each value (strings ≤ 120 characters, arrays → count + first entry, objects → their keys).
 */
export function inputSummary(input: Record<string, unknown>): Record<string, string> {
  const one = (v: unknown): string => {
    if (typeof v === "string") return cleanLabel(v, 120) ?? ""
    if (typeof v === "number" || typeof v === "boolean" || v === null) return String(v)
    if (Array.isArray(v)) return `[${v.length} mục]${v.length ? ` ${one(v[0])}` : ""}`.slice(0, 160)
    if (typeof v === "object")
      return `{${Object.keys(v as object)
        .slice(0, 8)
        .map((k) => cleanLabel(k, 40))
        .join(", ")}}`
    return ""
  }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(input).slice(0, 30)) {
    const key = cleanLabel(k, 80)
    if (key && key !== "__proto__") out[key] = one(v)
  }
  return out
}

export function pricingOut(p: ApifyPricing | null) {
  if (!p)
    return {
      model: "PAY_PER_USAGE",
      note: "Chỉ tính phí tài nguyên Apify (compute unit, proxy).",
    }
  return {
    model: p.pricingModel,
    ...(p.pricePerUnitUsd !== null
      ? {
          price_per_unit_usd: p.pricePerUnitUsd,
          unit: cleanLabel(p.unitName, 40),
        }
      : {}),
    ...(p.minimalMaxTotalChargeUsd !== null
      ? { min_charge_cap_usd: p.minimalMaxTotalChargeUsd }
      : {}),
    ...(p.platformUsagePaidByUser ? { platform_usage_paid_by_user: true } : {}),
    events: p.events.slice(0, 6).map((e) => ({
      name: cleanLabel(e.name, 60),
      title: cleanLabel(e.title, 100),
      price_usd: e.priceUsd,
      ...(e.isPrimary ? { primary: true } : {}),
    })),
  }
}

/** JSON budget of the Store tools' answers (the text block repeats it; security L3) */
export const STORE_BUDGET_CHARS = MAX_STRUCTURED_CHARS - 2_000

type Rec = Record<string, unknown>

/**
 * apify_search_actors within the budget: input fields go first (from the last result up), then descriptions are
 * shortened, then the last results are dropped. Returns the list + whether something was cut.
 */
export function fitActorList(actors: Rec[], budget = STORE_BUDGET_CHARS): { actors: Rec[]; truncated: boolean } {
  let list = actors
  let truncated = false
  for (let i = list.length - 1; i >= 0 && jsonLength(list) > budget; i--) {
    const { input_fields: _f, ...rest } = list[i]!
    list = [...list.slice(0, i), rest, ...list.slice(i + 1)]
    truncated = true
  }
  if (jsonLength(list) > budget) {
    list = list.map((a) => ({
      ...a,
      description: typeof a.description === "string" ? cleanLabel(a.description, 120) : a.description,
    }))
  }
  while (list.length > 1 && jsonLength(list) > budget) list = list.slice(0, -1)
  return { actors: list, truncated: truncated || list.length < actors.length }
}

/**
 * apify_get_actor within the budget: input field descriptions shortened, then enums / defaults dropped, then the
 * README summary shortened, then the last input fields dropped (`input_schema_truncated`).
 */
export function fitActorDetail(detail: Rec, budget = STORE_BUDGET_CHARS): Rec {
  let out = detail
  const schema = () => (Array.isArray(out.input_schema) ? (out.input_schema as Rec[]) : null)
  if (jsonLength(out) > budget && schema()) {
    out = {
      ...out,
      input_schema: schema()!.map((p) => ({
        ...p,
        description: typeof p.description === "string" ? cleanLabel(p.description, 100) : p.description,
      })),
      input_schema_truncated: true,
    }
  }
  if (jsonLength(out) > budget && schema()) {
    out = {
      ...out,
      input_schema: schema()!.map(({ enum: _e, default: _d, ...p }) => p),
    }
  }
  if (jsonLength(out) > budget && typeof out.readme_summary === "string") {
    out = { ...out, readme_summary: cleanLabel(out.readme_summary, 500) }
  }
  while (jsonLength(out) > budget && (schema()?.length ?? 0) > 1) {
    out = { ...out, input_schema: schema()!.slice(0, -1), input_schema_truncated: true }
  }
  return out
}
