// Log page query (URL search params ⇄ typed filters). Pure + client-safe: used by the /logs page,
// its client components, the log server actions and the CSV export route.
import { RELEASED_PLATFORMS } from "@/lib/platforms"
import { z } from "zod"

export const LOG_TABS = ["mcp", "staff"] as const
export type LogTab = (typeof LOG_TABS)[number]

export const LOG_PLATFORMS = RELEASED_PLATFORMS
export const MCP_LOG_STATUSES = [
  "success",
  "error",
  "denied",
  "rate_limited",
  "pending_confirmation",
  "invalid_request",
] as const
export type McpLogStatus = (typeof MCP_LOG_STATUSES)[number]
export const ACTIVITY_STATUSES = ["success", "failure"] as const
/** action prefixes (activity_logs.action = "<group>.<…>") */
export const ACTIVITY_GROUPS = ["auth", "setup", "user", "connection", "mcp", "settings", "logs", "system"] as const
export type ActivityGroup = (typeof ACTIVITY_GROUPS)[number]

export const LOG_PAGE_SIZE = 50
export const LOG_EXPORT_MAX_ROWS = 100_000
/** longest custom range accepted (keeps partition pruning meaningful) */
export const LOG_MAX_RANGE_DAYS = 400
export const LOG_DEFAULT_HOURS = 24
export const LOG_TIMEZONE = "Asia/Ho_Chi_Minh"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
/** user ids (Better Auth: random strings), external ad account ids, tool names */
const TOKEN_RE = /^[\w.:\-/@]{1,128}$/

export interface LogDateRange {
  /** inclusive YYYY-MM-DD in LOG_TIMEZONE */
  from: string
  /** inclusive YYYY-MM-DD in LOG_TIMEZONE */
  to: string
}

/** Everything the /logs URL can carry. Lists are already validated/deduplicated. */
export interface LogQuery {
  tab: LogTab
  /** null = default "last 24 hours" */
  range: LogDateRange | null
  q: string
  // MCP tab
  mcp: string[]
  owner: string[]
  platform: string[]
  account: string[]
  tool: string[]
  status: string[]
  writes: boolean
  // staff tab
  actor: string[]
  group: string[]
  result: string[]
}

export const EMPTY_LOG_QUERY: LogQuery = {
  tab: "mcp",
  range: null,
  q: "",
  mcp: [],
  owner: [],
  platform: [],
  account: [],
  tool: [],
  status: [],
  writes: false,
  actor: [],
  group: [],
  result: [],
}

type RawParams = URLSearchParams | Record<string, string | string[] | undefined>

function getRaw(params: RawParams, key: string): string | undefined {
  if (params instanceof URLSearchParams) {
    const all = params.getAll(key)
    return all.length ? all.join(",") : undefined
  }
  const v = params[key]
  return Array.isArray(v) ? v.join(",") : v
}

function list(
  params: RawParams,
  key: string,
  accept: (s: string) => boolean,
  max = 50
): string[] {
  const raw = getRaw(params, key)
  if (!raw) return []
  const out: string[] = []
  for (const part of raw.split(",")) {
    const s = part.trim()
    if (s && accept(s) && !out.includes(s)) out.push(s)
    if (out.length >= max) break
  }
  return out
}

function isIsoDate(s: string): boolean {
  if (!ISO_DATE_RE.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000
  )
}

/** Validates a date range: ordered, ≤ LOG_MAX_RANGE_DAYS. Returns null when invalid/missing. */
export function parseLogDateRange(
  from: string | undefined | null,
  to: string | undefined | null
): LogDateRange | null {
  if (!from || !to || !isIsoDate(from) || !isIsoDate(to)) return null
  const [a, b] = from <= to ? [from, to] : [to, from]
  if (daysBetween(a, b) + 1 > LOG_MAX_RANGE_DAYS) return null
  return { from: a, to: b }
}

const inSet =
  <T extends readonly string[]>(set: T) =>
  (s: string) =>
    (set as readonly string[]).includes(s)

/** Parse /logs search params (unknown/invalid values are dropped silently). */
export function parseLogQuery(params: RawParams): LogQuery {
  const tabRaw = getRaw(params, "tab")
  const tab: LogTab = tabRaw === "staff" ? "staff" : "mcp"
  const q = (getRaw(params, "q") ?? "").trim().slice(0, 200)
  return {
    tab,
    range: parseLogDateRange(getRaw(params, "from"), getRaw(params, "to")),
    q,
    mcp: list(params, "mcp", (s) => UUID_RE.test(s)),
    owner: list(params, "owner", (s) => TOKEN_RE.test(s)),
    platform: list(params, "platform", inSet(LOG_PLATFORMS)),
    account: list(params, "account", (s) => TOKEN_RE.test(s)),
    tool: list(params, "tool", (s) => TOKEN_RE.test(s)),
    status: list(params, "status", inSet(MCP_LOG_STATUSES)),
    writes: getRaw(params, "writes") === "1",
    actor: list(params, "actor", (s) => TOKEN_RE.test(s)),
    group: list(params, "group", inSet(ACTIVITY_GROUPS)),
    result: list(params, "result", inSet(ACTIVITY_STATUSES)),
  }
}

/** LogQuery → URLSearchParams (only non-default values; filters of the other tab are dropped). */
export function logQueryToSearchParams(query: LogQuery): URLSearchParams {
  const sp = new URLSearchParams()
  if (query.tab !== "mcp") sp.set("tab", query.tab)
  if (query.range) {
    sp.set("from", query.range.from)
    sp.set("to", query.range.to)
  }
  const put = (k: keyof LogQuery & string, v: string[]) => {
    if (v.length) sp.set(k, v.join(","))
  }
  if (query.tab === "mcp") {
    put("mcp", query.mcp)
    put("owner", query.owner)
    put("platform", query.platform)
    put("account", query.account)
    put("tool", query.tool)
    put("status", query.status)
    if (query.writes) sp.set("writes", "1")
  } else {
    put("actor", query.actor)
    put("group", query.group)
    put("result", query.result)
  }
  if (query.q) sp.set("q", query.q)
  return sp
}

// ---------------------------------------------------------------------------
// Time range → instants
// ---------------------------------------------------------------------------

export interface LogTimeRange {
  since: Date
  /** exclusive */
  until: Date
}

/** Offset (ms) of `timeZone` at `instant`: local wall time − UTC. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant)
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value)
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"))
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000
}

/** UTC instant of 00:00 local time on `isoDate` in `timeZone`. */
export function zonedDayStart(isoDate: string, timeZone: string = LOG_TIMEZONE): Date {
  const naive = Date.parse(`${isoDate}T00:00:00Z`)
  let guess = naive - zoneOffsetMs(new Date(naive), timeZone)
  // second pass handles DST transitions between the naive guess and the result
  guess = naive - zoneOffsetMs(new Date(guess), timeZone)
  return new Date(guess)
}

function nextIsoDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

/** Required time window of every log query: the picked days, or the last 24 hours. */
export function resolveLogTimeRange(
  range: LogDateRange | null,
  now: Date = new Date(),
  timeZone: string = LOG_TIMEZONE
): LogTimeRange {
  if (!range) {
    return { since: new Date(now.getTime() - LOG_DEFAULT_HOURS * 3_600_000), until: now }
  }
  return { since: zonedDayStart(range.from, timeZone), until: zonedDayStart(nextIsoDay(range.to), timeZone) }
}

// ---------------------------------------------------------------------------
// Server action inputs
// ---------------------------------------------------------------------------

/** opaque keyset cursor: base64url(JSON [createdAtIsoMicro, id]) */
export const logCursorSchema = z.string().min(10).max(200)

export const loadMoreLogsSchema = z.object({
  /** the page's current search string (without "?") */
  search: z.string().max(4000),
  cursor: logCursorSchema,
})

export const logDetailSchema = z.object({
  id: z.string().regex(UUID_RE, "ID không hợp lệ"),
  /** created_at with microseconds, as returned by the list (partition pruning) */
  createdAt: z.string().min(10).max(40),
})
