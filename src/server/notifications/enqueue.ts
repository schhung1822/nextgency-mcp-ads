// enqueueNotification: insert one `pending` delivery per channel (skipped when the per-channel dedupe key already
// exists) and queue a `notify.telegram` job for each. Shared by the web app and the worker.
// It NEVER throws: an ad operation / connection check must not fail because of Telegram - problems are logged only.
// A job that could not be queued leaves the delivery `pending`; the `notifications.sweep` job re-queues it.
import { and, inArray, isNull, ne } from "drizzle-orm"

import { notifications as m } from "@/lib/i18n/vi/notifications"
import type {
  DeliveryEventType,
  DeliverySource,
} from "@/lib/schemas/notifications"
import { safeErrorForLog } from "@/server/audit/safe-error"
import { db } from "@/server/db/client"
import {
  notificationChannels,
  notificationDeliveries,
} from "@/server/db/schema"

import { fitMessage, previewOf } from "./format"
import { sendNotifyJob } from "./queue"

export interface EnqueueNotificationInput {
  channelIds: string[]
  source: DeliverySource
  eventType: DeliveryEventType
  mcpId?: string | null
  /** per-channel idempotency key (unique (channel_id, dedupe_key)); omit for "send every time" */
  dedupeKey?: string | null
  /** HTML built with format.ts (all dynamic values escaped) */
  text: string
}

export interface EnqueueNotificationResult {
  /** deliveries queued for sending */
  queued: string[]
  /** deliveries recorded as failed at once (channel in `error`) */
  failed: string[]
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function enqueueNotification(
  input: EnqueueNotificationInput
): Promise<EnqueueNotificationResult> {
  const result: EnqueueNotificationResult = { queued: [], failed: [] }
  try {
    const ids = [...new Set(input.channelIds)].filter((id) => UUID_RE.test(id))
    if (ids.length === 0 || !input.text.trim()) return result
    // deleted / disabled channels get nothing; `error` channels get a failed row (the owner sees what was missed)
    const channels = await db
      .select({
        id: notificationChannels.id,
        status: notificationChannels.status,
        statusMessage: notificationChannels.statusMessage,
      })
      .from(notificationChannels)
      .where(
        and(
          inArray(notificationChannels.id, ids),
          isNull(notificationChannels.deletedAt),
          ne(notificationChannels.status, "disabled")
        )
      )
    if (channels.length === 0) return result

    const html = fitMessage(input.text)
    const preview = previewOf(html)
    const dedupeKey = input.dedupeKey ? input.dedupeKey.slice(0, 200) : null
    const rows = await db
      .insert(notificationDeliveries)
      .values(
        channels.map((c) => {
          const broken = c.status === "error"
          return {
            channelId: c.id,
            source: input.source,
            eventType: input.eventType,
            mcpId: input.mcpId ?? null,
            dedupeKey,
            status: broken ? "failed" : "pending",
            preview,
            message: broken ? null : html,
            errorMessage: broken
              ? m.telegram.skippedError(c.statusMessage ?? "").slice(0, 1000)
              : null,
          }
        })
      )
      .onConflictDoNothing({
        target: [
          notificationDeliveries.channelId,
          notificationDeliveries.dedupeKey,
        ],
      })
      .returning({
        id: notificationDeliveries.id,
        status: notificationDeliveries.status,
      })

    for (const r of rows) {
      if (r.status !== "pending") {
        result.failed.push(r.id)
        continue
      }
      result.queued.push(r.id)
      try {
        await sendNotifyJob({ deliveryId: r.id, attempt: 0 })
      } catch (e) {
        console.warn(
          `[notifications] could not queue delivery ${r.id} (the sweep job retries): ${safeErrorForLog(e)}`
        )
      }
    }
  } catch (e) {
    console.error(
      `[notifications] enqueue ${input.eventType} failed: ${safeErrorForLog(e)}`
    )
  }
  return result
}
