// Ad accounts of a connection: list, enable/disable, and the lookups the MCP wizard / grant loader need.
import { RELEASED_PLATFORMS } from "@/lib/platforms"
import "server-only"
import { and, eq, inArray, isNull, ne } from "drizzle-orm"

import { connections as m } from "@/lib/i18n/vi/connections"
import type { AdAccountDto, ConnectionStatusValue, MetaPageDto } from "@/lib/schemas/connections"
import { actorOf, logActivity } from "@/server/audit/activity-log"
import { db } from "@/server/db/client"
import { adAccounts, connections, metaPages, user as userTable } from "@/server/db/schema"
import { invalidateGrantCache } from "@/server/mcp/grant"
import type { Platform } from "@/server/providers/types"

import {
  ConnectionServiceError,
  getAccessibleConnectionRow,
  toAdAccountDto,
  toMetaPageDto,
  type Actor,
} from "./connections"

/** Every ad account of a connection the actor may access (enabled or not). */
export async function listAdAccounts(actor: Actor, connectionId: string): Promise<AdAccountDto[]> {
  const row = await getAccessibleConnectionRow(actor, connectionId)
  const rows = await db.select().from(adAccounts).where(eq(adAccounts.connectionId, row.id)).orderBy(adAccounts.name)
  return rows.map(toAdAccountDto)
}

/** Enable/disable ad accounts for MCP use (activity `connection.accounts.toggle`). */
export async function setAdAccountsEnabled(
  actor: Actor,
  input: { connectionId: string; changes: { adAccountId: string; enabled: boolean }[] }
): Promise<AdAccountDto[]> {
  const row = await getAccessibleConnectionRow(actor, input.connectionId)
  const wanted = new Map(input.changes.map((c) => [c.adAccountId, c.enabled]))
  const ids = [...wanted.keys()]
  const result = await db.transaction(async (tx) => {
    const current = await tx
      .select()
      .from(adAccounts)
      .where(and(eq(adAccounts.connectionId, row.id), inArray(adAccounts.id, ids)))
    if (current.length !== ids.length) throw new ConnectionServiceError(m.errors.accountNotFound)
    const changed = current.filter((a) => a.isEnabled !== wanted.get(a.id))
    if (changed.length === 0) return current.map(toAdAccountDto)
    const toEnable = changed.filter((a) => wanted.get(a.id)).map((a) => a.id)
    const toDisable = changed.filter((a) => !wanted.get(a.id)).map((a) => a.id)
    const now = new Date()
    if (toEnable.length)
      await tx.update(adAccounts).set({ isEnabled: true, updatedAt: now }).where(inArray(adAccounts.id, toEnable))
    if (toDisable.length)
      await tx.update(adAccounts).set({ isEnabled: false, updatedAt: now }).where(inArray(adAccounts.id, toDisable))
    await logActivity(
      {
        actor: actorOf(actor),
        action: "connection.accounts.toggle",
        target: { type: "connection", id: row.id, label: row.name },
        metadata: {
          changes: changed.map((a) => ({
            adAccountId: a.id,
            externalId: a.externalId,
            name: a.name,
            before: a.isEnabled,
            after: wanted.get(a.id),
          })),
        },
      },
      tx
    )
    const updated = await tx
      .select()
      .from(adAccounts)
      .where(and(eq(adAccounts.connectionId, row.id), inArray(adAccounts.id, ids)))
    return updated.map(toAdAccountDto)
  })
  // MCP grants embed the enabled accounts: the change must be effective on the very next MCP request
  invalidateGrantCache()
  return result
}

/** Enable/disable Facebook Pages of a Meta connection for MCP use (activity `connection.pages.toggle`). */
export async function setMetaPagesEnabled(
  actor: Actor,
  input: { connectionId: string; changes: { pageId: string; enabled: boolean }[] }
): Promise<MetaPageDto[]> {
  const row = await getAccessibleConnectionRow(actor, input.connectionId)
  if (row.platform !== "meta") throw new ConnectionServiceError(m.errors.pageNotFound)
  const wanted = new Map(input.changes.map((c) => [c.pageId, c.enabled]))
  const ids = [...wanted.keys()]
  const result = await db.transaction(async (tx) => {
    const current = await tx
      .select()
      .from(metaPages)
      .where(and(eq(metaPages.connectionId, row.id), inArray(metaPages.id, ids)))
    if (current.length !== ids.length) throw new ConnectionServiceError(m.errors.pageNotFound)
    const changed = current.filter((p) => p.isEnabled !== wanted.get(p.id))
    if (changed.length === 0) return current.map(toMetaPageDto)
    const toEnable = changed.filter((p) => wanted.get(p.id)).map((p) => p.id)
    const toDisable = changed.filter((p) => !wanted.get(p.id)).map((p) => p.id)
    const now = new Date()
    if (toEnable.length) await tx.update(metaPages).set({ isEnabled: true, updatedAt: now }).where(inArray(metaPages.id, toEnable))
    if (toDisable.length) await tx.update(metaPages).set({ isEnabled: false, updatedAt: now }).where(inArray(metaPages.id, toDisable))
    await logActivity(
      {
        actor: actorOf(actor),
        action: "connection.pages.toggle",
        target: { type: "connection", id: row.id, label: row.name },
        metadata: {
          changes: changed.map((p) => ({
            pageId: p.id,
            externalId: p.externalId,
            name: p.name,
            before: p.isEnabled,
            after: wanted.get(p.id),
          })),
        },
      },
      tx
    )
    const updated = await tx
      .select()
      .from(metaPages)
      .where(and(eq(metaPages.connectionId, row.id), inArray(metaPages.id, ids)))
    return updated.map(toMetaPageDto)
  })
  // MCP grants embed the enabled Pages: effective on the very next MCP request
  invalidateGrantCache()
  return result
}

// ---------------------------------------------------------------------------
// For the MCP wizard (step 2) and scope validation
// ---------------------------------------------------------------------------

export interface UsableConnection {
  id: string
  name: string
  platform: Platform
  status: ConnectionStatusValue
  owner: { id: string; email: string; name: string }
  /** only accounts with is_enabled = true */
  accounts: AdAccountDto[]
  /** Meta only: Facebook Pages with is_enabled = true and not missing */
  pages: MetaPageDto[]
}

/**
 * Connections the actor may put into an MCP: staff → own; admin → all (D4).
 * Excludes deleted and `disabled` connections; accounts are the ENABLED ones only.
 */
export async function listUsableConnectionsForMcp(
  actor: Actor,
  opts: { platform?: Platform } = {}
): Promise<UsableConnection[]> {
  const conns = await db
    .select({
      id: connections.id,
      name: connections.name,
      platform: connections.platform,
      status: connections.status,
      ownerId: connections.ownerId,
      ownerEmail: userTable.email,
      ownerName: userTable.name,
    })
    .from(connections)
    .innerJoin(userTable, eq(userTable.id, connections.ownerId))
    .where(
      and(
        isNull(connections.deletedAt),
        ne(connections.status, "disabled"),
        inArray(connections.platform, [...RELEASED_PLATFORMS]),
        actor.role === "admin" ? undefined : eq(connections.ownerId, actor.id),
        opts.platform ? eq(connections.platform, opts.platform) : undefined
      )
    )
    .orderBy(connections.platform, connections.name)
  if (conns.length === 0) return []
  const accs = await db
    .select()
    .from(adAccounts)
    .where(
      and(
        inArray(
          adAccounts.connectionId,
          conns.map((c) => c.id)
        ),
        eq(adAccounts.isEnabled, true)
      )
    )
    .orderBy(adAccounts.name)
  const byConn = new Map<string, AdAccountDto[]>()
  for (const a of accs) {
    const list = byConn.get(a.connectionId) ?? []
    list.push(toAdAccountDto(a))
    byConn.set(a.connectionId, list)
  }
  const metaIds = conns.filter((c) => c.platform === "meta").map((c) => c.id)
  const pageRows = metaIds.length
    ? await db
        .select()
        .from(metaPages)
        .where(and(inArray(metaPages.connectionId, metaIds), eq(metaPages.isEnabled, true), eq(metaPages.isMissing, false)))
        .orderBy(metaPages.name)
    : []
  const pagesByConn = new Map<string, MetaPageDto[]>()
  for (const p of pageRows) {
    const list = pagesByConn.get(p.connectionId) ?? []
    list.push(toMetaPageDto(p))
    pagesByConn.set(p.connectionId, list)
  }
  return conns.map((c) => ({
    id: c.id,
    name: c.name,
    platform: c.platform,
    status: c.status as ConnectionStatusValue,
    owner: { id: c.ownerId, email: c.ownerEmail, name: c.ownerName },
    accounts: byConn.get(c.id) ?? [],
    pages: pagesByConn.get(c.id) ?? [],
  }))
}

/**
 * Validates MCP scope refs against what the actor may use. `adAccountId: null` = whole connection.
 * Throws ConnectionServiceError when any connection/account is not usable (deleted, disabled,
 * someone else's for staff, account not enabled or not in that connection).
 */
export async function assertScopesUsableForMcp(
  actor: Actor,
  scopes: { connectionId: string; adAccountId: string | null }[],
  pageScopes: { connectionId: string; pageId: string | null }[] = []
): Promise<void> {
  if (scopes.length === 0 && pageScopes.length === 0) return
  const usable = await listUsableConnectionsForMcp(actor)
  const map = new Map(usable.map((c) => [c.id, new Set(c.accounts.map((a) => a.id))]))
  for (const s of scopes) {
    const accounts = map.get(s.connectionId)
    if (!accounts) throw new ConnectionServiceError(m.errors.notFound)
    if (s.adAccountId !== null && !accounts.has(s.adAccountId)) throw new ConnectionServiceError(m.errors.accountNotFound)
  }
  // Pages: Meta connections only; a picked Page must be enabled (and not missing) in that connection
  const pages = new Map(usable.filter((c) => c.platform === "meta").map((c) => [c.id, new Set(c.pages.map((p) => p.id))]))
  for (const s of pageScopes) {
    const ids = pages.get(s.connectionId)
    if (!ids) throw new ConnectionServiceError(m.errors.notFound)
    if (s.pageId !== null && !ids.has(s.pageId)) throw new ConnectionServiceError(m.errors.pageNotFound)
  }
}
