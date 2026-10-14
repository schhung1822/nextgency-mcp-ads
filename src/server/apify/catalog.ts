// Apify catalog (16-apify.md §6): curated tasks → Actors (primary first, then fallbacks) with normalised,
// zod-validated inputs. The AI only picks a task key + simple params; buildActorRun() validates them, clamps the
// result limit and builds the exact Actor INPUT (every limit-like field pinned, paid add-ons off, never cookies /
// login / custom JS / webhooks / output connectors / proxy URLs). Group definitions live in ./catalog/*.ts.
// Pure module: no network, no DB, no next/* imports.
//
// Fallback policy (16-apify.md §6): the next Actor is used only when the previous one cannot START (404,
// deprecated, under maintenance, full permissions, input rejected by Apify) — never automatically after a run that
// already cost money; the AI may ask for it explicitly (apify_run_task actor_choice: "fallback").
import type { ApifyCatalogTask } from "@/server/apify/types"

import type { CatalogTask } from "./catalog/common"
import { FACEBOOK_TASKS } from "./catalog/facebook"
import { GOOGLE_TASKS } from "./catalog/google"
import { INSTAGRAM_TASKS } from "./catalog/instagram"
import { LAZADA_TASKS } from "./catalog/lazada"
import { SHOPEE_TASKS } from "./catalog/shopee"
import { TIKI_TASKS } from "./catalog/tiki"
import { TIKTOK_TASKS } from "./catalog/tiktok"
import { TIKTOKSHOP_TASKS } from "./catalog/tiktokshop"
import { WEB_TASKS } from "./catalog/web"
import { YOUTUBE_TASKS } from "./catalog/youtube"

/** Hard caps sent to Apify (16-apify.md §7). */
export const APIFY_MAX_TIMEOUT_SECS = 600
export const APIFY_MAX_MEMORY_MBYTES = 4096

const ALL_TASKS: readonly CatalogTask[] = [
  ...SHOPEE_TASKS,
  ...LAZADA_TASKS,
  ...TIKTOKSHOP_TASKS,
  ...TIKI_TASKS,
  ...TIKTOK_TASKS,
  ...FACEBOOK_TASKS,
  ...INSTAGRAM_TASKS,
  ...YOUTUBE_TASKS,
  ...GOOGLE_TASKS,
  ...WEB_TASKS,
]

/** Every task (core + beta), grouped by platform. Beta tasks have `beta: true`. */
export const APIFY_CATALOG: readonly ApifyCatalogTask[] = Object.freeze([
  ...ALL_TASKS,
])

const TASKS_BY_KEY: ReadonlyMap<string, CatalogTask> = new Map(
  ALL_TASKS.map((t) => [t.key, t])
)

/** Task by key (core or beta); null when unknown. */
export function getCatalogTask(key: string): ApifyCatalogTask | null {
  return TASKS_BY_KEY.get(key) ?? null
}

/** Tasks shown to the AI: core only, plus beta tasks when explicitly requested. */
export function listCatalogTasks(
  opts: { includeBeta?: boolean } = {}
): ApifyCatalogTask[] {
  return APIFY_CATALOG.filter((t) => opts.includeBeta === true || !t.beta)
}

/** A realistic input for the task (copy), e.g. to show the AI in apify_list_tasks; null when unknown. */
export function getCatalogTaskExample(
  key: string
): Record<string, unknown> | null {
  const task = TASKS_BY_KEY.get(key)
  return task ? structuredClone(task.example) : null
}

/**
 * Lowest `maxTotalChargeUsd` some Actors accept (Store `minimalMaxTotalChargeUsd`, 2026-10-14; only values
 * ≥ $0.05 are listed). A per-run cap below it may make the start fail → the MCP should use at least this value
 * when its own per-run cap allows it, otherwise prefer another Actor or explain the cap to the user.
 */
export const APIFY_ACTOR_MIN_CHARGE_USD: Readonly<Record<string, number>> =
  Object.freeze({
    "gio21~shopee-scraper": 0.25,
    "gio21~shopee-product-detail": 0.25,
    "fatihtahta~lazada-scraper": 0.1,
    "clockworks~tiktok-scraper": 0.5,
    "compass~crawler-google-places": 0.5,
    "apify~google-search-scraper": 0.5,
    "streamers~youtube-comments-scraper": 0.5,
  })

/**
 * Catalog Actors billed by Apify platform usage (pricing model FREE = pay-per-usage: compute units + proxy, checked on
 * the Store 2026-10-14): maxTotalChargeUsd may not bind them, so apify_run_task lowers their timeout until
 * memory × time × $0.2/CU fits the run cap (security M2). Proxy traffic is not covered by that bound.
 */
export const APIFY_USAGE_BILLED_ACTORS: ReadonlySet<string> = new Set([
  "apify~rag-web-browser",
  "apify~website-content-crawler",
])

/**
 * Actor input keys the catalog must never send: cookies / login / session / passwords, custom JS (pageFunction,
 * customMapFunction…), webhooks, MCP / Notion output connectors, custom proxy URLs or headers, request signing,
 * named storages or resumable state shared across runs, remote URL lists. Checked on every built input.
 */
export const FORBIDDEN_ACTOR_INPUT_KEY_RE =
  /cookie|login|password|session|pageFunction|Function$|webhook|outputConnector|mcpConnector|deliver|notion|proxyUrl|customHttpHeaders|signHttpRequests|KvStore|dedupMemory|monitorStore|stateKey|resume|urlsFromFile/i

/** Every key (deep, incl. inside arrays) matching FORBIDDEN_ACTOR_INPUT_KEY_RE, as dotted paths. */
export function findForbiddenInputKeys(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => findForbiddenInputKeys(v, `${path}[${i}]`))
  }
  if (value === null || typeof value !== "object") return []
  return Object.entries(value).flatMap(([k, v]) => {
    const p = path ? `${path}.${k}` : k
    return [
      ...(FORBIDDEN_ACTOR_INPUT_KEY_RE.test(k) ? [p] : []),
      ...findForbiddenInputKeys(v, p),
    ]
  })
}

/** Normalised params rejected by the task's zod schema (→ MCP error apify_input_invalid). */
export class ApifyCatalogInputError extends Error {
  readonly taskKey: string
  readonly issues: { path: string; message: string }[]

  constructor(
    taskKey: string,
    issues: readonly { path: readonly PropertyKey[]; message: string }[]
  ) {
    const list = issues.map((i) => ({
      path: i.path.map(String).join("."),
      message: i.message,
    }))
    super(
      `Dữ liệu vào không hợp lệ cho việc "${taskKey}": ${list
        .map((i) => (i.path ? `${i.path}: ${i.message}` : i.message))
        .join("; ")}`
    )
    this.name = "ApifyCatalogInputError"
    this.taskKey = taskKey
    this.issues = list
  }
}

/**
 * Effective result limit: the requested one (integer part) clamped to [1, task.limit.max]; the task default when
 * nothing usable is requested.
 */
export function clampTaskLimit(
  task: Pick<ApifyCatalogTask, "limit">,
  requested?: number | null
): number {
  const max = Math.max(1, Math.floor(task.limit.max))
  const wanted =
    typeof requested === "number" && Number.isFinite(requested)
      ? Math.floor(requested)
      : task.limit.default
  return Math.min(Math.max(1, wanted), max)
}

/** What actors.ts needs to start one run (POST /v2/acts/{actorId}/runs?timeout&memory&maxTotalChargeUsd). */
export interface ApifyActorRunPlan {
  /** "username~actor-name" */
  actorId: string
  /** the Actor INPUT (plain JSON: undefined fields dropped) */
  input: Record<string, unknown>
  /** ≤ APIFY_MAX_TIMEOUT_SECS */
  timeoutSecs: number
  /** ≤ APIFY_MAX_MEMORY_MBYTES; undefined = Actor default (never the case in this catalog) */
  memoryMbytes: number | undefined
  /** effective result limit applied to the input */
  limit: number
  /** billed by platform usage (APIFY_USAGE_BILLED_ACTORS): bound the timeout by the cost cap */
  usageBilled: boolean
}

/**
 * Validates `params` with the task's zod schema, clamps the limit and builds the input of the Actor at
 * `actorIndex` (0 = primary, 1+ = fallbacks).
 * @throws ApifyCatalogInputError when params are invalid; RangeError when the task has no such Actor.
 */
export function buildActorRun(
  task: ApifyCatalogTask,
  actorIndex: number,
  params: unknown,
  requestedLimit?: number | null
): ApifyActorRunPlan {
  const actor = Number.isInteger(actorIndex)
    ? task.actors[actorIndex]
    : undefined
  if (!actor) {
    throw new RangeError(
      `Apify task "${task.key}" has no actor at index ${actorIndex}`
    )
  }
  const parsed = task.input.safeParse(params ?? {})
  if (!parsed.success) {
    throw new ApifyCatalogInputError(task.key, parsed.error.issues)
  }
  const limit = clampTaskLimit(task, requestedLimit)
  const input = JSON.parse(
    JSON.stringify(
      actor.buildInput(parsed.data as Record<string, unknown>, limit)
    )
  ) as Record<string, unknown>
  const forbidden = findForbiddenInputKeys(input)
  if (forbidden.length > 0) {
    // programming error in a catalog entry: never send it
    throw new Error(
      `Apify task "${task.key}" (${actor.actorId}) built forbidden input keys: ${forbidden.join(", ")}`
    )
  }
  return {
    actorId: actor.actorId,
    input,
    timeoutSecs: Math.min(
      Math.max(1, Math.floor(actor.timeoutSecs)),
      APIFY_MAX_TIMEOUT_SECS
    ),
    memoryMbytes:
      actor.memoryMbytes === undefined
        ? undefined
        : Math.min(actor.memoryMbytes, APIFY_MAX_MEMORY_MBYTES),
    limit,
    usageBilled: APIFY_USAGE_BILLED_ACTORS.has(actor.actorId),
  }
}
