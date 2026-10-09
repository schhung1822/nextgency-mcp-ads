// Defence in depth for security review H1: Drive folders a viewer must never reach through ANOTHER source (e.g. a
// company folder registered above a staff member's personal folder before the registration check existed, or a
// folder moved later). Used with findAncestorIn(..., { blocked }) and to hide blocked sub-folders in listings.
// No imports from "next/*".
import { and, eq, isNull, ne, sql } from "drizzle-orm"

import { db, type Tx } from "../db/client"
import { driveSources } from "../db/schema"

export interface BlockedViewer {
  id: string
  role: "admin" | "staff"
}

/**
 * Google ids of LIVE (not deleted, any status) personal FOLDER sources owned by someone other than `viewer.id`.
 * An admin viewer gets an empty set (admins may use every source - G4).
 *
 * Exception: a personal folder registered INSIDE an older live company folder (allowed by doc 15 §5.2-2 - it was
 * already shared) is not blocked; otherwise a staff member could hide company sub-folders from everybody by
 * registering them. The decision uses the stored ancestor_ids (refreshed by recheck / drive.health); rows whose
 * ancestors are not known yet stay blocked (safe default).
 */
export async function loadBlockedFolderIds(
  viewer: BlockedViewer,
  tx: Tx | typeof db = db
): Promise<Set<string>> {
  if (viewer.role === "admin") return new Set()
  return loadOtherPersonalFolderIds(viewer.id, tx)
}

/**
 * The folders loadBlockedFolderIds blocks for a STAFF viewer `ownerId`, whatever the role of `ownerId`: used by
 * drive.health / recheck to flag a source (company sources too) that now sits inside someone else's personal folder.
 */
export async function loadOtherPersonalFolderIds(
  ownerId: string,
  tx: Tx | typeof db = db
): Promise<Set<string>> {
  const rows = await tx
    .selectDistinct({ googleId: driveSources.googleId })
    .from(driveSources)
    .where(
      and(
        isNull(driveSources.deletedAt),
        eq(driveSources.kind, "folder"),
        eq(driveSources.scope, "personal"),
        ne(driveSources.ownerId, ownerId),
        // the alias hides the table name inside the sub-query: "drive_sources".* below is the outer row
        sql`not exists (select 1 from ${driveSources} c where c.deleted_at is null and c.kind = 'folder' and c.scope = 'company' and c.google_id = any(${driveSources.ancestorIds}) and c.created_at < ${driveSources.createdAt})`
      )
    )
  return new Set(rows.map((r) => r.googleId))
}

/**
 * A source is blocked for a viewer when the folder itself, or one of its stored ancestors (drive_sources.ancestor_ids),
 * is a folder blocked for that viewer (security review T-2): e.g. a company folder that was later moved INTO a staff
 * member's personal folder must not open it to other staff.
 */
export function sourceIsBlocked(
  source: { googleId: string; ancestorIds?: readonly string[] | null },
  blocked: ReadonlySet<string>
): boolean {
  if (blocked.size === 0) return false
  if (blocked.has(source.googleId)) return true
  return (source.ancestorIds ?? []).some((id) => blocked.has(id))
}
