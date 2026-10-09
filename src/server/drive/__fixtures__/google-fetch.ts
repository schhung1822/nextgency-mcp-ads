// Test-only fetch mock for Google Drive / Sheets / OAuth token calls (no real network in automated tests).
import { generateKeyPairSync } from "node:crypto"
import { vi } from "vitest"
import type { DriveAuth, GoogleServiceAccount } from "../types"

export interface GoogleCall {
  url: URL
  method: string
  headers: Record<string, string>
  body: string | null
  signal: AbortSignal | null
}

export type Responder = (call: GoogleCall) => Response | Promise<Response>

export interface GoogleFetchMock {
  calls: GoogleCall[]
  /** calls other than the token endpoint */
  api: () => GoogleCall[]
  tokenCalls: () => GoogleCall[]
  /** persistent handler (checked after queued ones, last added first) */
  on: (match: (c: GoogleCall) => boolean, respond: Responder) => void
  /** one-shot handler, first in first out */
  once: (match: (c: GoogleCall) => boolean, respond: Responder) => void
}

export const isToken = (c: GoogleCall) =>
  c.url.href.startsWith("https://oauth2.googleapis.com/token")

export function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

/** Google API error body */
export function googleError(
  status: number,
  reason: string | null,
  o: { message?: string; status?: string; details?: string[] } = {}
): Response {
  return json(
    {
      error: {
        code: status,
        message: o.message ?? `error ${reason ?? status}`,
        status: o.status,
        errors: reason ? [{ domain: "global", reason, message: "x" }] : [],
        details: (o.details ?? []).map((r) => ({
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason: r,
        })),
      },
    },
    status
  )
}

/** a body streamed in the given chunks */
export function streamResponse(
  chunks: Uint8Array[],
  status = 200,
  headers: Record<string, string> = {}
): Response {
  let i = 0
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(ctl) {
        if (i < chunks.length) ctl.enqueue(chunks[i++]!)
        else ctl.close()
      },
    }),
    { status, headers }
  )
}

export function mockGoogleFetch(
  opts: { expiresIn?: number } = {}
): GoogleFetchMock {
  const calls: GoogleCall[] = []
  const persistent: {
    match: (c: GoogleCall) => boolean
    respond: Responder
  }[] = []
  const queued: { match: (c: GoogleCall) => boolean; respond: Responder }[] = []
  let tokenN = 0
  const fn = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input))
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(
        (init?.headers as Record<string, string>) ?? {}
      ))
        headers[k.toLowerCase()] = v
      const body =
        typeof init?.body === "string"
          ? init.body
          : init?.body instanceof URLSearchParams
            ? init.body.toString()
            : null
      const call: GoogleCall = {
        url,
        method: init?.method ?? "GET",
        headers,
        body,
        signal: init?.signal ?? null,
      }
      calls.push(call)
      if (call.signal?.aborted) throw new DOMException("aborted", "AbortError")
      const qi = queued.findIndex((q) => q.match(call))
      if (qi >= 0) return queued.splice(qi, 1)[0]!.respond(call)
      for (let i = persistent.length - 1; i >= 0; i--)
        if (persistent[i]!.match(call)) return persistent[i]!.respond(call)
      if (isToken(call)) {
        tokenN++
        return json({
          access_token: `ya29.test-token-${tokenN}`,
          expires_in: opts.expiresIn ?? 3599,
          token_type: "Bearer",
        })
      }
      return json({ error: { code: 599, message: "unmocked" } }, 599)
    }
  )
  vi.stubGlobal("fetch", fn)
  return {
    calls,
    api: () => calls.filter((c) => !isToken(c)),
    tokenCalls: () => calls.filter(isToken),
    on: (match, respond) => persistent.push({ match, respond }),
    once: (match, respond) => queued.push({ match, respond }),
  }
}

/** a fetch that only settles when its signal aborts (timeouts) */
export function hangUntilAborted(call: GoogleCall): Promise<Response> {
  return new Promise((_, reject) => {
    const s = call.signal
    if (!s) return
    s.addEventListener(
      "abort",
      () => reject(new DOMException("aborted", "AbortError")),
      { once: true }
    )
  })
}

let keyPair: { privateKey: string; publicKey: string } | null = null
export function testKeyPair() {
  keyPair ??= generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  })
  return keyPair
}

export const SA_EMAIL = "drive-bot@demo-project.iam.gserviceaccount.com"

export function testServiceAccount(
  over: Partial<GoogleServiceAccount> = {}
): GoogleServiceAccount {
  return {
    clientEmail: SA_EMAIL,
    privateKey: testKeyPair().privateKey,
    privateKeyId: "kid-drive-1",
    projectId: "demo-project",
    ...over,
  }
}

export function saJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "service_account",
    project_id: "demo-project",
    private_key_id: "kid-drive-1",
    private_key: testKeyPair().privateKey,
    client_email: SA_EMAIL,
    client_id: "123",
    token_uri: "https://evil.example/token",
    ...over,
  })
}

// built at runtime so secret scanners do not flag this obviously fake key in the repository
export const TEST_API_KEY = ["AI", "za", "SyTESTKEY0123456789abcdefghijklmnop"].join("")

export function saAuth(cacheKey = "drive_credential:test"): DriveAuth {
  return { type: "service_account", sa: testServiceAccount(), cacheKey }
}

export function keyAuth(): DriveAuth {
  return { type: "api_key", apiKey: TEST_API_KEY }
}

export const FILE_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz012345"

/** a raw Drive v3 File resource */
export function rawFile(
  over: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: FILE_ID,
    name: "banner tuần 41.jpg",
    mimeType: "image/jpeg",
    size: "204800",
    md5Checksum: "0123456789abcdef0123456789abcdef",
    headRevisionId: "rev-1",
    version: "7",
    modifiedTime: "2026-10-08T03:00:00.000Z",
    parents: ["folderParent0001"],
    trashed: false,
    imageMediaMetadata: { width: 1080, height: 1080 },
    capabilities: { canDownload: true, canEdit: false },
    ...over,
  }
}
