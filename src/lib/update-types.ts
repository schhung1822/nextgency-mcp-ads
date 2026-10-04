// Client-safe shapes of the update system (.claude/docs/10-update-system.md §3-4). Plain serialisable data:
// the server builds them (src/server/services/updates.ts), /api/updates/status returns them as JSON and the
// /settings/updates page renders them.

/** Steps the `updater` reports, in execution order (`rollback` only appears after a failure). */
export const UPDATE_STEPS = ["backup", "pull", "migrate", "restart", "healthcheck"] as const
export type UpdateStepName = (typeof UPDATE_STEPS)[number] | "rollback"

export const UPDATE_REQUEST_STATUSES = ["pending", "running", "succeeded", "failed", "rolled_back"] as const
export type UpdateRequestStatus = (typeof UPDATE_REQUEST_STATUSES)[number]

/** `updater` writes a heartbeat every 30 s; the UI treats it as online while the last one is younger than this. */
export const UPDATER_ONLINE_WINDOW_MS = 90_000

export interface LatestRelease {
  /** semver without "v" */
  version: string
  /** git tag, "v1.2.0" */
  tag: string
  publishedAt: string | null
  /** plain text, <= 4000 chars - render escaped (never as HTML) */
  notes: string
  url: string
  checkedAt: string
}

export interface UpdateCheckFailure {
  at: string
  message: string
}

export interface UpdateRequestView {
  id: string
  fromVersion: string
  targetVersion: string
  status: UpdateRequestStatus
  step: UpdateStepName | null
  message: string | null
  requestedBy: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

/** Why the "Cập nhật" button cannot be used right now (null = it can). */
export type UpdateBlockReason = "no_update" | "dev_build" | "busy" | "updater_offline"

export interface UpdateStatus {
  /** running version, semver without "v" (or "dev") */
  current: string
  /** the running build is a release (strict semver), i.e. comparable with `latest` */
  currentIsRelease: boolean
  latest: LatestRelease | null
  /** `latest` is strictly newer than `current` */
  hasUpdate: boolean
  checkError: UpdateCheckFailure | null
  updater: { online: boolean; lastSeenAt: string | null; version: string | null }
  /** the pending/running request, if any */
  active: UpdateRequestView | null
  /** newest first, at most 10 (includes `active`) */
  history: UpdateRequestView[]
  blockReason: UpdateBlockReason | null
  /** server clock when the snapshot was built */
  serverTime: string
}

/** Cheap summary for the user menu (layout): every user gets `current`, only admins get `latestVersion`. */
export interface VersionBadge {
  current: string
  /** set only for admins when a newer release is known */
  latestVersion: string | null
}
