import { and, asc, eq, gt, sql } from "drizzle-orm"
import { z } from "zod"
import { db } from "../../../db/client"
import { mcpCallLogs } from "../../../db/schema"
import type { Budget } from "../../../providers/types"
import { denied, invalid } from "../../errors"
import { assertGrant } from "../../grant"
import { campaignFlightOrDeny } from "../../budget-flight"
import {
  checkDailyCap,
  checkLifetimeCap,
  DYNAMIC_DAILY_NOTE,
  fmtMoney as fmt,
  legacyCapWarning,
  lifetimeLimit,
  requireMoneyCaps,
  type Flight,
} from "../../guardrails"
import { accountIdSchema, objectIdSchema, platformEnum, writeFields, writeOutputSchema } from "../../schemas"
import { providerFor, registerToolSpec, runWrite, UPDATE_ANNOTATIONS, type ToolContext } from "../../tool"
import { grantPlatformsWith, type McpSettings } from "../../types"
import { writeOptions } from "../../write-options"
import { alwaysConfirmFor } from "./set-status"
import { mutationOut, previewFromMutation } from "./write-common"

export const NAME = "ads_update_budget"

export interface BudgetGuardResult {
  warnings: string[]
  changePct: number | null
}

/**
 * Guardrails (04-mcp-design.md §6): max % change vs the CURRENT budget, the per-currency daily cap and
 * the lifetime cap (daily cap × flight days / explicit lifetime cap).
 * Throws McpToolError(denied) when violated. Pure, exported for tests.
 */
export function checkBudgetGuardrails(
  settings: McpSettings,
  current: Budget | null | undefined,
  next: { type: "daily" | "lifetime"; amount: number; currency: string },
  /** flight of the object (lifetime budgets: cap = daily cap × days) */
  flight?: Flight
): BudgetGuardResult {
  const warnings: string[] = []
  const cur = next.currency.toUpperCase()
  if (!Number.isFinite(next.amount) || next.amount <= 0) throw invalid("invalid_amount", "Ngân sách phải lớn hơn 0.")
  let changePct: number | null = null
  if (current && current.type === next.type && current.amount > 0) {
    changePct = ((next.amount - current.amount) / current.amount) * 100
    if (Math.abs(changePct) > settings.budgetChangeMaxPct + 1e-9) {
      const maxUp = current.amount * (1 + settings.budgetChangeMaxPct / 100)
      const maxDown = current.amount * (1 - settings.budgetChangeMaxPct / 100)
      throw denied(
        "budget_change_too_large",
        `Thay đổi ${changePct > 0 ? "+" : ""}${changePct.toFixed(1)}% (${fmt(current.amount, cur)} → ${fmt(next.amount, cur)}) vượt giới hạn ±${settings.budgetChangeMaxPct}% mỗi lần của MCP này.`,
        `Mức cho phép lần này: từ ${fmt(Math.max(0, maxDown), cur)} đến ${fmt(maxUp, cur)}; có thể thay đổi nhiều lần, hoặc nhờ chủ MCP đổi giới hạn.`
      )
    }
    if (changePct !== 0) warnings.push(`Ngân sách ${changePct > 0 ? "tăng" : "giảm"} ${Math.abs(changePct).toFixed(1)}%.`)
  } else if (current && current.type !== next.type) {
    // switching daily ↔ lifetime would bypass the % guardrail; platforms rarely allow it anyway
    throw invalid(
      "budget_type_change",
      `Ngân sách hiện tại là loại ${current.type === "daily" ? "ngày" : "trọn đời"}; không đổi loại ngân sách qua MCP.`,
      `Gọi lại với budget_type="${current.type}".`
    )
  }
  // a flexible daily budget (TikTok) keeps its mode: the cap is compared with what one day may spend (125%)
  const dynamic = next.type === "daily" && current?.type === "daily" && current.dynamic === true
  if (next.type === "daily") checkDailyCap(settings, next.amount, cur, dynamic ? "Ngân sách ngày linh hoạt" : "Ngân sách ngày", { dynamic })
  else checkLifetimeCap(settings, next.amount, cur, flight ?? {})
  if (dynamic) warnings.push(`${DYNAMIC_DAILY_NOTE} Mức ${fmt(next.amount, cur)} có thể chi tới ${fmt(next.amount * 1.25, cur)} trong một ngày.`)
  return { warnings, changePct }
}

/**
 * Cumulative guard (anti "salami" stepping): within 24 h the budget may not move more than
 * budgetChangeMaxPct away from the EARLIEST value seen in that window (from successful
 * ads_update_budget calls of any MCP on this object). Pure, exported for tests.
 */
export function checkCumulativeBudget(
  settings: McpSettings,
  baseline: { amount: number; type: "daily" | "lifetime" } | null,
  next: { type: "daily" | "lifetime"; amount: number; currency: string }
): void {
  if (!baseline || baseline.type !== next.type || !(baseline.amount > 0)) return
  const cur = next.currency.toUpperCase()
  const pct = ((next.amount - baseline.amount) / baseline.amount) * 100
  if (Math.abs(pct) <= settings.budgetChangeMaxPct + 1e-9) return
  const maxUp = baseline.amount * (1 + settings.budgetChangeMaxPct / 100)
  const maxDown = baseline.amount * (1 - settings.budgetChangeMaxPct / 100)
  throw denied(
    "budget_cumulative_change_too_large",
    `Trong 24 giờ qua ngân sách này đã được đổi từ ${fmt(baseline.amount, cur)}; mức ${fmt(next.amount, cur)} lệch ${pct > 0 ? "+" : ""}${pct.toFixed(1)}%, vượt giới hạn ±${settings.budgetChangeMaxPct}% cộng dồn trong 24 giờ của MCP này.`,
    `Mức cho phép hiện tại: từ ${fmt(Math.max(0, maxDown), cur)} đến ${fmt(maxUp, cur)}. Muốn thay đổi lớn hơn, hãy đợi đủ 24 giờ hoặc nhờ chủ MCP đổi giới hạn.`
  )
}

/** Earliest budget value (before the first successful change) of this object within the last 24 h. */
export async function budgetBaseline24h(q: {
  platform: string
  accountExternalId: string
  level: string
  id: string
  type: "daily" | "lifetime"
}): Promise<{ amount: number; type: "daily" | "lifetime" } | null> {
  const rows = await db
    .select({ before: sql<string | null>`${mcpCallLogs.response} -> 'result' ->> 'before'` })
    .from(mcpCallLogs)
    .where(
      and(
        eq(mcpCallLogs.platform, q.platform),
        eq(mcpCallLogs.adAccountId, q.accountExternalId),
        eq(mcpCallLogs.toolName, NAME),
        eq(mcpCallLogs.status, "success"),
        gt(mcpCallLogs.createdAt, sql`now() - interval '24 hours'`),
        sql`${mcpCallLogs.objectIds} @> array[${q.id}]::text[]`,
        sql`${mcpCallLogs.request} ->> 'level' = ${q.level}`,
        sql`${mcpCallLogs.response} -> 'result' ->> 'budget_type' = ${q.type}`
      )
    )
    .orderBy(asc(mcpCallLogs.createdAt))
    .limit(1)
  const v = rows[0]?.before
  const n = v === null || v === undefined ? NaN : Number(v)
  return Number.isFinite(n) && n > 0 ? { amount: n, type: q.type } : null
}

export function register(server: Parameters<typeof registerToolSpec>[0], tctx: ToolContext) {
  const platforms = grantPlatformsWith(tctx.grant, "update")
  if (platforms.length === 0) return
  registerToolSpec(server, tctx, {
    name: NAME,
    title: "Đổi ngân sách",
    description:
      "Dùng khi cần đặt ngân sách ngày (daily) hoặc trọn đời (lifetime) cho một chiến dịch hoặc nhóm quảng cáo, theo đơn vị chính của tiền tệ tài khoản (vd 500000 nghĩa là 500.000 VND). Gọi ads_list_accounts và ads_get_object trước để biết ngân sách đang nằm ở cấp nào (CBO/ABO) và giá trị hiện tại. Có giới hạn % thay đổi mỗi lần và trần ngân sách ngày theo cấu hình MCP; vượt giới hạn sẽ bị từ chối kèm mức cho phép. Kết quả có effective_at khi thay đổi không có hiệu lực ngay (vd TikTok: 00:00 hôm sau). Google: chiến dịch Video (YouTube) chỉ xem được; Demand Gen tối thiểu khoảng 5 USD/ngày. Có thể trả confirmation_required: cho người dùng xem preview rồi gọi lại với confirm_token khi họ đồng ý.",
    kind: "write",
    annotations: UPDATE_ANNOTATIONS,
    input: z.object({
      platform: platformEnum(platforms),
      account_id: accountIdSchema,
      level: z.enum(["campaign", "ad_group"]),
      id: objectIdSchema,
      budget_type: z.enum(["daily", "lifetime"]),
      amount: z.number().positive().max(1e13).describe("Đơn vị chính của tiền tệ tài khoản"),
      ...writeFields,
    }),
    output: writeOutputSchema,
    async handler(args, env) {
      const account = assertGrant(env.grant, { platform: args.platform, accountId: args.account_id, permission: "update" })
      env.log.setTarget({ platform: account.platform, accountId: account.externalId, objectIds: [args.id] })
      const provider = providerFor(account.platform, "update_budget")

      // Guardrails run on BOTH steps against the live budget (it may have changed since the preview).
      const ctx = await env.providerCtx(account)
      // L5: refusals that do not depend on money (TikTok: GMV Max locked) come before the cap checks
      if (provider.preflightWrite) await provider.preflightWrite(ctx, args.level, [args.id], "update", writeOptions(env.grant, account))
      // forWrite: platform-specific lookups (TikTok GMV Max) fail closed instead of falling back to a generic budget
      const obj = await provider.getObject(ctx, args.level, args.id, { forWrite: true })
      const current = obj.budget ?? null
      if (!current) {
        // without the current value the % guardrail cannot be enforced → refuse (money safety)
        throw invalid(
          "no_current_budget",
          `Không đọc được ngân sách hiện tại của ${args.level === "campaign" ? "chiến dịch" : "nhóm quảng cáo"} này (có thể ngân sách nằm ở cấp khác, vd CBO).`,
          "Gọi ads_get_object (include_children) để xem ngân sách nằm ở cấp chiến dịch hay nhóm quảng cáo."
        )
      }
      if (current.level && current.level !== args.level) {
        throw invalid(
          "budget_level_mismatch",
          `Ngân sách của đối tượng này nằm ở cấp ${current.level === "campaign" ? "chiến dịch" : "nhóm quảng cáo"}.`,
          `Gọi lại với level="${current.level}" và id tương ứng (xem ads_get_object).`
        )
      }
      const currency = (current?.currency || account.currency).toUpperCase()
      requireMoneyCaps(env.grant.settings, currency, "đổi ngân sách")
      const next = { type: args.budget_type, amount: args.amount, currency }
      // a campaign lifetime budget (CBO) is spent over the flights of its ad sets (budget-flight.ts)
      const flight: Flight =
        args.level === "campaign" && args.budget_type === "lifetime" && lifetimeLimit(env.grant.settings, currency, {})
          ? await campaignFlightOrDeny(provider, ctx, obj)
          : { startTime: obj.startTime, endTime: obj.endTime }
      const guard = checkBudgetGuardrails(env.grant.settings, current, next, flight)
      const warnings = [...legacyCapWarning(env.grant.settings, currency), ...guard.warnings]
      checkCumulativeBudget(
        env.grant.settings,
        await budgetBaseline24h({ platform: account.platform, accountExternalId: account.externalId, level: args.level, id: args.id, type: args.budget_type }),
        next
      )
      const update = { level: args.level, id: args.id, type: args.budget_type, amount: args.amount }
      // e.g. TikTok GMV Max: always two-step confirmation; GMV Max switch + strict worst-case guard in the adapter
      const confirm = await alwaysConfirmFor(env, account, provider, args.level, [args.id], "update", args)
      const wopts = {
        ...writeOptions(env.grant, account),
        // S6: adapters that read the budget themselves (TikTok GMV Max) re-check the % limit + 24 h cumulative rule
        // against THAT value, so a different baseline here cannot widen the change
        budgetChangeGuard: async (q: { current: number; next: number; currency: string }) => {
          const cur = q.currency.toUpperCase()
          checkBudgetGuardrails(
            env.grant.settings,
            { type: "daily", amount: q.current, currency: cur, level: args.level },
            { type: "daily", amount: q.next, currency: cur }
          )
          checkCumulativeBudget(
            env.grant.settings,
            await budgetBaseline24h({ platform: account.platform, accountExternalId: account.externalId, level: args.level, id: args.id, type: "daily" }),
            { type: "daily", amount: q.next, currency: cur }
          )
        },
      }

      return runWrite(env, {
        args,
        account,
        alwaysConfirm: confirm.alwaysConfirm,
        preview: async () => {
          const r = await provider.updateBudget(ctx, update, { ...wopts, dryRun: true })
          return previewFromMutation(r, [...warnings, ...confirm.reasons], {
            current: current ? { type: current.type, amount: current.amount, currency } : null,
            requested: { type: args.budget_type, amount: args.amount, currency },
            change_pct: guard.changePct === null ? null : Math.round(guard.changePct * 10) / 10,
          })
        },
        execute: async (idempotencyKey, meta) => {
          const r = await provider.updateBudget(ctx, update, { ...wopts, idempotencyKey, confirmed: meta.confirmed })
          return {
            structured: {
              ...mutationOut(r, guard.warnings),
              result: { before: current ? current.amount : null, after: args.amount, currency, budget_type: args.budget_type },
            },
            summary: `Đã đặt ngân sách ${args.budget_type === "daily" ? "ngày" : "trọn đời"} ${fmt(args.amount, currency)} cho ${args.level} ${args.id}${r.effectiveAt ? ` (hiệu lực từ ${r.effectiveAt})` : ""}.`,
            changes: r.changes.length
              ? r.changes
              : [{ objectId: args.id, objectName: obj.name ?? null, level: args.level, field: `${args.budget_type}_budget`, before: current.amount, after: args.amount }],
          }
        },
      })
    },
  })
}
