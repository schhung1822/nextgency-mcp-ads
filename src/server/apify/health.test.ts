// Apify token store + health check against the test Postgres (skipped without DATABASE_URL). Fake Apify, no network.
// runApifyHealth checks EVERY live token of the database: tokens of other test files get a 503 (transient → untouched).
import { randomUUID } from "node:crypto"
import { eq, inArray } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { aad, decryptSecret } from "@/server/crypto/secret-box"
import { db } from "@/server/db/client"
import { apifyRuns, apifyTokens, mcpServers, user } from "@/server/db/schema"

import {
  createFakeApify,
  FAKE_BASE_URL,
  fakeToken,
  type FakeApify,
} from "./__fixtures__/apify-fetch"
import type { FetchLike } from "./client"
import { checkApifySecret, runApifyHealth, statusFromAccount } from "./health"
import {
  ApifyTokenUnreadableError,
  decryptApifyToken,
  encryptApifyToken,
  loadApifyToken,
  loadGrantApifyTokens,
  markApifyAccountExhausted,
  saveApifyTokenCheck,
} from "./store"

describe("statusFromAccount", () => {
  const base = {
    apifyUserId: "u",
    username: "x",
    planId: "FREE",
    planTier: "FREE",
    usageUsd: 1,
    limitUsd: 5,
    cycleEndAt: "2099-01-01T00:00:00.000Z",
    actorsEnabled: true,
  }
  it("còn credit → active; hết (< $0.05) → exhausted tới cuối chu kỳ; Actor bị tắt → error", () => {
    expect(statusFromAccount(base)).toEqual({
      status: "active",
      statusMessage: null,
      exhaustedUntil: null,
    })
    const ex = statusFromAccount({ ...base, usageUsd: 4.97 })
    expect(ex.status).toBe("exhausted")
    expect(ex.exhaustedUntil?.toISOString()).toBe("2099-01-01T00:00:00.000Z")
    const noCycle = statusFromAccount(
      { ...base, usageUsd: 5, cycleEndAt: null },
      Date.parse("2026-10-14T00:00:00Z")
    )
    expect(noCycle.exhaustedUntil?.toISOString()).toBe(
      "2026-10-15T00:00:00.000Z"
    )
    expect(statusFromAccount({ ...base, actorsEnabled: false }).status).toBe(
      "error"
    )
    expect(statusFromAccount({ ...base, usageUsd: null }).status).toBe("active")
  })
})

const HAS_DB = !!process.env.DATABASE_URL
const PREFIX = `t-apify-health-${randomUUID().slice(0, 8)}`
const A = `${PREFIX}-a`
const B = `${PREFIX}-b`

describe.skipIf(!HAS_DB)("store + runApifyHealth (DB)", () => {
  let fake: FakeApify
  let fetchImpl: FetchLike
  const ids: string[] = []

  async function add(
    owner: string,
    tag: string,
    o: Partial<typeof apifyTokens.$inferInsert> = {}
  ) {
    const id = randomUUID()
    const secret = fakeToken(tag)
    await db.insert(apifyTokens).values({
      id,
      scope: "personal",
      ownerId: owner,
      name: `${PREFIX} ${tag}`,
      credentialsEncrypted: encryptApifyToken(id, secret),
      credentialHint: secret.slice(-4),
      ...o,
    })
    ids.push(id)
    return { id, secret }
  }
  const row = async (id: string) =>
    (await db.select().from(apifyTokens).where(eq(apifyTokens.id, id)))[0]!

  beforeAll(async () => {
    await db
      .insert(user)
      .values(
        [A, B].map((id) => ({
          id,
          name: id,
          email: `${id}@test.local`,
          role: "staff",
          emailVerified: true,
        }))
      )
  })
  afterAll(async () => {
    if (ids.length)
      await db.delete(apifyRuns).where(inArray(apifyRuns.tokenId, ids))
    await db.delete(mcpServers).where(inArray(mcpServers.ownerId, [A, B]))
    await db.delete(apifyTokens).where(inArray(apifyTokens.ownerId, [A, B]))
    await db.delete(user).where(inArray(user.id, [A, B]))
  })
  beforeEach(() => {
    fake = createFakeApify()
    // only this file's tokens are known; any other token (another test file) gets a transient 503
    fetchImpl = (url, init) => {
      const auth =
        new Headers(init.headers as HeadersInit).get("authorization") ?? ""
      const mine = [...fake.accounts.keys()].some((t) => auth === `Bearer ${t}`)
      return mine
        ? fake.fetch(url, init)
        : Promise.resolve(new Response("{}", { status: 503 }))
    }
  })

  it('mã hoá token với AAD gắn id; dòng đã xoá ("") / sai AAD → ApifyTokenUnreadableError (không kèm nguyên nhân)', async () => {
    const { id, secret } = await add(A, "enc")
    const r = await row(id)
    expect(r.credentialsEncrypted).not.toContain(secret)
    expect(
      decryptSecret(r.credentialsEncrypted, aad.apifyTokenCredentials(id))
    ).toBe(secret)
    expect(decryptApifyToken(r)).toBe(secret)
    expect((await loadApifyToken(id))!.secret).toBe(secret)
    expect(() =>
      decryptApifyToken({
        id: randomUUID(),
        credentialsEncrypted: r.credentialsEncrypted,
      })
    ).toThrow(ApifyTokenUnreadableError)
    expect(() =>
      decryptApifyToken({ id, credentialsEncrypted: encryptApifyToken(id, "") })
    ).toThrow(ApifyTokenUnreadableError)
    expect(await loadApifyToken("not-a-uuid")).toBeNull()
  })

  it("loadGrantApifyTokens: token công ty + token cá nhân CỦA CHỦ MCP, còn sống, active/exhausted; không có bí mật", async () => {
    const company = await add(B, "grantCompany", { scope: "company" })
    const mine = await add(A, "grantMine")
    const theirs = await add(B, "grantTheirs")
    const exhausted = await add(A, "grantEx", {
      status: "exhausted",
      exhaustedUntil: new Date(Date.now() + 3600_000),
    })
    const invalid = await add(A, "grantInvalid", { status: "invalid" })
    const disabled = await add(A, "grantDisabled", { status: "disabled" })
    const deleted = await add(A, "grantDeleted", { deletedAt: new Date() })
    const grant = (await loadGrantApifyTokens(A))
      .filter((t) => ids.includes(t.id))
      .map((t) => t.id)
    expect(grant).toEqual(
      expect.arrayContaining([company.id, mine.id, exhausted.id])
    )
    for (const x of [theirs, invalid, disabled, deleted])
      expect(grant).not.toContain(x.id)
    expect(JSON.stringify(await loadGrantApifyTokens(A))).not.toMatch(
      /credentials|apify_api_/
    )
  })

  it("ghi trạng thái tự động không bump updated_at và không đụng token đã tắt / đã xoá; hết credit không biết tài khoản → chỉ token đó", async () => {
    const t = await add(A, "state")
    const off = await add(A, "stateOff", { status: "disabled" })
    const lone = await add(A, "stateLone", { apifyUserId: null })
    const before = await row(t.id)
    expect(
      await saveApifyTokenCheck(t.id, { status: "error", statusMessage: "x" })
    ).toBe(true)
    expect(
      await saveApifyTokenCheck(off.id, {
        status: "active",
        statusMessage: null,
      })
    ).toBe(false)
    expect((await row(off.id)).status).toBe("disabled")
    const after = await row(t.id)
    expect(after.status).toBe("error")
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime())
    expect(after.lastCheckedAt).not.toBeNull()
    const changed = await markApifyAccountExhausted(
      { id: lone.id, apifyUserId: null },
      new Date("2026-12-01T00:00:00Z"),
      "hết"
    )
    expect(changed).toEqual([lone.id])
  })

  it("runApifyHealth: cập nhật tài khoản / credit / trạng thái; 401 → invalid; lỗi tạm thời giữ nguyên; token tắt bỏ qua; dọn run > 90 ngày", async () => {
    const ok = await add(A, "hOk", {
      status: "exhausted",
      exhaustedUntil: new Date(Date.now() + 86_400_000),
    })
    const broke = await add(A, "hBroke")
    const bad = await add(A, "hBad")
    const flaky = await add(A, "hFlaky", {
      status: "active",
      statusMessage: null,
    })
    const off = await add(A, "hOff", { status: "disabled" })
    fake.accounts.set(ok.secret, {
      userId: "accH",
      username: "healthy",
      planId: "STARTER",
      tier: "BRONZE",
      usageUsd: 1,
      limitUsd: 19,
      cycleEndAt: "2026-11-01T00:00:00.000Z",
    })
    fake.accounts.set(broke.secret, {
      userId: "accBroke",
      username: "broke",
      usageUsd: 5,
      limitUsd: 5,
      cycleEndAt: "2026-11-02T00:00:00.000Z",
    })
    fake.accounts.set(off.secret, {
      userId: "accOff",
      username: "off",
      usageUsd: 0,
      limitUsd: 5,
      cycleEndAt: "2026-11-02T00:00:00.000Z",
    })
    // flaky: a known account, but users/me answers 503 three times (retried, then transient)
    fake.accounts.set(flaky.secret, {
      userId: "accFlaky",
      username: "flaky",
      usageUsd: 0,
      limitUsd: 5,
      cycleEndAt: "2026-11-02T00:00:00.000Z",
    })
    const flakyFetch: FetchLike = (url, init) => {
      const auth = new Headers(init.headers as HeadersInit).get("authorization")
      if (auth === `Bearer ${flaky.secret}`)
        return Promise.resolve(new Response("{}", { status: 503 }))
      if (auth === `Bearer ${bad.secret}`) return fake.fetch(url, init) // unknown → 401
      return fetchImpl(url, init)
    }
    const mcpId = randomUUID()
    await db
      .insert(mcpServers)
      .values({
        id: mcpId,
        ownerId: A,
        name: `${PREFIX} mcp`,
        keyHash: `h-${mcpId}`,
        keyPrefix: "amcp_x",
        keyEncrypted: "v1.x.y.z",
      })
    await db.insert(apifyRuns).values([
      {
        mcpId,
        tokenId: ok.id,
        actorId: "a~b",
        runId: "old1",
        status: "SUCCEEDED",
        maxChargeUsd: 1,
        createdAt: new Date(Date.now() - 91 * 86_400_000),
      },
      {
        mcpId,
        tokenId: ok.id,
        actorId: "a~b",
        runId: "new1",
        status: "SUCCEEDED",
        maxChargeUsd: 1,
      },
    ])
    const beforeOk = await row(ok.id)
    const summary = await runApifyHealth({
      fetchImpl: flakyFetch,
      baseUrl: FAKE_BASE_URL,
    })
    expect(summary.runsDeleted).toBeGreaterThanOrEqual(1)
    const rOk = await row(ok.id)
    expect(rOk).toMatchObject({
      status: "active",
      apifyUserId: "accH",
      apifyUsername: "healthy",
      planId: "STARTER",
      planTier: "BRONZE",
      usageUsd: 1,
      limitUsd: 19,
      exhaustedUntil: null,
      statusMessage: null,
    })
    expect(rOk.updatedAt.getTime()).toBe(beforeOk.updatedAt.getTime())
    expect(await row(broke.id)).toMatchObject({ status: "exhausted" })
    expect((await row(broke.id)).exhaustedUntil?.toISOString()).toBe(
      "2026-11-02T00:00:00.000Z"
    )
    expect((await row(bad.id)).status).toBe("invalid")
    expect(await row(flaky.id)).toMatchObject({
      status: "active",
      lastCheckedAt: null,
    })
    expect(await row(off.id)).toMatchObject({
      status: "disabled",
      apifyUsername: null,
    })
    const runs = await db
      .select()
      .from(apifyRuns)
      .where(eq(apifyRuns.mcpId, mcpId))
    expect(runs.map((r) => r.runId)).toEqual(["new1"])
  })

  it("checkApifySecret không ném lỗi: token sai → failed/invalid, Apify sập → transient", async () => {
    expect(
      await checkApifySecret(fakeToken("nobody"), {
        fetchImpl: fake.fetch,
        baseUrl: FAKE_BASE_URL,
      })
    ).toMatchObject({ kind: "failed", patch: { status: "invalid" } })
    const down: FetchLike = async () => new Response("{}", { status: 502 })
    expect(
      (
        await checkApifySecret(fakeToken("x"), {
          fetchImpl: down,
          baseUrl: FAKE_BASE_URL,
        })
      ).kind
    ).toBe("transient")
  })

  it("kiểm tra không ghi đè token bị tắt / bị thay trong lúc gọi Apify (gắn với bản mã đã kiểm tra)", async () => {
    const off = await add(A, "hRaceOff")
    const swap = await add(A, "hRaceSwap")
    fake.accounts.set(off.secret, { userId: "accRaceOff", username: "off", usageUsd: 0, limitUsd: 5, cycleEndAt: "2026-11-01T00:00:00.000Z" })
    fake.accounts.set(swap.secret, { userId: "accRaceSwap", username: "old-account", usageUsd: 0, limitUsd: 5, cycleEndAt: "2026-11-01T00:00:00.000Z" })
    const newCipher = encryptApifyToken(swap.id, fakeToken("hRaceSwapNew"))
    const racing: FetchLike = async (url, init) => {
      const auth = new Headers(init.headers as HeadersInit).get("authorization")
      if (url.endsWith("/users/me") && auth === `Bearer ${off.secret}`)
        await db.update(apifyTokens).set({ status: "disabled" }).where(eq(apifyTokens.id, off.id))
      if (url.endsWith("/users/me") && auth === `Bearer ${swap.secret}`)
        await db.update(apifyTokens).set({ credentialsEncrypted: newCipher }).where(eq(apifyTokens.id, swap.id))
      return fetchImpl(url, init)
    }
    await runApifyHealth({ fetchImpl: racing, baseUrl: FAKE_BASE_URL })
    expect(await row(off.id)).toMatchObject({ status: "disabled", apifyUsername: null })
    const s2 = await row(swap.id)
    expect(s2.credentialsEncrypted).toBe(newCipher)
    expect(s2.apifyUsername).toBeNull()
    // the store helpers refuse a stale ciphertext too
    expect(await saveApifyTokenCheck(swap.id, { status: "error", statusMessage: "x", ciphertext: "v1.stale" })).toBe(false)
    expect(await markApifyAccountExhausted({ id: swap.id, apifyUserId: null, ciphertext: "v1.stale" }, new Date(), "x")).toEqual([])
  })

  it("đánh dấu hết credit chỉ chạm token active/exhausted cùng tài khoản (không ghi đè invalid / error / disabled)", async () => {
    const act = await add(A, "exAct", { apifyUserId: "accEx2" })
    const inv = await add(A, "exInv", { apifyUserId: "accEx2", status: "invalid", statusMessage: "401" })
    const err = await add(A, "exErr", { apifyUserId: "accEx2", status: "error", statusMessage: "x" })
    const off = await add(A, "exOff", { apifyUserId: "accEx2", status: "disabled" })
    const changed = await markApifyAccountExhausted({ id: act.id, apifyUserId: "accEx2" }, new Date("2026-12-01T00:00:00Z"), "hết")
    expect(changed).toEqual([act.id])
    expect((await row(inv.id)).status).toBe("invalid")
    expect((await row(err.id)).status).toBe("error")
    expect((await row(off.id)).status).toBe("disabled")
  })
})
