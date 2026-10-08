import { z } from "zod"
import { assertRange, resolvePreset, type DatePreset } from "../../../providers/dates"
import type {
  DateRange,
  MetricPreset,
  NormalizedMetricKey,
  Platform,
  ReportFilters,
  ReportLevel,
  ReportRow,
} from "../../../providers/types"
import { noteAuthFailure } from "../../connection-health"
import { decodeCursor, encodeCursor, type CursorBinding } from "../../cursor"
import { invalid, mapToolError } from "../../errors"
import { collectFanout, positionAfter, type FanoutPosition } from "../../fanout"
import { assertGrant, findGrantAccount, platformLabel } from "../../grant"
import {
  accountIdSchema,
  datePresetSchema,
  googleAdNetworkTypesSchema,
  googleChannelTypesSchema,
  isoDateSchema,
  metricKeySchema,
  metricPresetSchema,
  platformEnum,
  reportLevelSchema,
  statusFilterSchema,
} from "../../schemas"
import { jsonLength, MAX_STRUCTURED_CHARS, providerFor, READ_ANNOTATIONS, registerToolSpec, type ToolContext } from "../../tool"
import { grantPlatformsWith, type GrantAccount } from "../../types"
import { pickMetrics, resolveMetrics, totalsByCurrency } from "./report-math"

export const NAME = "ads_get_report"

const FANOUT_CONCURRENCY = 4
const MAX_ACCOUNTS = 50
/** sorted / min_spend mode collects at most this many rows before sorting */
const MAX_SORT_ROWS = 2_000
const SORT_PAGE_SIZE = 200

const output = z.object({
  rows: z.array(z.record(z.string(), z.unknown())),
  totals_by_currency: z.array(
    z.object({
      currency: z.string(),
      rows: z.number(),
      accounts: z.number(),
      metrics: z.record(z.string(), z.number().nullable()),
    })
  ),
  totals_scope: z.enum(["all", "page"]),
  accounts: z.array(z.record(z.string(), z.unknown())),
  level: z.string(),
  granularity: z.string(),
  metrics: z.array(z.string()),
  row_count: z.number(),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
  truncated: z.boolean(),
  warnings: z.array(z.string()),
  errors: z.array(z.record(z.string(), z.unknown())),
})

interface Job {
  account: GrantAccount
  range: DateRange
}

type Collected = { row: ReportRow; job: number; currency: string }

export function register(server: Parameters<typeof registerToolSpec>[0], tctx: ToolContext) {
  const readPlatforms = grantPlatformsWith(tctx.grant, "read")
  if (readPlatforms.length === 0) return
  const input = z.object({
    platforms: z.array(platformEnum(readPlatforms)).min(1).max(readPlatforms.length).optional().describe("Mặc định: mọi nền tảng được phép"),
    account_ids: z
      .array(accountIdSchema)
      .min(1)
      .max(MAX_ACCOUNTS)
      .optional()
      .describe("Mặc định: mọi tài khoản trong phạm vi MCP của các nền tảng đã chọn"),
    level: reportLevelSchema.default("account").describe("account | campaign | ad_group | ad | keyword (keyword: chỉ Google)"),
    preset: datePresetSchema.optional().describe("Khoảng ngày định sẵn, tính theo múi giờ từng tài khoản. Mặc định last_7d"),
    date_from: isoDateSchema.optional().describe("YYYY-MM-DD (theo múi giờ tài khoản), dùng cùng date_to thay cho preset"),
    date_to: isoDateSchema.optional(),
    granularity: z.enum(["day", "total"]).default("total"),
    metrics: z
      .union([metricPresetSchema, z.array(metricKeySchema).min(1).max(17)])
      .default("all")
      .describe(
        "Mặc định all = MỌI chỉ số có trên nền tảng (17 chỉ số chuẩn hoá + extra: toàn bộ chỉ số riêng của nền tảng). Chỉ khi người dùng yêu cầu chỉ số cụ thể mới truyền danh sách metric chuẩn hoá (hoặc preset basic | conversion | video)"
      ),
    extra_metrics: z
      .array(z.string().trim().regex(/^[a-z0-9_.]{1,80}$/, "tên chỉ số chỉ gồm a-z 0-9 _ ."))
      .min(1)
      .max(50)
      .optional()
      .describe(
        "Chỉ số RIÊNG của nền tảng mà người dùng hỏi (ngoài danh sách chuẩn hoá), trả trong row.extra. Meta: loại hành động như add_to_cart, initiate_checkout, landing_page_view, view_content, complete_registration (tìm trong actions/action_values/cost_per_action_type) hoặc trường như video_p75_watched_actions, video_thruplay_watched_actions, outbound_clicks, quality_ranking, objective. OpenAI Ads: post_click_cvr, order_created_roas…"
      ),
    filters: z
      .object({
        campaign_ids: z.array(z.string().max(128)).max(100).optional(),
        ad_group_ids: z.array(z.string().max(128)).max(100).optional(),
        ad_ids: z.array(z.string().max(128)).max(100).optional(),
        statuses: z.array(statusFilterSchema).max(9).optional(),
        name_contains: z.string().max(200).optional(),
        min_spend: z.number().min(0).optional().describe("Chỉ giữ dòng có spend ≥ giá trị (đơn vị chính)"),
        include_deleted: z.boolean().optional(),
        channel_types: googleChannelTypesSchema.optional(),
        ad_network_types: googleAdNetworkTypesSchema.optional(),
      })
      .optional(),
    sort_by: metricKeySchema.optional().describe("Sắp xếp theo metric (trên toàn bộ kết quả, tối đa 2.000 dòng)"),
    sort_dir: z.enum(["desc", "asc"]).default("desc"),
    limit: z.number().int().min(1).max(200).default(50),
    cursor: z.string().max(4_000).optional().describe("next_cursor của lần gọi trước (giữ nguyên các tham số khác)"),
  })

  registerToolSpec(server, tctx, {
    name: NAME,
    title: "Báo cáo chỉ số quảng cáo",
    description:
      "Dùng khi cần số liệu (chi tiêu, hiển thị, click, CTR, CPC, CPM, chuyển đổi, CPA, ROAS…) theo khoảng ngày cho một hoặc nhiều nền tảng và tài khoản. Gọi ads_list_accounts trước để biết account_id. Mặc định trả MỌI chỉ số có trên nền tảng (metrics=all, gồm extra là chỉ số riêng của nền tảng); người dùng hỏi chỉ số cụ thể thì truyền metrics (danh sách chuẩn hoá) và/hoặc extra_metrics (chỉ số riêng như add_to_cart, landing_page_view). Chọn level (account/campaign/ad_group/ad/keyword - keyword chỉ Google), granularity day hoặc total, filters (ids, trạng thái, tên chứa, chi tiêu tối thiểu; Google: channel_types - youtube = chiến dịch Video + Demand Gen - và ad_network_types, vd YOUTUBE cho phần YouTube của Performance Max), sort_by. Quảng cáo YouTube nằm trong Google Ads (metrics=video cho chỉ số video). Ngày (preset hoặc date_from/date_to) được tính theo múi giờ của từng tài khoản. Tiền theo đơn vị chính của tiền tệ tài khoản; totals_by_currency cộng riêng từng loại tiền (không cộng chéo tiền tệ). Metric không có trên nền tảng trả null. Kết quả phân trang: dùng next_cursor để lấy tiếp.",
    kind: "read",
    annotations: READ_ANNOTATIONS,
    input,
    output,
    async handler(args, env) {
      const { grant } = env
      // ---- resolve platforms + accounts (re-checked against the grant) -------------------------
      const platforms: Platform[] = (args.platforms ?? readPlatforms).filter((p, i, a) => a.indexOf(p) === i)
      for (const p of platforms) {
        if (!grantPlatformsWith(grant, "read").includes(p)) {
          // assertGrant produces the standard denied error
          assertGrant(grant, { platform: p, accountId: "-", permission: "read" })
        }
      }
      let accounts: GrantAccount[]
      if (args.account_ids) {
        accounts = []
        for (const raw of args.account_ids) {
          const match = platforms.map((p) => findGrantAccount(grant, p, raw)).find(Boolean)
          // throws the standard "account_not_in_scope" when not granted
          const acc = match ?? assertGrant(grant, { platform: platforms[0]!, accountId: raw, permission: "read" })
          assertGrant(grant, { platform: acc.platform, accountId: acc.externalId, permission: "read" })
          if (!accounts.some((a) => a.id === acc.id)) accounts.push(acc)
        }
      } else {
        accounts = grant.accounts.filter((a) => platforms.includes(a.platform))
      }
      if (accounts.length === 0) {
        throw invalid("no_accounts", "Không có tài khoản quảng cáo nào trong phạm vi để lấy báo cáo.", "Gọi ads_list_accounts để xem tài khoản khả dụng.")
      }
      if (accounts.length > MAX_ACCOUNTS) {
        throw invalid(
          "too_many_accounts",
          `Tối đa ${MAX_ACCOUNTS} tài khoản mỗi lần (đang có ${accounts.length}).`,
          "Truyền account_ids hoặc platforms để thu hẹp phạm vi."
        )
      }
      if (args.level === "keyword" && accounts.some((a) => a.platform !== "google_ads")) {
        throw invalid("invalid_level", "level keyword chỉ dùng cho Google Ads.", "Chọn platforms: [\"google_ads\"] khi lấy báo cáo keyword.")
      }
      const channelTypes = args.filters?.channel_types?.length ? [...new Set(args.filters.channel_types)] : undefined
      const adNetworkTypes = args.filters?.ad_network_types?.length ? [...new Set(args.filters.ad_network_types)] : undefined
      if ((channelTypes || adNetworkTypes) && accounts.some((a) => a.platform !== "google_ads")) {
        throw invalid(
          "invalid_filter",
          "channel_types / ad_network_types chỉ dùng cho Google Ads (gồm quảng cáo YouTube).",
          "Chọn platforms: [\"google_ads\"] (hoặc account_ids chỉ gồm tài khoản Google Ads) khi lọc theo loại chiến dịch/mạng."
        )
      }
      if (channelTypes && args.level === "account") {
        throw invalid("invalid_filter", "channel_types không dùng được ở level account.", "Dùng level campaign (hoặc ad_group/ad) khi lọc theo loại chiến dịch.")
      }

      // ---- dates per account time zone ----------------------------------------------------------
      if ((args.date_from && !args.date_to) || (!args.date_from && args.date_to)) {
        throw invalid("invalid_date_range", "Cần cả date_from và date_to (hoặc dùng preset).")
      }
      if (args.preset && args.date_from) {
        throw invalid("invalid_date_range", "Chỉ dùng preset HOẶC date_from/date_to, không dùng cả hai.")
      }
      const preset: DatePreset | null = args.date_from ? null : (args.preset ?? "last_7d")
      const now = new Date()
      const jobs: Job[] = accounts.map((account) => ({
        account,
        range: preset ? resolvePreset(preset, account.timezone, now) : assertRange({ from: args.date_from!, to: args.date_to! }),
      }))

      const resolved = resolveMetrics(args.metrics as MetricPreset | NormalizedMetricKey[])
      const keys = resolved.keys
      const extraWanted = args.extra_metrics?.length ? [...new Set(args.extra_metrics)] : null
      // platform-specific metrics come from the adapter's "all" fetch
      const adapterPreset: MetricPreset = extraWanted ? "all" : resolved.preset
      const includeExtra = args.metrics === "all" || extraWanted !== null
      const filters: ReportFilters = {
        campaignIds: args.filters?.campaign_ids,
        adGroupIds: args.filters?.ad_group_ids,
        adIds: args.filters?.ad_ids,
        statuses: args.filters?.statuses,
        nameContains: args.filters?.name_contains,
        includeDeleted: args.filters?.include_deleted,
        ...(channelTypes ? { channelTypes } : {}),
        ...(adNetworkTypes ? { adNetworkTypes } : {}),
      }
      const minSpend = args.filters?.min_spend
      const sortedMode = Boolean(args.sort_by) || minSpend !== undefined

      env.log.setTarget({
        platform: [...new Set(accounts.map((a) => a.platform))].join(","),
        accountId: accounts.length === 1 ? accounts[0]!.externalId : null,
        objectIds: [...(filters.campaignIds ?? []), ...(filters.adGroupIds ?? []), ...(filters.adIds ?? [])],
      })

      // signed cursor bound to this MCP + tool + accounts + query (H2)
      const bind: CursorBinding = {
        mcpId: grant.mcpId,
        tool: NAME,
        accountIds: accounts.map((a) => a.id),
        query: {
          a: accounts.map((a) => a.id),
          l: args.level,
          r: jobs.map((j) => j.range),
          g: args.granularity,
          m: args.metrics,
          f: args.filters ?? null,
          s: args.sort_by ?? null,
          d: args.sort_dir,
        },
      }

      const fetchPage = async (index: number, cursor: string | null, pageSize: number) => {
        const job = jobs[index]!
        const provider = providerFor(job.account.platform, "report")
        const ctx = await env.providerCtx(job.account)
        const page = await provider.getReport(ctx, {
          level: args.level as ReportLevel,
          dateRange: job.range,
          granularity: args.granularity,
          metrics: adapterPreset,
          filters,
          cursor,
          limit: pageSize,
        })
        for (const w of page.warnings ?? []) pageWarnings.add(`${job.account.externalId}: ${w}`)
        currencyByJob.set(index, (page.currency || job.account.currency).toUpperCase())
        return {
          items: page.rows.map((row): Collected => ({ row, job: index, currency: (page.currency || job.account.currency).toUpperCase() })),
          nextCursor: page.nextCursor,
        }
      }
      const pageWarnings = new Set<string>()
      const currencyByJob = new Map<number, string>()

      // ---- collect ------------------------------------------------------------------------------
      let start: FanoutPosition = { i: 0, c: null, s: 0, p: sortedMode ? SORT_PAGE_SIZE : args.limit }
      let offset = 0
      if (args.cursor) {
        const c = decodeCursor<{ m: "q" | "s"; i?: number; c?: string | null; s?: number; p?: number; o?: number }>(args.cursor, bind)
        if (sortedMode) {
          if (c.m !== "s" || typeof c.o !== "number" || c.o < 0) throw invalid("invalid_cursor", "cursor không hợp lệ.")
          offset = c.o
        } else {
          if (c.m !== "q" || typeof c.i !== "number" || c.i < 0 || c.i >= jobs.length) throw invalid("invalid_cursor", "cursor không hợp lệ.")
          start = { i: c.i, c: c.c ?? null, s: Math.max(0, c.s ?? 0), p: Math.min(Math.max(1, c.p ?? args.limit), 500) }
        }
      }

      const result = await collectFanout<Collected>({
        sourceCount: jobs.length,
        start,
        maxItems: sortedMode ? MAX_SORT_ROWS : args.limit,
        pageSize: sortedMode ? SORT_PAGE_SIZE : args.limit,
        concurrency: FANOUT_CONCURRENCY,
        fetch: fetchPage,
        signal: env.signal,
      })

      // per-account auth failures (fan-out keeps going) still flag their connection
      for (const e of result.errors) await noteAuthFailure(e.error, jobs[e.index]?.account.connectionId)
      const errors = result.errors.map((e) => {
        const mapped = mapToolError(e.error)
        const job = jobs[e.index]!
        env.log.addUpstreamRequestId(mapped.upstreamRequestId)
        return { ...mapped.payload, platform: job.account.platform, account_id: job.account.externalId }
      })
      if (errors.length > 0 && result.items.length === 0 && result.touched.size === 0) {
        // nothing succeeded: surface the first error as the tool error
        throw result.errors[0]!.error
      }

      const warnings: string[] = [...pageWarnings].slice(0, 30)
      let collected = result.items
      let nextCursor: string | null = null
      let truncated = false
      let totalsScope: "all" | "page" = "page"

      const toOut = (c: Collected) => {
        const job = jobs[c.job]!
        const r = c.row
        const row: Record<string, unknown> = {
          platform: job.account.platform,
          account_id: job.account.externalId,
          currency: c.currency,
        }
        if (r.date) row.date = r.date
        row.level = r.level
        if (r.campaignId) row.campaign_id = r.campaignId
        if (r.campaignName) row.campaign_name = r.campaignName
        if (r.adGroupId) row.ad_group_id = r.adGroupId
        if (r.adGroupName) row.ad_group_name = r.adGroupName
        if (r.adId) row.ad_id = r.adId
        if (r.adName) row.ad_name = r.adName
        if (r.keyword) row.keyword = r.keyword
        if (r.status) row.status = r.status
        row.metrics = pickMetrics(r.metrics, keys, c.currency)
        if (includeExtra && r.extra) row.extra = extraWanted ? pickExtra(r.extra, extraWanted) : r.extra
        return row
      }

      let outRows: Record<string, unknown>[]
      if (sortedMode) {
        if (result.end) warnings.push(`Chỉ lọc/sắp xếp trong ${MAX_SORT_ROWS} dòng đầu tiên; thu hẹp phạm vi để có kết quả đầy đủ.`)
        let list = collected
        if (minSpend !== undefined) list = list.filter((c) => (c.item.row.metrics?.spend ?? 0) >= minSpend)
        if (args.sort_by) {
          const key = args.sort_by
          const dir = args.sort_dir === "asc" ? 1 : -1
          list = [...list].sort((a, b) => {
            const va = a.item.row.metrics?.[key] ?? null
            const vb = b.item.row.metrics?.[key] ?? null
            if (va === null && vb === null) return 0
            if (va === null) return 1
            if (vb === null) return -1
            return (va - vb) * dir
          })
          if (new Set(list.map((c) => c.item.currency)).size > 1 && ["spend", "cpc", "cpm", "cpa", "conversion_value"].includes(key)) {
            warnings.push("Sắp xếp theo giá trị tiền giữa các loại tiền tệ khác nhau chỉ mang tính tham khảo (không quy đổi tỷ giá).")
          }
        }
        totalsScope = result.end ? "page" : "all"
        const totals = totalsByCurrency(
          list.map((c) => ({ currency: c.item.currency, accountKey: String(c.item.job), metrics: c.item.row.metrics })),
          keys
        )
        const pageItems = list.slice(offset, offset + args.limit)
        outRows = pageItems.map((c) => toOut(c.item))
        const fit = fitRows(outRows)
        truncated = fit < outRows.length
        outRows = outRows.slice(0, fit)
        const nextOffset = offset + outRows.length
        if (nextOffset < list.length) nextCursor = encodeCursor({ m: "s", o: nextOffset }, bind)
        return finish(outRows, totals)
      }

      outRows = collected.map((c) => toOut(c.item))
      const fit = fitRows(outRows)
      truncated = fit < outRows.length
      outRows = outRows.slice(0, fit)
      collected = collected.slice(0, fit)
      const next = positionAfter(result, fit)
      if (next) nextCursor = encodeCursor({ m: "q", i: next.i, c: next.c, s: next.s, p: next.p }, bind)
      totalsScope = !args.cursor && !next ? "all" : "page"
      const totals = totalsByCurrency(
        collected.map((c) => ({ currency: c.item.currency, accountKey: String(c.item.job), metrics: c.item.row.metrics })),
        keys
      )
      return finish(outRows, totals)

      function finish(rows: Record<string, unknown>[], totals: ReturnType<typeof totalsByCurrency>) {
        if (totalsScope === "page") warnings.push("totals_by_currency chỉ tính trên các dòng của trang này.")
        if (truncated) warnings.push("Kết quả bị cắt bớt để vừa giới hạn kích thước; dùng next_cursor để lấy tiếp.")
        const touched = jobs
          .map((j, idx) => ({ j, idx }))
          .filter(({ idx }) => result.touched.has(idx) || result.errors.some((e) => e.index === idx))
        const accountsOut = touched.map(({ j, idx }) => ({
          platform: j.account.platform,
          account_id: j.account.externalId,
          name: j.account.name,
          currency: currencyByJob.get(idx) ?? j.account.currency,
          timezone: j.account.timezone,
          date_from: j.range.from,
          date_to: j.range.to,
          status: result.errors.some((e) => e.index === idx) ? "error" : "ok",
        }))
        const structured = {
          rows,
          totals_by_currency: totals,
          totals_scope: totalsScope,
          accounts: accountsOut,
          level: args.level,
          granularity: args.granularity,
          metrics: keys,
          row_count: rows.length,
          has_more: nextCursor !== null,
          next_cursor: nextCursor,
          truncated,
          warnings,
          errors,
        }
        // last resort: drop the account list if still too big
        if (jsonLength(structured) > MAX_STRUCTURED_CHARS * 1.5) structured.accounts = accountsOut.slice(0, 10)
        const totalText = totals
          .map((t) => `${t.metrics.spend ?? "?"} ${t.currency}`)
          .slice(0, 4)
          .join(", ")
        const platformsText = [...new Set(accounts.map((a) => platformLabel(a.platform)))].join(", ")
        return {
          structured,
          summary:
            `Báo cáo ${rows.length} dòng (${args.level}, ${args.granularity}) từ ${touched.length} tài khoản ${platformsText}` +
            (keys.includes("spend") && totalText ? `; chi tiêu: ${totalText}` : "") +
            (nextCursor ? ". Còn dữ liệu - dùng next_cursor." : ".") +
            (errors.length ? ` ${errors.length} tài khoản lỗi (xem errors).` : ""),
        }
      }
    },
  })
}

/** Containers in which a bare metric name (e.g. "add_to_cart") is looked up when it is not a top-level extra key. */
const EXTRA_CONTAINERS = ["actions", "action_values", "cost_per_action_type", "conversions", "conversion_values"]

/**
 * Only the platform-specific metrics the user asked for: a top-level extra key, a dotted path ("actions.add_to_cart"),
 * or a bare action type found in the action maps (returned as "actions.add_to_cart", "action_values.add_to_cart"…).
 * Names that do not exist are returned as null so the AI can say the metric is not available.
 */
export function pickExtra(extra: Record<string, unknown>, names: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const name of names) {
    if (name in extra) {
      out[name] = extra[name]
      continue
    }
    const dot = name.indexOf(".")
    if (dot > 0) {
      const container = extra[name.slice(0, dot)]
      const v = container && typeof container === "object" ? (container as Record<string, unknown>)[name.slice(dot + 1)] : undefined
      out[name] = v ?? null
      continue
    }
    let found = false
    for (const c of EXTRA_CONTAINERS) {
      const container = extra[c]
      if (container && typeof container === "object" && name in (container as Record<string, unknown>)) {
        out[`${c}.${name}`] = (container as Record<string, unknown>)[name]
        found = true
      }
    }
    if (!found) out[name] = null
  }
  return out
}

/** How many rows fit in the structured size budget. */
function fitRows(rows: Record<string, unknown>[]): number {
  const budget = MAX_STRUCTURED_CHARS - 3_000
  let total = 0
  for (let i = 0; i < rows.length; i++) {
    total += jsonLength(rows[i]) + 1
    if (total > budget) return Math.max(1, i)
  }
  return rows.length
}
