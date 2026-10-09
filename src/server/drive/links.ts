// Parse Google Drive / Docs links (formats observed in practice - doc 15 §6, UNVERIFIED in Google's docs). The id is
// only a candidate: callers always confirm it with files.get. No imports from "next/*".
import type { DriveLink } from "./types"

/** Drive file / folder / spreadsheet id */
const ID_RE = /^[A-Za-z0-9_-]{10,200}$/
/** resource key value (opaque, short) */
const RESOURCE_KEY_RE = /^[A-Za-z0-9_-]{1,128}$/

const DRIVE_HOSTS = new Set([
  "drive.google.com",
  "docs.google.com",
  "drive.usercontent.google.com",
])

export function isDriveId(s: string): boolean {
  return ID_RE.test(s)
}

function parseUrl(input: string): URL | null {
  try {
    const u = new URL(input)
    if (u.protocol !== "https:" && u.protocol !== "http:") return null
    return u
  } catch {
    return null
  }
}

/** first query parameter named `name`, any case */
function queryParam(u: URL, name: string): string | null {
  const want = name.toLowerCase()
  for (const [k, v] of u.searchParams) if (k.toLowerCase() === want) return v
  return null
}

function resourceKeyOf(u: URL): string | null {
  const v = queryParam(u, "resourcekey")?.trim()
  return v && RESOURCE_KEY_RE.test(v) ? v : null
}

/** gid from "#gid=123", "#gid=123&range=A1" or "?gid=123" */
function gidOf(u: URL): number | null {
  const fromHash = /(?:^|[#&])gid=(\d{1,10})(?:&|$)/.exec(u.hash)?.[1]
  const raw = fromHash ?? queryParam(u, "gid")
  if (raw === null || !/^\d{1,10}$/.test(raw)) return null
  const n = Number(raw)
  return Number.isSafeInteger(n) && n <= 2_147_483_647 ? n : null
}

function link(
  kind: DriveLink["kind"],
  id: string | null | undefined,
  u: URL,
  gid: number | null = null
): DriveLink | null {
  if (!id || !ID_RE.test(id)) return null
  return { kind, id, resourceKey: resourceKeyOf(u), gid }
}

/**
 * drive.google.com/file/d/<id>/…, /open?id=, /uc?id=…, /drive/folders/<id>, /drive/u/<n>/folders/<id>,
 * drive.usercontent.google.com/download?id=, docs.google.com/spreadsheets/d/<id>/…#gid=<gid>,
 * docs.google.com/{document|presentation}/d/<id> (kind "document"); `resourcekey` query param (any case).
 * A bare id ([A-Za-z0-9_-]{10,}) → kind "unknown". Anything else → null.
 */
export function parseDriveLink(input: string): DriveLink | null {
  const s = String(input ?? "").trim()
  if (!s || s.length > 2048) return null
  if (ID_RE.test(s))
    return { kind: "unknown", id: s, resourceKey: null, gid: null }
  const u = parseUrl(s)
  if (!u || u.username || u.password) return null
  const host = u.hostname.toLowerCase()
  if (!DRIVE_HOSTS.has(host)) return null
  // "/u/0/" (signed-in account index) can appear in any of the paths below
  const path = u.pathname.replace(/\/u\/\d{1,2}(?=\/)/g, "")
  const seg = path.split("/").filter(Boolean)

  if (host === "drive.usercontent.google.com") {
    // /download?id=…, /uc?id=…
    if (seg[0] === "download" || seg[0] === "uc")
      return link("file", queryParam(u, "id"), u)
    return null
  }

  if (host === "docs.google.com") {
    const [app, d, id] = seg
    if (d !== "d") {
      // docs.google.com/uc?id=… (old download links)
      if (app === "uc") return link("file", queryParam(u, "id"), u)
      return null
    }
    if (app === "spreadsheets") return link("sheet", id, u, gidOf(u))
    if (
      app === "document" ||
      app === "presentation" ||
      app === "forms" ||
      app === "drawings"
    )
      return link("document", id, u)
    if (app === "file") return link("file", id, u)
    return null
  }

  // drive.google.com
  if (seg[0] === "file" && seg[1] === "d") return link("file", seg[2], u)
  if (seg[0] === "uc" || seg[0] === "thumbnail")
    return link("file", queryParam(u, "id"), u)
  if (seg[0] === "open" || seg[0] === "folderview")
    return link(
      seg[0] === "folderview" ? "folder" : "unknown",
      queryParam(u, "id"),
      u
    )
  if (seg[0] === "drive") {
    // /drive/folders/<id>, /drive/mobile/folders/<id>, /drive/u/1/folders/<id>
    const i = seg.indexOf("folders")
    if (i > 0 && i <= 2) return link("folder", seg[i + 1], u)
  }
  return null
}

/** true when the string is an http(s) URL on a Google Drive / Docs host (used to route `url` to the Drive path). */
export function isGoogleDriveUrl(input: string): boolean {
  const u = parseUrl(String(input ?? "").trim())
  return !!u && DRIVE_HOSTS.has(u.hostname.toLowerCase())
}
