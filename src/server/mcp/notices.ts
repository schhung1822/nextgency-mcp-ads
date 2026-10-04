// Notice block appended to every MCP tool result (.claude/docs/13-system-notices.md §4): "a newer release is
// waiting" + the system notices fetched from noti.vn, one line each. Plain text in an extra `content` item -
// structuredContent (validated against each tool's outputSchema) is never touched. Never throws: a DB problem
// only means no notice. No `next/*` imports (MCP layer).
import type { CallToolResult } from "@modelcontextprotocol/server"

import { buildMcpNoticeText } from "@/lib/system-notices"
import { isNewerVersion, parseSemver } from "@/lib/version"

import { getActiveNotices, NOTICES_CACHE_MS } from "../jobs/lib/system-notices"
import { readLatestRelease } from "../jobs/lib/update-check"

/** Running version as baked into the image ("v1.2.0" / "1.2.0"); a dev build ("dev") never shows the update line. */
export function runningVersion(
  env: Record<string, string | undefined> = process.env
): string | null {
  const raw = env.APP_BUILD_VERSION?.trim().replace(/^v/, "") ?? ""
  return parseSemver(raw) ? raw : null
}

let updateCache: { at: number; available: boolean } | null = null

async function isUpdateAvailable(now: number): Promise<boolean> {
  if (updateCache && now - updateCache.at < NOTICES_CACHE_MS)
    return updateCache.available
  const current = runningVersion()
  let available = false
  if (current) {
    try {
      const latest = await readLatestRelease()
      available = !!latest && isNewerVersion(latest.version, current)
    } catch {
      available = updateCache?.available ?? false
    }
  }
  updateCache = { at: now, available }
  return available
}

/** The notice text for the current moment (cached ~60 s per process), or null. */
export async function currentNoticeText(
  now = Date.now()
): Promise<string | null> {
  try {
    const [updateAvailable, notices] = await Promise.all([
      isUpdateAvailable(now),
      getActiveNotices(now),
    ])
    return buildMcpNoticeText({ updateAvailable, notices })
  } catch {
    return null
  }
}

/** Append the notice block (if any) as the last content item. */
export function appendNotice(
  result: CallToolResult,
  text: string | null
): CallToolResult {
  if (!text) return result
  return {
    ...result,
    content: [
      ...(result.content ?? []),
      { type: "text", text, annotations: { audience: ["user", "assistant"] } },
    ],
  }
}

export function resetNoticeCacheForTests(): void {
  updateCache = null
}
