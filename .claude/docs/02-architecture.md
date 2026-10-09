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
                         ┌────▼────┐   log filter che /mcp/<key>, /dl/<token>
                         │  Caddy  │
                         └────┬────┘
     /mcp/*, /dl/* ───────────┼──────── mọi path khác   (/dl/*: link tạm video Drive, không encode/buffer)
                              │
                    ┌─────────▼─────────┐          ┌────────────────┐
                    │ web (Next.js 16)  │          │ worker (Node)  │
                    │ - UI admin (RSC)  │          │ pg-boss cron:  │
                    │ - server actions  │          │ - logs.maintain│
                    │ - /api/auth/*     │          │ - logs.rollup  │
                    │ - /mcp/[key]  ◄───┼─ AI      │ - tokens.health│
                    │ - /dl/[token] ◄───┼─ Meta/   │ - accounts.sync│
                    │                   │  TikTok  │ - drive.*      │
                    │                   │          │ - media.video_ │
                    │                   │          │   upload       │
                    └─────────┬─────────┘          │                │
                              │                    └───────┬────────┘
                       ┌──────▼───────────────────────────▼──┐
                       │      PostgreSQL 18 (volume pgdata)   │
                       └──────────────────────────────────────┘
        web/worker ──HTTPS──► Meta Graph · TikTok Business · Google Ads REST (gồm YouTube) · OpenAI Ads · Telegram Bot API
        web/worker ──HTTPS──► Google Drive v3 · Sheets v4 (host ghim: www/sheets.googleapis.com, *.googleusercontent.com cho thumbnail)
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
│  │  │   ├─ connections/ [id]/ new/    Kết nối quảng cáo (+ telegram/{new,[id]}, drive/{new,[id]} — tab ?tab=telegram|drive)
│  │  │   ├─ mcp-servers/ [id]/ new/    MCP (quản lý; /mcp/* là endpoint)
│  │  │   ├─ logs/                      Nhật ký (?tab=mcp|staff)
│  │  │   ├─ users/                     (admin)
│  │  │   ├─ settings/                  (admin)
│  │  │   ├─ account/                   tài khoản của tôi, 2FA
│  │  │   └─ security/enable-2fa/       cổng bắt buộc 2FA cho admin
│  │  ├─ api/auth/[...all]/route.ts     toNextJsHandler(auth)
│  │  ├─ api/health/route.ts
│  │  ├─ api/drive/thumb/[sourceId]/[fileId]/route.ts   ảnh thu nhỏ Drive cho lưới file (cần phiên, 404 khi không có quyền)
│  │  ├─ dl/[token]/[name]/route.ts     link tạm công khai cho Meta/TikTok tải video Drive → relayServe() (15-google-drive-media.md §8/§18.3)
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
│  │  │            notification-channels.ts (kênh Telegram: CRUD + owner check + enqueueNotification)
│  │  │            drive-credentials.ts drive-sources.ts (Google Drive: credential hệ thống/riêng, nguồn thư mục/sheet, chống nhận vơ, quyền)
│  │  ├─ google/                        KHÔNG import next/*: service-account.ts (JWT RS256 → access token, scope là tham số, cache theo scope; Google Ads + Drive dùng chung)
│  │  ├─ drive/                         KHÔNG import next/*: client.ts (Drive v3 + Sheets v4 qua fetch, host ghim) links.ts files.ts sheets.ts rate-limit.ts
│  │  │                                 store.ts (mã hoá/giải mã) blocked.ts file-ref.ts (drf_) media-uploads.ts relay-*.ts (link tạm /dl)
│  │  │                                 upload-jobs.ts upload-queue.ts (tải video nền) health.ts access-recheck.ts (15-google-drive-media.md §18.1)
│  │  ├─ net/                           ssrf.ts (safeFetch ghim IP), media-type.ts (magic bytes), media-slots.ts (semaphore media chung Telegram + Drive)
│  │  ├─ notifications/                 KHÔNG import next/*: telegram.ts (Bot API: sendMessage/getMe/getChat/getChatMember,
│  │  │                                 escapeHtml, map lỗi, không log URL chứa token) + nội dung tin theo sự kiện (14-telegram-notifications.md)
│  │  ├─ actions/  *.ts                 server actions mỏng: requireUser → zod parse → service → activity log → revalidate
│  │  ├─ providers/                     KHÔNG import next/*
│  │  │   ├─ types.ts registry.ts errors.ts http.ts (fetch + retry + timeout) rate-limit.ts money.ts dates.ts
│  │  │   └─ meta/ tiktok/ google-ads/ openai-ads/   (client.ts, credentials.ts, report.ts, objects.ts, mutate.ts, copy.ts, mapping.ts)
│  │  └─ mcp/                           KHÔNG import next/* (xem 04-mcp-design.md §2)
│  ├─ proxy.ts                          redirect lạc quan khi thiếu cookie (Next 16: thay middleware.ts)
│  └─ instrumentation.ts                flush log khi SIGTERM
├─ scripts/ migrate.ts worker.ts cli.ts (create-admin, reset-password, reset-2fa, unlock, unban, reencrypt, google:refresh-token)
├─ drizzle/                             migration SQL (có file custom cho partition)
├─ tests/ e2e/                          Playwright
├─ Dockerfile  docker-compose.yml  Caddyfile  .env.example
```
Quy tắc phụ thuộc: `app → server/actions → server/services → server/{db,providers,crypto,audit}`; `server/mcp → server/{services,providers,audit,crypto,db}`. Component client không import `server/*`. Thêm ESLint `no-restricted-imports` chặn `next/*` trong `src/server/providers/**` và `src/server/mcp/**` (`src/server/drive/**`, `src/server/google/**` cũng không import `next/*` vì chạy trong worker — hiện mới giữ bằng review, **chưa** có trong danh sách file của rule ESLint).

## 4. Provider adapter (giao diện chung)
```ts
export type Platform = 'meta' | 'tiktok' | 'google_ads' | 'openai_ads'; // = enum DB; bản build chỉ có RELEASED_PLATFORMS (src/lib/platforms.ts, 12-platform-rollout.md)
export type Level = 'account' | 'campaign' | 'ad_group' | 'ad' | 'keyword'; // keyword: chỉ Google Ads
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
- `money.ts`: `toMinor/fromMinor` (Meta offset 1|100 theo currency), `toMicros/fromMicros` (Google/OpenAI). Dùng số nguyên/BigInt cho micros — **không dùng float cho tiền gửi lên API**.
- `dates.ts`: preset → khoảng ngày theo múi giờ tài khoản; chia cửa sổ theo giới hạn từng nền tảng (TikTok ≤30 ngày/lần).
- Phiên bản API mỗi nền tảng là hằng số override được bằng env: `META_API_VERSION=v26.0`, `GOOGLE_ADS_API_VERSION=v25`, `TIKTOK_API_VERSION=v1.3` (+ `TIKTOK_BASE_URL` tuỳ chọn, trỏ sandbox), `OPENAI_ADS_API_VERSION=v1`.
- YouTube không có API quảng cáo riêng: chiến dịch Video / Demand Gen đọc qua adapter `google-ads` (`advertising_channel_type`, bộ chỉ số video); chiến dịch VIDEO chỉ đọc (adapter từ chối thao tác ghi).

## 5. Luồng dữ liệu chính
**Tạo kết nối**: form (client) → server action `createConnection` → `requireUser` → zod → `provider.validateCredentials` → `listAccounts` → transaction: insert `connections` (credential mã hoá với AAD `connection:<id>:credentials`) + upsert `ad_accounts` → `activity_logs` → revalidate.

**Gọi MCP**: AI → Caddy → `/mcp/[key]` → `serveMcp` (host/origin, key → grant, IP, rate limit) → SDK handler → factory đăng ký tool theo grant → tool: kiểm tra platform/account/quyền → (xác nhận 2 bước nếu là ghi) → giải mã credential → adapter → chuẩn hoá → `withCallLogging` đẩy log vào batch writer → trả kết quả.

**Thông báo Telegram** (`14-telegram-notifications.md`): nguồn sự kiện (thao tác ghi MCP thành công, tool `telegram_send_message`, `connection-ops.ts` khi trạng thái kết nối chuyển, job cập nhật) → `enqueueNotification()` (insert `notification_deliveries` pending, bỏ qua trùng `dedupe_key`, **không bao giờ ném lỗi ra luồng gọi**) → pg-boss `notify.telegram` → `notifications/telegram.ts` giải mã bot token (AAD `notification_channel:<id>:credentials`) → Bot API → cập nhật delivery/kênh. Tool `telegram_send_message` gửi đồng bộ (≤10 s, không thử lại).

**Google Drive → nền tảng** (`15-google-drive-media.md` §18): tool MCP `ads_upload_media(drive_file)` → `drive-access.ts` (file thuộc nguồn được cấp — service account — hoặc link công khai — API key) → ảnh: tải bytes từ Drive → adapter upload bytes; video nhỏ (TikTok ≤ 10 MB, Meta ≤ 50 MB): `createRelayLink` → nền tảng GET `/dl/<token>/<tên>` → `relay-serve.ts` stream từ Drive (Range, không đệm, không ghi đĩa); video lớn: `media_upload_jobs` + pg-boss `media.video_upload` → worker đọc Drive bằng Range và gọi `uploadVideoChunked` của adapter. Mã media lưu `drive_media_uploads` để tái dùng.

**Job nền (worker)**: `logs.maintain` 03:15 hằng ngày (tạo trước partition 3 tháng, drop partition quá hạn theo setting) · `logs.rollup` mỗi 5 phút (`mcp_call_stats_hourly` cho biểu đồ) · `tokens.health` mỗi 6 giờ (validate credential, cập nhật trạng thái/hạn) · `accounts.sync` hằng ngày (đồng bộ danh sách tài khoản QC) · `pending_actions.cleanup` hằng giờ · `auth.cleanup` 03:45 hằng ngày (xoá hàng đã hết hạn của `verification` — bộ đếm khoá đăng nhập/quota/đánh dấu phiên tươi/thử thách 2FA —, `session`, `rate_limit`; nếu không chúng phình mãi vì mỗi lần đăng nhập sai tạo hàng mới) · `drive.health` phút 40 mỗi 6 giờ (kiểm tra lại credential + nguồn Drive) · `drive.cleanup` 03:50 hằng ngày (xoá link tạm hết hạn > 24 h, đánh dấu lỗi lượt tải video treo, xoá lượt tải > 30 ngày) · `media.upload_sweep` 10 phút/lần · `media.video_upload` theo yêu cầu (tải video Drive lớn theo từng phần, 1 job một lúc).

## 6. Ghi chú Next 16 quan trọng
- `proxy.ts` thay `middleware.ts` (chạy Node runtime). Chỉ dùng redirect lạc quan khi thiếu cookie session; **kiểm tra thật trong layout + từng server action + route handler**. Matcher loại trừ `/mcp`, `/dl`, `/api/auth`, `/api/health`, `/login`, `/setup`, `/_next`, file tĩnh — proxy buffer body (mặc định 10MB, cắt im lặng) nên `/mcp` tuyệt đối không đi qua proxy.
- Request API async: `await params`, `await cookies()`, `await headers()`.
- `next lint` đã bỏ → chạy `eslint` trực tiếp.
- Caching dynamic mặc định; **để `cacheComponents` tắt** (app toàn trang cần đăng nhập).
- `NEXT_PUBLIC_*` bị inline lúc build → image dùng chung cho nhiều đơn vị phải đọc config deploy (domain…) ở **runtime** phía server.
- Đặt `KEEP_ALIVE_TIMEOUT=130000` (> keepalive 2 phút của Caddy) tránh 502 lẻ tẻ.
- Không cấu hình `images.remotePatterns` nếu không cần.
