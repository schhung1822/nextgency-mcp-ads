// Shared zod schemas for MCP tool inputs/outputs.
import { z } from "zod"
import { DATE_PRESETS } from "../providers/dates"
import { LOOKUP_KINDS, METRIC_PRESETS, NORMALIZED_METRICS, type Platform } from "../providers/types"

/** `platform` enum limited to the platforms the grant allows for the tool's permission. */
export function platformEnum(platforms: readonly Platform[]) {
  return z.enum(platforms as [Platform, ...Platform[]]).describe("Nền tảng quảng cáo")
}

export const accountIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .describe("account_id lấy từ ads_list_accounts (Meta act_…, OpenAI Ads adacct_…)")

export const objectIdSchema = z.string().trim().min(1).max(128)

export const objectLevelSchema = z
  .enum(["campaign", "ad_group", "ad"])
  .describe("Cấp đối tượng: campaign, ad_group (ad set/ad group), ad")

export const reportLevelSchema = z.enum(["account", "campaign", "ad_group", "ad"])

export const datePresetSchema = z.enum(DATE_PRESETS)

export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ngày dạng YYYY-MM-DD")

export const statusFilterSchema = z.enum([
  "active",
  "paused",
  "archived",
  "deleted",
  "removed",
  "pending_review",
  "rejected",
  "disabled",
  "unknown",
])

export const metricPresetSchema = z.enum(METRIC_PRESETS)
export const metricKeySchema = z.enum(NORMALIZED_METRICS)
export const lookupKindSchema = z.enum(LOOKUP_KINDS)

/** Extra fields every write tool accepts. */
export const writeFields = {
  confirm_token: z
    .string()
    .max(200)
    .optional()
    .describe("Chỉ gửi ở bước 2, sau khi người dùng đồng ý với bản xem trước (lấy từ kết quả confirmation_required)"),
  idempotency_key: z.string().max(100).optional().describe("Khoá chống tạo trùng (tuỳ chọn)"),
  reason: z.string().max(500).optional().describe("Lý do thay đổi (ghi vào nhật ký)"),
}

export const toolErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  hint: z.string().nullable().optional(),
})

/** Output shape shared by every write tool (preview step and execution step). */
export const writeOutputSchema = z.object({
  status: z.enum(["confirmation_required", "success"]),
  message: z.string().optional(),
  preview: z
    .object({
      changes: z.array(z.record(z.string(), z.unknown())),
      warnings: z.array(z.string()),
      effective_at: z.string().nullable(),
      details: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  confirm_token: z.string().optional(),
  expires_in_seconds: z.number().optional(),
  replayed: z.boolean().optional(),
  platform: z.string().optional(),
  account_id: z.string().optional(),
  changes: z.array(z.record(z.string(), z.unknown())).optional(),
  warnings: z.array(z.string()).optional(),
  effective_at: z.string().nullable().optional(),
  result: z.record(z.string(), z.unknown()).optional(),
})
