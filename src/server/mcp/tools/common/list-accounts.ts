import { eq, inArray } from "drizzle-orm"
import { z } from "zod"
import { db } from "../../../db/client"
import { adAccounts, connections } from "../../../db/schema"
import { PLATFORMS, type Platform } from "../../../providers/types"
import { invalid } from "../../errors"
import { decodeCursor, encodeCursor, type CursorBinding } from "../../cursor"
import { platformLabel } from "../../grant"
import { platformEnum } from "../../schemas"
import { jsonLength, MAX_STRUCTURED_CHARS, READ_ANNOTATIONS, registerToolSpec, type ToolContext } from "../../tool"
import { grantPlatformsWith } from "../../types"

export const NAME = "ads_list_accounts"

const output = z.object({
  accounts: z.array(
    z.object({
      platform: z.string(),
      account_id: z.string(),
      name: z.string(),
      currency: z.string(),
      timezone: z.string(),
      status: z.string(),
      /** health of the connection (token) behind the account: active | expiring | invalid - calls fail while invalid */
      connection_status: z.string(),
      permissions: z.array(z.string()),
    })
  ),
  platforms: z.array(z.object({ platform: z.string(), permissions: z.array(z.string()), accounts: z.number() })),
  /** accounts in scope (all pages) */
  total_accounts: z.number(),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
  warnings: z.array(z.string()),
})

const DEFAULT_LIMIT = 50

export function register(server: Parameters<typeof registerToolSpec>[0], tctx: ToolContext) {
  const readPlatforms = grantPlatformsWith(tctx.grant, "read")
  if (readPlatforms.length === 0) return
  registerToolSpec(server, tctx, {
    name: NAME,
    title: "Danh sách tài khoản quảng cáo",
    description:
      "Dùng khi bắt đầu mọi yêu cầu: liệt kê các tài khoản quảng cáo mà MCP này được phép dùng - nền tảng, account_id, tên, tiền tệ, múi giờ, trạng thái và quyền khả dụng (read/status/update/copy/create/delete) theo từng nền tảng. Gọi tool này TRƯỚC các tool khác để lấy đúng account_id; tiền tệ và múi giờ ở đây là đơn vị/múi giờ mà các tool khác dùng. Nhiều tài khoản thì kết quả phân trang: dùng next_cursor để lấy tiếp.",
    kind: "read",
    annotations: READ_ANNOTATIONS,
    input: z.object({
      platform: platformEnum(readPlatforms).optional(),
      limit: z.number().int().min(1).max(200).default(DEFAULT_LIMIT),
      cursor: z.string().max(2_000).optional().describe("next_cursor của lần gọi trước (giữ nguyên các tham số khác)"),
    }),
    output,
    async handler(args, env) {
      const { grant } = env
      const platforms = (args.platform ? [args.platform] : PLATFORMS.filter((p) => readPlatforms.includes(p))) as Platform[]
      // re-check the platform against the grant (never trust the enum)
      const allowed = platforms.filter((p) => grantPlatformsWith(grant, "read").includes(p))
      const accounts = grant.accounts.filter((a) => allowed.includes(a.platform))
      env.log.setTarget({ platform: args.platform ?? null })

      const statusById = new Map<string, { status: string; connection: string }>()
      if (accounts.length > 0) {
        const rows = await db
          .select({ id: adAccounts.id, status: adAccounts.status, connection: connections.status })
          .from(adAccounts)
          .innerJoin(connections, eq(connections.id, adAccounts.connectionId))
          .where(inArray(adAccounts.id, accounts.map((a) => a.id)))
        for (const r of rows) statusById.set(r.id, { status: r.status, connection: r.connection })
      }

      const warnings: string[] = []
      for (const p of allowed) {
        if (!accounts.some((a) => a.platform === p)) {
          warnings.push(`${platformLabel(p)}: MCP chưa có tài khoản quảng cáo nào đang bật.`)
        }
      }
      const broken = accounts.filter((a) => statusById.get(a.id)?.connection === "invalid")
      if (broken.length > 0) {
        warnings.push(
          `${broken.length} tài khoản thuộc kết nối có token lỗi (connection_status = invalid) - mọi lệnh trên các tài khoản này sẽ thất bại cho tới khi chủ MCP cập nhật token trong trang Kết nối: ${broken
            .slice(0, 10)
            .map((a) => a.externalId)
            .join(", ")}.`
        )
      }
      // pagination (an MCC can expose hundreds of accounts): signed cursor bound to this MCP + the accounts in scope
      const bind: CursorBinding = { mcpId: grant.mcpId, tool: NAME, accountIds: accounts.map((a) => a.id), query: { p: args.platform ?? null } }
      let offset = 0
      if (args.cursor) {
        const c = decodeCursor<{ o?: number }>(args.cursor, bind)
        if (typeof c.o !== "number" || !Number.isInteger(c.o) || c.o < 0 || c.o > accounts.length) throw invalid("invalid_cursor", "cursor không hợp lệ.")
        offset = c.o
      }
      const row = (a: (typeof accounts)[number]) => ({
        platform: a.platform,
        account_id: a.externalId,
        name: a.name,
        currency: a.currency,
        timezone: a.timezone,
        status: statusById.get(a.id)?.status ?? "unknown",
        connection_status: statusById.get(a.id)?.connection ?? "unknown",
        permissions: grant.permissions[a.platform] ?? [],
      })
      let page = accounts.slice(offset, offset + args.limit).map(row)
      // keep each answer within the size budget: cut rows (never below one) and continue with the cursor
      const budget = MAX_STRUCTURED_CHARS - 3_000
      while (page.length > 1 && jsonLength(page) > budget) page = page.slice(0, Math.max(1, Math.floor(page.length * 0.8)))
      const nextOffset = offset + page.length
      const nextCursor = nextOffset < accounts.length ? encodeCursor({ o: nextOffset }, bind) : null
      if (nextCursor) warnings.push(`Còn ${accounts.length - nextOffset} tài khoản nữa - dùng next_cursor để lấy tiếp.`)
      const structured = {
        accounts: page,
        platforms: allowed.map((p) => ({
          platform: p,
          permissions: grant.permissions[p] ?? [],
          accounts: accounts.filter((a) => a.platform === p).length,
        })),
        total_accounts: accounts.length,
        has_more: nextCursor !== null,
        next_cursor: nextCursor,
        warnings,
      }
      return {
        structured,
        summary: `Có ${accounts.length} tài khoản quảng cáo trên ${allowed.length} nền tảng trong phạm vi MCP${nextCursor ? ` (trả ${page.length}, còn tiếp - dùng next_cursor)` : ""}.`,
      }
    },
  })
}
