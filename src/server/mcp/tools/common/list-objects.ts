import { z } from "zod"
import type { ObjectLevel } from "../../../providers/types"
import { decodeCursor, encodeCursor, type CursorBinding } from "../../cursor"
import { collectFanout, positionAfter } from "../../fanout"
import { assertGrant } from "../../grant"
import { accountIdSchema, objectIdSchema, objectLevelSchema, platformEnum, statusFilterSchema } from "../../schemas"
import { jsonLength, MAX_STRUCTURED_CHARS, providerFor, READ_ANNOTATIONS, registerToolSpec, type ToolContext } from "../../tool"
import { grantPlatformsWith } from "../../types"
import { objectSummaryOut } from "./shape"

export const NAME = "ads_list_objects"

const output = z.object({
  platform: z.string(),
  account_id: z.string(),
  currency: z.string(),
  level: z.string(),
  items: z.array(z.record(z.string(), z.unknown())),
  count: z.number(),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
  truncated: z.boolean(),
  warnings: z.array(z.string()),
})

export function register(server: Parameters<typeof registerToolSpec>[0], tctx: ToolContext) {
  const platforms = grantPlatformsWith(tctx.grant, "read")
  if (platforms.length === 0) return
  registerToolSpec(server, tctx, {
    name: NAME,
    title: "Liệt kê chiến dịch / nhóm / quảng cáo",
    description:
      "Dùng khi cần danh sách chiến dịch, nhóm quảng cáo (ad set/ad group), hoặc quảng cáo của một tài khoản: id, tên, trạng thái, ngân sách (đơn vị chính + tiền tệ), lịch chạy, mục tiêu. Gọi ads_list_accounts trước để lấy account_id. Lọc theo parent_id (campaign của nhóm, nhóm của quảng cáo), trạng thái, tên chứa chuỗi; phân trang bằng next_cursor. Dùng kết quả để lấy đúng id trước khi gọi ads_get_object, ads_set_status, ads_update_budget…",
    kind: "read",
    annotations: READ_ANNOTATIONS,
    input: z.object({
      platform: platformEnum(platforms),
      account_id: accountIdSchema,
      level: objectLevelSchema,
      parent_id: objectIdSchema.optional().describe("campaign id (khi level=ad_group) hoặc ad_group id (khi level=ad)"),
      statuses: z.array(statusFilterSchema).max(9).optional(),
      name_contains: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(200).default(50),
      cursor: z.string().max(4_000).optional(),
    }),
    output,
    async handler(args, env) {
      const account = assertGrant(env.grant, { platform: args.platform, accountId: args.account_id, permission: "read" })
      env.log.setTarget({ platform: account.platform, accountId: account.externalId, objectIds: [args.parent_id] })
      const provider = providerFor(account.platform, "list_objects")
      // signed cursor bound to this MCP + tool + account + query (H2)
      const bind: CursorBinding = {
        mcpId: env.grant.mcpId,
        tool: NAME,
        accountIds: [account.id],
        query: { a: account.id, l: args.level, p: args.parent_id ?? null, s: args.statuses ?? null, n: args.name_contains ?? null },
      }
      let start = { i: 0, c: null as string | null, s: 0, p: args.limit }
      if (args.cursor) {
        const c = decodeCursor<{ c?: string | null; s?: number; p?: number }>(args.cursor, bind)
        start = { i: 0, c: c.c ?? null, s: Math.max(0, c.s ?? 0), p: Math.min(Math.max(1, c.p ?? args.limit), 500) }
      }
      const warnings = new Set<string>()
      const result = await collectFanout({
        sourceCount: 1,
        start,
        maxItems: args.limit,
        pageSize: args.limit,
        concurrency: 1,
        signal: env.signal,
        fetch: async (_i, cursor, pageSize) => {
          const ctx = await env.providerCtx(account)
          const page = await provider.listObjects(ctx, {
            level: args.level as ObjectLevel,
            parentId: args.parent_id ?? null,
            statuses: args.statuses,
            nameContains: args.name_contains,
            cursor,
            limit: pageSize,
          })
          for (const w of page.warnings ?? []) warnings.add(w)
          return { items: page.items, nextCursor: page.nextCursor }
        },
      })
      if (result.errors.length) throw result.errors[0]!.error
      let items = result.items.map((x) => objectSummaryOut(x.item))
      let kept = items.length
      let size = 0
      for (let i = 0; i < items.length; i++) {
        size += jsonLength(items[i]) + 1
        if (size > MAX_STRUCTURED_CHARS - 2_000) {
          kept = Math.max(1, i)
          break
        }
      }
      const truncated = kept < items.length
      items = items.slice(0, kept)
      const next = positionAfter(result, kept)
      const nextCursor = next ? encodeCursor({ c: next.c, s: next.s, p: next.p }, bind) : null
      if (truncated) warnings.add("Kết quả bị cắt bớt để vừa giới hạn kích thước; dùng next_cursor để lấy tiếp.")
      return {
        structured: {
          platform: account.platform,
          account_id: account.externalId,
          currency: account.currency,
          level: args.level,
          items,
          count: items.length,
          has_more: nextCursor !== null,
          next_cursor: nextCursor,
          truncated,
          warnings: [...warnings],
        },
        summary: `${items.length} ${args.level} trong tài khoản ${account.name} (${account.externalId})${nextCursor ? ", còn tiếp - dùng next_cursor" : ""}.`,
      }
    },
  })
}
