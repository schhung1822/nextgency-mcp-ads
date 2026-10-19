# Lộ trình triển khai

> Đang triển khai (chủ dự án cho phép từ 2026-10-02). Mỗi giai đoạn kết thúc bằng: typecheck + lint + test xanh, chạy thử thật (skill `/verify`), cập nhật checklist dưới đây, tóm tắt cho chủ dự án. Không nhảy giai đoạn khi giai đoạn trước chưa đạt tiêu chí.
>
> **Trạng thái rà lại theo code trên `main` — 2026-10-02.** `[x]` = đã có trong `main` (unit/integration test xanh); `[ ]` = chưa có hoặc chưa kiểm chứng. Các tiêu chí "Đạt khi" cần tài khoản QC thật / VPS / e2e **chưa** được kiểm chứng ở giai đoạn nào — ghi rõ dưới mỗi giai đoạn.

## Giai đoạn 0 — Khởi tạo
- [x] `git init` (nhánh `main`), `.gitignore` (`.env*` trừ `.env.example`, `.claude/settings.local.json`, `CLAUDE.local.md`, `backups/`, `node_modules`, `.next`, `dist`)
- [x] Next.js 16.3.8 + shadcn init (`-t next -b radix -p maia`), pnpm, TS strict, ESLint flat + Prettier (+ tailwind plugin), Vitest, Playwright (dependency + `tests/e2e/mcp-servers.spec.ts`)
- [ ] Playwright: **chưa có `playwright.config.ts`** → `pnpm test:e2e` chưa chạy được
- [x] `src/server/env.ts` (zod), `docker-compose.yml` + `docker-compose.dev.yml` (Postgres 18, cổng 5433 khi dev), Drizzle config + client
- [x] Copy logo vào `public/brand/`, favicon, Inter (latin + vietnamese), `<html lang="vi">`
- [x] Script: `dev`, `build`, `start`, `lint`, `typecheck`, `test`, `test:e2e`, `db:generate`, `db:migrate`, `worker:dev`
- [ ] Script `cli` đã khai báo trong `package.json` nhưng **chưa có `scripts/cli.ts`**
- [x] CI GitHub Actions: `ci.yml` (install → lint → typecheck → migrate → test → build) + `docker.yml` (build & push GHCR)
**Đạt khi**: `pnpm dev` chạy trang trống có logo + theme sáng/tối; CI xanh. — dev chạy được; CI trên GitHub **chưa kiểm chứng** (chưa push).

## Giai đoạn 1 — Design system & khung app
- [x] Token màu, `glass` utility, nút `brand`, nền gradient, TransparencyToggle, ThemeToggle, token biểu đồ theo nền tảng `--chart-platform-*`
- [x] AppShell (sidebar floating glass + top bar), PageHeader, GlassCard, KpiCard, EmptyState, StatusBadge, PlatformIcon, CopyField, ConfirmDialog, DataTable (TanStack v9), FilterBar, DateRangePicker, Stepper, JsonViewer
- [x] Chuỗi tiếng Việt trong `src/lib/i18n/vi/*.ts` (gom qua `src/lib/i18n/index.ts`), `format.ts` (tiền/ngày/tương đối)
- [x] Trang 404 / lỗi tiếng Việt (`app/not-found`, `app/error`, `app/global-error`, bản trong khung dashboard); script trước-khi-vẽ chỉ chạy từ HTML server (không còn cảnh báo "script tag" của React)
**Đạt khi**: trang demo nội bộ `/dev/ui` hiển thị đủ component ở sáng/tối, mobile/desktop — trang đã có; các trang thật (Tổng quan, MCP, Kết nối, Nhật ký, 404) đã chụp kiểm tra bằng Playwright sáng/tối 1440/390 (Chrome DevTools MCP không phải lúc nào cũng dùng được).

## Giai đoạn 2 — Xác thực, người dùng, nhật ký nhân sự
- [x] Schema Better Auth (generate) + bảng `app_settings`, `activity_logs` (partition) + hàm partition + migrate script
- [x] Lõi phía server: `requireUser()` / `requireUserForAction()`, hook ghi `activity_logs` cho sự kiện auth, lockout theo email, chính sách `require_2fa_all`
- [ ] Trang `/setup` (SETUP_TOKEN), `/login`, `/login/2fa`, bắt buộc đổi mật khẩu, cổng `/security/enable-2fa`, `/account` — **chưa có trong `main`**
- [ ] `/users` (tạo, đổi vai trò, đặt lại mật khẩu/2FA, khoá, phiên) — **chưa có** (sidebar đã có link)
- [ ] `proxy.ts` (chuyển hướng khi chưa đăng nhập) — chưa có; hiện bảo vệ bằng `requireUser()` trong layout/page và `requireUserForAction()` trong action
- [ ] CLI: `create-admin`, `reset-password`, `reset-2fa` (`scripts/cli.ts`)
**Đạt khi**: e2e setup → admin bật 2FA → tạo staff → staff đăng nhập/đổi mật khẩu → staff không vào được `/users` — **chưa đạt** (thiếu trang). Dev hiện đăng nhập bằng `scripts/dev-seed-logs.ts`.

## Giai đoạn 3 — Kết nối quảng cáo
- [x] `secret-box.ts` (keyring AES-GCM + AAD), `redact.ts`, `cap-json.ts`
- [x] `providers/{types,http,rate-limit,money,dates,errors,registry}.ts`
- [x] Adapter Meta + OpenAI Ads: `validateCredentials` + `listAccounts` (Meta token cá nhân/System User, OpenAI + probe tính năng) — unit test với fixture. Google Ads (gồm YouTube), TikTok Ads: phát hành 2026-10-08 (mục "Phát hành Google Ads (YouTube), TikTok Ads, kênh Telegram" bên dưới)
- [x] Bảng `connections`, `ad_accounts`; trang danh sách / wizard thêm (HelpPanel từng nền tảng, `?platform=` chọn sẵn nền tảng) / chi tiết (bật tắt TKQC, kiểm tra lại, sửa credential, xoá)
- [x] Worker pg-boss: `tokens.health`, `accounts.sync`
- [ ] Kết nối **tài khoản thật** mỗi nền tảng (chế độ chỉ đọc)
**Đạt khi**: kết nối thật được ít nhất 1 tài khoản mỗi nền tảng — **chưa kiểm chứng**; kiểm tra credential không lộ ra client/log bằng DevTools network — chưa làm với tài khoản thật.

## Giai đoạn 4 — MCP lõi + tool đọc
- [x] Bảng `mcp_servers`, `mcp_platform_permissions`, `mcp_account_scopes`, `mcp_call_logs` (partition), `mcp_call_stats_hourly`
- [x] Wizard tạo MCP 4 bước (bước 4 có trần ngày / trọn đời / giá thầu, giới hạn ghi / 10 phút) + màn hoàn tất (link + hướng dẫn 5 client), chi tiết MCP, xoay key và xem lại link (cả hai cần mật khẩu + TOTP, khoá sau 5 lần sai / 15 phút), tắt/xoá
- [x] `/mcp/[key]` (serveMcp: host/origin, 404, IP, rate limit, cache grant 3 s có invalidate), handler SDK v2 (2026-07-28 + legacy stateless), registry, ghi log theo lô
- [x] Tool đọc: `ads_list_accounts`, `ads_get_report` (chuẩn hoá metric, mặc định kéo mọi chỉ số + `extra_metrics`, phân trang bằng cursor ký HMAC, tổng theo tiền tệ), `ads_list_objects`, `ads_get_object`, `ads_lookup`, `openai_ads_get_conversions`
- [ ] Kết nối thử từ Claude Code / claude.ai / ChatGPT developer mode / Gemini CLI tới máy chủ thật (HTTPS)
**Đạt khi**: kết nối thành công từ các client + số chi tiêu khớp Ads Manager — **chưa kiểm chứng** (cần domain + TKQC thật). Phạm vi staff và log MCP: có test tích hợp.

## Giai đoạn 5 — Tool ghi cơ bản + an toàn
- [x] `mcp_pending_actions` + luồng xác nhận 2 bước + idempotent replay; văn bản xác nhận yêu cầu người dùng (con người) đồng ý rõ ràng
- [x] `ads_set_status`, `ads_update_budget` (guardrail % mỗi lần + cộng dồn 24 h, trần ngày / trọn đời, CBO/shared budget cảnh báo), `ads_update_object` (trần giá thầu), `ads_delete_object`
- [x] Giới hạn thao tác ghi / 10 phút theo MCP; khoá idempotency xác định cho mọi lần thực thi ghi
- [x] Tool cập nhật riêng: `meta_update_targeting`, `openai_ads_update_ad_group`
- [x] Ghi `changes` before/after vào log
- [ ] Test trên object thử nghiệm của chủ dự án
**Đạt khi**: tắt/bật, đổi ngân sách, đổi tên đúng trên Ads Manager — **chưa kiểm chứng với tài khoản thật**; vượt guardrail bị từ chối và token dùng lại không tạo trùng — có unit/integration test.

## Giai đoạn 6 — Sao chép & tạo mới
- [x] `ads_copy_object` (Meta native theo chiến lược ≤3 ad; OpenAI giả lập)
- [x] `ads_upload_media` (chặn SSRF, tải 1 lần qua guard có ghim IP)
- [x] Tạo mới: `meta_create_*`, `openai_ads_create_*` — tất cả PAUSED, có preview/validate, tiền khai báo qua `moneyOf()` (fail-closed)
- [ ] Sao chép / tạo mới 1 chiến dịch hoàn chỉnh trên tài khoản thử của mỗi nền tảng
**Đạt khi**: sao chép và tạo mới trên tài khoản thử — **chưa kiểm chứng**; logic copy/map id có unit test với fixture.

## Giai đoạn 7 — Nhật ký, Tổng quan, Cài đặt
- [x] `/logs` 2 tab, filter, keyset pagination, Sheet chi tiết (trước → sau, JSON), xuất CSV (ghi log `logs.export`)
- [x] Worker `logs.maintain` (tạo trước + drop partition theo setting), `logs.rollup`, `pending_actions.cleanup`
- [x] Tổng quan (KPI, biểu đồ theo nền tảng, cảnh báo token, hoạt động gần đây), `/settings` (retention 2 loại, 2FA toàn bộ, mặc định MCP, phiên bản API, thông tin hệ thống)
- [ ] Đo hiệu năng trang log với ≥1 triệu dòng giả lập
**Đạt khi**: đổi retention → job drop đúng partition — có test; trang log mượt với ≥1 triệu dòng — **chưa đo**.

## Giai đoạn 8 — Đóng gói & phát hành
- [x] Dockerfile, compose (db/migrate/web/worker/caddy/backup), Caddyfile (che key), `scripts/gen-secrets.sh` + `scripts/gen-env.mjs`, `.env.example` có chú thích tiếng Việt
- [x] README (VI + tóm tắt EN) + `docs/` (lấy token từng nền tảng, kết nối AI, vận hành) — ảnh chụp minh hoạ chưa có
- [x] LICENSE, SECURITY.md; GitHub Actions publish image GHCR (`docker.yml`)
- [x] Hệ thống cập nhật tự động - phần hạ tầng (`scripts/updater*.ts`, target `updater`, service compose, `docker.yml` + Release, gen-env/.env.example, tài liệu 07 §6). Đã chạy thật trên Docker cục bộ; chưa thử với GHCR/VPS thật. Phần web/UI/bảng DB: xem `10-update-system.md`
- [ ] CONTRIBUTING (chưa có — cân nhắc vì giấy phép source-available)
- [ ] **Docker build đầy đủ** (`docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build`; file chính không còn `build:` từ 1.0.0) - chưa chạy kiểm chứng
- [ ] Rà soát bảo mật toàn bộ (`security-reviewer` + `/security-review`) sau khi có trang đăng nhập/người dùng
- [ ] **Test e2e trên VPS thật**
**Đạt khi**: cài mới từ đầu trên VPS sạch theo README trong < 15 phút — **chưa kiểm chứng**.

## Rà soát luồng kết nối / MCP / phân quyền (2026-10-03)
- [x] Bộ test end-to-end `src/server/mcp/__tests__/flows/` (nền tảng giả cho mọi nền tảng đã phát hành → service thật → endpoint `/mcp/<key>` thật, 2 thời kỳ giao thức): ma trận quyền (quyền × phạm vi TK × trạng thái kết nối × trạng thái MCP × vai trò chủ), vòng đời khoá, đồng bộ/token, guardrail trên mọi nền tảng, xác nhận 2 bước, server action với client giả mạo, worker jobs, luồng token cá nhân Meta (adapter thật, HTTP giả). Chạy: `vitest run src/server/mcp/__tests__/flows` (cần `DATABASE_URL` tới DB test riêng).
- [x] Sửa: grant cache không bị xoá khi đổi TKQC/xoá kết nối; TKQC trùng giữa nhiều kết nối bị liệt kê/cộng đôi; hạn mức ghi bị trừ bởi replay/token sai; `ads_list_accounts` phân trang + `connection_status`; TKQC đã đóng/MCC mặc định TẮT khi tạo kết nối; `statusMessage` tách khỏi `statusHint`; key MCP lọt vào log request của `next dev`.
- [x] UI nối theo hợp đồng mới: wizard bước 3 khởi tạo công tắc từ `defaultEnabled` và gửi `disabledExternalIds` + `enabledExternalIds` (chỉ phần khác mặc định); `statusHint` hiện ngay dưới `statusMessage` (chi tiết kết nối, wizard, danh sách, thẻ "Cảnh báo" Tổng quan; không lặp khi message đã chứa); tab Cấu hình MCP báo kết nối đã xoá / TKQC đã tắt sẽ bị loại khi lưu (thanh lưu mở ngay khi có mục bị loại) và tab Tổng quan báo nền tảng chưa có TKQC dùng được.
- [ ] Chưa có đường UI/service để **Tắt** một kết nối (trạng thái `disabled` có trong mô hình nhưng không thao tác nào đặt nó).

## Rà soát nhân sự / phân quyền / xác thực (2026-10-03)
- [x] Bộ test cách ly trên database riêng cho từng file (`src/server/__tests__/people/`, `scripts/cli.integration.test.ts`): ma trận quyền mọi server action × mọi loại người gọi (ẩn danh, nhân viên, admin ± 2FA, buộc đổi mật khẩu, bị khoá, phiên hết hạn/quá `session_max_hours`) × 3 chính sách 2FA, quản lý người dùng đầy đủ + luật admin cuối + hai admin thao tác chéo song song, `/setup` (token, dùng một lần, giới hạn thử, đóng sau người dùng đầu), đăng nhập (không lộ tài khoản, khoá, 2FA, thiết bị tin cậy, cookie HTTPS), cách ly dữ liệu nhân viên (KPI, biểu đồ, nhật ký, xuất CSV, action kết nối/MCP), nhật ký ghi cùng transaction, CLI, độ phủ danh mục `activity_logs`. Chạy: `vitest run src/server/__tests__/people scripts` (cần `DATABASE_URL` tới Postgres, tạo/xoá database `adsmcp_pa_*` tạm).
- [x] Playwright `tests/e2e/authz-matrix.spec.ts` (status + Location của mọi route × người gọi × chính sách, API, CSRF), `people-flows.spec.ts` (chính sách 2FA, không kẹt khi bật bắt buộc, gõ nhầm mật khẩu), `people-users-ui.spec.ts` (quản lý người dùng bằng giao diện thật). Chạy: `E2E_PORT=3116 playwright test` (database riêng `<db>_e2e`).
- [x] Sửa: admin không tắt được 2FA khi chính sách không bắt buộc · endpoint Better Auth ngoài danh sách cho phép (đổi mật khẩu, sửa hồ sơ, thu hồi phiên, danh sách phiên, bật/tắt 2FA…) mở qua HTTP và né chính sách của app · kẻ tấn công khoá được chủ hệ thống chỉ có mật khẩu (khoá email 10 lần từ mọi IP) · CLI in tham số truy vấn (hash mật khẩu) khi lỗi DB · tiêu đề `/setup` lộ sau khi có người dùng · nhân viên nhận HTTP 200 thay vì 404 ở `/users`, `/settings` (do `loading.tsx` bọc layout) · IP IPv6 có zone id làm hỏng insert nhật ký · bảng `verification`/`session`/`rate_limit` phình mãi (thêm job `auth.cleanup`).
- [ ] Còn mở (đề xuất): xác thực lại khi khoá/xoá **admin khác** (hiện chỉ đổi vai trò, tạo admin, đặt lại mật khẩu/2FA admin cần); khoá/xoá hàng loạt admin bằng phiên bị đánh cắp là cách phá hoại lẫn nhau giữa các admin.

## Hệ thống phiên bản & cập nhật (2026-10-03) - thiết kế: `10-update-system.md`
Phần **ứng dụng** (web + worker + DB):
- [x] Bảng `system_update_requests` (migrations `0002` + `0003`, CHECK status/step/target_version chặt, unique index một phần 1 yêu cầu mở, index `created_at`) + khoá nội bộ `app_settings` (`update_latest`, `update_check_error`, `updater_heartbeat`) tách khỏi form Cài đặt
- [x] `src/lib/version.ts` (semver chặt `vX.Y.Z`, bỏ qua pre-release; không import gì để client dùng được) + `src/server/app-version.ts` (`getAppVersion()`: `APP_BUILD_VERSION` → `package.json`) + test
- [x] Kiểm tra GitHub (`UPDATE_REPO` mặc định `notivn/ads-mcp-simple`, `UPDATE_GITHUB_TOKEN` tuỳ chọn): `/releases/latest` → fallback `/tags` theo semver, timeout, lỗi thân thiện (kho riêng tư, 401, rate limit), token không lọt vào log/lỗi - `src/server/jobs/lib/update-check.ts`
- [x] Job `update.check` mỗi 6 giờ (`20 */6 * * *`), không ghi `activity_logs`
- [x] Service `src/server/services/updates.ts` (`getUpdateStatus`, `getVersionBadge`, `checkForUpdatesNow`, `startUpdate`) + server action `checkUpdatesAction` / `startUpdateAction` (admin + re-auth) + `GET /api/updates/status` (admin, no-store, chịu lỗi)
- [x] Giao diện: `/settings/updates` (admin; tiến trình theo bước có poll chịu được lúc web khởi động lại; lịch sử; trạng thái updater + hướng dẫn chạy tay), dòng "Phiên bản vX" trong menu người dùng (desktop + sheet Menu di động) cho mọi người, chấm cảnh báo + mục "Có bản mới" cho admin, cảnh báo ở Tổng quan, thẻ liên kết ở Cài đặt, `PageGuide`
- [x] Nhật ký: `system.update_check`, `system.update_requested` (web) + `system.update_succeeded|failed|rolled_back` (do `updater` ghi)
- [x] Test: semver, parse GitHub (mock fetch: 401/403 rate limit/404 riêng tư/5xx/timeout), `startUpdate` từ chối (staff, target sai, trùng, race 2 admin, updater offline, dev), action RBAC + re-auth sai, API status, job, ràng buộc bảng
- [ ] Service `updater`, Docker/compose, GitHub Actions phát hành tag `v*` (phần hạ tầng, làm riêng, dùng đúng hợp đồng §3)
- [ ] **Chưa kiểm chứng**: cập nhật thật trên VPS (backup → pull → migrate → restart → rollback), chụp màn hình giao diện sáng/tối + 390/1440px, `UPDATE_*` truyền được vào cả `web` lẫn `worker` trong compose
- [ ] Migration phải tương thích ngược 1 phiên bản (expand/contract) vì rollback không đảo migration, ghi trong `07-deployment.md` khi làm phần hạ tầng

## Mở rộng: Trang Facebook (2026-10-03 → 2026-10-04), thiết kế `11-meta-pages.md` (§11 = bản đã làm)
- [x] Research Pages API + cập nhật `providers/meta.md` §10 (version, quyền, page token, bài viết, metric còn sống/đã khai tử)
- [x] Chốt phạm vi P1–P3 (chỉ Facebook Page; Trang từ `/me/accounts` + BM; phân quyền theo Trang)
- [x] Test thật với token via (`scripts/dev-probe-meta-pages.ts`, 2026-10-03): whitelist metric, múi giờ LA, Trang BM, giới hạn 93 ngày — kết quả `providers/meta.md` §10.7; còn vài trường hợp chưa có dữ liệu để test (ghi ở đó)
- [x] Lỗi phát hiện khi test: v26 bỏ tham số `ids` → `ads_set_status` Meta (`setMetaStatus`) hỏng — **đã sửa** (batch GET), unit test + test thật dryRun trên v26; bước ghi (batch POST, không đổi) chưa chạy thật
- [x] Migration `0004_meta_pages` (`meta_pages` + `mcp_page_scopes`), service, activity log `connection.pages.toggle`
- [x] Adapter `meta/pages.ts` + client `pageAccessToken` + cache page token trong bộ nhớ
- [x] Grant + 5 tool `meta_*` Trang + instructions + test (unit + flows)
- [x] UI: thẻ "Trang Facebook" ở kết nối Meta, khối phạm vi Trang trong form MCP, hướng dẫn scope token
- [x] lint + typecheck + 1.278 test + build xanh; chạy thật end-to-end qua endpoint MCP (kết nối "Test 2"); chụp UI sáng/tối 1440/390
- [x] `security-reviewer`: không có lỗi Nghiêm trọng/Cao; 1 Trung bình + 7 Thấp đã sửa kèm test (`11-meta-pages.md` §11)
- [ ] Chưa test thật: Trang **chỉ** thấy qua BM, bài khách đăng / hẹn giờ / bài quảng cáo có dữ liệu, `end_time` mùa đông (PST) - xem `providers/meta.md` §10.7
**Đạt khi**: từ Claude hỏi được "liệt kê Trang", "bài tuần này của Trang X", "chỉ số bài Y", "lượt xem Trang 30 ngày" trên Trang thật; staff không đọc được Trang ngoài phạm vi.

## Thông báo hệ thống trên top bar web (2026-10-04), thiết kế `13-system-notices.md`
- [x] Job `notices.fetch` (1 giờ/lần + khi worker khởi động) GET webhook noti.vn → `app_settings.system_notices` (làm sạch, tối đa 10 × 300 ký tự, giữ 24 h khi webhook lỗi, `SYSTEM_NOTICES_URL` tắt được)
- [x] Chạy chữ ở top bar (desktop/tablet giữa breadcrumb và ô tìm kiếm; phone dải dưới top bar), reduced-motion đứng yên, sáng/tối - đã chụp 1440/820/390
- [x] MCP **không** kèm thông báo hệ thống hay dòng nhắc cập nhật (quyết định chủ dự án 2026-10-05, chống prompt injection; bản 1.0.1 từng kèm, đã gỡ cùng câu dặn trong server instructions)

## Báo lỗi / yêu cầu tính năng, khối Phiên bản, tự kiểm tra cập nhật (2026-10-08)
- [x] Nút nổi "Báo bug, yêu cầu tính năng" (góc dưới phải, máy tính icon + chữ / điện thoại chỉ icon) mở form n8n của noti.vn ở tab mới; tự nâng khi có thanh hành động dính đáy - 06 §13
- [x] Khối "Phiên bản" ở sidebar: hiện tại + mới nhất (admin), link tới `/settings/updates`; `VersionBadge.latestKnown` - 10-update-system
- [x] `/settings/updates` tự kiểm tra GitHub khi mở (không toast, nhật ký `trigger: auto`); e2e trỏ `UPDATE_REPO` tới repo không tồn tại để không ghi đè dữ liệu test
- [x] Chụp sáng/tối 1440 + 390; test dịch vụ cập nhật cập nhật theo `latestKnown` / `trigger`

## Trang "Mẹo chạy tự động" (2026-10-07) - nay là mẹo "Chạy tự động" trong "Mẹo sử dụng" (`/tips/automation`, 2026-10-10)
- [x] Mục menu dưới "Nhật ký" (`/automation-tips`, mọi vai trò; ⌘K; điện thoại: sheet Menu - `bottomMenuItemsForRole().main`), `PageGuide`, `loading.tsx`
- [x] Bộ soạn quy tắc CPA (`src/lib/automation-prompt.ts` + test): câu lệnh đầy đủ, `SKILL.md` (frontmatter trong giới hạn Claude), câu lệnh ngắn gọi skill; tham số khớp `ads_get_report` / `ads_set_status`
- [x] Hướng dẫn Claude (Scheduled tasks: giao diện mới + Cowork, Tool permissions "Always allow", tác vụ cục bộ Claude Desktop 30 phút), ChatGPT (MCP = plugin, không còn Developer mode; tác vụ hẹn giờ trong Work; quyền ghi theo help center chỉ Business/Enterprise/Edu), Gemini (Spark Schedules - chưa dùng được ở VN: custom apps chỉ ở Mỹ; ghi luôn cần xác nhận), Gemini CLI + Task Scheduler/cron (30 phút) - nghiên cứu lại kỹ từ nguồn chính thức 2026-10-07
- [x] Sửa hướng dẫn kết nối Claude/ChatGPT đã cũ (tab Kết nối AI của MCP, `docs/ket-noi-ai.md`, 04 §9)
- [x] Chụp sáng/tối 1440/820/390
- [ ] Chưa chạy thử thật: tác vụ hẹn giờ của từng ứng dụng AI gọi MCP thật - ChatGPT (OpenAI chưa ghi rõ tác vụ hẹn giờ dùng được MCP tự thêm), Claude (tool `destructiveHint` có thể vẫn hỏi duyệt dù Always allow), lệnh Gemini CLI `--trust`/`--skip-trust`

## Trang chính sách công khai cho app Meta/OpenAI (2026-10-05)
- [x] `/privacy`, `/terms`, `/data-deletion` (route group `(legal)`, không cần phiên; `proxy.ts` loại trừ), tiếng Việt + tiếng Anh, nội dung khớp hệ thống (đơn vị vận hành = bên kiểm soát dữ liệu, số tháng lưu nhật ký thật)
- [x] Cài đặt → Thông tin pháp lý (`legal_org_name`, `legal_contact_email`; không cần xác thực lại; ghi `settings.update`)
- [x] Khối "Liên kết cho ứng dụng" dưới sidebar (mở tab mới + sao chép URL tuyệt đối), menu điện thoại, ⌘K
- [ ] Chụp màn hình sáng/tối × 390/1440px; Meta App Dashboard chấp nhận URL trên máy chủ thật (crawler của Meta)

## Phát hành Google Ads (YouTube), TikTok Ads, kênh Telegram (2026-10-08)
Nguồn: nhánh lưu trữ `archive/full-platforms` (chỉ đọc) + nghiên cứu lại tài liệu chính thức 2026-10-08 (Google v25, bỏ developer token, bỏ nhắm ngôn ngữ Search, ma trận YouTube; TikTok v1.3, luồng auth_code, ngừng tạo chiến dịch Manual 2026-12-31). Thiết kế Telegram: `14-telegram-notifications.md`. Checklist phát hành: `12-platform-rollout.md` §2.
- [x] **Adapter**: `providers/{tiktok,google-ads}/**` (+ fixture/test) theo bản đồ port, áp các sửa từ nghiên cứu (Google: không gửi developer token, bỏ language, VIDEO chỉ đọc, preset video + lọc kênh YouTube, YoutubeVideoAsset; TikTok: `TIKTOK_BASE_URL`, scope con, trạng thái mới, Smart+ `current_budget`, lịch ad group đã chạy); `meta/lookup.ts` case `identities`; `providers/index.ts`
- [x] **MCP + bật nền tảng**: `RELEASED_PLATFORMS` (`src/lib/platforms.ts`), `PREFIX`/`PLATFORM_LABEL`/`accountIdCandidates`, level `keyword`, mô tả tool chung, `instructions.ts`, `budget-flight` cho TikTok, test flows (`world.ts`, ma trận quyền, extensions-compat) — kèm lọc `channel_types` / `ad_network_types` (Google, YouTube = Video + Demand Gen) ở `ads_get_report` / `ads_list_objects`, `ads_upload_media` Google (ảnh bytes qua bộ lọc an toàn + video YouTube), test `flows/google-youtube.flows.test.ts`
- [x] **Kết nối (UI)**: thẻ TikTok / Google Ads / YouTube Ads ở `/connections/new`, form Google (service account | OAuth, không còn ô developer token), luồng **TikTok auth_code** (service + action có `throttleProvider` + wizard + "Thay token"), chuỗi `connections.ts` / `connection-status.ts` / `settings.ts` (Phiên bản API), biểu đồ Tổng quan
- [x] **Telegram backend**: migration `notification_channels` / `notification_deliveries` / `mcp_notification_scopes`, `notifications/telegram.ts`, `enqueueNotification`, job `notify.telegram` + dọn dẹp, nguồn sự kiện (ghi MCP, sức khoẻ kết nối, cập nhật), redact token Telegram, activity log `notification_channel.*`
- [x] **Telegram UI + MCP**: tab Telegram ở `/connections`, `/connections/telegram/new` + `[id]`, khối Telegram trong wizard MCP (bước 2–4), tool `telegram_list_channels` / `telegram_send_message`, grant + settings `telegram_*` — phần MCP **xong** (grant `notificationChannels`, settings `telegram_tool` / `telegram_notify_writes` / `telegram_messages_per_hour`, `mcp_notification_scopes` lưu khi tạo/sửa MCP + diff nhật ký, 2 tool + hạn mức/giờ, tự báo sau thao tác ghi, `connection_invalid` từ MCP, khối Telegram wizard/tab Cấu hình/Tổng quan, test `flows/telegram.flows.test.ts`); trang Telegram ở `/connections` (tab, `/telegram/new`, `/telegram/[id]`) + chụp UI sáng/tối 390/1440 - xong
- [x] **Tài liệu / CLI / pháp lý**: CLI `google:refresh-token` (+ test, gợi ý passkey / In production + Verify Branding / service account, không cần developer token; Dockerfile), `legal.ts` (VI + EN: TikTok, Google Ads gồm YouTube, Telegram + cách thu hồi), metadata, từ khoá nav (`tiktok`, `google`, `youtube`, `telegram`), `guides.ts`, `automation.ts` (độ trễ TikTok/Google), seed/demo dev, `docs/ket-noi-ai.md`, `docs/van-hanh.md`, 01/02/04/06/07/09/12, `CLAUDE.md`, rules/skills/agents, `SECURITY.md`
- [x] **Biến môi trường**: `GOOGLE_ADS_API_VERSION` (v25), `TIKTOK_API_VERSION` (v1.3), `TIKTOK_BASE_URL`, `TELEGRAM_API_BASE_URL` trong `env.ts`, `.env.example`, `x-env-runtime` của `docker-compose.yml`
- [x] **Kiểm chứng (2026-10-08)**: lint + typecheck sạch; 1.589 unit/integration + 52 test DB Telegram + 40/40 e2e xanh; `security-reviewer` (0 Nghiêm trọng/Cao; M1 - MCP chỉ dùng kết nối Telegram của chính chủ MCP - và L1–L7 đã sửa kèm test), `ads-api-reviewer` (15 điểm đã sửa, gồm ngân sách ngày linh hoạt TikTok 125%), `ui-reviewer` (đã sửa); chụp UI sáng/tối 390/1440; build image web + updater + smoke test production (migrate 0006, web healthy, worker 11 job)
- [ ] **Còn lại**: kết nối thật (chỉ đọc) TikTok + Google Ads (có chiến dịch YouTube) + 1 nhóm Telegram; `security-reviewer` + `ads-api-reviewer` (TikTok, Google); chụp UI sáng/tối 390/1440 (thẻ nền tảng, form Google/TikTok auth_code, trang Telegram, khối Telegram trong wizard MCP); kết nối thật (chỉ đọc) TikTok + Google Ads (có chiến dịch YouTube) + 1 nhóm Telegram; build image + smoke test trước khi phát hành (minor, `release-notes/`)
**Đạt khi**: kết nối thật đọc được báo cáo TikTok và Google Ads (kể cả chiến dịch YouTube, chiến dịch Video bị từ chối khi sửa), TikTok auth_code đổi được token, tin Telegram tới nhóm thật cho cả 3 nguồn (AI yêu cầu, AI thay đổi quảng cáo, sự kiện hệ thống) và không lộ bot token ở client/log.

## Telegram gửi ảnh / video / tệp qua MCP + dòng ghi nguồn; gộp thẻ YouTube Ads vào Google Ads (2026-10-09), thiết kế `14-telegram-notifications.md` §10
- [x] **Dòng ghi nguồn** mọi tin Telegram: "Ads MCP Simple" in nghiêng (link `https://s.noti.vn/s/ads-mcp-simple`), gắn 1 lần ở tầng gửi (`notifications/credit.ts`, `attemptSend`), cả fallback plain-text và chú thích media
- [x] **Gửi media**: `callTelegramMultipart` + `sendTelegramMedia` (sendPhoto/Video/Document, ảnh bị từ chối → gửi lại dạng tệp, 413 → `file_too_large`), `notifications/media.ts` (tải qua `safeFetch` https + ghim IP, nhận diện magic bytes, chặn loại nguy hiểm/Office có macro/nhúng, tên tệp an toàn, tệp chữ CSV có BOM + chống công thức), semaphore 2/tiến trình + 1/MCP, 20 lượt tải/10 phút/MCP
- [x] **Tool MCP** `telegram_send_message`: `file_url` / `file` (ChatGPT `openai/fileParams`) / `file_content`+`file_name`, `send_as`, chú thích ≤ 800, hạn chót 50 s (ChatGPT cắt 60 s), chống trùng tệp ChatGPT, log không chứa `download_url`/query
- [x] **Gộp thẻ YouTube Ads** vào "Google Ads (gồm YouTube)" ở `/connections/new` (huy hiệu YouTube, ghi chú YouTube luôn hiện ở form Google; link cũ `?platform=youtube` vẫn mở form Google)
- [x] **Kiểm chứng (2026-10-09)**: `security-reviewer` (0 Nghiêm trọng/Cao; M1 chống công thức CSV, M2 hạn mức lượt tải + L1–L11 đã sửa kèm test, gồm L10: tải có guard không đi qua proxy env để giữ ghim IP); lint + typecheck sạch; 1.702 unit/integration + 40/40 e2e xanh; chụp UI thẻ Google Ads sáng/tối 390/1440; build image web + updater + smoke test production
- [ ] **Còn lại**: thử thật với 1 nhóm Telegram (ảnh, video MP4, PDF, XLSX, CSV từ AI, tệp đính kèm ChatGPT); phát hành (`release-notes/`)
**Đạt khi**: AI gửi được tin chữ + ảnh/video/tệp vào nhóm Telegram thật qua MCP, mọi tin có dòng ghi nguồn bấm được, không lộ link ký/token trong log.

## Google Drive & Google Sheet làm nguồn creative (đã phát hành v1.0.6 ngày 2026-10-09), thiết kế `15-google-drive-media.md` (bản thực tế §18)
Quyết định G1–G7 (cách A tham chiếu; thư mục công ty + riêng; ảnh + video; admin thấy tất cả; chia sẻ cho email hệ thống; link công khai có công tắc mặc định bật; đọc sheet + ghi ngược) + GD1–GD5; chủ dự án 2026-10-09: video **hai đường** (nhỏ qua link tạm, lớn tải nền).
- [x] Thiết kế + nghiên cứu Drive v3 / Sheets v4 từ tài liệu chính thức (§12)
- [x] Nghiên cứu tài liệu chính thức nhánh upload: TikTok `UPLOAD_BY_FILE` / `UPLOAD_BY_URL` / tải chia đoạn, OpenAI multipart, Meta `file_url` + `advideos` upload_phase (ghi trong `providers/{tiktok,openai-ads,meta}.md`)
- [x] Helper service account dùng chung `src/server/google/service-account.ts` (scope là tham số, cache theo scope; Google Ads dùng lại) + `src/server/drive/**` + media dùng chung Telegram (`net/media-type.ts`, `net/media-slots.ts`)
- [x] Migration `0007_drive_media` (`drive_credentials`, `drive_sources`, `mcp_drive_scopes`, `drive_media_uploads`, `drive_relay_links`) + `0008_drive_security_jobs` (`ancestor_ids`, `drive_relay_links.source_id`, `media_upload_jobs`); AAD + CLI `reencrypt`; activity `drive_credential.*` / `drive_source.*`
- [x] Link tạm `/dl/*` (route stream + Range, giới hạn token/IP/tiến trình, ngân sách byte, kiểm tra lại grant, `proxy.ts`, `next.config.ts`, Caddy/nginx, redact `adr_`/`AIza`/`resourcekey`)
- [x] MCP: `drive_list_sources`, `drive_list_files`, `drive_sheet_read`, `drive_sheet_update_rows`, `ads_upload_media` (`drive_file` + `file` ChatGPT + tái sử dụng + ảnh bytes 4 nền tảng + video link tạm / tải nền), `ads_get_media_upload`, settings `drive_public_links` / `drive_sheet_writeback` (mặc định bật, kể cả MCP cũ), `instructions.ts`
- [x] Adapter: ảnh bytes TikTok (`UPLOAD_BY_FILE`) + OpenAI (multipart); `deadlineAt`; `uploadVideoChunked` Meta + TikTok
- [x] Job `drive.health`, `drive.cleanup`, `media.video_upload`, `media.upload_sweep`
- [x] UI: Cài đặt → Google Drive hệ thống, tab Google Drive ở Kết nối, `/connections/drive/new` + `[id]` (lưới file + ảnh thu nhỏ, xem trước sheet), service account riêng, khối Drive trong wizard / tab Cấu hình / Tổng quan MCP, từ khoá ⌘K; chụp màn hình dev (credential giả) sáng/tối 390/1440
- [x] Rà soát + sửa: `security-reviewer` (H1 thư mục chứa / nằm trong thư mục riêng của người khác, M1 sheet theo cả file, L1–L9: `drf_`, hạn mức Sheets/MCP, relay, host ghim, thông báo chung, chống công thức) và `ads-api-reviewer` (#4–#7: Range không tính lượt, `deadlineAt`, không lưu URL hết hạn, cảnh báo ảnh TikTok > 10 MB)
- [x] Tài liệu: 01 (§2, §3b, §4, §8), 02, 03, 04, 05, 06, 07 §4b, 15 §18, `CLAUDE.md`, `docs/huong-dan-google-drive.md`, `docs/ket-noi-ai.md`, `docs/deploy-vps.md` (Cloudflare `/dl/*`), `docs/van-hanh.md`, `legal.ts` (VI + EN), `guides.ts`
- [x] Kiểm chứng đầy đủ: lint + typecheck + 2.169 test (gồm test DB) + 44 e2e xanh; `security-reviewer` 2 vòng, `ads-api-reviewer`, `ui-reviewer` (đã sửa)
- [ ] **Thử thật với Google** (§12 UNVERIFIED): thư mục My Drive + Shared drive, link công khai có / không resource key, liệt kê thư mục công khai bằng API key, chi phí quota `alt=media`, lỗi API key sai / API chưa bật ở lần dùng đầu, sheet đọc + ghi ngược (`row_moved`, RAW), `drive.health`
- [ ] **Thử thật với nền tảng** (TKQC thử nghiệm): ảnh từ Drive lên Meta / TikTok / Google / OpenAI; video nhỏ qua `/dl` (TikTok ≤ 10 MB, Meta ≤ 20 MB từ v1.1.2) sau Caddy, Cloudflare proxy (B) và Cloudflare Tunnel (D); **video lớn 200–500 MB tải nền** lên Meta + TikTok (tiến độ, `ads_get_media_upload`, worker 768 MB, worker khởi động lại giữa chừng → `failed` + tải lại); ChatGPT ≤ 60 s; tệp đính kèm ChatGPT
- [x] Build image web + updater + **smoke test production** (migrate 0007 + 0008, web healthy, worker đủ job mới, `/dl` qua Caddy trả 404 cho token lạ, không bị chuyển về /login)
- [x] Phát hành v1.0.6 (`release-notes/v1.0.6.md`; image GHCR đã ký, cosign verify đạt; phát hành thẳng không qua rc là sai quy trình - đã kiểm tra bù đủ các bước của rc trước khi để khách cập nhật): ghi rõ **MCP đã có cũng bật "link Drive công khai" + "ghi trạng thái vào Google Sheet"** (chỉ có tác dụng khi admin thêm API key / sheet bật ghi); cần worker chạy cho video lớn; Cloudflare không challenge `/dl/*`
**Đạt khi**: nhân viên dùng được file trong thư mục công ty + thư mục riêng + link công khai để upload ảnh (4 nền tảng) và video (Meta, TikTok — nhỏ qua link tạm, lớn tải nền) qua MCP, không lấy được file riêng của người khác bằng mã hay link, đọc sheet và ghi ngược trạng thái đúng dòng, video 500 MB tải lên được mà không đệm toàn bộ vào RAM.

## Cài đặt VPS bằng một lệnh (2026-10-09 → 2026-10-10), phát hành v1.0.7
Quyết định chủ dự án: **1 token GitHub** (PAT classic `repo` + `read:packages`) cho clone + GHCR + `UPDATE_GITHUB_TOKEN`; script hỏi GitHub username + token (nhập ẩn); cài **bản phát hành mới nhất** (`--version` để ghim); cuối cùng in link `/setup` + setup key; swap khi RAM ít; tường lửa + cập nhật tự động mặc định bật; HTTPS: tự động (Caddy) hoặc Cloudflare Tunnel.
- [x] `scripts/install-ads-mcp.sh` (installer 1.0.0) + `scripts/ads-mcp` (status, logs, doctor, setup-key, token, update, update-config, backup)
- [x] Thử trong container sạch (Docker-in-Docker): cài mới Ubuntu 24.04 + Debian 12, Cloudflare Tunnel (token giả), chạy lại (giữ nguyên secret), đổi phiên bản, mọi lệnh `ads-mcp`, các tình huống lỗi; shellcheck sạch
- [x] Repo công khai **notivn/ads-mcp-simple-install** (script + `ads-mcp` + README + SHA256SUMS + LICENSE), ruleset bảo vệ `main` (chặn xoá, force-push, chỉ admin được push)
- [x] Tài liệu: `docs/deploy-vps.md` §0 cài nhanh + §5 một token + §15.2 bước 7b đồng bộ repo công khai; `.env.example`, `docker-compose.yml`, README, `van-hanh.md`, 07-deployment
- [ ] **Thử trên VPS thật**: chứng chỉ Let's Encrypt thật, Cloudflare Tunnel thật, tạo swap, UFW, token có hạn dùng, chấp nhận lời mời repo, arm64
**Đạt khi**: một người không rành kỹ thuật cài được trên VPS mới chỉ bằng 2 dòng lệnh + trả lời câu hỏi, có HTTPS thật, tạo được admin bằng setup key, Cài đặt → Cập nhật thấy bản mới nhất.

## Mẹo sử dụng, giải thích Google Drive trong Cài đặt, đổi tên menu (2026-10-10), phát hành v1.0.8
- [x] Cài đặt → thẻ Google Drive hệ thống: khung "Hướng dẫn cấu hình" (Drive dùng để làm gì, lấy khoá JSON, API key không bắt buộc + dùng để làm gì + cách tạo, sau khi lưu) chiếm nửa phải trên màn rộng, xếp dưới form trên mobile; bỏ bước Google Drive khỏi panel hướng dẫn
- [x] Đổi tên menu: "Kết nối quảng cáo" → "Kết nối", "Mẹo chạy tự động" → "Mẹo sử dụng" (UI, pháp lý VI/EN, tài liệu)
- [x] "Mẹo sử dụng" `/tips` với menu con: Chạy tự động (`/tips/automation`, nội dung cũ + cập nhật nghiên cứu 10/10), Tạo quảng cáo số lượng lớn (`/tips/bulk-ads`: mẫu sheet 14 cột, sao chép tiêu đề, tải CSV mẫu, bộ soạn câu lệnh + SKILL.md), Tự động kiểm tra quảng cáo (`/tips/ad-check`: vì sao dùng lịch trên web, Claude web khuyên dùng, MCP bán hàng, bộ soạn câu lệnh + SKILL.md, báo cáo Telegram); `/automation-tips` chuyển hướng 308
- [x] Google Sheet: cột hệ thống mới "Link bài viết" / "Link chiến dịch" (`post_link` / `campaign_link` của `drive_sheet_update_rows`), bí danh trạng thái "Chưa tạo ads" / "Đã tạo ads"…
- [ ] Thử thật quy trình lên quảng cáo hàng loạt và báo cáo theo lịch với Google + TKQC thử nghiệm + MCP bán hàng

## TikTok GMV Max (2026-10-10) - chưa phát hành
- [x] Nghiên cứu API GMV Max (providers/tiktok.md §8): báo cáo BASIC không gồm GMV Max (ít nhất loại tạo từ TikTok Shop) → báo cáo riêng `/gmv_max/report/get/`; tạo GMV Max qua API luôn chạy ngay → không mở cho AI
- [x] 3 tool chỉ đọc `tiktok_gmv_max_shops` / `tiktok_gmv_max_campaigns` / `tiktok_gmv_max_report` (kèm `caution`), cảnh báo trong `ads_get_report` / `ads_list_objects` TikTok
- [x] Chặn đổi ngân sách / sửa / sao chép / xoá / thêm nhóm QC trên chiến dịch GMV Max; bật/tắt luôn xác nhận 2 bước (hook `mustAlwaysConfirm`) + cảnh báo; bật chạy tôn trọng trần ngân sách ngày theo chi tiêu tối đa có thể (hook `activationSpend`); nhận diện fail closed
- [x] Hướng dẫn GMV Max trong form thêm kết nối TikTok (khung lưu ý + hộp thoại hướng dẫn chi tiết + panel hướng dẫn), kiểm tra cửa hàng GMV Max khi kiểm tra kết nối; tài liệu người dùng
- [x] Giai đoạn 2 (chủ dự án duyệt 2026-10-10): mở ghi GMV Max sau công tắc MCP `tiktok_gmv_max_write` **chỉ admin bật** (cần xác thực lại; nhân viên chỉ giữ / tắt / thu hẹp): đổi ngân sách, ROI, sản phẩm, video, tự tăng ngân sách, ngày khuyến mãi, bật/tắt, xoá, **tạo mới + sao chép (chạy ngay, cảnh báo đỏ)**; luôn xác nhận 2 bước (cờ `confirmed` ở adapter), trần ngày theo chi tiêu tối đa có thể + trần cộng dồn 24 giờ cho chiến dịch bắt đầu chạy; đọc lại sau khi ghi; không mở: chuyển tài khoản GMV Max độc quyền, phiên Max delivery, nhóm quảng cáo
- [x] Hướng dẫn kết nối TikTok "tick tất cả quyền"; bước Chọn quyền của MCP có công tắc + bảng ảnh hưởng từng quyền với GMV Max; huy hiệu ở danh sách MCP
- [ ] Chủ dự án quyết: bỏ quyền Exclusive Authorization / Session khỏi danh sách "tick tất cả"? sửa 2 câu "luôn tạm dừng" ở trang pháp lý?
- [ ] e2e `people-flows.spec.ts` "bắt buộc 2FA cho quản trị viên" lỗi cả trên v1.0.8 (có từ trước) - cần xem riêng
- [ ] Thử thật với TKQC có GMV Max (UNVERIFIED §8: `/campaign/get/` có trả GMV Max không, BASIC có trùng không, `primary_status` mặc định, scope id, mã lỗi shop chưa cấp quyền)

## Popup "Miễn trừ trách nhiệm" khi thêm kết nối và khi tạo MCP (2026-10-10) - chưa phát hành
- [x] Nội dung 2 bản (kết nối / MCP) trong `src/lib/i18n/vi/disclaimers.ts`, phiên bản + quy tắc chặn trong `src/lib/disclaimers.ts` (mã băm nội dung ghim bằng test)
- [x] Popup `DisclaimerGate` trước `/connections/new`, `/connections/telegram/new`, `/connections/drive/new`, `/mcp-servers/new` (kéo hết + 10 giây + tick; Huỷ / Esc / ✕ rời trang; tạo MCP khi chưa có kết nối thì không hỏi)
- [x] Server: `acceptDisclaimerAction` ghi `legal.disclaimer_accept`; 5 action tạo từ chối khi người dùng chưa từng xác nhận phiên bản hiện tại; log tạo mang `disclaimerVersion`; Điều khoản dịch vụ §9 (VI + EN)
- [x] Chủ dự án quyết: **hiện 1 lần cho mỗi người dùng và mỗi phiên bản** (trang server tra xác nhận, không giới hạn thời gian; bỏ cửa sổ 12 giờ); tên trong 2 bản nội dung: "Ads MCP Simple by noti.vn" (giữ vai trò Đơn vị vận hành / noti.vn)
- [ ] Chủ dự án quyết: có thêm popup cho "service account riêng" Google Drive (tab Google Drive) / credential Drive hệ thống (Cài đặt) không

## Chế độ bảo vệ MCP Cơ bản / Tùy chỉnh nâng cao + Meta lỗi 31 (2026-10-13), phát hành v1.0.10
- [x] Chủ dự án quyết (2026-10-13): MCP mới mặc định **Cơ bản** (chỉ ngày hết hạn); MCP có sẵn (không có `protection_mode`) giữ **Tùy chỉnh nâng cao** + cấu hình hiện tại; trần ngày bắt buộc chỉ ở nâng cao; GMV Max ở Cơ bản: tạo / sao chép bị từ chối, bật/tắt + đổi ngân sách vẫn được (luôn xác nhận); luôn giữ: xoá + GMV Max luôn xác nhận, object mới tạm dừng, hết hạn, owner/grant, 404 + chặn dò key, giới hạn body (D6)
- [x] Hợp đồng: `PROTECTION_MODES` / `UNLIMITED` / `isUnlimited` (`types.ts`), `parseMcpSettings` + `effectiveMcpSettings` (`settings.ts`), grant dùng giá trị hiệu lực (`grant.ts`), schema + form (`mcp-servers.ts`: mặc định basic, `sanitizeHiddenAdvanced`, `validateProtectionStep`)
- [x] Meta lỗi 31 (subcode 3858385, khách báo) → `ProviderErrorCode` `action_required` (không retry, không đánh kết nối invalid, log `denied`) + `providers/meta.md`
- [x] Runtime: bỏ qua giới hạn `UNLIMITED` (serve rate limit, hạn mức ghi, Telegram/giờ, % ngân sách), không `legacyCapWarning` ở Cơ bản, GMV Max tạo / sao chép bị từ chối ở Cơ bản, service lưu Cơ bản không đòi trần, nhân viên chuyển nâng cao → Cơ bản trên MCP có công tắc GMV Max = mở rộng (từ chối), diff log có `protectionMode`
- [ ] UI: công tắc "Tùy chỉnh nâng cao" ở bước Bảo vệ (wizard + tab Cấu hình), ghi chú Cơ bản, tổng quan MCP hiện chế độ, không badge thiếu trần cho MCP Cơ bản; sáng/tối + 390/1440
- [x] Tài liệu: 01 (§4 bước 4, D2, D6), 03 (`protection_mode`), 04 (§1, §5 `action_required`, §6 Chế độ bảo vệ, GMV Max C5), 05 (§2, §4, checklist), 06 (wireframe ④), 14 (giới hạn tin/giờ chỉ ở nâng cao), `docs/ket-noi-ai.md`, `docs/huong-dan-google-drive.md`, `docs/huong-dan-telegram.md`, `docs/huong-dan-lay-token-tiktok.md`, `docs/huong-dan-lay-token-meta.md` (lỗi 31), `release-notes/v1.0.10.md` (nháp)
- [x] Rà câu chữ pháp lý / miễn trừ / mẹo trong `src/lib/i18n/vi/*` còn nói "luôn xác nhận 2 bước / luôn có trần" (danh sách do agent tài liệu báo cáo) - đã sửa legal.ts (cập nhật 13/10/2026), tips.ts, automation.ts, guides.ts, mcp.ts; disclaimers.ts giữ nguyên (vẫn đúng, đổi sẽ bắt mọi người đồng ý lại)
- [x] Kiểm chứng: lint + typecheck + unit + build + e2e; `security-reviewer`, `ui-reviewer`; build image + smoke production; rc → v1.0.10

## Quyết định đã chốt (2026-10-02)
1. Giấy phép: **proprietary source-available** — chỉ đơn vị được noti.vn cấp quyền bằng văn bản mới được dùng (`LICENSE`, song ngữ). Không dùng từ "mã nguồn mở" trong UI/README.
2. GitHub: tổ chức **notivn**, repo **Ads-MCP-simple** → image `ghcr.io/notivn/ads-mcp-simple`.
3. D1–D5 giữ mặc định như `01-product-spec.md` §9.
4. shadcn preset **radix-maia** (bo tròn, thoáng); preset dùng bộ icon **Hugeicons** (`@hugeicons/react` + `@hugeicons/core-free-icons`) — giữ nguyên, KHÔNG trộn lucide; font đổi Figtree → **Inter**.
5. Chủ dự án có TKQC thật để test (giai đoạn 5–6: chỉ thao tác trên object thử nghiệm được chỉ định).

## Giãn cách lệnh ghi (write delay) ở chế độ Tùy chỉnh nâng cao (2026-10-14)
- [x] Chủ dự án quyết (D7): tự chờ rồi chạy, theo từng MCP, mọi lệnh ghi lên nền tảng, mặc định tắt; trần chờ + giãn cách tối đa 30 s (không phải 60 s: ChatGPT cắt tool call ở 60 s)
- [x] `write_delay_seconds` (types / parser / `effectiveMcpSettings` basic → 0 / schema + form / service: nhân viên không giảm được trên MCP GMV Max đã duyệt)
- [x] `src/server/mcp/write-pacing.ts` (hàng đợi FIFO theo MCP, chờ từ lúc lệnh trước xong, `write_cooldown` khi chờ > 30 s (từ chối ngay nếu hàng đợi chắc chắn vượt), `write_cancelled` khi client huỷ) + gắn vào `runWrite` trước luồng xác nhận
- [x] UI: ô "Giãn cách giữa các lệnh ghi" trong nhóm Giới hạn tốc độ; dòng tổng quan; ghi chú Cơ bản
- [x] Test: unit (đồng hồ giả), tích hợp qua endpoint, schema / parser / nhân viên; tài liệu 01 (D7), 03, 04 §6, `docs/ket-noi-ai.md`
- [x] Phát hành v1.0.11 (2026-10-14, qua rc)

## Apify — lấy dữ liệu qua MCP (2026-10-14 → 2026-10-15), thiết kế `16-apify.md` (§12 = bản thực tế) - chưa phát hành
- [x] Chủ dự án quyết (A1–A4 = D8 ở `01-product-spec.md` §9): token công ty + cá nhân (kho MCP = công ty + cá nhân của chủ MCP); danh mục chọn lọc + công tắc "Actor ngoài danh mục" chỉ admin bật; trần mỗi lần chạy luôn bật ($1, cả Cơ bản), trần ngày chỉ ở Tùy chỉnh nâng cao; MCP vẫn cần ≥ 1 nền tảng quảng cáo
- [x] Nghiên cứu API Apify + Actor Store, thiết kế `16-apify.md` (+ `providers/apify.md`, `providers/apify.openapi.json`)
- [x] Backend: bảng `apify_tokens` / `apify_runs` (migration `0009_apify`), `src/server/apify/{client,errors,store,pool,actors,health}.ts`, job kiểm tra token + dọn `apify_runs` > 90 ngày, service + action (`apify_token.*` trong `activity_logs`), AAD + redact `apify_api_…`, `reencrypt`, xoá người dùng còn token
- [x] Danh mục việc `src/server/apify/catalog*` (~30 việc lõi + beta ẩn; Actor chính + dự phòng; ép giới hạn; không cookie / login)
- [x] UI Kết nối: tab Apify, `/connections/apify/new` (miễn trừ trách nhiệm), `/connections/apify/[id]`, nhóm "Nguồn dữ liệu" ở `/connections/new`, icon thương hiệu; 4 tab vừa 360 px; sáng/tối + 390/1440
- [x] MCP: settings `apify_*` (parser + `effectiveMcpSettings`), grant (kho token), tool `apify_*`, `SERVER_INSTRUCTIONS`, thẻ Apify ở bước Quyền + trần ngày ở bước Bảo vệ + tổng quan, công tắc Actor ngoài danh mục chỉ admin bật
- [x] Tài liệu + pháp lý: `CLAUDE.md`, 01 (§1, §2, §3c, §4, D8), 02, 04, 05, 06, 07, 08, `.claude/rules/{mcp-server,logging-and-secrets}.md`, `docs/huong-dan-apify.md`, `docs/ket-noi-ai.md`, `README.md`, `legal.ts` (VI + EN, cập nhật 14/10/2026), miễn trừ trách nhiệm `connection` (thêm mục Apify, phiên bản 2026-10-14 + mã băm test); đồng bộ với code 2026-10-15: `16-apify.md` §4/§5/§7 + §12 bản thực tế, 03 (khoá settings), 05 (xác thực lại, giữ chỗ trần ngày, rủi ro chế độ Cơ bản), 01 §4, hướng dẫn bước 3–4 của wizard MCP (`guides.ts`)
- [x] Kiểm chứng (2026-10-15): lint + typecheck + unit + Postgres + flows (2848 test) + e2e (lỗi 2FA ở auth.spec có sẵn từ v1.0.11) + build + smoke production + ảnh chụp; 2 vòng `security-reviewer` + rà lỗi logic, đã sửa hết
- [ ] Smoke test bằng token Apify thật (nên gói Starter — gói Free một số Actor Shopee trả dữ liệu mẫu; Shopee VN best-effort); bổ sung kết quả smoke test vào `16-apify.md` §12.5 + `providers/apify.md` §15
- [x] Phát hành v1.1.0 (2026-10-15, qua rc; ghi chú phát hành: mọi người xác nhận lại miễn trừ trách nhiệm `connection`)

## Apify là nền tảng của MCP (2026-10-15, quyết định A5 = D9, `16-apify.md` §12.4) - chưa phát hành
- [x] Wizard + tab Cấu hình: thẻ nền tảng Apify ở bước "Nền tảng & tài khoản" (cùng kiểu thẻ nền tảng quảng cáo, hiện cả khi chưa có kết nối), thẻ quyền Apify ở bước "Quyền" (bỏ nhóm "Lấy dữ liệu (không bắt buộc)"); lỗi / focus theo bước mới
- [x] Kiểm tra: ≥ 1 nền tảng quảng cáo hoặc Apify (form + zod create / update / config); service từ chối MCP chỉ dùng Apify khi kho token của chủ MCP trống
- [x] `/mcp-servers/new` mở được khi chỉ có token Apify; trạng thái trống nêu Apify; Tổng quan: khối Apify trong "Phạm vi MCP"; danh sách MCP: icon + bộ lọc Apify; instructions riêng cho MCP không có nền tảng quảng cáo
- [x] Test: schema, service (Postgres), flows (MCP chỉ dùng Apify chỉ có `apify_*`), unit instructions, e2e bước 2; tài liệu 01 (D9), 04, 06, 16, `docs/huong-dan-apify.md`, `docs/ket-noi-ai.md`
- [ ] Orchestrator kiểm chứng UI (ảnh chụp bước 2 / 3 sáng-tối, 390 / 1440) + e2e đầy đủ; phát hành

## Google Ads: nhắm mục tiêu chiến dịch + asset Search (2026-10-19 → 2026-10-20), v1.1.7
Nguồn yêu cầu: góp ý khách (tool "google_ads_update_campaign_criteria": loại vị trí, bán kính, lịch chạy, gắn / gỡ asset). Chủ dự án quyết: làm cả phần nhắm mục tiêu và asset, **không** đổi mặc định sang PRESENCE (bỏ trống = mặc định Google). Thiết kế + API: `providers/google-ads.md` §5 "Nhắm mục tiêu chiến dịch & asset Search", 04 (bảng tool).
- [x] Research doc chính thức Google Ads API v25 (2026-10-19): geo target type, ProximityInfo, AdScheduleInfo, asset sitelink / callout / call / snippet / price / promotion, CampaignAsset / CustomerAsset, GAQL
- [x] `targeting.ts`: `google_ads_get_campaign_targeting`, `google_ads_update_campaign_targeting` (luôn xác nhận; 1 mutate nguyên khối; diff lịch chạy; chặn gỡ hết vị trí trừ `allow_no_location`); `google_ads_create_search_campaign` thêm `positive_geo_target_type` / `proximities` / `ad_schedules`
- [x] `assets.ts`: `google_ads_list_assets`, `google_ads_create_assets` (chỉ tạo vào thư viện, dùng lại asset trùng, giá hiển thị không phải chi tiêu), `google_ads_link_assets` (quyền Sửa, luôn xác nhận)
- [x] Sao chép chiến dịch giữ bán kính + liên kết asset cấp chiến dịch (`copy.ts`); map lỗi tiếng Việt (`errors.ts`); `SERVER_INSTRUCTIONS`; trần số tool trong test 45 → 50
- [x] Rà soát: `ads-api-reviewer` + `security-reviewer` (0 Nghiêm trọng / Cao; M1 tạo asset không được gắn vào chiến dịch, M2 nhắm mục tiêu luôn xác nhận, L1–L3 + kết quả không chắc chắn khi mất kết nối — đã sửa kèm test)
- [ ] Thử thật với tài khoản Google Ads (chỉ object thử nghiệm): header "Service catalog" / "Services", gắn lại link đã gỡ, price asset `languageCode=vi`, bán kính trên PMax
- [x] Tài liệu: 01, 04, `providers/google-ads.md`, `docs/ket-noi-ai.md`, `release-notes/v1.1.7.md`
