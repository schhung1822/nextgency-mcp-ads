// In-memory fake of the Apify API v2 for tests (no network): users/me (+ limits), store, actors, builds,
// validate-input, runs (start / get / list / abort / INPUT record) and dataset items. Accounts are keyed by token;
// runs belong to the account that started them (another account's token gets 404, like Apify's "Restricted" access).
// Pass `fake.fetch` as `fetchImpl` (client.ts / actors.ts / pool.ts / health.ts) or stub the global fetch with it.
import type { FetchLike } from "../client"

export interface FakeAccount {
  userId: string
  username: string
  planId?: string
  tier?: string
  usageUsd: number
  limitUsd: number
  cycleEndAt: string
  actorsEnabled?: boolean
}

export interface FakeActor {
  id: string
  username: string
  name: string
  permissionLevel?: "LIMITED_PERMISSIONS" | "FULL_PERMISSIONS"
  isDeprecated?: boolean
  notice?: string
  pricingModel?: string
  /** input fields validate-input requires */
  required?: string[]
}

export interface FakeRun {
  id: string
  actId: string
  userId: string
  status: string
  input: unknown
  datasetId: string
  kvId: string
  startedAt: string
  finishedAt: string | null
  usageTotalUsd: number
  options: Record<string, unknown>
  statusMessage?: string
}

/** forced answer of one call; `afterCreate` (start run only): the run IS created, then this answer is given */
export type FakeOutcome =
  | {
      status: number
      body?: unknown
      headers?: Record<string, string>
      afterCreate?: boolean
    }
  | { network: true; afterCreate?: boolean }

export interface FakeCall {
  method: string
  /** route key, e.g. "POST /runs" */
  route: string
  path: string
  query: URLSearchParams
  authorization: string | null
  redirect: RequestRedirect | undefined
  body: unknown
}

const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
const apiError = (status: number, type: string, message = type) =>
  json({ error: { type, message } }, status)

export function createFakeApify() {
  const accounts = new Map<string, FakeAccount>()
  const actors = new Map<string, FakeActor>()
  const runs = new Map<string, FakeRun>()
  const datasets = new Map<string, unknown[]>()
  const calls: FakeCall[] = []
  const forced = new Map<string, FakeOutcome[]>()
  let runNo = 0
  // run ids unique across fake instances (apify_runs is unique per (mcp_id, run_id))
  const prefix = Math.random().toString(36).replace(/[^a-z0-9]/g, "").slice(0, 6)
  /** status of a new run when waitForFinish > 0 (default SUCCEEDED) / = 0 (default RUNNING) */
  const config = {
    finishedStatus: "SUCCEEDED",
    runningStatus: "RUNNING",
    runUsageUsd: 0.12,
    storeTotal: 42,
  }

  function route(method: string, path: string): string {
    const p = path.replace(/^\/v2\//, "")
    if (p === "users/me") return `${method} /users/me`
    if (p === "users/me/limits") return `${method} /users/me/limits`
    if (p === "store") return `${method} /store`
    if (/^actors\/[^/]+$/.test(p)) return `${method} /actor`
    if (/^actors\/[^/]+\/builds\/default$/.test(p)) return `${method} /build`
    if (/^actors\/[^/]+\/validate-input$/.test(p))
      return `${method} /validate-input`
    if (/^actors\/[^/]+\/runs$/.test(p)) return `${method} /runs`
    if (p === "actor-runs") return `${method} /actor-runs`
    if (/^actor-runs\/[^/]+$/.test(p)) return `${method} /run`
    if (/^actor-runs\/[^/]+\/abort$/.test(p)) return `${method} /abort`
    if (/^actor-runs\/[^/]+\/key-value-store\/records\/INPUT$/.test(p))
      return `${method} /input`
    if (/^datasets\/[^/]+\/items$/.test(p)) return `${method} /items`
    return `${method} ${p}`
  }

  function runJson(r: FakeRun) {
    return {
      id: r.id,
      actId: r.actId,
      userId: r.userId,
      status: r.status,
      statusMessage: r.statusMessage ?? null,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      defaultDatasetId: r.datasetId,
      defaultKeyValueStoreId: r.kvId,
      usageTotalUsd: r.usageTotalUsd,
      options: r.options,
      stats: { durationMillis: 1234 },
      chargedEventCounts: { result: 3 },
      exitCode: r.finishedAt ? 0 : null,
    }
  }

  function createRun(
    account: FakeAccount,
    actor: FakeActor,
    input: unknown,
    q: URLSearchParams
  ): FakeRun {
    runNo++
    const id = `run${prefix}${String(runNo).padStart(4, "0")}`
    const wait = Number(q.get("waitForFinish") ?? 0)
    const done = wait > 0
    const run: FakeRun = {
      id,
      actId: actor.id,
      userId: account.userId,
      status: done ? config.finishedStatus : config.runningStatus,
      input,
      datasetId: `ds${id}`,
      kvId: `kv${id}`,
      startedAt: new Date().toISOString(),
      finishedAt: done ? new Date().toISOString() : null,
      usageTotalUsd: done ? config.runUsageUsd : 0,
      options: {
        timeoutSecs: Number(q.get("timeout")),
        memoryMbytes: q.has("memory") ? Number(q.get("memory")) : 1024,
        maxTotalChargeUsd: Number(q.get("maxTotalChargeUsd")),
      },
    }
    runs.set(id, run)
    datasets.set(run.datasetId, [
      { title: "Sản phẩm A", price: 100 },
      { title: "Sản phẩm B", price: 200 },
      { title: "C", price: 300 },
    ])
    return run
  }

  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input)
    const method = init.method ?? "GET"
    const r = route(method, url.pathname)
    const headers = new Headers(init.headers as HeadersInit)
    const authorization = headers.get("authorization")
    let body: unknown
    try {
      body = typeof init.body === "string" ? JSON.parse(init.body) : undefined
    } catch {
      body = init.body
    }
    calls.push({
      method,
      route: r,
      path: url.pathname,
      query: url.searchParams,
      authorization,
      redirect: init.redirect,
      body,
    })
    if (init.signal?.aborted) throw new DOMException("aborted", "AbortError")

    const token = authorization?.startsWith("Bearer ")
      ? authorization.slice(7)
      : null
    const account = token ? accounts.get(token) : undefined
    const fail = (o: FakeOutcome): Response => {
      if ("network" in o)
        throw new TypeError(`fetch failed for ${url.toString()}`)
      return json(o.body ?? {}, o.status, o.headers)
    }
    // like Apify: unknown / missing tokens are refused BEFORE anything else (forced answers apply after auth)
    const publicRoute =
      r === "GET /store" || r === "GET /actor" || r === "GET /build"
    if (!publicRoute) {
      if (!token)
        return r === "POST /runs"
          ? apiError(402, "x402-payment-required")
          : apiError(401, "token-not-provided")
      if (!account)
        return apiError(
          401,
          "user-or-token-not-found",
          "User was not found or authentication token is not valid"
        )
    } else if (token && !account) {
      return apiError(401, "user-or-token-not-found")
    }
    const outcome = forced.get(r)?.shift()
    if (outcome && !outcome.afterCreate) return fail(outcome)
    const seg = url.pathname
      .replace(/^\/v2\//, "")
      .split("/")
      .map(decodeURIComponent)

    switch (r) {
      case "GET /users/me":
        return json({
          data: {
            id: account!.userId,
            username: account!.username,
            email: "owner@private.example",
            proxy: { password: "proxy-secret-pw", groups: [] },
            profile: { name: "Owner" },
            plan: {
              id: account!.planId ?? "FREE",
              tier: account!.tier ?? "FREE",
              monthlyUsageCreditsUsd: 5,
              maxConcurrentActorRuns: 25,
            },
            effectivePlatformFeatures: {
              ACTORS: {
                isEnabled: account!.actorsEnabled ?? true,
                disabledReason:
                  account!.actorsEnabled === false ? "Billing problem" : null,
              },
            },
            isPaying: false,
          },
        })
      case "GET /users/me/limits":
        return json({
          data: {
            monthlyUsageCycle: {
              startAt: "2026-10-01T00:00:00.000Z",
              endAt: account!.cycleEndAt,
            },
            limits: {
              maxMonthlyUsageUsd: account!.limitUsd,
              maxConcurrentActorJobs: 25,
              maxActorMemoryGbytes: 8,
            },
            current: {
              monthlyUsageUsd: account!.usageUsd,
              activeActorJobCount: 0,
              actorMemoryGbytes: 0,
            },
          },
        })
      case "GET /store": {
        if (
          url.searchParams.get("includeInputSchema") === "true" &&
          Number(url.searchParams.get("limit")) > 10
        )
          return apiError(
            400,
            "invalid-parameter",
            "Parameter 'limit' must be 10 or less when 'includeInputSchema' is true"
          )
        const items = [...actors.values()].map((a) => ({
          id: a.id,
          username: a.username,
          name: a.name,
          title: `Title ${a.name}`,
          description: "desc\u202eevil",
          notice: a.notice ?? "NONE",
          currentPricingInfo: {
            pricingModel: a.pricingModel ?? "PAY_PER_EVENT",
            minimalMaxTotalChargeUsd: 0.5,
          },
          stats: {
            totalUsers30Days: 10,
            publicActorRunStats30Days: { SUCCEEDED: 9, TOTAL: 10 },
          },
          ...(url.searchParams.get("includeInputSchema") === "true"
            ? {
                inputSchema: {
                  type: "object",
                  properties: {
                    url: { type: "string" },
                    maxResults: { type: "integer" },
                  },
                  required: ["url"],
                },
              }
            : {}),
        }))
        return json({
          data: {
            total: config.storeTotal,
            count: items.length,
            offset: 0,
            limit: 10,
            items,
          },
        })
      }
      case "GET /actor": {
        const a =
          actors.get(seg[1]!) ??
          [...actors.values()].find((x) => x.id === seg[1])
        if (!a)
          return apiError(
            404,
            "record-not-found",
            "Actor with this name was not found"
          )
        return json({
          data: {
            id: a.id,
            username: a.username,
            name: a.name,
            title: `Title ${a.name}`,
            isPublic: true,
            isDeprecated: a.isDeprecated ?? false,
            actorPermissionLevel: a.permissionLevel ?? "LIMITED_PERMISSIONS",
            notice: a.notice ?? "NONE",
            pricingInfos: [
              {
                pricingModel: "FLAT_PRICE_PER_MONTH",
                startedAt: "2024-01-01T00:00:00.000Z",
              },
              {
                pricingModel: a.pricingModel ?? "PAY_PER_EVENT",
                startedAt: "2026-01-01T00:00:00.000Z",
                minimalMaxTotalChargeUsd: 0.5,
                pricingPerEvent: {
                  actorChargeEvents: {
                    result: {
                      eventTitle: "Kết quả",
                      eventPriceUsd: 0.004,
                      isPrimaryEvent: true,
                    },
                  },
                },
              },
              { pricingModel: "FREE", startedAt: "2999-01-01T00:00:00.000Z" },
            ],
            defaultRunOptions: { timeoutSecs: 3600, memoryMbytes: 4096 },
            readmeSummary: "Summary",
            stats: { totalUsers30Days: 10 },
          },
        })
      }
      case "GET /build":
        return json({
          data: {
            id: "build1",
            readme: "# README\n" + "x".repeat(20_000),
            actorDefinition: {
              input: {
                type: "object",
                properties: {
                  url: { type: "string", title: "URL", description: "Link" },
                  maxResults: { type: "integer", default: 10 },
                },
                required: ["url"],
              },
              storages: {
                dataset: {
                  views: {
                    overview: {
                      transformation: { fields: ["title", "price"] },
                    },
                  },
                },
              },
              minMemoryMbytes: 256,
            },
          },
        })
      case "POST /validate-input": {
        const a = actors.get(seg[1]!)
        if (!a) return apiError(404, "record-not-found")
        const missing = (a.required ?? []).filter(
          (k) => !(body && typeof body === "object" && k in (body as object))
        )
        if (missing.length)
          return apiError(
            400,
            "invalid-input",
            `Input is not valid: Field input.${missing[0]} is required`
          )
        return json({ valid: true })
      }
      case "POST /runs": {
        const a = actors.get(seg[1]!)
        if (!a)
          return apiError(
            404,
            "record-not-found",
            "Actor with this name was not found"
          )
        const run = createRun(account!, a, body, url.searchParams)
        if (outcome) return fail(outcome)
        return json({ data: runJson(run) }, 201)
      }
      case "GET /actor-runs": {
        const after = url.searchParams.get("startedAfter")
        const list = [...runs.values()]
          .filter(
            (x) =>
              x.userId === account!.userId && (!after || x.startedAt >= after)
          )
          .sort(
            (a, b) =>
              b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id)
          )
          .slice(0, Number(url.searchParams.get("limit") ?? 1000))
        return json({
          data: {
            total: list.length,
            items: list.map((x) => ({
              id: x.id,
              actId: x.actId,
              status: x.status,
              startedAt: x.startedAt,
              finishedAt: x.finishedAt,
              defaultDatasetId: x.datasetId,
              usageTotalUsd: x.usageTotalUsd,
            })),
          },
        })
      }
      case "GET /run":
      case "POST /abort":
      case "GET /input": {
        const run = runs.get(seg[1]!)
        if (!run || run.userId !== account!.userId)
          return apiError(404, "record-not-found", "Actor run was not found")
        if (r === "GET /input") return json(run.input)
        if (r === "POST /abort" && !run.finishedAt) {
          run.status = "ABORTED"
          run.finishedAt = new Date().toISOString()
        }
        if (
          r === "GET /run" &&
          Number(url.searchParams.get("waitForFinish") ?? 0) > 0 &&
          !run.finishedAt
        ) {
          run.status = config.finishedStatus
          run.finishedAt = new Date().toISOString()
          run.usageTotalUsd = config.runUsageUsd
        }
        return json({ data: runJson(run) })
      }
      case "GET /items": {
        const ds = datasets.get(seg[1]!)
        const owner = [...runs.values()].find((x) => x.datasetId === seg[1])
        if (!ds || (owner && owner.userId !== account!.userId))
          return apiError(404, "record-not-found")
        const offset = Number(url.searchParams.get("offset") ?? 0)
        const limit = url.searchParams.has("limit")
          ? Number(url.searchParams.get("limit"))
          : ds.length
        return json(ds.slice(offset, offset + limit), 200, {
          "x-apify-pagination-total": String(ds.length),
        })
      }
      default:
        return apiError(404, "page-not-found")
    }
  }

  return {
    fetch,
    accounts,
    actors,
    runs,
    datasets,
    calls,
    config,
    /** queue forced answers for a route key ("POST /runs", "GET /users/me", …) */
    force(routeKey: string, ...outcomes: FakeOutcome[]) {
      forced.set(routeKey, [...(forced.get(routeKey) ?? []), ...outcomes])
    },
    callsTo(routeKey: string) {
      return calls.filter((c) => c.route === routeKey)
    },
    reset() {
      accounts.clear()
      actors.clear()
      runs.clear()
      datasets.clear()
      calls.length = 0
      forced.clear()
      runNo = 0
    },
  }
}

export type FakeApify = ReturnType<typeof createFakeApify>

/** a syntactically valid token (APIFY_TOKEN_RE) */
export function fakeToken(tag: string): string {
  return `apify_api_${tag.replace(/[^A-Za-z0-9]/g, "")}${"Q".repeat(Math.max(0, 24 - tag.length))}`
}

export const FAKE_BASE_URL = "https://apify.test"
