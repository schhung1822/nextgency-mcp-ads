// S5 / M1: in-process ledger of the cumulative started-spend cap (lock + reservations) and M3: the logged changes
// column keeps its STARTED_MAX_DAILY_SPEND_FIELD rows readable (never replaced by capJson's truncation object).
import { beforeEach, describe, expect, it } from "vitest"
import { capJson, LOG_RESPONSE_MAX } from "../audit/cap-json"
import {
  STARTED_MAX_DAILY_SPEND_FIELD,
  type FieldChange,
} from "../providers/types"
import { changesForLog, LOG_CHANGE_NAME_MAX } from "./logging"
import {
  mergeStartedHistory,
  reserveStarted,
  resetStartedLedgerForTests,
  STARTED_RESERVATION_TTL_MS,
  startedLedgerKey,
  startedReservations,
  withStartedLock,
} from "./started-spend-ledger"

beforeEach(() => resetStartedLedgerForTests())

const KEY = startedLedgerKey("00000000-0000-4000-8000-000000000001", {
  platform: "tiktok",
  externalId: "7100",
})
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("withStartedLock", () => {
  it("serialises callers of the same key (FIFO), not other keys; released when fn throws", async () => {
    const order: string[] = []
    const job = (name: string, key = KEY, ms = 20) =>
      withStartedLock(key, async () => {
        order.push(`${name}+`)
        await sleep(ms)
        order.push(`${name}-`)
        return name
      })
    const other = startedLedgerKey("00000000-0000-4000-8000-000000000002", {
      platform: "tiktok",
      externalId: "7100",
    })
    const r = await Promise.all([job("a"), job("b"), job("x", other, 5)])
    expect(r).toEqual(["a", "b", "x"])
    // a and b never overlap; x (other MCP) runs meanwhile
    expect(order.indexOf("a-")).toBeLessThan(order.indexOf("b+"))
    expect(order.indexOf("x+")).toBeLessThan(order.indexOf("a-"))
    await expect(
      withStartedLock(KEY, async () => {
        throw new Error("boom")
      })
    ).rejects.toThrow("boom")
    expect(await job("c")).toBe("c")
  })

  it("check + reserve under the lock: the second of two parallel starts sees the first one's reservation", async () => {
    const cap = 2_000_000
    const start = (id: string, amount: number) =>
      withStartedLock(KEY, async () => {
        const snapshot = startedReservations(KEY)
        await sleep(10) // the DB read
        const rows = mergeStartedHistory(KEY, [], snapshot)
        const total = rows.reduce((a, r) => a + r.amount, 0) + amount
        if (total > cap) throw new Error(`refused ${total}`)
        reserveStarted(KEY, [{ objectId: id, amount }])
        return id
      })
    const r = await Promise.allSettled([
      start("A", 1_500_000),
      start("B", 1_500_000),
    ])
    expect(r.map((x) => x.status)).toEqual(["fulfilled", "rejected"])
  })
})

describe("reservations", () => {
  it("are part of the history until their log row is visible (same id, amount ≥, not older than the reservation)", () => {
    const t0 = Date.parse("2026-10-10T03:00:00Z")
    reserveStarted(KEY, [{ objectId: "A", amount: 1_000 }], t0)
    // DB has nothing yet → the reservation is counted
    expect(
      mergeStartedHistory(KEY, [], startedReservations(KEY, t0), t0)
    ).toEqual([{ objectId: "A", amount: 1_000, at: new Date(t0) }])
    // an OLDER row of the same campaign (an earlier start) does not hide the reservation
    const older = [
      { objectId: "A", amount: 1_000, at: new Date(t0 - 3_600_000) },
    ]
    expect(
      mergeStartedHistory(KEY, older, startedReservations(KEY, t0), t0)
    ).toHaveLength(2)
    // a row with a smaller amount does not either
    const smaller = [{ objectId: "A", amount: 500, at: new Date(t0 + 1_000) }]
    expect(
      mergeStartedHistory(KEY, smaller, startedReservations(KEY, t0), t0)
    ).toHaveLength(2)
    // the matching row → pruned from the ledger
    const row = [{ objectId: "A", amount: 1_000, at: new Date(t0 + 1_000) }]
    expect(
      mergeStartedHistory(KEY, row, startedReservations(KEY, t0), t0)
    ).toEqual(row)
    expect(startedReservations(KEY, t0)).toEqual([])
  })

  it("settle re-keys a create (request key → campaign id, larger amount kept); release drops; 24 h expiry", () => {
    const t0 = Date.parse("2026-10-10T03:00:00Z")
    const r = reserveStarted(
      KEY,
      [
        { objectId: "gmv_max_request:1", amount: 1_000 },
        { objectId: "B", amount: 2_000 },
      ],
      t0
    )
    r.settle("gmv_max_request:1", { objectId: "NEW", amount: 1_500 })
    r.settle("gmv_max_request:1", { objectId: "X", amount: 1 }) // already re-keyed → ignored
    expect(
      startedReservations(KEY, t0).map((x) => [x.objectId, x.amount])
    ).toEqual([
      ["NEW", 1_500],
      ["B", 2_000],
    ])
    r.release(["B"])
    expect(startedReservations(KEY, t0).map((x) => x.objectId)).toEqual(["NEW"])
    // another write's reservation is not touched by this handle
    reserveStarted(KEY, [{ objectId: "C", amount: 3 }], t0)
    r.release()
    expect(startedReservations(KEY, t0).map((x) => x.objectId)).toEqual(["C"])
    expect(startedReservations(KEY, t0 + STARTED_RESERVATION_TTL_MS)).toEqual(
      []
    )
  })
})

describe("changesForLog (M3)", () => {
  const started: FieldChange = {
    objectId: "1840000000000000099",
    objectName: "x".repeat(600),
    level: "campaign",
    field: STARTED_MAX_DAILY_SPEND_FIELD,
    before: null,
    after: 1_500_000,
  }

  it("caps names and large values; the started rows always survive and the column stays an array under capJson", () => {
    const ids = Array.from(
      { length: 400 },
      (_, i) => `1729000000000${String(i).padStart(6, "0")}`
    )
    const bulk: FieldChange[] = Array.from({ length: 199 }, (_, i) => ({
      objectId: `p${i}`,
      objectName: "N".repeat(2_000),
      field: "item_group_ids",
      before: ids,
      after: ids,
    }))
    const logged = changesForLog([...bulk, started])!
    const cap = capJson(logged, LOG_RESPONSE_MAX)
    expect(cap.truncated).toBe(false)
    expect(Array.isArray(cap.json)).toBe(true)
    const row = logged.find((c) => c.field === STARTED_MAX_DAILY_SPEND_FIELD)!
    expect(row).toMatchObject({ object_id: started.objectId, after: 1_500_000 })
    expect(row.object_name).toHaveLength(LOG_CHANGE_NAME_MAX)
    expect(logged.at(-1)).toMatchObject({ field: "_changes_truncated" })
    // a value too large for one row is replaced by a preview object
    const one = changesForLog([
      {
        objectId: "1",
        field: "item_group_ids",
        before: null,
        after: Array(5_000).fill("1729000000000000000"),
      },
    ])!
    expect(one[0]!.after).toMatchObject({ _truncated: true })
  })

  it("small changes are kept as they are, in order; a started row beyond the 200-row limit is kept", () => {
    const small: FieldChange[] = [
      {
        objectId: "1",
        objectName: "A",
        level: "campaign",
        field: "status",
        before: "paused",
        after: "active",
      },
      started,
    ]
    expect(changesForLog(small)).toEqual([
      {
        object_id: "1",
        object_name: "A",
        level: "campaign",
        field: "status",
        before: "paused",
        after: "active",
      },
      expect.objectContaining({
        object_id: started.objectId,
        field: STARTED_MAX_DAILY_SPEND_FIELD,
        after: 1_500_000,
      }),
    ])
    const many = [
      ...Array.from({ length: 250 }, (_, i) => ({
        objectId: `o${i}`,
        field: "name",
        before: "a",
        after: "b",
      })),
      started,
    ]
    const out = changesForLog(many)!
    expect(out).toHaveLength(200)
    expect(out.at(-1)!.field).toBe(STARTED_MAX_DAILY_SPEND_FIELD)
  })
})
