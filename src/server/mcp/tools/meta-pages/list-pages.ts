import { inArray } from "drizzle-orm"
import { z } from "zod"
import { db } from "../../../db/client"
import { connections } from "../../../db/schema"
import { decodeCursor, encodeCursor, type CursorBinding } from "../../cursor"
import { invalid } from "../../errors"
import {
  jsonLength,
  MAX_STRUCTURED_CHARS,
  READ_ANNOTATIONS,
  registerToolSpec,
  type ToolContext,
} from "../../tool"
import { capabilitiesOf } from "./shared"

export const NAME = "meta_list_pages"

const output = z.object({
  pages: z.array(
    z.object({
      page_id: z.string(),
      name: z.string(),
      category: z.string().nullable(),
      followers: z.number().nullable(),
      verification: z.string().nullable(),
      business: z.string().nullable(),
      /** what the connection's user may read on this Page */
      capabilities: z.object({
        posts: z.boolean(),
        insights: z.boolean(),
        ads_posts: z.boolean(),
        comments: z.boolean(),
        messages: z.boolean(),
      }),
      connection_status: z.string(),
    })
  ),
  total_pages: z.number(),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
  warnings: z.array(z.string()),
})

export function register(
  server: Parameters<typeof registerToolSpec>[0],
  tctx: ToolContext
) {
  registerToolSpec(server, tctx, {
    name: NAME,
    title: "Danh sách Trang Facebook",
    description:
      "Dùng khi người dùng hỏi về Trang Facebook (fanpage), bài viết hoặc chỉ số của Trang: liệt kê các Trang mà MCP này được phép đọc - page_id, tên, danh mục, số người theo dõi, Business Manager chứa Trang và khả năng đọc (capabilities: posts = bài viết, insights = chỉ số, ads_posts = bài quảng cáo, comments = bình luận, messages = tin nhắn Messenger nếu MCP được bật đọc tin nhắn). Gọi TRƯỚC các tool meta_list_page_posts / meta_get_post / meta_list_post_comments / meta_get_post_insights / meta_get_page_insights để lấy đúng page_id. Lọc theo tên bằng q; nhiều Trang thì dùng next_cursor.",
    kind: "read",
    annotations: READ_ANNOTATIONS,
    input: z.object({
      q: z
        .string()
        .trim()
        .max(100)
        .optional()
        .describe("Lọc theo tên Trang (không phân biệt hoa thường)"),
      limit: z.number().int().min(1).max(200).default(50),
      cursor: z
        .string()
        .max(2_000)
        .optional()
        .describe(
          "next_cursor của lần gọi trước (giữ nguyên các tham số khác)"
        ),
    }),
    output,
    async handler(args, env) {
      const { grant } = env
      env.log.setTarget({ platform: "meta" })
      const q = args.q?.toLocaleLowerCase("vi")
      const pages = grant.pages.filter(
        (p) => !q || p.name.toLocaleLowerCase("vi").includes(q)
      )

      const bind: CursorBinding = {
        mcpId: grant.mcpId,
        tool: NAME,
        accountIds: pages.map((p) => p.id),
        query: { q: q ?? null },
      }
      let offset = 0
      if (args.cursor) {
        const c = decodeCursor<{ o?: number }>(args.cursor, bind)
        if (
          typeof c.o !== "number" ||
          !Number.isInteger(c.o) ||
          c.o < 0 ||
          c.o > pages.length
        )
          throw invalid("invalid_cursor", "cursor không hợp lệ.")
        offset = c.o
      }

      const connIds = [...new Set(pages.map((p) => p.connectionId))]
      const statusOf = new Map<string, string>()
      if (connIds.length) {
        const rows = await db
          .select({ id: connections.id, status: connections.status })
          .from(connections)
          .where(inArray(connections.id, connIds))
        for (const r of rows) statusOf.set(r.id, r.status)
      }
      const row = (p: (typeof pages)[number]) => {
        const caps = capabilitiesOf(p)
        return {
          page_id: p.externalId,
          name: p.name,
          category: p.category,
          followers: p.followersCount,
          verification: p.verificationStatus,
          business: p.businessName,
          capabilities: {
            posts: caps.posts,
            insights: caps.insights,
            ads_posts: caps.adsPosts,
            comments: caps.comments,
            messages: caps.messages,
          },
          connection_status: statusOf.get(p.connectionId) ?? "unknown",
        }
      }
      let page = pages.slice(offset, offset + args.limit).map(row)
      const budget = MAX_STRUCTURED_CHARS - 3_000
      while (page.length > 1 && jsonLength(page) > budget)
        page = page.slice(0, Math.max(1, Math.floor(page.length * 0.8)))
      const nextOffset = offset + page.length
      const nextCursor =
        nextOffset < pages.length ? encodeCursor({ o: nextOffset }, bind) : null

      const warnings: string[] = []
      if (grant.pages.length === 0)
        warnings.push(
          "MCP chưa có Trang nào trong phạm vi (cấu hình ở trang MCP của Ads MCP)."
        )
      else if (pages.length === 0) warnings.push("Không có Trang nào khớp q.")
      const broken = page.filter((p) => p.connection_status === "invalid")
      if (broken.length)
        warnings.push(
          `${broken.length} Trang thuộc kết nối có token lỗi - lệnh trên các Trang này sẽ thất bại cho tới khi cập nhật token.`
        )
      if (nextCursor)
        warnings.push(
          `Còn ${pages.length - nextOffset} Trang nữa - dùng next_cursor để lấy tiếp.`
        )
      return {
        structured: {
          pages: page,
          total_pages: pages.length,
          has_more: nextCursor !== null,
          next_cursor: nextCursor,
          warnings,
        },
        summary: `Có ${pages.length} Trang Facebook trong phạm vi MCP${nextCursor ? ` (trả ${page.length}, còn tiếp)` : ""}.`,
      }
    },
  })
}
