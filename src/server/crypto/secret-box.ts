// AES-256-GCM encryption for secrets at rest (platform credentials, MCP keys).
// Key ring from env ENCRYPTION_KEYS="2:<b64 32B>,1:<b64 32B>" - first entry is active, others decrypt-only.
// Payload format: v<ver>.<iv b64url>.<tag b64url>.<ciphertext b64url>. AAD binds ciphertext to row+field.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

const IV_BYTES = 12
/** GCM tag length is pinned: Node otherwise accepts truncated tags (down to 4 bytes) on decrypt. */
const TAG_BYTES = 16

type Ring = { active: number; keys: Map<number, Buffer> }
let ring: Ring | undefined

export function parseKeyRing(spec: string | undefined): Ring {
  const keys = new Map<number, Buffer>()
  let active: number | undefined
  for (const part of (spec ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const i = part.indexOf(":")
    if (i < 1) throw new Error("ENCRYPTION_KEYS: mỗi phần tử phải có dạng <phiên_bản>:<khoá_base64>")
    const ver = Number(part.slice(0, i))
    const key = Buffer.from(part.slice(i + 1), "base64")
    if (!Number.isInteger(ver) || ver < 1) throw new Error(`ENCRYPTION_KEYS: phiên bản không hợp lệ "${part.slice(0, i)}"`)
    if (key.length !== 32) throw new Error(`ENCRYPTION_KEYS: khoá v${ver} phải dài đúng 32 byte (base64)`)
    if (keys.has(ver)) throw new Error(`ENCRYPTION_KEYS: trùng phiên bản v${ver}`)
    keys.set(ver, key)
    active ??= ver
  }
  if (active === undefined) throw new Error("ENCRYPTION_KEYS chưa được cấu hình")
  return { active, keys }
}

function loadRing(): Ring {
  ring ??= parseKeyRing(process.env.ENCRYPTION_KEYS)
  return ring
}

/** Startup check (web + worker): throws a Vietnamese message (never key material) when ENCRYPTION_KEYS is unusable. */
export function assertKeyRing(): void {
  loadRing()
}

/** test helper */
export function __setKeyRing(spec: string | undefined) {
  ring = spec === undefined ? undefined : parseKeyRing(spec)
}

export function encryptSecret(plain: string, aad: string): string {
  const { active, keys } = loadRing()
  const iv = randomBytes(IV_BYTES)
  const c = createCipheriv("aes-256-gcm", keys.get(active)!, iv, { authTagLength: TAG_BYTES })
  c.setAAD(Buffer.from(aad, "utf8"))
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()])
  return [`v${active}`, iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".")
}

export function decryptSecret(payload: string, aad: string): string {
  const parts = payload.split(".")
  if (parts.length !== 4 || !parts[0]!.startsWith("v")) throw new Error("Dữ liệu mã hoá không đúng định dạng")
  const [v, iv, tag, ct] = parts as [string, string, string, string]
  const key = loadRing().keys.get(Number(v.slice(1)))
  if (!key) throw new Error(`Không có khoá giải mã phiên bản ${v}`)
  const ivBuf = Buffer.from(iv, "base64url")
  const tagBuf = Buffer.from(tag, "base64url")
  if (ivBuf.length !== IV_BYTES || tagBuf.length !== TAG_BYTES) throw new Error("Dữ liệu mã hoá không đúng định dạng")
  const d = createDecipheriv("aes-256-gcm", key, ivBuf, { authTagLength: TAG_BYTES })
  d.setAAD(Buffer.from(aad, "utf8"))
  d.setAuthTag(tagBuf)
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8")
}

export function encryptJson(value: unknown, aad: string): string {
  return encryptSecret(JSON.stringify(value), aad)
}

export function decryptJson<T = unknown>(payload: string, aad: string): T {
  return JSON.parse(decryptSecret(payload, aad)) as T
}

export function needsReencrypt(payload: string): boolean {
  return !payload.startsWith(`v${loadRing().active}.`)
}

export function lastChars(s: string, n = 4): string {
  return s.length <= n ? "•".repeat(s.length) : s.slice(-n)
}

export const aad = {
  connectionCredentials: (connectionId: string) => `connection:${connectionId}:credentials`,
  mcpKey: (mcpId: string) => `mcp:${mcpId}:key`,
  notificationChannelCredentials: (channelId: string) => `notification_channel:${channelId}:credentials`,
  // Google Drive (15-google-drive-media.md §10): service account JSON, API key (system only), resource keys
  driveCredential: (credentialId: string) => `drive_credential:${credentialId}:credentials`,
  driveCredentialApiKey: (credentialId: string) => `drive_credential:${credentialId}:api_key`,
  driveSourceResourceKey: (sourceId: string) => `drive_source:${sourceId}:resource_key`,
  driveRelayResourceKey: (relayLinkId: string) => `drive_relay_link:${relayLinkId}:resource_key`,
  // background video uploads (media_upload_jobs) + opaque drf_ refs to public Drive files handed to the AI
  mediaUploadJobResourceKey: (jobId: string) => `media_upload_job:${jobId}:resource_key`,
  driveFileRef: (mcpId: string) => `drive_ref:${mcpId}`,
}
