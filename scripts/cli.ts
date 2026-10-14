#!/usr/bin/env node
// Ads MCP CLI — chạy trong container: `node dist/cli.mjs <lệnh>` · dev: `pnpm cli <lệnh>`.
// Bundled by esbuild (package.json build:scripts). Must NOT import `next/*` or "server-only" (directly or
// transitively): it talks to Postgres through Drizzle and writes activity_logs with the framework-free
// writer in src/server/auth/activity-core.ts.
//
//   create-admin --email <email> [--name <tên>] [--password-stdin]   (or ADMIN_PASSWORD env)
//   reset-password <email>            (alias: user:reset-password)
//   reset-2fa <email>                 (alias: user:reset-2fa)
//   unlock <email>                    gỡ khoá đăng nhập (sai mật khẩu nhiều lần + khoá 2FA)
//   unban <email>                     mở khoá tài khoản bị quản trị viên khoá (alias: user:unban)
//   reencrypt [--dry-run]             mã hoá lại credential/key MCP bằng khoá ENCRYPTION_KEYS đang dùng
//   google:refresh-token --client-id <id> [--client-secret-stdin] [--port 8085] [--host 127.0.0.1]
//                                     (secret: GOOGLE_ADS_CLIENT_SECRET env, stdin, or a hidden prompt)
// Secrets passed as argv (--password / --client-secret) still work but print a warning: argv is visible
// in `ps`, shell history and container inspect output.
import { createHash, randomBytes, randomUUID } from "node:crypto"
import http from "node:http"
import { isIP } from "node:net"
import { createInterface } from "node:readline"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"
import { hashPassword } from "better-auth/crypto"
import { and, count, eq, isNotNull, like } from "drizzle-orm"

import { generateTempPassword } from "@/lib/schemas/users"
import { safeErrorForLog } from "@/server/audit/safe-error"
import { CLI_ACTOR, insertActivity } from "@/server/auth/activity-core"
import { clearLoginFailures } from "@/server/auth/lockout"
import { aad, decryptSecret, encryptSecret, needsReencrypt } from "@/server/crypto/secret-box"
import { db, pool } from "@/server/db/client"
import {
  account,
  apifyTokens,
  connections,
  driveCredentials,
  driveRelayLinks,
  driveSources,
  mcpServers,
  mediaUploadJobs,
  notificationChannels,
  session,
  twoFactor,
  user,
  verification,
} from "@/server/db/schema"

const PASSWORD_MIN = 8
const PASSWORD_MAX = 128

class CliError extends Error {}

function out(msg = "") {
  process.stdout.write(`${msg}\n`)
}

const HELP = `Ads MCP CLI

Cách dùng: node dist/cli.mjs <lệnh> [tham số]   (dev: pnpm cli <lệnh>)

  create-admin --email <email> [--name <tên>] [--password-stdin]
      Tạo quản trị viên (dùng thay /setup hoặc khi mất quyền truy cập). Mật khẩu tạm: biến môi trường
      ADMIN_PASSWORD, hoặc --password-stdin (đọc 1 dòng từ stdin); không có thì tạo ngẫu nhiên.
      Người dùng phải đổi mật khẩu khi đăng nhập (2FA tuỳ chọn, trừ khi Cài đặt bắt buộc). (--password <…> vẫn chạy nhưng bị cảnh báo:
      tham số dòng lệnh lộ trong ps/lịch sử shell.)
  reset-password <email>
      Đặt mật khẩu tạm mới, đăng xuất mọi thiết bị, buộc đổi mật khẩu ở lần đăng nhập tới.
  reset-2fa <email>
      Xoá xác thực 2 bước (ứng dụng + mã dự phòng + thiết bị tin cậy), đăng xuất mọi thiết bị.
  unlock <email>
      Gỡ khoá đăng nhập của email (khoá do nhập sai mật khẩu — theo email và theo IP — và khoá 2FA do nhập
      sai mã nhiều lần). Không đổi mật khẩu, không đăng xuất thiết bị.
  unban <email>
      Mở khoá tài khoản đã bị quản trị viên khoá (Người dùng → Khoá tài khoản). Không đổi mật khẩu, không đổi 2FA.
      Khác với "unlock" (gỡ khoá do nhập sai mật khẩu nhiều lần).
  reencrypt [--dry-run]
      Mã hoá lại credential kết nối, key MCP, bot token Telegram và bí mật Google Drive (service account, API key,
      resource key) chưa dùng khoá ENCRYPTION_KEYS đang hoạt động.
  google:refresh-token --client-id <id> [--client-secret-stdin] [--port 8085] [--host 127.0.0.1]
      Lấy refresh token Google Ads (gồm quảng cáo YouTube) bằng OAuth client loại Desktop, redirect
      http://127.0.0.1:<port>. Không cần developer token (Google bỏ yêu cầu từ 09/09/2026).
      Client secret: biến môi trường GOOGLE_ADS_CLIENT_SECRET, --client-secret-stdin, hoặc nhập ẩn khi được hỏi.
      Trước khi chạy: OAuth consent screen để "In production" và hoàn tất Verify Branding - nếu để "Testing",
      refresh token hết hạn sau 7 ngày. Tài khoản Google bị Google Ads bắt buộc passkey phải đăng nhập bằng
      passkey (không nhận TOTP/SMS; passkey mới có thể cần tới 7 ngày mới được chấp nhận).
      Cách khuyên dùng thay cho lệnh này: service account (thêm email service account làm người dùng ở tài khoản
      quản lý MCC, dán file JSON vào form kết nối) - không cần refresh token.
      Máy chủ chờ mã chỉ nghe 127.0.0.1 (mặc định). Trong Docker cần --host 0.0.0.0 VÀ chỉ publish cổng
      ra loopback của VPS, rồi mở SSH tunnel từ máy bạn:
        ssh -L 8085:127.0.0.1:8085 user@vps
        docker compose run --rm -p 127.0.0.1:8085:8085 -e GOOGLE_ADS_CLIENT_SECRET web \\
          node dist/cli.mjs google:refresh-token --client-id <id> --host 0.0.0.0
`

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

/** Same shape as Better Auth's generateId(): 32 chars [a-zA-Z0-9]. */
export function generateId(size = 32): string {
  const outChars: string[] = []
  const max = 256 - (256 % ID_ALPHABET.length)
  while (outChars.length < size) {
    for (const b of randomBytes(size * 2)) {
      if (b < max && outChars.length < size) outChars.push(ID_ALPHABET[b % ID_ALPHABET.length]!)
    }
  }
  return outChars.join("")
}

function normEmail(e: string | undefined): string {
  const email = (e ?? "").trim().toLowerCase()
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new CliError(`Email không hợp lệ: "${e ?? ""}"`)
  }
  return email
}

function checkPassword(p: string) {
  if (p.length < PASSWORD_MIN) throw new CliError(`Mật khẩu cần ít nhất ${PASSWORD_MIN} ký tự.`)
  if (p.length > PASSWORD_MAX) throw new CliError(`Mật khẩu tối đa ${PASSWORD_MAX} ký tự.`)
}

function warnArgvSecret(flag: string, alternative: string) {
  process.stderr.write(
    `⚠ ${flag} trên dòng lệnh có thể lộ qua ps, lịch sử shell, docker inspect. Lần sau dùng ${alternative}.\n`
  )
}

/** First line of stdin (piped), or a hidden prompt when stdin is a terminal. */
export async function readSecretFromStdin(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = []
    for await (const c of process.stdin) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)))
    return Buffer.concat(chunks).toString("utf8").split(/\r?\n/)[0]!.trim()
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WritableStream }
  let muted = false
  out._writeToOutput = (s: string) => {
    if (!muted) out.output.write(s)
  }
  return new Promise<string>((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close()
      process.stdout.write("\n")
      resolve(answer.trim())
    })
    muted = true
  })
}

/**
 * Secret resolution order: argv (deprecated, warns) → environment variable → stdin/prompt (when
 * `fromStdin` or `promptIfMissing`). Returns undefined when none is available.
 */
export async function resolveSecret(opts: {
  argv: string | undefined
  argvFlag: string
  env: string
  fromStdin: boolean
  promptIfMissing: boolean
  prompt: string
}): Promise<string | undefined> {
  if (opts.argv !== undefined) {
    warnArgvSecret(opts.argvFlag, `biến môi trường ${opts.env} hoặc stdin`)
    return opts.argv
  }
  const fromEnv = process.env[opts.env]
  if (fromEnv && fromEnv.trim() !== "") return fromEnv
  if (opts.fromStdin || (opts.promptIfMissing && process.stdin.isTTY)) {
    const v = await readSecretFromStdin(opts.prompt)
    return v === "" ? undefined : v
  }
  return undefined
}

async function findUserByEmail(email: string) {
  const [u] = await db.select().from(user).where(eq(user.email, email)).limit(1)
  if (!u) throw new CliError(`Không tìm thấy người dùng có email ${email}.`)
  return u
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

async function createAdmin(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      email: { type: "string" },
      name: { type: "string" },
      password: { type: "string" },
      "password-stdin": { type: "boolean" },
    },
    strict: true,
  })
  const email = normEmail(values.email)
  const name = (values.name ?? email.split("@")[0] ?? "Admin").trim().slice(0, 100) || "Admin"
  const given = await resolveSecret({
    argv: values.password,
    argvFlag: "--password",
    env: "ADMIN_PASSWORD",
    fromStdin: !!values["password-stdin"],
    promptIfMissing: false,
    prompt: "Mật khẩu tạm: ",
  })
  const generated = !given
  const password = given ?? generateTempPassword()
  checkPassword(password)
  const hash = await hashPassword(password)
  const id = generateId()
  const isFirst = await db.transaction(async (tx) => {
    const [exists] = await tx.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1)
    if (exists) throw new CliError(`Email ${email} đã có tài khoản. Dùng "reset-password ${email}" nếu quên mật khẩu.`)
    const [{ n }] = (await tx.select({ n: count() }).from(user)) as [{ n: number }]
    const now = new Date()
    await tx.insert(user).values({
      id,
      name,
      email,
      emailVerified: true,
      role: "admin",
      banned: false,
      twoFactorEnabled: false,
      mustChangePassword: true,
      createdAt: now,
      updatedAt: now,
    })
    await tx.insert(account).values({
      id: generateId(),
      accountId: id,
      providerId: "credential",
      userId: id,
      password: hash,
      createdAt: now,
      updatedAt: now,
    })
    const first = Number(n) === 0
    await insertActivity(
      {
        actor: CLI_ACTOR,
        action: first ? "setup.first_admin" : "user.create",
        target: { type: "user", id, label: email },
        metadata: { via: "cli", name, email, role: "admin", forcedChangeOnLogin: true },
      },
      tx
    )
    return first
  })
  out(`✔ Đã tạo quản trị viên ${email}${isFirst ? " (người dùng đầu tiên)" : ""}.`)
  if (generated) out(`  Mật khẩu tạm: ${password}`)
  out("  Khi đăng nhập, người dùng phải đổi mật khẩu. Xác thực 2 bước là tuỳ chọn (bật trong trang Tài khoản).")
}

async function resetPassword(args: string[]) {
  const email = normEmail(args[0])
  const u = await findUserByEmail(email)
  const password = generateTempPassword()
  const hash = await hashPassword(password)
  await db.transaction(async (tx) => {
    const now = new Date()
    const updated = await tx
      .update(account)
      .set({ password: hash, updatedAt: now })
      .where(and(eq(account.userId, u.id), eq(account.providerId, "credential")))
      .returning({ id: account.id })
    if (updated.length === 0) {
      await tx.insert(account).values({
        id: generateId(),
        accountId: u.id,
        providerId: "credential",
        userId: u.id,
        password: hash,
        createdAt: now,
        updatedAt: now,
      })
    }
    await tx.update(user).set({ mustChangePassword: true }).where(eq(user.id, u.id))
    await tx.delete(session).where(eq(session.userId, u.id))
    // "trust this device" cookies must not skip 2FA after a password reset
    await tx
      .delete(verification)
      .where(and(like(verification.identifier, "trust-device-%"), eq(verification.value, u.id)))
    await insertActivity(
      {
        actor: CLI_ACTOR,
        action: "user.password.reset",
        target: { type: "user", id: u.id, label: email },
        metadata: { via: "cli", forcedChangeOnLogin: true, sessionsRevoked: true, trustedDevicesRevoked: true },
      },
      tx
    )
  })
  out(`✔ Đã đặt lại mật khẩu cho ${email} và đăng xuất mọi thiết bị.`)
  out(`  Mật khẩu tạm: ${password}`)
  out("  Người dùng phải đổi mật khẩu ở lần đăng nhập tới.")
}

async function resetTwoFactor(args: string[]) {
  const email = normEmail(args[0])
  const u = await findUserByEmail(email)
  await db.transaction(async (tx) => {
    await tx.delete(twoFactor).where(eq(twoFactor.userId, u.id))
    await tx.update(user).set({ twoFactorEnabled: false }).where(eq(user.id, u.id))
    await tx
      .delete(verification)
      .where(and(like(verification.identifier, "trust-device-%"), eq(verification.value, u.id)))
    await tx.delete(session).where(eq(session.userId, u.id))
    await insertActivity(
      {
        actor: CLI_ACTOR,
        action: "user.2fa.reset",
        target: { type: "user", id: u.id, label: email },
        metadata: { via: "cli", before: { twoFactorEnabled: !!u.twoFactorEnabled }, after: { twoFactorEnabled: false } },
      },
      tx
    )
  })
  out(`✔ Đã đặt lại xác thực 2 bước cho ${email} và đăng xuất mọi thiết bị.`)
  if (u.role === "admin") out("  Có thể bật lại 2FA trong trang Tài khoản (bắt buộc nếu Cài đặt yêu cầu).")
}

async function unlock(args: string[]) {
  const email = normEmail(args[0])
  const [u] = await db.select().from(user).where(eq(user.email, email)).limit(1)
  const cleared = await clearLoginFailures(email)
  let twoFactorReset = 0
  if (u) {
    const rows = await db
      .update(twoFactor)
      .set({ failedVerificationCount: 0, lockedUntil: null })
      .where(eq(twoFactor.userId, u.id))
      .returning({ id: twoFactor.id })
    twoFactorReset = rows.length
    await insertActivity({
      actor: CLI_ACTOR,
      action: "user.update",
      target: { type: "user", id: u.id, label: email },
      metadata: { via: "cli", op: "unlock", lockoutCountersCleared: cleared, twoFactorLockReset: twoFactorReset > 0 },
    })
  }
  out(`✔ Đã gỡ khoá đăng nhập cho ${email} (${cleared} bộ đếm sai mật khẩu${u ? "" : "; không có tài khoản nào dùng email này"}).`)
}

async function unban(args: string[]) {
  const email = normEmail(args[0])
  const u = await findUserByEmail(email)
  if (!u.banned) {
    out(`Tài khoản ${email} không bị khoá - không cần mở khoá.`)
    return
  }
  await db.transaction(async (tx) => {
    await tx
      .update(user)
      .set({ banned: false, banReason: null, banExpires: null, updatedAt: new Date() })
      .where(eq(user.id, u.id))
    await insertActivity(
      {
        actor: CLI_ACTOR,
        action: "user.unban",
        target: { type: "user", id: u.id, label: email },
        metadata: { via: "cli", before: { banned: true }, after: { banned: false } },
      },
      tx
    )
  })
  out(`✔ Đã mở khoá tài khoản ${email}. Người dùng đăng nhập lại bằng mật khẩu hiện tại.`)
}

type ReencryptFailure = {
  kind:
    | "connection"
    | "mcp"
    | "notification_channel"
    | "drive_credential"
    | "drive_api_key"
    | "drive_source"
    | "drive_relay_link"
    | "media_upload_job"
    | "apify_token"
  id: string
  reason: string
}

/**
 * Re-encrypt every row of one table that is not under the active key. Row by row: a row that cannot be decrypted
 * (its key version is no longer in ENCRYPTION_KEYS, or the ciphertext is damaged) is reported and skipped instead of
 * aborting the whole run. Compare-and-swap update: a row changed meanwhile (e.g. token replaced) is left alone.
 */
async function reencryptRows(
  kind: ReencryptFailure["kind"],
  rows: { id: string; enc: string }[],
  aadOf: (id: string) => string,
  save: (id: string, prev: string, next: string) => Promise<boolean>,
  dry: boolean,
  failures: ReencryptFailure[]
): Promise<{ count: number; raced: number; failed: number }> {
  let count = 0
  let raced = 0
  let failed = 0
  for (const r of rows) {
    if (!needsReencrypt(r.enc)) continue
    try {
      const plain = decryptSecret(r.enc, aadOf(r.id))
      if (dry) {
        count++
        continue
      }
      if (await save(r.id, r.enc, encryptSecret(plain, aadOf(r.id)))) count++
      else raced++
    } catch (e) {
      failed++
      failures.push({ kind, id: r.id, reason: safeErrorForLog(e) })
    }
  }
  return { count, raced, failed }
}

async function reencrypt(args: string[]) {
  const { values } = parseArgs({ args, options: { "dry-run": { type: "boolean" } }, strict: true })
  const dry = !!values["dry-run"]
  const failures: ReencryptFailure[] = []
  const connRows = await db
    .select({ id: connections.id, enc: connections.credentialsEncrypted })
    .from(connections)
  const conn = await reencryptRows(
    "connection",
    connRows,
    aad.connectionCredentials,
    async (id, prev, next) =>
      (
        await db
          .update(connections)
          .set({ credentialsEncrypted: next })
          .where(and(eq(connections.id, id), eq(connections.credentialsEncrypted, prev)))
          .returning({ id: connections.id })
      ).length === 1,
    dry,
    failures
  )
  const mcpRows = await db.select({ id: mcpServers.id, enc: mcpServers.keyEncrypted }).from(mcpServers)
  const mcp = await reencryptRows(
    "mcp",
    mcpRows,
    aad.mcpKey,
    async (id, prev, next) =>
      (
        await db
          .update(mcpServers)
          .set({ keyEncrypted: next })
          .where(and(eq(mcpServers.id, id), eq(mcpServers.keyEncrypted, prev)))
          .returning({ id: mcpServers.id })
      ).length === 1,
    dry,
    failures
  )
  // Telegram bot tokens of notification channels (AAD notification_channel:<id>:credentials)
  const channelRows = await db
    .select({ id: notificationChannels.id, enc: notificationChannels.credentialsEncrypted })
    .from(notificationChannels)
  const channels = await reencryptRows(
    "notification_channel",
    channelRows,
    aad.notificationChannelCredentials,
    async (id, prev, next) =>
      (
        await db
          .update(notificationChannels)
          .set({ credentialsEncrypted: next })
          .where(and(eq(notificationChannels.id, id), eq(notificationChannels.credentialsEncrypted, prev)))
          .returning({ id: notificationChannels.id })
      ).length === 1,
    dry,
    failures
  )
  // Google Drive: service account JSON + API key (drive_credentials), resource keys (drive_sources, drive_relay_links)
  const driveCredRows = await db
    .select({ id: driveCredentials.id, enc: driveCredentials.credentialsEncrypted })
    .from(driveCredentials)
  const driveCreds = await reencryptRows(
    "drive_credential",
    driveCredRows,
    aad.driveCredential,
    async (id, prev, next) =>
      (
        await db
          .update(driveCredentials)
          .set({ credentialsEncrypted: next })
          .where(and(eq(driveCredentials.id, id), eq(driveCredentials.credentialsEncrypted, prev)))
          .returning({ id: driveCredentials.id })
      ).length === 1,
    dry,
    failures
  )
  const driveKeyRows = await db
    .select({ id: driveCredentials.id, enc: driveCredentials.apiKeyEncrypted })
    .from(driveCredentials)
    .where(isNotNull(driveCredentials.apiKeyEncrypted))
  const driveKeys = await reencryptRows(
    "drive_api_key",
    driveKeyRows.map((r) => ({ id: r.id, enc: r.enc! })),
    aad.driveCredentialApiKey,
    async (id, prev, next) =>
      (
        await db
          .update(driveCredentials)
          .set({ apiKeyEncrypted: next })
          .where(and(eq(driveCredentials.id, id), eq(driveCredentials.apiKeyEncrypted, prev)))
          .returning({ id: driveCredentials.id })
      ).length === 1,
    dry,
    failures
  )
  const driveSourceRows = await db
    .select({ id: driveSources.id, enc: driveSources.resourceKeyEncrypted })
    .from(driveSources)
    .where(isNotNull(driveSources.resourceKeyEncrypted))
  const driveSrc = await reencryptRows(
    "drive_source",
    driveSourceRows.map((r) => ({ id: r.id, enc: r.enc! })),
    aad.driveSourceResourceKey,
    async (id, prev, next) =>
      (
        await db
          .update(driveSources)
          .set({ resourceKeyEncrypted: next })
          .where(and(eq(driveSources.id, id), eq(driveSources.resourceKeyEncrypted, prev)))
          .returning({ id: driveSources.id })
      ).length === 1,
    dry,
    failures
  )
  const relayRows = await db
    .select({ id: driveRelayLinks.id, enc: driveRelayLinks.resourceKeyEncrypted })
    .from(driveRelayLinks)
    .where(isNotNull(driveRelayLinks.resourceKeyEncrypted))
  const relays = await reencryptRows(
    "drive_relay_link",
    relayRows.map((r) => ({ id: r.id, enc: r.enc! })),
    aad.driveRelayResourceKey,
    async (id, prev, next) =>
      (
        await db
          .update(driveRelayLinks)
          .set({ resourceKeyEncrypted: next })
          .where(and(eq(driveRelayLinks.id, id), eq(driveRelayLinks.resourceKeyEncrypted, prev)))
          .returning({ id: driveRelayLinks.id })
      ).length === 1,
    dry,
    failures
  )
  // background video uploads (media_upload_jobs.resource_key_encrypted, short-lived)
  const jobRows = await db
    .select({ id: mediaUploadJobs.id, enc: mediaUploadJobs.resourceKeyEncrypted })
    .from(mediaUploadJobs)
    .where(isNotNull(mediaUploadJobs.resourceKeyEncrypted))
  const jobs = await reencryptRows(
    "media_upload_job",
    jobRows.map((r) => ({ id: r.id, enc: r.enc! })),
    aad.mediaUploadJobResourceKey,
    async (id, prev, next) =>
      (
        await db
          .update(mediaUploadJobs)
          .set({ resourceKeyEncrypted: next })
          .where(and(eq(mediaUploadJobs.id, id), eq(mediaUploadJobs.resourceKeyEncrypted, prev)))
          .returning({ id: mediaUploadJobs.id })
      ).length === 1,
    dry,
    failures
  )
  // Apify API tokens (AAD apify_token:<id>:credentials; soft-deleted rows hold an encrypted "" - re-encrypted too)
  const apifyRows = await db
    .select({ id: apifyTokens.id, enc: apifyTokens.credentialsEncrypted })
    .from(apifyTokens)
  const apify = await reencryptRows(
    "apify_token",
    apifyRows,
    aad.apifyTokenCredentials,
    async (id, prev, next) =>
      (
        await db
          .update(apifyTokens)
          .set({ credentialsEncrypted: next })
          .where(and(eq(apifyTokens.id, id), eq(apifyTokens.credentialsEncrypted, prev)))
          .returning({ id: apifyTokens.id })
      ).length === 1,
    dry,
    failures
  )
  const driveCount = driveCreds.count + driveKeys.count + driveSrc.count + relays.count + jobs.count
  if (!dry) {
    if (driveCreds.count + driveKeys.count > 0 || driveCreds.failed + driveKeys.failed > 0)
      await insertActivity({
        actor: CLI_ACTOR,
        action: "drive_credential.update",
        target: { type: "drive_credential", id: null, label: "reencrypt" },
        metadata: {
          via: "cli",
          op: "reencrypt",
          count: driveCreds.count,
          apiKeys: driveKeys.count,
          failed: driveCreds.failed + driveKeys.failed,
        },
      })
    // relay links / upload jobs are short-lived: counted with the sources, no row of their own
    if (driveSrc.count + relays.count + jobs.count > 0 || driveSrc.failed + relays.failed + jobs.failed > 0)
      await insertActivity({
        actor: CLI_ACTOR,
        action: "drive_source.update",
        target: { type: "drive_source", id: null, label: "reencrypt" },
        metadata: {
          via: "cli",
          op: "reencrypt",
          count: driveSrc.count,
          relayLinks: relays.count,
          uploadJobs: jobs.count,
          failed: driveSrc.failed + relays.failed + jobs.failed,
        },
      })
    if (apify.count > 0 || apify.failed > 0)
      await insertActivity({
        actor: CLI_ACTOR,
        action: "apify_token.update",
        target: { type: "apify_token", id: null, label: "reencrypt" },
        metadata: { via: "cli", op: "reencrypt", count: apify.count, failed: apify.failed },
      })
    if (channels.count > 0 || channels.failed > 0)
      await insertActivity({
        actor: CLI_ACTOR,
        action: "notification_channel.update",
        target: { type: "notification_channel", id: null, label: "reencrypt" },
        metadata: { via: "cli", op: "reencrypt", count: channels.count, failed: channels.failed },
      })
    if (conn.count > 0 || conn.failed > 0)
      await insertActivity({
        actor: CLI_ACTOR,
        action: "connection.update",
        target: { type: "connection", id: null, label: "reencrypt" },
        metadata: { via: "cli", op: "reencrypt", count: conn.count, failed: conn.failed },
      })
    if (mcp.count > 0 || mcp.failed > 0)
      await insertActivity({
        actor: CLI_ACTOR,
        action: "mcp.update",
        target: { type: "mcp", id: null, label: "reencrypt" },
        metadata: { via: "cli", op: "reencrypt", count: mcp.count, failed: mcp.failed },
      })
  }
  out(
    dry
      ? `Cần mã hoá lại: ${conn.count} kết nối, ${mcp.count} key MCP, ${channels.count} kết nối Telegram, ${driveCount} bí mật Google Drive, ${apify.count} token Apify (chạy lại không có --dry-run để thực hiện).`
      : `✔ Đã mã hoá lại ${conn.count} kết nối, ${mcp.count} key MCP, ${channels.count} kết nối Telegram, ${driveCount} bí mật Google Drive và ${apify.count} token Apify bằng khoá đang hoạt động.`
  )
  // ids + a redacted error message only - never ciphertext or plaintext
  const kindLabel = {
    connection: "kết nối",
    mcp: "MCP",
    notification_channel: "kết nối Telegram",
    drive_credential: "service account Google Drive",
    drive_api_key: "API key Google Drive",
    drive_source: "thư mục / sheet Google Drive",
    drive_relay_link: "link tạm Google Drive",
    media_upload_job: "lượt tải video Google Drive",
    apify_token: "token Apify",
  } as const
  for (const f of failures) process.stderr.write(`✖ ${kindLabel[f.kind]} ${f.id}: ${f.reason}\n`)
  const raced =
    conn.raced + mcp.raced + channels.raced + driveCreds.raced + driveKeys.raced + driveSrc.raced + relays.raced + jobs.raced + apify.raced
  if (raced > 0) out(`  ${raced} bản ghi vừa được thay đổi trong lúc chạy - chạy lại lệnh để mã hoá nốt.`)
  if (failures.length > 0) {
    throw new CliError(
      `${failures.length} bản ghi không ${dry ? "giải mã" : "mã hoá lại"} được (giữ khoá cũ trong ENCRYPTION_KEYS, kiểm tra rồi chạy lại).`
    )
  }
}

// ---------------------------------------------------------------------------
// google:refresh-token (OAuth 2.0 loopback + PKCE, Desktop client)
// ---------------------------------------------------------------------------

export const GOOGLE_ADS_SCOPE = "https://www.googleapis.com/auth/adwords"

export function buildGoogleAuthUrl(p: {
  clientId: string
  redirectUri: string
  state: string
  codeChallenge: string
}): string {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth")
  u.searchParams.set("client_id", p.clientId)
  u.searchParams.set("redirect_uri", p.redirectUri)
  u.searchParams.set("response_type", "code")
  u.searchParams.set("scope", GOOGLE_ADS_SCOPE)
  u.searchParams.set("access_type", "offline")
  u.searchParams.set("prompt", "consent")
  u.searchParams.set("state", p.state)
  u.searchParams.set("code_challenge", p.codeChallenge)
  u.searchParams.set("code_challenge_method", "S256")
  return u.toString()
}

const page = (title: string, body: string) =>
  `<!doctype html><html lang="vi"><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font-family:system-ui;max-width:520px;margin:15vh auto;padding:0 16px">` +
  `<h1 style="font-size:20px">${title}</h1><p>${body}</p></body></html>`

async function googleRefreshToken(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      "client-id": { type: "string" },
      "client-secret": { type: "string" },
      "client-secret-stdin": { type: "boolean" },
      port: { type: "string" },
      host: { type: "string" },
    },
    strict: true,
  })
  const clientId = values["client-id"]?.trim()
  if (!clientId) throw new CliError("Thiếu --client-id (OAuth client loại Desktop).")
  const clientSecret = (
    await resolveSecret({
      argv: values["client-secret"],
      argvFlag: "--client-secret",
      env: "GOOGLE_ADS_CLIENT_SECRET",
      fromStdin: !!values["client-secret-stdin"],
      promptIfMissing: true,
      prompt: "Client secret (ẩn khi gõ): ",
    })
  )?.trim()
  if (!clientSecret) {
    throw new CliError("Thiếu client secret: đặt biến môi trường GOOGLE_ADS_CLIENT_SECRET hoặc dùng --client-secret-stdin.")
  }
  const port = Number(values.port ?? 8085)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new CliError("--port phải là số từ 1024 đến 65535.")
  // Loopback only by default: the callback carries the authorization code. 0.0.0.0 is opt-in (Docker, with
  // the port published to the VPS loopback + an SSH tunnel).
  const host = values.host?.trim() || "127.0.0.1"
  if (isIP(host) === 0) throw new CliError("--host phải là địa chỉ IP (mặc định 127.0.0.1; trong Docker: 0.0.0.0).")
  if (host !== "127.0.0.1" && host !== "::1") {
    process.stderr.write(
      `⚠ Máy chủ chờ mã đang nghe ${host}:${port}. Chỉ publish cổng ra 127.0.0.1 của máy chủ (-p 127.0.0.1:${port}:${port}) và dùng SSH tunnel.\n`
    )
  }

  const redirectUri = `http://127.0.0.1:${port}`
  const state = randomUUID()
  const verifier = randomBytes(48).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  const authUrl = buildGoogleAuthUrl({ clientId, redirectUri, state, codeChallenge: challenge })

  const code = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close()
      reject(new CliError("Hết 10 phút chờ mà chưa nhận được mã từ Google. Chạy lại lệnh."))
    }, 10 * 60_000)
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", redirectUri)
      if (url.pathname !== "/") {
        res.writeHead(404).end()
        return
      }
      const err = url.searchParams.get("error")
      const got = url.searchParams.get("code")
      if (url.searchParams.get("state") !== state || (!got && !err)) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" })
        res.end(page("Yêu cầu không hợp lệ", "Tham số state không khớp. Hãy mở lại đúng link mà lệnh CLI in ra."))
        return
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      if (err) {
        res.end(page("Google từ chối cấp quyền", "Quay lại terminal để xem chi tiết."))
        clearTimeout(timer)
        server.close()
        reject(new CliError(`Google trả lỗi: ${err}`))
        return
      }
      res.end(page("Đã nhận mã xác thực", "Bạn có thể đóng tab này và quay lại terminal."))
      clearTimeout(timer)
      server.close()
      resolve(got!)
    })
    server.on("error", (e) => {
      clearTimeout(timer)
      reject(new CliError(`Không mở được cổng ${port}: ${e.message}`))
    })
    server.listen(port, host, () => {
      out("1. Mở link sau trong trình duyệt (cùng máy, hoặc máy có cổng " + port + " được chuyển tới):")
      out()
      out(authUrl)
      out()
      out("2. Đăng nhập tài khoản Google có quyền Google Ads và bấm Cho phép.")
      out("   Nếu Google yêu cầu passkey (bắt buộc với một số người dùng Google Ads API), hãy đăng nhập bằng passkey -")
      out("   mã TOTP/SMS không được chấp nhận.")
      out(`   Đang chờ Google chuyển hướng về ${redirectUri} …`)
    })
  })

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(30_000),
  })
  const json = (await tokenRes.json().catch(() => ({}))) as { refresh_token?: string; error?: string; error_description?: string }
  if (!tokenRes.ok || !json.refresh_token) {
    throw new CliError(
      `Đổi mã lấy token thất bại (${json.error ?? tokenRes.status}${json.error_description ? `: ${json.error_description}` : ""}).` +
        (tokenRes.ok ? " Google không trả refresh_token — thu hồi quyền ứng dụng tại myaccount.google.com/permissions rồi chạy lại." : "")
    )
  }
  out()
  out("✔ Refresh token (dán vào form kết nối Google Ads, KHÔNG chia sẻ):")
  out()
  out(json.refresh_token)
  out()
  out("Lưu ý:")
  out("- OAuth consent screen ở trạng thái Testing → refresh token hết hạn sau 7 ngày. Chuyển sang In production")
  out("  và hoàn tất Verify Branding để token không bị hết hạn.")
  out("- Không cần developer token. Cấp truy cập API (Explorer/Basic/Standard) gắn với Google Cloud project của OAuth client.")
  out("- Muốn khỏi phải lấy lại refresh token: dùng service account (thêm email service account làm người dùng ở MCC).")
}

// ---------------------------------------------------------------------------

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv
  const usesDb = cmd !== "google:refresh-token" && cmd !== undefined && cmd !== "help" && cmd !== "--help" && cmd !== "-h"
  try {
    switch (cmd) {
      case "create-admin":
        await createAdmin(rest)
        break
      case "reset-password":
      case "user:reset-password":
        await resetPassword(rest)
        break
      case "reset-2fa":
      case "user:reset-2fa":
        await resetTwoFactor(rest)
        break
      case "unlock":
      case "user:unlock":
        await unlock(rest)
        break
      case "unban":
      case "user:unban":
        await unban(rest)
        break
      case "reencrypt":
        await reencrypt(rest)
        break
      case "google:refresh-token":
        await googleRefreshToken(rest)
        break
      case undefined:
      case "help":
      case "--help":
      case "-h":
        out(HELP)
        break
      default:
        out(HELP)
        throw new CliError(`Lệnh không hợp lệ: ${cmd}`)
    }
    return 0
  } catch (e) {
    // Unexpected errors go through safeErrorForLog: Drizzle's "Failed query … params: <values>" would print the
    // password hash, ids and emails bound to the failing statement (container logs / terminal scrollback).
    const msg =
      e instanceof CliError || (e instanceof Error && e.name === "TypeError" && "code" in e)
        ? (e as Error).message
        : `Lỗi: ${safeErrorForLog(e)}`
    process.stderr.write(`✖ ${msg}\n`)
    return 1
  } finally {
    if (usesDb) {
      try {
        await pool().end()
      } catch {
        /* pool never connected (e.g. DATABASE_URL missing) */
      }
    }
  }
}

const invokedDirectly = (() => {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => process.exit(code))
}
