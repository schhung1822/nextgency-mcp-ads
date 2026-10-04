// DEV ONLY - creates a throw-away user + fake connection/accounts + MCP and prints its URL so the
// endpoint can be exercised end to end (initialize / tools/list) without the admin UI.
//   pnpm tsx --env-file=.env src/server/mcp/__dev__/seed.ts [--cleanup]
// Refuses to run unless ALLOW_DEV_SEED=1, DATABASE_URL is loopback, NODE_ENV ≠ production and every
// existing user is @example.test (../../db/dev-seed-guard.ts). Never import this file from app code.
import { randomUUID } from "node:crypto"
import { eq, like } from "drizzle-orm"
import { buildMcpUrl, generateMcpKey, hashMcpKey, mcpKeyPrefix } from "../../crypto/mcp-key"
import { aad, encryptJson, encryptSecret } from "../../crypto/secret-box"
import { safeErrorForLog } from "../../audit/safe-error"
import { db, pool } from "../../db/client"
import { assertDevSeedAllowed } from "../../db/dev-seed-guard"
import { adAccounts, connections, mcpAccountScopes, mcpPlatformPermissions, mcpServers, user } from "../../db/schema"

const EMAIL = "dev-mcp-seed@example.test"

async function cleanup() {
  const u = await db.select({ id: user.id }).from(user).where(eq(user.email, EMAIL))
  for (const row of u) {
    await db.delete(mcpServers).where(eq(mcpServers.ownerId, row.id))
    await db.delete(connections).where(eq(connections.ownerId, row.id))
    await db.delete(user).where(eq(user.id, row.id))
  }
  await db.delete(connections).where(like(connections.name, "dev-seed %"))
}

async function main() {
  await assertDevSeedAllowed()
  await cleanup()
  if (process.argv.includes("--cleanup")) {
    console.log("cleaned up")
    return
  }
  const userId = `dev_${randomUUID()}`
  await db.insert(user).values({ id: userId, name: "Dev MCP seed", email: EMAIL, emailVerified: true, role: "admin" })

  const connectionId = randomUUID()
  await db.insert(connections).values({
    id: connectionId,
    ownerId: userId,
    platform: "meta",
    name: "dev-seed Meta",
    credentialsEncrypted: encryptJson({ access_token: "dev-fake-token" }, aad.connectionCredentials(connectionId)),
    credentialHint: "oken",
    status: "active",
  })
  await db.insert(adAccounts).values([
    { connectionId, platform: "meta", externalId: "act_1000001", name: "Dev VND account", currency: "VND", timezone: "Asia/Ho_Chi_Minh" },
    { connectionId, platform: "meta", externalId: "act_1000002", name: "Dev USD account", currency: "USD", timezone: "America/Los_Angeles" },
  ])

  const key = generateMcpKey()
  const mcpId = randomUUID()
  await db.insert(mcpServers).values({
    id: mcpId,
    ownerId: userId,
    name: "Dev seed MCP",
    keyHash: hashMcpKey(key),
    keyPrefix: mcpKeyPrefix(key),
    keyEncrypted: encryptSecret(key, aad.mcpKey(mcpId)),
    status: "active",
    settings: { two_step_confirm: true, budget_change_max_pct: 50, rate_limit_per_min: 120 },
  })
  await db.insert(mcpPlatformPermissions).values({ mcpId, platform: "meta", permissions: ["read", "status", "update"] })
  await db.insert(mcpAccountScopes).values({ mcpId, connectionId, adAccountId: null })

  const base = process.env.MCP_SEED_BASE_URL ?? "http://localhost:3100"
  console.log(buildMcpUrl(base, key))
}

main()
  .then(() => pool().end())
  .catch(async (e) => {
    console.error(safeErrorForLog(e))
    await pool().end()
    process.exit(1)
  })
