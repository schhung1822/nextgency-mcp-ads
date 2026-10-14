// Runtime environment, validated with zod. Read lazily so `next build` does not need secrets.
// Never import this from client components.
import { z } from "zod"

/** Minimum length of SETUP_TOKEN when set (gen-env.mjs makes 32 chars). Shorter = guessable. */
export const SETUP_TOKEN_MIN_LENGTH = 24

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

/** Production must serve auth over HTTPS (Secure cookies); loopback is allowed for local smoke tests. */
export function isAcceptableAuthUrl(url: string, nodeEnv: string | undefined): boolean {
  if (nodeEnv !== "production") return true
  try {
    const u = new URL(url)
    return u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname))
  } catch {
    return false
  }
}

/** Same rule as src/server/providers/tiktok/client.ts: https only, no credentials/query/fragment (tokens go there). */
export function isSafeHttpsBaseUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    return u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash
  } catch {
    return false
  }
}

/** Same rule as src/server/notifications/telegram.ts (the bot token travels in the URL path). */
export function isSafeTelegramBaseUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    if (u.username || u.password || u.search || u.hash) return false
    return u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname))
  } catch {
    return false
  }
}

const baseSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_DOMAIN: z.string().min(1).default("localhost"),
  BETTER_AUTH_URL: z.url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL chưa được cấu hình"),
  BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET phải dài ít nhất 32 ký tự"),
  ENCRYPTION_KEYS: z.string().min(1, "ENCRYPTION_KEYS chưa được cấu hình"),
  MCP_KEY_PEPPER: z.string().min(32, "MCP_KEY_PEPPER phải dài ít nhất 32 ký tự"),
  SETUP_TOKEN: z
    .string()
    .optional()
    .refine((v) => !v || v.trim() === "" || v.trim().length >= SETUP_TOKEN_MIN_LENGTH, {
      message: `SETUP_TOKEN phải dài ít nhất ${SETUP_TOKEN_MIN_LENGTH} ký tự (sinh bằng: node scripts/gen-env.mjs hoặc openssl rand -base64 24)`,
    }),
  LOG_RETENTION_MONTHS: z.coerce.number().int().min(1).max(24).default(3),
  APP_TIMEZONE: z.string().default("Asia/Ho_Chi_Minh"),
  META_API_VERSION: z.string().default("v26.0"),
  GOOGLE_ADS_API_VERSION: z.string().default("v25"),
  TIKTOK_API_VERSION: z.string().default("v1.3"),
  OPENAI_ADS_API_VERSION: z.string().default("v1"),
  /** TikTok API base (sandbox: https://sandbox-ads.tiktok.com/open_api); https only; unset = production */
  TIKTOK_BASE_URL: z
    .string()
    .optional()
    .refine((v) => !v || v.trim() === "" || isSafeHttpsBaseUrl(v.trim()), {
      message: "TIKTOK_BASE_URL phải là địa chỉ https://, không kèm user/mật khẩu hay query",
    }),
  /** Apify API base (tests / a sandbox double): https only, no credentials / query; unset = https://api.apify.com */
  APIFY_API_BASE_URL: z
    .string()
    .optional()
    .refine((v) => !v || v.trim() === "" || isSafeHttpsBaseUrl(v.trim()), {
      message: "APIFY_API_BASE_URL phải là địa chỉ https://, không kèm user/mật khẩu hay query",
    }),
  /** Telegram Bot API base (notification channels): https only (http for localhost); unset = https://api.telegram.org */
  TELEGRAM_API_BASE_URL: z
    .string()
    .optional()
    .refine((v) => !v || v.trim() === "" || isSafeTelegramBaseUrl(v.trim()), {
      message: "TELEGRAM_API_BASE_URL phải là địa chỉ https:// (http chỉ cho localhost), không kèm user/mật khẩu hay query",
    }),
})

const schema = baseSchema.superRefine((v, ctx) => {
  if (!isAcceptableAuthUrl(v.BETTER_AUTH_URL, v.NODE_ENV)) {
    ctx.addIssue({
      code: "custom",
      path: ["BETTER_AUTH_URL"],
      message: "Production bắt buộc BETTER_AUTH_URL dạng https:// (cookie Secure, Caddy cấp HTTPS)",
    })
  }
})

export type Env = z.infer<typeof schema>

/** .env.example ships `change-me` as the PostgreSQL password: warn (do not refuse, existing installs keep running). */
export function hasSamplePostgresPassword(databaseUrl: string): boolean {
  return databaseUrl.includes(":change-me@")
}

let cached: Env | undefined

/** Validate an environment object (tests, startup). */
export function parseEnv(source: Record<string, string | undefined>) {
  return schema.safeParse(source)
}

export function env(): Env {
  if (cached) return cached
  const parsed = parseEnv(process.env)
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n")
    throw new Error(`Cấu hình môi trường không hợp lệ:\n${msg}`)
  }
  cached = parsed.data
  if (hasSamplePostgresPassword(cached.DATABASE_URL)) {
    console.warn("[env] CẢNH BÁO: Mật khẩu PostgreSQL đang là giá trị mẫu change-me — đổi ngay")
  }
  return cached
}

/** Public base URL without trailing slash, e.g. https://ads.example.com */
export function appBaseUrl(): string {
  return env().BETTER_AUTH_URL.replace(/\/+$/, "")
}

export function isProduction() {
  return process.env.NODE_ENV === "production"
}
