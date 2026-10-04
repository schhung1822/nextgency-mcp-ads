// CSRF guard for cookie-authenticated route handlers (server actions already check Origin themselves).
// A state-changing or data-exporting request must come from the app's own pages: `Origin` must be the app
// origin (BETTER_AUTH_URL) or the request's own origin, and Fetch Metadata (`Sec-Fetch-Site`), when the
// browser sends it, must be "same-origin". A missing Origin is rejected (browsers always send it on POST).

export function isSameOriginRequest(req: Request, appOrigin: string): boolean {
  const site = req.headers.get("sec-fetch-site")
  if (site && site !== "same-origin") return false
  const origin = req.headers.get("origin")
  if (!origin || origin === "null") return false
  const allowed = new Set<string>([new URL(req.url).origin])
  try {
    allowed.add(new URL(appOrigin).origin)
  } catch {
    /* invalid app origin: only the request origin */
  }
  return allowed.has(origin)
}
