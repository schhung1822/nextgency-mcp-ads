# Ads MCP by: noti.vn

Web app **source-available** (giấy phép riêng của noti.vn — chỉ đơn vị được cấp quyền mới được dùng, xem `LICENSE`), tự host (VPS + Docker + PostgreSQL), cho phép đội marketing **dán token từ app developer** để kết nối tài khoản quảng cáo **Meta, TikTok Ads, Google Ads (gồm YouTube), OpenAI Ads** và **kênh thông báo Telegram**, rồi tạo **MCP server** (`https://<domain>/mcp/<key>`) để điều khiển quảng cáo từ **Claude, ChatGPT, Gemini**: kéo chỉ số theo ngày, sửa, bật/tắt, sao chép, tạo mới. Có phân quyền Admin/Nhân viên, 2FA, nhật ký chi tiết (MCP + nhân sự) lưu N tháng.

## Trạng thái hiện tại
**Đang triển khai** (chủ dự án đã cho phép bắt đầu ngày 2026-10-02). Làm theo thứ tự trong `.claude/docs/08-roadmap.md`, cập nhật checklist ở đó sau mỗi phần việc.
Next.js 16 khác dữ liệu huấn luyện — trước khi dùng API Next, đọc hướng dẫn trong `node_modules/next/dist/docs/` (xem `AGENTS.md`).

@AGENTS.md

## Tài liệu (đọc file liên quan TRƯỚC khi làm phần đó)
| File | Nội dung |
|---|---|
| `.claude/docs/01-product-spec.md` | Yêu cầu chức năng, vai trò & ma trận quyền, luồng tạo kết nối/MCP, log, quyết định mặc định D1–D5 |
| `.claude/docs/02-architecture.md` | Stack + version đã kiểm tra, sơ đồ hệ thống, cây thư mục, interface provider adapter, ghi chú Next 16 |
| `.claude/docs/03-database-schema.md` | Bảng, cột, index, partition log theo tháng, danh mục action log |
| `.claude/docs/04-mcp-design.md` | Endpoint & key, danh mục tool, chuẩn hoá metric/tiền/ngày, xác nhận 2 bước, hướng dẫn kết nối từng AI client |
| `.claude/docs/05-security.md` | Better Auth config, 2FA, phân quyền, mã hoá, redact, checklist review |
| `.claude/docs/06-ui-design-system.md` | Màu thương hiệu, Liquid Glass CSS, layout kiểu Shopify, wireframe từng trang, văn phong tiếng Việt |
| `.claude/docs/07-deployment.md` | Env, Dockerfile, compose, Caddyfile, vận hành/backup |
| `.claude/docs/08-roadmap.md` | Các giai đoạn + tiêu chí "đạt" + câu hỏi còn mở |
| `.claude/docs/11-meta-pages.md` | Tính năng Trang Facebook (danh sách Trang, bài viết, chỉ số — chỉ đọc): quyết định, bảng, tool, UI (đã làm 2026-10-04, §11 = bản thực tế) |
| `.claude/docs/providers/{meta,tiktok,google-ads,openai-ads}.md` | API từng nền tảng: version, credential, endpoint, đơn vị tiền, copy, rate limit, lỗi |
| `.claude/docs/providers/openai-ads.openapi.json` | OpenAPI chính thức OpenAI Ads — grep để lấy schema chính xác |
| `.claude/docs/12-platform-rollout.md` | Bật/tắt nền tảng (`src/lib/platforms.ts`) + checklist phát hành nền tảng mới (Google Ads, TikTok Ads đã phát hành 2026-10-08) |
| `.claude/docs/13-system-notices.md` | Thông báo hệ thống (webhook noti.vn 1 giờ/lần → chạy chữ top bar web); kết quả MCP không kèm thông báo |
| `.claude/docs/14-telegram-notifications.md` | Kênh thông báo Telegram: bảng, gửi tin (Bot API), hàng đợi, sự kiện, tool MCP `telegram_*`, UI, bảo mật |

## Stack (chi tiết + version: 02-architecture.md)
Next.js 16.3.8 App Router · React 19 · TypeScript strict · Tailwind v4 · shadcn/ui (Radix, style `radix-maia`, icon Hugeicons) · Better Auth 1.7.7 (email/password, 2FA TOTP, admin) · Drizzle 0.45 + PostgreSQL 18 · pg-boss (worker) · MCP TS SDK v2 `@modelcontextprotocol/server` · Caddy · pnpm · Node 24 · Vitest + Playwright.

## Lệnh (sẽ có sau Giai đoạn 0)
```bash
pnpm dev            # Next dev (cần Postgres: docker compose up -d db)
pnpm worker:dev     # pg-boss worker
pnpm lint && pnpm typecheck && pnpm test     # bắt buộc xanh trước khi báo xong
pnpm test:e2e       # Playwright
pnpm db:generate    # drizzle-kit generate (không dùng push cho production)
pnpm db:migrate
pnpm cli <cmd>      # create-admin | reset-password | reset-2fa | unlock | unban | reencrypt | google:refresh-token
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build   # build từ mã nguồn + chạy full stack (VPS chỉ pull: docker compose pull && docker compose up -d --no-build)
```

## Quy tắc bắt buộc
1. **Bảo mật trước hết** — app giữ token có toàn quyền chi tiền:
   - Mọi server action / route / tool MCP: `requireUser()` + kiểm tra role + **kiểm tra owner** (staff chỉ thấy/dùng tài nguyên của mình). Layout không phải ranh giới bảo mật.
   - Credential nền tảng & key MCP: mã hoá AES-256-GCM (có AAD), **không bao giờ** trả về client, đưa cho AI, hay ghi log. Redact trước khi log.
   - `auth.api.createUser` (và mọi API admin của Better Auth) **phải** kèm `headers: await headers()`.
   - MCP: key sai/tắt/hết hạn → **404, không bao giờ 401**. Mỗi tool tự kiểm tra lại platform/account/quyền theo grant.
2. **An toàn thao tác quảng cáo**: object tạo mới/bản sao luôn **tạm dừng**; thao tác ghi qua luồng xác nhận 2 bước khi MCP bật; tôn trọng guardrail ngân sách; xoá không hoàn tác → luôn xác nhận.
3. **Tiền & ngày**: tool MCP nhận/trả **đơn vị chính + mã tiền tệ**; adapter tự quy đổi (Meta minor-unit, **VND offset 1**; Google/OpenAI micros; TikTok đơn vị chính). Không dùng float cho số gửi lên API. **Không cộng chéo tiền tệ.** Ngày theo múi giờ tài khoản QC; DB lưu UTC.
4. **API nền tảng thay đổi nhanh**: không code theo trí nhớ — đọc `providers/*.md`; nếu nghi ngờ hoặc tài liệu > 30 ngày, chạy `/provider-api-check <platform>`. Version API là hằng số override bằng env.
5. **Log là yêu cầu cốt lõi**: thao tác của nhân sự ghi `activity_logs` **trong cùng transaction**; mọi request MCP ghi `mcp_call_logs` (kèm before/after khi ghi).
6. **Ranh giới code**: `src/server/providers/**` và `src/server/mcp/**` **không import `next/*`**. Client component không import `src/server/*`.
7. **UI**: dùng component shadcn có sẵn (thêm bằng CLI, chỉ thêm variant khi cần); glass chỉ cho khung (top bar, sidebar, popover, dialog, KPI), nội dung dày dùng card đặc; mỗi trang 1 nút chính `brand`; toàn bộ chuỗi tiếng Việt có dấu trong `src/lib/i18n/vi.ts`; kiểm tra sáng/tối + mobile.
8. **Database**: thay đổi schema qua Drizzle migration (bảng log partition: sửa tay migration — xem 03-database-schema.md §3). Không sửa migration đã commit.
9. **Không tự ý nâng major version** hoặc thêm dependency mà chưa hỏi orchestrator/chủ dự án. **Chỉ commit khi chủ dự án yêu cầu** (không tự commit sau mỗi phần việc; message tiếng Anh, Conventional Commits); **không push** khi chưa được yêu cầu.
10. **Phát hành: build Docker image trước, push sau.** Luôn build Docker image (web + updater, `--build-arg APP_BUILD_VERSION=<ver>`) thành công ở máy local và chạy thử stack production trước; chỉ khi build + smoke test đạt mới push code/tag lên GitHub (`notivn/Ads-MCP-simple`, private) và đẩy image lên GHCR. Version ở `package.json` phải khớp tag `vX.Y.Z`.
11. **Xong việc = đã kiểm chứng**: chạy `/verify`; với UI chụp màn hình (Chrome DevTools MCP); báo cáo trung thực cái gì chưa test được.

## Môi trường dev
Máy dev là **Windows** (Git Bash + PowerShell). Đường dẫn trong code dùng `/`; script npm phải chạy được trên cả Windows và Linux (dùng Node script thay cho bash khi cần). Production chạy Linux container.

## Giao tiếp
Trả lời chủ dự án bằng **tiếng Việt**. Code, tên biến, commit message bằng tiếng Anh; chuỗi UI và thông báo lỗi cho người dùng bằng tiếng Việt.
