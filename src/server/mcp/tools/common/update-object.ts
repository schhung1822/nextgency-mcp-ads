import { z } from "zod"
import { googleScheduleIso } from "../../../providers/google-ads/time"
import type { AdsProvider, ObjectLevel, ObjectUpdate } from "../../../providers/types"
import { campaignFlightOrDeny } from "../../budget-flight"
import { invalid } from "../../errors"
import { assertGrant } from "../../grant"
import { accountIdSchema, objectIdSchema, objectLevelSchema, platformEnum, writeFields, writeOutputSchema } from "../../schemas"
import { providerFor, registerToolSpec, runWrite, UPDATE_ANNOTATIONS, type ToolContext, type ToolEnv } from "../../tool"
import { grantPlatformsWith, type GrantAccount } from "../../types"
import { checkBidCap, checkLifetimeCap, LEVEL_VI, legacyCapWarning, lifetimeLimit, requireMoneyCaps, type Flight } from "../../guardrails"
import { writeOptions } from "../../write-options"
import { alwaysConfirmFor } from "./set-status"
import { mutationOut, previewFromMutation } from "./write-common"

export const NAME = "ads_update_object"

/**
 * A schedule change can shrink the flight of a LIFETIME budget (e.g. end_time pulled in → the same budget over
 * fewer days). Re-check the lifetime cap with the new flight: the object's own lifetime budget and, for an ad
 * group of a campaign with a lifetime budget (CBO), the campaign budget over its ad-set flight.
 * No lifetime limit for the account currency → nothing to read.
 */
export async function assertScheduleWithinCaps(
  env: ToolEnv,
  account: GrantAccount,
  provider: AdsProvider,
  level: ObjectLevel,
  id: string,
  changes: Pick<ObjectUpdate["changes"], "startTime" | "endTime">
): Promise<void> {
  if (level !== "campaign" && level !== "ad_group") return
  const s = env.grant.settings
  const cur = account.currency.toUpperCase()
  if (!lifetimeLimit(s, cur, {})) return
  const ctx = await env.providerCtx(account)
  const obj = await provider.getObject(ctx, level, id)
  // Google rounds a new schedule to whole days (start 00:00:00, end 23:59:59 account time) → check that flight
  const g = account.platform === "google_ads"
  const start = changes.startTime !== undefined && g ? googleScheduleIso(changes.startTime, "start", account.timezone) : changes.startTime
  const end = changes.endTime !== undefined && g ? googleScheduleIso(changes.endTime, "end", account.timezone) : changes.endTime
  const nf: Flight = {
    startTime: start !== undefined ? start : (obj.startTime ?? null),
    endTime: end !== undefined ? end : (obj.endTime ?? null),
  }
  const label = (o: { level: string; name?: string | null; id: string }) =>
    `${LEVEL_VI[o.level] ?? o.level} "${String(o.name ?? o.id).slice(0, 80)}" (${o.id})`
  const b = obj.budget
  if (b && b.type === "lifetime" && b.amount > 0 && (b.level ?? level) === level) {
    const flight = level === "campaign" ? await campaignFlightOrDeny(provider, ctx, { ...obj, ...nf }) : nf
    checkLifetimeCap(s, b.amount, (b.currency || cur).toUpperCase(), flight, `Ngân sách trọn đời của ${label(obj)} với lịch chạy mới`)
  }
  if (level === "ad_group") {
    const campaignId = obj.campaignId ?? obj.parentId ?? null
    if (!campaignId) return
    const campaign = await provider.getObject(ctx, "campaign", campaignId)
    const cb = campaign.budget
    if (!cb || cb.type !== "lifetime" || !(cb.amount > 0)) return
    const flight = await campaignFlightOrDeny(provider, ctx, campaign, { override: { adGroupId: id, ...nf } })
    checkLifetimeCap(s, cb.amount, (cb.currency || cur).toUpperCase(), flight, `Ngân sách trọn đời của ${label(campaign)} với lịch chạy mới của nhóm quảng cáo`)
  }
}

const isoDateTime = z
  .string()
  .max(40)
  .refine((s) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(s) && !Number.isNaN(Date.parse(s)), {
    message: "Thời gian dạng ISO 8601 có múi giờ, vd 2026-10-05T00:00:00+07:00",
  })

const httpUrl = z
  .string()
  .max(2_000)
  .refine((s) => {
    try {
      const u = new URL(s)
      return u.protocol === "https:" || u.protocol === "http:"
    } catch {
      return false
    }
  }, "URL http(s) hợp lệ")

/** ads_update_object input `tiktok_creative` (TikTok ads only) → ObjectUpdate.changes.creative */
export const tiktokCreativeSchema = z
  .object({
    ad_text: z.string().trim().min(1).max(100).optional().describe("Chữ quảng cáo mới (≤ 100 ký tự, không emoji)"),
    call_to_action: z
      .string()
      .regex(/^[A-Z][A-Z_]{1,39}$/, "Mã CTA TikTok, vd LEARN_MORE")
      .optional()
      .describe("Nút CTA mới: LEARN_MORE, SHOP_NOW, SIGN_UP, ORDER_NOW, CONTACT_US, SEND_MESSAGE…"),
    tiktok_item_id: z
      .string()
      .regex(/^\d{1,30}$/, "Id bài đăng TikTok (chuỗi số)")
      .optional()
      .describe("Bài đăng TikTok mới - chỉ cho quảng cáo đang dùng bài đăng (Spark Ads)"),
    video_id: z
      .string()
      .regex(/^[A-Za-z0-9_.-]{1,64}$/, "video_id không hợp lệ")
      .optional()
      .describe("Video mới (ads_upload_media) - chỉ cho quảng cáo video; bắt buộc kèm 1 ảnh bìa trong image_ids"),
    image_ids: z
      .array(z.string().regex(/^[A-Za-z0-9_./-]{1,128}$/, "image_id không hợp lệ"))
      .min(1)
      .max(35)
      .optional()
      .describe("Ảnh mới: video = đúng 1 ảnh bìa; ảnh đơn = 1 ảnh; carousel = 1–35 ảnh (thay toàn bộ)"),
  })
  .strict()

export function register(server: Parameters<typeof registerToolSpec>[0], tctx: ToolContext) {
  const platforms = grantPlatformsWith(tctx.grant, "update")
  if (platforms.length === 0) return
  registerToolSpec(server, tctx, {
    name: NAME,
    title: "Sửa thông tin đối tượng",
    description:
      "Dùng khi cần đổi tên, lịch chạy (start_time/end_time, ISO 8601 có múi giờ), giá thầu (bid_amount, đơn vị chính của tiền tệ tài khoản) hoặc URL đích (final_url) của một chiến dịch, nhóm quảng cáo, quảng cáo hoặc keyword. Quảng cáo TikTok (level=ad) còn sửa được nội dung qua tiktok_creative: ad_text, call_to_action, tiktok_item_id (đổi bài đăng của quảng cáo Spark), video_id (kèm 1 ảnh bìa trong image_ids), image_ids - không đổi loại quảng cáo (bài đăng ↔ video), TikTok sẽ duyệt lại quảng cáo; quảng cáo tin nhắn TikTok giữ nút SEND_MESSAGE, không đổi được lời chào; quảng cáo Smart+ / ACO sửa nội dung trong TikTok Ads Manager. Meta sửa nội dung bằng meta_update_ad_creative. Gọi ads_list_accounts và ads_get_object trước để xem giá trị hiện tại. Đổi ngân sách dùng ads_update_budget; bật/tắt dùng ads_set_status. Có thể trả confirmation_required: cho người dùng xem preview rồi gọi lại với confirm_token khi họ đồng ý.",
    kind: "write",
    annotations: UPDATE_ANNOTATIONS,
    input: z.object({
      platform: platformEnum(platforms),
      account_id: accountIdSchema,
      level: objectLevelSchema,
      id: objectIdSchema,
      name: z.string().trim().min(1).max(400).optional(),
      start_time: isoDateTime.nullable().optional(),
      end_time: isoDateTime.nullable().optional().describe("null = bỏ ngày kết thúc"),
      bid_amount: z.number().positive().max(1e12).nullable().optional().describe("null = bỏ giá thầu thủ công"),
      final_url: httpUrl.optional(),
      tiktok_creative: tiktokCreativeSchema
        .optional()
        .describe("Chỉ TikTok, level=ad: nội dung mới của quảng cáo (chỉ truyền trường cần đổi). TikTok sẽ duyệt lại quảng cáo."),
      ...writeFields,
    }),
    output: writeOutputSchema,
    async handler(args, env) {
      const account = assertGrant(env.grant, { platform: args.platform, accountId: args.account_id, permission: "update" })
      env.log.setTarget({ platform: account.platform, accountId: account.externalId, objectIds: [args.id] })
      if (args.level === "keyword" && account.platform !== "google_ads") throw invalid("invalid_level", "level keyword chỉ dùng cho Google Ads.")
      const changes: ObjectUpdate["changes"] = {}
      if (args.name !== undefined) changes.name = args.name
      if (args.start_time !== undefined) changes.startTime = args.start_time
      if (args.end_time !== undefined) changes.endTime = args.end_time
      if (args.bid_amount !== undefined) changes.bidAmount = args.bid_amount
      if (args.final_url !== undefined) changes.finalUrl = args.final_url
      if (args.tiktok_creative !== undefined) {
        if (account.platform !== "tiktok" || args.level !== "ad") {
          throw invalid(
            "unsupported_field",
            "tiktok_creative chỉ dùng cho quảng cáo TikTok (level=ad).",
            account.platform === "meta"
              ? "Meta: sửa nội dung quảng cáo bằng meta_update_ad_creative."
              : account.platform === "google_ads"
                ? "Google Ads: tạo quảng cáo RSA mới bằng google_ads_create_rsa rồi tạm dừng quảng cáo cũ."
                : account.platform === "openai_ads"
                  ? "OpenAI Ads: tạo quảng cáo mới bằng openai_ads_create_ad rồi tạm dừng quảng cáo cũ."
                  : "Dùng level=ad với id quảng cáo TikTok."
          )
        }
        const t = args.tiktok_creative
        const creative: NonNullable<ObjectUpdate["changes"]["creative"]> = {}
        if (t.ad_text !== undefined) creative.adText = t.ad_text
        if (t.call_to_action !== undefined) creative.callToAction = t.call_to_action
        if (t.tiktok_item_id !== undefined) creative.tiktokItemId = t.tiktok_item_id
        if (t.video_id !== undefined) creative.videoId = t.video_id
        if (t.image_ids !== undefined) creative.imageIds = [...t.image_ids]
        if (Object.keys(creative).length) changes.creative = creative
      }
      if (Object.keys(changes).length === 0) {
        throw invalid(
          "nothing_to_update",
          "Không có trường nào cần sửa.",
          "Truyền ít nhất một trong: name, start_time, end_time, bid_amount, final_url, tiktok_creative (TikTok)."
        )
      }
      if (changes.startTime && changes.endTime && Date.parse(changes.startTime) >= Date.parse(changes.endTime)) {
        throw invalid("invalid_schedule", "start_time phải trước end_time.")
      }
      // L5: refusals that do not depend on money (TikTok: GMV Max locked) come before the cap checks
      const pre = providerFor(account.platform, "update_object")
      if (pre.preflightWrite) {
        await pre.preflightWrite(await env.providerCtx(account), args.level as ObjectLevel, [args.id], "update", writeOptions(env.grant, account))
      }
      // a new schedule or bid can start / raise spend: daily cap mandatory (new MCPs), caps re-checked (both steps)
      const moneyChange = changes.startTime !== undefined || changes.endTime !== undefined || changes.bidAmount !== undefined
      if (moneyChange) requireMoneyCaps(env.grant.settings, account.currency, "đổi lịch chạy hoặc giá thầu")
      if (typeof changes.bidAmount === "number") checkBidCap(env.grant.settings, changes.bidAmount, account.currency, "Giá thầu (bid_amount)")
      const provider = providerFor(account.platform, "update_object")
      if (changes.startTime !== undefined || changes.endTime !== undefined) {
        await assertScheduleWithinCaps(env, account, provider, args.level as ObjectLevel, args.id, changes)
      }
      const update: ObjectUpdate = { level: args.level as ObjectLevel, id: args.id, changes }
      // e.g. TikTok GMV Max: always two-step confirmation; GMV Max switch in the adapter
      const confirm = await alwaysConfirmFor(env, account, provider, args.level as ObjectLevel, [args.id], "update", args)
      const wopts = writeOptions(env.grant, account)
      return runWrite(env, {
        args,
        account,
        alwaysConfirm: confirm.alwaysConfirm,
        preview: async () => {
          const ctx = await env.providerCtx(account)
          const warn = moneyChange ? legacyCapWarning(env.grant.settings, account.currency) : []
          return previewFromMutation(await provider.updateObject(ctx, update, { ...wopts, dryRun: true }), [...warn, ...confirm.reasons])
        },
        execute: async (idempotencyKey, meta) => {
          const ctx = await env.providerCtx(account)
          const r = await provider.updateObject(ctx, update, { ...wopts, idempotencyKey, confirmed: meta.confirmed })
          return {
            structured: mutationOut(r),
            summary: `Đã cập nhật ${Object.keys(changes).length - (changes.creative ? 1 : 0) + Object.keys(changes.creative ?? {}).length} trường của ${args.level} ${args.id}.`,
            changes: r.changes,
          }
        },
      })
    },
  })
}
