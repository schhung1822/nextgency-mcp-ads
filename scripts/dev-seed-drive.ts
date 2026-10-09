// DEV ONLY — demo Google Drive data to review the "Kết nối → Google Drive" tab, /connections/drive/[id], Settings →
// "Google Drive hệ thống" and the MCP "Google Drive" block WITHOUT real Google credentials:
// a system credential (fake service account JSON with a locally generated RSA key + fake API key), a personal
// credential for the staff user, folders / sheets (company, personal, error, disabled, shared drive) and
// mcp_drive_scopes for two demo MCPs. Live Google calls (file grid, sheet preview, "Kiểm tra") fail - by design.
// Run AFTER scripts/dev-seed-logs.ts (+ dev-seed-flows.ts for the MCP scopes):
//   ALLOW_DEV_SEED=1 tsx --env-file=.env scripts/dev-seed-drive.ts [--clean]
// --clean removes only what this script created (sources "[drive] …", the fake credentials) and exits.
// Same safety guard as dev-seed-logs (localhost DB, non-production, @example.test users only).
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto"
import { and, eq, inArray, isNull, like, or } from "drizzle-orm"

import { assertDevSeedAllowed } from "@/server/db/dev-seed-guard"
import { db, pool } from "@/server/db/client"
import {
  driveCredentials,
  driveSources,
  mcpDriveScopes,
  mcpServers,
  user,
} from "@/server/db/schema"
import { DEFAULT_SHEET_COLUMNS } from "@/server/drive/types"
import {
  encryptDriveApiKey,
  encryptServiceAccount,
  encryptSourceResourceKey,
} from "@/server/drive/store"

const TAG = "[drive] "
/** fake service accounts live in this (non-existent) project - used by --clean */
const FAKE_DOMAIN = "@ads-mcp-dev-seed.iam.gserviceaccount.com"
const hour = 3_600_000

async function userId(email: string): Promise<string> {
  const r = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
  if (!r[0]) throw new Error(`Chạy dev-seed-logs.ts trước (thiếu ${email})`)
  return r[0].id
}

function fakeServiceAccount(name: string) {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  })
  return {
    clientEmail: `${name}${FAKE_DOMAIN}`,
    privateKey,
    privateKeyId: randomBytes(20).toString("hex"),
    projectId: "ads-mcp-dev-seed",
  }
}

/** Google API key shape: AIza + 35 chars (fake, never valid). */
function fakeApiKey(): string {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"
  let s = "AIza"
  for (const b of randomBytes(35)) s += abc[b % abc.length]
  return s
}

/** Drive-like id: 33 chars [A-Za-z0-9_-]. */
function fakeDriveId(): string {
  return ("1" + randomBytes(30).toString("base64url")).slice(0, 33)
}

async function clean() {
  const fakeCreds = await db
    .select({ id: driveCredentials.id })
    .from(driveCredentials)
    .where(like(driveCredentials.clientEmail, `%${FAKE_DOMAIN}`))
  const credIds = fakeCreds.map((c) => c.id)
  // sources first (FK restrict), scopes cascade
  await db
    .delete(driveSources)
    .where(
      credIds.length
        ? or(
            like(driveSources.name, `${TAG}%`),
            inArray(driveSources.credentialId, credIds)
          )
        : like(driveSources.name, `${TAG}%`)
    )
  if (credIds.length)
    await db
      .delete(driveCredentials)
      .where(inArray(driveCredentials.id, credIds))
  console.log(`[drive] đã xoá dữ liệu demo (${credIds.length} credential).`)
}

async function main() {
  await assertDevSeedAllowed()
  const adminId = await userId("dev-logs-admin@example.test")
  const staffId = await userId("dev-logs-staff@example.test")
  await clean()
  if (process.argv.includes("--clean")) return

  // ---- system credential (one live row; reuse a real-looking existing one if someone else created it) ----
  const [existing] = await db
    .select({ id: driveCredentials.id })
    .from(driveCredentials)
    .where(
      and(
        eq(driveCredentials.kind, "system"),
        isNull(driveCredentials.deletedAt)
      )
    )
  let systemId: string
  if (existing) {
    systemId = existing.id
    console.log("[drive] dùng lại credential hệ thống đang có.")
  } else {
    systemId = randomUUID()
    const sa = fakeServiceAccount("ads-mcp-drive")
    const apiKey = fakeApiKey()
    await db.insert(driveCredentials).values({
      id: systemId,
      kind: "system",
      ownerId: null,
      name: "",
      credentialsEncrypted: encryptServiceAccount(systemId, sa),
      apiKeyEncrypted: encryptDriveApiKey(systemId, apiKey),
      apiKeyHint: apiKey.slice(-4),
      clientEmail: sa.clientEmail,
      credentialHint: sa.privateKeyId.slice(-4),
      status: "active",
      lastCheckedAt: new Date(Date.now() - 2 * hour),
    })
  }

  // ---- personal credential of the staff user ----
  const personalId = randomUUID()
  const psa = fakeServiceAccount("lan-drive-rieng")
  await db.insert(driveCredentials).values({
    id: personalId,
    kind: "personal",
    ownerId: staffId,
    name: "Drive cá nhân của Lan",
    credentialsEncrypted: encryptServiceAccount(personalId, psa),
    clientEmail: psa.clientEmail,
    credentialHint: psa.privateKeyId.slice(-4),
    status: "active",
    lastCheckedAt: new Date(Date.now() - 26 * hour),
  })

  const sheetConfig = (writeback: boolean) => ({
    headerRow: 1,
    columns: { ...DEFAULT_SHEET_COLUMNS },
    writeback,
  })

  type Src = {
    key: string
    kind: "folder" | "sheet"
    scope: "company" | "personal"
    owner: string
    credential: string
    name: string
    googleName: string
    status?: "active" | "error" | "disabled"
    statusMessage?: string
    sharedDrive?: boolean
    resourceKey?: string
    depth?: number
    writeback?: boolean
    checkedHoursAgo?: number
  }
  const specs: Src[] = [
    {
      key: "company-folder",
      kind: "folder",
      scope: "company",
      owner: adminId,
      credential: systemId,
      name: "Creative công ty — Tuần 41",
      googleName: "Creative Tuần 41",
      depth: 2,
      checkedHoursAgo: 3,
    },
    {
      key: "company-sheet",
      kind: "sheet",
      scope: "company",
      owner: adminId,
      credential: systemId,
      name: "Kế hoạch creative tháng 10",
      googleName: "Kế hoạch creative Q4 - Tháng 10",
      writeback: true,
      checkedHoursAgo: 1,
    },
    {
      key: "company-shared-drive",
      kind: "folder",
      scope: "company",
      owner: adminId,
      credential: systemId,
      name: "Thư viện video TikTok (Shared drive)",
      googleName: "Video TikTok 2026",
      sharedDrive: true,
      depth: 1,
      checkedHoursAgo: 6,
    },
    {
      key: "company-error",
      kind: "folder",
      scope: "company",
      owner: adminId,
      credential: systemId,
      name: "Ảnh sản phẩm — Black Friday",
      googleName: "BF 2026 - Ảnh SP",
      status: "error",
      statusMessage:
        "Email hệ thống chưa có quyền truy cập file / thư mục này. Mở Google Drive → Chia sẻ → thêm email hệ thống (quyền Người xem).",
      checkedHoursAgo: 5,
    },
    {
      key: "staff-folder",
      kind: "folder",
      scope: "personal",
      owner: staffId,
      credential: systemId,
      name: "Lan — Video review khách hàng",
      googleName: "Review KH",
      depth: 0,
      resourceKey: "0-AbCdEfGhIjKlMnOp",
      checkedHoursAgo: 12,
    },
    {
      key: "staff-sheet-own-sa",
      kind: "sheet",
      scope: "personal",
      owner: staffId,
      credential: personalId,
      name: "Lan — Lịch lên bài TikTok",
      googleName: "Lịch TikTok - Sheet1",
      writeback: false,
      checkedHoursAgo: 30,
    },
    {
      key: "admin-personal",
      kind: "folder",
      scope: "personal",
      owner: adminId,
      credential: systemId,
      name: "Thắng — Thử nghiệm creative AI",
      googleName: "AI creative test",
      status: "disabled",
      statusMessage: "Đã tắt sau khi thư mục bị xoá khỏi Google Drive.",
      checkedHoursAgo: 72,
    },
  ]

  const ids: Record<string, string> = {}
  for (const s of specs) {
    const id = randomUUID()
    ids[s.key] = id
    await db.insert(driveSources).values({
      id,
      kind: s.kind,
      scope: s.scope,
      ownerId: s.owner,
      credentialId: s.credential,
      googleId: fakeDriveId(),
      sheetGid: s.kind === "sheet" ? 0 : null,
      resourceKeyEncrypted: encryptSourceResourceKey(id, s.resourceKey ?? null),
      name: TAG + s.name,
      googleName: s.googleName,
      sharedDriveId: s.sharedDrive ? "0AFakeSharedDriveIdUk9PVA" : null,
      config:
        s.kind === "folder"
          ? { recursiveDepth: s.depth ?? 0 }
          : sheetConfig(!!s.writeback),
      status: s.status ?? "active",
      statusMessage: s.statusMessage ?? null,
      lastCheckedAt: new Date(Date.now() - (s.checkedHoursAgo ?? 1) * hour),
    })
  }

  // ---- MCP scopes (MCPs from dev-seed-flows.ts, when present) ----
  const mcps = await db
    .select({
      id: mcpServers.id,
      name: mcpServers.name,
      ownerId: mcpServers.ownerId,
    })
    .from(mcpServers)
    .where(
      inArray(mcpServers.name, [
        "[flows] Báo cáo hằng ngày",
        "[flows] Lan · Meta vận hành",
      ])
    )
  for (const mcp of mcps) {
    const keys =
      mcp.ownerId === adminId
        ? ["company-folder", "company-sheet", "staff-folder"]
        : [
            "company-folder",
            "company-sheet",
            "staff-folder",
            "staff-sheet-own-sa",
          ]
    await db
      .insert(mcpDriveScopes)
      .values(keys.map((k) => ({ mcpId: mcp.id, sourceId: ids[k]! })))
      .onConflictDoNothing()
  }

  console.log(
    `[drive] đã tạo ${specs.length} thư mục / sheet, 1 service account riêng, gán cho ${mcps.length} MCP.`
  )
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exitCode = 1
  })
  .finally(() => pool().end())
