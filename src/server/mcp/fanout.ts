// Paginated fan-out over several sources (ad accounts), each with its own platform cursor.
// Every collected item remembers where it came from (source index, platform cursor used, page size,
// index inside that page) so the next cursor can point exactly after the last item actually returned -
// even when the page is cut short to fit the response size budget.

export interface FanoutPosition {
  /** source index */
  i: number
  /** platform cursor of the page being read (null = first page) */
  c: string | null
  /** items of that page already consumed */
  s: number
  /** page size used to request that page (must be reused to get the same page back) */
  p: number
}

export interface Provenance {
  i: number
  c: string | null
  p: number
  k: number
}

export interface FetchedPage<T> {
  items: T[]
  nextCursor: string | null
}

export interface FanoutError {
  index: number
  error: unknown
}

export interface FanoutResult<T> {
  items: { item: T; prov: Provenance }[]
  /** where to continue after the LAST collected item (null = all sources exhausted) */
  end: FanoutPosition | null
  errors: FanoutError[]
  /** indexes of sources whose first page was fetched successfully in this call */
  touched: Set<number>
}

export async function mapConcurrent<A, B>(items: A[], limit: number, fn: (a: A, idx: number) => Promise<B>): Promise<B[]> {
  const out: B[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const idx = next++
      if (idx >= items.length) return
      out[idx] = await fn(items[idx]!, idx)
    }
  })
  await Promise.all(workers)
  return out
}

/**
 * Collect up to `maxItems` items starting at `start`. Pages of the current source and the first pages
 * of the following sources are fetched concurrently (`concurrency`), then consumed in order.
 */
export async function collectFanout<T>(o: {
  sourceCount: number
  start: FanoutPosition
  maxItems: number
  pageSize: number
  concurrency: number
  fetch: (index: number, cursor: string | null, pageSize: number) => Promise<FetchedPage<T>>
  signal?: AbortSignal
}): Promise<FanoutResult<T>> {
  const items: { item: T; prov: Provenance }[] = []
  const errors: FanoutError[] = []
  const touched = new Set<number>()
  let pos: FanoutPosition = { ...o.start }

  let rounds = 0
  while (items.length < o.maxItems && pos.i < o.sourceCount) {
    o.signal?.throwIfAborted()
    // safety net against platforms returning endless empty pages
    if (++rounds > 200) break
    const batchIdx: number[] = []
    for (let i = pos.i; i < o.sourceCount && batchIdx.length < o.concurrency; i++) batchIdx.push(i)
    const current = pos
    const results = await mapConcurrent(batchIdx, o.concurrency, async (idx) => {
      const cursor = idx === current.i ? current.c : null
      const size = idx === current.i ? current.p : o.pageSize
      try {
        return { ok: true as const, page: await o.fetch(idx, cursor, size), cursor, size }
      } catch (error) {
        return { ok: false as const, error, cursor, size }
      }
    })

    let advancedWithinBatch = false
    for (let b = 0; b < batchIdx.length; b++) {
      const idx = batchIdx[b]!
      const r = results[b]!
      if (!r.ok) {
        errors.push({ index: idx, error: r.error })
        pos = { i: idx + 1, c: null, s: 0, p: o.pageSize }
        continue
      }
      touched.add(idx)
      const skip = idx === current.i ? current.s : 0
      const page = r.page
      let k = skip
      for (; k < page.items.length; k++) {
        if (items.length >= o.maxItems) break
        items.push({ item: page.items[k]!, prov: { i: idx, c: r.cursor, p: r.size, k } })
      }
      if (k < page.items.length) {
        // page only partly consumed
        return { items, end: { i: idx, c: r.cursor, s: k, p: r.size }, errors, touched }
      }
      if (page.nextCursor && page.nextCursor !== r.cursor) {
        pos = { i: idx, c: page.nextCursor, s: 0, p: o.pageSize }
        // later sources of this batch were prefetched but must wait until this one is exhausted
        advancedWithinBatch = true
        break
      }
      pos = { i: idx + 1, c: null, s: 0, p: o.pageSize }
    }
    if (advancedWithinBatch && items.length >= o.maxItems) break
  }
  return { items, end: pos.i < o.sourceCount ? pos : null, errors, touched }
}

/** Position right after `kept` items (when the collected list was cut to fit the size budget). */
export function positionAfter<T>(r: FanoutResult<T>, kept: number): FanoutPosition | null {
  if (kept >= r.items.length) return r.end
  const first = r.items[kept]!.prov
  return { i: first.i, c: first.c, s: first.k, p: first.p }
}
