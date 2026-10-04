// Shared helpers of the Facebook Pages tools (meta_list_pages, meta_list_page_posts, meta_get_post,
// meta_get_post_insights, meta_get_page_insights). Read only; every handler calls assertPageGrant FIRST.
import { z } from "zod"
import type { MetaCredentials } from "../../../providers/meta/client"
import {
  pageCapabilities,
  type PageCapabilities,
} from "../../../providers/meta/pages"
import type { ConnectionContext } from "../../../providers/types"
import { denied } from "../../errors"
import type { ToolEnv } from "../../tool"
import type { GrantPage } from "../../types"

export const pageIdSchema = z
  .string()
  .trim()
  .regex(/^\d{1,30}$/, "page_id chỉ gồm chữ số")
  .describe("page_id lấy từ meta_list_pages")

export const postIdSchema = z
  .string()
  .trim()
  .regex(/^\d{1,30}_\d{1,30}$/, "post_id có dạng PAGEID_POSTID")
  .describe("post_id dạng PAGEID_POSTID (lấy từ meta_list_page_posts)")

export const PAGE_INSIGHTS_TZ_NOTE =
  "Ngày của chỉ số Trang theo giờ Los Angeles (America/Los_Angeles) - khác giờ Việt Nam và múi giờ tài khoản quảng cáo; số liệu Meta cập nhật khoảng 24 giờ/lần."

/** Credentials of the connection the Page is granted through (decrypted inside the tool call only). */
export async function pageContext(
  env: ToolEnv,
  page: GrantPage
): Promise<ConnectionContext<MetaCredentials>> {
  return (await env.providerCtx.connection(
    page.connectionId
  )) as ConnectionContext<MetaCredentials>
}

export function capabilitiesOf(page: GrantPage): PageCapabilities {
  return pageCapabilities(page.tasks)
}

/** Insights need the task ANALYZE of the connection's user on the Page. */
export function assertInsights(page: GrantPage) {
  if (!capabilitiesOf(page).insights) {
    throw denied(
      "page_insights_unavailable",
      `Via của kết nối không có quyền xem thông tin chi tiết (task ANALYZE) trên Trang "${page.name}" nên không đọc được chỉ số.`,
      "Cấp cho via quyền xem thông tin chi tiết của Trang rồi đồng bộ lại kết nối trong Ads MCP."
    )
  }
}

export function pageRef(page: GrantPage) {
  return { page_id: page.externalId, page_name: page.name }
}
