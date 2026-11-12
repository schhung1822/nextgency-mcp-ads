// DEV ONLY - read-only live probe for (1) saved Messenger greeting templates and (2) Facebook live video ads.
//   ALLOW_DEV_PROBE=1 tsx --env-file=.env scripts/dev-probe-meta-messaging-live.ts "<connection name>" \
//     [--page <page_id>] [--ad <ad_id>]... [--out report.json]
// Refuses to run unless ALLOW_DEV_PROBE=1, NODE_ENV is not production and DATABASE_URL points to a loopback host
// (it decrypts a stored token). Only GET requests: nothing is written to Meta or to the DB. Tokens / app secret are
// scrubbed from the output. Ad texts and greetings are printed in full (they are what we need to read).
//   --page: Page to probe (welcome_message_flows, live_videos); default = the Page of the first --ad, else the first
//           Page of /me/accounts.
//   --ad:   ads to dump in full (campaign → ad set → ad → creative), e.g. an ad that uses a saved greeting template
//           made in Ads Manager, or a live video ad made in Ads Manager.
import { createHmac } from "node:crypto"
import { writeFileSync } from "node:fs"
import { and, eq, isNull } from "drizzle-orm"
import { aad, decryptJson } from "@/server/crypto/secret-box"
import { db, pool } from "@/server/db/client"
import { connections } from "@/server/db/schema"
import { parseMetaCredentials } from "@/server/providers/meta/credentials"
import { metaApiVersion } from "@/server/providers/meta/client"

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
const log = (section: string, value: unknown) => {
  report[section] = value
  console.log(`\n=== ${section} ===\n${scrub(JSON.stringify(value, null, 2))}`)
}
let appSecret: string | undefined

async function call(
  path: string,
  params: Json,
  token: string,
  proof = true
): Promise<CallResult> {
  const url = new URL(
    `https://graph.facebook.com/${metaApiVersion()}/${path.replace(/^\/+/, "")}`
  )
  for (const [k, v] of Object.entries(params))
    url.searchParams.set(k, typeof v === "string" ? v : JSON.stringify(v))
  url.searchParams.set("access_token", token)
  if (appSecret && proof)
    url.searchParams.set(
      "appsecret_proof",
      createHmac("sha256", appSecret).update(token).digest("hex")
    )
  await new Promise((r) => setTimeout(r, 150))
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  const text = await res.text()
  let body: Json | null
  try {
    body = JSON.parse(text) as Json
  } catch {
    body = { raw: text.slice(0, 200) }
  }
  const e = body?.error as Json | undefined
  return {
    ok: res.ok && !e,
    status: res.status,
    body,
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
const rows = (r: CallResult) =>
  Array.isArray(r.body?.data) ? (r.body!.data as Json[]) : []
const out = (r: CallResult) => (r.ok ? r.body : brief(r))

/** Parse JSON-in-a-string fields (page_welcome_message, welcome_message) so the report shows their structure. */
function parsedGreeting(v: unknown): unknown {
  if (typeof v !== "string" || !v.trim().startsWith("{")) return v
  try {
    return { _raw_length: v.length, parsed: JSON.parse(v) }
  } catch {
    return v
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
  if (
    process.env.ALLOW_DEV_PROBE !== "1" ||
    process.env.NODE_ENV === "production" ||
    !["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)
  ) {
    throw new Error(
      "dev-probe-meta-messaging-live: chỉ chạy ở máy dev (ALLOW_DEV_PROBE=1, DATABASE_URL localhost, NODE_ENV khác production)."
    )
  }
}

const CAMPAIGN_FIELDS =
  "id,name,objective,status,effective_status,buying_type,special_ad_categories,smart_promotion_type,daily_budget,lifetime_budget,bid_strategy,is_budget_schedule_enabled,promoted_object"
const CAMPAIGN_FIELDS_MIN =
  "id,name,objective,status,effective_status,buying_type,special_ad_categories,smart_promotion_type,daily_budget,lifetime_budget,bid_strategy"
const ADSET_FIELDS =
  "id,name,status,effective_status,destination_type,optimization_goal,billing_event,bid_strategy,promoted_object,daily_budget,lifetime_budget,start_time,end_time,is_dynamic_creative,attribution_spec,targeting,dsa_beneficiary,dsa_payor"
const AD_FIELDS =
  "id,name,status,effective_status,account_id,adset_id,campaign_id,creative{id},tracking_specs,conversion_specs"
const CREATIVE_FIELDS =
  "id,name,status,object_type,object_story_id,effective_object_story_id,object_story_spec,asset_feed_spec,call_to_action,call_to_action_type,page_welcome_message,video_id,image_hash,instagram_user_id,source_instagram_media_id,url_tags,degrees_of_freedom_spec,platform_customizations,authorization_category,body,title,link_url,object_url,messenger_sponsored_message,contextual_multi_ads"

/** Read a node with the full field list; on a field error, fall back to a minimal list and report which failed. */
async function readWithFallback(
  id: string,
  fields: string,
  min: string,
  token: string
): Promise<unknown> {
  const full = await call(id, { fields }, token)
  if (full.ok) return full.body
  const fallback = await call(id, { fields: min }, token)
  return { full_fields_error: full.error, fallback: out(fallback) }
}

async function dumpAd(
  adId: string,
  token: string
): Promise<{ pageId: string | null; accountId: string | null }> {
  const ad = await call(adId, { fields: AD_FIELDS }, token)
  if (!ad.ok) {
    log(`ad_${adId}`, brief(ad))
    return { pageId: null, accountId: null }
  }
  const a = ad.body!
  const creativeId = (a.creative as Json | undefined)?.id as string | undefined
  // one field at a time when the whole list fails (Meta rejects some creative fields per creative type)
  let creative: Json | null = null
  let creativeErrors: Json | undefined
  if (creativeId) {
    const c = await call(creativeId, { fields: CREATIVE_FIELDS }, token)
    if (c.ok) creative = c.body
    else {
      creative = { id: creativeId }
      creativeErrors = { full_list: c.error }
      for (const f of CREATIVE_FIELDS.split(",").slice(1)) {
        const one = await call(creativeId, { fields: f }, token)
        if (one.ok) Object.assign(creative, one.body)
        else creativeErrors[f] = one.error?.message
      }
    }
    if (creative) {
      creative.page_welcome_message = parsedGreeting(
        creative.page_welcome_message
      )
      const spec = creative.object_story_spec as Json | undefined
      for (const k of ["link_data", "video_data"]) {
        const d = spec?.[k] as Json | undefined
        if (d?.page_welcome_message)
          d.page_welcome_message = parsedGreeting(d.page_welcome_message)
      }
      const add = (creative.asset_feed_spec as Json | undefined)
        ?.additional_data as Json | undefined
      if (add?.page_welcome_message)
        add.page_welcome_message = parsedGreeting(add.page_welcome_message)
    }
  }
  const campaign = a.campaign_id
    ? await readWithFallback(
        String(a.campaign_id),
        CAMPAIGN_FIELDS,
        CAMPAIGN_FIELDS_MIN,
        token
      )
    : null
  const adset = a.adset_id
    ? await call(String(a.adset_id), { fields: ADSET_FIELDS }, token)
    : null
  const campaignPromoted = a.campaign_id
    ? await call(String(a.campaign_id), { fields: "promoted_object" }, token)
    : null
  log(`ad_${adId}`, {
    campaign,
    campaign_promoted_object_alone: campaignPromoted
      ? out(campaignPromoted)
      : null,
    adset: adset ? out(adset) : null,
    ad: a,
    creative,
    ...(creativeErrors ? { creative_field_errors: creativeErrors } : {}),
  })
  const c = creative ?? {}
  const spec = c.object_story_spec as Json | undefined
  const story = (c.effective_object_story_id ?? c.object_story_id) as
    string | undefined
  const promotedPage = adset?.ok
    ? ((adset.body?.promoted_object as Json | undefined)?.page_id as
        string | undefined)
    : undefined
  const pageId =
    (spec?.page_id as string | undefined) ??
    (story?.includes("_") ? story.split("_")[0]! : undefined) ??
    promotedPage ??
    null
  return {
    pageId,
    accountId: typeof a.account_id === "string" ? a.account_id : null,
  }
}

async function main() {
  assertDevOnly()
  const args = process.argv.slice(2)
  const flag = (name: string) =>
    args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]!] : []))
  const connName = args.find(
    (a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--")
  )
  if (!connName) {
    throw new Error(
      'Usage: tsx --env-file=.env scripts/dev-probe-meta-messaging-live.ts "<connection>" [--page id] [--ad id]... [--out f]'
    )
  }
  const adIds = flag("--ad")
  let pageId: string | null = flag("--page")[0] ?? null

  const found = await db
    .select({
      id: connections.id,
      name: connections.name,
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
  if (found.length !== 1)
    throw new Error(
      `Expected exactly 1 Meta connection named "${connName}", found ${found.length}`
    )
  const creds = parseMetaCredentials(
    decryptJson(found[0]!.enc, aad.connectionCredentials(found[0]!.id))
  )
  const userToken = creds.accessToken
  secrets.add(userToken)
  if (creds.appSecret) secrets.add(creds.appSecret)
  appSecret = creds.appSecret

  // 0. token permissions ----------------------------------------------------------------------------------------------
  const perms = await call("me/permissions", {}, userToken)
  log(
    "0_permissions",
    perms.ok
      ? rows(perms).map((p) => `${p.permission}:${p.status}`)
      : brief(perms)
  )

  // 0b. --account act_X --campaign "<name contains>": find the ads of matching campaigns ------------------------------
  const account = flag("--account")[0]
  const campaignName = flag("--campaign")[0]
  if (account && campaignName) {
    const camps = await call(
      `${account}/campaigns`,
      {
        fields:
          "id,name,objective,effective_status,ads.limit(10){id,name,effective_status}",
        filtering: [
          { field: "name", operator: "CONTAIN", value: campaignName },
        ],
        limit: 10,
      },
      userToken
    )
    const found = rows(camps)
    log("0b_campaigns", camps.ok ? found : brief(camps))
    for (const c of found) {
      for (const a of rows({
        ok: true,
        status: 200,
        body: (c.ads as Json | undefined) ?? null,
      }))
        adIds.push(String(a.id))
    }
  }

  // 1. ads given on the command line (saved-template greeting ads, live video ads) ------------------------------------
  for (const id of adIds) {
    const r = await dumpAd(id, userToken)
    pageId ??= r.pageId
  }

  // 2. page + page token ----------------------------------------------------------------------------------------------
  if (!pageId) {
    const acc = await call(
      "me/accounts",
      { fields: "id,name", limit: 5 },
      userToken
    )
    pageId = (rows(acc)[0]?.id as string | undefined) ?? null
  }
  if (!pageId) {
    log("2_page", { error: "Không tìm thấy Trang nào để dò (truyền --page)." })
    return
  }
  const tok = await call(pageId, { fields: "id,name,access_token" }, userToken)
  const pageToken =
    typeof tok.body?.access_token === "string"
      ? (tok.body.access_token as string)
      : null
  if (pageToken) secrets.add(pageToken)
  log("2_page", {
    id: pageId,
    name: tok.body?.name,
    tasks: tok.body?.tasks,
    gotPageToken: !!pageToken,
    ...(tok.ok ? {} : brief(tok)),
  })

  // 3. saved greeting templates ---------------------------------------------------------------------------------------
  const FLOW_FIELDS =
    "id,name,welcome_message_flow,welcome_message,eligible_platforms,last_update_time,is_used_in_ad"
  const flowsOut: Json = {}
  for (const [label, token] of [
    ["page_token", pageToken],
    ["user_token", userToken],
  ] as const) {
    if (!token) continue
    const plain = await call(`${pageId}/welcome_message_flows`, {}, token)
    const withFields = await call(
      `${pageId}/welcome_message_flows`,
      { fields: FLOW_FIELDS },
      token
    )
    flowsOut[label] = {
      no_fields: plain.ok
        ? rows(plain).map((f) => ({
            ...f,
            welcome_message: parsedGreeting(f.welcome_message),
          }))
        : brief(plain),
      with_fields: withFields.ok
        ? rows(withFields).map((f) => ({
            ...f,
            welcome_message: parsedGreeting(f.welcome_message),
            welcome_message_flow: parsedGreeting(f.welcome_message_flow),
          }))
        : brief(withFields),
    }
  }
  log("3_welcome_message_flows", flowsOut)

  // 4. live videos of the page ----------------------------------------------------------------------------------------
  const LIVE_FIELDS =
    "id,title,description,status,broadcast_start_time,creation_time,planned_start_time,permalink_url,is_reference_only,video{id,permalink_url,length,post_id}"
  const LIVE_FIELDS_MIN =
    "id,title,status,creation_time,permalink_url,video{id}"
  const liveOut: Json = {}
  for (const [label, token] of [
    ["page_token", pageToken],
    ["user_token", userToken],
  ] as const) {
    if (!token) continue
    const full = await call(
      `${pageId}/live_videos`,
      { fields: LIVE_FIELDS, limit: 10 },
      token
    )
    const min = full.ok
      ? null
      : await call(
          `${pageId}/live_videos`,
          { fields: LIVE_FIELDS_MIN, limit: 10 },
          token
        )
    const filtered = await call(
      `${pageId}/live_videos`,
      {
        fields: "id,status,title",
        broadcast_status: [
          "LIVE",
          "SCHEDULED_UNPUBLISHED",
          "SCHEDULED_LIVE",
          "VOD",
        ],
        limit: 10,
      },
      token
    )
    liveOut[label] = {
      list: full.ok
        ? rows(full)
        : { full_error: full.error, min: min ? out(min) : null },
      broadcast_status_filter: filtered.ok ? rows(filtered) : brief(filtered),
    }
  }
  // the post behind the most recent live video: is it a normal page post usable as object_story_id?
  const firstLive = (
    (liveOut.page_token as Json | undefined)?.list as Json[] | undefined
  )?.[0]
  const liveVideoId = (firstLive?.video as Json | undefined)?.id as
    string | undefined
  if (liveVideoId && pageToken) {
    const v = await call(
      liveVideoId,
      {
        fields:
          "id,post_id,permalink_url,live_status,is_crossposting_eligible,status",
      },
      pageToken
    )
    liveOut.first_live_video_node = out(v)
  }
  log("4_live_videos", liveOut)
}

main()
  .catch((e) => {
    console.error(
      scrub(e instanceof Error ? (e.stack ?? e.message) : String(e))
    )
    process.exitCode = 1
  })
  .finally(async () => {
    const i = process.argv.indexOf("--out")
    if (i >= 0 && process.argv[i + 1])
      writeFileSync(
        process.argv[i + 1]!,
        scrub(JSON.stringify(report, null, 2))
      )
    await pool().end()
  })
