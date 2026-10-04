import http from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { httpJson } from "./http"

const servers: http.Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))))
})

function listen(handler: http.RequestListener): Promise<string> {
  const s = http.createServer(handler)
  servers.push(s)
  return new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)))
}

describe("httpJson redirects", () => {
  it("never follows a redirect, so platform auth headers are not replayed to another origin", async () => {
    const seen: http.IncomingHttpHeaders[] = []
    const target = await listen((req, res) => {
      seen.push(req.headers)
      res.end("{}")
    })
    const origin = await listen((_req, res) => {
      res.writeHead(302, { location: `${target}/steal` })
      res.end()
    })
    await expect(
      httpJson({ platform: "openai_ads", method: "GET", url: `${origin}/v1/x`, headers: { "Access-Token": "secret-token" }, retries: 0 })
    ).rejects.toMatchObject({ code: "upstream_error", retryable: false })
    expect(seen).toHaveLength(0)
  })

  it("still returns normal responses", async () => {
    const origin = await listen((_req, res) => {
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ ok: true }))
    })
    const r = await httpJson<{ ok: boolean }>({ platform: "meta", method: "GET", url: `${origin}/v1/me`, retries: 0 })
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
  })
})
