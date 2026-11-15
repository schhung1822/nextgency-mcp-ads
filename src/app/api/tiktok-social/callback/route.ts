// TikTok Social OAuth callback (17-tiktok-social.md §3, §5). TikTok sends the browser back here with ?code&state
// (or ?error). Session auth (cookie) + the encrypted state cookie set by startTiktokSocialConnectAction (same user, same
// state, ≤ 10 min, used once). The code is exchanged server-side (PKCE); the browser is then redirected to the
// TikTok Social tab with a short status (?status=ok&u=<username> | ?status=error&reason=<key>) - never a token / code.
import { cookies } from "next/headers"

import { tiktokSocialCallbackSchema } from "@/lib/schemas/tiktok-social"
import { safeErrorForLog } from "@/server/audit/safe-error"
import { AuthorizationError, requireUserForAction } from "@/server/auth/session"
import { appBaseUrl } from "@/server/env"
import {
  completeTiktokSocialConnect,
  TiktokSocialServiceError,
  tiktokSocialStateCookieName,
} from "@/server/services/tiktok-social-accounts"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const PAGE = "/connections"
const USERNAME_RE = /^[\w.]{1,64}$/

function back(params: Record<string, string>): Response {
  const u = new URL(PAGE, `${appBaseUrl()}/`)
  u.searchParams.set("tab", "tiktok-social")
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
  return new Response(null, {
    status: 303,
    headers: { Location: u.toString(), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  })
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const parsed = tiktokSocialCallbackSchema.safeParse({
    code: url.searchParams.get("code") ?? undefined,
    state: url.searchParams.get("state") ?? undefined,
    error: url.searchParams.get("error") ?? undefined,
  })
  const jar = await cookies()
  const name = tiktokSocialStateCookieName()
  const blob = jar.get(name)?.value
  // the state cookie is single-use, whatever happens next
  jar.delete(name)
  try {
    const session = await requireUserForAction()
    if (!parsed.success) return back({ status: "error", reason: "state" })
    const res = await completeTiktokSocialConnect(session.user, { ...parsed.data, stateBlob: blob })
    return back({ status: "ok", u: res.username, ...(res.reconnected ? { re: "1" } : {}) })
  } catch (err) {
    if (err instanceof AuthorizationError) return back({ status: "error", reason: "state" })
    if (err instanceof TiktokSocialServiceError) {
      const extra: Record<string, string> =
        err.reason === "wrong" && USERNAME_RE.test(err.fieldErrors?.expected ?? "") && USERNAME_RE.test(err.fieldErrors?.got ?? "")
          ? { exp: err.fieldErrors!.expected!, got: err.fieldErrors!.got! }
          : {}
      return back({ status: "error", reason: err.reason ?? "down", ...extra })
    }
    console.error("[tiktok-social/callback]", safeErrorForLog(err))
    return back({ status: "error", reason: "down" })
  }
}
