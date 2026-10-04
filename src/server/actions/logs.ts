"use server"
// Log page actions: "Tải thêm" (keyset) + detail sheet. Read-only; authorization is re-checked here and
// ownership is enforced by the logs service (staff → own MCP logs only, activity logs admin-only).
import { fail, ok, type ActionResult } from "@/lib/action-result"
import { logs as tl } from "@/lib/i18n/vi/logs"
import { loadMoreLogsSchema, logDetailSchema, parseLogQuery } from "@/lib/schemas/logs"
import { safeErrorForLog } from "@/server/audit/safe-error"
import { AuthorizationError, requireUserForAction } from "@/server/auth/session"
import {
  activityFiltersFromQuery,
  getActivityLog,
  getMcpLog,
  listActivityLogs,
  listMcpLogs,
  mcpFiltersFromQuery,
  type ActivityLogDetail,
  type ActivityLogListRow,
  type LogPage,
  type McpLogDetail,
  type McpLogListRow,
} from "@/server/services/logs"

function toError(e: unknown): ActionResult<never> {
  if (e instanceof AuthorizationError) return fail(e.message)
  if (e instanceof RangeError) return fail(tl.errors.invalidRange)
  console.error("[logs action]", safeErrorForLog(e))
  return fail(tl.errors.loadFailed)
}

export async function loadMoreMcpLogsAction(input: unknown): Promise<ActionResult<LogPage<McpLogListRow>>> {
  try {
    const { user } = await requireUserForAction()
    const parsed = loadMoreLogsSchema.safeParse(input)
    if (!parsed.success) return fail(tl.errors.loadFailed)
    const query = parseLogQuery(new URLSearchParams(parsed.data.search))
    return ok(await listMcpLogs(user, mcpFiltersFromQuery(query), parsed.data.cursor))
  } catch (e) {
    return toError(e)
  }
}

export async function loadMoreActivityLogsAction(
  input: unknown
): Promise<ActionResult<LogPage<ActivityLogListRow>>> {
  try {
    const { user } = await requireUserForAction({ role: "admin" })
    const parsed = loadMoreLogsSchema.safeParse(input)
    if (!parsed.success) return fail(tl.errors.loadFailed)
    const query = parseLogQuery(new URLSearchParams(parsed.data.search))
    return ok(await listActivityLogs(user, activityFiltersFromQuery(query), parsed.data.cursor))
  } catch (e) {
    return toError(e)
  }
}

export async function getMcpLogDetailAction(input: unknown): Promise<ActionResult<McpLogDetail>> {
  try {
    const { user } = await requireUserForAction()
    const parsed = logDetailSchema.safeParse(input)
    if (!parsed.success) return fail(tl.errors.notFound)
    const row = await getMcpLog(user, parsed.data.id, parsed.data.createdAt)
    return row ? ok(row) : fail(tl.errors.notFound)
  } catch (e) {
    return toError(e)
  }
}

/** Admin: any row. Staff: only their own activity (account page "Hoạt động của tôi"). */
export async function getActivityLogDetailAction(input: unknown): Promise<ActionResult<ActivityLogDetail>> {
  try {
    const { user } = await requireUserForAction()
    const parsed = logDetailSchema.safeParse(input)
    if (!parsed.success) return fail(tl.errors.notFound)
    const row = await getActivityLog(user, parsed.data.id, parsed.data.createdAt)
    return row ? ok(row) : fail(tl.errors.notFound)
  } catch (e) {
    return toError(e)
  }
}
