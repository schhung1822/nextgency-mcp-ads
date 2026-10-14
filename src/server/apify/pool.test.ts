// Token pool: pure pick logic + rotation / run records against the test Postgres (skipped without DATABASE_URL).
// Apify is the in-memory fake (__fixtures__/apify-fetch.ts) - no network.
import { randomUUID } from "node:crypto"
import { eq, inArray } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { db } from "@/server/db/client"
import { apifyRuns, apifyTokens, mcpServers, user } from "@/server/db/schema"

import {
  createFakeApify,
  FAKE_BASE_URL,
  fakeToken,
  type FakeApify,
} from "./__fixtures__/apify-fetch"
import {
  apifyAccountKey,
  isCreditCacheStale,
  isGrantTokenUsable,
  loadRunForMcp,
  mcpApifySpendToday,
  minCreditFor,
  pickToken,
  recordRun,
  runTakenByOtherMcp,
  runWithRotation,
  startActorRunForMcp,
  updateRunStatus,
  usableAccounts,
  vnDayStart,
} from "./pool"
import { encryptApifyToken, loadGrantApifyTokens } from "./store"
import type { GrantApifyToken } from "./types"
import { startActorRun } from "./actors"
import { ApifyError } from "./errors"

const fresh = () => new Date().toISOString()

function gt(id: string, o: Partial<GrantApifyToken> = {}): GrantApifyToken {
  return {
    id,
    name: id,
    scope: "company",
    apifyUserId: null,
    status: "active",
    exhaustedUntil: null,
    usageUsd: null,
    limitUsd: null,
    cycleEndAt: null,
    lastCheckedAt: fresh(),
    ...o,
  }
}

describe("pickToken (thuần)", () => {
  it("gộp token cùng tài khoản Apify; token không biết tài khoản là nhóm riêng", () => {
    const groups = usableAccounts(
      [
        gt("a", { apifyUserId: "u1" }),
        gt("b", { apifyUserId: "u1" }),
        gt("c"),
        gt("d"),
      ],
      { minCreditUsd: 0.05 }
    )
    expect(groups.map((g) => g.key).sort()).toEqual(["t:c", "t:d", "u:u1"])
    expect(
      groups.find((g) => g.key === "u:u1")!.tokens.map((t) => t.id)
    ).toEqual(["a", "b"])
    expect(apifyAccountKey({ id: "x", apifyUserId: null })).toBe("t:x")
  })

  it("bỏ cả tài khoản khi một token của nó còn hạn 'hết credit'; hết hạn exhausted_until thì dùng lại", () => {
    const now = Date.parse("2026-10-14T00:00:00Z")
    const future = "2026-11-01T00:00:00.000Z"
    const past = "2026-10-01T00:00:00.000Z"
    const tokens = [
      gt("a", {
        apifyUserId: "u1",
        status: "exhausted",
        exhaustedUntil: future,
      }),
      gt("b", { apifyUserId: "u1" }),
      gt("c", { apifyUserId: "u2", status: "exhausted", exhaustedUntil: past }),
    ]
    const groups = usableAccounts(tokens, { minCreditUsd: 0.05, now })
    expect(groups.map((g) => g.key)).toEqual(["u:u2"])
    expect(isGrantTokenUsable(tokens[0]!, now)).toBe(false)
    expect(isGrantTokenUsable(tokens[2]!, now)).toBe(true)
  })

  it("bỏ tài khoản có credit còn (biết được) < min(trần lần chạy, $0.05); chọn ngẫu nhiên có trọng số theo credit còn", () => {
    expect(minCreditFor(1)).toBe(0.05)
    expect(minCreditFor(0.02)).toBe(0.02)
    const tokens = [
      gt("poor", { apifyUserId: "p", usageUsd: 4.98, limitUsd: 5 }),
      gt("small", { apifyUserId: "s", usageUsd: 4, limitUsd: 5 }), // $1 left
      gt("rich", { apifyUserId: "r", usageUsd: 0, limitUsd: 9 }), // $9 left
    ]
    expect(
      usableAccounts(tokens, { minCreditUsd: 0.05 }).map((g) => g.key)
    ).toEqual(["u:s", "u:r"])
    // weights 1 and 9 (total 10): a draw below 0.1 lands on "small", above on "rich"
    expect(
      pickToken(tokens, { minCreditUsd: 0.05, random: () => 0.05 })!.id
    ).toBe("small")
    expect(
      pickToken(tokens, { minCreditUsd: 0.05, random: () => 0.5 })!.id
    ).toBe("rich")
    expect(
      pickToken(tokens, {
        minCreditUsd: 0.05,
        excludeAccounts: new Set(["u:r", "u:s"]),
      })
    ).toBeNull()
    expect(
      pickToken(tokens, {
        minCreditUsd: 0.05,
        excludeTokens: new Set(["rich", "small"]),
      })
    ).toBeNull()
    expect(pickToken([], { minCreditUsd: 0.05 })).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------------------------

const HAS_DB = !!process.env.DATABASE_URL
const PREFIX = `t-apify-pool-${randomUUID().slice(0, 8)}`
const OWNER = `${PREFIX}-owner`
const ACTOR = "shopx~shopee-scraper"

describe.skipIf(!HAS_DB)("runWithRotation + apify_runs (DB)", () => {
  let fake: FakeApify
  let mcpId: string
  const tokenIds: string[] = []

  async function addToken(
    tag: string,
    o: {
      apifyUserId?: string | null
      usage?: number
      limit?: number
      checked?: Date | null
      status?: string
      exhaustedUntil?: Date | null
    } = {}
  ) {
    const id = randomUUID()
    const secret = fakeToken(tag)
    await db.insert(apifyTokens).values({
      id,
      scope: "personal",
      ownerId: OWNER,
      name: `${PREFIX} ${tag}`,
      credentialsEncrypted: encryptApifyToken(id, secret),
      credentialHint: secret.slice(-4),
      apifyUserId: o.apifyUserId === undefined ? `acc-${tag}` : o.apifyUserId,
      usageUsd: o.usage ?? 0,
      limitUsd: o.limit ?? 5,
      cycleEndAt: new Date("2026-11-01T00:00:00Z"),
      lastCheckedAt: o.checked === undefined ? new Date() : o.checked,
      status: o.status ?? "active",
      exhaustedUntil: o.exhaustedUntil ?? null,
    })
    tokenIds.push(id)
    return { id, secret }
  }

  const row = async (id: string) =>
    (await db.select().from(apifyTokens).where(eq(apifyTokens.id, id)))[0]!
  const grantOf = async (ids: string[]) =>
    (await loadGrantApifyTokens(OWNER)).filter((t) => ids.includes(t.id))
  const startWith = (
    tokens: GrantApifyToken[],
    extra: Partial<Parameters<typeof runWithRotation>[2]> = {}
  ) =>
    runWithRotation(
      tokens,
      (_p, ctx) =>
        startActorRun(
          ctx,
          ACTOR,
          { keyword: "x" },
          { timeoutSecs: 60, maxTotalChargeUsd: 1 }
        ),
      {
        runMaxUsd: 1,
        fetchImpl: fake.fetch,
        baseUrl: FAKE_BASE_URL,
        random: () => 0,
        ...extra,
      }
    )

  beforeAll(async () => {
    await db
      .insert(user)
      .values({
        id: OWNER,
        name: OWNER,
        email: `${OWNER}@test.local`,
        role: "staff",
        emailVerified: true,
      })
    mcpId = randomUUID()
    await db
      .insert(mcpServers)
      .values({
        id: mcpId,
        ownerId: OWNER,
        name: `${PREFIX} mcp`,
        keyHash: `h-${mcpId}`,
        keyPrefix: "amcp_x",
        keyEncrypted: "v1.x.y.z",
      })
  })

  afterAll(async () => {
    await db.delete(apifyRuns).where(eq(apifyRuns.mcpId, mcpId))
    if (tokenIds.length)
      await db.delete(apifyRuns).where(inArray(apifyRuns.tokenId, tokenIds))
    await db.delete(mcpServers).where(eq(mcpServers.ownerId, OWNER))
    await db.delete(apifyTokens).where(eq(apifyTokens.ownerId, OWNER))
    await db.delete(user).where(eq(user.id, OWNER))
  })

  beforeEach(() => {
    fake = createFakeApify()
    fake.actors.set(ACTOR, {
      id: "ACT1",
      username: "shopx",
      name: "shopee-scraper",
    })
  })

  it("token đầu hết credit → đánh dấu CẢ tài khoản (mọi token cùng apify_user_id) tới cuối chu kỳ, chuyển sang tài khoản khác; không bump updated_at", async () => {
    const a1 = await addToken("rotA1", { apifyUserId: "accRot" })
    const a2 = await addToken("rotA2", { apifyUserId: "accRot" })
    const b = await addToken("rotB", { apifyUserId: "accRotB", limit: 0.5 })
    // the DB cache still shows credit (fresh check), Apify's limits say it is gone: the refusal is confirmed
    for (const t of [a1, a2])
      fake.accounts.set(t.secret, {
        userId: "accRot",
        username: "a",
        usageUsd: 5,
        limitUsd: 5,
        cycleEndAt: "2026-11-01T00:00:00.000Z",
      })
    fake.accounts.set(b.secret, {
      userId: "accRotB",
      username: "b",
      usageUsd: 0,
      limitUsd: 0.5,
      cycleEndAt: "2026-11-02T00:00:00.000Z",
    })
    fake.force("POST /runs", {
      status: 402,
      body: { error: { type: "not-enough-usage-to-run-paid-actor" } },
    })
    const before = await row(a2.id)
    // weights: accRot $5, accRotB $0.5 → random 0 picks accRot first
    const res = await startWith(await grantOf([a1.id, a2.id, b.id]))
    expect(res.tokenId).toBe(b.id)
    expect(res.attempts).toBe(2)
    for (const id of [a1.id, a2.id]) {
      const r = await row(id)
      expect(r.status).toBe("exhausted")
      expect(r.exhaustedUntil?.toISOString()).toBe("2026-11-01T00:00:00.000Z")
      expect(r.statusMessage).toBeTruthy()
    }
    expect((await row(a2.id)).updatedAt.getTime()).toBe(
      before.updatedAt.getTime()
    )
    expect((await row(b.id)).lastUsedAt).not.toBeNull()
    // a fresh grant no longer offers the exhausted account
    const next = await grantOf([a1.id, a2.id, b.id])
    expect(
      usableAccounts(next, { minCreditUsd: 0.05 }).map((g) => g.key)
    ).toEqual(["u:accRotB"])
  })

  it("401 → token invalid (chỉ token đó); RAM/run đồng thời → bỏ qua tài khoản lần này, không đánh dấu", async () => {
    const bad = await addToken("rotBad", { apifyUserId: "accBad", limit: 50 })
    const busy = await addToken("rotBusy", {
      apifyUserId: "accBusy",
      limit: 10,
    })
    const good = await addToken("rotGood", { apifyUserId: "accGood", limit: 1 })
    // bad: not known to Apify at all → 401
    fake.accounts.set(busy.secret, {
      userId: "accBusy",
      username: "busy",
      usageUsd: 0,
      limitUsd: 10,
      cycleEndAt: "2026-11-01T00:00:00.000Z",
    })
    fake.accounts.set(good.secret, {
      userId: "accGood",
      username: "good",
      usageUsd: 0,
      limitUsd: 1,
      cycleEndAt: "2026-11-01T00:00:00.000Z",
    })
    fake.force("POST /runs", {
      status: 402,
      body: {
        error: {
          type: "actor-memory-limit-exceeded",
          message: "exceed the memory limit",
        },
      },
    })
    const res = await startWith(await grantOf([bad.id, busy.id, good.id]))
    expect(res.tokenId).toBe(good.id)
    expect(res.attempts).toBe(3)
    expect((await row(bad.id)).status).toBe("invalid")
    expect((await row(bad.id)).statusMessage).toContain("Thay token")
    expect((await row(busy.id)).status).toBe("active")
  })

  it("lỗi không thuộc nhóm xoay (input sai) → trả ngay, không thử token khác; hết token → no_token; mọi tài khoản bận → lỗi bận", async () => {
    const t1 = await addToken("rotIn1", { apifyUserId: "accIn1" })
    const t2 = await addToken("rotIn2", { apifyUserId: "accIn2" })
    for (const [t, u] of [
      [t1, "accIn1"],
      [t2, "accIn2"],
    ] as const)
      fake.accounts.set(t.secret, {
        userId: u,
        username: u,
        usageUsd: 0,
        limitUsd: 5,
        cycleEndAt: "2026-11-01T00:00:00.000Z",
      })
    fake.force("POST /runs", {
      status: 400,
      body: { error: { type: "invalid-input", message: "bad" } },
    })
    await expect(
      startWith(await grantOf([t1.id, t2.id]))
    ).rejects.toMatchObject({ code: "input_invalid" })
    expect(fake.callsTo("POST /runs")).toHaveLength(1)

    fake.force(
      "POST /runs",
      {
        status: 403,
        body: { error: { type: "concurrent-runs-limit-exceeded" } },
      },
      {
        status: 403,
        body: { error: { type: "concurrent-runs-limit-exceeded" } },
      }
    )
    await expect(
      startWith(await grantOf([t1.id, t2.id]))
    ).rejects.toMatchObject({ code: "account_busy" })

    await expect(startWith([])).rejects.toMatchObject({ code: "no_token" })
    const err = await startWith([]).catch((e: unknown) => e)
    expect((err as ApifyError).userMessageVi).toMatch(/Không còn token Apify/)
  })

  it("credit cache cũ (> 5 phút) → đọc lại /users/me/limits trước; hết credit thật → đánh dấu tài khoản, chọn tài khoản khác", async () => {
    const stale = await addToken("rotStale", {
      apifyUserId: "accStale",
      limit: 100,
      checked: new Date(Date.now() - 10 * 60_000),
    })
    const other = await addToken("rotOther", {
      apifyUserId: "accOther",
      limit: 1,
    })
    fake.accounts.set(stale.secret, {
      userId: "accStale",
      username: "s",
      usageUsd: 99.99,
      limitUsd: 100,
      cycleEndAt: "2026-11-03T00:00:00.000Z",
    })
    fake.accounts.set(other.secret, {
      userId: "accOther",
      username: "o",
      usageUsd: 0,
      limitUsd: 1,
      cycleEndAt: "2026-11-01T00:00:00.000Z",
    })
    const res = await startWith(await grantOf([stale.id, other.id]))
    expect(res.tokenId).toBe(other.id)
    expect(res.attempts).toBe(1)
    const r = await row(stale.id)
    expect(r.status).toBe("exhausted")
    expect(r.usageUsd).toBeCloseTo(99.99)
    expect(r.exhaustedUntil?.toISOString()).toBe("2026-11-03T00:00:00.000Z")
    expect(fake.callsTo("GET /users/me/limits")).toHaveLength(1)
  })

  it("startActorRunForMcp: validate (miễn phí) → start → ghi apify_runs với token ghim; loadRunForMcp chỉ thấy run của chính MCP", async () => {
    const t = await addToken("rotRec", { apifyUserId: "accRec" })
    fake.accounts.set(t.secret, {
      userId: "accRec",
      username: "r",
      usageUsd: 0,
      limitUsd: 5,
      cycleEndAt: "2026-11-01T00:00:00.000Z",
    })
    const r = await startActorRunForMcp({
      mcpId,
      tokens: await grantOf([t.id]),
      actorId: ACTOR,
      taskKey: "shopee_search",
      input: { keyword: "son" },
      run: { timeoutSecs: 120, maxTotalChargeUsd: 0.5, waitForFinishSecs: 10 },
      fetchImpl: fake.fetch,
      baseUrl: FAKE_BASE_URL,
    })
    expect(fake.callsTo("POST /validate-input")).toHaveLength(1)
    expect(r.record).toMatchObject({
      mcpId,
      tokenId: t.id,
      actorId: ACTOR,
      taskKey: "shopee_search",
      runId: r.run.id,
      status: "SUCCEEDED",
      maxChargeUsd: 0.5,
      usageUsd: 0.12,
    })
    expect(await loadRunForMcp(mcpId, r.run.id)).toMatchObject({
      id: r.record.id,
      tokenId: t.id,
    })
    expect(await loadRunForMcp(randomUUID(), r.run.id)).toBeNull()
    expect(await loadRunForMcp(mcpId, "bad id!")).toBeNull()
    await updateRunStatus(r.record.id, {
      status: "SUCCEEDED",
      itemCount: 3,
      usageUsd: 0.2,
    })
    expect(await loadRunForMcp(mcpId, r.run.id)).toMatchObject({
      itemCount: 3,
      usageUsd: 0.2,
    })
    // recording the same run again (recovered) is idempotent
    const again = await recordRun({
      mcpId,
      tokenId: t.id,
      actorId: ACTOR,
      taskKey: null,
      run: { ...r.run, usageTotalUsd: 0.3 },
      maxChargeUsd: 0.5,
    })
    expect(again.id).toBe(r.record.id)
  })

  it("client huỷ ngay sau khi start → run bị abort bằng token ghim và bản ghi cập nhật ABORTED", async () => {
    const t = await addToken("rotAbort", { apifyUserId: "accAbort" })
    fake.accounts.set(t.secret, {
      userId: "accAbort",
      username: "a",
      usageUsd: 0,
      limitUsd: 5,
      cycleEndAt: "2026-11-01T00:00:00.000Z",
    })
    const ac = new AbortController()
    const fetchImpl: typeof fake.fetch = async (url, init) => {
      const res = await fake.fetch(url, init)
      if (url.includes("/runs?")) ac.abort()
      return res
    }
    const r = await startActorRunForMcp({
      mcpId,
      tokens: await grantOf([t.id]),
      actorId: ACTOR,
      taskKey: null,
      input: { keyword: "x" },
      run: { timeoutSecs: 60, maxTotalChargeUsd: 1 },
      signal: ac.signal,
      fetchImpl,
      baseUrl: FAKE_BASE_URL,
    })
    expect(r.run.status).toBe("ABORTED")
    expect((await loadRunForMcp(mcpId, r.run.id))!.status).toBe("ABORTED")
    expect(fake.callsTo("POST /abort")[0]!.authorization).toBe(
      `Bearer ${t.secret}`
    )
  })

  it("mcpApifySpendToday: run xong tính chi phí thực, chưa xong tính trần; chỉ trong ngày giờ Việt Nam", async () => {
    const t = await addToken("rotSpend", { apifyUserId: "accSpend" })
    const spendMcp = randomUUID()
    await db
      .insert(mcpServers)
      .values({
        id: spendMcp,
        ownerId: OWNER,
        name: `${PREFIX} spend`,
        keyHash: `h-${spendMcp}`,
        keyPrefix: "amcp_x",
        keyEncrypted: "v1.x.y.z",
      })
    const now = new Date()
    await db.insert(apifyRuns).values([
      {
        mcpId: spendMcp,
        tokenId: t.id,
        actorId: ACTOR,
        runId: "s1",
        status: "SUCCEEDED",
        maxChargeUsd: 1,
        usageUsd: 0.25,
      },
      {
        mcpId: spendMcp,
        tokenId: t.id,
        actorId: ACTOR,
        runId: "s2",
        status: "RUNNING",
        maxChargeUsd: 2,
      },
      {
        mcpId: spendMcp,
        tokenId: t.id,
        actorId: ACTOR,
        runId: "s3",
        status: "FAILED",
        maxChargeUsd: 0.5,
      }, // cost never read → cap
      {
        mcpId: spendMcp,
        tokenId: t.id,
        actorId: ACTOR,
        runId: "s4",
        status: "SUCCEEDED",
        maxChargeUsd: 5,
        usageUsd: 4,
        createdAt: new Date(vnDayStart(now).getTime() - 60_000),
      },
    ])
    expect(await mcpApifySpendToday(spendMcp, now)).toBe(2.75)
    expect(await mcpApifySpendToday(randomUUID(), now)).toBe(0)
    // 23:30 VN on 14/10 = 16:30 UTC → the day starts at 17:00 UTC of the 13th
    expect(vnDayStart(new Date("2026-10-14T16:30:00Z")).toISOString()).toBe(
      "2026-10-13T17:00:00.000Z"
    )
    expect(vnDayStart(new Date("2026-10-14T17:30:00Z")).toISOString()).toBe(
      "2026-10-14T17:00:00.000Z"
    )
  })

  it("lỗi kiểu hết credit nhưng /limits cho thấy còn credit → KHÔNG đánh dấu tài khoản (chỉ bỏ qua lần này), chuyển tài khoản khác", async () => {
    const x = await addToken("rotUnconf", { apifyUserId: "accUnconf", limit: 50 })
    const y = await addToken("rotUnconfB", { apifyUserId: "accUnconfB", limit: 1 })
    fake.accounts.set(x.secret, { userId: "accUnconf", username: "x", usageUsd: 1, limitUsd: 50, cycleEndAt: "2026-11-01T00:00:00.000Z" })
    fake.accounts.set(y.secret, { userId: "accUnconfB", username: "y", usageUsd: 0, limitUsd: 1, cycleEndAt: "2026-11-01T00:00:00.000Z" })
    // an expensive Actor refused for THIS run (e.g. minimum charge above the remaining credit of the cycle)
    fake.force("POST /runs", { status: 402, body: { error: { type: "not-enough-usage-to-run-paid-actor" } } })
    const res = await startWith(await grantOf([x.id, y.id]))
    expect(res.tokenId).toBe(y.id)
    expect((await row(x.id)).status).toBe("active")
    expect((await row(x.id)).exhaustedUntil).toBeNull()
    // only that refusal everywhere → the refusal is reported (not "no token")
    fake.force("POST /runs", { status: 402, body: { error: { type: "not-enough-usage-to-run-paid-actor" } } }, { status: 402, body: { error: { type: "not-enough-usage-to-run-paid-actor" } } })
    await expect(startWith(await grantOf([x.id, y.id]))).rejects.toMatchObject({ code: "out_of_credit" })
    expect((await row(x.id)).status).toBe("active")
  })

  it("ghi trạng thái gắn với bản mã đã kiểm tra: token bị thay giữa chừng không bị đánh dấu invalid", async () => {
    const t = await addToken("rotSwap", { apifyUserId: "accSwap" })
    // unknown to Apify → 401 on the start; but the token is replaced while the POST is in flight
    const swapping: typeof fake.fetch = async (url, init) => {
      if (url.includes("/runs?")) {
        const { encryptApifyToken: enc } = await import("./store")
        await db.update(apifyTokens).set({ credentialsEncrypted: enc(t.id, fakeToken("rotSwapNew")) }).where(eq(apifyTokens.id, t.id))
      }
      return fake.fetch(url, init)
    }
    fake.actors.set(ACTOR, { id: "ACT1", username: "shopx", name: "shopee-scraper" })
    await expect(startWith(await grantOf([t.id]), { fetchImpl: swapping })).rejects.toMatchObject({ code: "no_token" })
    expect((await row(t.id)).status).toBe("active")
  })

  it("trần ngày: giữ chỗ nguyên tử - 5 lần gọi song song (trần $1, ngày $2.5) chỉ 2 lần chạy, 3 lần daily_budget_exceeded", async () => {
    const t = await addToken("rotDaily", { apifyUserId: "accDaily", limit: 100 })
    fake.accounts.set(t.secret, { userId: "accDaily", username: "d", usageUsd: 0, limitUsd: 100, cycleEndAt: "2026-11-01T00:00:00.000Z" })
    const dailyMcp = randomUUID()
    await db.insert(mcpServers).values({ id: dailyMcp, ownerId: OWNER, name: `${PREFIX} daily`, keyHash: `h-${dailyMcp}`, keyPrefix: "amcp_x", keyEncrypted: "v1.x.y.z" })
    const tokens = await grantOf([t.id])
    const calls = Array.from({ length: 5 }, (_, i) =>
      startActorRunForMcp({
        mcpId: dailyMcp,
        tokens,
        actorId: ACTOR,
        taskKey: "shopee_search",
        input: { keyword: `k${i}` },
        run: { timeoutSecs: 60, maxTotalChargeUsd: 1 },
        dailyMaxUsd: 2.5,
        fetchImpl: fake.fetch,
        baseUrl: FAKE_BASE_URL,
      })
    )
    const results = await Promise.allSettled(calls)
    const ok = results.filter((r) => r.status === "fulfilled")
    const refused = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[]
    expect(ok).toHaveLength(2)
    expect(refused).toHaveLength(3)
    for (const r of refused) {
      expect(r.reason).toBeInstanceOf(ApifyError)
      expect((r.reason as ApifyError).code).toBe("daily_budget_exceeded")
      expect((r.reason as ApifyError).userMessageVi).toMatch(/2\.5 USD/)
    }
    expect(fake.callsTo("POST /runs")).toHaveLength(2)
    // the reservations became the run records (real run ids, the token that ran)
    const rows = await db.select().from(apifyRuns).where(eq(apifyRuns.mcpId, dailyMcp))
    expect(rows).toHaveLength(2)
    for (const r of rows) {
      expect(r.runId.startsWith("pending:")).toBe(false)
      expect(r.tokenId).toBe(t.id)
      expect(r.status).toBe("RUNNING")
    }
    expect(await mcpApifySpendToday(dailyMcp)).toBe(2)
    // without dailyMaxUsd nothing is reserved / refused
    const free = await startActorRunForMcp({
      mcpId: dailyMcp,
      tokens,
      actorId: ACTOR,
      taskKey: null,
      input: { keyword: "free" },
      run: { timeoutSecs: 60, maxTotalChargeUsd: 1 },
      fetchImpl: fake.fetch,
      baseUrl: FAKE_BASE_URL,
    })
    expect(free.record.runId).toBe(free.run.id)
  })

  it("trần ngày: thất bại chắc chắn (input sai) → huỷ giữ chỗ; start_uncertain → GIỮ chỗ (vẫn tính trần, gắn token đã thử)", async () => {
    const t = await addToken("rotRes", { apifyUserId: "accRes", limit: 100 })
    fake.accounts.set(t.secret, { userId: "accRes", username: "r", usageUsd: 0, limitUsd: 100, cycleEndAt: "2026-11-01T00:00:00.000Z" })
    fake.actors.set(ACTOR, { id: "ACT1", username: "shopx", name: "shopee-scraper", required: ["keyword"] })
    const resMcp = randomUUID()
    await db.insert(mcpServers).values({ id: resMcp, ownerId: OWNER, name: `${PREFIX} res`, keyHash: `h-${resMcp}`, keyPrefix: "amcp_x", keyEncrypted: "v1.x.y.z" })
    const base = {
      mcpId: resMcp,
      tokens: await grantOf([t.id]),
      actorId: ACTOR,
      taskKey: null,
      run: { timeoutSecs: 60, maxTotalChargeUsd: 2 },
      dailyMaxUsd: 10,
      fetchImpl: fake.fetch,
      baseUrl: FAKE_BASE_URL,
    }
    await expect(startActorRunForMcp({ ...base, input: {} })).rejects.toMatchObject({ code: "input_invalid" })
    expect(await db.select().from(apifyRuns).where(eq(apifyRuns.mcpId, resMcp))).toHaveLength(0)
    expect(await mcpApifySpendToday(resMcp)).toBe(0)

    fake.force("POST /runs", { status: 504, body: {} })
    await expect(startActorRunForMcp({ ...base, input: { keyword: "x" } })).rejects.toMatchObject({ code: "start_uncertain" })
    const kept = await db.select().from(apifyRuns).where(eq(apifyRuns.mcpId, resMcp))
    expect(kept).toHaveLength(1)
    expect(kept[0]).toMatchObject({ status: "UNKNOWN", tokenId: t.id, maxChargeUsd: 2 })
    expect(kept[0]!.runId.startsWith("pending:")).toBe(true)
    expect(await mcpApifySpendToday(resMcp)).toBe(2)
    expect(await loadRunForMcp(resMcp, kept[0]!.runId)).toBeNull()

    // spend 2 (kept) + cap 9 > 10 → refused before any Apify call
    const before = fake.calls.length
    await expect(startActorRunForMcp({ ...base, input: { keyword: "y" }, run: { timeoutSecs: 60, maxTotalChargeUsd: 9 } })).rejects.toMatchObject({ code: "daily_budget_exceeded" })
    expect(fake.calls.length).toBe(before)
  })

  it("runTakenByOtherMcp: run đã thuộc MCP khác → true; của chính MCP / chưa có → false", async () => {
    const t = await addToken("rotTaken", { apifyUserId: "accTaken" })
    const other = randomUUID()
    await db.insert(mcpServers).values({ id: other, ownerId: OWNER, name: `${PREFIX} other`, keyHash: `h-${other}`, keyPrefix: "amcp_x", keyEncrypted: "v1.x.y.z" })
    await db.insert(apifyRuns).values({ mcpId: other, tokenId: t.id, actorId: ACTOR, runId: "takenRun1", status: "RUNNING", maxChargeUsd: 1 })
    expect(await runTakenByOtherMcp(mcpId, "takenRun1")).toBe(true)
    expect(await runTakenByOtherMcp(other, "takenRun1")).toBe(false)
    expect(await runTakenByOtherMcp(mcpId, "nobodyRun")).toBe(false)
  })

  it("token hết credit đã qua exhausted_until với số liệu cũ 5/5 (cache cũ) vẫn được chọn, đọc lại /limits rồi chạy, trở lại active", async () => {
    const t = await addToken("rotRevive", {
      apifyUserId: "accRevive",
      usage: 5,
      limit: 5,
      checked: new Date(Date.now() - 2 * 86_400_000),
      status: "exhausted",
      exhaustedUntil: new Date(Date.now() - 3600_000),
    })
    fake.accounts.set(t.secret, { userId: "accRevive", username: "r", usageUsd: 0, limitUsd: 5, cycleEndAt: "2026-12-01T00:00:00.000Z" })
    const grant = await grantOf([t.id])
    // stale cache: remaining counts as unknown, not "too low"
    expect(usableAccounts(grant, { minCreditUsd: 0.05 }).map((g) => g.remaining)).toEqual([null])
    expect(isCreditCacheStale(grant[0]!)).toBe(true)
    const res = await startWith(grant)
    expect(res.tokenId).toBe(t.id)
    expect(fake.callsTo("GET /users/me/limits")).toHaveLength(1)
    expect(await row(t.id)).toMatchObject({ status: "active", usageUsd: 0, exhaustedUntil: null })
    // a FRESH cache that says 5/5 still drops the account
    expect(usableAccounts([{ ...grant[0]!, status: "active", exhaustedUntil: null, usageUsd: 5, limitUsd: 5, lastCheckedAt: new Date().toISOString() }], { minCreditUsd: 0.05 })).toEqual([])
  })

  it("lỗi cuối: một tài khoản bận + một token invalid → báo lý do bận (không phải no_token)", async () => {
    const bad = await addToken("rotFinBad", { apifyUserId: "accFinBad", limit: 50 })
    const busy = await addToken("rotFinBusy", { apifyUserId: "accFinBusy", limit: 1 })
    fake.accounts.set(busy.secret, { userId: "accFinBusy", username: "busy", usageUsd: 0, limitUsd: 1, cycleEndAt: "2026-11-01T00:00:00.000Z" })
    fake.force("POST /runs", { status: 403, body: { error: { type: "apify-plan-required-to-use-paid-actor" } } })
    await expect(startWith(await grantOf([bad.id, busy.id]))).rejects.toMatchObject({ code: "paid_plan_required" })
    expect((await row(bad.id)).status).toBe("invalid")
  })

  it("trần ngày + client huỷ giữa POST: run tìm thấy bị abort và giữ chỗ hạ về chi phí thật; không có run → huỷ giữ chỗ", async () => {
    const t = await addToken("rotAbortRes", { apifyUserId: "accAbortRes", limit: 100 })
    fake.accounts.set(t.secret, { userId: "accAbortRes", username: "a", usageUsd: 0, limitUsd: 100, cycleEndAt: "2026-11-01T00:00:00.000Z" })
    fake.actors.set(ACTOR, { id: "ACT1", username: "shopx", name: "shopee-scraper" })
    const m = randomUUID()
    await db.insert(mcpServers).values({ id: m, ownerId: OWNER, name: `${PREFIX} abortres`, keyHash: `h-${m}`, keyPrefix: "amcp_x", keyEncrypted: "v1.x.y.z" })
    for (const create of [true, false]) {
      const ac = new AbortController()
      const f: typeof fake.fetch = async (url, init) => {
        if (url.includes("/runs?")) {
          if (create) await fake.fetch(url, { ...init, signal: undefined })
          ac.abort()
          await new Promise((r) => setTimeout(r, 5))
          throw new DOMException("aborted", "AbortError")
        }
        return fake.fetch(url, init)
      }
      await expect(
        startActorRunForMcp({
          mcpId: m,
          tokens: await grantOf([t.id]),
          actorId: ACTOR,
          taskKey: null,
          input: { keyword: `abort-${create}` },
          run: { timeoutSecs: 60, maxTotalChargeUsd: 3 },
          dailyMaxUsd: 10,
          signal: ac.signal,
          validate: false,
          fetchImpl: f,
          baseUrl: FAKE_BASE_URL,
        })
      ).rejects.toMatchObject({ code: "aborted" })
    }
    const rows = await db.select().from(apifyRuns).where(eq(apifyRuns.mcpId, m))
    // only the aborted run remains, recorded at its real cost (0 here), not the 3 USD reservation
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: "ABORTED", tokenId: t.id })
    expect(rows[0]!.runId.startsWith("pending:")).toBe(false)
    expect(await mcpApifySpendToday(m)).toBe(0)
  })

  it("một run chỉ có MỘT chủ trên mọi MCP: chỉ mục unique + recordRun claim nguyên tử", async () => {
    const t = await addToken("rotClaim", { apifyUserId: "accClaim" })
    const a = randomUUID()
    const b = randomUUID()
    await db.insert(mcpServers).values([
      { id: a, ownerId: OWNER, name: `${PREFIX} claimA`, keyHash: `h-${a}`, keyPrefix: "amcp_x", keyEncrypted: "v1.x.y.z" },
      { id: b, ownerId: OWNER, name: `${PREFIX} claimB`, keyHash: `h-${b}`, keyPrefix: "amcp_x", keyEncrypted: "v1.x.y.z" },
    ])
    const run = { id: `claim${a.slice(0, 8)}`, actId: "ACT1", status: "RUNNING", isTerminal: false, statusMessage: null, startedAt: new Date().toISOString(), finishedAt: null, defaultDatasetId: null, defaultKeyValueStoreId: null, usageTotalUsd: null, chargedEventCounts: null, options: { timeoutSecs: 60, memoryMbytes: 1024, maxTotalChargeUsd: 1 }, durationMillis: null, exitCode: null }
    const first = await recordRun({ mcpId: a, tokenId: t.id, actorId: ACTOR, taskKey: null, run, maxChargeUsd: 1 })
    // same MCP again: idempotent
    expect((await recordRun({ mcpId: a, tokenId: t.id, actorId: ACTOR, taskKey: null, run: { ...run, status: "SUCCEEDED" }, maxChargeUsd: 1 })).id).toBe(first.id)
    // another MCP: refused
    await expect(recordRun({ mcpId: b, tokenId: t.id, actorId: ACTOR, taskKey: null, run, maxChargeUsd: 1 })).rejects.toMatchObject({ code: "start_uncertain" })
    // the database itself refuses a second owner
    await expect(db.insert(apifyRuns).values({ mcpId: b, tokenId: t.id, actorId: ACTOR, runId: run.id, status: "RUNNING", maxChargeUsd: 1 })).rejects.toThrow()
    // reservations are exempt (unique placeholders)
    await db.insert(apifyRuns).values([
      { mcpId: a, tokenId: t.id, actorId: ACTOR, runId: `pending:${randomUUID()}`, status: "STARTING", maxChargeUsd: 1 },
      { mcpId: b, tokenId: t.id, actorId: ACTOR, runId: `pending:${randomUUID()}`, status: "STARTING", maxChargeUsd: 1 },
    ])
    expect((await db.select().from(apifyRuns).where(eq(apifyRuns.runId, run.id))).map((r) => r.mcpId)).toEqual([a])
  })
})
