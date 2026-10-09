// safeFetch transport rules (no real target is ever reached): an env proxy (NODE_USE_ENV_PROXY + HTTPS_PROXY, Node 24
// built-in proxy support on the GLOBAL agents) must never carry a guarded request - the proxy would resolve the host
// itself and bypass the IP pinning; non-2xx bodies are never buffered; the overall deadline also bounds the DNS
// checks (first URL and every redirect hop).
import { EventEmitter } from "node:events"
import http from "node:http"
import https from "node:https"
import net from "node:net"
import { Readable } from "node:stream"
import { afterEach, describe, expect, it, vi } from "vitest"

import { safeFetch } from "./ssrf"

type RequestCallback = (res: http.IncomingMessage) => void

interface FakeHop {
  status: number
  headers?: Record<string, string>
  body?: string
}

/** http.request replaced: answers the given hops in order, records the options and each response stream */
function fakeHttp(hops: FakeHop[]) {
  const calls: { url: string; opts: http.RequestOptions }[] = []
  const responses: Readable[] = []
  let i = 0
  const spy = vi.spyOn(http, "request").mockImplementation(((
    url: URL,
    opts: http.RequestOptions,
    cb: RequestCallback
  ) => {
    calls.push({ url: String(url), opts })
    const hop = hops[i++]!
    const req = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
      end: () => {
        const res = Object.assign(
          Readable.from([Buffer.from(hop.body ?? "")]),
          { statusCode: hop.status, headers: hop.headers ?? {} }
        )
        vi.spyOn(res, "resume")
        responses.push(res)
        queueMicrotask(() => cb(res as unknown as http.IncomingMessage))
      },
    })
    return req as unknown as http.ClientRequest
  }) as unknown as typeof http.request)
  return { calls, responses, spy }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("safeFetch: env proxy never carries a guarded request (IP pinning)", () => {
  it("each request uses an explicit agent, never the (possibly proxied) global agent", async () => {
    const { calls } = fakeHttp([{ status: 200, body: "ok" }])
    await safeFetch("http://93.184.216.34/a.png", { readBody: true })
    const agent = calls[0]!.opts.agent
    expect(agent).toBeInstanceOf(http.Agent)
    expect(agent).not.toBe(http.globalAgent)
  })

  it("a global https agent configured with HTTPS_PROXY receives no connection", async () => {
    let proxied = 0
    const proxy = net.createServer((s) => {
      proxied++
      s.destroy()
    })
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r))
    const port = (proxy.address() as net.AddressInfo).port
    const mod = https as unknown as { globalAgent: https.Agent }
    const saved = mod.globalAgent
    // what NODE_USE_ENV_PROXY=1 + HTTPS_PROXY does to the global agent at startup (Node ≥ 24.5)
    mod.globalAgent = new https.Agent({
      proxyEnv: { HTTPS_PROXY: `http://127.0.0.1:${port}` },
    } as https.AgentOptions)
    try {
      // public IP literal: no DNS; the direct connection may fail offline - only the proxy matters here
      await safeFetch("https://93.184.216.34/a.png", {
        timeoutMs: 300,
        totalTimeoutMs: 800,
      }).catch(() => null)
      expect(proxied).toBe(0)
    } finally {
      mod.globalAgent.destroy()
      mod.globalAgent = saved
      await new Promise((r) => proxy.close(r))
    }
  })
})

describe("safeFetch: response bodies", () => {
  it("4xx / 5xx / 3xx without location: status only, body never buffered (stream resumed)", async () => {
    for (const status of [404, 500, 302]) {
      const { responses } = fakeHttp([{ status, body: "x".repeat(4096) }])
      const r = await safeFetch("http://93.184.216.34/a.png", {
        readBody: true,
      })
      expect(r.status).toBe(status)
      expect(r.body).toBeNull()
      expect(responses[0]!.resume).toHaveBeenCalled()
      expect(responses[0]!.listenerCount("data")).toBe(0)
      vi.restoreAllMocks()
    }
  })

  it("2xx: the body is read (size cap unchanged)", async () => {
    fakeHttp([{ status: 200, body: "hello" }])
    const r = await safeFetch("http://93.184.216.34/a.png", { readBody: true })
    expect(r.body?.toString()).toBe("hello")
  })

  it("redirect bodies are not buffered either; the next hop is followed", async () => {
    const { responses, calls } = fakeHttp([
      {
        status: 302,
        headers: { location: "http://93.184.216.35/b.png" },
        body: "moved",
      },
      { status: 200, body: "img" },
    ])
    const r = await safeFetch("http://93.184.216.34/a.png", { readBody: true })
    expect(calls.map((c) => c.url)).toEqual([
      "http://93.184.216.34/a.png",
      "http://93.184.216.35/b.png",
    ])
    expect(responses[0]!.listenerCount("data")).toBe(0)
    expect(r.body?.toString()).toBe("img")
  })
})

describe("safeFetch: the overall deadline bounds DNS too", () => {
  const hanging = (() => new Promise(() => {})) as never

  it("first URL: a resolver that never answers ends with media_timeout at the deadline", async () => {
    const t0 = Date.now()
    await expect(
      safeFetch("https://slow-dns.example/a.png", {
        resolver: hanging,
        totalTimeoutMs: 200,
      })
    ).rejects.toMatchObject({ code: "media_timeout" })
    expect(Date.now() - t0).toBeLessThan(2_000)
  })

  it("redirect hop: the DNS check of the new host is bounded by the same deadline", async () => {
    fakeHttp([
      {
        status: 301,
        headers: { location: "https://slow-dns.example/b.png" },
      },
    ])
    const t0 = Date.now()
    await expect(
      safeFetch("http://93.184.216.34/a.png", {
        resolver: hanging,
        totalTimeoutMs: 250,
      })
    ).rejects.toMatchObject({ code: "media_timeout" })
    expect(Date.now() - t0).toBeLessThan(2_000)
  })

  it("an already aborted signal stops before any DNS lookup", async () => {
    const resolver = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
    ])
    await expect(
      safeFetch("https://cdn.example/a.png", {
        resolver: resolver as never,
        signal: AbortSignal.abort(),
      })
    ).rejects.toMatchObject({ code: "media_timeout" })
    expect(resolver).not.toHaveBeenCalled()
  })
})
