// File types recognised by their MAGIC BYTES (never the Content-Type / extension), shared by Telegram attachments
// (notifications/media.ts) and Google Drive creatives (drive/**): JPEG/PNG/GIF/WebP, MP4/MOV (ISO-BMFF brands), PDF,
// DOCX/XLSX/PPTX (by the names in the ZIP central directory - nothing is decompressed) and text types (UTF-8 with a
// csv/tsv/txt/md/json hint). Neutral errors (MediaTypeError): each caller maps them to its own error type.
// No "next/*" imports.

export type FileFamily = "image" | "video" | "document" | "text"

export interface FileType {
  ext: string
  mime: string
  family: FileFamily
}

/** why a file was refused */
export type MediaTypeErrorReason =
  /** not on the allowlist */
  | "not_allowed"
  /** Office file with macros (vbaProject.bin) */
  | "macro"
  /** Office file carrying OLE objects / ActiveX / binaries / executables */
  | "office_embedded"
  /** text file that is really markup (html / svg / script) */
  | "markup"

export class MediaTypeError extends Error {
  readonly reason: MediaTypeErrorReason
  constructor(reason: MediaTypeErrorReason) {
    super(`media type ${reason}`)
    this.name = "MediaTypeError"
    this.reason = reason
  }
}

export function isMediaTypeError(e: unknown): e is MediaTypeError {
  return e instanceof MediaTypeError
}

/** central-directory entries read from an Office (ZIP) file at most */
const ZIP_MAX_ENTRIES = 5_000

export const FILE_TYPES = {
  jpg: { ext: "jpg", mime: "image/jpeg", family: "image" },
  png: { ext: "png", mime: "image/png", family: "image" },
  webp: { ext: "webp", mime: "image/webp", family: "image" },
  gif: { ext: "gif", mime: "image/gif", family: "image" },
  mp4: { ext: "mp4", mime: "video/mp4", family: "video" },
  mov: { ext: "mov", mime: "video/quicktime", family: "video" },
  pdf: { ext: "pdf", mime: "application/pdf", family: "document" },
  docx: {
    ext: "docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    family: "document",
  },
  xlsx: {
    ext: "xlsx",
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    family: "document",
  },
  pptx: {
    ext: "pptx",
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    family: "document",
  },
  csv: { ext: "csv", mime: "text/csv", family: "text" },
  tsv: { ext: "tsv", mime: "text/tab-separated-values", family: "text" },
  txt: { ext: "txt", mime: "text/plain", family: "text" },
  md: { ext: "md", mime: "text/markdown", family: "text" },
  json: { ext: "json", mime: "application/json", family: "text" },
} as const satisfies Record<string, FileType>

const T = FILE_TYPES

export type TextExt = "csv" | "tsv" | "txt" | "md" | "json"
const TEXT_EXTS = new Set<string>(["csv", "tsv", "txt", "md", "json"])
const TEXT_MIMES: Record<string, TextExt> = {
  "text/csv": "csv",
  "text/tab-separated-values": "tsv",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/x-markdown": "md",
  "application/json": "json",
}

export function isTextExt(ext: string | null | undefined): ext is TextExt {
  return !!ext && TEXT_EXTS.has(ext)
}

/** ISO-BMFF brands of MP4 video (major or compatible) */
const MP4_BRANDS = new Set([
  "isom",
  "iso2",
  "iso3",
  "iso4",
  "iso5",
  "iso6",
  "mp41",
  "mp42",
  "avc1",
  "M4V ",
  "M4VH",
  "M4VP",
  "dash",
  "mmp4",
  "f4v ",
  "XAVC",
  "MSNV",
])
/** ISO-BMFF files that are NOT videos we accept (HEIF/AVIF images, audio, raw photos, JPEG 2000) */
const NON_VIDEO_BRANDS = new Set([
  "heic",
  "heix",
  "hevc",
  "hevx",
  "heim",
  "heis",
  "mif1",
  "msf1",
  "avif",
  "avis",
  "M4A ",
  "M4B ",
  "M4P ",
  "crx ",
  "jp2 ",
])

/** lower-case extension of a file name ("a.JPG" → "jpg"), null when none */
export function extOf(name: string | null | undefined): string | null {
  const m1 = /\.([A-Za-z0-9]{1,10})$/.exec(String(name ?? "").trim())
  return m1 ? m1[1]!.toLowerCase() : null
}

function sniffIsoBmff(b: Buffer): FileType | null {
  if (b.length < 12 || b.toString("latin1", 4, 8) !== "ftyp") return null
  const major = b.toString("latin1", 8, 12)
  if (major === "qt  ") return T.mov
  if (NON_VIDEO_BRANDS.has(major)) return null
  const boxEnd = Math.min(b.readUInt32BE(0), b.length, 256)
  const compatible: string[] = []
  for (let p = 16; p + 4 <= boxEnd; p += 4)
    compatible.push(b.toString("latin1", p, p + 4))
  if (MP4_BRANDS.has(major) || compatible.some((c) => MP4_BRANDS.has(c)))
    return T.mp4
  if (compatible.includes("qt  ")) return T.mov
  return null
}

/** Entry names of a ZIP from its central directory (no decompression); null = not a readable / plain ZIP. */
export function zipEntryNames(b: Buffer): string[] | null {
  if (b.length < 22) return null
  // End Of Central Directory record: the last 22 bytes + a comment of up to 65535 bytes
  const lowest = Math.max(0, b.length - 22 - 0xffff)
  for (let i = b.length - 22; i >= lowest; i--) {
    if (b.readUInt32LE(i) !== 0x06054b50) continue
    const total = b.readUInt16LE(i + 10)
    const size = b.readUInt32LE(i + 12)
    const offset = b.readUInt32LE(i + 16)
    // ZIP64 / absurd counts: refused (an Office file ≤ 50 MB never needs them)
    if (total === 0xffff || offset === 0xffffffff || total > ZIP_MAX_ENTRIES)
      return null
    if (offset + size > i) return null
    const names: string[] = []
    let p = offset
    for (let n = 0; n < total; n++) {
      if (p + 46 > i || b.readUInt32LE(p) !== 0x02014b50) return null
      const nameLen = b.readUInt16LE(p + 28)
      const extraLen = b.readUInt16LE(p + 30)
      const commentLen = b.readUInt16LE(p + 32)
      const nameEnd = p + 46 + nameLen
      if (nameEnd > i) return null
      names.push(b.toString("utf8", p + 46, nameEnd))
      p = nameEnd + extraLen + commentLen
    }
    return names
  }
  return null
}

/** the main part that makes a ZIP a DOCX / XLSX / PPTX (with [Content_Types].xml) */
const OFFICE_MAIN_PARTS = [
  ["word/document.xml", T.docx],
  ["xl/workbook.xml", T.xlsx],
  ["ppt/presentation.xml", T.pptx],
] as const
/** executables / scripts that have no business inside an Office file */
const OFFICE_EXEC_EXT =
  /\.(exe|dll|com|scr|pif|cpl|msi|msp|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|jar|sh|lnk|reg|apk|so|dylib|ocx|sys|scf|url|iqy|slk|application|gadget)$/
/** printer settings (DEVMODE) saved by Excel / Word / PowerPoint: the one harmless, very common .bin part */
const OFFICE_PRINTER_SETTINGS =
  /^(word|xl|ppt)\/printersettings\/printersettings\d+\.bin$/

/** an entry (lower-case, "/") that is refused: absolute / "..", OLE embeddings, ActiveX, binaries, executables */
function unsafeOfficeEntry(n: string): boolean {
  if (n.startsWith("/") || /^[a-z]:/.test(n)) return true
  const segs = n.split("/")
  if (segs.includes("..")) return true
  if (segs.some((s) => s === "embeddings" || s === "activex")) return true
  if (n.endsWith(".bin") && !OFFICE_PRINTER_SETTINGS.test(n)) return true
  return OFFICE_EXEC_EXT.test(n)
}

/**
 * DOCX / XLSX / PPTX from the ZIP entry names: [Content_Types].xml + exactly one main part. Macro-enabled files
 * (vbaProject.bin) and files carrying OLE objects, ActiveX controls, other binaries or executables are refused.
 */
function sniffOffice(b: Buffer): FileType | null {
  const names = zipEntryNames(b)
  if (!names) return null
  const lower = names.map((n) => n.replace(/\\/g, "/").toLowerCase())
  if (!lower.includes("[content_types].xml")) return null
  const mains = OFFICE_MAIN_PARTS.filter(([part]) => lower.includes(part))
  if (mains.length !== 1) return null
  if (
    lower.some((n) => n.endsWith("vbaproject.bin") || n.endsWith("vbadata.xml"))
  )
    throw new MediaTypeError("macro")
  if (lower.some(unsafeOfficeEntry)) throw new MediaTypeError("office_embedded")
  return mains[0]![1]
}

function isUtf8Text(b: Buffer): boolean {
  if (b.includes(0)) return false
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(b)
    return true
  } catch {
    return false
  }
}

/** bytes of a text file inspected for markup */
const MARKUP_SCAN_BYTES = 1024

/**
 * Markup documents (scripts in a browser) are never sent, even named .txt: a leading comment / doctype / XML
 * declaration / html-like tag, or an svg / html / script / iframe tag anywhere in the first 1 KB (any case).
 */
function looksLikeMarkup(head: string): boolean {
  const s = head.replace(/^﻿/, "").slice(0, MARKUP_SCAN_BYTES).toLowerCase()
  const start = s.trimStart()
  if (/^<(!--|!doctype|\?xml)/.test(start)) return true
  if (/^<(html|svg|script|head|body|iframe)\b/.test(start)) return true
  return /<(svg|html|script|iframe)(?=[\s/>]|$)/.test(s)
}

function textTypeFromHint(hint: {
  name?: string | null
  mime?: string | null
}): TextExt | null {
  const ext = extOf(hint.name)
  // a name WITH an extension decides (x.html is never "text/plain")
  if (ext) return TEXT_EXTS.has(ext) ? (ext as TextExt) : null
  const mt = (hint.mime ?? "").split(";")[0]!.trim().toLowerCase()
  return TEXT_MIMES[mt] ?? null
}

/**
 * Image or video type from the first bytes only (JPEG/PNG/GIF/WebP, MP4/MOV), null for anything else - never
 * throws. Enough for a stream's first chunk (≥ 12 bytes; MP4 compatible brands are read up to 256 bytes).
 */
export function sniffMediaType(b: Buffer): FileType | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
    return T.jpg
  if (
    b.length >= 8 &&
    b
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return T.png
  if (b.length >= 6) {
    const sig = b.toString("latin1", 0, 6)
    if (sig === "GIF87a" || sig === "GIF89a") return T.gif
  }
  if (
    b.length >= 12 &&
    b.toString("latin1", 0, 4) === "RIFF" &&
    b.toString("latin1", 8, 12) === "WEBP"
  )
    return T.webp
  return sniffIsoBmff(b)
}

/**
 * Allowlisted type of a downloaded file from its bytes; text types (no magic bytes) need a csv/tsv/txt/md/json
 * hint (name or mime) AND valid UTF-8 without NUL. Throws MediaTypeError for anything else.
 */
export function detectFileType(
  b: Buffer,
  hint: { name?: string | null; mime?: string | null } = {}
): FileType {
  const media = sniffMediaType(b)
  if (media) return media
  if (b.length >= 5 && b.toString("latin1", 0, 5) === "%PDF-") return T.pdf
  if (b.length >= 4 && b.readUInt32LE(0) === 0x04034b50) {
    const office = sniffOffice(b)
    if (office) return office
    throw new MediaTypeError("not_allowed")
  }
  const text = textTypeFromHint(hint)
  if (text && isUtf8Text(b)) {
    if (
      looksLikeMarkup(
        b.toString("utf8", 0, Math.min(b.length, MARKUP_SCAN_BYTES))
      )
    )
      throw new MediaTypeError("markup")
    return T[text]
  }
  throw new MediaTypeError("not_allowed")
}
