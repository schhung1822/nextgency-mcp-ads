// Generic registration of every provider's platform-specific tools (AdsProvider.extensions).
// Input = extension zod input + account_id (+ confirm_token / idempotency_key / reason for writes).
// Permission = extension.permission on that platform; writes go through two-step confirmation
// (opts.dryRun first). Extensions with invalid names / clashing names are skipped with a warning.
import { z } from "zod"
import { getProvider, hasProvider } from "../../providers/registry"
import { PLATFORMS, type FieldChange, type MutationResult, type Platform, type ProviderExtension } from "../../providers/types"
import { previewChanges, type PreviewInfo } from "../confirm"
import { denied } from "../errors"
import { assertGrant } from "../grant"
import { enforceMoneyItems, moneyLikePaths } from "../guardrails"
import { changesForLog } from "../logging"
import { accountIdSchema, writeFields } from "../schemas"
import {
  CREATE_ANNOTATIONS,
  jsonLength,
  MAX_STRUCTURED_CHARS,
  READ_ANNOTATIONS,
  registerToolSpec,
  runWrite,
  UPDATE_ANNOTATIONS,
  type ToolContext,
} from "../tool"
import { grantAllows } from "../types"

/** Tool-name prefix per platform shipped in this build (an extension of any other platform is skipped). */
const PREFIX: Partial<Record<Platform, string>> = {
  meta: "meta_",
  openai_ads: "openai_ads_",
}
const NAME_RE = /^[a-z0-9_]{3,40}$/
const RESERVED_KEYS = new Set(["account_id", "confirm_token", "idempotency_key", "reason"])

function isMutationResult(v: unknown): v is MutationResult {
  return !!v && typeof v === "object" && Array.isArray((v as MutationResult).changes) && Array.isArray((v as MutationResult).warnings)
}

/** Every created id appears in the changes (the logs "Trước → Sau" table reads only `changes`). */
export function withCreatedIds(changes: FieldChange[], createdIds: string[] | undefined, permission: string): FieldChange[] {
  const out = [...changes]
  const seen = new Set(out.map((c) => c.objectId))
  for (const id of createdIds ?? []) {
    if (!seen.has(id)) out.push({ objectId: id, field: "created", before: null, after: permission === "create" ? "đã tạo (tạm dừng)" : "đã tạo" })
  }
  return out
}

function asRecord(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>
  return { value: v ?? null }
}

/** Validate an extension definition; returns a reason when it must be skipped. */
export function extensionProblem(platform: Platform, ext: ProviderExtension, taken: Set<string>): string | null {
  if (!NAME_RE.test(ext.name)) return "invalid name"
  const prefix = PREFIX[platform]
  if (!prefix) return "platform not released in this build"
  if (!ext.name.startsWith(prefix)) return `name must start with ${prefix}`
  if (ext.name.startsWith("ads_")) return "ads_ prefix is reserved"
  if (taken.has(ext.name)) return "duplicate name"
  if (!["read", "update", "create"].includes(ext.permission)) return "invalid permission"
  if (ext.write && ext.permission === "read") return "write extension cannot use read permission"
  if (!(ext.input instanceof z.ZodObject)) return "input must be a z.object"
  const shape = (ext.input as z.ZodObject).shape as Record<string, unknown>
  for (const k of Object.keys(shape)) if (RESERVED_KEYS.has(k)) return `input uses reserved key ${k}`
  return null
}

const warned = new Set<string>()

export function registerExtensions(server: Parameters<typeof registerToolSpec>[0], tctx: ToolContext, taken: Set<string>) {
  for (const platform of PLATFORMS) {
    if (!hasProvider(platform)) continue
    const provider = getProvider(platform)
    for (const ext of provider.extensions ?? []) {
      const problem = extensionProblem(platform, ext, taken)
      if (problem) {
        const key = `${platform}:${ext.name}:${problem}`
        if (!warned.has(key)) {
          warned.add(key)
          console.warn(`[mcp] skipped extension ${ext.name} (${platform}): ${problem}`)
        }
        continue
      }
      if (!grantAllows(tctx.grant, platform, ext.permission)) continue
      taken.add(ext.name)
      registerOne(server, tctx, platform, ext)
    }
  }
}

function registerOne(server: Parameters<typeof registerToolSpec>[0], tctx: ToolContext, platform: Platform, ext: ProviderExtension) {
  const base = ext.input as z.ZodObject
  const input = base.extend({
    account_id: accountIdSchema,
    ...(ext.write ? writeFields : {}),
  })
  const annotations = !ext.write ? READ_ANNOTATIONS : ext.permission === "create" ? CREATE_ANNOTATIONS : UPDATE_ANNOTATIONS
  const output = z.object({
    status: z.string().optional(),
    platform: z.string().optional(),
    account_id: z.string().optional(),
    result: z.unknown().optional(),
    preview: z.unknown().optional(),
    confirm_token: z.string().optional(),
    expires_in_seconds: z.number().optional(),
    message: z.string().optional(),
    replayed: z.boolean().optional(),
    changes: z.array(z.record(z.string(), z.unknown())).optional(),
    warnings: z.array(z.string()).optional(),
    effective_at: z.string().nullable().optional(),
    truncated: z.boolean().optional(),
  })

  registerToolSpec(server, tctx, {
    name: ext.name,
    title: ext.title,
    description: ext.description.slice(0, 1_500),
    kind: ext.write ? "write" : "read",
    annotations,
    input,
    output,
    async handler(args, env) {
      // idempotency_key stays in args: runWrite derives the deterministic adapter key from it
      const { account_id, confirm_token: _c, idempotency_key: _i, reason: _r, ...rest } = args as Record<string, unknown> & {
        account_id: string
      }
      const account = assertGrant(env.grant, { platform, accountId: account_id, permission: ext.permission })
      env.log.setTarget({ platform, accountId: account.externalId })
      // re-validate with the provider's own schema (strips the mcp-core fields)
      const parsed = (ext.input as z.ZodObject).parse(rest)

      if (ext.write) {
        // money guardrails (both steps, before preview/execute): create tools must not bypass the caps
        if (ext.moneyOf) {
          enforceMoneyItems(env.grant.settings, account.currency, ext.moneyOf(parsed))
        } else {
          const paths = moneyLikePaths(parsed)
          if (paths.length) {
            throw denied(
              "money_fields_undeclared",
              `Tool ${ext.name} nhận giá trị tiền (${paths.slice(0, 3).join(", ")}) nhưng chưa khai báo để kiểm tra trần ngân sách/giá thầu - từ chối để an toàn.`,
              "Báo quản trị viên cập nhật adapter (moneyOf)."
            )
          }
        }
      }

      if (!ext.write) {
        const ctx = await env.providerCtx(account)
        const out = await ext.run(ctx, parsed, {})
        let result: unknown = out
        let truncated = false
        if (jsonLength(result) > MAX_STRUCTURED_CHARS) {
          truncated = true
          result = { _truncated: true, preview: JSON.stringify(out).slice(0, MAX_STRUCTURED_CHARS - 500) }
        }
        return {
          structured: { platform, account_id: account.externalId, result, truncated },
          summary: `${ext.title}: hoàn tất${truncated ? " (kết quả đã bị cắt bớt)" : ""}.`,
        }
      }

      return runWrite(env, {
        args: args as Record<string, unknown>,
        account,
        preview: async (): Promise<PreviewInfo> => {
          const ctx = await env.providerCtx(account)
          const r = await ext.run(ctx, parsed, { dryRun: true })
          if (isMutationResult(r)) {
            // adapters may attach the request body they would send (`payload`) - shown when small
            const payload = (r as MutationResult & { payload?: unknown }).payload
            const details = payload !== undefined && jsonLength(payload) <= 8_000 ? { payload } : undefined
            return {
              changes: previewChanges(r.changes),
              warnings: [...(ext.permission === "create" ? ["Đối tượng mới luôn được tạo ở trạng thái tạm dừng."] : []), ...r.warnings],
              effective_at: r.effectiveAt ?? null,
              ...(details ? { details } : {}),
            }
          }
          const details = asRecord(r)
          return {
            changes: [{ object: ext.name, object_id: "-", level: null, field: ext.permission, before: null, after: "xem details" }],
            warnings: ext.permission === "create" ? ["Đối tượng mới luôn được tạo ở trạng thái tạm dừng."] : [],
            effective_at: null,
            details: jsonLength(details) > 8_000 ? { _truncated: true } : details,
          }
        },
        execute: async (idempotencyKey) => {
          const ctx = await env.providerCtx(account)
          const r = await ext.run(ctx, parsed, { idempotencyKey })
          if (isMutationResult(r)) {
            if (r.createdIds?.length) env.log.addObjectIds(r.createdIds)
            const changes = withCreatedIds(r.changes, r.createdIds, ext.permission)
            return {
              structured: {
                changes: (changesForLog(changes) ?? []) as unknown as Record<string, unknown>[],
                warnings: r.warnings,
                effective_at: r.effectiveAt ?? null,
                result: { created_ids: r.createdIds ?? [] },
              },
              summary: `${ext.title}: hoàn tất${r.createdIds?.length ? ` (id mới: ${r.createdIds.slice(0, 5).join(", ")})` : ""}.`,
              changes,
            }
          }
          const result = jsonLength(r) > MAX_STRUCTURED_CHARS ? { _truncated: true } : (r ?? null)
          return {
            structured: { result },
            summary: `${ext.title}: hoàn tất.`,
            changes: [{ objectId: "-", field: ext.permission === "create" ? "create" : ext.name, before: null, after: result }],
          }
        },
      })
    },
  })
}
