// Output shaping helpers shared by the common tools (snake_case, compact, no nulls where useless).
import type { AdObjectDetail, AdObjectSummary, Budget } from "../../../providers/types"
import { jsonLength, MAX_STRUCTURED_CHARS } from "../../tool"
import { roundMoney } from "../../../providers/money"

export function budgetOut(b: Budget | null | undefined) {
  if (!b) return null
  return {
    type: b.type,
    amount: roundMoney(b.amount, b.currency),
    currency: b.currency,
    level: b.level,
    ...(b.shared ? { shared: true } : {}),
  }
}

export function objectSummaryOut(o: AdObjectSummary): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: o.id,
    level: o.level,
    name: o.name,
    status: o.status,
    status_raw: o.statusRaw,
  }
  if (o.campaignId) out.campaign_id = o.campaignId
  if (o.parentId) out.parent_id = o.parentId
  if (o.budget) out.budget = budgetOut(o.budget)
  if (o.objective) out.objective = o.objective
  if (o.startTime) out.start_time = o.startTime
  if (o.endTime) out.end_time = o.endTime
  if (o.createdTime) out.created_time = o.createdTime
  if (o.extra && Object.keys(o.extra).length) out.extra = o.extra
  return out
}

export function objectDetailOut(o: AdObjectDetail, depth = 0): Record<string, unknown> {
  const out = objectSummaryOut(o)
  out.config = o.config ?? {}
  if (o.children && depth < 3) out.children = o.children.map((c) => objectDetailOut(c, depth + 1))
  return out
}

function countNodes(o: Record<string, unknown>): number {
  const children = (o.children as Record<string, unknown>[] | undefined) ?? []
  return 1 + children.reduce((n, c) => n + countNodes(c), 0)
}

/**
 * Fit an object tree into the size budget: first drop config of grandchildren, then of children,
 * then trim children lists. Returns the (possibly) reduced tree + whether something was cut.
 */
export function fitObjectTree(tree: Record<string, unknown>, budget = MAX_STRUCTURED_CHARS - 2_000) {
  if (jsonLength(tree) <= budget) return { tree, truncated: false }
  const clone = structuredClone(tree)
  const strip = (node: Record<string, unknown>, depth: number, minDepth: number) => {
    if (depth >= minDepth && "config" in node) {
      delete node.config
      node.config_omitted = true
    }
    for (const c of (node.children as Record<string, unknown>[] | undefined) ?? []) strip(c, depth + 1, minDepth)
  }
  for (const minDepth of [2, 1]) {
    strip(clone, 0, minDepth)
    if (jsonLength(clone) <= budget) return { tree: clone, truncated: true }
  }
  // trim children (keep the first ones) until it fits
  const children = (clone.children as Record<string, unknown>[] | undefined) ?? []
  const total = countNodes(clone) - 1
  while (children.length > 0 && jsonLength(clone) > budget) children.pop()
  if (children.length < total) clone.children_omitted = total - countNodes(clone) + 1
  if (jsonLength(clone) > budget) {
    // config itself is huge: keep only its keys
    const cfg = clone.config as Record<string, unknown> | undefined
    if (cfg) {
      clone.config = Object.fromEntries(
        Object.entries(cfg).map(([k, v]) => [k, jsonLength(v) > 2_000 ? "[quá lớn - đã lược bớt]" : v])
      )
    }
  }
  return { tree: clone, truncated: true }
}
