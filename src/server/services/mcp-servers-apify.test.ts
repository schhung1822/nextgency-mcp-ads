// Apify settings of the MCP service (16-apify.md §7; DB, skipped without DATABASE_URL):
// - "Actor ngoài danh mục" (apify_store_actors) is admin-only: staff cannot turn it on (create or update), may keep it
//   or turn it off; an admin turning it on must re-authenticate (like the GMV Max switch);
// - staff on an MCP with admin-approved GMV Max writes may not raise the Apify per-run / daily caps;
// - the settings are stored snake_case and diffed in activity_logs.
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

import { and, eq, inArray } from "drizzle-orm"

import { aad, encryptJson } from "@/server/crypto/secret-box"
import { db } from "@/server/db/client"
import {
  activityLogs,
  adAccounts,
  connections,
  mcpServers,
  user,
} from "@/server/db/schema"

import {
  createMcpServer,
  getMcpServer,
  MCP_ERRORS,
  updateMcpServer,
  type McpActor,
} from "./mcp-servers"

const hasDb = !!process.env.DATABASE_URL
const okVerify = async () => "ok" as const
const P = `tmcpapify_${randomUUID().slice(0, 8)}`

const staff: McpActor = {
  id: `${P}_staff`,
  email: `${P}_staff@example.test`,
  role: "staff",
}
const admin: McpActor = {
  id: `${P}_admin`,
  email: `${P}_admin@example.test`,
  role: "admin",
}
const ids = { conn: randomUUID(), acc: randomUUID() }

const baseSettings = {
  protectionMode: "advanced",
  twoStepConfirm: true,
  budgetChangeMaxPct: 30,
  maxDailyBudget: { VND: 5_000_000 },
  rateLimitPerMin: 60,
  writeRateLimitPer10Min: 10,
  allowedIps: [],
  apifyEnabled: true,
  apifyRunMaxUsd: 1,
  apifyDailyMaxUsd: 10,
}

function cfg(settings: Record<string, unknown> = {}) {
  return {
    name: `${P} apify`,
    description: null,
    platforms: [
      {
        platform: "tiktok",
        connections: [{ connectionId: ids.conn, accountIds: [ids.acc] }],
        permissions: ["status"],
      },
    ],
    settings: { ...baseSettings, ...settings },
    expiresAt: null,
  }
}

describe.skipIf(!hasDb)(
  "MCP service: Apify settings (admin-only store switch, staff widening)",
  () => {
    let mcpId = ""

    beforeAll(async () => {
      await db.insert(user).values(
        [staff, admin].map((u) => ({
          id: u.id,
          name: u.id,
          email: u.email,
          emailVerified: true,
          role: u.role,
          twoFactorEnabled: u.role === "admin",
        }))
      )
      await db.insert(connections).values({
        id: ids.conn,
        ownerId: staff.id,
        platform: "tiktok",
        name: `${P} tt`,
        status: "active",
        credentialsEncrypted: encryptJson(
          { accessToken: "x" },
          aad.connectionCredentials(ids.conn)
        ),
        credentialHint: "xxxx",
      })
      await db.insert(adAccounts).values({
        id: ids.acc,
        connectionId: ids.conn,
        platform: "tiktok",
        externalId: `${P}1`,
        name: `${P}1`,
        currency: "VND",
        timezone: "Asia/Ho_Chi_Minh",
        status: "active",
        isEnabled: true,
      })
      mcpId = (await createMcpServer(staff, cfg(), okVerify)).id
    })

    afterAll(async () => {
      if (!hasDb) return
      const owners = [staff.id, admin.id]
      await db.delete(mcpServers).where(inArray(mcpServers.ownerId, owners))
      await db.delete(connections).where(inArray(connections.ownerId, owners))
      await db.delete(activityLogs).where(inArray(activityLogs.actorId, owners))
      await db.delete(user).where(inArray(user.id, owners))
    })

    const upd = (
      actor: McpActor,
      c: ReturnType<typeof cfg>,
      verify?: typeof okVerify
    ) => updateMcpServer(actor, { ...c, id: mcpId }, verify)

    it("stores the Apify settings snake_case and reads them back", async () => {
      const [row] = await db
        .select()
        .from(mcpServers)
        .where(eq(mcpServers.id, mcpId))
      expect(row!.settings).toMatchObject({
        apify_enabled: true,
        apify_run_max_usd: 1,
        apify_daily_max_usd: 10,
        apify_store_actors: false,
      })
      expect((await getMcpServer(staff, mcpId))!.settings).toMatchObject({
        apifyEnabled: true,
        apifyRunMaxUsd: 1,
        apifyDailyMaxUsd: 10,
        apifyStoreActors: false,
      })
    })

    it("staff cannot turn 'Actor ngoài danh mục' on (create or update) - field error, nothing saved", async () => {
      await expect(
        createMcpServer(staff, cfg({ apifyStoreActors: true }), okVerify)
      ).rejects.toMatchObject({
        code: "invalid",
        fieldErrors: {
          "settings.apifyStoreActors": MCP_ERRORS.apifyStoreAdminOnly,
        },
      })
      await expect(
        upd(staff, cfg({ apifyStoreActors: true }))
      ).rejects.toMatchObject({
        fieldErrors: {
          "settings.apifyStoreActors": MCP_ERRORS.apifyStoreAdminOnly,
        },
      })
      expect(
        (await getMcpServer(staff, mcpId))!.settings.apifyStoreActors
      ).toBe(false)
    })

    it("an admin turning it on must re-authenticate; then staff may keep it, and turn it off", async () => {
      await expect(
        upd(admin, cfg({ apifyStoreActors: true }))
      ).rejects.toMatchObject({
        code: "reauth_required",
        fieldErrors: { _reauth: "required" },
      })
      expect(
        (await getMcpServer(admin, mcpId))!.settings.apifyStoreActors
      ).toBe(false)
      expect(
        (await upd(admin, cfg({ apifyStoreActors: true }), okVerify)).changed
      ).toBe(true)
      expect(
        (await getMcpServer(staff, mcpId))!.settings.apifyStoreActors
      ).toBe(true)
      const [log] = await db
        .select()
        .from(activityLogs)
        .where(
          and(
            eq(activityLogs.targetId, mcpId),
            eq(activityLogs.action, "mcp.update"),
            eq(activityLogs.actorId, admin.id)
          )
        )
        .orderBy(activityLogs.createdAt)
        .limit(1)
      const meta = log!.metadata as {
        before?: { settings?: Record<string, unknown> }
        after?: { settings?: Record<string, unknown> }
      }
      expect(meta.before?.settings?.apifyStoreActors).toBe(false)
      expect(meta.after?.settings?.apifyStoreActors).toBe(true)
      // staff keeps it while editing something else
      expect(
        (await upd(staff, cfg({ apifyStoreActors: true, apifyRunMaxUsd: 0.5 })))
          .changed
      ).toBe(true)
      // staff turns it off
      expect(
        (
          await upd(
            staff,
            cfg({ apifyStoreActors: false, apifyRunMaxUsd: 0.5 })
          )
        ).changed
      ).toBe(true)
      expect(
        (await getMcpServer(staff, mcpId))!.settings.apifyStoreActors
      ).toBe(false)
    })

    it("staff on an MCP with admin-approved GMV Max writes may lower, never raise / remove the Apify caps", async () => {
      // admin approves GMV Max writes (re-auth) with known Apify caps
      expect(
        (
          await upd(
            admin,
            cfg({
              tiktokGmvMaxWrite: true,
              apifyRunMaxUsd: 1,
              apifyDailyMaxUsd: 10,
            }),
            okVerify
          )
        ).changed
      ).toBe(true)
      const gmv = (s: Record<string, unknown>) =>
        cfg({ tiktokGmvMaxWrite: true, ...s })
      await expect(
        upd(staff, gmv({ apifyRunMaxUsd: 2, apifyDailyMaxUsd: 10 }))
      ).rejects.toMatchObject({
        fieldErrors: {
          "settings.apifyRunMaxUsd": MCP_ERRORS.gmvMaxStaffApifyWidening,
        },
      })
      await expect(
        upd(staff, gmv({ apifyRunMaxUsd: 1, apifyDailyMaxUsd: 20 }))
      ).rejects.toMatchObject({
        fieldErrors: {
          "settings.apifyDailyMaxUsd": MCP_ERRORS.gmvMaxStaffApifyWidening,
        },
      })
      // 0 = no daily cap = wider than any cap
      await expect(
        upd(staff, gmv({ apifyRunMaxUsd: 1, apifyDailyMaxUsd: 0 }))
      ).rejects.toMatchObject({
        fieldErrors: {
          "settings.apifyDailyMaxUsd": MCP_ERRORS.gmvMaxStaffApifyWidening,
        },
      })
      expect(
        (await upd(staff, gmv({ apifyRunMaxUsd: 0.5, apifyDailyMaxUsd: 5 })))
          .changed
      ).toBe(true)
      const s = (await getMcpServer(staff, mcpId))!.settings
      expect([s.apifyRunMaxUsd, s.apifyDailyMaxUsd]).toEqual([0.5, 5])
      // an admin may raise them
      expect(
        (await upd(admin, gmv({ apifyRunMaxUsd: 5, apifyDailyMaxUsd: 0 })))
          .changed
      ).toBe(true)
    })

    it("M1: staff on an MCP with the admin-approved 'Actor ngoài danh mục' switch may lower, never raise / remove the Apify caps or switch to basic", async () => {
      expect(
        (
          await upd(
            admin,
            cfg({ apifyStoreActors: true, apifyRunMaxUsd: 1, apifyDailyMaxUsd: 10 }),
            okVerify
          )
        ).changed
      ).toBe(true)
      const store = (s: Record<string, unknown>) =>
        cfg({ apifyStoreActors: true, apifyRunMaxUsd: 1, apifyDailyMaxUsd: 10, ...s })
      const msg = MCP_ERRORS.apifyStoreStaffWidening
      await expect(upd(staff, store({ apifyRunMaxUsd: 2 }))).rejects.toMatchObject({
        fieldErrors: { "settings.apifyRunMaxUsd": msg },
      })
      await expect(upd(staff, store({ apifyDailyMaxUsd: 20 }))).rejects.toMatchObject({
        fieldErrors: { "settings.apifyDailyMaxUsd": msg },
      })
      await expect(upd(staff, store({ apifyDailyMaxUsd: 0 }))).rejects.toMatchObject({
        fieldErrors: { "settings.apifyDailyMaxUsd": msg },
      })
      await expect(upd(staff, store({ protectionMode: "basic" }))).rejects.toMatchObject({
        fieldErrors: { "settings.protectionMode": msg },
      })
      const s1 = (await getMcpServer(staff, mcpId))!.settings
      expect([s1.apifyRunMaxUsd, s1.apifyDailyMaxUsd, s1.protectionMode]).toEqual([1, 10, "advanced"])
      // narrowing is fine
      expect((await upd(staff, store({ apifyRunMaxUsd: 0.5, apifyDailyMaxUsd: 5 }))).changed).toBe(true)
      // turning the switch off ends the admin-approved scope: then the caps are the staff member's own choice
      expect(
        (await upd(staff, cfg({ apifyStoreActors: false, apifyRunMaxUsd: 3, apifyDailyMaxUsd: 0 }))).changed
      ).toBe(true)
    })
  }
)
