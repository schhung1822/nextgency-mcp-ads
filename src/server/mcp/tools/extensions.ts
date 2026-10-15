// Generic registration of every provider's platform-specific tools (AdsProvider.extensions).
// Input = extension zod input + account_id (+ confirm_token / idempotency_key / reason for writes).
// Permission = extension.permission on that platform; writes go through two-step confirmation
// (opts.dryRun first). Extensions with invalid names / clashing names are skipped with a warning.
// Drive image (ProviderExtension.driveImageRef, e.g. meta_create_ad creative.image_drive_file - D5): resolved here in
// the MCP's Drive scope on BOTH steps (preview: label + reuse lookup, nothing uploaded; execution: downloaded +
// uploaded as bytes / reused → MutationOptions.driveImage.imageHash). The confirmation / idempotency args carry the
// resolved file id instead of the ref (a re-issued drf_ ref or another link form of the same file confirms the same
// action). Executions also get MutationOptions.fetchImage (SSRF-guarded download of platform image URLs - D2).
import { z } from "zod"
import { getProvider, hasProvider } from "../../providers/registry"
import { PLATFORMS, type FieldChange, type MutationResult, type Platform, type ProviderExtension } from "../../providers/types"
import { previewChanges, type PreviewInfo } from "../confirm"
import { denied, McpToolError } from "../errors"
import { assertGrant } from "../grant"
import { DYNAMIC_DAILY_NOTE, enforceMoneyItems, legacyCapWarning, moneyLikePaths, requireMoneyCaps } from "../guardrails"
import { driveRefForLog, stripMediaUrlQueries } from "../log-args"
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
import { grantAllows, type McpGrant } from "../types"
import { writeOptions } from "../write-options"
import { isKnownMedia } from "../known-media"
import { MEDIA_CALL_BUDGET_MS } from "./telegram/attachment"
import { fetchPlatformImage, resolveDriveCover, uploadDriveCover, type DriveCover } from "./common/upload-media"

/** Tool-name prefix per platform shipped in this build (an extension of any other platform is skipped). */
const PREFIX: Partial<Record<Platform, string>> = {
  meta: "meta_",
  tiktok: "tiktok_",
  google_ads: "google_ads_",
  openai_ads: "openai_ads_",
}
const NAME_RE = /^[a-z0-9_]{3,40}$/
const RESERVED_KEYS = new Set(["account_id", "confirm_token", "idempotency_key", "reason"])

function isMutationResult(v: unknown): v is MutationResult {
  return !!v && typeof v === "object" && Array.isArray((v as MutationResult).changes) && Array.isArray((v as MutationResult).warnings)
}

/** Every created id appears in the changes (the logs "Trước → Sau" table reads only `changes`). */
export function withCreatedIds(
  changes: FieldChange[],
  createdIds: string[] | undefined,
  permission: string,
  createsActive = false
): FieldChange[] {
  const out = [...changes]
  const seen = new Set(out.map((c) => c.objectId))
  const after = permission !== "create" ? "đã tạo" : createsActive ? "đã tạo (ĐANG CHẠY)" : "đã tạo (tạm dừng)"
  for (const id of createdIds ?? []) {
    if (!seen.has(id)) out.push({ objectId: id, field: "created", before: null, after })
  }
  return out
}

/** Opt-in MCP setting of an extension (ProviderExtension.requiresSetting) is on for this grant. */
export function extensionSettingOn(grant: Pick<McpGrant, "settings">, ext: Pick<ProviderExtension, "requiresSetting">): boolean {
  if (!ext.requiresSetting) return true
  // fail closed: an unknown setting name is never "on"
  return ext.requiresSetting === "tiktok_gmv_max_write" && grant.settings.tiktokGmvMaxWrite === true
}

/** Refusal of an extension whose opt-in MCP setting is off (defence in depth - such tools are not even listed). */
export const EXTENSION_SETTING_OFF =
  "MCP này chưa được quản trị viên cho phép dùng công cụ này (cần bật quyền tương ứng trong cấu hình MCP)."

/** Keys of extension inputs that carry a Google Drive reference (file id / Drive link / drf_ ref). */
const DRIVE_REF_KEY = /(^|_)drive_file$/

/** Deep copy where every Drive reference (keys …drive_file) is replaced by `fn(value)`. */
function mapDriveRefs(v: unknown, fn: (ref: string) => string, key: string | null = null, depth = 0): unknown {
  if (typeof v === "string") return key !== null && DRIVE_REF_KEY.test(key) ? fn(v) : v
  if (v === null || typeof v !== "object" || depth > 8) return v
  if (Array.isArray(v)) return v.map((item) => mapDriveRefs(item, fn, key, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, item] of Object.entries(v as Record<string, unknown>)) out[k] = mapDriveRefs(item, fn, k, depth + 1)
  return out
}

/** Logged / stored args of an extension: media URL queries stripped, Drive refs reduced to the file id (no resource key). */
export function extensionLogArgs(args: Record<string, unknown>): Record<string, unknown> {
  return mapDriveRefs(stripMediaUrlQueries(args), driveRefForLog) as Record<string, unknown>
}

/**
 * Confirmation / idempotency args: the Drive ref replaced by the resolved file id + file version (stable across ref
 * forms; a file changed on Drive between preview and confirm no longer matches the token - S-L5).
 */
export function bindDriveRef(args: Record<string, unknown>, fileId: string, contentKey: string | null): Record<string, unknown> {
  return mapDriveRefs(args, () => `drive:${fileId}@${contentKey ?? "?"}`) as Record<string, unknown>
}

/** Media sub-steps of a write (Drive cover upload, Meta automatic cover) keep this much of the call for the write. */
const COVER_WORK_MS = 30_000

/** A failure of the cover step after the confirmation was consumed: nothing was created - say how to retry. */
function coverStepError(e: unknown): unknown {
  if (!(e instanceof McpToolError)) return e
  return new McpToolError({
    code: e.code,
    messageVi: e.messageVi,
    hint: `${e.hint ? `${e.hint} ` : ""}Chưa tạo gì trên nền tảng: gọi lại công cụ KHÔNG kèm confirm_token để có bản xem trước mới rồi xác nhận lại.`,
    logStatus: e.logStatus,
    details: e.details,
  })
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
      // opt-in tools (e.g. TikTok GMV Max writes): not listed unless the MCP setting is on
      if (!extensionSettingOn(tctx.grant, ext)) continue
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
    // signed media URLs (image_url, video_url…) and Drive resource keys must not end up in mcp_call_logs /
    // mcp_pending_actions
    logArgs: (a) => extensionLogArgs(a as Record<string, unknown>),
    async handler(args, env) {
      // idempotency_key stays in args: runWrite derives the deterministic adapter key from it
      const { account_id, confirm_token: _c, idempotency_key: _i, reason: _r, ...rest } = args as Record<string, unknown> & {
        account_id: string
      }
      const account = assertGrant(env.grant, { platform, accountId: account_id, permission: ext.permission })
      env.log.setTarget({ platform, accountId: account.externalId })
      if (!extensionSettingOn(env.grant, ext)) {
        throw denied("setting_disabled", EXTENSION_SETTING_OFF, "Nhờ quản trị viên mở cấu hình MCP để bật quyền này.")
      }
      // re-validate with the provider's own schema (strips the mcp-core fields)
      const parsed = (ext.input as z.ZodObject).parse(rest)

      // preview warnings of a legacy MCP (no daily cap for this currency) that sets money
      let moneyWarnings: string[] = []
      if (ext.write) {
        // money guardrails (both steps, before preview/execute): create tools must not bypass the caps
        if (ext.moneyOf) {
          const items = ext.moneyOf(parsed)
          if (items.length) {
            requireMoneyCaps(env.grant.settings, account.currency, "đặt ngân sách/giá thầu")
            moneyWarnings = legacyCapWarning(env.grant.settings, account.currency)
          }
          enforceMoneyItems(env.grant.settings, account.currency, items)
          if (items.some((it) => it.kind === "daily_budget" && it.dynamic)) moneyWarnings = [...moneyWarnings, DYNAMIC_DAILY_NOTE]
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

      // GMV Max switch / strict worst-case daily-spend guard / change history (both steps)
      const wopts = writeOptions(env.grant, account)
      const pausedNote =
        ext.permission === "create" && !ext.createsActive && ext.createsAdObject !== false
          ? ["Đối tượng mới luôn được tạo ở trạng thái tạm dừng."]
          : []
      // media sub-steps (Drive cover, Meta automatic cover) are bounded from the call's arrival (C-M3)
      const deadline = Date.now() + MEDIA_CALL_BUDGET_MS
      const usesMedia = !!ext.driveImageRef || ext.fetchesPlatformImages === true
      // ids this app uploaded to the account are trusted by the adapter's ownership checks (S-M1)
      const knownMedia = { isKnownMedia: (q: { id: string }) => isKnownMedia(account, q.id) }
      // Drive image of the input (D5): resolved on both steps (scope, type, size, file version, reuse)
      const driveRef = ext.driveImageRef?.(parsed)
      const cover: DriveCover | null = driveRef ? await resolveDriveCover(env, account, driveRef) : null
      const coverRow = cover
        ? [
            {
              object: `Google Drive: ${cover.label}`,
              object_id: cover.fileId,
              level: null,
              field: "image_drive_file",
              before: null,
              after: cover.reusedId
                ? `ảnh đã có trên tài khoản (id ${cover.reusedId}) - dùng lại`
                : "ảnh sẽ được tải lên tài khoản khi xác nhận",
            },
          ]
        : []
      return runWrite(env, {
        args: cover ? bindDriveRef(args as Record<string, unknown>, cover.fileId, cover.item.contentKey) : (args as Record<string, unknown>),
        account,
        alwaysConfirm: ext.alwaysConfirm === true,
        // the write pacing never eats the time the media steps need
        ...(usesMedia ? { pacingMaxWaitMs: Math.max(0, deadline - Date.now() - COVER_WORK_MS) } : {}),
        preview: async (): Promise<PreviewInfo> => {
          const ctx = await env.providerCtx(account)
          const r = await ext.run(ctx, parsed, {
            ...wopts,
            ...knownMedia,
            dryRun: true,
            ...(cover ? { driveImage: { label: cover.label, ...(cover.reusedId ? { imageHash: cover.reusedId } : {}) } } : {}),
          })
          if (isMutationResult(r)) {
            // adapters may attach the request body they would send (`payload`) - shown when small
            const payload = (r as MutationResult & { payload?: unknown }).payload
            const details = payload !== undefined && jsonLength(payload) <= 8_000 ? { payload } : undefined
            return {
              changes: [...previewChanges(r.changes), ...coverRow],
              warnings: [...moneyWarnings, ...pausedNote, ...r.warnings],
              effective_at: r.effectiveAt ?? null,
              ...(details ? { details } : {}),
            }
          }
          const details = asRecord(r)
          return {
            changes: [{ object: ext.name, object_id: "-", level: null, field: ext.permission, before: null, after: "xem details" }, ...coverRow],
            warnings: [...moneyWarnings, ...pausedNote],
            effective_at: null,
            details: jsonLength(details) > 8_000 ? { _truncated: true } : details,
          }
        },
        execute: async (idempotencyKey, meta) => {
          // the Drive image is uploaded (or reused) only now, after the confirmation
          const uploaded = cover ? await uploadDriveCover(env, account, cover, deadline).catch((e: unknown) => {
            throw coverStepError(e)
          }) : null
          const coverChanges: FieldChange[] =
            cover && uploaded && !uploaded.reused
              ? [{ objectId: uploaded.id, field: "media_uploaded", before: null, after: `Google Drive: ${cover.label} (${cover.fileId})` }]
              : []
          const ctx = await env.providerCtx(account)
          const r = await ext.run(ctx, parsed, {
            ...wopts,
            ...knownMedia,
            idempotencyKey,
            confirmed: meta.confirmed,
            // only tools that declare it may download platform images (S-L2)
            ...(ext.fetchesPlatformImages ? { fetchImage: fetchPlatformImage(env, deadline), deadlineAt: deadline } : {}),
            ...(cover && uploaded ? { driveImage: { label: cover.label, imageHash: uploaded.id } } : {}),
          })
          if (isMutationResult(r)) {
            if (r.createdIds?.length) env.log.addObjectIds(r.createdIds)
            const changes = [...coverChanges, ...withCreatedIds(r.changes, r.createdIds, ext.permission, ext.createsActive === true)]
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
