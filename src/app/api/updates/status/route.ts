// GET /api/updates/status - snapshot for the /settings/updates page to poll (admin only, never cached).
// Staff -> 404 (the update system does not exist for them); no session -> 401. Tolerates a failing database:
// the page keeps polling while the web container restarts during an update.
import { safeErrorForLog } from "@/server/audit/safe-error"
import { AuthorizationError, requireUserForAction } from "@/server/auth/session"
import { getUpdateStatus } from "@/server/services/updates"

export const dynamic = "force-dynamic"

const NO_STORE = { "Cache-Control": "no-store" }

export async function GET() {
  try {
    const session = await requireUserForAction()
    if (session.user.role !== "admin") return new Response(null, { status: 404, headers: NO_STORE })
    return Response.json(await getUpdateStatus(), { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthorizationError) return Response.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE })
    console.error("[api/updates/status]", safeErrorForLog(e))
    return Response.json({ error: "unavailable" }, { status: 503, headers: NO_STORE })
  }
}
