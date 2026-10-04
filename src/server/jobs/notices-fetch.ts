// Job "notices.fetch" (hourly + once when the worker starts): GET the noti.vn notice webhook and store the result
// in app_settings.system_notices (top bar ticker + MCP results read it). A failing webhook is recorded, not
// thrown: the next hourly run tries again and the last good notices stay visible for up to 24 h.
// Runs in the worker bundle: no `next/*`, no `server-only`.
import {
  runNoticesFetch,
  type NoticesFetchErrorCode,
} from "./lib/system-notices"
import type { JobDefinition } from "./types"

export type NoticesFetchJobResult =
  | { ok: true; count: number }
  | { ok: false; code: NoticesFetchErrorCode; kept: number }

export const noticesFetchJob: JobDefinition = {
  name: "notices.fetch",
  // minute 10 of every hour: away from the other jobs' minutes (0, 5-multiples, 7, 15, 20, 45)
  cron: "10 * * * *",
  runOnStart: true,
  queue: { expireInSeconds: 2 * 60, retryLimit: 0 },
  handler: async (_data, ctx): Promise<NoticesFetchJobResult> => {
    const { result, stored } = await runNoticesFetch({ signal: ctx.signal })
    if (result.ok) {
      ctx.log(`notices=${result.items.length}`)
      return { ok: true, count: result.items.length }
    }
    ctx.log(
      `fetch failed: ${result.code}${result.status ? ` ${result.status}` : ""} (kept ${stored.items.length})`
    )
    return { ok: false, code: result.code, kept: stored.items.length }
  },
}
