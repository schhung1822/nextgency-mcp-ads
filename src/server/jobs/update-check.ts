// Job "update.check" (every 6 hours): ask GitHub for the newest release and store it in app_settings
// (`update_latest`, or `update_check_error` on failure) so the web app can tell admins a new version exists.
// A failed check (GitHub down, rate limit, bad token) is recorded, not thrown: retrying within minutes would
// only burn the rate limit; the next scheduled run tries again. Not written to activity_logs (only a manual
// "Kiểm tra ngay" is). Runs in the worker bundle: no `next/*`, no `server-only`.
import { runUpdateCheck, type UpdateCheckErrorCode } from "./lib/update-check"
import type { JobDefinition } from "./types"

export type UpdateCheckJobResult = { ok: true; version: string } | { ok: false; code: UpdateCheckErrorCode }

export const updateCheckJob: JobDefinition = {
  name: "update.check",
  // 20 minutes past every 6th hour: not on the same minute as tokens.health (0 */6)
  cron: "20 */6 * * *",
  queue: { expireInSeconds: 5 * 60, retryLimit: 0 },
  handler: async (_data, ctx): Promise<UpdateCheckJobResult> => {
    const r = await runUpdateCheck({ signal: ctx.signal })
    if (r.ok) {
      ctx.log(`latest=${r.release.tag}`)
      return { ok: true, version: r.release.version }
    }
    ctx.log(`check failed: ${r.code}`)
    return { ok: false, code: r.code }
  },
}
