// DEV ONLY - read-only live probe of the Meta Pages API for the open questions in
// .claude/docs/providers/meta.md §10.7 (Pages list, BM pages, page tokens, posts, Page/Post Insights).
//   ALLOW_DEV_PROBE=1 tsx --env-file=.env scripts/dev-probe-meta-pages.ts "<connection name>" [page_id] [--out report.json]
// Refuses to run unless ALLOW_DEV_PROBE=1, NODE_ENV is not production and DATABASE_URL points to a loopback host
// (it decrypts a stored token).
// Uses the stored credentials of one Meta connection (local DB). Only GET requests; nothing is written to Meta
// or to the DB. Every token / secret is scrubbed from the output; post text is cut to 80 characters.
import { createHmac } from "node:crypto"
import { writeFileSync } from "node:fs"
import { and, eq, isNull } from "drizzle-orm"
import { aad, decryptJson } from "@/server/crypto/secret-box"
import { db, pool } from "@/server/db/client"
import { connections } from "@/server/db/schema"
import { parseMetaCredentials } from "@/server/providers/meta/credentials"
import {
  metaApiVersion,
  type MetaCredentials,
} from "@/server/providers/meta/client"

type Json = Record<string, unknown>

interface CallResult {
  ok: boolean
  status: number
  body: Json | null
  error?: {
    code?: number
    subcode?: number
    type?: string
    message?: string
    userMsg?: string
  }
  usage?: Record<string, string>
}

const secrets = new Set<string>()
const scrub = (s: string) => {
  let out = s
  for (const v of secrets)
    if (v.length >= 8) out = out.split(v).join("[redacted]")
  return out.replace(/access_token=[^&"\s]+/g, "access_token=[redacted]")
}

const report: Json = {
  probedAt: new Date().toISOString(),
  apiVersion: metaApiVersion(),
}
const log = (section: string, data: unknown) => {
  report[section] = data
  console.log(`\n=== ${section} ===\n${scrub(JSON.stringify(data, null, 2))}`)
}

let appSecret: string | undefined

async function call(
  path: string,
  params: Json,
  token: string,
  opts: { proof?: "token" | "none" | string } = {}
): Promise<CallResult> {
  const url = new URL(
    `https://graph.facebook.com/${metaApiVersion()}/${path.replace(/^\/+/, "")}`
  )
  for (const [k, v] of Object.entries(params))
    url.searchParams.set(k, String(v))
  url.searchParams.set("access_token", token)
  const proofMode = opts.proof ?? "token"
  if (appSecret && proofMode !== "none") {
    const base = proofMode === "token" ? token : proofMode
    url.searchParams.set(
      "appsecret_proof",
      createHmac("sha256", appSecret).update(base).digest("hex")
    )
  }
  await new Promise((r) => setTimeout(r, 150))
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  const text = await res.text()
  let body: Json | null = null
  try {
    body = JSON.parse(text) as Json
  } catch {
    body = { raw: text.slice(0, 200) }
  }
  const usage: Record<string, string> = {}
  for (const h of [
    "x-business-use-case-usage",
    "x-app-usage",
    "x-page-usage",
    "x-fb-trace-id",
  ]) {
    const v = res.headers.get(h)
    if (v) usage[h] = v
  }
  const e = body?.error as Json | undefined
  return {
    ok: res.ok && !e,
    status: res.status,
    body,
    usage,
    error: e
      ? {
          code: e.code as number,
          subcode: e.error_subcode as number,
          type: e.type as string,
          message: e.message as string,
          userMsg: (e.error_user_msg as string) ?? undefined,
        }
      : undefined,
  }
}

const brief = (r: CallResult) =>
  r.ok ? { ok: true } : { ok: false, status: r.status, error: r.error }
const data = (r: CallResult) =>
  Array.isArray(r.body?.data) ? (r.body!.data as Json[]) : []
const cut = (s: unknown, n = 80) =>
  typeof s === "string" ? (s.length > n ? `${s.slice(0, n)}…` : s) : s

async function all(
  path: string,
  params: Json,
  token: string,
  max = 500
): Promise<{ rows: Json[]; error?: CallResult["error"]; pages: number }> {
  const rows: Json[] = []
  let after: string | undefined
  let pages = 0
  for (;;) {
    const r = await call(path, after ? { ...params, after } : params, token)
    pages++
    if (!r.ok) return { rows, error: r.error, pages }
    rows.push(...data(r))
    const paging = r.body?.paging as Json | undefined
    after = paging?.next
      ? ((paging.cursors as Json | undefined)?.after as string | undefined)
      : undefined
    if (!after || rows.length >= max) return { rows, pages }
  }
}

const PAGE_METRICS_LIVE = [
  "page_media_view",
  "page_total_media_view_unique",
  "page_post_engagements",
  "page_total_actions",
  "page_views_total",
  "page_follows",
  "page_daily_follows_unique",
  "page_daily_unfollows_unique",
  "page_actions_post_reactions_total",
  "page_video_views",
  "page_video_views_paid",
  "page_video_views_organic",
  "page_video_complete_views_30s",
  "page_video_view_time",
]
const PAGE_METRICS_DEAD = [
  "page_impressions",
  "page_impressions_paid",
  "page_impressions_unique",
  "page_fans",
  "page_fan_adds",
  "page_fan_removes",
  "page_posts_impressions",
  "page_video_views_unique",
  "page_engaged_users",
  "page_tab_views_login_top_unique",
]
const POST_METRICS_LIVE = [
  "post_media_view",
  "post_total_media_view_unique",
  "post_clicks",
  "post_clicks_by_type",
  "post_reactions_by_type_total",
  "post_activity_by_action_type",
  "post_video_views",
  "post_video_views_organic",
  "post_video_views_paid",
  "post_video_view_time",
  "post_video_avg_time_watched",
  "post_video_length",
  "post_video_complete_views_organic",
  "post_video_complete_views_paid",
]
const POST_METRICS_DEAD = [
  "post_impressions",
  "post_impressions_unique",
  "post_impressions_paid",
  "post_impressions_nonviral",
  "post_engaged_users",
  "post_video_views_unique",
]

const ymd = (d: Date) => d.toISOString().slice(0, 10)
const daysAgo = (n: number) => ymd(new Date(Date.now() - n * 86_400_000))

function assertDevOnly() {
  const host = (() => {
    try {
      return new URL(process.env.DATABASE_URL ?? "").hostname
    } catch {
      return ""
    }
  })()
  if (process.env.ALLOW_DEV_PROBE !== "1" || process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("dev-probe-meta-pages: chỉ chạy ở máy dev (ALLOW_DEV_PROBE=1, DATABASE_URL localhost, NODE_ENV khác production).")
  }
}

async function main() {
  assertDevOnly()
  const args = process.argv.slice(2)
  const outIdx = args.indexOf("--out")
  const positional = args.filter((a, i) => a !== "--out" && i !== outIdx + 1)
  const [connName, forcedPageId] = positional
  if (!connName)
    throw new Error(
      'Usage: tsx --env-file=.env scripts/dev-probe-meta-pages.ts "<connection name>" [page_id] [--out file]'
    )

  const rows = await db
    .select({
      id: connections.id,
      name: connections.name,
      platform: connections.platform,
      enc: connections.credentialsEncrypted,
    })
    .from(connections)
    .where(
      and(
        eq(connections.name, connName),
        eq(connections.platform, "meta"),
        isNull(connections.deletedAt)
      )
    )
  if (rows.length !== 1)
    throw new Error(
      `Expected exactly 1 Meta connection named "${connName}", found ${rows.length}`
    )
  const creds: MetaCredentials = parseMetaCredentials(
    decryptJson(rows[0].enc, aad.connectionCredentials(rows[0].id))
  )
  const userToken = creds.accessToken
  secrets.add(userToken)
  if (creds.appSecret) secrets.add(creds.appSecret)
  appSecret = creds.appSecret
  log("connection", {
    name: rows[0].name,
    hasAppId: !!creds.appId,
    hasAppSecret: !!creds.appSecret,
  })

  // 0. Token / permissions ---------------------------------------------------------------------------
  const me = await call("me", { fields: "id,name" }, userToken)
  const perms = await call("me/permissions", {}, userToken)
  const permList = data(perms).map((p) => `${p.permission}:${p.status}`)
  let debug: unknown = null
  if (creds.appId && creds.appSecret) {
    const d = await call(
      "debug_token",
      { input_token: userToken },
      `${creds.appId}|${creds.appSecret}`,
      { proof: "none" }
    )
    const dd = (d.body?.data ?? {}) as Json
    debug = d.ok
      ? {
          type: dd.type,
          expires_at: dd.expires_at,
          data_access_expires_at: dd.data_access_expires_at,
          granular_scopes: (dd.granular_scopes as Json[] | undefined)?.map(
            (g) => ({
              scope: g.scope,
              target_ids_count: Array.isArray(g.target_ids)
                ? g.target_ids.length
                : "all",
            })
          ),
        }
      : brief(d)
  }
  log("0_token", {
    me: me.ok ? { id: "[user]", name: "[via]" } : brief(me),
    permissions: permList,
    debug_token: debug,
  })

  // 1. /me/accounts ----------------------------------------------------------------------------------
  const PAGE_FIELDS =
    "id,name,category,tasks,followers_count,fan_count,verification_status,is_published"
  const acc = await all(
    "me/accounts",
    { fields: PAGE_FIELDS, limit: 100 },
    userToken
  )
  const limit101 = await call(
    "me/accounts",
    { fields: "id", limit: 101 },
    userToken
  )
  const mePages = acc.rows
  log("1_me_accounts", {
    error: acc.error,
    count: mePages.length,
    requests: acc.pages,
    limit_101: limit101.ok
      ? { ok: true, returned: data(limit101).length }
      : brief(limit101),
    pages: mePages.map((p) => ({
      id: p.id,
      name: p.name,
      category: p.category,
      tasks: p.tasks,
      followers: p.followers_count,
      fan_count: p.fan_count,
      verification: p.verification_status,
      published: p.is_published,
    })),
  })

  // 2. Business Manager pages -------------------------------------------------------------------------
  const biz = await all(
    "me/businesses",
    { fields: "id,name", limit: 100 },
    userToken
  )
  const meIds = new Set(mePages.map((p) => String(p.id)))
  const bmOnly: {
    id: string
    name: unknown
    business: unknown
    permitted_tasks?: unknown
  }[] = []
  const bizOut: unknown[] = []
  for (const b of biz.rows.slice(0, 10)) {
    const owned = await all(
      `${b.id}/owned_pages`,
      {
        fields: "id,name,category,followers_count",
        limit: 100,
        summary: "total_count",
      },
      userToken
    )
    const client = await all(
      `${b.id}/client_pages`,
      {
        fields: "id,name,category,followers_count,permitted_tasks",
        limit: 100,
        summary: "total_count",
      },
      userToken
    )
    for (const p of [...owned.rows, ...client.rows]) {
      if (
        !meIds.has(String(p.id)) &&
        !bmOnly.some((x) => x.id === String(p.id))
      ) {
        bmOnly.push({
          id: String(p.id),
          name: p.name,
          business: b.name,
          permitted_tasks: p.permitted_tasks,
        })
      }
    }
    bizOut.push({
      business: b.name,
      owned: owned.error
        ? { error: owned.error }
        : { count: owned.rows.length },
      client: client.error
        ? { error: client.error }
        : {
            count: client.rows.length,
            sample: client.rows.slice(0, 3).map((p) => ({
              name: p.name,
              permitted_tasks: p.permitted_tasks,
            })),
          },
    })
  }
  log("2_business_pages", {
    error: biz.error,
    businesses: biz.rows.length,
    perBusiness: bizOut,
    bmOnlyPages: bmOnly.length,
    bmOnlySample: bmOnly.slice(0, 10),
  })

  // 3. Page token for BM-only pages --------------------------------------------------------------------
  const bmTok: unknown[] = []
  for (const p of bmOnly.slice(0, 3)) {
    const r = await call(p.id, { fields: "access_token,tasks" }, userToken)
    bmTok.push({
      page: p.name,
      gotToken: r.ok && typeof r.body?.access_token === "string",
      tasks: r.body?.tasks ?? null,
      ...(r.ok ? {} : brief(r)),
    })
  }
  log("3_bm_only_page_token", bmTok)

  // 4. Pick a test page + page token -------------------------------------------------------------------
  const analyzable = mePages.filter(
    (p) => Array.isArray(p.tasks) && (p.tasks as string[]).includes("ANALYZE")
  )
  const chosen =
    (forcedPageId && mePages.find((p) => String(p.id) === forcedPageId)) ||
    analyzable.sort(
      (a, b) => Number(b.followers_count ?? 0) - Number(a.followers_count ?? 0)
    )[0] ||
    mePages[0]
  if (!chosen) {
    log("4_page_token", {
      error: "Không có Trang nào trong /me/accounts để test tiếp.",
    })
    return
  }
  const pageId = String(chosen.id)
  const tokRes = await call(pageId, { fields: "access_token" }, userToken)
  const pageToken =
    typeof tokRes.body?.access_token === "string"
      ? (tokRes.body.access_token as string)
      : null
  if (pageToken) secrets.add(pageToken)
  const pageDebug =
    pageToken && creds.appId && creds.appSecret
      ? await call(
          "debug_token",
          { input_token: pageToken },
          `${creds.appId}|${creds.appSecret}`,
          { proof: "none" }
        )
      : null
  log("4_page_token", {
    page: {
      id: pageId,
      name: chosen.name,
      tasks: chosen.tasks,
      followers: chosen.followers_count,
    },
    gotToken: !!pageToken,
    ...(tokRes.ok ? {} : brief(tokRes)),
    pageTokenDebug: pageDebug?.ok
      ? {
          type: (pageDebug.body?.data as Json)?.type,
          expires_at: (pageDebug.body?.data as Json)?.expires_at,
        }
      : pageDebug
        ? brief(pageDebug)
        : null,
  })
  if (!pageToken) return

  // 5. Posts -------------------------------------------------------------------------------------------
  const POST_FIELDS =
    "id,message,created_time,permalink_url,full_picture,status_type,is_published,is_hidden,promotable_id,shares,attachments{media_type,type},reactions.summary(true).limit(0),comments.summary(true).limit(0)"
  const mapPost = (p: Json) => ({
    id: p.id,
    created_time: p.created_time,
    message: cut(p.message),
    media_type:
      ((p.attachments as Json | undefined)?.data as Json[] | undefined)?.[0]
        ?.media_type ?? null,
    status_type: p.status_type,
    is_published: p.is_published,
    promotable_id: p.promotable_id,
    reactions:
      ((p.reactions as Json | undefined)?.summary as Json | undefined)
        ?.total_count ?? null,
    comments:
      ((p.comments as Json | undefined)?.summary as Json | undefined)
        ?.total_count ?? null,
    shares: (p.shares as Json | undefined)?.count ?? 0,
  })
  const since = daysAgo(30)
  const pub = await call(
    `${pageId}/published_posts`,
    { fields: POST_FIELDS, limit: 5 },
    pageToken
  )
  const pubSince = await call(
    `${pageId}/published_posts`,
    { fields: "id,created_time", limit: 25, since },
    pageToken
  )
  const pubLimit101 = await call(
    `${pageId}/published_posts`,
    { fields: "id", limit: 101 },
    pageToken
  )
  const pubWithUserToken = await call(
    `${pageId}/published_posts`,
    { fields: "id", limit: 1 },
    userToken
  )
  const feed = await call(
    `${pageId}/feed`,
    { fields: "id,created_time,from{id}", limit: 5 },
    pageToken
  )
  const postsEdge = await call(
    `${pageId}/posts`,
    { fields: "id,created_time", limit: 5, since },
    pageToken
  )
  const adsPosts = await call(
    `${pageId}/ads_posts`,
    { fields: "id,created_time,is_published,message", limit: 5 },
    pageToken
  )
  const adsPostsUser = await call(
    `${pageId}/ads_posts`,
    { fields: "id", limit: 1 },
    userToken
  )
  const scheduled = await call(
    `${pageId}/scheduled_posts`,
    { fields: "id,scheduled_publish_time", limit: 3 },
    pageToken
  )
  const sinceRows = data(pubSince)
  log("5_posts", {
    published_posts: pub.ok ? data(pub).map(mapPost) : brief(pub),
    published_posts_since: pubSince.ok
      ? {
          since,
          returned: sinceRows.length,
          allOnOrAfterSince: sinceRows.every(
            (p) => String(p.created_time) >= since
          ),
          oldest: sinceRows.at(-1)?.created_time ?? null,
        }
      : brief(pubSince),
    published_posts_limit_101: pubLimit101.ok
      ? { ok: true, returned: data(pubLimit101).length }
      : brief(pubLimit101),
    published_posts_with_user_token: brief(pubWithUserToken),
    feed: feed.ok
      ? {
          returned: data(feed).length,
          visitorPosts: data(feed).filter(
            (p) => (p.from as Json | undefined)?.id !== pageId
          ).length,
        }
      : brief(feed),
    posts_since: postsEdge.ok
      ? {
          returned: data(postsEdge).length,
          allOnOrAfterSince: data(postsEdge).every(
            (p) => String(p.created_time) >= since
          ),
        }
      : brief(postsEdge),
    ads_posts: adsPosts.ok
      ? data(adsPosts).map((p) => ({
          id: p.id,
          created_time: p.created_time,
          is_published: p.is_published,
          message: cut(p.message, 40),
        }))
      : brief(adsPosts),
    ads_posts_with_user_token: brief(adsPostsUser),
    scheduled_posts: scheduled.ok
      ? { returned: data(scheduled).length }
      : brief(scheduled),
    usageHeaders: pub.usage,
  })

  // 6. Page Insights -------------------------------------------------------------------------------------
  const iSince = daysAgo(8)
  const iUntil = daysAgo(1)
  const perMetric: Record<string, unknown> = {}
  for (const m of [...PAGE_METRICS_LIVE, ...PAGE_METRICS_DEAD]) {
    const r = await call(
      `${pageId}/insights`,
      { metric: m, period: "day", since: iSince, until: iUntil },
      pageToken
    )
    const values = ((data(r)[0]?.values as Json[] | undefined) ?? []).map(
      (v) => ({ end_time: v.end_time, value: v.value })
    )
    perMetric[m] = r.ok
      ? { ok: true, returnedSeries: data(r).length, values: values.slice(0, 3) }
      : brief(r)
  }
  const mixed = await call(
    `${pageId}/insights`,
    {
      metric: "page_media_view,page_impressions",
      period: "day",
      since: iSince,
      until: iUntil,
    },
    pageToken
  )
  const range90 = await call(
    `${pageId}/insights`,
    {
      metric: "page_media_view",
      period: "day",
      since: daysAgo(90),
      until: daysAgo(1),
    },
    pageToken
  )
  const range120 = await call(
    `${pageId}/insights`,
    {
      metric: "page_media_view",
      period: "day",
      since: daysAgo(120),
      until: daysAgo(1),
    },
    pageToken
  )
  const withUserToken = await call(
    `${pageId}/insights`,
    { metric: "page_media_view", period: "day", since: iSince, until: iUntil },
    userToken
  )
  const breakdown = await call(
    `${pageId}/insights`,
    {
      metric: "page_media_view",
      period: "day",
      since: iSince,
      until: iUntil,
      breakdown: "is_from_ads",
    },
    pageToken
  )
  log("6_page_insights", {
    range: { since: iSince, until: iUntil },
    perMetric,
    mixedLiveAndDead: mixed.ok
      ? { ok: true, series: data(mixed).map((s) => s.name) }
      : brief(mixed),
    range_89_days: range90.ok
      ? {
          ok: true,
          points: ((data(range90)[0]?.values as Json[] | undefined) ?? [])
            .length,
        }
      : brief(range90),
    range_119_days: range120.ok
      ? {
          ok: true,
          points: ((data(range120)[0]?.values as Json[] | undefined) ?? [])
            .length,
        }
      : brief(range120),
    with_user_token: brief(withUserToken),
    breakdown_is_from_ads: breakdown.ok
      ? {
          ok: true,
          sample: (
            (data(breakdown)[0]?.values as Json[] | undefined) ?? []
          ).slice(0, 2),
        }
      : brief(breakdown),
  })

  // 7. Post Insights -------------------------------------------------------------------------------------
  const firstPost = data(pub)[0]?.id as string | undefined
  if (firstPost) {
    const postMetric: Record<string, unknown> = {}
    for (const m of [...POST_METRICS_LIVE, ...POST_METRICS_DEAD]) {
      const r = await call(`${firstPost}/insights`, { metric: m }, pageToken)
      postMetric[m] = r.ok
        ? {
            ok: true,
            period: data(r)[0]?.period ?? null,
            value:
              ((data(r)[0]?.values as Json[] | undefined) ?? [])[0]?.value ??
              null,
          }
        : brief(r)
    }
    const batchIds = data(pub)
      .slice(0, 3)
      .map((p) => p.id)
      .join(",")
    const multi = await call(
      "insights",
      { ids: batchIds, metric: "post_media_view,post_clicks" },
      pageToken
    )
    const multiAlt = await call(
      "",
      { ids: batchIds, fields: "insights.metric(post_media_view,post_clicks)" },
      pageToken
    )
    log("7_post_insights", {
      post: firstPost,
      perMetric: postMetric,
      ids_insights_edge: multi.ok
        ? { ok: true, keys: Object.keys(multi.body ?? {}).length }
        : brief(multi),
      ids_fields_insights: multiAlt.ok
        ? { ok: true, keys: Object.keys(multiAlt.body ?? {}).length }
        : brief(multiAlt),
    })
  } else {
    log("7_post_insights", {
      skipped: "Trang không có bài published_posts để test.",
    })
  }

  // 8. appsecret_proof with page token -------------------------------------------------------------------
  if (appSecret) {
    const proofPage = await call(pageId, { fields: "id,name" }, pageToken, {
      proof: "token",
    })
    const proofUser = await call(pageId, { fields: "id,name" }, pageToken, {
      proof: userToken,
    })
    const proofNone = await call(pageId, { fields: "id,name" }, pageToken, {
      proof: "none",
    })
    log("8_appsecret_proof", {
      proofFromPageToken: brief(proofPage),
      proofFromUserToken: brief(proofUser),
      noProof: brief(proofNone),
    })
  } else {
    log("8_appsecret_proof", { skipped: "Kết nối không có App Secret." })
  }
}

main()
  .catch((e) => {
    console.error(
      scrub(e instanceof Error ? (e.stack ?? e.message) : String(e))
    )
    process.exitCode = 1
  })
  .finally(async () => {
    const outIdx = process.argv.indexOf("--out")
    if (outIdx >= 0 && process.argv[outIdx + 1])
      writeFileSync(
        process.argv[outIdx + 1],
        scrub(JSON.stringify(report, null, 2))
      )
    await pool().end()
  })
