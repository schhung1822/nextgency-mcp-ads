// TikTok GMV Max write switch - save rules of the MCP service (DB; skipped without DATABASE_URL):
// S3: while an admin-approved switch stays on, a STAFF save may keep / narrow the TikTok side but never widen it
//     (accounts, "all accounts", permissions, caps of the TikTok currencies, % limit, write rate limit);
// S4: turning the switch ON (admin) needs re-authentication, like the other sensitive MCP changes.
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
  listMcpServers,
  MCP_ERRORS,
  updateMcpServer,
  type McpActor,
  type ReauthVerifier,
} from "./mcp-servers"

const hasDb = !!process.env.DATABASE_URL
const okVerify = async () => "ok" as const
const P = `tmcpgmv_${randomUUID().slice(0, 8)}`

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

const ids = {
  conn: randomUUID(), // staff, tiktok
  conn2: randomUUID(), // staff, tiktok (second connection)
  acc1: randomUUID(), // VND
  acc2: randomUUID(), // VND
  acc3: randomUUID(), // conn2, VND
}

const baseSettings = {
  twoStepConfirm: true,
  budgetChangeMaxPct: 30,
  maxDailyBudget: { VND: 5_000_000, USD: 100 },
  maxLifetimeBudget: { VND: 50_000_000 },
  maxBid: { VND: 100_000 },
  rateLimitPerMin: 60,
  writeRateLimitPer10Min: 10,
  allowedIps: [],
}

function cfg(
  over: {
    settings?: Record<string, unknown>
    accountIds?: string[] | null
    permissions?: string[]
    extraConn?: boolean
  } = {}
) {
  return {
    name: `${P} gmv`,
    description: "test",
    platforms: [
      {
        platform: "tiktok",
        connections: [
          {
            connectionId: ids.conn,
            accountIds:
              over.accountIds === undefined ? [ids.acc1] : over.accountIds,
          },
          ...(over.extraConn
            ? [{ connectionId: ids.conn2, accountIds: [ids.acc3] }]
            : []),
        ],
        permissions: over.permissions ?? ["status", "update"],
      },
    ],
    settings: { ...baseSettings, ...over.settings },
    expiresAt: null,
  }
}

describe.skipIf(!hasDb)(
  "MCP service: TikTok GMV Max switch (S3 staff widening, S4 re-auth)",
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
      const conn = (id: string, name: string) => ({
        id,
        ownerId: staff.id,
        platform: "tiktok" as const,
        name,
        status: "active",
        credentialsEncrypted: encryptJson(
          { accessToken: "x" },
          aad.connectionCredentials(id)
        ),
        credentialHint: "xxxx",
      })
      await db
        .insert(connections)
        .values([conn(ids.conn, `${P} tt`), conn(ids.conn2, `${P} tt2`)])
      const acc = (id: string, connectionId: string, ext: string) => ({
        id,
        connectionId,
        platform: "tiktok" as const,
        externalId: ext,
        name: ext,
        currency: "VND",
        timezone: "Asia/Ho_Chi_Minh",
        status: "active",
        isEnabled: true,
      })
      await db
        .insert(adAccounts)
        .values([
          acc(ids.acc1, ids.conn, `${P}1`),
          acc(ids.acc2, ids.conn, `${P}2`),
          acc(ids.acc3, ids.conn2, `${P}3`),
        ])
      const r = await createMcpServer(staff, cfg(), okVerify)
      mcpId = r.id
    })

    afterAll(async () => {
      if (!hasDb) return
      const owners = [staff.id, admin.id]
      await db.delete(mcpServers).where(inArray(mcpServers.ownerId, owners))
      await db.delete(connections).where(inArray(connections.ownerId, owners))
      await db.delete(activityLogs).where(inArray(activityLogs.actorId, owners))
      await db.delete(user).where(inArray(user.id, owners))
    })

    const on = (s: Record<string, unknown> = {}) => ({
      tiktokGmvMaxWrite: true,
      ...s,
    })
    const upd = (
      actor: McpActor,
      c: ReturnType<typeof cfg>,
      verify?: ReauthVerifier
    ) => updateMcpServer(actor, { ...c, id: mcpId }, verify)

    it("S4: an admin turning the switch on must re-authenticate (no verifier → reauth_required; bad password → refused + logged)", async () => {
      await expect(upd(admin, cfg({ settings: on() }))).rejects.toMatchObject({
        code: "reauth_required",
        fieldErrors: { _reauth: "required" },
      })
      await expect(
        upd(admin, cfg({ settings: on() }), async () => "bad_password" as const)
      ).rejects.toMatchObject({
        code: "reauth_failed",
      })
      expect(
        (await getMcpServer(admin, mcpId))!.settings.tiktokGmvMaxWrite
      ).toBe(false)
      const failures = await db
        .select()
        .from(activityLogs)
        .where(
          and(
            eq(activityLogs.actorId, admin.id),
            eq(activityLogs.action, "mcp.update")
          )
        )
      expect(
        failures.some(
          (l) =>
            l.status === "failure" &&
            (l.metadata as { reauth?: boolean }).reauth === true
        )
      ).toBe(true)
      expect(
        (await upd(admin, cfg({ settings: on() }), okVerify)).changed
      ).toBe(true)
      expect(
        (await getMcpServer(staff, mcpId))!.settings.tiktokGmvMaxWrite
      ).toBe(true)
      // already on: other admin edits need no re-auth
      expect(
        (await upd(admin, cfg({ settings: on({ budgetChangeMaxPct: 20 }) })))
          .changed
      ).toBe(true)
      // U1: the list shows the switch
      expect(
        (await listMcpServers(staff)).find((m) => m.id === mcpId)!
          .tiktokGmvMaxWrite
      ).toBe(true)
    })

    it("S3: staff may narrow (lower caps / % / rate, fewer permissions) while the switch stays on", async () => {
      expect(
        (
          await upd(
            staff,
            cfg({
              permissions: ["status"],
              settings: on({
                budgetChangeMaxPct: 10,
                writeRateLimitPer10Min: 5,
                maxDailyBudget: { VND: 4_000_000, USD: 100 },
                maxBid: { VND: 90_000 },
              }),
            })
          )
        ).changed
      ).toBe(true)
      expect(
        (await getMcpServer(staff, mcpId))!.settings.tiktokGmvMaxWrite
      ).toBe(true)
    })

    it("S3: staff widening the TikTok side is refused with a field error on the switch (nothing saved)", async () => {
      const narrowed = {
        budgetChangeMaxPct: 10,
        writeRateLimitPer10Min: 5,
        maxDailyBudget: { VND: 4_000_000, USD: 100 },
        maxBid: { VND: 90_000 },
      }
      const widen: ReturnType<typeof cfg>[] = [
        cfg({
          permissions: ["status"],
          accountIds: [ids.acc1, ids.acc2],
          settings: on(narrowed),
        }), // new account
        cfg({
          permissions: ["status"],
          accountIds: null,
          settings: on(narrowed),
        }), // all accounts
        cfg({
          permissions: ["status"],
          extraConn: true,
          settings: on(narrowed),
        }), // new connection
        cfg({ permissions: ["status", "update"], settings: on(narrowed) }), // new permission
        cfg({
          permissions: ["status"],
          settings: on({
            ...narrowed,
            maxDailyBudget: { VND: 4_000_001, USD: 100 },
          }),
        }),
        cfg({
          permissions: ["status"],
          settings: on({ ...narrowed, maxBid: {} }),
        }), // removing a cap = higher
        cfg({
          permissions: ["status"],
          settings: on({ ...narrowed, maxLifetimeBudget: { VND: 60_000_000 } }),
        }),
        cfg({
          permissions: ["status"],
          settings: on({ ...narrowed, budgetChangeMaxPct: 11 }),
        }),
        cfg({
          permissions: ["status"],
          settings: on({ ...narrowed, writeRateLimitPer10Min: 6 }),
        }),
      ]
      for (const c of widen) {
        await expect(upd(staff, c)).rejects.toMatchObject({
          code: "invalid",
          message: MCP_ERRORS.gmvMaxStaffWidening,
          fieldErrors: {
            "settings.tiktokGmvMaxWrite": MCP_ERRORS.gmvMaxStaffWidening,
          },
        })
      }
      const d = (await getMcpServer(staff, mcpId))!
      expect(d.settings.maxDailyBudget.VND).toBe(4_000_000)
      expect(d.permissions.tiktok).toEqual(["read", "status"])
      // a cap of a currency the TikTok accounts do not use is not a TikTok widening
      expect(
        (
          await upd(
            staff,
            cfg({
              permissions: ["status"],
              settings: on({
                ...narrowed,
                maxDailyBudget: { VND: 4_000_000, USD: 500 },
              }),
            })
          )
        ).changed
      ).toBe(true)
    })

    it("S3: staff may widen after turning the switch OFF in the same save; an admin may widen with the switch on", async () => {
      expect(
        (await upd(staff, cfg({ accountIds: [ids.acc1, ids.acc2] }))).changed
      ).toBe(true)
      expect(
        (await getMcpServer(staff, mcpId))!.settings.tiktokGmvMaxWrite
      ).toBe(false)
      expect(
        (await upd(admin, cfg({ accountIds: null, settings: on() }), okVerify))
          .changed
      ).toBe(true)
      expect(
        (await getMcpServer(admin, mcpId))!.settings.tiktokGmvMaxWrite
      ).toBe(true)
    })

    it("L3: staff loosening the IP allowlist or extending / removing the expiry is a widening; narrowing them is allowed", async () => {
      const inDays = (d: number) =>
        new Date(Date.now() + d * 86_400_000).toISOString()
      const ips = ["203.0.113.0/24", "198.51.100.7"]
      const scoped = (allowedIps: string[], expiresAt: string | null) =>
        ({
          ...cfg({ accountIds: null, settings: on({ allowedIps }) }),
          expiresAt,
        }) as unknown as ReturnType<typeof cfg>
      // approved by an admin (switch on): an allowlist + an expiry
      expect((await upd(admin, scoped(ips, inDays(10)))).changed).toBe(true)
      const widen = [
        scoped([], inDays(10)), // empty allowlist = every IP
        scoped([...ips, "192.0.2.1"], inDays(10)), // an IP that was not allowed
        scoped(ips, inDays(20)), // later expiry
        scoped(ips, null), // no expiry
      ]
      for (const c of widen) {
        await expect(upd(staff, c)).rejects.toMatchObject({
          code: "invalid",
          message: MCP_ERRORS.gmvMaxStaffWidening,
        })
      }
      // narrowing: fewer IPs, earlier expiry
      expect(
        (await upd(staff, scoped(["198.51.100.7"], inDays(5)))).changed
      ).toBe(true)
      const d = (await getMcpServer(staff, mcpId))!
      expect(d.settings.allowedIps).toEqual(["198.51.100.7"])
    })
  }
)
