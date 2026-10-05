// CSV export of the /logs view (same URL filters). Streams batches (keyset, ≤100k rows), UTF-8 BOM for
// Excel, Vietnamese headers. Staff: only their own MCP logs; staff tab admin-only. Writes "logs.export".
//
// L2 hardening: POST only (a cross-site top-level GET would carry the SameSite=Lax cookie), same-origin
// check, a FRESH session (signed in ≤10 min ago, or re-authenticated ≤10 min ago) else re-auth with
// password (+TOTP) through the shared gate, and a per-user quota (5 exports / 10 min).
// Body (JSON or form): { search: "<log filters query string>", password?, code? }.
// Errors are JSON { error, code?, fieldErrors? } for the export button (fetch + blob download).
import { logs as tl } from "@/lib/i18n/vi/logs"
import { LOG_EXPORT_MAX_ROWS, logQueryToSearchParams, parseLogQuery } from "@/lib/schemas/logs"
import { actorOf, logActivity, metaFromHeaders } from "@/server/audit/activity-log"
import { safeErrorForLog } from "@/server/audit/safe-error"
import { reauthFieldsSchema } from "@/lib/schemas/reauth"
import { appBaseUrl } from "@/server/env"
import {
  isSessionFresh,
  REAUTH_MESSAGES,
  ReauthError,
  requestReauthVerifier,
  requireReauth,
} from "@/server/auth/reauth"
import { AuthorizationError, requireUserForAction, type AppSession } from "@/server/auth/session"
import { consumeQuota } from "@/server/db/quota"
import { isSameOriginRequest } from "@/server/net/same-origin"
import {
  activityFiltersFromQuery,
  CSV_BOM,
  csvLine,
  iterateActivityLogsForExport,
  iterateMcpLogsForExport,
  mcpFiltersFromQuery,
  type ActivityLogListRow,
  type McpLogExportRow,
} from "@/server/services/logs"

const VN_TIME = new Intl.DateTimeFormat("vi-VN", {
  timeZone: "Asia/Ho_Chi_Minh",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
})

function vnTime(iso: string): string {
  return VN_TIME.format(new Date(iso))
}

function mcpRow(r: McpLogExportRow): string {
  return csvLine([
    r.createdAt,
    vnTime(r.createdAt),
    r.mcpName,
    r.mcpId,
    r.ownerEmail,
    r.clientName,
    r.clientVersion,
    r.ip,
    r.method,
    r.toolName,
    r.platform,
    r.adAccountId,
    r.objectIds,
    tl.kind[r.actionKind as keyof typeof tl.kind] ?? r.actionKind,
    r.status,
    r.errorCode,
    r.errorMessage,
    r.upstreamRequestIds,
    r.durationMs,
  ])
}

function activityRow(r: ActivityLogListRow): string {
  return csvLine([
    r.createdAt,
    vnTime(r.createdAt),
    r.actorEmail,
    r.actorRole,
    tl.actions[r.action as keyof typeof tl.actions] ?? r.action,
    r.action,
    r.targetType,
    r.targetId,
    r.targetLabel,
    tl.result[r.status as keyof typeof tl.result] ?? r.status,
    r.ip,
    r.userAgent,
  ])
}


/** Per-user export quota. */
const EXPORT_QUOTA_MAX = 5
const EXPORT_QUOTA_WINDOW_MS = 10 * 60_000

function json(status: number, body: Record<string, unknown>, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  })
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const type = req.headers.get("content-type") ?? ""
  try {
    if (type.includes("application/json")) return ((await req.json()) ?? {}) as Record<string, unknown>
    const form = await req.formData()
    return Object.fromEntries([...form.entries()].map(([k, v]) => [k, typeof v === "string" ? v : ""]))
  } catch {
    return {}
  }
}

export async function POST(req: Request): Promise<Response> {
  let session: AppSession
  try {
    session = await requireUserForAction()
  } catch (e) {
    return json(401, { error: e instanceof AuthorizationError ? e.message : tl.errors.exportForbidden })
  }
  if (!isSameOriginRequest(req, appBaseUrl())) return json(403, { error: tl.errors.exportBadOrigin })
  const { user } = session
  const body = await readBody(req)
  const search = typeof body.search === "string" ? body.search.slice(0, 4096) : ""
  const query = parseLogQuery(new URLSearchParams(search))
  if (query.tab === "staff" && user.role !== "admin") return json(403, { error: tl.errors.exportForbidden })

  // Fresh session or re-auth (password + TOTP when 2FA is on).
  if (!(await isSessionFresh(session))) {
    if (typeof body.password !== "string" || body.password === "") {
      return json(401, { error: REAUTH_MESSAGES.required, code: "reauth_required", twoFactorEnabled: user.twoFactorEnabled })
    }
    const fields = reauthFieldsSchema.safeParse({ password: body.password, code: body.code })
    if (!fields.success) {
      const issue = fields.error.issues[0]
      return json(400, { error: issue?.message ?? REAUTH_MESSAGES.failed, code: "reauth_invalid" })
    }
    try {
      await requireReauth(
        { id: user.id, email: user.email, role: user.role },
        { action: "logs.export", target: { type: "logs", id: query.tab, label: tl.tabs[query.tab] } },
        await requestReauthVerifier(user, fields.data),
        { sessionId: session.sessionId }
      )
    } catch (e) {
      if (e instanceof ReauthError) {
        return json(e.code === "reauth_locked" ? 429 : 401, { error: e.message, code: e.code, fieldErrors: e.fieldErrors })
      }
      console.error("[logs export] re-auth failed", safeErrorForLog(e))
      return json(500, { error: tl.errors.exportFailed })
    }
  }

  const quota = await consumeQuota("logs-export", user.id, EXPORT_QUOTA_MAX, EXPORT_QUOTA_WINDOW_MS)
  if (!quota.allowed) {
    return json(
      429,
      { error: tl.errors.exportRateLimited(Math.ceil(quota.retryAfterSec / 60)), code: "rate_limited" },
      { "retry-after": String(quota.retryAfterSec) }
    )
  }

  let batches: AsyncGenerator<(McpLogExportRow | ActivityLogListRow)[]>
  try {
    batches =
      query.tab === "mcp"
        ? iterateMcpLogsForExport(user, mcpFiltersFromQuery(query), LOG_EXPORT_MAX_ROWS)
        : iterateActivityLogsForExport(user, activityFiltersFromQuery(query), LOG_EXPORT_MAX_ROWS)
  } catch {
    return json(400, { error: tl.errors.invalidRange })
  }

  const meta = metaFromHeaders(req.headers)
  const encoder = new TextEncoder()
  let rows = 0
  let logged = false
  const audit = async (status: "success" | "failure", completed: boolean) => {
    if (logged) return
    logged = true
    await logActivity({
      actor: actorOf(user),
      action: "logs.export",
      target: { type: "logs", id: query.tab, label: tl.tabs[query.tab] },
      status,
      ip: meta.ip,
      userAgent: meta.userAgent,
      metadata: {
        tab: query.tab,
        filters: logQueryToSearchParams(query).toString(),
        rows,
        capped: rows >= LOG_EXPORT_MAX_ROWS,
        completed,
      },
    }).catch((e: unknown) => console.error("[logs export] audit failed", safeErrorForLog(e)))
  }

  const header = query.tab === "mcp" ? tl.csv.mcpHeaders : tl.csv.staffHeaders
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(CSV_BOM + csvLine(header)))
    },
    async pull(controller) {
      try {
        const { value, done } = await batches.next()
        if (done) {
          await audit("success", true)
          controller.close()
          return
        }
        rows += value.length
        const text =
          query.tab === "mcp"
            ? (value as McpLogExportRow[]).map(mcpRow).join("")
            : (value as ActivityLogListRow[]).map(activityRow).join("")
        controller.enqueue(encoder.encode(text))
      } catch (e) {
        console.error("[logs export]", safeErrorForLog(e))
        await audit("failure", false)
        controller.error(e)
      }
    },
    async cancel() {
      await batches.return(undefined)
      await audit("success", false)
    },
  })

  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date())
  const fileName = tl.csv.fileName(query.tab, date)
  return new Response(stream, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  })
}
