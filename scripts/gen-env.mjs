#!/usr/bin/env node
// Tạo file .env từ .env.example với secret ngẫu nhiên.
// Dùng: node scripts/gen-env.mjs [--dev] [--force] [--print] [--domain <tên miền>] [--email <email>]
//   --dev            : cấu hình chạy local (localhost:3000, Postgres qua docker-compose.dev.yml)
//   --force          : ghi đè .env đã có
//   --print          : in nội dung ra màn hình thay vì ghi file .env
//   --domain <d>     : điền APP_DOMAIN và BETTER_AUTH_URL=https://<d> (production)
//   --email <e>      : điền ACME_EMAIL (email nhận thông báo Let's Encrypt)
//   --no-updater     : KHÔNG bật cập nhật tự động (COMPOSE_PROFILES để trống; xem docs 07-deployment §6)
//   --ssl <p>        : phương án HTTPS (docs/deploy-vps.md): auto (mặc định, Caddy tự xin chứng chỉ) |
//                      cloudflare (sau proxy Cloudflare, chứng chỉ Origin CA) | nginx (Nginx + Certbot trên máy chủ) |
//                      tunnel (Cloudflare Tunnel; sau đó dán TUNNEL_TOKEN vào .env)
// HOST_PROJECT_DIR (đường dẫn thư mục dự án trên máy chủ) lấy từ biến môi trường cùng tên hoặc thư mục hiện tại.
// APP_VERSION (tag image sẽ kéo) = package.json#version (production).
// VPS chưa cài Node: dùng `sh scripts/gen-secrets.sh` với cùng tham số.
import { randomBytes } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"

// --ssl -> biến của docker-compose.yml (giữ đồng bộ với SSL_PRESETS trong scripts/gen-secrets.sh).
// Mọi preset đặt ĐỦ các biến (giá trị mặc định khi không dùng) để đổi phương án không để sót giá trị cũ.
const CADDY_PUBLIC = { CADDY_SITE_SCHEME: "", CADDY_HTTP_PORT_BIND: "80", CADDY_HTTPS_PORT_BIND: "443", CLOUDFLARED_REPLICAS: "0" }
const SSL_PRESETS = {
  auto: { CADDY_REPLICAS: "1", CADDY_CLIENT_IP: "direct", CADDY_TLS: "auto", WEB_HOST_PORT: "", ...CADDY_PUBLIC },
  cloudflare: { CADDY_REPLICAS: "1", CADDY_CLIENT_IP: "cloudflare", CADDY_TLS: "cloudflare-origin", WEB_HOST_PORT: "", ...CADDY_PUBLIC },
  nginx: { CADDY_REPLICAS: "0", CADDY_CLIENT_IP: "direct", CADDY_TLS: "auto", WEB_HOST_PORT: "3000", ...CADDY_PUBLIC },
  // D: cloudflared -> http://caddy:80 trong mạng Docker; Caddy chỉ mở trên loopback (cổng ngẫu nhiên). TUNNEL_TOKEN
  // do người vận hành dán từ dashboard Cloudflare (script không sinh token).
  tunnel: {
    CADDY_REPLICAS: "1",
    CADDY_CLIENT_IP: "tunnel",
    CADDY_TLS: "tunnel",
    WEB_HOST_PORT: "",
    CADDY_SITE_SCHEME: "http://",
    CADDY_HTTP_PORT_BIND: "127.0.0.1:",
    CADDY_HTTPS_PORT_BIND: "127.0.0.1:",
    CLOUDFLARED_REPLICAS: "1",
  },
}

function parseArgs(argv) {
  const flags = new Set()
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const m = /^--(domain|email|ssl)(?:=(.*))?$/.exec(a)
    if (m) {
      const v = m[2] ?? argv[++i]
      if (!v || v.startsWith("--")) fail(`Thiếu giá trị cho --${m[1]}`)
      opts[m[1]] = v.trim()
    } else if (["--dev", "--force", "--print", "--no-updater"].includes(a)) {
      flags.add(a.slice(2))
    } else {
      fail(`Tham số không hợp lệ: ${a}`)
    }
  }
  return { flags, opts }
}

function fail(msg) {
  console.error(msg)
  process.exit(1)
}

const { flags, opts } = parseArgs(process.argv.slice(2))
const dev = flags.has("dev")
const print = flags.has("print")

if (opts.domain !== undefined) {
  opts.domain = opts.domain.replace(/^https?:\/\//, "").replace(/\/+$/, "").toLowerCase()
  if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(opts.domain)) {
    fail(`Tên miền không hợp lệ: ${opts.domain} (ví dụ đúng: mcp.congty.vn)`)
  }
}
if (opts.email !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(opts.email)) {
  fail(`Email không hợp lệ: ${opts.email}`)
}
if (opts.ssl !== undefined && !Object.hasOwn(SSL_PRESETS, opts.ssl)) {
  fail(`--ssl phải là một trong: ${Object.keys(SSL_PRESETS).join(", ")}`)
}
if (dev && opts.ssl !== undefined) fail("--ssl chỉ dùng cho production (không dùng với --dev)")
if (!print && existsSync(".env") && !flags.has("force")) {
  fail(".env đã tồn tại. Dùng --force để ghi đè (nhớ giữ lại ENCRYPTION_KEYS cũ nếu đã có dữ liệu!).")
}
if (!existsSync(".env.example")) fail("Không tìm thấy .env.example — hãy chạy lệnh ở thư mục gốc của dự án.")

// Đường dẫn dự án trên máy chủ cho service updater: chỉ nhận đường dẫn POSIX tuyệt đối đơn giản.
const projectDirCandidate = (process.env.HOST_PROJECT_DIR || process.cwd()).replace(/\/+$/, "")
const projectDir = /^\/[A-Za-z0-9._/-]+$/.test(projectDirCandidate) && !projectDirCandidate.split("/").includes("..") ? projectDirCandidate : ""
const updaterOn = !dev && !flags.has("no-updater")

const b64 = (n = 32) => randomBytes(n).toString("base64")
const pg = randomBytes(18).toString("base64url")

// Tag image phát hành = package.json#version (chỉ nhận x.y.z; bản khác -> để trống = latest)
let appVersion = ""
try {
  const v = JSON.parse(readFileSync("package.json", "utf8")).version
  if (typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v)) appVersion = v
} catch {
  // không có package.json hợp lệ: giữ trống
}

const values = {
  BETTER_AUTH_SECRET: b64(),
  ENCRYPTION_KEYS: `1:${b64()}`,
  MCP_KEY_PEPPER: b64(),
  SETUP_TOKEN: randomBytes(24).toString("base64url"),
  POSTGRES_PASSWORD: pg,
  DATABASE_URL: `postgres://adsmcp:${pg}@${dev ? "localhost:5433" : "db:5432"}/adsmcp`,
  ...(dev
    ? { APP_DOMAIN: "localhost", BETTER_AUTH_URL: "http://localhost:3000", ACME_EMAIL: "dev@localhost" }
    : {}),
  ...(!dev && opts.domain ? { APP_DOMAIN: opts.domain, BETTER_AUTH_URL: `https://${opts.domain}` } : {}),
  ...(!dev && opts.email ? { ACME_EMAIL: opts.email } : {}),
  COMPOSE_PROFILES: updaterOn ? "updater" : "",
  ...(!dev && projectDir ? { HOST_PROJECT_DIR: projectDir } : {}),
  ...(!dev && appVersion ? { APP_VERSION: appVersion } : {}),
  ...(!dev ? SSL_PRESETS[opts.ssl ?? "auto"] : {}),
}

const out = readFileSync(".env.example", "utf8")
  .split(/\r?\n/)
  .map((line) => {
    const m = /^([A-Z0-9_]+)=/.exec(line)
    return m && m[1] in values ? `${m[1]}=${values[m[1]]}` : line
  })
  .join("\n")

if (print) {
  process.stdout.write(out.endsWith("\n") ? out : out + "\n")
} else {
  writeFileSync(".env", out, { mode: 0o600 })
  console.log(`Đã tạo .env${dev ? " (dev)" : ""}. SETUP_TOKEN và các khoá nằm trong file này — hãy sao lưu ENCRYPTION_KEYS riêng.`)
  if (updaterOn && !projectDir) {
    console.log("Cập nhật tự động đã bật nhưng chưa xác định được HOST_PROJECT_DIR (cần đường dẫn Linux tuyệt đối, vd /opt/ads-mcp). Hãy điền vào .env hoặc chạy lại trên VPS.")
  }
  if (!dev && !opts.domain) {
    console.log("Nhớ sửa APP_DOMAIN, BETTER_AUTH_URL, ACME_EMAIL trong .env (hoặc chạy lại với --domain/--email --force).")
  }
  if (!dev) {
    console.log(`Phương án HTTPS: ${opts.ssl ?? "auto"} · APP_VERSION=${appVersion || "(trống = latest)"} - xem docs/deploy-vps.md.`)
  }
  if (opts.ssl === "tunnel") {
    console.log("Cloudflare Tunnel: dán token của tunnel vào dòng TUNNEL_TOKEN= trong .env (xem docs/deploy-vps.md, Phương án D).")
  }
}
