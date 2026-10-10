// "Miễn trừ trách nhiệm" enforcement on the SERVER ACTIONS (what the browser can really POST): every create path of
// "Thêm kết nối" (token, TikTok auth_code, Telegram, Google Drive) and "Tạo MCP" refuses unless the SAME user
// accepted the CURRENT version of the matching text (at any time - shown once per user, kind and version); the
// acceptance is an append-only activity_logs row with the content hash; the created object's log carries the
// accepted version. Real DB + real services for
// connections / MCPs; the Telegram and Drive services are spied (they would call Telegram / Google).
import { and, eq, inArray } from "drizzle-orm"
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
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
const requireUserForAction = vi.fn()
vi.mock("@/server/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth/session")>()),
  requireUserForAction: (...a: unknown[]) => requireUserForAction(...a),
}))
const reauthCalls = vi.hoisted(() => ({ n: 0 }))
vi.mock("@/server/auth/reauth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth/reauth")>()),
  requestReauthVerifier: async () => async () => {
    reauthCalls.n++
    return "ok" as const
  },
}))
const createChannel = vi.hoisted(() => vi.fn())
vi.mock("@/server/services/notification-channels", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/server/services/notification-channels")
  >()),
  createNotificationChannel: (...a: unknown[]) => createChannel(...a),
}))
const createSource = vi.hoisted(() => vi.fn())
vi.mock("@/server/services/drive-sources", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/services/drive-sources")>()),
  createDriveSource: (...a: unknown[]) => createSource(...a),
}))

import { DISCLAIMER_VERSIONS } from "@/lib/disclaimers"
import { disclaimers as t } from "@/lib/i18n/vi/disclaimers"
import {
  createConnectionAction,
  createTikTokFromAuthCodeAction,
} from "@/server/actions/connections"
import { createDriveSourceAction } from "@/server/actions/drive"
import { acceptDisclaimerAction } from "@/server/actions/legal"
import { createMcpAction } from "@/server/actions/mcp-servers"
import { createTelegramChannelAction } from "@/server/actions/notification-channels"
import { AuthorizationError } from "@/server/auth/session"
import { db } from "@/server/db/client"
import { quotaId } from "@/server/db/quota"
import {
  activityLogs,
  connections,
  mcpServers,
  verification,
} from "@/server/db/schema"
import {
  disclaimerContentHash,
  findDisclaimerAcceptance,
  hasAcceptedDisclaimer,
} from "@/server/services/disclaimers"

import { demoAccounts, loadTestEnv, World, type ConnInfo } from "./world"

const hasDb = loadTestEnv()
const V = DISCLAIMER_VERSIONS

describe.skipIf(!hasDb)(
  "miễn trừ trách nhiệm - bắt buộc ở server action",
  { timeout: 180_000 },
  () => {
    let w: World
    let adminConn: ConnInfo
    const asUser = (u: {
      id: string
      email: string
      role: "admin" | "staff"
    }) =>
      requireUserForAction.mockResolvedValue({
        sessionId: "s",
        user: {
          ...u,
          name: u.id,
          twoFactorEnabled: true,
          mustChangePassword: false,
          banned: false,
        },
      })
    const acceptRows = (userId: string) =>
      db
        .select()
        .from(activityLogs)
        .where(
          and(
            eq(activityLogs.actorId, userId),
            eq(activityLogs.action, "legal.disclaimer_accept")
          )
        )
    /** a hand-written acceptance row (old / other version) - what a past popup would have left behind */
    const insertAcceptance = (
      u: { id: string; email: string; role: string },
      kind: string,
      version: string,
      at: Date,
      status: "success" | "failure" = "success"
    ) =>
      db.insert(activityLogs).values({
        createdAt: at,
        actorId: u.id,
        actorEmail: u.email,
        actorRole: u.role,
        action: "legal.disclaimer_accept",
        targetType: "disclaimer",
        targetId: kind,
        targetLabel: version,
        status,
        metadata: { kind, version },
      })

    beforeAll(async () => {
      w = await World.create()
      adminConn = await w.connect(
        w.users.admin,
        "meta",
        demoAccounts(w.prefix, "meta")
      )
    }, 120_000)
    afterAll(async () => {
      if (w) await w.cleanup()
    }, 60_000)
    beforeEach(async () => {
      requireUserForAction.mockReset()
      createChannel.mockReset()
      createSource.mockReset()
      reauthCalls.n = 0
      w.reset()
      const ids = Object.values(w.users).flatMap((u) => [
        quotaId("connection-verify", u.id),
        quotaId("disclaimer-accept", u.id),
        quotaId("drive-verify", u.id),
        quotaId("telegram-verify", u.id),
      ])
      await db.delete(verification).where(inArray(verification.id, ids))
    })

    const metaInput = (name: string) => ({
      platform: "meta",
      name: `${w.prefix} ${name}`,
      credentials: {
        token: w.token(
          "meta",
          demoAccounts(w.prefix, "meta").map((a) => ({
            ...a,
            externalId: `${a.externalId}${name.length}`,
          }))
        ),
      },
    })
    const mcpInput = (name: string) => ({
      ...w.toInput({
        platforms: {
          meta: { permissions: ["read"], connections: [{ conn: adminConn }] },
        },
      }),
      name: `${w.prefix} ${name}`,
      password: "x",
    })
    const telegramInput = {
      name: "Kênh thử",
      botToken: `123456789:${"A".repeat(35)}`,
      chatId: "-1001234567890",
      events: [],
    }
    const driveInput = {
      kind: "folder",
      scope: "personal",
      link: "https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz0123",
    }

    // ---------------------------------------------------------------------------------------------------------
    it("acceptDisclaimerAction: cần đăng nhập; từ chối loại lạ và phiên bản cũ (không ghi dòng nào)", async () => {
      requireUserForAction.mockRejectedValue(
        new AuthorizationError(
          "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại."
        )
      )
      expect(
        await acceptDisclaimerAction({
          kind: "connection",
          version: V.connection,
        })
      ).toMatchObject({
        ok: false,
        error: "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.",
      })
      asUser(w.users.staff)
      expect(
        await acceptDisclaimerAction({
          kind: "telegram",
          version: V.connection,
        })
      ).toMatchObject({ ok: false, error: t.errors.invalid })
      expect(await acceptDisclaimerAction(null)).toMatchObject({ ok: false })
      expect(
        await acceptDisclaimerAction({
          kind: "connection",
          version: "2020-01-01",
        })
      ).toEqual({ ok: false, error: t.errors.stale, fieldErrors: undefined })
      expect(await acceptRows(w.users.staff.id)).toHaveLength(0)
    })

    it("acceptDisclaimerAction: ghi activity_logs legal.disclaimer_accept với loại, phiên bản, mã băm nội dung", async () => {
      asUser(w.users.staff2)
      const r = await acceptDisclaimerAction({ kind: "mcp", version: V.mcp })
      expect(r).toMatchObject({
        ok: true,
        data: { kind: "mcp", version: V.mcp },
      })
      const rows = await acceptRows(w.users.staff2.id)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        actorEmail: w.users.staff2.email,
        actorRole: "staff",
        targetType: "disclaimer",
        targetId: "mcp",
        targetLabel: V.mcp,
        status: "success",
        metadata: {
          kind: "mcp",
          version: V.mcp,
          contentHash: disclaimerContentHash("mcp"),
        },
      })
      expect(disclaimerContentHash("mcp")).toMatch(/^[0-9a-f]{16}$/)
      expect(disclaimerContentHash("mcp")).not.toBe(
        disclaimerContentHash("connection")
      )
      // the MCP text does not count for connections (and vice versa)
      expect(
        await findDisclaimerAcceptance(w.users.staff2.id, "mcp")
      ).not.toBeNull()
      expect(await hasAcceptedDisclaimer(w.users.staff2.id, "mcp")).toBe(true)
      expect(
        await findDisclaimerAcceptance(w.users.staff2.id, "connection")
      ).toBeNull()
      expect(await hasAcceptedDisclaimer(w.users.staff2.id, "connection")).toBe(
        false
      )
    })

    it("tạo kết nối (token) bị từ chối khi chưa xác nhận - không gọi nền tảng, không tạo gì; xác nhận xong thì tạo được và log có phiên bản", async () => {
      const u = w.users.staff
      asUser(u)
      const before = await db
        .select()
        .from(connections)
        .where(eq(connections.ownerId, u.id))
      const refused = await createConnectionAction(metaInput("k1"))
      expect(refused).toEqual({
        ok: false,
        error: t.errors.required.connection,
        fieldErrors: undefined,
      })
      expect(w.state.credentialsSeen).toHaveLength(0)
      expect(
        await db.select().from(connections).where(eq(connections.ownerId, u.id))
      ).toHaveLength(before.length)

      // only the MCP text accepted → still refused
      await w.acceptDisclaimers(u, ["mcp"])
      expect(await createConnectionAction(metaInput("k1"))).toMatchObject({
        ok: false,
        error: t.errors.required.connection,
      })

      expect(
        (
          await acceptDisclaimerAction({
            kind: "connection",
            version: V.connection,
          })
        ).ok
      ).toBe(true)
      const done = await createConnectionAction(metaInput("k1"))
      expect(done.ok).toBe(true)
      const id = (done as { data: { id: string } }).data.id
      const [log] = await db
        .select()
        .from(activityLogs)
        .where(
          and(
            eq(activityLogs.action, "connection.create"),
            eq(activityLogs.targetId, id)
          )
        )
      expect(log!.metadata).toMatchObject({ disclaimerVersion: V.connection })
    })

    it("xác nhận phiên bản hiện tại không hết hạn (hiện 1 lần); phiên bản cũ, dòng thất bại, của người khác không được tính", async () => {
      const u = w.users.staff2 // has an MCP acceptance only (test above)
      asUser(u)
      // an older version (the text changed since) must be accepted again
      await insertAcceptance(u, "connection", "2020-01-01", new Date())
      // a row of the current version written as a failure does not count either
      await insertAcceptance(u, "connection", V.connection, new Date(), "failure")
      expect(await findDisclaimerAcceptance(u.id, "connection")).toBeNull()
      expect(await hasAcceptedDisclaimer(u.id, "connection")).toBe(false)
      expect(await createConnectionAction(metaInput("k2x"))).toMatchObject({
        ok: false,
        error: t.errors.required.connection,
      })
      // the admin's acceptance does not help staff2
      await w.acceptDisclaimers(w.users.admin, ["connection"])
      expect(await hasAcceptedDisclaimer(u.id, "connection")).toBe(false)
      expect(await createConnectionAction(metaInput("k2x"))).toMatchObject({
        ok: false,
        error: t.errors.required.connection,
      })
      // an acceptance of the current version long ago still counts: no time window (page + create action)
      await insertAcceptance(
        u,
        "connection",
        V.connection,
        new Date(Date.now() - 200 * 24 * 3600_000)
      )
      expect(await hasAcceptedDisclaimer(u.id, "connection")).toBe(true)
      expect(await findDisclaimerAcceptance(u.id, "connection")).toMatchObject({
        version: V.connection,
      })
      const done = await createConnectionAction(metaInput("k2x"))
      expect(done.ok, JSON.stringify(done)).toBe(true)
      const id = (done as { data: { id: string } }).data.id
      const [log] = await db
        .select()
        .from(activityLogs)
        .where(
          and(
            eq(activityLogs.action, "connection.create"),
            eq(activityLogs.targetId, id)
          )
        )
      expect(log!.metadata).toMatchObject({ disclaimerVersion: V.connection })
    })

    it("TikTok auth_code: từ chối trước khi đổi mã khi chưa xác nhận", async () => {
      const u = w.users.banned // never accepted anything (the session guard is faked here)
      asUser(u)
      const r = await createTikTokFromAuthCodeAction({
        name: `${w.prefix} tt`,
        appId: "7312345678901234567",
        secret: "s".repeat(32),
        authCode: "code",
      })
      expect(r).toMatchObject({
        ok: false,
        error: t.errors.required.connection,
      })
      expect(
        await db.select().from(connections).where(eq(connections.ownerId, u.id))
      ).toHaveLength(0)
    })

    it("Telegram và Google Drive: từ chối khi chưa xác nhận (service không được gọi); xác nhận xong service nhận phiên bản để ghi log", async () => {
      const u = w.users.banned
      asUser(u)
      expect(await createTelegramChannelAction(telegramInput)).toMatchObject({
        ok: false,
        error: t.errors.required.connection,
      })
      expect(await createDriveSourceAction(driveInput)).toMatchObject({
        ok: false,
        error: t.errors.required.connection,
      })
      expect(createChannel).not.toHaveBeenCalled()
      expect(createSource).not.toHaveBeenCalled()

      await w.acceptDisclaimers(u, ["connection"])
      createChannel.mockResolvedValue({
        id: "00000000-0000-4000-8000-000000000001",
        check: { ok: true },
      })
      createSource.mockResolvedValue({
        id: "00000000-0000-4000-8000-000000000002",
        source: {},
      })
      expect((await createTelegramChannelAction(telegramInput)).ok).toBe(true)
      expect((await createDriveSourceAction(driveInput)).ok).toBe(true)
      expect(createChannel).toHaveBeenCalledTimes(1)
      expect(createChannel.mock.calls[0]![2]).toEqual({
        disclaimerVersion: V.connection,
      })
      expect(createSource).toHaveBeenCalledTimes(1)
      expect(createSource.mock.calls[0]![2]).toEqual({
        disclaimerVersion: V.connection,
      })
    })

    it("tạo MCP: từ chối khi chưa xác nhận (trước cả bước kiểm tra mật khẩu); xác nhận kết nối không thay được; xác nhận MCP xong thì tạo được", async () => {
      const u = w.users.admin // accepted "connection" above, not "mcp"
      asUser(u)
      const refused = await createMcpAction(mcpInput("m1"))
      expect(refused).toEqual({
        ok: false,
        error: t.errors.required.mcp,
        fieldErrors: undefined,
      })
      expect(reauthCalls.n).toBe(0)
      expect(
        await db.select().from(mcpServers).where(eq(mcpServers.ownerId, u.id))
      ).toHaveLength(0)

      expect(
        (await acceptDisclaimerAction({ kind: "mcp", version: V.mcp })).ok
      ).toBe(true)
      const done = await createMcpAction(mcpInput("m1"))
      expect(done.ok, JSON.stringify(done)).toBe(true)
      expect(reauthCalls.n).toBe(1)
      const id = (done as { data: { id: string } }).data.id
      const [log] = await db
        .select()
        .from(activityLogs)
        .where(
          and(
            eq(activityLogs.action, "mcp.create"),
            eq(activityLogs.targetId, id)
          )
        )
      expect(log!.metadata).toMatchObject({ disclaimerVersion: V.mcp })
    })

    it("xác nhận bị giới hạn tần suất theo người dùng", async () => {
      const u = w.users.staff
      asUser(u)
      for (let i = 0; i < 30; i++)
        expect(
          (await acceptDisclaimerAction({ kind: "mcp", version: V.mcp })).ok,
          `#${i + 1}`
        ).toBe(true)
      expect(
        await acceptDisclaimerAction({ kind: "mcp", version: V.mcp })
      ).toMatchObject({ ok: false, error: t.errors.throttled })
    })
  }
)
