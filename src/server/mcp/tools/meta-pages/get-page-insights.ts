import { z } from "zod"
import { addDays, todayInTz } from "../../../providers/dates"
import {
  getMetaPageInsights,
  PAGE_INSIGHTS_TZ,
  PAGE_METRIC_PRESETS,
  PAGE_METRICS,
  type PageMetric,
} from "../../../providers/meta/pages"
import { invalid } from "../../errors"
import { assertPageGrant } from "../../grant"
import { isoDateSchema } from "../../schemas"
import {
  jsonLength,
  MAX_STRUCTURED_CHARS,
  READ_ANNOTATIONS,
  registerToolSpec,
  type ToolContext,
} from "../../tool"
import {
  assertInsights,
  PAGE_INSIGHTS_TZ_NOTE,
  pageContext,
  pageIdSchema,
  pageRef,
} from "./shared"

export const NAME = "meta_get_page_insights"

const PRESET_DAYS = {
  last_7d: 7,
  last_28d: 28,
  last_30d: 30,
  last_90d: 90,
} as const

const output = z.object({
  page_id: z.string(),
  page_name: z.string(),
  timezone: z.string(),
  period: z.string(),
  since: z.string(),
  until: z.string(),
  rows: z.array(z.record(z.string(), z.unknown())),
  totals: z.record(z.string(), z.number()),
  rows_truncated: z.boolean(),
  warnings: z.array(z.string()),
})

export function register(
  server: Parameters<typeof registerToolSpec>[0],
  tctx: ToolContext
) {
  registerToolSpec(server, tctx, {
    name: NAME,
    title: "Chỉ số Trang Facebook theo ngày",
    description:
      "Dùng khi cần chỉ số của một Trang Facebook theo ngày/tuần/28 ngày. preset overview (mặc định): page_media_view = lượt xem nội dung, page_total_media_view_unique = người xem, page_post_engagements = tương tác bài, page_total_actions = click liên hệ/CTA, page_views_total = lượt xem Trang, page_follows = tổng người theo dõi, page_daily_follows_unique / page_daily_unfollows_unique = theo dõi mới / bỏ theo dõi. preset video: page_video_views (3s), _paid, _organic, page_video_complete_views_30s, page_video_view_time (ms). Chọn khoảng bằng date_preset (last_7d, last_28d, last_30d, last_90d - không gồm hôm nay) hoặc since/until (YYYY-MM-DD, tối đa 2 năm). NGÀY THEO GIỜ LOS ANGELES (America/Los_Angeles), không phải giờ Việt Nam. totals chỉ cộng các metric cộng dồn được (period=day). Cần capabilities.insights (meta_list_pages); Trang dưới 100 lượt thích không có số liệu.",
    kind: "read",
    annotations: READ_ANNOTATIONS,
    input: z.object({
      page_id: pageIdSchema,
      date_preset: z
        .enum(["last_7d", "last_28d", "last_30d", "last_90d"])
        .optional(),
      since: isoDateSchema
        .optional()
        .describe("Từ ngày (YYYY-MM-DD, giờ Los Angeles)"),
      until: isoDateSchema
        .optional()
        .describe("Đến ngày (YYYY-MM-DD, giờ Los Angeles, tính cả ngày này)"),
      period: z.enum(["day", "week", "days_28"]).default("day"),
      preset: z.enum(["overview", "video"]).default("overview"),
      metrics: z
        .array(z.enum(PAGE_METRICS))
        .min(1)
        .max(PAGE_METRICS.length)
        .optional()
        .describe("Chọn metric cụ thể (ghi đè preset)"),
    }),
    output,
    async handler(args, env) {
      const page = assertPageGrant(env.grant, args.page_id)
      env.log.setTarget({ platform: "meta", objectIds: [page.externalId] })
      assertInsights(page)
      let since = args.since
      let until = args.until
      if (args.date_preset) {
        if (since || until)
          throw invalid(
            "invalid_range",
            "Chỉ dùng date_preset HOẶC since/until."
          )
        const today = todayInTz(PAGE_INSIGHTS_TZ)
        since = addDays(today, -PRESET_DAYS[args.date_preset])
        until = addDays(today, -1)
      }
      if (!since || !until)
        throw invalid(
          "invalid_range",
          "Cần date_preset hoặc cả since và until."
        )
      const metrics: PageMetric[] =
        args.metrics ?? PAGE_METRIC_PRESETS[args.preset]
      const ctx = await pageContext(env, page)
      const res = await getMetaPageInsights(ctx, page.externalId, {
        since,
        until,
        period: args.period,
        metrics,
      })

      let rows = res.rows as Record<string, unknown>[]
      let truncated = false
      const budget = MAX_STRUCTURED_CHARS - 4_000
      if (jsonLength(rows) > budget) {
        // keep the most recent days; totals still cover the whole range
        while (rows.length > 1 && jsonLength(rows) > budget)
          rows = rows.slice(Math.ceil(rows.length * 0.2))
        truncated = true
      }
      const warnings = [PAGE_INSIGHTS_TZ_NOTE, ...res.warnings]
      if (truncated) {
        warnings.push(
          `Chỉ trả ${rows.length} dòng gần nhất (từ ${String(rows[0]?.date ?? "")}) vì kết quả quá dài - thu hẹp khoảng ngày, giảm số metric${args.period === "day" ? " hoặc dùng period=week" : ""}. totals vẫn tính trên cả khoảng.`
        )
      }
      return {
        structured: {
          ...pageRef(page),
          timezone: res.timezone,
          period: res.period,
          since,
          until,
          rows,
          totals: res.totals,
          rows_truncated: truncated,
          warnings,
        },
        summary: `Chỉ số Trang ${page.name} từ ${since} đến ${until} (giờ Los Angeles, ${res.rows.length} mốc ${args.period}).`,
      }
    },
  })
}
