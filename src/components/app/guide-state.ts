// Pure state helpers for the Guide panel (no React): the registry that pages publish their guide into,
// and the "collapsed" preference (localStorage + html[data-guide-collapsed]). Kept React-free so it is unit-testable.
import type { GuideDef } from "@/lib/guide-types"

import type { Platform } from "./types"

export interface RegisteredGuide {
  guide: GuideDef
  /** shows the platform icon next to the title instead of the book icon */
  platform?: Platform
}

export interface GuideStore {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => RegisteredGuide | null
  /** publishes a guide; returns the token to hand back to `unregister` */
  register: (entry: RegisteredGuide) => symbol
  /**
   * Withdraws a guide. The previous guide stays visible for `graceMs` so the panel does not flicker while the
   * next page streams in (loading.tsx unmounts the old page before the new one registers).
   */
  unregister: (token: symbol) => void
}

export const GUIDE_UNREGISTER_GRACE_MS = 1500

export function createGuideStore(
  graceMs: number = GUIDE_UNREGISTER_GRACE_MS
): GuideStore {
  let current: { token: symbol; entry: RegisteredGuide } | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const listeners = new Set<() => void>()
  const emit = () => listeners.forEach((l) => l())
  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => current?.entry ?? null,
    register(entry) {
      const token = Symbol("guide")
      clearTimer()
      current = { token, entry }
      emit()
      return token
    },
    unregister(token) {
      if (current?.token !== token) return
      clearTimer()
      timer = setTimeout(() => {
        timer = null
        if (current?.token === token) {
          current = null
          emit()
        }
      }, graceMs)
    },
  }
}

// ---------------------------------------------------------------------------------------------------------
// "Thu gọn" - session-only on purpose: the docked panel is open by default on every page / step / tab, so a
// collapse only lasts until the guide content changes (GuideProvider re-opens it). <html data-guide-collapsed>
// drives the CSS (panel hidden + top bar "Hướng dẫn" button shown).

export const GUIDE_COLLAPSED_ATTR = "data-guide-collapsed"
const CHANGE_EVENT = "ads-mcp:guide-collapsed-change"

/** Legacy key from when the collapse was remembered; kept only so the old value can be cleared. */
export function guideStorageKey(userId?: string | null): string {
  return `ads-mcp:guide-collapsed:${userId ? userId : "anon"}`
}

/** Inline script (runs before paint): makes sure an old remembered collapse never hides the panel. */
export function guideInitScript(storageKey: string): string {
  return `(function(){try{document.documentElement.removeAttribute(${JSON.stringify(
    GUIDE_COLLAPSED_ATTR
  )});localStorage.removeItem(${JSON.stringify(storageKey)})}catch(e){}})()`
}

export function readGuideCollapsed(): boolean {
  if (typeof document === "undefined") return false
  return document.documentElement.hasAttribute(GUIDE_COLLAPSED_ATTR)
}

export function setGuideCollapsed(collapsed: boolean) {
  const root = document.documentElement
  if (collapsed) root.setAttribute(GUIDE_COLLAPSED_ATTR, "1")
  else root.removeAttribute(GUIDE_COLLAPSED_ATTR)
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

export function subscribeGuideCollapsed(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange)
  return () => window.removeEventListener(CHANGE_EVENT, onChange)
}
