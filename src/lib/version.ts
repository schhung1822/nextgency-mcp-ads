// Strict semver helpers (.claude/docs/10-update-system.md). Framework-free and free of any import: used by the web
// app, the worker (update.check job) and client components - no `next/*`, no `server-only`, no package.json.
// The running version itself is src/server/app-version.ts.
export interface Semver {
  major: number
  minor: number
  patch: number
}

// Strict release versions only: MAJOR.MINOR.PATCH, no leading zeros, no pre-release / build metadata.
const SEMVER_RE = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/

/** "1.2.3" -> parts; anything else ("v1.2", "1.2.3-rc1", "1.02.3", "dev") -> null. No `v` prefix allowed here. */
export function parseSemver(input: string): Semver | null {
  const m = SEMVER_RE.exec(input)
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
}

/** Release tag "v1.2.3" -> "1.2.3" (the `v` is mandatory); anything else (incl. "v1.2.3-rc1") -> null. */
export function versionFromTag(tag: string): string | null {
  if (!tag.startsWith("v")) return null
  const v = tag.slice(1)
  return parseSemver(v) ? v : null
}

export function compareSemver(a: Semver, b: Semver): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
}

/** Compare two version strings; null when either is not a strict semver. */
export function compareVersions(a: string, b: string): number | null {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  return pa && pb ? compareSemver(pa, pb) : null
}

/** True only when both are strict semver and `candidate` is strictly newer than `current`. */
export function isNewerVersion(candidate: string, current: string): boolean {
  return (compareVersions(candidate, current) ?? 0) > 0
}

/** Highest strict-semver tag ("vX.Y.Z") of a list, or null. Pre-release / malformed tags are ignored. */
export function pickLatestTag(tags: readonly string[]): { tag: string; version: string } | null {
  let best: { tag: string; version: string } | null = null
  for (const tag of tags) {
    const version = versionFromTag(tag)
    if (!version) continue
    if (!best || (compareVersions(version, best.version) ?? 0) > 0) best = { tag, version }
  }
  return best
}

/** Display form: "v1.2.0" for releases, "dev" stays "dev". */
export function displayVersion(version: string): string {
  return parseSemver(version) ? `v${version}` : version
}
