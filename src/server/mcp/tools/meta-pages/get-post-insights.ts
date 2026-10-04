import { z } from "zod"
import {
  getMetaPostInsights,
  POST_METRIC_PRESETS,
  POST_METRICS,
  type PostMetric,
} from "../../../providers/meta/pages"
import { invalid } from "../../errors"
import { assertPageGrant } from "../../grant"
import {
  READ_ANNOTATIONS,
  registerToolSpec,
  type ToolContext,
} from "../../tool"
import { assertInsights, pageContext, pageRef, postIdSchema } from "./shared"

export const NAME = "meta_get_post_insights"

const output = z.object({
  page_id: z.string(),
  page_name: z.string(),
  period: z.literal("lifetime"),
  posts: z.array(
    z.object({
      post_id: z.string(),
      metrics: z.record(z.string(), z.unknown()),
      invalid_metrics: z.array(z.string()),
      error: z.string().nullable(),
    })
  ),
  warnings: z.array(z.string()),
})

export function register(
  server: Parameters<typeof registerToolSpec>[0],
  tctx: ToolContext
) {
  registerToolSpec(server, tctx, {
    name: NAME,
    title: "Chỉ số bài viết Trang",
    description:
      "Dùng khi cần chỉ số (trọn đời) của 1–20 bài viết cùng một Trang Facebook. preset basic (mặc định): post_media_view = lượt xem/hiển thị, post_total_media_view_unique = số người xem, post_clicks, post_clicks_by_type (link clicks, photo view…), post_reactions_by_type_total (like, love…). preset video: post_video_views (3 giây), _organic, _paid, post_video_view_time (ms), post_video_avg_time_watched (ms), post_video_length (ms), post_video_complete_views_organic/_paid. preset all = tất cả; hoặc truyền metrics để chọn từng metric. Cần capabilities.insights của Trang (meta_list_pages). Meta không còn cung cấp impressions/reach kiểu cũ - dùng post_media_view / post_total_media_view_unique.",
    kind: "read",
    annotations: READ_ANNOTATIONS,
    input: z.object({
      post_ids: z
        .array(postIdSchema)
        .min(1)
        .max(20)
        .describe("1–20 post_id của CÙNG một Trang"),
      preset: z.enum(["basic", "video", "all"]).default("basic"),
      metrics: z
        .array(z.enum(POST_METRICS))
        .min(1)
        .max(POST_METRICS.length)
        .optional()
        .describe("Chọn metric cụ thể (ghi đè preset)"),
    }),
    output,
    async handler(args, env) {
      const pageIds = [...new Set(args.post_ids.map((id) => id.split("_")[0]))]
      if (pageIds.length !== 1)
        throw invalid(
          "mixed_pages",
          "Mọi post_id phải thuộc cùng một Trang.",
          "Gọi riêng cho từng Trang."
        )
      const page = assertPageGrant(env.grant, pageIds[0])
      env.log.setTarget({
        platform: "meta",
        objectIds: [page.externalId, ...args.post_ids],
      })
      assertInsights(page)
      const metrics: PostMetric[] =
        args.metrics ?? POST_METRIC_PRESETS[args.preset]
      const ctx = await pageContext(env, page)
      const res = await getMetaPostInsights(
        ctx,
        page.externalId,
        args.post_ids,
        metrics
      )
      const warnings: string[] = []
      const bad = [...new Set(res.flatMap((r) => r.invalidMetrics))]
      if (bad.length)
        warnings.push(`Meta không trả các metric: ${bad.join(", ")}.`)
      if (res.some((r) => r.error))
        warnings.push(
          "Một số bài không lấy được chỉ số - xem trường error của từng bài."
        )
      return {
        structured: {
          ...pageRef(page),
          period: "lifetime" as const,
          posts: res.map((r) => ({
            post_id: r.postId,
            metrics: r.metrics,
            invalid_metrics: r.invalidMetrics,
            error: r.error,
          })),
          warnings,
        },
        summary: `Chỉ số trọn đời của ${res.length} bài viết Trang ${page.name}.`,
      }
    },
  })
}
