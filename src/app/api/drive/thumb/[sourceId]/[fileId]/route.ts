// Thumbnail of a Drive file inside a registered folder source, for the folder grid of /connections/drive/[id]
// (15-google-drive-media.md §11). Session auth (cookie) + the SAME visibility / descendant checks as the page:
// getDriveSourceThumbnail → staff only reach company sources and their own; the file must be an image / video
// inside the source. Every refusal (no session, bad id, not visible, not inside, no thumbnail, Google error) is a
// plain 404 so the route cannot be used to probe which ids exist. The thumbnail bytes come from Google
// (thumbnailLink, *.googleusercontent.com) - never a link, token or resource key.
import { driveThumbnailParamsSchema } from "@/lib/schemas/drive"
import { safeErrorForLog } from "@/server/audit/safe-error"
import { AuthorizationError, requireUserForAction } from "@/server/auth/session"
import { consumeQuota } from "@/server/db/quota"
import {
  DriveServiceError,
  getDriveSourceThumbnail,
} from "@/server/services/drive-sources"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** a folder page shows ≤ 100 tiles; "Tải thêm" / filters fetch more - generous but bounded per user */
const THUMB_QUOTA = { scope: "drive-thumb", max: 600, windowMs: 60_000 }

function notFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  })
}

type Ctx = { params: Promise<{ sourceId: string; fileId: string }> }

export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  const raw = await ctx.params
  const parsed = driveThumbnailParamsSchema.safeParse(raw)
  if (!parsed.success) return notFound()
  try {
    const session = await requireUserForAction()
    const q = await consumeQuota(
      THUMB_QUOTA.scope,
      session.user.id,
      THUMB_QUOTA.max,
      THUMB_QUOTA.windowMs
    )
    if (!q.allowed)
      return new Response("Too many requests", {
        status: 429,
        headers: { "Retry-After": "10", "Cache-Control": "no-store" },
      })
    const thumb = await getDriveSourceThumbnail(
      session.user,
      parsed.data.sourceId,
      parsed.data.fileId
    )
    if (!thumb || !/^image\/[a-z0-9.+-]+$/i.test(thumb.contentType))
      return notFound()
    return new Response(new Uint8Array(thumb.bytes), {
      status: 200,
      headers: {
        "Content-Type": thumb.contentType,
        "Content-Length": String(thumb.bytes.byteLength),
        // per-user content (permission checked): private cache only, short
        "Cache-Control": "private, max-age=300",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": "inline",
        "Cross-Origin-Resource-Policy": "same-origin",
      },
    })
  } catch (e) {
    if (e instanceof AuthorizationError || e instanceof DriveServiceError)
      return notFound()
    console.error("[api/drive/thumb]", safeErrorForLog(e))
    return notFound()
  }
}
