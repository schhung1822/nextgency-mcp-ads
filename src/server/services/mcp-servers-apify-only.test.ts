// Apify-only MCPs (16-apify.md §2 decision A5: Apify counts as a platform; DB, skipped without DATABASE_URL):
// - an MCP may have no ad platform when Apify is on - for staff and admins, the Apify pool is the MCP OWNER's
//   (company tokens + the owner's personal tokens), never the editor's;
// - no ad platform and Apify off → "Chọn ít nhất 1 nền tảng"; Apify-only with an empty pool → field error
//   settings.apifyEnabled (an MCP with nothing usable is refused).
// Isolation: other DB test files create COMPANY Apify tokens at the same time (they would join every pool), so the
// pool is filtered to the tokens created here (the real loader runs underneath).
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

vi.hoisted(() => {
  try {
    process.loadEnvFile(".env")
  } catch {
    /* no .env (CI) → DB tests are skipped */
  }
})

vi.mock("server-only", () => ({}))

const iso = vi.hoisted(() => ({ tokenIds: new Set<string>() }))
vi.mock("@/server/apify/store", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/apify/store")>()
  return {
    ...real,
    loadGrantApifyTokens: async (
      ...a: Parameters<typeof real.loadGrantApifyTokens>
    ) =>
      (await real.loadGrantApifyTokens(...a)).filter((t) =>
        iso.tokenIds.has(t.id)
      ),
  }
})

import { and, eq, inArray } from "drizzle-orm"

import {
  DEFAULT_SETTINGS_INPUT,
  MCP_SCHEMA_MESSAGES,
} from "@/lib/schemas/mcp-servers"
import { encryptApifyToken } from "@/server/apify/store"
import { db } from "@/server/db/client"
import {
  activityLogs,
  apifyTokens,
  mcpPlatformPermissions,
  mcpServers,
  user,
} from "@/server/db/schema"

import {
  createMcpServer,
  getMcpServer,
  listMcpServers,
  MCP_ERRORS,
  updateMcpServer,
  type McpActor,
} from "./mcp-servers"

const hasDb = !!process.env.DATABASE_URL
const okVerify = async () => "ok" as const
const P = `tmcpapifyonly_${randomUUID().slice(0, 8)}`

const mk = (k: string, role: "admin" | "staff"): McpActor => ({
  id: `${P}_${k}`,
  email: `${P}_${k}@example.test`,
  role,
})
const staff = mk("staff", "staff")
const staff2 = mk("staff2", "staff")
const admin = mk("admin", "admin")
const OWNERS = [staff.id, staff2.id, admin.id]

/** an Apify-only config: no ad platform, Apify on */
function apifyOnly(name: string, settings: Record<string, unknown> = {}) {
  return {
    name: `${P} ${name}`,
    description: null,
    platforms: [],
    settings: {
      ...DEFAULT_SETTINGS_INPUT,
      protectionMode: "basic",
      apifyEnabled: true,
      apifyRunMaxUsd: 1,
      apifyDailyMaxUsd: 10,
      ...settings,
    },
    expiresAt: null,
  }
}

async function addToken(owner: McpActor, scope: "company" | "personal") {
  const id = randomUUID()
  await db.insert(apifyTokens).values({
    id,
    scope,
    ownerId: owner.id,
    name: `${P} ${owner.id} ${scope}`,
    credentialsEncrypted: encryptApifyToken(id, `apify_api_${P}${scope}x`),
    credentialHint: "xxxx",
    apifyUserId: `${P}${owner.id}${scope}`,
    status: "active",
  })
  iso.tokenIds.add(id)
  return id
}

describe.skipIf(!hasDb)(
  "MCP service: Apify-only MCP (Apify counts as a platform, A5)",
  () => {
    beforeAll(async () => {
      await db.insert(user).values(
        [staff, staff2, admin].map((u) => ({
          id: u.id,
          name: u.id,
          email: u.email,
          emailVerified: true,
          role: u.role,
          twoFactorEnabled: u.role === "admin",
        }))
      )
    })

    afterAll(async () => {
      if (!hasDb) return
      await db.delete(mcpServers).where(inArray(mcpServers.ownerId, OWNERS))
      await db.delete(apifyTokens).where(inArray(apifyTokens.ownerId, OWNERS))
      await db.delete(activityLogs).where(inArray(activityLogs.actorId, OWNERS))
      await db.delete(user).where(inArray(user.id, OWNERS))
    })

    it("no ad platform and Apify off: refused with 'Chọn ít nhất 1 nền tảng'", async () => {
      await expect(
        createMcpServer(
          staff,
          apifyOnly("none", { apifyEnabled: false }),
          okVerify
        )
      ).rejects.toMatchObject({
        code: "invalid",
        fieldErrors: { platforms: MCP_SCHEMA_MESSAGES.platformsRequired },
      })
    })

    it("Apify-only with an empty pool of the owner: refused on settings.apifyEnabled; another staff's token does not count", async () => {
      iso.tokenIds.clear()
      await addToken(staff2, "personal")
      await expect(
        createMcpServer(staff, apifyOnly("empty"), okVerify)
      ).rejects.toMatchObject({
        code: "invalid",
        fieldErrors: { "settings.apifyEnabled": MCP_ERRORS.apifyOnlyNoToken },
      })
      const rows = await db
        .select({ id: mcpServers.id })
        .from(mcpServers)
        .where(eq(mcpServers.ownerId, staff.id))
      expect(rows).toEqual([])
    })

    it("staff: Apify-only MCP on the staff's personal token - no platform rows, listed with Apify, update keeps it", async () => {
      iso.tokenIds.clear()
      await addToken(staff, "personal")
      const { id } = await createMcpServer(staff, apifyOnly("staff"), okVerify)
      const perms = await db
        .select()
        .from(mcpPlatformPermissions)
        .where(eq(mcpPlatformPermissions.mcpId, id))
      expect(perms).toEqual([])
      const detail = (await getMcpServer(staff, id))!
      expect(detail.config).toEqual([])
      expect(detail.platforms).toEqual([])
      expect(detail.apifyEnabled).toBe(true)
      expect(detail.settings.apifyEnabled).toBe(true)
      expect(detail.capsMissing).toEqual([])
      const item = (await listMcpServers(staff)).find((m) => m.id === id)!
      expect(item).toMatchObject({
        platforms: [],
        allPermissions: [],
        apifyEnabled: true,
      })
      // rename + lower the per-run cap: saved and logged
      expect(
        (
          await updateMcpServer(staff, {
            ...apifyOnly("staff 2", { apifyRunMaxUsd: 0.5 }),
            id,
          })
        ).changed
      ).toBe(true)
      const [log] = await db
        .select()
        .from(activityLogs)
        .where(
          and(
            eq(activityLogs.targetId, id),
            eq(activityLogs.action, "mcp.update")
          )
        )
      const meta = log!.metadata as {
        after?: { settings?: Record<string, unknown>; name?: string }
      }
      expect(meta.after?.settings?.apifyRunMaxUsd).toBe(0.5)
      expect(meta.after?.name).toBe(`${P} staff 2`)
      // switching Apify off without any ad platform leaves nothing: refused
      await expect(
        updateMcpServer(staff, {
          ...apifyOnly("staff 2", { apifyEnabled: false }),
          id,
        })
      ).rejects.toMatchObject({
        fieldErrors: { platforms: MCP_SCHEMA_MESSAGES.platformsRequired },
      })
    })

    it("admin: Apify-only MCP on a company token; editing a staff MCP checks the OWNER's pool, not the admin's", async () => {
      iso.tokenIds.clear()
      const company = await addToken(admin, "company")
      const { id: adminMcp } = await createMcpServer(
        admin,
        apifyOnly("admin"),
        okVerify
      )
      expect((await getMcpServer(admin, adminMcp))!.config).toEqual([])
      // a company token joins the staff's pool too
      const { id: staffMcp } = await createMcpServer(
        staff,
        apifyOnly("staff on company"),
        okVerify
      )
      // only the admin's PERSONAL token left: it never serves the staff's MCP
      iso.tokenIds.delete(company)
      await addToken(admin, "personal")
      await expect(
        updateMcpServer(admin, {
          ...apifyOnly("staff on company 2"),
          id: staffMcp,
        })
      ).rejects.toMatchObject({
        fieldErrors: { "settings.apifyEnabled": MCP_ERRORS.apifyOnlyNoToken },
      })
      // the admin's own Apify-only MCP still saves (the admin's personal token is in its pool)
      expect(
        (
          await updateMcpServer(admin, {
            ...apifyOnly("admin 2"),
            id: adminMcp,
          })
        ).changed
      ).toBe(true)
    })
  }
)
