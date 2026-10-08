import { z } from "zod"
import { safeErrorForLog } from "../../../audit/safe-error"
import type { AdObjectDetail, AdObjectSummary, AdsProvider, ObjectLevel } from "../../../providers/types"
import { adGroupFlightsMatter, campaignFlightOrDeny, isConfiguredOn, listChildAdGroups } from "../../budget-flight"
import { denied, invalid } from "../../errors"
import { assertGrant } from "../../grant"
import { checkDailyCap, checkLifetimeCap, LEVEL_VI, legacyCapWarning, requireMoneyCaps, type Flight } from "../../guardrails"
import { accountIdSchema, objectIdSchema, objectLevelSchema, platformEnum, writeFields, writeOutputSchema } from "../../schemas"
import { providerFor, registerToolSpec, runWrite, UPDATE_ANNOTATIONS, type ToolContext, type ToolEnv } from "../../tool"
import { grantPlatformsWith, type GrantAccount } from "../../types"
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
 * No cap configured for the account currency → nothing to read.
 */
export async function assertActivationWithinCaps(
  env: ToolEnv,
  account: GrantAccount,
  provider: AdsProvider,
  level: ObjectLevel,
  ids: string[]
): Promise<void> {
  const s = env.grant.settings
  const cur = account.currency.toUpperCase()
  const hasCap = (s.maxDailyBudget?.[cur] ?? 0) > 0 || (s.maxLifetimeBudget?.[cur] ?? 0) > 0
  if (!hasCap) return
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
}

function unverifiable(e: unknown, id: string): never {
  console.warn("[mcp] activation budget check failed", safeErrorForLog(e))
  throw denied(
    "budget_unverifiable",
    `Không đọc được ngân sách cấp trên của ${id} để kiểm tra trần ngân sách nên chưa bật chạy.`,
    "Thử lại sau, hoặc kiểm tra bằng ads_get_object; MCP có trần ngân sách nên không bật khi chưa kiểm tra được."
  )
}

export function register(server: Parameters<typeof registerToolSpec>[0], tctx: ToolContext) {
  const platforms = grantPlatformsWith(tctx.grant, "status")
  if (platforms.length === 0) return
  registerToolSpec(server, tctx, {
    name: NAME,
    title: "Bật / tạm dừng quảng cáo",
    description:
      "Dùng khi cần bật chạy (active) hoặc tạm dừng (paused) 1–50 chiến dịch, nhóm quảng cáo, quảng cáo hoặc keyword (Google) cùng cấp trong một tài khoản. Chiến dịch Video (YouTube) của Google chỉ xem được, không bật/tắt qua API. Gọi ads_list_accounts và ads_list_objects (hoặc ads_get_report) trước để có account_id và id đúng. Khi MCP bật xác nhận 2 bước, lần gọi đầu trả confirmation_required kèm preview và confirm_token; chỉ gọi lại với cùng tham số + confirm_token sau khi người dùng đồng ý. Bật chạy sẽ bắt đầu tiêu tiền.",
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
      // activation starts spending: the budgets that govern these objects must respect the caps
      // (objects created/copied paused with a large budget must not be switched on past the guardrails)
      if (args.status === "active") {
        requireMoneyCaps(env.grant.settings, account.currency, "bật chạy quảng cáo")
        await assertActivationWithinCaps(env, account, provider, level, ids)
      }
      return runWrite(env, {
        args,
        account,
        preview: async () => {
          const ctx = await env.providerCtx(account)
          const r = await provider.setStatus(ctx, level, ids, args.status, { dryRun: true })
          const warn =
            args.status === "active"
              ? [...legacyCapWarning(env.grant.settings, account.currency), "Bật chạy sẽ bắt đầu tiêu ngân sách."]
              : []
          return previewFromMutation(r, warn)
        },
        execute: async (idempotencyKey) => {
          const ctx = await env.providerCtx(account)
          const r = await provider.setStatus(ctx, level, ids, args.status, { idempotencyKey })
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
