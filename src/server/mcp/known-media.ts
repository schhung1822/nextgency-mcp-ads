// "Known media" of an ad account (v1.1.2 S-M1 / C-M2): media ids THIS APP uploaded to that account, so an id the AI
// passes back (meta_create_ad video_id, ads_get_media_upload video_id) can be trusted without asking the platform's
// library (whose id filter is undocumented on Meta). Two sources:
//  - drive_media_uploads (Drive relay / background job / Drive covers - reuse table, no retention limit);
//  - mcp_call_logs: every successful upload (URL, ChatGPT file, Drive, background job "media.video_upload") writes a
//    change row {object_id: <media id>, field: "media_uploaded"} for (platform, ad account) - kept for the log
//    retention (index mcp_call_logs_account_time_idx).
// Never throws: an unreadable source counts as "not known" (the caller then checks on the platform - fail closed).
// No imports from "next/*".
import { and, eq, sql } from "drizzle-orm"
import { safeErrorForLog } from "../audit/safe-error"
import { db } from "../db/client"
import { mcpCallLogs } from "../db/schema"
import { isKnownMediaId } from "../drive/media-uploads"
import type { GrantAccount } from "./types"

/** Field of the change row every media upload logs (upload-media.ts, jobs/media-video-upload.ts, Drive covers). */
export const MEDIA_UPLOADED_FIELD = "media_uploaded"

export async function isKnownMedia(
  account: Pick<GrantAccount, "id" | "platform" | "externalId">,
  mediaId: string
): Promise<boolean> {
  const id = String(mediaId ?? "").trim()
  if (!id || id.length > 200) return false
  try {
    if (await isKnownMediaId(account.id, id)) return true
    const [row] = await db
      .select({ at: mcpCallLogs.createdAt })
      .from(mcpCallLogs)
      .where(
        and(
          eq(mcpCallLogs.platform, account.platform),
          eq(mcpCallLogs.adAccountId, account.externalId),
          eq(mcpCallLogs.status, "success"),
          eq(mcpCallLogs.actionKind, "write"),
          sql`${mcpCallLogs.changes} @> ${JSON.stringify([{ object_id: id, field: MEDIA_UPLOADED_FIELD }])}::jsonb`
        )
      )
      .limit(1)
    return !!row
  } catch (e) {
    console.warn("[mcp] known media lookup failed", safeErrorForLog(e))
    return false
  }
}
