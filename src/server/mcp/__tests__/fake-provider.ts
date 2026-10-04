// In-memory fake AdsProvider used by the MCP tests (no network).
import { z } from "zod"
import { ProviderError } from "../../providers/errors"
import {
  emptyMetrics,
  type AdObjectDetail,
  type AdsProvider,
  type Capability,
  type CapabilityMode,
  type MutationResult,
  type Platform,
  type ProviderContext,
  type ReportRow,
} from "../../providers/types"

export interface FakeObject {
  id: string
  level: "campaign" | "ad_group" | "ad"
  name: string
  status: "active" | "paused"
  parentId: string | null
  budget?: { type: "daily" | "lifetime"; amount: number; level: "campaign" | "ad_group" } | null
}

export interface FakeState {
  /** accountExternalId → objects */
  objects: Map<string, FakeObject[]>
  /** accountExternalId → spend per campaign */
  spend: Map<string, number>
  executions: { op: string; account: string; args: unknown; idem?: string }[]
  credentialsSeen: unknown[]
  /** accounts whose getReport throws */
  failingAccounts: Set<string>
}

const CAPS: Record<Capability, CapabilityMode> = {
  report: "native",
  list_objects: "native",
  get_object: "native",
  set_status: "native",
  update_budget: "native",
  update_object: "native",
  copy: "native",
  delete: "native",
  upload_media: "native",
  lookup: "native",
  create: "native",
  update_targeting: "native",
  conversions: "unsupported",
}

export function createFakeProvider(platform: Platform, state: FakeState): AdsProvider {
  const prefix = platform
  const objectsOf = (ctx: ProviderContext) => state.objects.get(ctx.account.externalId) ?? []
  const find = (ctx: ProviderContext, id: string) => {
    const o = objectsOf(ctx).find((x) => x.id === id)
    if (!o) {
      throw new ProviderError({ platform, code: "not_found", message: `object ${id} not found`, userMessageVi: `Không tìm thấy đối tượng ${id}.` })
    }
    return o
  }
  const record = (op: string, ctx: ProviderContext, args: unknown, idem?: string) => {
    state.executions.push({ op, account: ctx.account.externalId, args, idem })
    state.credentialsSeen.push(ctx.credentials)
    ctx.onUpstream?.({ platform, method: "POST", url: `https://fake.${platform}/${op}`, status: 200, durationMs: 1, requestId: `req-${op}-${state.executions.length}` })
  }

  return {
    platform,
    capabilities: CAPS,
    credentialFields: [],
    guide: { summary: "fake", steps: [] },
    extensions: [
      {
        name: `${prefix}_fake_insight`,
        permission: "read",
        title: "Fake đọc",
        description: "Dùng khi kiểm thử extension đọc.",
        input: z.object({ topic: z.string().max(50) }),
        write: false,
        async run(ctx, input) {
          return { topic: input.topic, account: ctx.account.externalId }
        },
      },
      {
        name: `${prefix}_fake_create_campaign`,
        permission: "create",
        title: "Fake tạo chiến dịch",
        description: "Dùng khi kiểm thử extension ghi.",
        input: z.object({ name: z.string().max(100) }),
        write: true,
        async run(ctx, input, opts): Promise<MutationResult> {
          if (!opts.dryRun) record("ext_create", ctx, input, opts.idempotencyKey)
          return {
            preview: Boolean(opts.dryRun),
            changes: [{ objectId: "new", field: "name", before: null, after: input.name }],
            warnings: [],
            createdIds: opts.dryRun ? [] : ["cmp_new_1"],
          }
        },
      },
      {
        name: `${prefix}_fake_create_adgroup`,
        permission: "create",
        title: "Fake tạo nhóm",
        description: "Dùng khi kiểm thử extension ghi có tiền.",
        input: z.object({
          name: z.string().max(100),
          daily_budget: z.number().positive().optional(),
          lifetime_budget: z.number().positive().optional(),
          end_time: z.string().optional(),
          bid: z.number().positive().optional(),
        }),
        write: true,
        moneyOf: (input: { daily_budget?: number; lifetime_budget?: number; end_time?: string; bid?: number }) => [
          ...(input.daily_budget ? [{ kind: "daily_budget" as const, amount: input.daily_budget, field: "daily_budget" }] : []),
          ...(input.lifetime_budget ? [{ kind: "lifetime_budget" as const, amount: input.lifetime_budget, field: "lifetime_budget", endTime: input.end_time ?? null }] : []),
          ...(input.bid ? [{ kind: "bid" as const, amount: input.bid, field: "bid" }] : []),
        ],
        async run(ctx, input: { name: string }, opts): Promise<MutationResult> {
          if (!opts.dryRun) record("ext_create_adgroup", ctx, input, opts.idempotencyKey)
          return {
            preview: Boolean(opts.dryRun),
            changes: [{ objectId: "(mới)", level: "ad_group", field: "create", before: null, after: { name: input.name } }],
            warnings: [],
            createdIds: opts.dryRun ? [] : ["ag_new_1"],
          }
        },
      },
      {
        name: `${prefix}_fake_undeclared_money`,
        permission: "create",
        title: "Fake tiền chưa khai báo",
        description: "Dùng khi kiểm thử extension nhận tiền nhưng không khai báo moneyOf.",
        input: z.object({ name: z.string().max(100), budget: z.number().optional() }),
        write: true,
        async run(ctx, input, opts): Promise<MutationResult> {
          if (!opts.dryRun) record("ext_undeclared", ctx, input, opts.idempotencyKey)
          return { preview: Boolean(opts.dryRun), changes: [], warnings: [] }
        },
      },
    ],
    parseCredentials: (raw) => raw,
    credentialHint: () => "fake",
    async validateCredentials() {
      return { valid: true, tokenExpiresAt: null, scopes: null, warnings: [], meta: {} }
    },
    async listAccounts() {
      return []
    },
    async getReport(ctx, q) {
      state.credentialsSeen.push(ctx.credentials)
      if (state.failingAccounts.has(ctx.account.externalId)) {
        throw new ProviderError({
          platform,
          code: "permission_denied",
          message: "denied",
          userMessageVi: "Token không có quyền với tài khoản này.",
          upstream: { code: 200, message: "Permissions error", requestId: "up-err-1" },
        })
      }
      const campaigns = objectsOf(ctx).filter((o) => o.level === "campaign")
      let rows: ReportRow[]
      if (q.level === "account") {
        const metrics = emptyMetrics()
        metrics.spend = state.spend.get(ctx.account.externalId) ?? 0
        metrics.impressions = 1000
        metrics.clicks = 10
        rows = [{ level: "account", metrics }]
      } else {
        rows = campaigns.map((c, i) => {
          const metrics = emptyMetrics()
          metrics.spend = (i + 1) * 100
          metrics.impressions = 100 * (i + 1)
          metrics.clicks = i + 1
          return { level: "campaign", campaignId: c.id, campaignName: c.name, status: c.status, metrics }
        })
      }
      const offset = q.cursor ? Number(q.cursor) : 0
      const page = rows.slice(offset, offset + q.limit)
      const next = offset + q.limit < rows.length ? String(offset + q.limit) : null
      return { rows: page, nextCursor: next, currency: ctx.account.currency, timezone: ctx.account.timezone, warnings: [] }
    },
    async listObjects(ctx, q) {
      const items = objectsOf(ctx)
        .filter((o) => o.level === q.level && (!q.parentId || o.parentId === q.parentId))
        .map((o) => ({
          id: o.id,
          level: o.level,
          name: o.name,
          status: o.status,
          statusRaw: o.status.toUpperCase(),
          parentId: o.parentId,
          budget: o.budget ? { ...o.budget, currency: ctx.account.currency } : null,
        }))
      const offset = q.cursor ? Number(q.cursor) : 0
      return {
        items: items.slice(offset, offset + q.limit),
        nextCursor: offset + q.limit < items.length ? String(offset + q.limit) : null,
        warnings: [],
      }
    },
    async getObject(ctx, _level, id, opts) {
      if (id === "auth_fail") {
        throw new ProviderError({
          platform,
          code: "auth_invalid",
          message: "token revoked",
          userMessageVi: "Token Meta đã hết hạn hoặc bị thu hồi.",
          upstream: { code: 190, message: "Error validating access token" },
        })
      }
      const o = find(ctx, id)
      const toDetail = (x: FakeObject): AdObjectDetail => ({
        id: x.id,
        level: x.level,
        name: x.name,
        status: x.status,
        statusRaw: x.status.toUpperCase(),
        parentId: x.parentId,
        budget: x.budget ? { ...x.budget, currency: ctx.account.currency } : null,
        config: { targeting: { geo: ["VN"] } },
        children: opts?.includeChildren ? objectsOf(ctx).filter((c) => c.parentId === x.id).map(toDetail) : undefined,
      })
      return toDetail(o)
    },
    async setStatus(ctx, level, ids, status, opts) {
      const changes = ids.map((id) => {
        const o = find(ctx, id)
        return { objectId: id, objectName: o.name, level, field: "status", before: o.status, after: status }
      })
      if (!opts?.dryRun) {
        record("set_status", ctx, { ids, status }, opts?.idempotencyKey)
        for (const id of ids) find(ctx, id).status = status
      }
      return { preview: Boolean(opts?.dryRun), changes, warnings: [] }
    },
    async updateBudget(ctx, u, opts) {
      const o = find(ctx, u.id)
      const before = o.budget?.amount ?? null
      if (!opts?.dryRun) {
        record("update_budget", ctx, u, opts?.idempotencyKey)
        o.budget = { type: u.type, amount: u.amount, level: u.level }
      }
      return {
        preview: Boolean(opts?.dryRun),
        changes: [{ objectId: u.id, objectName: o.name, level: u.level, field: `${u.type}_budget`, before, after: u.amount }],
        warnings: [],
        effectiveAt: null,
      }
    },
    async updateObject(ctx, u, opts) {
      const o = find(ctx, u.id)
      if (!opts?.dryRun) {
        record("update_object", ctx, u, opts?.idempotencyKey)
        if (u.changes.name) o.name = u.changes.name
      }
      return {
        preview: Boolean(opts?.dryRun),
        changes: Object.entries(u.changes).map(([field, after]) => ({ objectId: u.id, field, before: null, after })),
        warnings: [],
      }
    },
    async copyObject(ctx, r, opts) {
      find(ctx, r.id)
      if (!opts?.dryRun) record("copy", ctx, r, opts?.idempotencyKey)
      return {
        preview: Boolean(opts?.dryRun),
        mode: "native",
        rootNewId: opts?.dryRun ? null : `${r.id}_copy`,
        mappings: [{ level: r.level, sourceId: r.id, newId: opts?.dryRun ? null : `${r.id}_copy` }],
        warnings: [],
      }
    },
    async deleteObject(ctx, level, id, opts) {
      const o = find(ctx, id)
      if (!opts?.dryRun) {
        record("delete", ctx, { level, id }, opts?.idempotencyKey)
        state.objects.set(
          ctx.account.externalId,
          objectsOf(ctx).filter((x) => x.id !== id)
        )
      }
      return { preview: Boolean(opts?.dryRun), changes: [{ objectId: id, objectName: o.name, level, field: "status", before: o.status, after: "deleted" }], warnings: [] }
    },
    async uploadMedia(ctx, r) {
      record("upload", ctx, r)
      return { type: r.type, id: "img_1", url: null }
    },
    async lookup() {
      return { items: [{ id: "p1", name: "Page 1" }], warnings: [] }
    },
  }
}

export function newFakeState(): FakeState {
  return { objects: new Map(), spend: new Map(), executions: [], credentialsSeen: [], failingAccounts: new Set() }
}
