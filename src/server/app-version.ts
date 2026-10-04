// Running app version (server side). Kept out of src/lib/version.ts on purpose: that module is imported by client
// components and must not pull package.json (dependency list, scripts) into the browser bundle.
import "server-only"

import { parseSemver } from "@/lib/version"

import packageJson from "../../package.json"

/**
 * `APP_BUILD_VERSION` (baked at image build from the git tag; "v1.2.0" or "1.2.0"), else package.json#version.
 * A non-semver build value (e.g. "dev", "main") is returned as-is (sanitised, <= 32 chars) - such a build is not
 * a release and cannot be updated automatically.
 */
export function getAppVersion(env: Record<string, string | undefined> = process.env): string {
  const raw = env.APP_BUILD_VERSION?.trim()
  if (raw) {
    const stripped = raw.startsWith("v") ? raw.slice(1) : raw
    if (parseSemver(stripped)) return stripped
    const safe = raw.replace(/[^\w.\-+]/g, "").slice(0, 32)
    if (safe) return safe
  }
  return packageJson.version
}
