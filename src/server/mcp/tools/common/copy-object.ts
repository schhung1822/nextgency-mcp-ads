import { z } from "zod"
import type { AdObjectDetail, CopyRequest, CopyResult, FieldChange } from "../../../providers/types"
import { invalid } from "../../errors"
import { assertGrant } from "../../grant"
import { accountIdSchema, objectIdSchema, platformEnum, writeFields, writeOutputSchema } from "../../schemas"
import { CREATE_ANNOTATIONS, providerFor, registerToolSpec, runWrite, type ToolContext } from "../../tool"
import { grantPlatformsWith } from "../../types"

export const NAME = "ads_copy_object"
export const MAX_DEEP_COPY_ADS = 50

function countAds(node: AdObjectDetail): number {
  if (node.level === "ad") return 1
  return (node.children ?? []).reduce((n, c) => n + countAds(c), 0)
}

function copyChanges(r: CopyResult): FieldChange[] {
  return r.mappings
    .filter((m) => m.newId)
    .map((m) => ({ objectId: m.newId!, level: m.level, field: "copied_from", before: null, after: m.sourceId }))
}

function mappingsOut(r: CopyResult) {
  return r.mappings.slice(0, 200).map((m) => ({
    level: m.level,
    source_id: m.sourceId,
    new_id: m.newId,
    ...(m.error ? { error: m.error } : {}),
  }))
}

export function register(server: Parameters<typeof registerToolSpec>[0], tctx: ToolContext) {
  const platforms = grantPlatformsWith(tctx.grant, "copy")
  if (platforms.length === 0) return
  registerToolSpec(server, tctx, {
    name: NAME,
    title: "Sao chép chiến dịch / nhóm / quảng cáo",
    description: `Dùng khi cần nhân bản một chiến dịch, nhóm quảng cáo hoặc quảng cáo (deep=true để sao cả các cấp con, tối đa ${MAX_DEEP_COPY_ADS} quảng cáo mỗi lần), có thể thêm tiền tố/hậu tố tên và chọn parent đích (target_parent_id). Bản sao LUÔN ở trạng thái tạm dừng; dùng ads_set_status để bật sau. Gọi ads_list_accounts và ads_get_object (include_children) trước để xem cây đối tượng. Kết quả gồm bảng map id cũ → id mới và cảnh báo. Có thể trả confirmation_required: cho người dùng xem preview rồi gọi lại với confirm_token khi họ đồng ý.`,
    kind: "write",
    annotations: CREATE_ANNOTATIONS,
    input: z.object({
      platform: platformEnum(platforms),
      account_id: accountIdSchema,
      level: z.enum(["campaign", "ad_group", "ad"]),
      id: objectIdSchema,
      deep: z.boolean().default(false),
      target_parent_id: objectIdSchema.optional().describe("campaign đích (khi sao nhóm) hoặc nhóm đích (khi sao quảng cáo)"),
      name_prefix: z.string().max(50).optional(),
      name_suffix: z.string().max(50).optional(),
      allow_incomplete_targeting: z
        .boolean()
        .default(false)
        .describe(
          "Chỉ đặt true khi người dùng đã đồng ý rõ ràng: cho phép bản sao thiếu một số tiêu chí nhắm/loại trừ không sao chép được (bản sao có thể nhắm RỘNG hơn bản gốc)."
        ),
      ...writeFields,
    }),
    output: writeOutputSchema,
    async handler(args, env) {
      const account = assertGrant(env.grant, { platform: args.platform, accountId: args.account_id, permission: "copy" })
      env.log.setTarget({ platform: account.platform, accountId: account.externalId, objectIds: [args.id, args.target_parent_id] })
      if (args.level === "campaign" && args.target_parent_id) {
        throw invalid("invalid_target", "Sao chép chiến dịch không có parent đích.", "Bỏ target_parent_id khi level=campaign.")
      }
      const provider = providerFor(account.platform, "copy")
      const ctx = await env.providerCtx(account)
      // deep-copy guardrail: count ads in the tree (both steps)
      let adCount: number | null = null
      if (args.deep && args.level !== "ad") {
        const tree = await provider.getObject(ctx, args.level, args.id, { includeChildren: true })
        adCount = countAds(tree)
        if (adCount > MAX_DEEP_COPY_ADS) {
          throw invalid(
            "copy_too_large",
            `Cây cần sao chép có ${adCount} quảng cáo, vượt giới hạn ${MAX_DEEP_COPY_ADS} quảng cáo mỗi lần.`,
            "Sao chép từng nhóm quảng cáo riêng (level=ad_group) hoặc dùng deep=false."
          )
        }
      }
      const req: CopyRequest = {
        level: args.level,
        id: args.id,
        deep: args.deep,
        targetParentId: args.target_parent_id ?? null,
        namePrefix: args.name_prefix,
        nameSuffix: args.name_suffix,
        allowIncomplete: args.allow_incomplete_targeting,
      }
      return runWrite(env, {
        args,
        account,
        preview: async () => {
          const r = await provider.copyObject(ctx, req, { dryRun: true })
          const planned = r.mappings.length || 1
          return {
            changes: [
              {
                object: args.id,
                object_id: args.id,
                level: args.level,
                field: "copy",
                before: null,
                after: `${planned} đối tượng mới (tạm dừng)${args.target_parent_id ? ` dưới ${args.target_parent_id}` : ""}`,
              },
            ],
            warnings: [
              "Bản sao luôn ở trạng thái tạm dừng.",
              ...(args.allow_incomplete_targeting
                ? ["Đã cho phép sao chép thiếu tiêu chí nhắm/loại trừ - kiểm tra kỹ nhắm mục tiêu của bản sao trước khi bật."]
                : []),
              ...r.warnings,
            ],
            effective_at: null,
            details: { mode: r.mode, deep: args.deep, ads_in_tree: adCount, mappings: mappingsOut(r).slice(0, 50) },
          }
        },
        execute: async (idempotencyKey) => {
          const r = await provider.copyObject(ctx, req, { idempotencyKey })
          const failed = r.mappings.filter((m) => !m.newId).length
          return {
            structured: {
              changes: copyChanges(r).map((c) => ({ object_id: c.objectId, level: c.level, field: c.field, before: null, after: c.after })),
              warnings: r.warnings,
              result: { mode: r.mode, root_new_id: r.rootNewId, mappings: mappingsOut(r), new_status: "paused" },
            },
            summary: `Đã sao chép ${args.level} ${args.id} → ${r.rootNewId ?? "(không tạo được)"} (${r.mappings.length - failed} đối tượng mới, tạm dừng)${failed ? `, ${failed} lỗi` : ""}.`,
            changes: copyChanges(r),
          }
        },
      })
    },
  })
}
