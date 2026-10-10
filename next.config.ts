import type { NextConfig } from "next"

const isDev = process.env.NODE_ENV === "development"

// Pragmatic CSP without nonces (node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md,
// "Without Nonces"): Next's inline bootstrap scripts and the theme script need 'unsafe-inline'; React dev
// tooling needs 'unsafe-eval' in development only. Everything else is same-origin; no third-party origins.
// A nonce-based policy would force dynamic rendering + proxy changes for every page — not worth it here
// because the app renders no third-party content and never uses dangerouslySetInnerHTML with user data.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ")

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Content-Security-Policy", value: csp },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
]

// Server Actions: Next rejects actions whose Origin host differs from the request host (x-forwarded-host /
// host). Caddy forwards the public Host, so no `serverActions.allowedOrigins` entry is needed (the default
// "same origin only" is the strictest setting). The list is fixed at build time — do NOT add APP_DOMAIN here.

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // Dev logs print Server Function arguments verbatim (tokens, app secrets, passwords) — never allow that.
  // …and the dev request log prints the full URL: /mcp/<key> (and /dl/<relay token>) would put live secrets into
  // terminals / pasted logs.
  logging: { serverFunctions: false, incomingRequests: { ignore: [/\/mcp\//, /\/dl\//] } },
  images: { unoptimized: true },
  serverExternalPackages: ["pg", "pg-boss"],
  // "Mẹo sử dụng" (/tips/<slug>, src/lib/tips-routes.ts): /tips has no page of its own; the old single page
  // /automation-tips (bookmarks, docs) moved to /tips/automation. Checked before the proxy, so a signed-out visitor
  // lands on /login?next=/tips/automation. Query strings are passed through by Next.
  async redirects() {
    return [
      { source: "/tips", destination: "/tips/automation", permanent: false },
      { source: "/automation-tips", destination: "/tips/automation", permanent: true },
      { source: "/automation-tips/:path+", destination: "/tips/automation", permanent: true },
    ]
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      { source: "/mcp/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }, { key: "Cache-Control", value: "no-store" }] },
      // Temporary video links /dl/<token>/<name> (15-google-drive-media.md §8): the token is in the path, the body is a
      // video the ad platforms download. STRICTER than the app CSP and no referrer. Must live here: Next never lets a
      // route handler override a header that next.config already set (send-response.js only adds missing headers);
      // a later entry overrides the same key of "/:path*". The other relay headers come from the route.
      {
        source: "/dl/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "default-src 'none'; sandbox" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
    ]
  },
}

export default nextConfig
