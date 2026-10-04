// Status → tone + Vietnamese label. Pure (no React) so it can be unit-tested and reused.
import { common } from "@/lib/i18n/vi/common"

export type StatusTone = "success" | "warning" | "danger" | "info" | "neutral"

export type ConnectionStatus = "active" | "expiring" | "invalid" | "disabled"
export type McpStatus = "active" | "disabled" | "expired"
export type LogStatus =
  | "success"
  | "error"
  | "denied"
  | "rate_limited"
  | "pending_confirmation"
  | "invalid_request"
export type ObjectStatus =
  | "active"
  | "paused"
  | "archived"
  | "deleted"
  | "removed"
  | "pending_review"
  | "rejected"
  | "disabled"
  | "unknown"
export type AccountStatusValue =
  "active" | "disabled" | "pending" | "closed" | "unknown"

export interface StatusKindMap {
  connection: ConnectionStatus
  mcp: McpStatus
  log: LogStatus
  object: ObjectStatus
  account: AccountStatusValue
}
export type StatusKind = keyof StatusKindMap

const TONES: { [K in StatusKind]: Record<StatusKindMap[K], StatusTone> } = {
  connection: {
    active: "success",
    expiring: "warning",
    invalid: "danger",
    disabled: "neutral",
  },
  mcp: { active: "success", disabled: "neutral", expired: "warning" },
  log: {
    success: "success",
    error: "danger",
    denied: "danger",
    rate_limited: "warning",
    pending_confirmation: "info",
    invalid_request: "warning",
  },
  object: {
    active: "success",
    paused: "neutral",
    archived: "neutral",
    deleted: "neutral",
    removed: "neutral",
    pending_review: "info",
    rejected: "danger",
    disabled: "danger",
    unknown: "neutral",
  },
  account: {
    active: "success",
    disabled: "danger",
    pending: "info",
    closed: "neutral",
    unknown: "neutral",
  },
}

export interface StatusMeta {
  label: string
  tone: StatusTone
}

/** Maps a raw status string to its label/tone; unknown values fall back to a neutral "Không rõ". */
export function getStatusMeta<K extends StatusKind>(
  kind: K,
  status: StatusKindMap[K] | (string & {})
): StatusMeta {
  const labels = common.status[kind] as Record<string, string>
  const tones = TONES[kind] as Record<string, StatusTone>
  if (Object.prototype.hasOwnProperty.call(tones, status)) {
    return { label: labels[status] ?? status, tone: tones[status] }
  }
  return { label: common.status.unknown, tone: "neutral" }
}

export function statusValues<K extends StatusKind>(
  kind: K
): StatusKindMap[K][] {
  return Object.keys(TONES[kind]) as StatusKindMap[K][]
}
