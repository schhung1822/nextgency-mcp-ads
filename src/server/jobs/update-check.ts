// Job "update.check" (every 6 hours): ask GitHub for the newest release and store it in app_settings
// (`update_latest`, or `update_check_error` on failure) so the web app can tell admins a new version exists.
// A failed check (GitHub down, rate limit, bad token) is recorded, not thrown: retrying within minutes would
// only burn the rate limit; the next scheduled run tries again. Not written to activity_logs (only a manual
// "Kiểm tra ngay" is). Runs in the worker bundle: no `next/*`, no `server-only`.
import { isNewerVersion } from "@/lib/version"
import { notifyUpdateAvailable } from "@/server/notifications/events"

import packageJson from "../../../package.json"

import { readLatestRelease, runUpdateCheck, type UpdateCheckErrorCode } from "./lib/update-check"
import type { JobDefinition } from "./types"

/** Version of this worker build (APP_BUILD_VERSION baked into the image, else package.json). */
function runningVersion(): string {
  const raw = process.env.APP_BUILD_VERSION?.trim()
  return raw ? raw.replace(/^v/, "") : packageJson.version
}

export type UpdateCheckJobResult = { ok: true; version: string } | { ok: false; code: UpdateCheckErrorCode }

export const updateCheckJob: JobDefinition = {
  name: "update.check",
  // 20 minutes past every 6th hour: not on the same minute as tokens.health (0 */6)
  cron: "20 */6 * * *",
  queue: { expireInSeconds: 5 * 60, retryLimit: 0 },
  handler: async (_data, ctx): Promise<UpdateCheckJobResult> => {
    const previous = await readLatestRelease()
    const r = await runUpdateCheck({ signal: ctx.signal })
    if (r.ok) {
      ctx.log(`latest=${r.release.tag}`)
      // Telegram (admin channels subscribed to system_update): only when the release differs from the stored one;
      // never throws, deduplicated per channel by `update:<version>`
      const running = runningVersion()
      if (r.release.version !== previous?.version && isNewerVersion(r.release.version, running)) {
        await notifyUpdateAvailable({ version: r.release.version, currentVersion: running, notes: r.release.notes })
      }
      return { ok: true, version: r.release.version }
    }
    ctx.log(`check failed: ${r.code}`)
    return { ok: false, code: r.code }
  },
}
