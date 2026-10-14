// Common path of apify_run_task / apify_run_actor (16-apify.md §5, §7): friendly daily pre-check → write limit
// (admitWrite; apify_run_task runs at once, apify_run_actor always goes through the 2-step confirmation; no ad write
// pacing) → token rotation + validate-input + start (wait 0, the pool enforces the daily cap atomically and records
// the run with its pinned token) → long-poll the run with that token within the call budget → first items when it
// finished in time. Once the run exists the tool always answers with its run_id (later failures become warnings) -
// unless the client left, then the run is aborted.
import { z } from "zod"

import {
  startActorRunForMcp,
  type StartForMcpResult,
} from "@/server/apify/pool"

import { admitWrite, type ToolEnv, type ToolOutcome } from "../../tool"
import {
  APIFY_NOTICE,
  assertDailyRoom,
  dailyCapOf,
  RUN_START_BUDGET_MS,
  RUN_TOOL_BUDGET_MS,
  runOutput,
  runOutputShape,
  settleStartedRun,
  usd,
  USAGE_COST_NOTE,
} from "./shared"

export interface RunPlan {
  /** "username~name" */
  actorId: string
  /** catalog task; null = Actor outside the catalog */
  taskKey: string | null
  input: Record<string, unknown>
  timeoutSecs: number
  memoryMbytes: number | undefined
  /** effective per-run cost ceiling (USD) */
  capUsd: number
  /** dataset fields of the preview (catalog resultFields / AI choice) */
  resultFields?: string[]
  /** billed by platform usage: the timeout is bounded by the cap, proxy traffic is not covered */
  usageBilled?: boolean
}

export const runToolOutput = z.object({
  ...runOutputShape,
  /** primary / fallback Actor of a catalog task; store = Actor outside the catalog */
  actor_choice: z.enum(["primary", "fallback", "store"]),
  /** first rows (cleaned, ≤ 5) when the run finished in time */
  items: z.array(z.unknown()),
  items_truncated: z.boolean(),
})

/** apify_run_actor: the run, or (first call) confirmation_required + preview + confirm_token - always 2 steps */
export const confirmableRunOutput = runToolOutput.partial().extend({
  status: z.string(),
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
})

/**
 * Daily pre-check + one unit of the write limit (apify_run_task: call once per tool call, before the first start
 * attempt). Refusals before this point cost nothing.
 */
export async function admitRun(env: ToolEnv, capUsd: number): Promise<void> {
  await assertDailyRoom(env.grant, capUsd)
  admitWrite(env.grant)
}

/** Start `plan` on the MCP's pool (rotation, validate-input, start, record). Throws the raw Apify error. */
export function startOnPool(
  env: ToolEnv,
  plan: RunPlan,
  t0: number
): Promise<StartForMcpResult> {
  return startActorRunForMcp({
    mcpId: env.grant.mcpId,
    tokens: env.grant.apifyTokens,
    actorId: plan.actorId,
    taskKey: plan.taskKey,
    input: plan.input,
    run: {
      timeoutSecs: plan.timeoutSecs,
      memoryMbytes: plan.memoryMbytes,
      maxTotalChargeUsd: plan.capUsd,
      // the wait happens after the start (pinned token), so the pool's per-MCP daily-cap lock is held briefly
      waitForFinishSecs: 0,
    },
    validate: true,
    signal: env.signal,
    deadline: t0 + RUN_START_BUDGET_MS,
    // advanced mode: the authoritative daily cap (per-MCP lock + reservation inside the pool); basic: none
    dailyMaxUsd: dailyCapOf(env.grant),
  })
}

/** After a successful start: log target + change, wait / preview, structured answer. */
export async function finishStartedRun(
  env: ToolEnv,
  started: StartForMcpResult,
  plan: RunPlan,
  o: {
    t0: number
    waitSecs: number
    choice: "primary" | "fallback" | "store"
    warnings: string[]
  }
): Promise<ToolOutcome> {
  const { record } = started
  env.log.setTarget({ objectIds: [record.runId] })
  env.log.setChanges([
    {
      objectId: record.runId,
      objectName: plan.taskKey ?? plan.actorId,
      field: "apify_run",
      before: null,
      after: `${plan.actorId} · trần ${usd(plan.capUsd)}`,
    },
  ])
  const warnings = [...o.warnings]
  if (plan.usageBilled) warnings.push(USAGE_COST_NOTE)
  if (started.attempts > 1)
    warnings.push(
      `Đã thử ${started.attempts} token Apify (token trước hết credit / bận / lỗi) trước khi chạy được.`
    )
  if (started.run.recovered)
    warnings.push(
      "Apify phản hồi chậm khi bắt đầu; hệ thống đã nhận lại đúng lần chạy vừa tạo (không chạy 2 lần)."
    )
  const settled = await settleStartedRun(record, started.run, {
    waitSecs: o.waitSecs,
    deadline: o.t0 + RUN_TOOL_BUDGET_MS,
    signal: env.signal,
    fields: plan.resultFields,
  })
  warnings.push(...settled.warnings)
  const base = runOutput(record, settled.run, settled.itemCount, warnings)
  const items = settled.preview?.items ?? []
  return {
    structured: {
      ...base,
      actor_choice: o.choice,
      items,
      items_truncated: settled.preview?.truncated ?? false,
    },
    summary: base.finished
      ? `Lần chạy Apify ${record.runId} đã ${base.status === "SUCCEEDED" ? "xong" : `dừng (${base.status})`}: ${base.item_count ?? "?"} dòng, chi phí ${base.usage_usd === null ? "chưa rõ" : usd(base.usage_usd)} (trần ${usd(plan.capUsd)}). ${items.length ? `Kèm ${items.length} dòng đầu. ` : ""}${APIFY_NOTICE}`
      : `Đã bắt đầu lần chạy Apify ${record.runId} (${base.status}, trần ${usd(plan.capUsd)}). ${base.next_step}`,
  }
}
