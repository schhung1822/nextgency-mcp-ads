import { z } from "zod"
import { safeErrorForLog } from "../../../audit/safe-error"
import { isProviderError } from "../../../providers/errors"
import type { ActivationSpend, AdObjectDetail, AdObjectSummary, AdsProvider, AlwaysConfirmOp, ObjectLevel } from "../../../providers/types"
import { adGroupFlightsMatter, campaignFlightOrDeny, isConfiguredOn, listChildAdGroups } from "../../budget-flight"
import { denied, invalid } from "../../errors"
import { assertGrant } from "../../grant"
import { checkDailyCap, checkLifetimeCap, fmtMoney, LEVEL_VI, legacyCapWarning, requireMoneyCaps, type Flight } from "../../guardrails"
import { accountIdSchema, objectIdSchema, objectLevelSchema, platformEnum, writeFields, writeOutputSchema } from "../../schemas"
import { providerFor, registerToolSpec, runWrite, UPDATE_ANNOTATIONS, type ToolContext, type ToolEnv } from "../../tool"
import { grantPlatformsWith, type GrantAccount } from "../../types"
import { writeOptions } from "../../write-options"
import { mutationOut, previewFromMutation } from "./write-common"

export const NAME = "ads_set_status"
export const MAX_STATUS_IDS = 50
const LOOKUP_CONCURRENCY = 5

/**
 * Before activating: read every object (and its parent ad group / campaign - CBO budgets live on the
 * campaign) and refuse when a governing budget exceeds the MCP's daily / lifetime cap.
 * - a campaign-level LIFETIME budget is checked against the flight of the ad sets that will deliver
 *   (budget-flight.ts), not the campaign dates alone;
 * - switching on a campaign without a campaign budget (Meta ABO) also checks every ad set that is
 *   configured on (they start spending with the campaign).
 * - provider.activationSpend (TikTok GMV Max: auto budget increase / promotion days): the WORST-CASE daily spend of
 *   each listed object is compared with the daily cap; when it cannot be verified the activation is refused
 *   (budget_unverifiable, fail closed). Returns those entries for the preview (undefined = hook not run).
 * No cap configured for the account currency → nothing to read.
 */
export async function assertActivationWithinCaps(
  env: ToolEnv,
  account: GrantAccount,
  provider: AdsProvider,
  level: ObjectLevel,
  ids: string[]
): Promise<ActivationSpend[] | undefined> {
  const s = env.grant.settings
  const cur = account.currency.toUpperCase()
  const hasDailyCap = (s.maxDailyBudget?.[cur] ?? 0) > 0
  const hasCap = hasDailyCap || (s.maxLifetimeBudget?.[cur] ?? 0) > 0
  if (!hasCap) return undefined
  const ctx = await env.providerCtx(account)
  const cache = new Map<string, Promise<AdObjectDetail>>()
  const get = (lvl: ObjectLevel, id: string) => {
    const k = `${lvl}:${id}`
    let p = cache.get(k)
    if (!p) {
      p = provider.getObject(ctx, lvl, id)
      cache.set(k, p)
    }
    return p
  }
  // child ad groups of a campaign, listed once per call (null = too many to verify)
  const kids = new Map<string, Promise<AdObjectSummary[] | null>>()
  const kidsOf = (campaignId: string) => {
    let p = kids.get(campaignId)
    if (!p) {
      p = listChildAdGroups(provider, ctx, campaignId)
      kids.set(campaignId, p)
    }
    return p.catch((e: unknown) => unverifiable(e, campaignId))
  }
  const activating = level === "ad_group" ? ids : []
  const check = async (o: AdObjectSummary) => {
    const b = o.budget
    if (!b || !(b.amount > 0)) return
    const c = (b.currency || cur).toUpperCase()
    const label = `${LEVEL_VI[b.level ?? o.level] ?? o.level} "${String(o.name ?? o.id).slice(0, 80)}" (${o.id})`
    if (b.type === "daily") {
      // flexible daily budget (TikTok, campaign CBO or ad group): one day may spend 125% of it
      return checkDailyCap(s, b.amount, c, `Ngân sách ngày${b.dynamic ? " linh hoạt" : ""} của ${label}`, { dynamic: b.dynamic === true })
    }
    const flight: Flight =
      o.level === "campaign"
        ? await campaignFlightOrDeny(provider, ctx, o, { activating, children: () => kidsOf(o.id) })
        : { startTime: o.startTime, endTime: o.endTime }
    checkLifetimeCap(s, b.amount, c, flight, `Ngân sách trọn đời của ${label}`)
  }
  /** ABO campaign being switched on: its ad sets that are configured on start spending with it */
  const checkChildren = async (campaign: AdObjectDetail) => {
    if (campaign.budget || !adGroupFlightsMatter(provider.platform)) return
    const list = await kidsOf(campaign.id)
    if (list === null) {
      throw denied(
        "budget_unverifiable",
        `Không đọc được danh sách nhóm quảng cáo của chiến dịch ${campaign.id} để kiểm tra trần ngân sách nên chưa bật chạy.`,
        "Thử lại sau, hoặc bật từng nhóm quảng cáo (level ad_group); MCP có trần ngân sách nên không bật khi chưa kiểm tra được."
      )
    }
    for (const k of list) if (isConfiguredOn(k)) await check(k)
  }
  const one = async (id: string) => {
    const o = await get(level, id)
    await check(o)
    if (level === "campaign") await checkChildren(o)
    const adGroupId: string | null = level === "ad" || level === "keyword" ? (o.parentId ?? null) : null
    let campaignId: string | null = level === "campaign" ? null : (o.campaignId ?? (level === "ad_group" ? o.parentId : null) ?? null)
    if (adGroupId) {
      const g = await get("ad_group", adGroupId).catch((e: unknown) => unverifiable(e, id))
      await check(g)
      campaignId ??= g.campaignId ?? g.parentId ?? null
    }
    if (campaignId) await check(await get("campaign", campaignId).catch((e: unknown) => unverifiable(e, id)))
  }
  const queue = [...ids]
  await Promise.all(
    Array.from({ length: Math.min(LOOKUP_CONCURRENCY, queue.length) }, async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) await one(id)
    })
  )
  if (!hasDailyCap || !provider.activationSpend) return undefined
  // worst-case daily spend beyond the reported budget (TikTok GMV Max): must stay within the daily cap
  let spend: ActivationSpend[]
  try {
    spend = await provider.activationSpend(ctx, level, ids)
  } catch (e) {
    if (isProviderError(e) && e.code === "auth_invalid") throw e
    console.warn("[mcp] activation spend check failed", safeErrorForLog(e))
    throw denied(
      "budget_unverifiable",
      `${ACTIVATION_SPEND_UNVERIFIABLE}${isProviderError(e) ? ` ${e.userMessageVi}` : ""}`,
      (isProviderError(e) && e.hint) ||
        "Thử lại sau; MCP có trần ngân sách/ngày nên không bật khi chưa kiểm tra được mức chi tối đa."
    )
  }
  for (const x of spend) {
    checkDailyCap(s, x.maxDailySpend, (x.currency || cur).toUpperCase(), `Mức chi tối đa có thể mỗi ngày của ${x.label}`)
  }
  return spend
}

/** activationSpend failed while the MCP has a daily cap (fail closed). */
export const ACTIVATION_SPEND_UNVERIFIABLE =
  "Không kiểm tra được mức chi tối đa có thể mỗi ngày của đối tượng sắp bật (vd. chiến dịch GMV Max của TikTok có tăng ngân sách tự động) nên chưa bật chạy."

/** activationSpend failed while building a preview without a daily cap (warning only). */
export const ACTIVATION_SPEND_PREVIEW_FAILED =
  "Không đọc được mức chi tối đa có thể mỗi ngày của đối tượng sắp bật (vd. chiến dịch GMV Max có tăng ngân sách tự động / ngày khuyến mãi) - kiểm tra ngân sách trong trình quản lý quảng cáo trước khi đồng ý."

/** Preview lines for provider.activationSpend entries (daily budget + worst-case daily spend). */
export function activationSpendWarnings(spend: ActivationSpend[]): string[] {
  return spend.map((x) => {
    const cur = x.currency.toUpperCase()
    const daily = x.dailyBudget === null ? "không rõ" : fmtMoney(x.dailyBudget, cur)
    const notes = x.notes.length ? ` ${x.notes.join(" ")}` : ""
    return `${x.label}: ngân sách ngày ${daily}; chi tiêu tối đa có thể mỗi ngày ${fmtMoney(x.maxDailySpend, cur)}.${notes}`
  })
}

/**
 * Preview of an activation: the worst-case daily spend lines. Reuses the entries of the cap check; without a daily cap
 * the hook is asked here (preview only, never blocking - a failure becomes a warning).
 */
export async function activationPreviewWarnings(
  env: ToolEnv,
  account: GrantAccount,
  provider: AdsProvider,
  level: ObjectLevel,
  ids: string[],
  checked: ActivationSpend[] | undefined
): Promise<string[]> {
  if (!provider.activationSpend) return []
  if (checked) return activationSpendWarnings(checked)
  try {
    const ctx = await env.providerCtx(account)
    return activationSpendWarnings(await provider.activationSpend(ctx, level, ids))
  } catch (e) {
    console.warn("[mcp] activation spend preview failed", safeErrorForLog(e))
    return [ACTIVATION_SPEND_PREVIEW_FAILED]
  }
}

function unverifiable(e: unknown, id: string): never {
  console.warn("[mcp] activation budget check failed", safeErrorForLog(e))
  throw denied(
    "budget_unverifiable",
    `Không đọc được ngân sách cấp trên của ${id} để kiểm tra trần ngân sách nên chưa bật chạy.`,
    "Thử lại sau, hoặc kiểm tra bằng ads_get_object; MCP có trần ngân sách nên không bật khi chưa kiểm tra được."
  )
}

/** The provider's always-confirm check itself failed: confirmation is required anyway (fail closed). */
export const ALWAYS_CONFIRM_CHECK_FAILED =
  "Không kiểm tra được đối tượng có thuộc loại luôn cần xác nhận hay không (vd. chiến dịch GMV Max của TikTok) - để an toàn, thao tác cần xác nhận 2 bước."

/**
 * Provider hook (TikTok: GMV Max campaigns): reasons why this write (status change, budget / field update, copy,
 * delete) must ALWAYS go through two-step confirmation, even when the MCP disabled it. Asked only when confirmation is
 * off (otherwise it would change nothing and cost platform calls) - ALWAYS then, also when the write quota is spent
 * (no fail-open shortcut). A failing hook → confirmation required (fail closed). No hook → [] (unchanged).
 * The adapters refuse to EXECUTE a GMV Max write that did not come through a consumed confirmation (MutationOptions
 * .confirmed) - defence in depth if this hook ever misses one.
 */
export async function alwaysConfirmReasons(
  env: ToolEnv,
  account: GrantAccount,
  provider: AdsProvider,
  level: ObjectLevel,
  ids: string[],
  op: AlwaysConfirmOp
): Promise<string[]> {
  if (!provider.mustAlwaysConfirm || env.grant.settings.twoStepConfirm) return []
  try {
    const ctx = await env.providerCtx(account)
    return await provider.mustAlwaysConfirm(ctx, level, ids, op)
  } catch (e) {
    console.warn("[mcp] always-confirm check failed", safeErrorForLog(e))
    return [ALWAYS_CONFIRM_CHECK_FAILED]
  }
}

/**
 * runWrite's alwaysConfirm for a generic write tool. A call carrying confirm_token on a platform with the hook always
 * goes through the confirmation flow (the token issued at step 1 is consumed and audited whatever the hook would answer
 * now) - the hook is not asked again. Otherwise the hook's reasons decide (alwaysConfirmReasons).
 */
export async function alwaysConfirmFor(
  env: ToolEnv,
  account: GrantAccount,
  provider: AdsProvider,
  level: ObjectLevel,
  ids: string[],
  op: AlwaysConfirmOp,
  args: { confirm_token?: unknown }
): Promise<{ alwaysConfirm: boolean; reasons: string[] }> {
  const hasConfirmToken = typeof args.confirm_token === "string" && args.confirm_token.trim() !== ""
  if (hasConfirmToken) return { alwaysConfirm: !!provider.mustAlwaysConfirm, reasons: [] }
  const reasons = await alwaysConfirmReasons(env, account, provider, level, ids, op)
  return { alwaysConfirm: reasons.length > 0, reasons }
}

export function register(server: Parameters<typeof registerToolSpec>[0], tctx: ToolContext) {
  const platforms = grantPlatformsWith(tctx.grant, "status")
  if (platforms.length === 0) return
  registerToolSpec(server, tctx, {
    name: NAME,
    title: "Bật / tạm dừng quảng cáo",
    description:
      "Dùng khi cần bật chạy (active) hoặc tạm dừng (paused) 1–50 chiến dịch, nhóm quảng cáo, quảng cáo hoặc keyword (Google) cùng cấp trong một tài khoản. Chiến dịch Video (YouTube) của Google chỉ xem được, không bật/tắt qua API. Gọi ads_list_accounts và ads_list_objects (hoặc ads_get_report) trước để có account_id và id đúng. Khi MCP bật xác nhận 2 bước, lần gọi đầu trả confirmation_required kèm preview và confirm_token; chỉ gọi lại với cùng tham số + confirm_token sau khi người dùng đồng ý. Chiến dịch GMV Max (TikTok) chỉ bật/tắt được khi quản trị viên đã cho phép MCP thay đổi GMV Max, luôn cần xác nhận 2 bước và nên hạn chế bật/tắt. Bật chạy sẽ bắt đầu tiêu tiền.",
    kind: "write",
    annotations: UPDATE_ANNOTATIONS,
    input: z.object({
      platform: platformEnum(platforms),
      account_id: accountIdSchema,
      level: objectLevelSchema,
      ids: z.array(objectIdSchema).min(1).max(MAX_STATUS_IDS),
      status: z.enum(["active", "paused"]),
      ...writeFields,
    }),
    output: writeOutputSchema,
    async handler(args, env) {
      const account = assertGrant(env.grant, { platform: args.platform, accountId: args.account_id, permission: "status" })
      const ids = [...new Set(args.ids)]
      if (ids.length > MAX_STATUS_IDS) throw invalid("too_many_ids", `Tối đa ${MAX_STATUS_IDS} đối tượng mỗi lần.`)
      if (args.level === "keyword" && account.platform !== "google_ads") throw invalid("invalid_level", "level keyword chỉ dùng cho Google Ads.")
      env.log.setTarget({ platform: account.platform, accountId: account.externalId, objectIds: ids })
      const provider = providerFor(account.platform, "set_status")
      const level = args.level as ObjectLevel
      // GMV Max switch / strict daily-spend guard / change history / cumulative started spend (both steps)
      const wopts = writeOptions(env.grant, account)
      // refusals that do not depend on money (TikTok: GMV Max locked) come before the cap checks
      if (provider.preflightWrite) {
        await provider.preflightWrite(await env.providerCtx(account), level, ids, args.status, wopts)
      }
      // activation starts spending: the budgets that govern these objects must respect the caps
      // (objects created/copied paused with a large budget must not be switched on past the guardrails)
      let spend: ActivationSpend[] | undefined
      if (args.status === "active") {
        requireMoneyCaps(env.grant.settings, account.currency, "bật chạy quảng cáo")
        spend = await assertActivationWithinCaps(env, account, provider, level, ids)
      }
      // e.g. TikTok GMV Max: always two-step confirmation, even when the MCP disabled it. On a platform with this hook
      // a call carrying confirm_token always goes through the confirmation flow (the token issued at step 1 is
      // consumed and audited whatever the hook would answer now) - the hook is not asked again.
      const confirm = await alwaysConfirmFor(env, account, provider, level, ids, args.status, args)
      const confirmReasons = confirm.reasons
      return runWrite(env, {
        args,
        account,
        alwaysConfirm: confirm.alwaysConfirm,
        preview: async () => {
          const ctx = await env.providerCtx(account)
          const r = await provider.setStatus(ctx, level, ids, args.status, { ...wopts, dryRun: true })
          const warn =
            args.status === "active"
              ? [
                  ...legacyCapWarning(env.grant.settings, account.currency),
                  "Bật chạy sẽ bắt đầu tiêu ngân sách.",
                  ...(await activationPreviewWarnings(env, account, provider, level, ids, spend)),
                ]
              : []
          return previewFromMutation(r, [...warn, ...confirmReasons.filter((x) => !(r.warnings ?? []).includes(x))])
        },
        execute: async (idempotencyKey, meta) => {
          const ctx = await env.providerCtx(account)
          const r = await provider.setStatus(ctx, level, ids, args.status, { ...wopts, idempotencyKey, confirmed: meta.confirmed })
          return {
            structured: mutationOut(r),
            summary: `Đã ${args.status === "active" ? "bật" : "tạm dừng"} ${ids.length} ${args.level}.`,
            changes: r.changes,
          }
        },
      })
    },
  })
}
