// Single source of truth for WHICH ad platforms this build ships. Safe for client and server (no imports).
//
// - ALL_PLATFORMS mirrors the Postgres enum `platform` (never shrink it: rows and migrations depend on it).
// - RELEASED_PLATFORMS: platforms with an adapter in this build - every list in the app (connections, MCP, logs,
//   charts, grants, jobs) is derived from it.
// - UPCOMING_PLATFORMS: shown as a disabled "Sắp ra mắt" card on /connections/new only; no code ships for them.
//
// Releasing a platform later: restore its adapter, then move it from UPCOMING_PLATFORMS to RELEASED_PLATFORMS
// (full checklist: .claude/docs/12-platform-rollout.md).

export const ALL_PLATFORMS = [
  "meta",
  "tiktok",
  "google_ads",
  "openai_ads",
] as const
export type Platform = (typeof ALL_PLATFORMS)[number]

export const RELEASED_PLATFORMS = [
  "meta",
  "openai_ads",
] as const satisfies readonly Platform[]
export type ReleasedPlatform = (typeof RELEASED_PLATFORMS)[number]

export const UPCOMING_PLATFORMS = [
  "google_ads",
  "tiktok",
] as const satisfies readonly Platform[]

export function isReleasedPlatform(p: string): p is ReleasedPlatform {
  return (RELEASED_PLATFORMS as readonly string[]).includes(p)
}
