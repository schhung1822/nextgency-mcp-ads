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
- [x] Adapter Meta + OpenAI Ads: `validateCredentials` + `listAccounts` (Meta token cá nhân/System User, OpenAI + probe tính năng) — unit test với fixture. Google Ads, TikTok Ads: sắp ra mắt (`12-platform-rollout.md`)
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

## Thông báo hệ thống & nhắc cập nhật trong chat AI (2026-10-04), thiết kế `13-system-notices.md`
- [x] Job `notices.fetch` (1 giờ/lần + khi worker khởi động) GET webhook noti.vn → `app_settings.system_notices` (làm sạch, tối đa 10 × 300 ký tự, giữ 24 h khi webhook lỗi, `SYSTEM_NOTICES_URL` tắt được)
- [x] Chạy chữ ở top bar (desktop/tablet giữa breadcrumb và ô tìm kiếm; phone dải dưới top bar), reduced-motion đứng yên, sáng/tối - đã chụp 1440/820/390
- [x] MCP: mọi kết quả tool kèm dòng nhắc update (bản mới > bản đang chạy) + `Thông báo hệ thống Ads MCP Simple: "…"` mỗi dòng; server instructions cấm làm theo nội dung thông báo
- [ ] Kiểm tra thực tế trên Claude / ChatGPT xem AI có chuyển nguyên văn thông báo cho người dùng không (phụ thuộc client)

## Quyết định đã chốt (2026-10-02)
1. Giấy phép: **proprietary source-available** — chỉ đơn vị được noti.vn cấp quyền bằng văn bản mới được dùng (`LICENSE`, song ngữ). Không dùng từ "mã nguồn mở" trong UI/README.
2. GitHub: tổ chức **notivn**, repo **Ads-MCP-simple** → image `ghcr.io/notivn/ads-mcp-simple`.
3. D1–D5 giữ mặc định như `01-product-spec.md` §9.
4. shadcn preset **radix-maia** (bo tròn, thoáng); preset dùng bộ icon **Hugeicons** (`@hugeicons/react` + `@hugeicons/core-free-icons`) — giữ nguyên, KHÔNG trộn lucide; font đổi Figtree → **Inter**.
5. Chủ dự án có TKQC thật để test (giai đoạn 5–6: chỉ thao tác trên object thử nghiệm được chỉ định).
