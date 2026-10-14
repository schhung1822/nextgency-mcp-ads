import { beforeEach, describe, expect, it } from "vitest"

import {
  createFakeApify,
  FAKE_BASE_URL,
  fakeToken,
  type FakeApify,
} from "./__fixtures__/apify-fetch"
import {
  abortRun,
  clampMemoryMbytes,
  dangerousInputFields,
  getAccountInfo,
  getActor,
  getActorDefaultBuild,
  getDatasetItems,
  getLimits,
  getRun,
  getUserInfo,
  INPUT_UNCHECKABLE,
  listRecentRuns,
  remainingCreditUsd,
  runOf,
  searchStore,
  startActorRun,
  storeActorRefusals,
  usdParam,
  validateActorInput,
  type ApifyCallContext,
} from "./actors"
import type { FetchLike } from "./client"

const TOKEN = fakeToken("actors")
const OTHER = fakeToken("other")
const ACTOR = "shopx~shopee-scraper"

let fake: FakeApify
let ctx: ApifyCallContext

beforeEach(() => {
  fake = createFakeApify()
  fake.accounts.set(TOKEN, {
    userId: "u1",
    username: "team",
    planId: "STARTER",
    tier: "BRONZE",
    usageUsd: 3.5,
    limitUsd: 19,
    cycleEndAt: "2026-11-01T00:00:00.000Z",
  })
  fake.accounts.set(OTHER, {
    userId: "u2",
    username: "other",
    usageUsd: 0,
    limitUsd: 5,
    cycleEndAt: "2026-11-05T00:00:00.000Z",
  })
  fake.actors.set(ACTOR, {
    id: "ACT1",
    username: "shopx",
    name: "shopee-scraper",
    required: ["keyword"],
  })
  ctx = { token: TOKEN, fetchImpl: fake.fetch, baseUrl: FAKE_BASE_URL }
})

describe("tài khoản", () => {
  it("getUserInfo không bao giờ trả email / mật khẩu proxy; getLimits + getAccountInfo đọc credit + chu kỳ", async () => {
    const u = await getUserInfo(ctx)
    expect(u).toMatchObject({
      apifyUserId: "u1",
      username: "team",
      planId: "STARTER",
      planTier: "BRONZE",
      actorsEnabled: true,
    })
    const s = JSON.stringify(u)
    expect(s).not.toContain("owner@private.example")
    expect(s).not.toContain("proxy-secret-pw")
    const l = await getLimits(ctx)
    expect(l).toMatchObject({
      usageUsd: 3.5,
      limitUsd: 19,
      cycleEndAt: "2026-11-01T00:00:00.000Z",
    })
    expect(remainingCreditUsd(l)).toBe(15.5)
    expect(remainingCreditUsd({ usageUsd: null, limitUsd: 5 })).toBeNull()
    const a = await getAccountInfo(ctx)
    expect(a).toEqual({
      apifyUserId: "u1",
      username: "team",
      planId: "STARTER",
      planTier: "BRONZE",
      usageUsd: 3.5,
      limitUsd: 19,
      cycleEndAt: "2026-11-01T00:00:00.000Z",
      actorsEnabled: true,
    })
    expect(JSON.stringify(a)).not.toMatch(/private|proxy/)
  })

  it("token sai → ApifyError invalid_token (rotate invalid)", async () => {
    await expect(
      getUserInfo({ ...ctx, token: fakeToken("nope") })
    ).rejects.toMatchObject({ code: "invalid_token", rotate: "invalid" })
    await expect(getUserInfo({ ...ctx, token: null })).rejects.toMatchObject({
      code: "token_missing",
    })
  })
})

describe("Store / Actor / build", () => {
  it("searchStore ≤ 10 kết quả kèm input schema, làm sạch mô tả; Apify từ chối includeInputSchema → tìm lại không có nó", async () => {
    const r = await searchStore(
      { ...ctx, token: null },
      { search: "shopee", limit: 50 }
    )
    expect(fake.calls[0]!.query.get("limit")).toBe("10")
    expect(fake.calls[0]!.query.get("includeInputSchema")).toBe("true")
    expect(r.total).toBe(42)
    expect(r.items[0]).toMatchObject({
      actorId: ACTOR,
      successRate30Days: 0.9,
      inputFields: [
        { name: "url", type: "string", required: true },
        { name: "maxResults", type: "integer", required: false },
      ],
    })
    expect(r.items[0]!.description).not.toContain("\u202e")
    fake.force("GET /store", {
      status: 400,
      body: { error: { type: "invalid-parameter" } },
    })
    const r2 = await searchStore(ctx, { search: "shopee" })
    expect(r2.items[0]!.inputFields).toBeNull()
    expect(
      fake.callsTo("GET /store").at(-1)!.query.has("includeInputSchema")
    ).toBe(false)
  })

  it("getActor lấy bảng giá đang hiệu lực (không phải bản cũ / tương lai); getActorDefaultBuild cắt README, đọc field dataset", async () => {
    const a = await getActor(ctx, ACTOR)
    expect(a).toMatchObject({
      id: "ACT1",
      actorId: ACTOR,
      permissionLevel: "LIMITED_PERMISSIONS",
      isDeprecated: false,
    })
    expect(a.pricing).toMatchObject({
      pricingModel: "PAY_PER_EVENT",
      minimalMaxTotalChargeUsd: 0.5,
    })
    expect(a.pricing!.events[0]).toMatchObject({
      name: "result",
      priceUsd: 0.004,
      isPrimary: true,
    })
    expect(storeActorRefusals(a)).toEqual([])
    expect(
      storeActorRefusals({
        ...a,
        permissionLevel: "FULL_PERMISSIONS",
        isDeprecated: true,
        notice: "UNDER_MAINTENANCE",
        pricing: { ...a.pricing!, pricingModel: "FLAT_PRICE_PER_MONTH" },
        usesStandby: true,
      })
    ).toEqual([
      "full_permissions",
      "deprecated",
      "under_maintenance",
      "rental",
      "standby",
    ])
    const b = await getActorDefaultBuild(ctx, ACTOR)
    expect(b.inputProperties.map((p) => p.name)).toEqual(["url", "maxResults"])
    expect(b.inputProperties[0]!.required).toBe(true)
    expect(b.datasetFields).toEqual(["title", "price"])
    expect(b.readme!.length).toBeLessThanOrEqual(5_000)
    await expect(getActor(ctx, "nobody~nothing")).rejects.toMatchObject({
      code: "not_found",
    })
  })
})

describe("validate-input", () => {
  it("hợp lệ → xong; thiếu trường → input_invalid kèm giải thích của Apify (không xoay token)", async () => {
    await validateActorInput(ctx, ACTOR, { keyword: "son môi" })
    const e = await validateActorInput(ctx, ACTOR, {}).catch((x: unknown) => x)
    expect(e).toMatchObject({ code: "input_invalid", rotate: null })
    expect((e as { upstreamMessage: string }).upstreamMessage).toContain(
      "keyword"
    )
  })
})

describe("startActorRun", () => {
  it("gửi trần server-side: timeout ≤ 600, memory luỹ thừa 2 ≤ 4096, maxTotalChargeUsd 4 chữ số, waitForFinish ≤ 25", async () => {
    const run = await startActorRun(
      ctx,
      ACTOR,
      { keyword: "x" },
      {
        timeoutSecs: 9999,
        memoryMbytes: 6000,
        maxTotalChargeUsd: 1.23456,
        waitForFinishSecs: 60,
      }
    )
    const q = fake.callsTo("POST /runs")[0]!.query
    expect(q.get("timeout")).toBe("600")
    expect(q.get("memory")).toBe("4096")
    expect(q.get("maxTotalChargeUsd")).toBe("1.2346")
    expect(q.get("waitForFinish")).toBe("25")
    expect(q.has("maxItems")).toBe(false)
    expect(q.has("webhooks")).toBe(false)
    expect(run).toMatchObject({
      status: "SUCCEEDED",
      isTerminal: true,
      recovered: false,
      usageTotalUsd: 0.12,
    })
    expect(run.defaultDatasetId).toBe(`ds${run.id}`)
    expect(clampMemoryMbytes(1000)).toBe(512)
    expect(clampMemoryMbytes(50)).toBe(128)
    expect(usdParam(0.05)).toBe("0.0500")
    expect(() => usdParam(0)).toThrow()
  })

  it("lỗi không mơ hồ (input sai / Actor không tồn tại / hết credit) → ném ngay, không tra cứu, không thử lại", async () => {
    fake.force("POST /runs", {
      status: 402,
      body: { error: { type: "not-enough-usage-to-run-paid-actor" } },
    })
    await expect(
      startActorRun(
        ctx,
        ACTOR,
        { keyword: "x" },
        { timeoutSecs: 60, maxTotalChargeUsd: 1 }
      )
    ).rejects.toMatchObject({ code: "out_of_credit", rotate: "exhausted" })
    expect(fake.callsTo("POST /runs")).toHaveLength(1)
    expect(fake.callsTo("GET /actor-runs")).toHaveLength(0)
    await expect(
      startActorRun(
        ctx,
        "nobody~x",
        {},
        { timeoutSecs: 60, maxTotalChargeUsd: 1 }
      )
    ).rejects.toMatchObject({ code: "not_found" })
  })

  it("timeout sau khi run ĐÃ được tạo → tra run gần đây, khớp Actor + INPUT → nhận lại run (recovered), không tạo run thứ 2", async () => {
    fake.force("POST /runs", { status: 504, body: {}, afterCreate: true })
    const run = await startActorRun(
      ctx,
      ACTOR,
      { keyword: "x", n: 1 },
      { timeoutSecs: 60, maxTotalChargeUsd: 1, deadline: Date.now() + 40_000 }
    )
    expect(run.recovered).toBe(true)
    expect(fake.runs.size).toBe(1)
    expect(fake.callsTo("POST /runs")).toHaveLength(1)
    expect(fake.callsTo("GET /input")).toHaveLength(1)
  })

  it("KHÔNG BAO GIỜ gửi lại POST sau lỗi mơ hồ: run của người khác (khác INPUT) không bị nhận; không thấy run → start_uncertain", async () => {
    // somebody else's run (another MCP on the same token): same account, same Actor, just started
    await startActorRun(ctx, ACTOR, { keyword: "khác" }, { timeoutSecs: 60, maxTotalChargeUsd: 1 })
    // our POST fails without creating anything (network): their run is inspected, NOT adopted, no second POST
    fake.force("POST /runs", { network: true })
    await expect(
      startActorRun(ctx, ACTOR, { keyword: "của tôi" }, { timeoutSecs: 60, maxTotalChargeUsd: 1, waitForFinishSecs: 20, deadline: Date.now() + 40_000 })
    ).rejects.toMatchObject({ code: "start_uncertain", rotate: null, retryable: false })
    expect(fake.callsTo("POST /runs")).toHaveLength(2)
    expect(fake.callsTo("GET /input")).toHaveLength(1)
    expect(fake.runs.size).toBe(1)
  })

  it("timeout / 5xx / 201 không đọc được → tra cứu, nhận run cùng INPUT nếu có, nếu không start_uncertain; tuyệt đối 1 POST", async () => {
    // 5xx without a run
    fake.force("POST /runs", { status: 503, body: {} })
    await expect(startActorRun(ctx, ACTOR, { keyword: "a" }, { timeoutSecs: 60, maxTotalChargeUsd: 1 })).rejects.toMatchObject({ code: "start_uncertain", httpStatus: 503 })
    expect(fake.callsTo("POST /runs")).toHaveLength(1)
    // unreadable 201: the run exists → adopted
    fake.force("POST /runs", { status: 201, body: { data: { nope: true } }, afterCreate: true })
    const adopted = await startActorRun(ctx, ACTOR, { keyword: "b" }, { timeoutSecs: 60, maxTotalChargeUsd: 1 })
    expect(adopted.recovered).toBe(true)
    expect(fake.callsTo("POST /runs")).toHaveLength(2)
    // timeout: never retried
    const hang: FetchLike = (url, init) =>
      url.includes("/runs?")
        ? new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("t", "AbortError"))))
        : fake.fetch(url, init)
    let posts = 0
    const counting: FetchLike = (url, init) => {
      if (url.includes("/runs?")) posts++
      return hang(url, init)
    }
    await expect(
      startActorRun({ ...ctx, fetchImpl: counting, timeoutMs: 10 }, ACTOR, { keyword: "x" }, { timeoutSecs: 60, maxTotalChargeUsd: 1, waitForFinishSecs: 0, deadline: Date.now() + 60_000 })
    ).rejects.toMatchObject({ code: "start_uncertain" })
    expect(posts).toBe(1)
  })

  it("không nhận (cũng không abort) run đã thuộc MCP khác dù INPUT giống hệt (isRunTaken)", async () => {
    fake.force("POST /runs", { status: 504, body: {}, afterCreate: true })
    const checked: string[] = []
    await expect(
      startActorRun(ctx, ACTOR, { keyword: "giống" }, {
        timeoutSecs: 60,
        maxTotalChargeUsd: 1,
        isRunTaken: async (id) => {
          checked.push(id)
          return true
        },
      })
    ).rejects.toMatchObject({ code: "start_uncertain" })
    expect(checked).toHaveLength(1)
    expect(fake.callsTo("GET /input")).toHaveLength(0)
    // a failing guard is fail safe: uncertain, nothing adopted
    fake.force("POST /runs", { status: 504, body: {}, afterCreate: true })
    await expect(
      startActorRun(ctx, ACTOR, { keyword: "giống 2" }, {
        timeoutSecs: 60,
        maxTotalChargeUsd: 1,
        isRunTaken: async () => {
          throw new Error("db down")
        },
      })
    ).rejects.toMatchObject({ code: "start_uncertain" })
  })

  it("luôn gửi memory: bỏ trống → 1024 MB; giá trị lạ được kẹp về luỹ thừa 2 ≤ 4096", async () => {
    await startActorRun(ctx, ACTOR, { keyword: "x" }, { timeoutSecs: 60, maxTotalChargeUsd: 1 })
    await startActorRun(ctx, ACTOR, { keyword: "y" }, { timeoutSecs: 60, maxTotalChargeUsd: 1, memoryMbytes: 32768 })
    const posts = fake.callsTo("POST /runs")
    expect(posts[0]!.query.get("memory")).toBe("1024")
    expect(posts[1]!.query.get("memory")).toBe("4096")
  })

  it("caller huỷ trong lúc POST mà run đã được tạo → run bị abort (không tốn tiền vô ích)", async () => {
    const ac = new AbortController()
    const slow: FetchLike = async (url, init) => {
      if (url.includes("/runs?")) {
        const res = await fake.fetch(url, { ...init, signal: undefined })
        ac.abort()
        await new Promise((r) => setTimeout(r, 5))
        if (init.signal?.aborted)
          throw new DOMException("aborted", "AbortError")
        return res
      }
      return fake.fetch(url, init)
    }
    await expect(
      startActorRun(
        { ...ctx, fetchImpl: slow, signal: ac.signal },
        ACTOR,
        { keyword: "x" },
        { timeoutSecs: 60, maxTotalChargeUsd: 1 }
      )
    ).rejects.toMatchObject({
      code: "aborted",
    })
    const [run] = [...fake.runs.values()]
    expect(run!.status).toBe("ABORTED")
    expect(fake.callsTo("POST /abort")).toHaveLength(1)
  })
})

describe("run / dataset", () => {
  it("getRun long-poll ≤ 30 s, abortRun, listRecentRuns; run của tài khoản khác → not_found", async () => {
    const started = await startActorRun(
      ctx,
      ACTOR,
      { keyword: "x" },
      { timeoutSecs: 60, maxTotalChargeUsd: 1 }
    )
    expect(started.status).toBe("RUNNING")
    const got = await getRun(ctx, started.id, { waitForFinishSecs: 99 })
    expect(fake.callsTo("GET /run")[0]!.query.get("waitForFinish")).toBe("30")
    expect(got).toMatchObject({
      status: "SUCCEEDED",
      isTerminal: true,
      chargedEventCounts: { result: 3 },
    })
    expect((await listRecentRuns(ctx))[0]!.id).toBe(started.id)
    expect(fake.callsTo("GET /actor-runs")[0]!.query.get("desc")).toBe("true")
    await expect(
      getRun({ ...ctx, token: OTHER }, started.id)
    ).rejects.toMatchObject({ code: "not_found" })
    const second = await startActorRun(
      ctx,
      ACTOR,
      { keyword: "y" },
      { timeoutSecs: 60, maxTotalChargeUsd: 1 }
    )
    expect((await abortRun(ctx, second.id)).status).toBe("ABORTED")
  })

  it("getDatasetItems LUÔN gửi limit (≤ 100), clean, field hợp lệ; trả total từ X-Apify-Pagination-Total", async () => {
    const run = await startActorRun(
      ctx,
      ACTOR,
      { keyword: "x" },
      { timeoutSecs: 60, maxTotalChargeUsd: 1, waitForFinishSecs: 5 }
    )
    const page = await getDatasetItems(ctx, run.defaultDatasetId!, {
      limit: 500,
      offset: 1,
      fields: ["title", "bad field;", "price"],
    })
    const q = fake.callsTo("GET /items")[0]!.query
    expect(q.get("limit")).toBe("100")
    expect(q.get("offset")).toBe("1")
    expect(q.get("clean")).toBe("true")
    expect(q.get("format")).toBe("json")
    expect(q.get("fields")).toBe("title,price")
    expect(page).toMatchObject({ total: 3, offset: 1, limit: 100 })
    expect(page.items).toHaveLength(2)
    await expect(
      getDatasetItems({ ...ctx, token: OTHER }, run.defaultDatasetId!, {
        limit: 5,
      })
    ).rejects.toMatchObject({ code: "not_found" })
  })
})

describe("dangerousInputFields (Actor ngoài danh mục)", () => {
  it("chặn cookie / header / login / password / session / mã JS / webhook / connector / proxy riêng / giá trị giống token", () => {
    const bad = dangerousInputFields({
      startUrls: [{ url: "https://shopee.vn", headers: { Cookie: "a=b" } }],
      loginUsername: "x",
      password: "y",
      sessionId: "z",
      pageFunction: "async () => {}",
      preNavigationHooks: "[]",
      customJavascript: "x",
      evaluateExpression: "x",
      initScript: "x",
      webhooks: [],
      outputConnector: {},
      mcpConnectors: [],
      proxyConfiguration: { useApifyProxy: false, proxyUrls: ["http://u:p@x"] },
      proxy: "http://user:pass@1.2.3.4:8000",
      proxyServer: "10.0.0.1:3128",
      note: `use ${"apify_api_" + "Z".repeat(20)}`,
      chat: "123456789:" + "A".repeat(35),
      googleKey: "AIza" + "SyA1b2C3d4E5f6G7h8I9j0K_L-M3n4O5p6Q",
      apiKey: "k",
    })
    expect(bad).toEqual(
      expect.arrayContaining([
        "startUrls[0].headers",
        "loginUsername",
        "password",
        "sessionId",
        "pageFunction",
        "preNavigationHooks",
        "customJavascript",
        "evaluateExpression",
        "initScript",
        "webhooks",
        "outputConnector",
        "mcpConnectors",
        "proxyConfiguration.proxyUrls",
        "proxy",
        "proxyServer",
        "note",
        "chat",
        "googleKey",
        "apiKey",
      ])
    )
  })

  it("không chặn nhầm input bình thường (description, countryCode, proxy của Apify, URL tìm kiếm)", () => {
    expect(
      dangerousInputFields({
        startUrls: [{ url: "https://shopee.vn/search?keyword=son" }],
        maxItems: 20,
        includeDescription: true,
        countryCode: "vn",
        languageCode: "vi",
        proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ["BUYPROXIES94952"], apifyProxyCountry: "VN" },
        proxyCountry: "VN",
        language: "vi",
        includeReviews: true,
        transcript: true,
      })
    ).toEqual([])
  })

  it("fail-closed: input > 64 KB, sâu quá 8 cấp, quá 2.000 nút hoặc không tuần tự hoá được → từ chối", () => {
    expect(dangerousInputFields({ text: "x".repeat(70 * 1024) })).toEqual([INPUT_UNCHECKABLE])
    let deep: Record<string, unknown> = { leaf: 1 }
    for (let i = 0; i < 12; i++) deep = { a: deep }
    expect(dangerousInputFields(deep)).toContain(INPUT_UNCHECKABLE)
    expect(dangerousInputFields({ list: Array.from({ length: 2500 }, (_, i) => i) })).toContain(INPUT_UNCHECKABLE)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(dangerousInputFields(cyclic)).toEqual([INPUT_UNCHECKABLE])
    expect(dangerousInputFields({ big: 10n })).toEqual([INPUT_UNCHECKABLE])
  })
})

describe("làm sạch chuỗi từ Apify trước khi đưa cho AI", () => {
  const RLO = String.fromCharCode(0x202e)
  it("tên trường input / default / enum / field dataset / tên event / categories được làm sạch; slug / id lạ bị loại", async () => {
    const build = {
      data: {
        id: "build1",
        actorDefinition: {
          input: {
            type: "object",
            properties: {
              [`url${RLO}`]: { type: "string", default: `a${RLO}b`, enum: [`x${RLO}`, { [`k${RLO}`]: `v${RLO}` }] },
              [RLO]: { type: "string" },
            },
          },
          storages: { dataset: { views: { o: { transformation: { fields: [`title${RLO}`, RLO] } } } } },
        },
      },
    }
    const custom: FetchLike = async (url, init) =>
      url.includes("/builds/default")
        ? new Response(JSON.stringify(build), { status: 200 })
        : fake.fetch(url, init)
    const b = await getActorDefaultBuild({ ...ctx, fetchImpl: custom }, ACTOR)
    const s = JSON.stringify(b)
    expect(s).not.toContain(RLO)
    expect(b.inputProperties.map((p) => p.name)).toEqual(["url"])
    expect(b.inputProperties[0]!.default).toBe("ab")
    expect(b.inputProperties[0]!.enum).toEqual(["x", { k: "v" }])
    expect(b.datasetFields).toEqual(["title"])

    const run = runOf({ id: "run1", status: "RUNNING", actId: "bad id!", chargedEventCounts: { [`ev${RLO}`]: 2, [RLO]: 1 } })
    expect(run.actId).toBeNull()
    expect(run.chargedEventCounts).toEqual({ ev: 2 })

    const store: FetchLike = async (url, init) =>
      url.includes("/store?")
        ? new Response(
            JSON.stringify({
              data: {
                total: 2,
                items: [
                  { username: "ok-user", name: "ok.actor", categories: [`SHOP${RLO}`, 5] },
                  { username: "bad user", name: "x" },
                  { username: `evil${RLO}`, name: "x" },
                ],
              },
            }),
            { status: 200 }
          )
        : fake.fetch(url, init)
    const r = await searchStore({ ...ctx, fetchImpl: store }, { search: "x", includeInputSchema: false })
    expect(r.items.map((i) => i.actorId)).toEqual(["ok-user~ok.actor"])
    expect(r.items[0]!.categories).toEqual(["SHOP"])
  })
})

describe("lô sửa lỗi 2", () => {
  it("waitForFinish thu lại cho vừa deadline của caller", async () => {
    await startActorRun({ ...ctx, deadline: Date.now() + 20_000 }, ACTOR, { keyword: "x" }, { timeoutSecs: 60, maxTotalChargeUsd: 1, waitForFinishSecs: 25 })
    const wait = Number(fake.callsTo("POST /runs")[0]!.query.get("waitForFinish"))
    expect(wait).toBeGreaterThanOrEqual(4)
    expect(wait).toBeLessThanOrEqual(5)
    await startActorRun({ ...ctx, deadline: Date.now() + 5_000 }, ACTOR, { keyword: "y" }, { timeoutSecs: 60, maxTotalChargeUsd: 1, waitForFinishSecs: 25 })
    expect(fake.callsTo("POST /runs")[1]!.query.get("waitForFinish")).toBe("0")
  })

  it("client huỷ giữa POST: báo kết quả tra cứu qua onAbortRecovery (run đã abort / none)", async () => {
    const outcomes: unknown[] = []
    for (const create of [true, false]) {
      const ac = new AbortController()
      const f: FetchLike = async (url, init) => {
        if (url.includes("/runs?")) {
          const res = create ? await fake.fetch(url, { ...init, signal: undefined }) : null
          ac.abort()
          await new Promise((r) => setTimeout(r, 5))
          if (init.signal?.aborted) throw new DOMException("aborted", "AbortError")
          return res!
        }
        return fake.fetch(url, init)
      }
      await expect(
        startActorRun({ ...ctx, fetchImpl: f, signal: ac.signal }, ACTOR, { keyword: `c${create}` }, {
          timeoutSecs: 60,
          maxTotalChargeUsd: 1,
          onAbortRecovery: (o) => outcomes.push(o),
        })
      ).rejects.toMatchObject({ code: "aborted" })
    }
    expect((outcomes[0] as { status: string }).status).toBe("ABORTED")
    expect(outcomes[1]).toBe("none")
  })

  it("proxy: chặn nhóm RESIDENTIAL / SERP / tên nhóm lạ, cho phép nhóm datacenter", () => {
    expect(dangerousInputFields({ proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"] } })).toEqual(["proxyConfiguration.apifyProxyGroups"])
    expect(dangerousInputFields({ proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ["GOOGLE_SERP"] } })).toEqual(["proxyConfiguration.apifyProxyGroups"])
    expect(dangerousInputFields({ proxy: { proxyGroups: ["residential-vn"] } })).toEqual(["proxy.proxyGroups"])
    expect(dangerousInputFields({ proxyConfiguration: { apifyProxyGroups: ["a b"] } })).toEqual(["proxyConfiguration.apifyProxyGroups"])
    expect(dangerousInputFields({ proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ["BUYPROXIES94952", "StaticUS3"], apifyProxyCountry: "US" } })).toEqual([])
    expect(dangerousInputFields({ proxyConfiguration: { useApifyProxy: true, apifyProxySession: "abc" } })).toEqual(["proxyConfiguration.apifyProxySession"])
  })

  it("getDatasetItems: skipHidden / skipEmpty gửi riêng (không kèm clean); mặc định vẫn clean", async () => {
    const run = await startActorRun(ctx, ACTOR, { keyword: "x" }, { timeoutSecs: 60, maxTotalChargeUsd: 1, waitForFinishSecs: 5 })
    await getDatasetItems(ctx, run.defaultDatasetId!, { limit: 5, skipHidden: true })
    await getDatasetItems(ctx, run.defaultDatasetId!, { limit: 5 })
    await getDatasetItems(ctx, run.defaultDatasetId!, { limit: 5, skipHidden: true, skipEmpty: false, clean: true })
    const [a, b, c] = fake.callsTo("GET /items").map((x) => x.query)
    expect(a!.get("skipHidden")).toBe("true")
    expect(a!.has("clean")).toBe(false)
    expect(a!.has("skipEmpty")).toBe(false)
    expect(b!.get("clean")).toBe("true")
    expect(b!.has("skipHidden")).toBe(false)
    expect(c!.get("clean")).toBe("true")
    expect(c!.get("skipEmpty")).toBe("false")
  })
})
