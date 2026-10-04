// SSRF guard for URLs supplied by the AI (ads_upload_media): only public http(s) targets.
// - scheme http/https, no userinfo, ports 80/443/8080/8443
// - hostname resolved; every address must be public (blocks loopback, private, link-local, CGNAT,
//   metadata 169.254.169.254, ULA, multicast, documentation, 6to4/Teredo/NAT64 embeddings…)
// - safeFetch() pins the vetted address at connect time (custom `lookup`), so DNS rebinding between
//   check and connect is impossible; redirects are followed manually and re-checked; size/time capped.
// - fetchMediaBytes() downloads a media file ONCE through safeFetch so adapters never fetch
//   AI-supplied URLs themselves (no second, unguarded DNS resolution).
import { lookup as dnsLookup } from "node:dns/promises"
import http from "node:http"
import https from "node:https"
import { BlockList, isIP, type LookupFunction } from "node:net"
import { invalid } from "../mcp/errors"
import { normalizeIp } from "./ip"

// separate lists: Node applies IPv6 rules to IPv4 addresses (as IPv4-mapped), which would make
// "::ffff:0:0/96" block every IPv4 address
const blocked4 = new BlockList()
const blocked6 = new BlockList()
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked4.addSubnet(net, prefix, "ipv4")
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::", 96], // IPv4-compatible (deprecated)
  ["::ffff:0:0", 96], // IPv4-mapped (normalised to v4 before checking, blocked if it slips through)
  ["64:ff9b::", 96], // NAT64
  ["64:ff9b:1::", 48],
  ["100::", 64], // discard
  ["2001::", 23], // IETF protocol assignments incl. Teredo 2001::/32
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4 (can embed private v4)
  ["fc00::", 7], // ULA (incl. fd00:ec2::254 metadata)
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
] as const) {
  blocked6.addSubnet(net, prefix, "ipv6")
}

/** true when the address is not a public unicast address */
export function isBlockedAddress(raw: string): boolean {
  const ip = normalizeIp(raw)
  if (!ip) return true
  return isIP(ip) === 6 ? blocked6.check(ip, "ipv6") : blocked4.check(ip, "ipv4")
}

const ALLOWED_PORTS = new Set(["", "80", "443", "8080", "8443"])
const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa"]

function reject(reason: string): never {
  throw invalid("url_not_allowed", `URL không được phép: ${reason}`, "Chỉ dùng URL http/https công khai (không dùng địa chỉ nội bộ).")
}

/** Validate scheme/host/port and resolve DNS: every address must be public. Returns the parsed URL. */
export async function assertSafeUrl(raw: string, resolver: typeof dnsLookup = dnsLookup): Promise<URL> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    reject("không đúng định dạng")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") reject("chỉ hỗ trợ http/https")
  if (url.username || url.password) reject("không được chứa thông tin đăng nhập")
  if (!ALLOWED_PORTS.has(url.port)) reject("cổng không được phép")
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "")
  if (!host) reject("thiếu tên miền")
  if (host === "localhost" || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s)) || host === "metadata.google.internal") {
    reject("tên miền nội bộ")
  }
  if (isIP(host) !== 0 || normalizeIp(host)) {
    if (isBlockedAddress(host)) reject("địa chỉ IP nội bộ")
    return url
  }
  let addrs: { address: string; family: number }[]
  try {
    addrs = await resolver(host, { all: true, verbatim: true })
  } catch {
    reject("không phân giải được tên miền")
  }
  if (addrs.length === 0) reject("không phân giải được tên miền")
  if (addrs.some((a) => isBlockedAddress(a.address))) reject("tên miền trỏ tới địa chỉ nội bộ")
  return url
}

/** `lookup` for http(s).request that refuses non-public addresses at connect time. */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { all: true, verbatim: true, family: options.family as 0 | 4 | 6 | undefined })
    .then((addrs) => {
      const ok = addrs.filter((a) => !isBlockedAddress(a.address))
      if (ok.length === 0 || ok.length !== addrs.length) {
        const err = Object.assign(new Error("blocked address"), { code: "EBLOCKED" })
        return callback(err as NodeJS.ErrnoException, "", 0)
      }
      if (options.all) return (callback as unknown as (e: null, a: typeof ok) => void)(null, ok)
      callback(null, ok[0]!.address, ok[0]!.family)
    })
    .catch((e: NodeJS.ErrnoException) => callback(e, "", 0))
}

export interface SafeFetchResult {
  status: number
  headers: http.IncomingHttpHeaders
  finalUrl: string
  body: Buffer | null
}

export interface SafeFetchOptions {
  method?: "GET" | "HEAD"
  headers?: Record<string, string>
  timeoutMs?: number
  maxBytes?: number
  maxRedirects?: number
  /** read the body (GET) - false: stop after headers */
  readBody?: boolean
  signal?: AbortSignal
  /** overall deadline for all hops incl. body (the socket `timeoutMs` is an idle timeout) */
  totalTimeoutMs?: number
}

function requestOnce(url: URL, o: SafeFetchOptions): Promise<SafeFetchResult> {
  const mod = url.protocol === "https:" ? https : http
  const maxBytes = o.maxBytes ?? 10 * 1024 * 1024
  return new Promise((resolve, reject) => {
    const req = mod.request(
      url,
      {
        method: o.method ?? "GET",
        headers: { "user-agent": "ads-mcp-noti/1.0 (+media-fetch)", ...o.headers },
        lookup: url.hostname && isIP(url.hostname.replace(/^\[|\]$/g, "")) ? undefined : guardedLookup,
        timeout: o.timeoutMs ?? 15_000,
        signal: o.signal,
      },
      (res) => {
        const base = { status: res.statusCode ?? 0, headers: res.headers, finalUrl: url.toString() }
        if (!o.readBody || (o.method ?? "GET") === "HEAD") {
          res.resume()
          req.destroy()
          return resolve({ ...base, body: null })
        }
        const chunks: Buffer[] = []
        let size = 0
        res.on("data", (c: Buffer) => {
          size += c.length
          if (size > maxBytes) {
            req.destroy(Object.assign(new Error("too large"), { code: "ETOOLARGE" }))
            return
          }
          chunks.push(c)
        })
        res.on("end", () => resolve({ ...base, body: Buffer.concat(chunks) }))
        res.on("error", reject)
      }
    )
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })))
    req.on("error", reject)
    req.end()
  })
}

/** Fetch a public URL with the SSRF guard on every hop. */
export async function safeFetch(raw: string, o: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  let url = await assertSafeUrl(raw)
  const maxRedirects = o.maxRedirects ?? 3
  const deadline = o.totalTimeoutMs ? AbortSignal.timeout(o.totalTimeoutMs) : null
  const signal = deadline ? (o.signal ? AbortSignal.any([o.signal, deadline]) : deadline) : o.signal
  for (let hop = 0; ; hop++) {
    let res: SafeFetchResult
    try {
      res = await requestOnce(url, { ...o, signal })
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code
      if (code === "EBLOCKED") reject("tên miền trỏ tới địa chỉ nội bộ")
      if (code === "ETOOLARGE") throw invalid("media_too_large", "Tệp vượt quá dung lượng cho phép.")
      if (code === "ETIMEDOUT" || deadline?.aborted) throw invalid("media_timeout", "Tải URL quá thời gian chờ.")
      throw invalid("media_fetch_failed", "Không tải được URL.", "Kiểm tra URL có truy cập công khai được không.")
    }
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      if (hop >= maxRedirects) throw invalid("too_many_redirects", "URL chuyển hướng quá nhiều lần.")
      url = await assertSafeUrl(new URL(res.headers.location, url).toString())
      continue
    }
    return res
  }
}

export const MEDIA_LIMITS = {
  image: { maxBytes: 30 * 1024 * 1024, types: /^image\// },
  video: { maxBytes: 500 * 1024 * 1024, types: /^video\// },
} as const

export interface MediaProbe {
  finalUrl: string
  contentType: string | null
  contentLength: number | null
  warnings: string[]
}

/** Check that a media URL is public, reachable, of the right type and within size limits. */
export async function probeMedia(raw: string, type: "image" | "video", signal?: AbortSignal): Promise<MediaProbe> {
  const limits = MEDIA_LIMITS[type]
  let res = await safeFetch(raw, { method: "HEAD", timeoutMs: 15_000, signal })
  if (res.status === 405 || res.status === 403 || res.status === 501) {
    res = await safeFetch(raw, { method: "GET", headers: { range: "bytes=0-0" }, timeoutMs: 15_000, readBody: false, signal })
  }
  if (res.status >= 400) {
    throw invalid("media_unreachable", `URL trả về HTTP ${res.status}.`, "Dùng URL công khai tải trực tiếp được tệp ảnh/video.")
  }
  const warnings: string[] = []
  const contentType = (res.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase() || null
  if (contentType && !limits.types.test(contentType)) {
    if (contentType === "application/octet-stream" || contentType === "binary/octet-stream") {
      warnings.push("Máy chủ không báo đúng loại tệp (octet-stream); nền tảng sẽ tự kiểm tra định dạng.")
    } else {
      throw invalid("media_wrong_type", `URL không phải ${type === "image" ? "ảnh" : "video"} (Content-Type: ${contentType}).`)
    }
  }
  let contentLength: number | null = null
  const range = res.headers["content-range"]
  const total = typeof range === "string" ? /\/(\d+)$/.exec(range)?.[1] : undefined
  const len = total ?? (res.status === 206 ? undefined : res.headers["content-length"])
  if (len !== undefined && /^\d+$/.test(String(len))) contentLength = Number(len)
  if (contentLength !== null && contentLength > limits.maxBytes) {
    throw invalid(
      "media_too_large",
      `Tệp ${(contentLength / 1024 / 1024).toFixed(1)} MB vượt giới hạn ${limits.maxBytes / 1024 / 1024} MB.`
    )
  }
  if (contentLength === null) warnings.push("Không xác định được dung lượng tệp trước khi tải.")
  return { finalUrl: res.finalUrl, contentType, contentLength, warnings }
}

/** Image type from magic bytes (the server's Content-Type is not trusted). */
export function sniffImageMime(b: Uint8Array): string | null {
  const ascii = (from: number, to: number) => Buffer.from(b.subarray(from, to)).toString("latin1")
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg"
  if (b.length >= 8 && Buffer.from(b.subarray(0, 8)).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png"
  if (b.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return "image/gif"
  if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp"
  if (b.length >= 2 && ascii(0, 2) === "BM") return "image/bmp"
  if (b.length >= 4 && (ascii(0, 4) === "II*\u0000" || ascii(0, 4) === "MM\u0000*")) return "image/tiff"
  return null
}

export interface MediaBytes {
  bytes: Uint8Array
  /** sniffed from the content */
  contentType: string
  finalUrl: string
}

/**
 * Download an image ONCE with the SSRF guard on every hop (pinned, re-validated addresses), a size cap,
 * an overall deadline and a magic-byte check. Adapters receive these bytes and never fetch the URL.
 */
export async function fetchMediaBytes(raw: string, o: { maxBytes?: number; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<MediaBytes> {
  const maxBytes = o.maxBytes ?? MEDIA_LIMITS.image.maxBytes
  const res = await safeFetch(raw, { method: "GET", readBody: true, maxBytes, timeoutMs: 15_000, totalTimeoutMs: o.timeoutMs ?? 60_000, signal: o.signal })
  if (res.status < 200 || res.status >= 300 || !res.body) {
    throw invalid("media_unreachable", `URL trả về HTTP ${res.status}.`, "Dùng URL công khai tải trực tiếp được tệp ảnh.")
  }
  if (res.body.length === 0) throw invalid("media_empty", "URL không trả nội dung.")
  const contentType = sniffImageMime(res.body)
  if (!contentType) throw invalid("media_wrong_type", "Tệp tải về không phải ảnh hợp lệ (JPG/PNG/GIF/WEBP/BMP/TIFF).")
  return { bytes: new Uint8Array(res.body), contentType, finalUrl: res.finalUrl }
}
