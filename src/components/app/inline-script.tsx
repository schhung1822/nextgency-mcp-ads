"use client"

/**
 * `type` for a script that must execute only from the server HTML (runs during parsing, before first
 * paint). When React renders the element in the browser (client-rendered root after hydration/error
 * recovery, not-found, dev Strict Mode remount) it is an inert `text/plain` data block: React does not
 * warn "Encountered a script tag while rendering React component" and nothing re-executes.
 * Must be evaluated in a CLIENT component - a server component would bake "text/javascript" into the
 * RSC payload. Pattern: node_modules/next/dist/docs/01-app/02-guides/preventing-flash-before-hydration.md
 */
export function ssrOnlyScriptType(): "text/javascript" | "text/plain" {
  return typeof window === "undefined" ? "text/javascript" : "text/plain"
}

/** Inline pre-paint script; `suppressHydrationWarning` covers the server/client `type` mismatch. */
export function InlineScript({
  html,
  nonce,
}: {
  html: string
  nonce?: string
}) {
  return (
    <script
      type={ssrOnlyScriptType()}
      nonce={nonce}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
