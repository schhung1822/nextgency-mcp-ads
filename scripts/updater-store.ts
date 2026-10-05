// Updater (I/O): all SQL of the updater. Contract: .claude/docs/10-update-system.md §3
//   system_update_requests (one active row at a time), app_settings 'updater_heartbeat', activity_logs.
// Takes a minimal pg-like handle so tests can pass a real pg.Pool (throw-away DB) or a fake.
import { safeErrorForLog } from "@/server/audit/safe-error"
import { ACTION_BY_STATUS, STALE_PENDING_MINUTES, type FinalStatus, type UpdateStep } from "./updater-core"

export interface Queryable {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>
}
export interface PoolLike extends Queryable {
  connect(): Promise<Queryable & { release(): void }>
}

export interface UpdateRequest {
  id: string
  fromVersion: string
  targetVersion: string
  requestedBy: string | null
}

export interface FinishInfo {
  status: FinalStatus
  step: UpdateStep | null
  /** short Vietnamese message shown in the UI (already redacted) */
  message: string
  /** log tail <= 64 KB (already redacted) */
  log: string
  /** activity_logs.metadata: from / to / durationMs ... (no secrets) */
  metadata: Record<string, unknown>
}

export interface Store {
  heartbeat(info: { at: Date; version: string; composeProject: string }): Promise<void>
  /** running rows older than `olderThanMinutes` (0 = all) -> failed (+ activity log). Returns how many. */
  failStaleRunning(olderThanMinutes: number, message: string): Promise<number>
  /** pending rows older than `olderThanMinutes` -> failed (+ activity log): they are never started. Returns how many. */
  failStalePending(olderThanMinutes: number, message: string): Promise<number>
  /** pending (younger than STALE_PENDING_MINUTES) -> running (FOR UPDATE SKIP LOCKED); null when nothing to do */
  claimNext(): Promise<UpdateRequest | null>
  progress(id: string, patch: { step?: UpdateStep | null; message?: string; log?: string }): Promise<void>
  /** status + finished_at + activity_logs in ONE transaction. false when the row was no longer `running`. */
  finish(req: UpdateRequest, info: FinishInfo): Promise<boolean>
}

interface RequestRow {
  id: string
  from_version: string
  target_version: string
  requested_by: string | null
  step?: string | null
}

const toReq = (r: RequestRow): UpdateRequest => ({
  id: r.id,
  fromVersion: r.from_version,
  targetVersion: r.target_version,
  requestedBy: r.requested_by,
})

export function createPgStore(pool: PoolLike): Store {
  /** Insert the audit row. Savepoint: a logging problem (e.g. missing monthly partition) must not lose the status change. */
  async function writeActivity(tx: Queryable, req: UpdateRequest, status: FinalStatus, metadata: Record<string, unknown>) {
    await tx.query("SAVEPOINT activity")
    try {
      await tx.query(
        `INSERT INTO activity_logs (actor_id, actor_email, actor_role, action, target_type, target_id, target_label, status, metadata)
         SELECT $1::text, u.email, COALESCE(u.role, 'system'), $2, 'system_update', $3, $4, $5, $6::jsonb
         FROM (SELECT 1) AS one LEFT JOIN "user" u ON u.id = $1::text`,
        [
          req.requestedBy,
          ACTION_BY_STATUS[status],
          req.id,
          `${req.fromVersion} -> ${req.targetVersion}`,
          status === "succeeded" ? "success" : "failure",
          JSON.stringify(metadata),
        ]
      )
      await tx.query("RELEASE SAVEPOINT activity")
    } catch (e) {
      await tx.query("ROLLBACK TO SAVEPOINT activity")
      console.error(`[updater] ghi activity_logs lỗi: ${safeErrorForLog(e)}`)
    }
  }

  async function inTx<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    // best effort: this month's log partition must exist (migrate/worker normally keep it ahead)
    await pool.query("SELECT app_ensure_monthly_partitions('activity_logs', 1)").catch(() => {})
    const c = await pool.connect()
    try {
      await c.query("BEGIN")
      const out = await fn(c)
      await c.query("COMMIT")
      return out
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {})
      throw e
    } finally {
      c.release()
    }
  }

  return {
    async heartbeat({ at, version, composeProject }) {
      await pool.query(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ('updater_heartbeat', $1::jsonb, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [JSON.stringify({ at: at.toISOString(), version, composeProject })]
      )
    },

    async failStaleRunning(olderThanMinutes, message) {
      return inTx(async (tx) => {
        const { rows } = await tx.query<RequestRow>(
          `UPDATE system_update_requests
              SET status = 'failed', message = $2, finished_at = now(), updated_at = now()
            WHERE status = 'running' AND started_at < now() - ($1::int * interval '1 minute')
        RETURNING id, from_version, target_version, requested_by::text AS requested_by, step`,
          [olderThanMinutes, message]
        )
        for (const r of rows) {
          await writeActivity(tx, toReq(r), "failed", {
            from: r.from_version,
            to: r.target_version,
            failedStep: r.step ?? null,
            reason: "stale_running",
          })
        }
        return rows.length
      })
    },

    async failStalePending(olderThanMinutes, message) {
      return inTx(async (tx) => {
        const { rows } = await tx.query<RequestRow>(
          `UPDATE system_update_requests
              SET status = 'failed', message = $2, finished_at = now(), updated_at = now()
            WHERE status = 'pending' AND created_at < now() - ($1::int * interval '1 minute')
        RETURNING id, from_version, target_version, requested_by::text AS requested_by, step`,
          [olderThanMinutes, message]
        )
        for (const r of rows) {
          await writeActivity(tx, toReq(r), "failed", { from: r.from_version, to: r.target_version, reason: "stale_pending" })
        }
        return rows.length
      })
    },

    async claimNext() {
      const { rows } = await pool.query<RequestRow>(
        `UPDATE system_update_requests
            SET status = 'running', started_at = now(), updated_at = now(), step = NULL,
                message = 'Đã nhận yêu cầu, đang chuẩn bị cập nhật'
          WHERE id = (SELECT id FROM system_update_requests
                       WHERE status = 'pending' AND created_at > now() - ($1::int * interval '1 minute')
                       ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id, from_version, target_version, requested_by::text AS requested_by`,
        [STALE_PENDING_MINUTES]
      )
      return rows[0] ? toReq(rows[0]) : null
    },

    async progress(id, patch) {
      await pool.query(
        `UPDATE system_update_requests
            SET step = CASE WHEN $2::boolean THEN $3 ELSE step END,
                message = COALESCE($4, message), log = COALESCE($5, log), updated_at = now()
          WHERE id = $1 AND status = 'running'`,
        [id, patch.step !== undefined, patch.step ?? null, patch.message ?? null, patch.log ?? null]
      )
    },

    async finish(req, info) {
      return inTx(async (tx) => {
        const { rowCount } = await tx.query(
          `UPDATE system_update_requests
              SET status = $2, step = $3, message = $4, log = $5, finished_at = now(), updated_at = now()
            WHERE id = $1 AND status = 'running'`,
          [req.id, info.status, info.step, info.message, info.log]
        )
        if (!rowCount) return false
        await writeActivity(tx, req, info.status, info.metadata)
        return true
      })
    },
  }
}
