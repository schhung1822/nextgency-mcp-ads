import { z } from "zod"
import type { LookupKind } from "../../../providers/types"
import { assertGrant } from "../../grant"
import { accountIdSchema, lookupKindSchema, platformEnum } from "../../schemas"
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
  warnings: z.array(z.string()),
})

export function register(server: Parameters<typeof registerToolSpec>[0], tctx: ToolContext) {
  const platforms = grantPlatformsWith(tctx.grant, "read")
  if (platforms.length === 0) return
  registerToolSpec(server, tctx, {
    name: NAME,
    title: "Tra cứu tài sản phụ",
    description:
      "Dùng khi cần id của tài sản phụ để tạo/sửa quảng cáo: pages (Fanpage), pixels, instagram_accounts, identities (TikTok), locations, interests, languages, conversion_events, custom_audiences - tuỳ nền tảng hỗ trợ. Gọi ads_list_accounts trước để có account_id; q là chuỗi tìm kiếm (bắt buộc với locations/interests trên đa số nền tảng).",
    kind: "read",
    annotations: READ_ANNOTATIONS,
    input: z.object({
      platform: platformEnum(platforms),
      account_id: accountIdSchema,
      kind: lookupKindSchema,
      q: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }),
    output,
    async handler(args, env) {
      const account = assertGrant(env.grant, { platform: args.platform, accountId: args.account_id, permission: "read" })
      env.log.setTarget({ platform: account.platform, accountId: account.externalId })
      const provider = providerFor(account.platform, "lookup")
      const ctx = await env.providerCtx(account)
      const res = await provider.lookup(ctx, args.kind as LookupKind, { q: args.q, limit: args.limit })
      let items = res.items.slice(0, args.limit).map((i) => ({ id: String(i.id), name: String(i.name ?? ""), ...(i.extra ? { extra: i.extra } : {}) }))
      let truncated = false
      while (items.length > 1 && jsonLength(items) > MAX_STRUCTURED_CHARS - 2_000) {
        items = items.slice(0, Math.floor(items.length * 0.8))
        truncated = true
      }
      return {
        structured: {
          platform: account.platform,
          account_id: account.externalId,
          kind: args.kind,
          items,
          count: items.length,
          truncated,
          warnings: res.warnings ?? [],
        },
        summary: `Tìm thấy ${items.length} ${args.kind}${truncated ? " (đã cắt bớt)" : ""}.`,
      }
    },
  })
}
