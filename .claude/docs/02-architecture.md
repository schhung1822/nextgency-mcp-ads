# Kiến trúc & stack

> Phiên bản đã kiểm tra trên npm/GitHub ngày 2026-10-02. Khi khởi tạo dự án, dùng đúng các version dưới (hoặc patch mới hơn cùng minor). Nâng **major** phải hỏi chủ dự án.

## 1. Stack
| Lớp | Lựa chọn | Version |
|---|---|---|
| Runtime | Node.js LTS | **24.x** (`node:24-slim`); chuyển 26 sau 2026-10-28 |
| Package manager | pnpm (corepack, ghim trong `packageManager`) | 10.x |
| Framework | **Next.js App Router** (Turbopack mặc định) | **16.3.8** (bản vá bảo mật SSRF — không dùng < 16.3.8) |
| UI runtime | React / React DOM | 19.x (theo create-next-app 16.3.8) |
| Ngôn ngữ | TypeScript strict | 5.9.x (typescript-eslint chưa hỗ trợ TS ≥ 6.1) |
| CSS | Tailwind CSS v4 + `tw-animate-css` | 4.3.x |
| Component | **shadcn/ui** (CLI `shadcn@4.21.x`, primitives **Radix** `-b radix`, preset `maia`) + icon **Hugeicons** (theo preset; không dùng lucide) | — |
| Theme | `next-themes` (class) | 0.4.6 |
| Bảng | `@tanstack/react-table` **v9** (API `useTable` + `tableFeatures`) | 9.2.x |
| Biểu đồ | shadcn `chart` + `recharts` | 3.x |
| Form | `react-hook-form` + `@hookform/resolvers` + **zod v4** (shadcn `field` + `Controller`; component `form` cũ đã rỗng) | 7.89 / 5.9 / 4.6 |
| Toast / OTP | `sonner` / `input-otp` | 2.x / 1.5 |
| Auth | **Better Auth** (`emailAndPassword` + `twoFactor` + `admin` + `nextCookies`) + `@better-auth/drizzle-adapter`; CLI `npx auth@latest generate` | **1.7.7** |
| ORM | **Drizzle ORM** + drizzle-kit + `pg` | 0.45.3 / 0.31.11 / 8.23 (KHÔNG dùng 1.0-rc, KHÔNG dùng Prisma) |
| DB | **PostgreSQL 18** (`uuidv7()` built-in) | 18.6 |
| Job | **pg-boss** (cron có `tz`, retry, singleton) — process `worker` riêng | 12.35.x |
| MCP | **`@modelcontextprotocol/server`** (SDK v2, `createMcpHandler`) | 2.2.x |
| Ngày giờ | `date-fns` + locale `vi` | 4.x |
| QR 2FA | `qrcode.react` (render phía client, KHÔNG gửi otpauth URI ra dịch vụ ngoài) | 4.2 |
| Font | **Inter** qua `next/font/google` (`subsets: ['latin','vietnamese']`); build offline → `@fontsource-variable/inter` | — |
| Reverse proxy | **Caddy** (HTTPS tự động) | 2.11 |
| Test | Vitest (unit, adapter với fixture HTTP qua MSW) + Playwright (e2e luồng chính) | bản ổn định mới nhất lúc init |
| Lint/format | ESLint 9 flat config (từ template) + Prettier + `prettier-plugin-tailwindcss` | — |

Khởi tạo UI (đã chạy thử với CLI 4.21.1):
```bash
pnpm dlx shadcn@latest init -t next -b radix -p maia -n ads-mcp   # style KHÔNG đổi được sau init (radix-maia: bo tròn, thoáng — hợp Apple/Shopify)
pnpm add next@16.3.8 eslint-config-next@16.3.8                    # template đang ghim 16.3.6
pnpm dlx shadcn@latest add sidebar-16 dashboard-01 login-03 chart sonner input-otp field table tabs badge \
  dropdown-menu dialog alert-dialog sheet command popover select checkbox skeleton tooltip breadcrumb empty spinner kbd
```
- Không có registry item `data-table` → lấy `components/data-table.tsx` từ `dashboard-01` làm gốc.
- `cn` giờ đến từ package `cn` (`export { cn } from "cn"`).
- Bọc app trong `<TooltipProvider>`.

## 2. Hình dạng hệ thống
```
                 Internet (HTTPS, IPv4 A record bắt buộc cho Claude)
                              │
                         ┌────▼────┐   log filter che /mcp/<key>
                         │  Caddy  │
                         └────┬────┘
              /mcp/*  ────────┼──────── mọi path khác
                              │
                    ┌─────────▼─────────┐          ┌────────────────┐
                    │ web (Next.js 16)  │          │ worker (Node)  │
                    │ - UI admin (RSC)  │          │ pg-boss cron:  │
                    │ - server actions  │          │ - logs.maintain│
                    │ - /api/auth/*     │          │ - logs.rollup  │
                    │ - /mcp/[key]  ◄───┼─ AI      │ - tokens.health│
                    └─────────┬─────────┘          │ - accounts.sync│
                              │                    └───────┬────────┘
                       ┌──────▼───────────────────────────▼──┐
                       │      PostgreSQL 18 (volume pgdata)   │
                       └──────────────────────────────────────┘
        web/worker ──HTTPS──► Meta Graph · OpenAI Ads
```
- 1 image Docker, nhiều entrypoint: `web` (`node server.js`), `worker` (`node dist/worker.mjs`), `migrate` (`node dist/migrate.mjs`, chạy 1 lần), CLI (`node dist/cli.mjs`).
- Khi tải MCP lớn: thêm service `mcp` chạy **cùng image** như `web`, Caddy route `/mcp/*` sang đó. Code `src/server/mcp/**` không import `next/*` nên có thể chuyển sang Hono (`@modelcontextprotocol/hono`) nếu cần.

## 3. Cấu trúc thư mục (single Next.js app)
```
├─ CLAUDE.md, .claude/                  hướng dẫn cho Claude Code
├─ logo/                                logo gốc (favicon.png, logo-duong-ban.png = nền sáng, logo-am-ban.png = nền tối)
├─ public/brand/                        bản copy tối ưu của logo (webp/png nhỏ) + favicon
├─ src/
│  ├─ app/
│  │  ├─ (auth)/login/  (auth)/login/2fa/  (auth)/setup/
│  │  ├─ (dashboard)/layout.tsx         requireUser() + AppShell
│  │  │   ├─ page.tsx                   Tổng quan
│  │  │   ├─ connections/ [id]/ new/    Kết nối quảng cáo
│  │  │   ├─ mcp-servers/ [id]/ new/    MCP (quản lý; /mcp/* là endpoint)
│  │  │   ├─ logs/                      Nhật ký (?tab=mcp|staff)
│  │  │   ├─ users/                     (admin)
│  │  │   ├─ settings/                  (admin)
│  │  │   ├─ account/                   tài khoản của tôi, 2FA
│  │  │   └─ security/enable-2fa/       cổng bắt buộc 2FA cho admin
│  │  ├─ api/auth/[...all]/route.ts     toNextJsHandler(auth)
│  │  ├─ api/health/route.ts
│  │  └─ mcp/[key]/route.ts             → serveMcp()
│  ├─ components/
│  │  ├─ ui/                            shadcn (sinh bởi CLI — hạn chế sửa tay, chỉ thêm variant)
│  │  └─ app/                           AppShell, PageHeader, GlassCard, DataTable, FilterBar, EmptyState,
│  │                                    PlatformBadge, StatusBadge, PermissionBadges, CopyField, ConfirmDialog, JsonViewer…
│  ├─ lib/                              utils, format.ts (tiền/ngày vi-VN), i18n/vi.ts, constants.ts
│  ├─ server/                           chỉ chạy server ("server-only")
│  │  ├─ env.ts                         đọc + validate env bằng zod (runtime, KHÔNG dùng NEXT_PUBLIC cho config deploy)
│  │  ├─ db/  client.ts  schema/{auth,app,logs}.ts
│  │  ├─ auth/ auth.ts  permissions.ts  guard.ts (requireUser/requireAdmin)
│  │  ├─ crypto/ secret-box.ts (AES-GCM keyring)  mcp-key.ts (sinh/HMAC/prefix)
│  │  ├─ audit/ activity-log.ts  mcp-log-writer.ts (batch)  redact.ts  cap-json.ts
│  │  ├─ services/ users.ts connections.ts ad-accounts.ts mcp-servers.ts logs.ts settings.ts dashboard.ts
│  │  ├─ actions/  *.ts                 server actions mỏng: requireUser → zod parse → service → activity log → revalidate
│  │  ├─ providers/                     KHÔNG import next/*
│  │  │   ├─ types.ts registry.ts errors.ts http.ts (fetch + retry + timeout) rate-limit.ts money.ts dates.ts
│  │  │   └─ meta/ openai-ads/   (client.ts, credentials.ts, report.ts, objects.ts, mutate.ts, copy.ts, mapping.ts)
│  │  └─ mcp/                           KHÔNG import next/* (xem 04-mcp-design.md §2)
│  ├─ proxy.ts                          redirect lạc quan khi thiếu cookie (Next 16: thay middleware.ts)
│  └─ instrumentation.ts                flush log khi SIGTERM
├─ scripts/ migrate.ts worker.ts cli.ts (create-admin, reset-password, reset-2fa, unlock, reencrypt)
├─ drizzle/                             migration SQL (có file custom cho partition)
├─ tests/ e2e/                          Playwright
├─ Dockerfile  docker-compose.yml  Caddyfile  .env.example
```
Quy tắc phụ thuộc: `app → server/actions → server/services → server/{db,providers,crypto,audit}`; `server/mcp → server/{services,providers,audit,crypto,db}`. Component client không import `server/*`. Thêm ESLint `no-restricted-imports` chặn `next/*` trong `src/server/providers/**` và `src/server/mcp/**`.

## 4. Provider adapter (giao diện chung)
```ts
export type Platform = 'meta' | 'tiktok' | 'google_ads' | 'openai_ads'; // = enum DB; bản build chỉ có RELEASED_PLATFORMS (src/lib/platforms.ts, 12-platform-rollout.md)
export type Level = 'account' | 'campaign' | 'ad_group' | 'ad';
export type Permission = 'read' | 'status' | 'update' | 'copy' | 'create' | 'delete';

export interface ProviderContext {
  connectionId: string; credentials: DecryptedCredentials; account: AdAccountRef;  // id, currency, timezone
  signal: AbortSignal; log: UpstreamLogger;                                         // ghi request id nền tảng
}
export interface AdsProvider {
  platform: Platform;
  capabilities: Record<Capability, 'native' | 'emulated' | 'gated' | 'unsupported'>;
  validateCredentials(raw: unknown): Promise<CredentialCheck>;     // is_valid, scopes, expires_at, warnings
  listAccounts(cred): Promise<AdAccountInfo[]>;
  getReport(ctx, q: ReportQuery): Promise<ReportPage>;             // trả metric đã chuẩn hoá + extra
  listObjects(ctx, q: ListQuery): Promise<ObjectPage>;
  getObject(ctx, level, id, opts): Promise<AdObjectDetail>;
  setStatus(ctx, level, ids, status, opts): Promise<MutationResult>;
  updateBudget(ctx, level, id, budget, opts): Promise<MutationResult>;
  updateObject(ctx, level, id, changes, opts): Promise<MutationResult>;
  copyObject(ctx, level, id, opts): Promise<CopyResult>;            // native hoặc giả lập
  deleteObject(ctx, level, id, opts): Promise<MutationResult>;
  uploadMedia(ctx, input): Promise<MediaRef>;
  lookup(ctx, kind, q): Promise<LookupResult>;
  preview?(ctx, mutation): Promise<PreviewResult>;                  // validate_only / validateOnly nếu có
}
```
- `opts.dryRun` → chỉ validate + đọc trạng thái hiện tại để tạo preview (luồng xác nhận 2 bước).
- `MutationResult` luôn có `changes: [{objectId, field, before, after}]` để ghi log và trả AI.
- Lỗi chuẩn hoá: `ProviderError { platform, code, httpStatus, retryable, userMessageVi, hint, upstream: {code, subcode, message, requestId} }`.
- `http.ts`: `fetch` + `AbortSignal.timeout(60s)` + retry có jitter chỉ cho lỗi retryable (theo bảng lỗi từng nền tảng) + token bucket theo `(platform, connection|account|app)` + đọc header usage (Meta BUC) để giảm tốc.
- `money.ts`: `toMinor/fromMinor` (Meta offset 1|100 theo currency), `toMicros/fromMicros` (OpenAI). Dùng số nguyên/BigInt cho micros — **không dùng float cho tiền gửi lên API**.
- `dates.ts`: preset → khoảng ngày theo múi giờ tài khoản; chia cửa sổ theo giới hạn từng nền tảng.
- Phiên bản API mỗi nền tảng là hằng số override được bằng env: `META_API_VERSION=v26.0`, `OPENAI_ADS_API_VERSION=v1`.

## 5. Luồng dữ liệu chính
**Tạo kết nối**: form (client) → server action `createConnection` → `requireUser` → zod → `provider.validateCredentials` → `listAccounts` → transaction: insert `connections` (credential mã hoá với AAD `connection:<id>:credentials`) + upsert `ad_accounts` → `activity_logs` → revalidate.

**Gọi MCP**: AI → Caddy → `/mcp/[key]` → `serveMcp` (host/origin, key → grant, IP, rate limit) → SDK handler → factory đăng ký tool theo grant → tool: kiểm tra platform/account/quyền → (xác nhận 2 bước nếu là ghi) → giải mã credential → adapter → chuẩn hoá → `withCallLogging` đẩy log vào batch writer → trả kết quả.

**Job nền (worker)**: `logs.maintain` 03:15 hằng ngày (tạo trước partition 3 tháng, drop partition quá hạn theo setting) · `logs.rollup` mỗi 5 phút (`mcp_call_stats_hourly` cho biểu đồ) · `tokens.health` mỗi 6 giờ (validate credential, cập nhật trạng thái/hạn) · `accounts.sync` hằng ngày (đồng bộ danh sách tài khoản QC) · `pending_actions.cleanup` hằng giờ · `auth.cleanup` 03:45 hằng ngày (xoá hàng đã hết hạn của `verification` — bộ đếm khoá đăng nhập/quota/đánh dấu phiên tươi/thử thách 2FA —, `session`, `rate_limit`; nếu không chúng phình mãi vì mỗi lần đăng nhập sai tạo hàng mới).

## 6. Ghi chú Next 16 quan trọng
- `proxy.ts` thay `middleware.ts` (chạy Node runtime). Chỉ dùng redirect lạc quan khi thiếu cookie session; **kiểm tra thật trong layout + từng server action + route handler**. Matcher loại trừ `/mcp`, `/api/auth`, `/api/health`, `/login`, `/setup`, `/_next`, file tĩnh — proxy buffer body (mặc định 10MB, cắt im lặng) nên `/mcp` tuyệt đối không đi qua proxy.
- Request API async: `await params`, `await cookies()`, `await headers()`.
- `next lint` đã bỏ → chạy `eslint` trực tiếp.
- Caching dynamic mặc định; **để `cacheComponents` tắt** (app toàn trang cần đăng nhập).
- `NEXT_PUBLIC_*` bị inline lúc build → image dùng chung cho nhiều đơn vị phải đọc config deploy (domain…) ở **runtime** phía server.
- Đặt `KEEP_ALIVE_TIMEOUT=130000` (> keepalive 2 phút của Caddy) tránh 502 lẻ tẻ.
- Không cấu hình `images.remotePatterns` nếu không cần.
