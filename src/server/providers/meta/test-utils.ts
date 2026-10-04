// Test-only helpers: a tiny Graph API fake on top of vi.stubGlobal("fetch").
import { vi } from "vitest"

import type { ProviderContext } from "../types"
import type { MetaCredentials } from "./client"

export interface RecordedCall {
  method: string
  url: URL
  /** Graph path without host/version, e.g. "act_1/insights" ("" for the batch/ids root) */
  path: string
  /** query params + form body params (strings) */
  params: Record<string, string>
  /** body was multipart/form-data */
  multipart: boolean
}

export interface FakeResponse {
  status?: number
  body?: unknown
  headers?: Record<string, string>
  /** raw bytes body (downloads) */
  raw?: Uint8Array
}

export type Handler = (call: RecordedCall) => FakeResponse | Promise<FakeResponse>
export type Route = [method: string, path: string | RegExp, handler: Handler]

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): FakeResponse {
  return { status, body, headers }
}

export function graphError(code: number, subcode?: number, extra: Record<string, unknown> = {}, status = 400): FakeResponse {
  return json(
    {
      error: {
        message: `Fake error ${code}`,
        type: "OAuthException",
        code,
        ...(subcode ? { error_subcode: subcode } : {}),
        fbtrace_id: "TRACE123",
        ...extra,
      },
    },
    status
  )
}

async function readParams(init: RequestInit | undefined): Promise<{ params: Record<string, string>; multipart: boolean }> {
  const params: Record<string, string> = {}
  const body = init?.body
  if (body instanceof URLSearchParams) {
    for (const [k, v] of body) params[k] = v
    return { params, multipart: false }
  }
  if (body instanceof FormData) {
    for (const [k, v] of body) params[k] = typeof v === "string" ? v : `[blob:${(v as Blob).size}]`
    return { params, multipart: true }
  }
  return { params, multipart: false }
}

/** Install a fetch fake. Unmatched requests fail the test loudly. */
export function mockGraph(routes: Route[]) {
  const calls: RecordedCall[] = []
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    const method = (init?.method ?? "GET").toUpperCase()
    const { params, multipart } = await readParams(init)
    for (const [k, v] of url.searchParams) params[k] ??= v
    const isGraph = url.hostname.endsWith("facebook.com")
    const path = isGraph ? url.pathname.replace(/^\/v\d+\.\d+\/?/, "") : url.href
    const call: RecordedCall = { method, url, path, params, multipart }
    calls.push(call)
    for (const [m, p, h] of routes) {
      if (m !== method) continue
      const ok = typeof p === "string" ? p === path : p.test(path)
      if (!ok) continue
      const r = await h(call)
      const headers = new Headers(r.headers ?? {})
      if (r.raw) return new Response(r.raw as BodyInit, { status: r.status ?? 200, headers })
      if (!headers.has("content-type")) headers.set("content-type", "application/json")
      return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status ?? 200, headers })
    }
    throw new Error(`Unmocked request: ${method} ${path} ${JSON.stringify(params)}`)
  })
  vi.stubGlobal("fetch", fetchMock)
  return {
    calls,
    fetchMock,
    /** every POST that is NOT a validate_only call nor a read-only batch (all ops GET) */
    mutatingPosts: () =>
      calls.filter(
        (c) =>
          c.method === "POST" && !(c.params.execution_options ?? "").includes("validate_only") && !isReadOnlyBatch(c)
      ),
  }
}

interface BatchOpLike {
  method: string
  relative_url: string
  body?: string
}

function isReadOnlyBatch(c: RecordedCall): boolean {
  if (c.path !== "" || !c.params.batch) return false
  return (JSON.parse(c.params.batch) as BatchOpLike[]).every((op) => op.method === "GET")
}

/**
 * Graph batch endpoint (`POST /`): GET ops answer from `nodes` (keyed by the id before "?"; missing → 100/33),
 * POST ops answer `onWrite(op)` (default `{success: true}`).
 */
export function batchRoute(nodes: Record<string, unknown>, onWrite: (op: BatchOpLike) => unknown = () => ({ success: true })): Route {
  return [
    "POST",
    "",
    (c) =>
      json(
        (JSON.parse(c.params.batch) as BatchOpLike[]).map((op) => {
          if (op.method !== "GET") return { code: 200, body: JSON.stringify(onWrite(op)) }
          const node = nodes[op.relative_url.split("?")[0]]
          if (node) return { code: 200, body: JSON.stringify(node) }
          const error = { message: "Object does not exist", type: "GraphMethodException", code: 100, error_subcode: 33 }
          return { code: 400, body: JSON.stringify({ error }) }
        })
      ),
  ]
}

export const TEST_TOKEN = "EAAtesttokenvalue0123456789abcdef"

export function providerCtx(
  overrides: Partial<ProviderContext<MetaCredentials>["account"]> = {},
  creds: Partial<MetaCredentials> = {}
): ProviderContext<MetaCredentials> {
  return {
    connectionId: "conn-1",
    credentials: { accessToken: TEST_TOKEN, ...creds },
    connectionMeta: {},
    account: {
      id: "00000000-0000-0000-0000-000000000001",
      externalId: "act_1001",
      name: "Shop VN",
      currency: "VND",
      timezone: "Asia/Ho_Chi_Minh",
      ...overrides,
    },
  }
}
