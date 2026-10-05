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
// Secrets passed as argv (--password) still work but print a warning: argv is visible
// in `ps`, shell history and container inspect output.
import { randomBytes } from "node:crypto"
import { createInterface } from "node:readline"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"
import { hashPassword } from "better-auth/crypto"
import { and, count, eq, like } from "drizzle-orm"

import { generateTempPassword } from "@/lib/schemas/users"
import { safeErrorForLog } from "@/server/audit/safe-error"
import { CLI_ACTOR, insertActivity } from "@/server/auth/activity-core"
import { clearLoginFailures } from "@/server/auth/lockout"
import { aad, decryptSecret, encryptSecret, needsReencrypt } from "@/server/crypto/secret-box"
import { db, pool } from "@/server/db/client"
import { account, connections, mcpServers, session, twoFactor, user, verification } from "@/server/db/schema"

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
      Mã hoá lại credential kết nối và key MCP chưa dùng khoá ENCRYPTION_KEYS đang hoạt động.
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

type ReencryptFailure = { kind: "connection" | "mcp"; id: string; reason: string }

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
  if (!dry) {
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
      ? `Cần mã hoá lại: ${conn.count} kết nối, ${mcp.count} key MCP (chạy lại không có --dry-run để thực hiện).`
      : `✔ Đã mã hoá lại ${conn.count} kết nối và ${mcp.count} key MCP bằng khoá đang hoạt động.`
  )
  // ids + a redacted error message only - never ciphertext or plaintext
  for (const f of failures) process.stderr.write(`✖ ${f.kind === "connection" ? "kết nối" : "MCP"} ${f.id}: ${f.reason}\n`)
  const raced = conn.raced + mcp.raced
  if (raced > 0) out(`  ${raced} bản ghi vừa được thay đổi trong lúc chạy - chạy lại lệnh để mã hoá nốt.`)
  if (failures.length > 0) {
    throw new CliError(
      `${failures.length} bản ghi không ${dry ? "giải mã" : "mã hoá lại"} được (giữ khoá cũ trong ENCRYPTION_KEYS, kiểm tra rồi chạy lại).`
    )
  }
}

// ---------------------------------------------------------------------------

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv
  const usesDb = cmd !== undefined && cmd !== "help" && cmd !== "--help" && cmd !== "-h"
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
