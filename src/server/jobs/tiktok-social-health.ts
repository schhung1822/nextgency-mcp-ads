// tiktok-social.health - every 6 hours at :20 (APP_TIMEZONE): refresh TikTok Social access tokens (1-day tokens) before
// they lapse, flag accounts whose 1-year authorization ends within 14 days. See src/server/tiktok-social/health.ts.
import { runTiktokSocialHealth } from "@/server/tiktok-social/health"

import type { JobDefinition } from "./types"

export const tiktokSocialHealthJob: JobDefinition = {
  name: "tiktok-social.health",
  cron: "20 */6 * * *",
  queue: { expireInSeconds: 30 * 60, retryLimit: 1 },
  handler: (_data, ctx) => runTiktokSocialHealth({ signal: ctx.signal, log: ctx.log }),
}
