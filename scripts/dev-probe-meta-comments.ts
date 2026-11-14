// DEV ONLY - read-only live probe of Page post comments (Graph API) for the comments feature design.
//   ALLOW_DEV_PROBE=1 tsx --env-file=.env scripts/dev-probe-meta-comments.ts "<connection name>" <page_id> [post_id] [--out f]
// Refuses to run unless ALLOW_DEV_PROBE=1, NODE_ENV is not production and DATABASE_URL points to a loopback host.
// Only GET requests. Tokens are scrubbed; commenter names are masked (first letter + length), texts cut to 60 chars.
import { createHmac } from "node:crypto"
import { writeFileSync } from "node:fs"
import { and, eq, isNull } from "drizzle-orm"
import { aad, decryptJson } from "@/server/crypto/secret-box"
import { db, pool } from "@/server/db/client"
import { connections } from "@/server/db/schema"
import { metaApiVersion } from "@/server/providers/meta/client"
import { parseMetaCredentials } from "@/server/providers/meta/credentials"

type Json = Record<string, unknown>
const secrets = new Set<string>()
const scrub = (s: string) => {
  let out = s
  for (const v of secrets) if (v.length >= 8) out = out.split(v).join("[redacted]")
  return out.replace(/access_token=[^&"\s]+/g, "access_token=[redacted]")
}
const report: Json = { probedAt: new Date().toISOString(), apiVersion: metaApiVersion() }
const log = (k: string, v: unknown) => {
  report[k] = v
  console.log(`\n=== ${k} ===\n${scrub(JSON.stringify(v, null, 2))}`)
}
let appSecret: string | undefined

async function get(path: string, params: Json, token: string): Promise<{ ok: boolean; body: Json; error?: Json }> {
  const url = new URL(`https://graph.facebook.com/${metaApiVersion()}/${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
  url.searchParams.set("access_token", token)
  if (appSecret) url.searchParams.set("appsecret_proof", createHmac("sha256", appSecret).update(token).digest("hex"))
  await new Promise((r) => setTimeout(r, 150))
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  const body = (await res.json().catch(() => ({}))) as Json
  const e = body.error as Json | undefined
  return { ok: res.ok && !e, body, ...(e ? { error: { code: e.code, subcode: e.error_subcode, message: e.message } } : {}) }
}
const rows = (r: { body: Json }) => (Array.isArray(r.body.data) ? (r.body.data as Json[]) : [])
const mask = (s: unknown) => (typeof s === "string" && s ? `${s[0]}…(${s.length})` : s)
const cut = (s: unknown, n = 60) => (typeof s === "string" ? (s.length > n ? `${s.slice(0, n)}…` : s) : s)
/** a comment with PII masked: commenter name masked, id kept only as "present" */
function maskComment(c: Json): Json {
  const from = c.from as Json | undefined
  return {
    ...c,
    message: cut(c.message),
    from: from ? { id: from.id ? "<present>" : null, name: mask(from.name) } : "(absent)",
    ...(c.comments ? { comments: "(nested)" } : {}),
  }
}

function assertDevOnly() {
  const host = (() => {
    try {
      return new URL(process.env.DATABASE_URL ?? "").hostname
    } catch {
      return ""
    }
  })()
  if (process.env.ALLOW_DEV_PROBE !== "1" || process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("dev-probe-meta-comments: chỉ chạy ở máy dev (ALLOW_DEV_PROBE=1, DATABASE_URL localhost, NODE_ENV khác production).")
  }
}

async function main() {
  assertDevOnly()
  const args = process.argv.slice(2).filter((a, i, all) => a !== "--out" && all[i - 1] !== "--out")
  const [connName, pageId, forcedPost] = args
  if (!connName || !pageId) throw new Error('Usage: ... dev-probe-meta-comments.ts "<connection>" <page_id> [post_id]')
  const found = await db
    .select()
    .from(connections)
    .where(and(eq(connections.name, connName), eq(connections.platform, "meta"), isNull(connections.deletedAt)))
  if (found.length !== 1) throw new Error(`Expected 1 Meta connection named "${connName}", found ${found.length}`)
  const creds = parseMetaCredentials(decryptJson(found[0]!.credentialsEncrypted, aad.connectionCredentials(found[0]!.id)))
  const user = creds.accessToken
  secrets.add(user)
  if (creds.appSecret) secrets.add(creds.appSecret)
  appSecret = creds.appSecret
  const tok = await get(pageId, { fields: "access_token,name" }, user)
  const page = typeof tok.body.access_token === "string" ? (tok.body.access_token as string) : ""
  if (page) secrets.add(page)
  log("0_page", { name: tok.body.name, gotPageToken: !!page, error: tok.error })
  if (!page) return

  // 1. posts with the most comments (recent 50)
  const posts = await get(`${pageId}/published_posts`, { fields: "id,created_time,comments.summary(true).limit(0)", limit: 50 }, page)
  const ranked = rows(posts)
    .map((p) => ({ id: String(p.id), created: p.created_time, comments: ((p.comments as Json)?.summary as Json)?.total_count ?? 0 }))
    .sort((a, b) => Number(b.comments) - Number(a.comments))
  log("1_posts_by_comments", { error: posts.error, top: ranked.slice(0, 5) })
  const postId = forcedPost ?? ranked[0]?.id
  if (!postId) return

  // 2. comments edge: fields, filter, order, summary - page token vs user token
  const FIELDS =
    "id,message,created_time,from{id,name},like_count,comment_count,parent{id},attachment{type,url,media},is_hidden,can_hide,can_remove,can_reply_privately,message_tags,permalink_url,user_likes"
  const variants: [string, Json, string][] = [
    ["page_toplevel_desc", { fields: FIELDS, filter: "toplevel", order: "reverse_chronological", summary: "true", limit: 5 }, page],
    ["page_stream_chrono", { fields: FIELDS, filter: "stream", order: "chronological", summary: "true", limit: 5 }, page],
    ["user_token_toplevel", { fields: "id,message,from{id,name}", filter: "toplevel", limit: 3 }, user],
    ["page_minimal_fields", { fields: "id,message,created_time,like_count,comment_count", limit: 3 }, page],
  ]
  for (const [label, params, token] of variants) {
    const r = await get(`${postId}/comments`, params, token)
    log(`2_${label}`, r.ok ? { summary: r.body.summary, paging_keys: Object.keys((r.body.paging as Json) ?? {}), data: rows(r).map(maskComment) } : { error: r.error })
  }
  // field-by-field: which fields fail alone
  const perField: Json = {}
  for (const f of FIELDS.split(/,(?![^{]*\})/)) {
    const r = await get(`${postId}/comments`, { fields: `id,${f}`, limit: 1 }, page)
    perField[f] = r.ok ? "ok" : r.error
  }
  log("3_fields_one_by_one", perField)

  // 4. replies of the first comment that has replies
  const top = await get(`${postId}/comments`, { fields: "id,comment_count", filter: "toplevel", limit: 25 }, page)
  const withReplies = rows(top).find((c) => Number(c.comment_count) > 0)
  if (withReplies) {
    const rep = await get(`${String(withReplies.id)}/comments`, { fields: FIELDS, limit: 3 }, page)
    log("4_replies", rep.ok ? rows(rep).map(maskComment) : { error: rep.error })
    const single = await get(String(withReplies.id), { fields: "id,message,from{id,name},parent{id},created_time,comment_count" }, page)
    log("5_single_comment_node", single.ok ? maskComment(single.body) : { error: single.error })
  } else {
    log("4_replies", "no comment with replies in the first 25")
  }
  // 7. replies nested in one call + since filter
  const nested = await get(
    `${postId}/comments`,
    {
      fields: "id,message,comment_count,comments.order(chronological).limit(3){id,message,created_time,from{id,name},parent{id}}",
      filter: "toplevel",
      order: "reverse_chronological",
      limit: 3,
    },
    page
  )
  log(
    "7_nested_replies",
    nested.ok
      ? rows(nested).map((c) => ({
          ...maskComment(c),
          replies: rows({ body: (c.comments as Json) ?? {} }).map(maskComment),
        }))
      : { error: nested.error }
  )
  const sinceUnix = Math.floor(Date.parse("2026-08-09T00:00:00Z") / 1000)
  const since = await get(`${postId}/comments`, { fields: "id,created_time", filter: "toplevel", since: sinceUnix, limit: 10 }, page)
  log("8_since", since.ok ? rows(since).map((c) => c.created_time) : { error: since.error })

  // 6. comments of an ad (dark) post of the page
  const ads = await get(`${pageId}/ads_posts`, { fields: "id,comments.summary(true).limit(0)", limit: 25 }, page)
  const adPost = rows(ads).find((p) => Number(((p.comments as Json)?.summary as Json)?.total_count ?? 0) > 0)
  if (adPost) {
    const r = await get(`${String(adPost.id)}/comments`, { fields: FIELDS, filter: "toplevel", summary: "true", limit: 3 }, page)
    log("6_ad_post_comments", { post: adPost.id, ...(r.ok ? { summary: r.body.summary, data: rows(r).map(maskComment) } : { error: r.error }) })
  } else {
    log("6_ad_post_comments", { error: ads.error, note: "no ads_posts with comments in the first 25" })
  }
}

main()
  .catch((e) => {
    console.error(scrub(e instanceof Error ? (e.stack ?? e.message) : String(e)))
    process.exitCode = 1
  })
  .finally(async () => {
    const i = process.argv.indexOf("--out")
    if (i >= 0 && process.argv[i + 1]) writeFileSync(process.argv[i + 1]!, scrub(JSON.stringify(report, null, 2)))
    await pool().end()
  })
