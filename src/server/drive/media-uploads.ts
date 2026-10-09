// Reuse of media ids already uploaded from Drive (15-google-drive-media.md §7.4).
// Key (ad_account_id, drive_file_id, content_key): a file whose content changed on Drive gets a new content key and
// is uploaded again. Media ids are not re-verified on the platform (quota); force_reupload overrides.
// No imports from "next/*".
import { and, eq, inArray, sql } from "drizzle-orm"

import { db, type Tx } from "@/server/db/client"
import { driveMediaUploads } from "@/server/db/schema"

import type { DriveMediaFamily } from "./types"

type DbLike = Tx | typeof db

export interface MediaUploadKey {
  adAccountId: string
  driveFileId: string
  contentKey: string
}

export interface ReusableMedia {
  mediaId: string
  mediaType: DriveMediaFamily
  mediaUrl: string | null
}

/** The media id recorded for this exact file version in this ad account (bumps last_used_at), or null. */
export async function findReusableMedia(
  key: MediaUploadKey,
  tx: DbLike = db
): Promise<ReusableMedia | null> {
  const [row] = await tx
    .update(driveMediaUploads)
    .set({ lastUsedAt: sql`now()` })
    .where(
      and(
        eq(driveMediaUploads.adAccountId, key.adAccountId),
        eq(driveMediaUploads.driveFileId, key.driveFileId),
        eq(driveMediaUploads.contentKey, key.contentKey)
      )
    )
    .returning({
      mediaId: driveMediaUploads.mediaId,
      mediaType: driveMediaUploads.mediaType,
      mediaUrl: driveMediaUploads.mediaUrl,
    })
  if (!row) return null
  return {
    mediaId: row.mediaId,
    mediaType: row.mediaType as DriveMediaFamily,
    mediaUrl: row.mediaUrl,
  }
}

export interface RecordMediaUploadInput extends MediaUploadKey {
  mediaType: DriveMediaFamily
  mediaId: string
  mediaUrl?: string | null
  sizeBytes?: number | null
  /** granted folder the file was resolved through (null: public link) */
  sourceId?: string | null
  mcpId?: string | null
}

/**
 * Insert or refresh (force_reupload / concurrent upload) the media id of a file version. first_mcp_id is kept from
 * the first upload; last_used_at is bumped.
 */
export async function recordMediaUpload(
  input: RecordMediaUploadInput,
  tx: DbLike = db
): Promise<void> {
  await tx
    .insert(driveMediaUploads)
    .values({
      adAccountId: input.adAccountId,
      driveFileId: input.driveFileId,
      contentKey: input.contentKey,
      mediaType: input.mediaType,
      mediaId: input.mediaId,
      mediaUrl: input.mediaUrl ?? null,
      sizeBytes: input.sizeBytes ?? null,
      sourceId: input.sourceId ?? null,
      firstMcpId: input.mcpId ?? null,
    })
    .onConflictDoUpdate({
      target: [
        driveMediaUploads.adAccountId,
        driveMediaUploads.driveFileId,
        driveMediaUploads.contentKey,
      ],
      set: {
        mediaType: sql`excluded.media_type`,
        mediaId: sql`excluded.media_id`,
        mediaUrl: sql`excluded.media_url`,
        sizeBytes: sql`coalesce(excluded.size_bytes, ${driveMediaUploads.sizeBytes})`,
        sourceId: sql`coalesce(excluded.source_id, ${driveMediaUploads.sourceId})`,
        lastUsedAt: sql`now()`,
      },
    })
}

export interface MediaUploadUse {
  driveFileId: string
  adAccountId: string
  contentKey: string
  mediaId: string
  mediaType: DriveMediaFamily
  lastUsedAt: Date
}

/**
 * "uploaded_to" of a page of files, limited to the ad accounts the caller may see (grant / UI visibility).
 * Empty input → no query.
 */
export async function listMediaUploadsForFiles(
  driveFileIds: readonly string[],
  adAccountIds: readonly string[],
  tx: DbLike = db
): Promise<MediaUploadUse[]> {
  if (driveFileIds.length === 0 || adAccountIds.length === 0) return []
  const rows = await tx
    .select({
      driveFileId: driveMediaUploads.driveFileId,
      adAccountId: driveMediaUploads.adAccountId,
      contentKey: driveMediaUploads.contentKey,
      mediaId: driveMediaUploads.mediaId,
      mediaType: driveMediaUploads.mediaType,
      lastUsedAt: driveMediaUploads.lastUsedAt,
    })
    .from(driveMediaUploads)
    .where(
      and(
        inArray(driveMediaUploads.driveFileId, [...new Set(driveFileIds)]),
        inArray(driveMediaUploads.adAccountId, [...new Set(adAccountIds)])
      )
    )
  return rows.map((r) => ({
    ...r,
    mediaType: r.mediaType as DriveMediaFamily,
  }))
}
