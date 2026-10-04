"use client"

// Polls GET /api/updates/status. Built to survive the web container restarting in the middle of an update: a
// failed fetch (network error, 502/503 from the reverse proxy) is "reconnecting", never an error, and polling keeps
// going. When the reported version differs from the one this page was loaded with, the new build is up.
import * as React from "react"

import type { UpdateStatus } from "@/lib/update-types"

export type LinkState = "ok" | "reconnecting" | "session_ended"

export const POLL_ACTIVE_MS = 2_500
export const POLL_IDLE_MS = 30_000

export function useUpdateStatus(initial: UpdateStatus) {
  const [status, setStatus] = React.useState(initial)
  const [link, setLink] = React.useState<LinkState>("ok")
  const [versionChanged, setVersionChanged] = React.useState(false)
  /** the request whose progress this page shows (seen active, or started from here) */
  const [watchedId, setWatchedId] = React.useState<string | null>(initial.active?.id ?? null)
  const baseVersion = React.useRef(initial.current)
  const inflight = React.useRef(false)
  const activeRef = React.useRef(!!initial.active)

  const refresh = React.useCallback(async () => {
    if (inflight.current) return
    inflight.current = true
    try {
      const res = await fetch("/api/updates/status", {
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json" },
      })
      const json = res.headers.get("content-type")?.includes("application/json") ?? false
      // no/expired session: the proxy redirects to /login (HTML); a demoted admin gets 404
      if (res.status === 401 || res.status === 404 || (res.ok && (res.redirected || !json))) {
        setLink("session_ended")
        return
      }
      if (!res.ok || !json) {
        setLink("reconnecting")
        return
      }
      const data = (await res.json()) as UpdateStatus
      activeRef.current = !!data.active
      setStatus(data)
      setLink("ok")
      if (data.active) setWatchedId(data.active.id)
      if (data.current !== baseVersion.current) setVersionChanged(true)
    } catch {
      setLink("reconnecting")
    } finally {
      inflight.current = false
    }
  }, [])

  React.useEffect(() => {
    // one fast tick; while an update is open every tick polls, otherwise only every POLL_IDLE_MS (and not in a
    // background tab) - so starting an update speeds polling up immediately
    const every = Math.round(POLL_IDLE_MS / POLL_ACTIVE_MS)
    let ticks = 0
    const id = setInterval(() => {
      ticks++
      if (activeRef.current) void refresh()
      else if (ticks % every === 0 && !document.hidden) void refresh()
    }, POLL_ACTIVE_MS)
    return () => clearInterval(id)
  }, [refresh])

  /** apply a snapshot returned by an action (e.g. "Kiểm tra ngay") */
  const apply = React.useCallback((next: UpdateStatus) => {
    activeRef.current = !!next.active
    setStatus(next)
  }, [])

  return { status, link, versionChanged, watchedId, setWatchedId, refresh, apply }
}
