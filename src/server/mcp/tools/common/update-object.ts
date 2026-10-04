import { z } from "zod"
import type { ObjectLevel, ObjectUpdate } from "../../../providers/types"
import { invalid } from "../../errors"
import { assertGrant } from "../../grant"
import { accountIdSchema, objectIdSchema, objectLevelSchema, platformEnum, writeFields, writeOutputSchema } from "../../schemas"
import { providerFor, registerToolSpec, runWrite, UPDATE_ANNOTATIONS, type ToolContext } from "../../tool"
import { grantPlatformsWith } from "../../types"
import { checkBidCap } from "../../guardrails"
import { mutationOut, previewFromMutation } from "./write-common"

export const NAME = "ads_update_object"

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

export function register(server: Parameters<typeof registerToolSpec>[0], tctx: ToolContext) {
  const platforms = grantPlatformsWith(tctx.grant, "update")
  if (platforms.length === 0) return
  registerToolSpec(server, tctx, {
    name: NAME,
    title: "Sửa thông tin đối tượng",
    description:
      "Dùng khi cần đổi tên, lịch chạy (start_time/end_time, ISO 8601 có múi giờ), giá thầu (bid_amount, đơn vị chính của tiền tệ tài khoản) hoặc URL đích (final_url) của một chiến dịch, nhóm quảng cáo, quảng cáo hoặc keyword. Gọi ads_list_accounts và ads_get_object trước để xem giá trị hiện tại. Đổi ngân sách dùng ads_update_budget; bật/tắt dùng ads_set_status. Có thể trả confirmation_required: cho người dùng xem preview rồi gọi lại với confirm_token khi họ đồng ý.",
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
      ...writeFields,
    }),
    output: writeOutputSchema,
    async handler(args, env) {
      const account = assertGrant(env.grant, { platform: args.platform, accountId: args.account_id, permission: "update" })
      env.log.setTarget({ platform: account.platform, accountId: account.externalId, objectIds: [args.id] })
      const changes: ObjectUpdate["changes"] = {}
      if (args.name !== undefined) changes.name = args.name
      if (args.start_time !== undefined) changes.startTime = args.start_time
      if (args.end_time !== undefined) changes.endTime = args.end_time
      if (args.bid_amount !== undefined) changes.bidAmount = args.bid_amount
      if (args.final_url !== undefined) changes.finalUrl = args.final_url
      if (Object.keys(changes).length === 0) {
        throw invalid("nothing_to_update", "Không có trường nào cần sửa.", "Truyền ít nhất một trong: name, start_time, end_time, bid_amount, final_url.")
      }
      if (changes.startTime && changes.endTime && Date.parse(changes.startTime) >= Date.parse(changes.endTime)) {
        throw invalid("invalid_schedule", "start_time phải trước end_time.")
      }
      if (typeof changes.bidAmount === "number") checkBidCap(env.grant.settings, changes.bidAmount, account.currency, "Giá thầu (bid_amount)")
      const provider = providerFor(account.platform, "update_object")
      const update: ObjectUpdate = { level: args.level as ObjectLevel, id: args.id, changes }
      return runWrite(env, {
        args,
        account,
        preview: async () => {
          const ctx = await env.providerCtx(account)
          return previewFromMutation(await provider.updateObject(ctx, update, { dryRun: true }))
        },
        execute: async (idempotencyKey) => {
          const ctx = await env.providerCtx(account)
          const r = await provider.updateObject(ctx, update, { idempotencyKey })
          return {
            structured: mutationOut(r),
            summary: `Đã cập nhật ${Object.keys(changes).length} trường của ${args.level} ${args.id}.`,
            changes: r.changes,
          }
        },
      })
    },
  })
}
