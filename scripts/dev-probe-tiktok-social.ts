// DEV ONLY - live probe of the TikTok Social MCP server (organic TikTok tools) for the design of 17-tiktok-social.md.
//   ALLOW_DEV_PROBE=1 PROBE_DIR=<scratch dir> tsx scripts/dev-probe-tiktok-social.ts login
//     → registers a client (Dynamic Client Registration, no developer app), prints the TikTok sign-in URL, waits on
//       http://127.0.0.1:53682/callback, exchanges the code (PKCE) and stores the tokens in PROBE_DIR/state.json.
//   ALLOW_DEV_PROBE=1 PROBE_DIR=<dir> tsx scripts/dev-probe-tiktok-social.ts tools
//     → initialize + tools/list, full schemas → PROBE_DIR/tools.json
//   ALLOW_DEV_PROBE=1 PROBE_DIR=<dir> tsx scripts/dev-probe-tiktok-social.ts call <tool> '<json args>'
//     → tools/call, raw result → PROBE_DIR/call-<tool>-<n>.json
//   ALLOW_DEV_PROBE=1 PROBE_DIR=<dir> tsx scripts/dev-probe-tiktok-social.ts refresh
// PROBE_DIR must be outside the repository (tokens are written there). Tokens never printed.
import { createHash, randomBytes } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { join, resolve } from "node:path"

const SERVER = "https://business-api.tiktok.com/open_mcp/tt-ads-mcp-organic-social"
const OAUTH = `${SERVER}/oauth/tiktok`
const REDIRECT = "http://127.0.0.1:53682/callback"

if (process.env.ALLOW_DEV_PROBE !== "1" || process.env.NODE_ENV === "production") throw new Error("dev-probe-tiktok-social: chỉ chạy ở máy dev.")
const dir = process.env.PROBE_DIR ? resolve(process.env.PROBE_DIR) : ""
if (!dir || dir.startsWith(resolve("."))) throw new Error("PROBE_DIR phải là thư mục ngoài repo.")
const statePath = join(dir, "state.json")
type State = { clientId: string; accessToken?: string; refreshToken?: string; expiresAt?: number; scope?: string; sessionId?: string }
const load = (): State => JSON.parse(readFileSync(statePath, "utf8")) as State
const save = (s: State) => writeFileSync(statePath, JSON.stringify(s, null, 2))
const scrub = (txt: string) => {
  if (!existsSync(statePath)) return txt
  const s = load()
  return [s.accessToken, s.refreshToken].reduce((x: string, t) => (t && t.length >= 8 ? x.split(t).join("[redacted]") : x), txt)
}
const b64url = (b: Buffer): string => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

async function register(): Promise<string> {
  const res = await fetch(`${OAUTH}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "ads-mcp-dev-probe",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  })
  const j = (await res.json()) as { client_id?: string }
  if (!j.client_id) throw new Error(`register failed ${res.status} ${JSON.stringify(j)}`)
  return j.client_id
}

async function tokenRequest(body: Record<string, string>) {
  const res = await fetch(`${OAUTH}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  })
  const text = await res.text()
  let j: Record<string, unknown> = {}
  try {
    j = JSON.parse(text) as Record<string, unknown>
  } catch {
    /* non-JSON */
  }
  if (!res.ok || typeof j.access_token !== "string") throw new Error(`token failed ${res.status} ${scrub(text).slice(0, 500)}`)
  // shape only (no token values)
  console.log("token response keys:", Object.keys(j), "expires_in", j.expires_in, "refresh_token_expires_in", j.refresh_token_expires_in)
  console.log("scope:", j.scope)
  return j as { access_token: string; refresh_token?: string; expires_in?: number; scope?: string }
}

async function login() {
  const clientId = existsSync(statePath) ? load().clientId : await register()
  save({ clientId })
  const verifier = b64url(randomBytes(48))
  const challenge = b64url(createHash("sha256").update(verifier).digest())
  const state = b64url(randomBytes(16))
  const url = new URL(`${OAUTH}/authorize`)
  url.search = new URLSearchParams({
    response_type: "code",
    resource: SERVER,
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  }).toString()
  writeFileSync(join(dir, "login-url.txt"), url.toString())
  console.log("Mở http://127.0.0.1:53682/start để đăng nhập TikTok (link đầy đủ ở login-url.txt)")
  const code = await new Promise<string>((done, fail) => {
    const srv = createServer((req, res) => {
      const u = new URL(req.url ?? "/", REDIRECT)
      // short link for the owner: http://127.0.0.1:53682/start → TikTok sign-in
      if (u.pathname === "/start") return void res.writeHead(302, { location: url.toString() }).end()
      if (u.pathname !== "/callback") return void res.writeHead(404).end()
      const params = Object.fromEntries(u.searchParams)
      console.log("callback params:", Object.keys(params), params.error ?? "", params.error_description ?? "")
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<h3>Xong - quay lại Claude Code.</h3>")
      srv.close()
      if (params.state && params.state !== state) return fail(new Error("state mismatch"))
      if (!params.code) return fail(new Error(`no code: ${JSON.stringify(params)}`))
      done(params.code)
    })
    srv.listen(53682, "127.0.0.1")
    setTimeout(() => (srv.close(), fail(new Error("timeout 20 phút"))), 20 * 60_000).unref()
  })
  const t = await tokenRequest({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: clientId })
  save({ clientId, accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: Date.now() + (t.expires_in ?? 0) * 1000, scope: t.scope })
  console.log("Đã lưu token.")
}

async function refresh() {
  const s = load()
  const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: s.refreshToken!, client_id: s.clientId })
  console.log("refresh token rotated:", t.refresh_token !== undefined && t.refresh_token !== s.refreshToken)
  save({ ...s, accessToken: t.access_token, refreshToken: t.refresh_token ?? s.refreshToken, expiresAt: Date.now() + (t.expires_in ?? 0) * 1000 })
}

let rpcId = 1
async function rpc(method: string, params: unknown, notify = false) {
  const s = load()
  const res = await fetch(SERVER, {
    method: "POST",
    headers: {
      authorization: `Bearer ${s.accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(s.sessionId ? { "mcp-session-id": s.sessionId } : {}),
    },
    body: JSON.stringify(notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: rpcId++, method, params }),
  })
  const sid = res.headers.get("mcp-session-id")
  if (sid) save({ ...load(), sessionId: sid })
  const text = await res.text()
  console.log(`${method}: HTTP ${res.status} content-type=${res.headers.get("content-type")} session=${sid ? "yes" : "no"} bytes=${text.length}`)
  if (notify || !text) return null
  const body = res.headers.get("content-type")?.includes("text/event-stream")
    ? text
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .pop() ?? ""
    : text
  try {
    return JSON.parse(body) as Record<string, unknown>
  } catch {
    return { raw: scrub(text).slice(0, 2000) }
  }
}

async function tools() {
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "ads-mcp-dev-probe", version: "0.0.1" },
  })
  writeFileSync(join(dir, "initialize.json"), scrub(JSON.stringify(init, null, 2)))
  await rpc("notifications/initialized", {}, true)
  const list = await rpc("tools/list", {})
  writeFileSync(join(dir, "tools.json"), scrub(JSON.stringify(list, null, 2)))
  const ts = ((list?.result as { tools?: { name: string; description?: string }[] })?.tools ?? []).map((t) => t.name)
  console.log(`${ts.length} tools:`, ts.join(", "))
}

async function call(name: string, argsJson: string) {
  const out = await rpc("tools/call", { name, arguments: JSON.parse(argsJson || "{}") })
  let n = 1
  while (existsSync(join(dir, `call-${name}-${n}.json`))) n++
  const file = join(dir, `call-${name}-${n}.json`)
  writeFileSync(file, scrub(JSON.stringify(out, null, 2)))
  console.log("→", file)
}

const [cmd, a, b] = process.argv.slice(2)
if (cmd === "login") await login()
else if (cmd === "tools") await tools()
else if (cmd === "call") await call(a!, b ?? "{}")
else if (cmd === "refresh") await refresh()
else throw new Error("login | tools | call <tool> '<json>' | refresh")
