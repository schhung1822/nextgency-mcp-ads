"use client" // Error boundaries must be Client Components

import * as React from "react"

import "./globals.css"
import { ErrorScreen } from "@/components/app/error-screen"
import { TRANSPARENCY_STORAGE_KEY } from "@/components/app/transparency"
import { common } from "@/lib/i18n/vi/common"

import { fontMono, inter } from "./fonts"

/**
 * Errors in the root layout itself. Replaces the root layout, so it brings its own <html>/<body>,
 * global styles and font, and re-applies the stored theme / reduced-transparency preference
 * (next-themes and TransparencyScript live in the root layout and are not rendered here).
 */
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string }
  retry: () => void
}) {
  const htmlRef = React.useRef<HTMLHtmlElement>(null)
  React.useLayoutEffect(() => {
    const root = htmlRef.current
    if (!root) return
    try {
      const stored = localStorage.getItem("theme")
      const dark =
        stored === "dark" ||
        ((!stored || stored === "system") &&
          window.matchMedia("(prefers-color-scheme: dark)").matches)
      root.classList.toggle("dark", dark)
      root.style.colorScheme = dark ? "dark" : "light"
      if (localStorage.getItem(TRANSPARENCY_STORAGE_KEY) === "reduced")
        root.setAttribute("data-transparency", "reduced")
    } catch {
      /* storage unavailable → light theme */
    }
  }, [])
  return (
    <html
      ref={htmlRef}
      lang="vi"
      className={`${inter.variable} ${fontMono.variable} font-sans antialiased`}
      suppressHydrationWarning
    >
      <body>
        <title>{`${common.errorPage.title} · ${common.appName}`}</title>
        <ErrorScreen error={error} retry={retry} />
      </body>
    </html>
  )
}
