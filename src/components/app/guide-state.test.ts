import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  createGuideStore,
  guideInitScript,
  guideStorageKey,
  type RegisteredGuide,
} from "./guide-state"

const a: RegisteredGuide = { guide: { title: "A", summary: "a" } }
const b: RegisteredGuide = { guide: { title: "B", summary: "b" } }

describe("guide store", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("publishes the registered guide and notifies subscribers", () => {
    const store = createGuideStore(100)
    const seen: (string | null)[] = []
    store.subscribe(() => seen.push(store.getSnapshot()?.guide.title ?? null))
    expect(store.getSnapshot()).toBeNull()
    store.register(a)
    expect(store.getSnapshot()).toBe(a)
    expect(seen).toEqual(["A"])
  })

  it("keeps the old guide during the grace period, then clears it", () => {
    const store = createGuideStore(100)
    const token = store.register(a)
    store.unregister(token)
    expect(store.getSnapshot()).toBe(a)
    vi.advanceTimersByTime(99)
    expect(store.getSnapshot()).toBe(a)
    vi.advanceTimersByTime(2)
    expect(store.getSnapshot()).toBeNull()
  })

  it("a new page registering during the grace period replaces the guide for good", () => {
    const store = createGuideStore(100)
    const first = store.register(a)
    store.unregister(first)
    store.register(b)
    vi.advanceTimersByTime(500)
    expect(store.getSnapshot()).toBe(b)
  })

  it("ignores a stale unregister (step change: new guide registers before the old cleanup)", () => {
    const store = createGuideStore(100)
    const first = store.register(a)
    store.register(b)
    store.unregister(first)
    vi.advanceTimersByTime(500)
    expect(store.getSnapshot()).toBe(b)
  })

  it("stops notifying after unsubscribe", () => {
    const store = createGuideStore(100)
    const fn = vi.fn()
    const off = store.subscribe(fn)
    off()
    store.register(a)
    expect(fn).not.toHaveBeenCalled()
  })
})

describe("guide collapsed preference", () => {
  it("keys the preference per user", () => {
    expect(guideStorageKey("u1")).not.toBe(guideStorageKey("u2"))
    expect(guideStorageKey(null)).toBe("ads-mcp:guide-collapsed:anon")
  })

  it("builds a valid pre-paint script for the storage key", () => {
    const script = guideInitScript(guideStorageKey('u"1'))
    expect(() => new Function(script)).not.toThrow()
    expect(script).toContain("data-guide-collapsed")
  })
})
