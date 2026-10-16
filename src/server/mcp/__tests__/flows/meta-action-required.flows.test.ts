// Meta code 31 "action required" (v1.1.6 B6 + D6) seen end to end: the AI's error names the connection + ad account,
// the connection is flagged "cần xác thực" (connections.meta.actionRequired, status unchanged), the owner gets ONE
// Telegram message per connection per day (eventType connection_invalid, dedupe conn:<id>:action_required:<day>),
// reads keep the flag, a successful write / "Thay token" / "Bỏ cảnh báo" (owner or admin, activity log) clears it, and
// a flag older than 7 days is no longer shown. The Meta error comes from the real mapper (mapGraphError) thrown by the
// fake provider (failNext); the pg-boss sender is a fake (no worker, no Bot API call).
import { and, desc, eq, inArray, sql } from "drizzle-orm"
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

vi.mock("server-only", () => ({}))

import { META_ACTION_REQUIRED_KEY } from "@/lib/schemas/connections"
import { db } from "@/server/db/client"
import {
  activityLogs,
  connections,
  notificationChannels,
  notificationDeliveries,
} from "@/server/db/schema"
import {
  __resetAuthInvalidThrottle,
  markConnectionActionRequired,
  noteConnectionFailure,
} from "@/server/mcp/connection-health"
import { applyRefresh, loadConnection, planRefresh } from "@/server/jobs/lib/connection-ops"
import { encryptChannelToken } from "@/server/notifications/deliver"
import { setNotificationJobSender } from "@/server/notifications/queue"
import { ProviderError } from "@/server/providers/errors"
import { mapGraphError } from "@/server/providers/meta/client"
import {
  dismissActionRequired,
  ConnectionServiceError,
  getConnection,
  listConnections,
} from "@/server/services/connections"
import type { McpGrant } from "@/server/mcp/types"
import {
  demoAccounts,
  loadTestEnv,
  World,
  type ConnInfo,
  type McpInfo,
} from "./world"

const hasDb = loadTestEnv()

const TOKEN = "123456789:AAEhBP0av28dfjdk3rn4kbhfh2-8sdjfskdjfh"

const metaCode31 = () =>
  mapGraphError(
    {
      message: "This request requires the user to take a pending action",
      type: "OAuthException",
      code: 31,
      error_subcode: 3858385,
      error_user_title: "Xác thực tài khoản",
      error_user_msg:
        "Vui lòng xác thực tài khoản của bạn trong Trình quản lý quảng cáo.",
      fbtrace_id: "trace31",
    },
    400,
    "req31"
  )

describe.skipIf(!hasDb)(
  "Meta code 31: cần xác thực (services → endpoint)",
  { timeout: 180_000 },
  () => {
    let w: World
    let conn: ConnInfo
    let mcp: McpInfo
    let channelId: string
    const jobs: unknown[] = []
    const accName = () =>
      `meta 1 ${demoAccounts(w.prefix, "meta")[0]!.currency}`
    const acc = () => conn.accounts[0]!
    const flagOf = async (id = conn.id) => {
      const row = await w.connRow(id)
      return (row.meta as Record<string, unknown>)[META_ACTION_REQUIRED_KEY] as
        Record<string, unknown> | undefined
    }
    const deliveries = () =>
      db
        .select()
        .from(notificationDeliveries)
        .where(eq(notificationDeliveries.channelId, channelId))
        .orderBy(desc(notificationDeliveries.createdAt))
    const setStatus = (id: string, status: "paused" | "active") =>
      w.call(mcp.key, "ads_set_status", {
        platform: "meta",
        account_id: acc().externalId,
        level: "campaign",
        ids: [id],
        status,
      })

    beforeAll(async () => {
      w = await World.create()
      conn = await w.connect(
        w.users.staff,
        "meta",
        demoAccounts(w.prefix, "meta"),
        { name: `${w.prefix} Meta chính` }
      )
      for (const a of conn.accounts) {
        w.seedObjects(a.externalId, [
          {
            id: "c1",
            level: "campaign",
            name: "C1",
            status: "active",
            parentId: null,
            budget: null,
          },
          {
            id: "c2",
            level: "campaign",
            name: "C2",
            status: "active",
            parentId: null,
            budget: null,
          },
        ])
      }
      mcp = await w.mcp(w.users.staff, {
        settings: { twoStepConfirm: false },
        platforms: {
          meta: { permissions: ["read", "status"], connections: [{ conn }] },
        },
      })
      channelId = crypto.randomUUID()
      await db.insert(notificationChannels).values({
        id: channelId,
        ownerId: w.users.staff.id,
        type: "telegram",
        name: `${w.prefix} staff`,
        credentialsEncrypted: encryptChannelToken(channelId, TOKEN),
        credentialHint: TOKEN.slice(-4),
        config: {
          chatId: "-100777000111",
          chatTitle: "Chat",
          chatType: "supergroup",
          messageThreadId: null,
          botId: "123456789",
          botUsername: "ads_test_bot",
        },
        events: ["connection_health"],
        status: "active",
      })
      setNotificationJobSender(async (_name, data) => {
        jobs.push(data)
        return "job"
      })
    }, 120_000)

    afterAll(async () => {
      setNotificationJobSender(null)
      if (!w) return
      await db
        .delete(notificationChannels)
        .where(inArray(notificationChannels.ownerId, [w.users.staff.id]))
      await w.cleanup()
    }, 60_000)

    beforeEach(() => {
      w.reset()
      __resetAuthInvalidThrottle()
      jobs.length = 0
    })

    it("code 31 on a write: the error names the connection + ad account, the connection is flagged (status unchanged), one Telegram message", async () => {
      w.failNext("meta", "setStatus", metaCode31, { account: acc().externalId })
      const r = await setStatus("c1", "paused")
      expect(r.isError).toBe(true)
      expect(r.sc.code).toBe("action_required")
      const msg = String(r.sc.message)
      expect(msg).toContain("Vui lòng xác thực tài khoản")
      expect(msg).toContain(`Kết nối "${w.prefix} Meta chính"`)
      expect(msg).toContain(
        `tài khoản quảng cáo "${accName()}" (${acc().externalId})`
      )

      const row = await w.connRow(conn.id)
      expect(row.status).toBe("active")
      const flag = await flagOf()
      expect(flag).toMatchObject({
        platform: "meta",
        accountExternalId: acc().externalId,
        accounts: [acc().externalId],
      })
      expect(String(flag?.message)).toContain("Vui lòng xác thực")

      await vi.waitFor(async () => expect((await deliveries()).length).toBe(1))
      const [d] = await deliveries()
      expect(d!.eventType).toBe("connection_invalid")
      expect(d!.dedupeKey).toMatch(
        new RegExp(`^conn:${conn.id}:action_required:\\d{4}-\\d{2}-\\d{2}$`)
      )
      expect(d!.preview).toContain("Meta yêu cầu xác thực tài khoản")
      expect(d!.preview).toContain(acc().externalId)
      expect(d!.message).not.toContain(TOKEN)
    })

    it("a second code 31 the same day refreshes the flag but sends no second message (1 / connection / day)", async () => {
      const before = await flagOf()
      w.failNext("meta", "setStatus", metaCode31, { account: acc().externalId })
      const r = await setStatus("c1", "paused")
      expect(r.sc.code).toBe("action_required")
      const after = await flagOf()
      expect(after?.since).toBe(before?.since)
      expect(Date.parse(String(after?.lastAt))).toBeGreaterThanOrEqual(
        Date.parse(String(before?.lastAt))
      )
      // the notify call is fire-and-forget: give it time, then the dedupe key must have kept it at one row
      await new Promise((res) => setTimeout(res, 300))
      expect((await deliveries()).length).toBe(1)
    })

    it("the list and the detail show the flag; a successful read keeps it", async () => {
      const list = await listConnections(w.users.staff)
      const item = list.find((c) => c.id === conn.id)
      expect(item?.actionRequired).toMatchObject({
        accounts: [acc().externalId],
      })
      const other = await w.connect(
        w.users.staff,
        "meta",
        demoAccounts(`${w.prefix}x`, "meta")
      )
      expect(
        (await listConnections(w.users.staff)).find((c) => c.id === other.id)
          ?.actionRequired
      ).toBeNull()
      await w.removeConnection(w.users.staff, other.id)

      const detail = await getConnection(w.users.staff, conn.id)
      expect(detail.actionRequired?.message).toContain("Vui lòng xác thực")

      const read = await w.call(mcp.key, "ads_list_objects", {
        platform: "meta",
        account_id: acc().externalId,
        level: "campaign",
      })
      expect(read.isError, read.text).toBe(false)
      expect(await flagOf()).toBeDefined()
    })

    it("a successful write on the flagged ad account clears the flag", async () => {
      const r = await setStatus("c2", "paused")
      expect(r.isError, r.text).toBe(false)
      expect(await flagOf()).toBeUndefined()
      expect(
        (await getConnection(w.users.staff, conn.id)).actionRequired
      ).toBeNull()
    })

    it("a flag older than 7 days is not shown", async () => {
      await markConnectionActionRequired(conn.id, {
        platform: "meta",
        accountExternalId: acc().externalId,
        messageVi: "x",
      })
      expect(
        (await getConnection(w.users.staff, conn.id)).actionRequired
      ).not.toBeNull()
      const old = new Date(Date.now() - 8 * 24 * 3600_000).toISOString()
      await db
        .update(connections)
        .set({
          meta: sql`jsonb_set(${connections.meta}, '{actionRequired,lastAt}', to_jsonb(${old}::text))`,
        })
        .where(eq(connections.id, conn.id))
      expect(
        (await getConnection(w.users.staff, conn.id)).actionRequired
      ).toBeNull()
      expect(
        (await listConnections(w.users.staff)).find((c) => c.id === conn.id)
          ?.actionRequired
      ).toBeNull()
    })

    it("Bỏ cảnh báo: another staff gets not found, the owner removes it (activity log), nothing left → false", async () => {
      await markConnectionActionRequired(conn.id, {
        platform: "meta",
        accountExternalId: acc().externalId,
        messageVi: "x",
      })
      await expect(
        dismissActionRequired(w.users.staff2, { connectionId: conn.id })
      ).rejects.toBeInstanceOf(ConnectionServiceError)
      expect(await flagOf()).toBeDefined()

      expect(
        await dismissActionRequired(w.users.staff, { connectionId: conn.id })
      ).toBe(true)
      expect(await flagOf()).toBeUndefined()
      const [log] = await db
        .select()
        .from(activityLogs)
        .where(
          and(
            eq(activityLogs.actorId, w.users.staff.id),
            eq(activityLogs.targetId, conn.id),
            eq(activityLogs.action, "connection.update")
          )
        )
        .orderBy(desc(activityLogs.createdAt))
        .limit(1)
      expect(log?.metadata).toMatchObject({
        changed: ["actionRequired"],
        after: { actionRequired: null },
      })
      expect(
        await dismissActionRequired(w.users.staff, { connectionId: conn.id })
      ).toBe(false)

      // an admin may dismiss any connection's flag
      await markConnectionActionRequired(
        conn.id,
        { platform: "meta", accountExternalId: null, messageVi: "y" },
        Date.now() + 120_000
      )
      expect(
        await dismissActionRequired(w.users.admin, { connectionId: conn.id })
      ).toBe(true)
    })

    it("Thay token clears the flag", async () => {
      await markConnectionActionRequired(conn.id, {
        platform: "meta",
        accountExternalId: acc().externalId,
        messageVi: "x",
      })
      expect(await flagOf()).toBeDefined()
      const fresh = w.token("meta", demoAccounts(w.prefix, "meta"))
      await w.replace(w.users.staff, {
        connectionId: conn.id,
        credentials: { token: fresh },
      })
      expect(await flagOf()).toBeUndefined()
      conn = { ...conn, token: fresh }
    })

    it("a connection check never overwrites the flag stored meanwhile: set between read and write survives, dismissed is not resurrected", async () => {
    // set while the platform is being called
    let row = (await loadConnection(conn.id))!
    expect(row.meta).not.toHaveProperty(META_ACTION_REQUIRED_KEY)
    let plan = await planRefresh(row, { syncAccounts: false })
    expect(plan.meta).toBeDefined()
    await markConnectionActionRequired(conn.id, { platform: "meta", accountExternalId: acc().externalId, messageVi: "x" })
    await applyRefresh(db, row, plan)
    expect(await flagOf()).toMatchObject({ accounts: [acc().externalId] })
    expect((await w.connRow(conn.id)).meta).toHaveProperty("checkWarnings")

    // dismissed while the platform is being called (the stale copy read before still has it)
    row = (await loadConnection(conn.id))!
    expect(row.meta).toHaveProperty(META_ACTION_REQUIRED_KEY)
    plan = await planRefresh(row, { syncAccounts: false })
    expect(plan.meta).toHaveProperty(META_ACTION_REQUIRED_KEY)
    expect(await dismissActionRequired(w.users.staff, { connectionId: conn.id })).toBe(true)
    await applyRefresh(db, row, plan)
    expect(await flagOf()).toBeUndefined()
  })

  it("a disabled connection is never flagged; other errors are named but do not flag", async () => {
      await db
        .update(connections)
        .set({ status: "disabled" })
        .where(eq(connections.id, conn.id))
      expect(
        await markConnectionActionRequired(conn.id, {
          platform: "meta",
          accountExternalId: null,
        })
      ).toBe(false)
      await db
        .update(connections)
        .set({ status: "active" })
        .where(eq(connections.id, conn.id))

      const grant = {
        accounts: [
          {
            id: acc().id,
            connectionId: conn.id,
            platform: "meta",
            externalId: acc().externalId,
            name: "TK <A>",
            currency: "VND",
            timezone: "Asia/Ho_Chi_Minh",
          },
        ],
        pages: [],
      } as unknown as McpGrant
      const denied = new ProviderError({
        platform: "meta",
        code: "permission_denied",
        message: "x",
        userMessageVi: "Thiếu quyền.",
      })
      const out = (await noteConnectionFailure(denied, {
        connectionId: conn.id,
        grant,
        accountExternalId: acc().externalId,
      })) as ProviderError
      expect(out.userMessageVi).toBe(
        `Thiếu quyền. (Kết nối "${w.prefix} Meta chính", tài khoản quảng cáo "TK <A>" (${acc().externalId}))`
      )
      expect(out.code).toBe("permission_denied")
      expect(await flagOf()).toBeUndefined()

      // a connection outside the grant / a non-provider error / rate limits stay untouched
      const foreign = await noteConnectionFailure(denied, {
        connectionId: crypto.randomUUID(),
        grant,
        accountExternalId: null,
      })
      expect(foreign).toBe(denied)
      const limited = new ProviderError({
        platform: "meta",
        code: "rate_limited",
        message: "x",
        userMessageVi: "Chậm lại.",
      })
      expect(
        await noteConnectionFailure(limited, {
          connectionId: conn.id,
          grant,
          accountExternalId: null,
        })
      ).toBe(limited)
      const plain = new Error("boom")
      expect(
        await noteConnectionFailure(plain, {
          connectionId: conn.id,
          grant,
          accountExternalId: null,
        })
      ).toBe(plain)
    })
  }
)
