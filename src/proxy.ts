// Next 16 proxy (formerly middleware): OPTIMISTIC redirect to /login when there is no session cookie.
// Not a security boundary - pages/actions/routes re-check with requireUser()/requireUserForAction().
// The matcher excludes /mcp (MCP endpoint: the proxy would buffer/limit the body), Better Auth, health,
// the public auth pages, the public legal pages (/privacy, /terms, /data-deletion - Meta's crawler must reach
// them without a session), Next internals and static files.
import { getSessionCookie } from "better-auth/cookies"
import { NextResponse, type NextRequest } from "next/server"

export function proxy(request: NextRequest) {
  if (getSessionCookie(request)) return NextResponse.next()
  const url = request.nextUrl.clone()
  const next = `${request.nextUrl.pathname}${request.nextUrl.search}`
  url.pathname = "/login"
  url.search = ""
  if (next !== "/") url.searchParams.set("next", next)
  return NextResponse.redirect(url)
}

export const config = {
  matcher: [
    "/((?!mcp(?:/|$)|api/auth(?:/|$)|api/health(?:/|$)|login(?:/|$)|setup(?:/|$)|privacy(?:/|$)|terms(?:/|$)|data-deletion(?:/|$)|_next/|brand/|favicon\\.ico$|robots\\.txt$|.*\\.(?:png|jpe?g|gif|svg|ico|webp|avif|txt|xml|webmanifest|css|js|map|woff2?)$).*)",
  ],
}
