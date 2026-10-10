// TikTok GMV Max in the MCP form (client-safe, no server imports): which ad accounts in scope have TikTok Shop /
// GMV Max (from the connection check's non-secret summary `connections.meta.gmvMax`), and the admin-only state of
// the "Cho phép AI thay đổi GMV Max" switch. The server enforces the admin rule on save - this is UI state only.
import type { McpFormValues } from "@/lib/schemas/mcp-servers"

/** Per ad account (ad_accounts.id): shops the account can use for GMV Max, and shops ready for GMV Max. */
export interface GmvMaxAccountFlag {
  shops: number
  ready: number
}

/** ad_accounts.id → flag; only accounts with at least one shop are listed. */
export type GmvMaxAccountFlags = Record<string, GmvMaxAccountFlag>

const count = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0

/**
 * Reads `connections.meta.gmvMax.advertisers[{advertiserId, shops, ready}]` (written by the TikTok connection check)
 * and maps it onto the connection's ad accounts by external id. Unknown / malformed meta → no flags.
 */
export function gmvMaxFlagsFromMeta(
  meta: unknown,
  accounts: readonly { id: string; externalId: string }[]
): GmvMaxAccountFlags {
  const out: GmvMaxAccountFlags = {}
  if (!meta || typeof meta !== "object") return out
  const gmv = (meta as { gmvMax?: unknown }).gmvMax
  if (!gmv || typeof gmv !== "object") return out
  const list = (gmv as { advertisers?: unknown }).advertisers
  if (!Array.isArray(list)) return out
  const byExternal = new Map(accounts.map((a) => [a.externalId, a.id]))
  for (const row of list) {
    if (!row || typeof row !== "object") continue
    const r = row as {
      advertiserId?: unknown
      shops?: unknown
      ready?: unknown
    }
    const id = byExternal.get(String(r.advertiserId ?? ""))
    const shops = count(r.shops)
    const ready = count(r.ready)
    if (!id || (shops === 0 && ready === 0)) continue
    out[id] = { shops: Math.max(shops, ready), ready }
  }
  return out
}

/** TikTok ad accounts currently selected in the form (step 2) that have TikTok Shop / GMV Max, by name. */
export function selectedGmvMaxAccounts(
  values: Pick<McpFormValues, "platforms">,
  connections: readonly {
    id: string
    platform: string
    accounts: readonly { id: string; name: string }[]
  }[],
  flags: GmvMaxAccountFlags
): { id: string; name: string; shops: number; ready: number }[] {
  const d = values.platforms.tiktok
  if (!d?.enabled) return []
  const byId = new Map(connections.map((c) => [c.id, c]))
  const out: { id: string; name: string; shops: number; ready: number }[] = []
  const seen = new Set<string>()
  for (const c of d.connections) {
    const conn = byId.get(c.connectionId)
    if (!conn || conn.platform !== "tiktok") continue
    for (const a of conn.accounts) {
      const f = flags[a.id]
      if (!f || seen.has(a.id)) continue
      if (c.mode !== "all" && !c.accountIds.includes(a.id)) continue
      seen.add(a.id)
      out.push({ id: a.id, name: a.name, ...f })
    }
  }
  return out
}

/**
 * The switch for the viewer: admins change it freely; staff may only keep or turn OFF a value an admin saved
 * (switching back on before saving restores the saved value, which the server accepts as "unchanged").
 */
export function gmvMaxSwitchState(opts: {
  isAdmin: boolean
  /** value saved on the MCP (false in the create wizard) */
  savedOn: boolean
  checked: boolean
}): { disabled: boolean; locked: boolean } {
  if (opts.isAdmin) return { disabled: false, locked: false }
  if (opts.savedOn) return { disabled: false, locked: false }
  // staff, never enabled by an admin: locked off (a stray "on" can still be turned off)
  return { disabled: !opts.checked, locked: true }
}
