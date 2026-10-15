// Shared server-side types for the Apify integration (16-apify.md). Contract between the token store / pool
// (src/server/apify), the services and the MCP tools (src/server/mcp/tools/apify). No next/* imports.
import type { z } from "zod"

import type { ApifyTokenScope, ApifyTokenStatus } from "@/lib/schemas/apify"

/**
 * A token an MCP may rotate through (on McpGrant.apifyTokens): company tokens + the MCP owner's personal tokens,
 * live, status active or exhausted. Never carries the secret - the pool loads it via store.ts when a run starts.
 */
export interface GrantApifyToken {
  /** apify_tokens.id */
  id: string
  name: string
  scope: ApifyTokenScope
  /** Apify account id: tokens of one account share the credit (grouped by the pool) */
  apifyUserId: string | null
  status: Extract<ApifyTokenStatus, "active" | "exhausted">
  /** ISO; exhausted tokens are usable again from then */
  exhaustedUntil: string | null
  usageUsd: number | null
  limitUsd: number | null
  cycleEndAt: string | null
  /** when usage / limit were read from Apify (ISO) - older than 5 min → re-read before relying on them */
  lastCheckedAt: string | null
}

/** Non-secret account info read from GET /v2/users/me + GET /v2/users/me/limits. */
export interface ApifyAccountInfo {
  apifyUserId: string
  username: string | null
  planId: string | null
  planTier: string | null
  usageUsd: number | null
  limitUsd: number | null
  cycleEndAt: string | null
  actorsEnabled: boolean
}

/** The token chosen for one run (secret decrypted in memory only, never logged / returned). */
export interface PickedApifyToken {
  tokenId: string
  apifyUserId: string | null
  /** plaintext API token - keep in a local variable, pass to client.ts only */
  secret: string
}

// ---------------------------------------------------------------------------------------------------------------
// Catalog (curated tasks → actors). Implemented in src/server/apify/catalog*.ts
// ---------------------------------------------------------------------------------------------------------------

export type ApifyTaskGroup =
  | "shopee"
  | "lazada"
  | "tiktokshop"
  | "tiki"
  | "tiktok"
  | "facebook"
  | "instagram"
  | "threads"
  | "youtube"
  | "google"
  | "web"

export interface ApifyCatalogActor {
  /** "username~actor-name" */
  actorId: string
  /**
   * Normalised task params (already validated by the task's zod schema) + the effective result limit → the Actor
   * INPUT. MUST set every limit-like field of the Actor (results, pages, reviews, comments, depth…) from `limit`,
   * never pass cookies / login / custom JS / webhooks / proxy URLs, and never leave a field whose default is huge.
   */
  buildInput: (
    params: Record<string, unknown>,
    limit: number
  ) => Record<string, unknown>
  /** run timeout sent to Apify (seconds, ≤ 600) */
  timeoutSecs: number
  /** run memory (MB, power of two, ≤ 4096); omitted = Actor default capped at 4096 */
  memoryMbytes?: number
  /** dataset fields worth returning first (apify_get_results default `fields`) */
  resultFields?: string[]
  /** Vietnamese note shown to the AI (limitations, e.g. "VN: chỉ dữ liệu cơ bản") */
  noteVi?: string
}

export interface ApifyCatalogTask {
  /** stable key, snake_case (e.g. "shopee_product") */
  key: string
  group: ApifyTaskGroup
  titleVi: string
  /** "Dùng khi…"-style description for the AI (≤ 300 chars) */
  descriptionVi: string
  /** normalised input the AI sends (e.g. { url } / { keyword, limit, country }) */
  input: z.ZodObject
  /** result count: default when the AI does not ask, hard max */
  limit: { default: number; max: number }
  /** rough cost of one call with the default limit on the FREE tier (USD) - shown to the AI, not enforced */
  estimatedCostUsd: number
  /** primary first, then fallbacks (used only when the previous one cannot start, 16-apify.md §6) */
  actors: ApifyCatalogActor[]
  /** hidden unless explicitly requested (low-confidence actors) */
  beta?: boolean
  noteVi?: string
}

/** One Apify run started by an MCP (apify_runs row), as the tools see it. */
export interface ApifyRunRecord {
  id: string
  mcpId: string
  tokenId: string
  actorId: string
  taskKey: string | null
  runId: string
  datasetId: string | null
  status: string
  maxChargeUsd: number
  usageUsd: number | null
  itemCount: number | null
  startedAt: string
  finishedAt: string | null
}
