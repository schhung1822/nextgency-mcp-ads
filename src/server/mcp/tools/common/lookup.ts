import { z } from "zod"
import type { LookupKind } from "../../../providers/types"
import { assertGrant } from "../../grant"
import { accountIdSchema, lookupKindSchema, lookupParentIdSchema, platformEnum } from "../../schemas"
import { jsonLength, MAX_STRUCTURED_CHARS, providerFor, READ_ANNOTATIONS, registerToolSpec, type ToolContext } from "../../tool"
import { grantPlatformsWith } from "../../types"

export const NAME = "ads_lookup"

const output = z.object({
  platform: z.string(),
  account_id: z.string(),
  kind: z.string(),
  items: z.array(z.object({ id: z.string(), name: z.string(), extra: z.record(z.string(), z.unknown()).optional() })),
  count: z.number(),
  truncated: z.boolean(),
  /** next page of a paged kind (tiktok_posts); null = no more */
  next_cursor: z.string().nullable(),
  warnings: z.array(z.string()),
})

export function register(server: Parameters<typeof registerToolSpec>[0], tctx: ToolContext) {
  const platforms = grantPlatformsWith(tctx.grant, "read")
  if (platforms.length === 0) return
  registerToolSpec(server, tctx, {
    name: NAME,
    title: "Tra cứu tài sản phụ",
    description:
      "Dùng khi cần id của tài sản phụ để tạo/sửa quảng cáo: pages (Fanpage), pixels, instagram_accounts, identities (TikTok), locations, interests, languages, conversion_events, custom_audiences, tiktok_posts (bài đăng TikTok của một identity để chạy Spark Ads: parent_id = identity_id từ kind=identities, identity_type / identity_authorized_bc_id tuỳ chọn - BC_AUTH_TT cần BC id; trả item_id = tiktok_item_id, nội dung, trạng thái hiển thị, used_in_ads ước lượng; trang tiếp theo qua cursor = next_cursor), live_videos (Meta: video trực tiếp của một Trang để chạy quảng cáo video trực tiếp: parent_id = page_id; trả id = object_story_id cho creative existing_post, status LIVE / VOD) - tuỳ nền tảng hỗ trợ. Gọi ads_list_accounts trước để có account_id; q là chuỗi tìm kiếm (bắt buộc với locations/interests trên đa số nền tảng).",
    kind: "read",
    annotations: READ_ANNOTATIONS,
    input: z.object({
      platform: platformEnum(platforms),
      account_id: accountIdSchema,
      kind: lookupKindSchema,
      q: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(100).default(50),
      parent_id: lookupParentIdSchema.optional().describe("kind tiktok_posts: identity_id (ads_lookup kind=identities); kind live_videos: page_id (ads_lookup kind=pages)"),
      identity_type: z
        .enum(["AUTH_CODE", "TT_USER", "BC_AUTH_TT"])
        .optional()
        .describe("Chỉ kind tiktok_posts: loại identity; bỏ trống = tự tra từ danh sách identity"),
      identity_authorized_bc_id: lookupParentIdSchema.optional().describe("Chỉ kind tiktok_posts: ID Business Center, cần với BC_AUTH_TT"),
      cursor: z.string().max(500).optional().describe("Trang tiếp theo: next_cursor của lần gọi trước (cùng tham số)"),
    }),
    output,
    async handler(args, env) {
      const account = assertGrant(env.grant, { platform: args.platform, accountId: args.account_id, permission: "read" })
      env.log.setTarget({ platform: account.platform, accountId: account.externalId })
      const provider = providerFor(account.platform, "lookup")
      const ctx = await env.providerCtx(account)
      const res = await provider.lookup(ctx, args.kind as LookupKind, {
        q: args.q,
        limit: args.limit,
        parentId: args.parent_id,
        identityType: args.identity_type,
        identityAuthorizedBcId: args.identity_authorized_bc_id,
        cursor: args.cursor,
      })
      let items = res.items.slice(0, args.limit).map((i) => ({ id: String(i.id), name: String(i.name ?? ""), ...(i.extra ? { extra: i.extra } : {}) }))
      let truncated = false
      while (items.length > 1 && jsonLength(items) > MAX_STRUCTURED_CHARS - 2_000) {
        items = items.slice(0, Math.floor(items.length * 0.8))
        truncated = true
      }
      const nextCursor = res.nextCursor ?? null
      const warnings = [...(res.warnings ?? [])]
      if (truncated && nextCursor) warnings.push("Kết quả bị cắt cho vừa giới hạn kích thước - gọi lại với limit nhỏ hơn để không bỏ sót mục nào trước next_cursor.")
      return {
        structured: {
          platform: account.platform,
          account_id: account.externalId,
          kind: args.kind,
          items,
          count: items.length,
          truncated,
          next_cursor: nextCursor,
          warnings,
        },
        summary: `Tìm thấy ${items.length} ${args.kind}${truncated ? " (đã cắt bớt)" : ""}${nextCursor ? " - còn trang tiếp theo (next_cursor)" : ""}.`,
      }
    },
  })
}
