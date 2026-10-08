import { z } from "zod"
import type { ObjectLevel } from "../../../providers/types"
import { invalid } from "../../errors"
import { assertGrant } from "../../grant"
import { accountIdSchema, objectIdSchema, objectLevelSchema, platformEnum, writeFields, writeOutputSchema } from "../../schemas"
import { providerFor, registerToolSpec, runWrite, UPDATE_ANNOTATIONS, type ToolContext } from "../../tool"
import { grantPlatformsWith } from "../../types"
import { mutationOut, previewFromMutation } from "./write-common"

export const NAME = "ads_delete_object"

export function register(server: Parameters<typeof registerToolSpec>[0], tctx: ToolContext) {
  const platforms = grantPlatformsWith(tctx.grant, "delete")
  if (platforms.length === 0) return
  registerToolSpec(server, tctx, {
    name: NAME,
    title: "Xoá / lưu trữ đối tượng",
    description:
      "Dùng khi người dùng yêu cầu rõ ràng việc xoá một chiến dịch, nhóm quảng cáo, quảng cáo hoặc keyword (Meta: DELETED, TikTok: delete, Google: remove - trừ chiến dịch Video/YouTube chỉ xem được, OpenAI: archive). KHÔNG hoàn tác được. Luôn có 2 bước: lần gọi đầu trả confirmation_required kèm preview và confirm_token; chỉ gọi lại với cùng tham số + confirm_token sau khi người dùng đồng ý. Muốn ngừng chạy tạm thời thì dùng ads_set_status (paused). Gọi ads_list_accounts và ads_get_object trước để xác định đúng đối tượng.",
    kind: "write",
    annotations: UPDATE_ANNOTATIONS,
    input: z.object({
      platform: platformEnum(platforms),
      account_id: accountIdSchema,
      level: objectLevelSchema,
      id: objectIdSchema,
      ...writeFields,
    }),
    output: writeOutputSchema,
    async handler(args, env) {
      const account = assertGrant(env.grant, { platform: args.platform, accountId: args.account_id, permission: "delete" })
      env.log.setTarget({ platform: account.platform, accountId: account.externalId, objectIds: [args.id] })
      if (args.level === "keyword" && account.platform !== "google_ads") throw invalid("invalid_level", "level keyword chỉ dùng cho Google Ads.")
      const provider = providerFor(account.platform, "delete")
      const level = args.level as ObjectLevel
      return runWrite(env, {
        args,
        account,
        alwaysConfirm: true,
        preview: async () => {
          const ctx = await env.providerCtx(account)
          return previewFromMutation(await provider.deleteObject(ctx, level, args.id, { dryRun: true }), ["Thao tác xoá KHÔNG hoàn tác được."])
        },
        execute: async (idempotencyKey) => {
          const ctx = await env.providerCtx(account)
          const r = await provider.deleteObject(ctx, level, args.id, { idempotencyKey })
          return { structured: mutationOut(r), summary: `Đã xoá ${args.level} ${args.id}.`, changes: r.changes }
        },
      })
    },
  })
}
