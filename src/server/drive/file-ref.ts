// Opaque, MCP-bound reference to a public Drive file that needs a resource key (security review L1): the AI gets
// `drf_<…>` instead of a link carrying `resourcekey=`. AES-256-GCM via secret-box, AAD `drive_ref:<mcpId>`, expires.
// The resource key only exists encrypted inside the ref; a ref copied to another MCP does not decrypt there.
// No imports from "next/*".
import { aad, decryptSecret, encryptSecret } from "../crypto/secret-box"

import { isDriveId } from "./links"

export const DRIVE_FILE_REF_PREFIX = "drf_"
/** lifetime of a ref handed to the AI */
export const DRIVE_FILE_REF_TTL_MS = 24 * 60 * 60_000
/** a ref is ~200-300 chars; anything much longer is not ours (bounded work before decrypting) */
const MAX_REF_LENGTH = 1024
const REF_BODY_RE = /^[A-Za-z0-9_-]+$/
/** Drive resource keys are short ("0-abc…"); bounded so a ref stays small */
const MAX_RESOURCE_KEY_LENGTH = 200

export interface DriveFileRefPayload {
  fileId: string
  resourceKey: string | null
}

interface Sealed {
  /** file id */
  f: string
  /** resource key */
  k: string | null
  /** expiry, epoch ms */
  x: number
}

/** `drf_` + base64url(secret-box payload {f, k, x(exp ms)}) bound to mcpId. */
export function encodeDriveFileRef(
  mcpId: string,
  p: DriveFileRefPayload,
  now: number = Date.now()
): string {
  if (!mcpId) throw new Error("drive file ref: mcpId required")
  if (!isDriveId(p.fileId)) throw new Error("drive file ref: invalid file id")
  if (
    p.resourceKey !== null &&
    (typeof p.resourceKey !== "string" ||
      !p.resourceKey ||
      p.resourceKey.length > MAX_RESOURCE_KEY_LENGTH)
  )
    throw new Error("drive file ref: invalid resource key")
  const sealed: Sealed = {
    f: p.fileId,
    k: p.resourceKey,
    x: now + DRIVE_FILE_REF_TTL_MS,
  }
  const enc = encryptSecret(JSON.stringify(sealed), aad.driveFileRef(mcpId))
  return DRIVE_FILE_REF_PREFIX + Buffer.from(enc, "utf8").toString("base64url")
}

/** null when malformed, for another MCP, tampered or expired. */
export function decodeDriveFileRef(
  mcpId: string,
  ref: string,
  now: number = Date.now()
): DriveFileRefPayload | null {
  if (!mcpId || !isDriveFileRef(ref) || ref.length > MAX_REF_LENGTH) return null
  const body = ref.slice(DRIVE_FILE_REF_PREFIX.length)
  if (!REF_BODY_RE.test(body)) return null
  let v: Partial<Sealed> | null
  try {
    const enc = Buffer.from(body, "base64url").toString("utf8")
    v = JSON.parse(
      decryptSecret(enc, aad.driveFileRef(mcpId))
    ) as Partial<Sealed> | null
  } catch {
    // wrong MCP, tampered, unknown key version, not JSON
    return null
  }
  if (
    !v ||
    typeof v.f !== "string" ||
    !isDriveId(v.f) ||
    !(v.k === null || (typeof v.k === "string" && v.k.length > 0)) ||
    typeof v.x !== "number" ||
    !Number.isFinite(v.x) ||
    v.x <= now
  )
    return null
  return { fileId: v.f, resourceKey: v.k }
}

export function isDriveFileRef(s: string): boolean {
  return typeof s === "string" && s.startsWith(DRIVE_FILE_REF_PREFIX)
}
