// DEV ONLY - read-only live probe of Page Messenger conversations (Conversations API) for a design decision.
//   ALLOW_DEV_PROBE=1 tsx --env-file=.env scripts/dev-probe-meta-conversations.ts "<connection name>" <page_id>
// Refuses to run unless ALLOW_DEV_PROBE=1, NODE_ENV is not production and DATABASE_URL points to a loopback host.
// Only GET requests. Tokens scrubbed; names masked (first letter + length), message texts replaced by their length.
import { createHmac } from "node:crypto"
import { and, eq, isNull } from "drizzle-orm"
import { aad, decryptJson } from "@/server/crypto/secret-box"
import { db, pool } from "@/server/db/client"
import { connections } from "@/server/db/schema"
import { metaApiVersion } from "@/server/providers/meta/client"
import { parseMetaCredentials } from "@/server/providers/meta/credentials"

type Json = Record<string, unknown>
const host = (() => {
  try {
    return new URL(process.env.DATABASE_URL ?? "").hostname
  } catch {
    return ""
  }
})()
if (process.env.ALLOW_DEV_PROBE !== "1" || process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "::1"].includes(host)) {
  throw new Error("dev-probe-meta-conversations: chỉ chạy ở máy dev.")
}
const [connName, pageId] = process.argv.slice(2)
const secrets: string[] = []
const scrub = (s: string) => secrets.reduce((x, t) => (t.length >= 8 ? x.split(t).join("[redacted]") : x), s)
const mask = (s: unknown) => (typeof s === "string" && s ? `${s[0]}…(${s.length})` : s)
function maskDeep(v: unknown, key = ""): unknown {
  if (Array.isArray(v)) return v.map((x) => maskDeep(x, key))
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Json).map(([k, x]) => [k, maskDeep(x, k)]))
  if (typeof v === "string") {
    if (key === "message" || key === "snippet") return `<text ${v.length} chars>`
    if (key === "name" || key === "email") return mask(v)
  }
  return v
}
const found = await db.select().from(connections).where(and(eq(connections.name, connName!), eq(connections.platform, "meta"), isNull(connections.deletedAt)))
const creds = parseMetaCredentials(decryptJson(found[0]!.credentialsEncrypted, aad.connectionCredentials(found[0]!.id)))
secrets.push(creds.accessToken, ...(creds.appSecret ? [creds.appSecret] : []))
async function get(path: string, params: Json, token: string) {
  const u = new URL(`https://graph.facebook.com/${metaApiVersion()}/${path}`)
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v))
  u.searchParams.set("access_token", token)
  if (creds.appSecret) u.searchParams.set("appsecret_proof", createHmac("sha256", creds.appSecret).update(token).digest("hex"))
  const body = (await (await fetch(u)).json()) as Json
  return body
}
const show = (k: string, v: unknown) => console.log(`\n=== ${k} ===\n${scrub(JSON.stringify(maskDeep(v), null, 1)).slice(0, 2500)}`)
const perms = await get("me/permissions", {}, creds.accessToken)
show("permissions", ((perms.data as Json[]) ?? []).map((p) => `${p.permission}:${p.status}`))
const tok = await get(pageId!, { fields: "access_token,name" }, creds.accessToken)
const page = typeof tok.access_token === "string" ? tok.access_token : ""
if (page) secrets.push(page)
show("page", { name: tok.name, gotPageToken: !!page, error: tok.error })
if (page) {
  const conv = await get(
    `${pageId}/conversations`,
    { platform: "messenger", fields: "id,updated_time,message_count,unread_count,participants,link,snippet,can_reply,is_subscribed", limit: 5 },
    page
  )
  show("conversations", conv)
  const first = [...((conv.data as Json[]) ?? [])].sort((a, b) => Number(b.message_count) - Number(a.message_count))[0]
  if (first) {
    const msgs = await get(String(first.id), { fields: "messages.limit(5){id,created_time,from,to,message,attachments{mime_type,name,image_data,file_url},sticker,tags}" }, page)
    show("messages_of_first", msgs)
    const m1 = (((msgs.messages as Json)?.data as Json[]) ?? [])[0]
    if (m1) show("single_message", await get(String(m1.id), { fields: "id,created_time,from,to,message,reply_to" }, page))
    const deep = await get(String(first.id), { fields: "message_count,messages.limit(50){id,created_time}" }, page)
    const ids = (((deep.messages as Json)?.data as Json[]) ?? [])
    show("messages_50_ids", { message_count: deep.message_count, returned: ids.length, paging: Object.keys(((deep.messages as Json)?.paging as Json) ?? {}), next: !!((deep.messages as Json)?.paging as Json)?.next })
    const oldest = ids.at(-1)
    if (oldest) show("oldest_returned_detail", await get(String(oldest.id), { fields: "id,created_time,message" }, page))
  }
  show("conversations_user_token", await get(`${pageId}/conversations`, { platform: "messenger", fields: "id", limit: 1 }, creds.accessToken))
  show("instagram_conversations", await get(`${pageId}/conversations`, { platform: "instagram", fields: "id,updated_time", limit: 2 }, page))
}
await pool().end()
