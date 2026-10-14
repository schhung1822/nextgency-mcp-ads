// apify_list_tasks (16-apify.md §6-§7): the curated catalog (what the AI may run with apify_run_task) + the state of
// the MCP's token pool (usable Apify accounts, estimated credit left, reset dates, caps, money committed today).
// No Apify call, nothing spent. Never returns a token, a token name, an Apify username or an email.
import { z } from "zod"

import {
  listCatalogTasks,
  getCatalogTask,
  getCatalogTaskExample,
} from "@/server/apify/catalog"
import {
  apifyAccountKey,
  isGrantTokenUsable,
  mcpApifySpendToday,
  minCreditFor,
  usableAccounts,
} from "@/server/apify/pool"
import type { ApifyCatalogTask, ApifyTaskGroup } from "@/server/apify/types"

import { invalid } from "../../errors"
import {
  jsonLength,
  MAX_STRUCTURED_CHARS,
  READ_ANNOTATIONS,
  registerToolSpec,
  type ToolContext,
} from "../../tool"
import type { McpGrant } from "../../types"
import { assertApifyEnabled, dailyCapOf, roundUsd, usd } from "./shared"

export const NAME = "apify_list_tasks"

const GROUPS = [
  "shopee",
  "lazada",
  "tiktokshop",
  "tiki",
  "tiktok",
  "facebook",
  "instagram",
  "youtube",
  "google",
  "web",
] as const satisfies readonly ApifyTaskGroup[]

/** JSON budget of the list (the text block repeats it) */
const LIST_BUDGET_CHARS = MAX_STRUCTURED_CHARS - 2_000

type JsonSchemaProp = {
  type?: string
  enum?: unknown[]
  default?: unknown
  items?: JsonSchemaProp
  maxItems?: number
  anyOf?: JsonSchemaProp[]
  description?: string
}

/** JSON Schema of a task input (what the AI sends in apify_run_task `input`), without the $schema noise. */
export function taskInputSchema(
  task: ApifyCatalogTask
): Record<string, unknown> {
  const { $schema: _s, ...schema } = z.toJSONSchema(task.input, {
    io: "input",
  }) as Record<string, unknown>
  return schema
}

function typeOf(p: JsonSchemaProp): string {
  if (p.enum?.length) {
    const vals = p.enum.map(String)
    return vals.length > 10 ? `${vals.slice(0, 8).join("|")}|…` : vals.join("|")
  }
  if (p.type === "array")
    return `danh sách ${p.items ? typeOf(p.items) : ""}${p.maxItems ? ` (tối đa ${p.maxItems})` : ""}`.trim()
  if (p.anyOf?.length) return p.anyOf.map(typeOf).join(" hoặc ")
  return p.type ?? "giá trị"
}

/** { field: "bắt buộc · string" } - short form of the task input for the list (full schema: `task` detail). */
export function compactTaskInput(
  task: ApifyCatalogTask
): Record<string, string> {
  const schema = taskInputSchema(task) as {
    properties?: Record<string, JsonSchemaProp>
    required?: string[]
  }
  const required = new Set(schema.required ?? [])
  const out: Record<string, string> = {}
  for (const [name, p] of Object.entries(schema.properties ?? {})) {
    const def =
      p.default !== undefined ? ` (mặc định ${JSON.stringify(p.default)})` : ""
    out[name] =
      `${required.has(name) ? "bắt buộc" : "tuỳ chọn"} · ${typeOf(p)}${def}`
  }
  return out
}

function taskSummary(t: ApifyCatalogTask) {
  return {
    key: t.key,
    group: t.group,
    title: t.titleVi,
    description: t.descriptionVi,
    input: compactTaskInput(t),
    limit: { default: t.limit.default, max: t.limit.max },
    estimated_cost_usd: t.estimatedCostUsd,
    has_fallback: t.actors.length > 1,
    ...(t.beta ? { beta: true } : {}),
    ...(t.noteVi ? { note: t.noteVi } : {}),
  }
}

/** Fit the list into the budget: notes go first, then long descriptions are shortened. */
export function fitTaskList(
  list: ReturnType<typeof taskSummary>[],
  budget = LIST_BUDGET_CHARS
) {
  let tasks = list
  let compacted = false
  if (jsonLength(tasks) > budget) {
    tasks = tasks.map(({ note: _n, ...t }) => t)
    compacted = true
  }
  if (jsonLength(tasks) > budget) {
    tasks = tasks.map((t) => ({
      ...t,
      description:
        t.description.length > 140
          ? `${t.description.slice(0, 139)}…`
          : t.description,
    }))
  }
  return { tasks, compacted }
}

/** Pool state for the AI (from the grant's cached data: no Apify call). */
export async function poolState(grant: McpGrant) {
  const runCap = grant.settings.apifyRunMaxUsd
  const now = Date.now()
  const groups = usableAccounts(grant.apifyTokens, {
    minCreditUsd: minCreditFor(runCap),
    now,
  })
  const known = groups.filter((g) => g.remaining !== null)
  const accounts = new Set(grant.apifyTokens.map(apifyAccountKey))
  const resets = grant.apifyTokens
    .filter((t) => !isGrantTokenUsable(t, now) && t.exhaustedUntil)
    .map((t) => t.exhaustedUntil as string)
    .sort()
  const daily = dailyCapOf(grant)
  const spent = await mcpApifySpendToday(grant.mcpId)
  return {
    accounts: accounts.size,
    usable_accounts: groups.length,
    /** estimated USD left on the usable accounts whose credit is known (cached ≤ a few minutes / hours) */
    credit_left_usd: known.length
      ? roundUsd(known.reduce((a, g) => a + (g.remaining ?? 0), 0))
      : null,
    accounts_credit_unknown: groups.length - known.length,
    next_reset_at: resets[0] ?? null,
    run_max_usd: runCap,
    daily_max_usd: daily ?? null,
    spent_today_usd: spent,
    left_today_usd:
      daily === undefined ? null : Math.max(0, roundUsd(daily - spent)),
  }
}

const output = z.object({
  tasks: z.array(z.record(z.string(), z.unknown())),
  /** set with `task`: full input JSON schema, example, actors, result fields */
  task_detail: z.record(z.string(), z.unknown()).nullable(),
  pool: z.object({
    accounts: z.number(),
    usable_accounts: z.number(),
    credit_left_usd: z.number().nullable(),
    accounts_credit_unknown: z.number(),
    next_reset_at: z.string().nullable(),
    run_max_usd: z.number(),
    daily_max_usd: z.number().nullable(),
    spent_today_usd: z.number(),
    left_today_usd: z.number().nullable(),
  }),
  store_actors: z.boolean(),
  warnings: z.array(z.string()),
})

export function register(
  server: Parameters<typeof registerToolSpec>[0],
  tctx: ToolContext
) {
  registerToolSpec(server, tctx, {
    name: NAME,
    title: "Danh mục việc Apify",
    description:
      "Dùng khi người dùng muốn lấy dữ liệu từ Shopee, Lazada, TikTok Shop, TikTok, Facebook (thư viện quảng cáo, Trang, nhóm, bình luận), Instagram, YouTube, Google (Maps, tìm kiếm, minh bạch quảng cáo) hoặc một trang web qua Apify - gọi TRƯỚC apify_run_task. Liệt kê danh mục việc: key, mô tả, input (trường bắt buộc / tuỳ chọn), số kết quả mặc định / tối đa (limit), chi phí ước tính USD, có Actor dự phòng không, ghi chú hạn chế; kèm tình trạng kho Apify của MCP (số tài khoản dùng được, credit còn ước tính, ngày reset, trần mỗi lần chạy / mỗi ngày, đã dùng hôm nay). group = lọc theo nền tảng; task = xem chi tiết 1 việc (input_schema đầy đủ + ví dụ input + trường kết quả). include_beta = cả việc thử nghiệm. Không gọi Apify, không tốn tiền.",
    kind: "read",
    annotations: READ_ANNOTATIONS,
    input: z.object({
      group: z
        .enum(GROUPS)
        .optional()
        .describe("Lọc theo nền tảng (bỏ trống = tất cả)"),
      task: z
        .string()
        .trim()
        .max(60)
        .optional()
        .describe("key của 1 việc để xem chi tiết input (vd shopee_search)"),
      include_beta: z
        .boolean()
        .optional()
        .describe("true = gồm cả việc thử nghiệm (beta)"),
    }),
    output,
    async handler(args, env) {
      const { grant } = env
      assertApifyEnabled(grant)
      const warnings: string[] = []
      let detail: Record<string, unknown> | null = null
      let list: ApifyCatalogTask[]
      if (args.task) {
        const task = getCatalogTask(args.task)
        if (!task) {
          throw invalid(
            "apify_unknown_task",
            `Việc "${args.task.slice(0, 60)}" không có trong danh mục Apify.`,
            "Gọi apify_list_tasks (không có task) để xem các key hỗ trợ."
          )
        }
        list = [task]
        detail = {
          key: task.key,
          input_schema: taskInputSchema(task),
          example: getCatalogTaskExample(task.key),
          actors: task.actors.map((a, i) => ({
            choice: i === 0 ? "primary" : "fallback",
            actor_id: a.actorId,
            timeout_secs: a.timeoutSecs,
            ...(a.noteVi ? { note: a.noteVi } : {}),
            ...(a.resultFields?.length
              ? { result_fields: a.resultFields.slice(0, 30) }
              : {}),
          })),
        }
      } else {
        list = listCatalogTasks({
          includeBeta: args.include_beta === true,
        }).filter((t) => !args.group || t.group === args.group)
      }
      const fitted = fitTaskList(list.map(taskSummary))
      if (fitted.compacted)
        warnings.push(
          "Danh sách đã được rút gọn (bỏ ghi chú) - gọi lại với group hoặc task để xem đủ."
        )
      const pool = await poolState(grant)
      if (pool.usable_accounts === 0) {
        warnings.push(
          `Hiện không có tài khoản Apify nào dùng được (hết credit / lỗi)${pool.next_reset_at ? ` - credit sớm nhất reset lúc ${pool.next_reset_at}` : ""}; apify_run_task sẽ báo apify_no_token.`
        )
      }
      return {
        structured: {
          tasks: fitted.tasks,
          task_detail: detail,
          pool,
          store_actors: grant.settings.apifyStoreActors,
          warnings,
        },
        summary: `${fitted.tasks.length} việc Apify${args.group ? ` (${args.group})` : ""}; ${pool.usable_accounts}/${pool.accounts} tài khoản Apify dùng được; trần mỗi lần chạy ${usd(pool.run_max_usd)}${pool.daily_max_usd !== null ? `, còn ${usd(pool.left_today_usd ?? 0)} hôm nay` : ""}. Mỗi lần apify_run_task tốn tiền Apify - chỉ chạy khi người dùng yêu cầu.`,
      }
    },
  })
}
