# 16 — Apify: kết nối token + lấy dữ liệu qua MCP

> Trạng thái: thiết kế chốt 2026-10-14, **đã triển khai 2026-10-15** — **§12 = bản thực tế** (tham chiếu chính khi sửa code Apify; §1–§11 giữ thiết kế, đã đồng bộ với code ở §4, §5, §7). API Apify: `providers/apify.md` (+ `providers/apify.openapi.json`). Nghiên cứu Actor: §6 + nguồn trong `providers/apify.md`.
> Hướng dẫn người dùng: `docs/huong-dan-apify.md`. Quyết định A1–A4 = D8, A5 (thay A4, 2026-10-15) = D9 ở `01-product-spec.md` §9.

## 1. Mục tiêu

- Ở **Kết nối** có thêm tab **Apify**: dán **API token** của Apify (chỉ cần token), thêm được **nhiều token**.
- MCP có thêm nhóm tool `apify_*`: AI lấy dữ liệu qua Apify (vd. "lấy dữ liệu sản phẩm X trên Shopee rồi phân tích"). **Hệ thống tự chọn Actor phù hợp** từ danh mục đã chọn lọc; AI tự phân tích dữ liệu trả về.
- **Xoay vòng token ngẫu nhiên**; token hết tiền → tự chuyển sang token khác.

## 2. Quyết định của chủ dự án (2026-10-14)

| #   | Quyết định                                                                                                                                                                                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | **Token công ty + token cá nhân** (giống Drive): admin thêm token "Dùng chung công ty" — mọi MCP bật Apify đều xoay vòng được; nhân viên (và admin) thêm token "Cá nhân" — chỉ MCP **của chính người đó** dùng. Kho của 1 MCP = token công ty + token cá nhân của **chủ MCP**.          |
| A2  | **Danh mục chọn lọc + mở rộng tuỳ chọn**: mặc định chỉ dùng danh mục ~30 việc (mỗi việc có Actor chính + dự phòng, server tự đặt giới hạn an toàn). Công tắc **"Cho phép Actor ngoài danh mục"** (tìm trên Apify Store) — mặc định **tắt**, **chỉ admin bật** (giống công tắc GMV Max). |
| A3  | **Trần chi phí mỗi lần chạy luôn bật** (mặc định **$1**, cả ở chế độ Cơ bản; Apify tự dừng run khi chạm trần qua `maxTotalChargeUsd`). **Trần theo ngày mỗi MCP chỉ ở Tùy chỉnh nâng cao.**                                                                                             |
| A4  | ~~MCP **vẫn cần ít nhất 1 nền tảng quảng cáo**; Apify là công cụ bổ sung (bật ở bước Quyền).~~ — **đã thay bằng A5** (2026-10-15).                                                                                                                                                       |
| A5  | (2026-10-15) **Apify là một nền tảng** ngang hàng Meta / TikTok / Google Ads / OpenAI Ads: thẻ nền tảng ở bước "Nền tảng & tài khoản", thẻ quyền ở bước "Quyền". MCP cần ít nhất 1 trong Meta / TikTok / Google Ads / OpenAI Ads / **Apify** → **MCP chỉ dùng Apify hợp lệ**; một MCP cũng có thể làm tất cả (đọc số liệu, tạo / sửa / bật tắt quảng cáo **và** lấy dữ liệu Apify để phân tích). |

Phát hiện phải nói với người dùng (UI + tài liệu): Điều khoản Apify §4.3 **cấm một người lập nhiều tài khoản Personal** → xoay vòng chỉ hợp lệ giữa token của **các tài khoản Apify hợp pháp khác nhau**; nhiều token cùng một tài khoản **dùng chung credit** (hệ thống tự gộp theo `apify_user_id`).

## 3. Mô hình dữ liệu (migration `0009_apify`)

Bảng thường (không partition), tạo bằng Drizzle (`db-change` skill).

### `apify_tokens`

| Cột                                            | Kiểu                                                              | Ghi chú                                                                        |
| ---------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| id                                             | uuid pk default uuidv7()                                          | sinh **trước** insert (dùng trong AAD)                                         |
| scope                                          | text CHECK in ('company','personal')                              | company: chỉ admin tạo/sửa/xoá                                                 |
| owner_id                                       | text → user.id ON DELETE RESTRICT                                 | người tạo (company: admin đã thêm); personal: chủ token                        |
| name                                           | text                                                              | tên gợi nhớ (≤ 80, lọc ký tự điều khiển/bidi)                                  |
| credentials_encrypted                          | text                                                              | AES-256-GCM, AAD `apify_token:<id>:credentials` (`aad.apifyTokenCredentials`)  |
| credential_hint                                | text                                                              | 4 ký tự cuối                                                                   |
| apify_user_id                                  | text null                                                         | từ `GET /v2/users/me` — gộp token cùng tài khoản (chung credit)                |
| apify_username                                 | text null                                                         | hiển thị                                                                       |
| plan_id / plan_tier                            | text null                                                         | vd. FREE / STARTER; tier FREE…DIAMOND (giá PPE theo bậc)                       |
| usage_usd / limit_usd                          | numeric(12,4) null                                                | `/users/me/limits` current.monthlyUsageUsd / limits.maxMonthlyUsageUsd (cache) |
| cycle_end_at                                   | timestamptz null                                                  | `monthlyUsageCycle.endAt` (credit reset)                                       |
| status                                         | text CHECK in ('active','exhausted','invalid','error','disabled') | exhausted = hết credit tới `exhausted_until`                                   |
| status_message                                 | text null                                                         | tiếng Việt, đã redact                                                          |
| exhausted_until                                | timestamptz null                                                  | = cycle_end_at khi hết credit                                                  |
| last_checked_at, last_used_at                  | timestamptz null                                                  |                                                                                |
| created_at, updated_at ($onUpdate), deleted_at | timestamptz                                                       | soft delete: xoá bí mật (mã hoá lại `""`)                                      |

Index: `owner_id`, `scope`, `apify_user_id`. **Không lưu** email, `proxy.password` hay object `proxy` của Apify.

### `apify_runs`

| Cột                                 | Kiểu                                      | Ghi chú                                                                                                                    |
| ----------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| id                                  | uuid pk                                   |                                                                                                                            |
| mcp_id                              | uuid → mcp_servers.id ON DELETE CASCADE   |                                                                                                                            |
| token_id                            | uuid → apify_tokens.id ON DELETE RESTRICT | **ghim token**: mọi thao tác sau (get run, dataset, abort) dùng đúng token đã start (tài nguyên Apify mặc định Restricted) |
| actor_id                            | text                                      | `username~name`                                                                                                            |
| task_key                            | text null                                 | việc trong danh mục; null = Actor ngoài danh mục                                                                           |
| run_id                              | text                                      | id run Apify                                                                                                               |
| dataset_id                          | text null                                 | defaultDatasetId                                                                                                           |
| status                              | text                                      | READY/RUNNING/…/SUCCEEDED/FAILED/TIMED-OUT/ABORTED                                                                         |
| max_charge_usd                      | numeric(10,4)                             | trần đã gửi                                                                                                                |
| usage_usd                           | numeric(12,4) null                        | `usageTotalUsd` thực (cập nhật khi get run)                                                                                |
| item_count                          | integer null                              |                                                                                                                            |
| started_at, finished_at, created_at | timestamptz                               |                                                                                                                            |

Unique (`mcp_id`, `run_id`); index (`mcp_id`, `created_at`), `token_id`. Dọn bản ghi > 90 ngày (job). AI chỉ truy cập được run **do chính MCP đó khởi chạy**.

Hành vi xoá user (`deleteUserByAdmin`): đếm token còn sống của user (chặn như kênh Telegram) + purge token đã soft-delete. Token company do user đó tạo: chặn xoá user cho tới khi admin chuyển/xoá token.

## 4. Kiến trúc server

Thư mục mới `src/server/apify/` (**không import `next/*`**, không `server-only` ở module job):

- `client.ts` — `fetch` tới `https://api.apify.com/v2` (hằng số, override `APIFY_API_BASE_URL` https-only cho test/sandbox), `Authorization: Bearer` (**không bao giờ** `?token=`), `redirect:"error"`, `cache:"no-store"`, timeout + signal của caller, retry backoff cho **GET** 429/5xx (≤ 2 lần, tổng ≤ 5 s); **POST start run không bao giờ thử lại** (Apify không có khoá idempotency cho run): kết quả mơ hồ (timeout, lỗi mạng, 5xx, phản hồi không đọc được) → tra ≤ 3 run gần nhất của tài khoản (`GET /v2/actor-runs?desc=1`) tìm run cùng Actor + **cùng input**, bắt đầu sau lúc gửi (lệch đồng hồ ≤ 10 s), không thuộc MCP khác → nhận lại (`recovered`); không thấy → lỗi `start_uncertain` (xem §7, §12). Không đưa URL/token vào lỗi. `fetchImpl`/`baseUrl` cho test.
- `errors.ts` — `ApifyError { code, httpStatus, apifyType, retryable, rotate: "exhausted"|"invalid"|"busy"|null, userMessageVi, hint }`; phân loại theo bảng lỗi `providers/apify.md` §9 (402 có `type` ≠ `x402-payment-required`, 403 `platform-feature-disabled` + "usage", `not-enough-usage-*`, `*memory-limit-exceeded`, `concurrent-runs-*`/`cannot-start-actor-runs`, 401 `user-or-token-not-found`, `user-disabled`…).
- `store.ts` — chỗ **duy nhất** mã hoá/giải mã token (`encryptApifyToken`, `loadApifyToken`).
- `pool.ts` — kho token của MCP + xoay vòng (§5).
- `catalog.ts` (+ `catalog/*.ts`) — danh mục việc (§6): định nghĩa input chuẩn hoá (zod), map sang input Actor, giới hạn ép buộc, trường kết quả gợi ý, Actor chính + dự phòng.
- `actors.ts` — chạy Actor (validate-input miễn phí → start `POST /v2/actors/{id}/runs?timeout&memory&maxTotalChargeUsd&waitForFinish`), đọc run, đọc dataset (luôn có `limit`), abort; kiểm tra Actor ngoài danh mục (từ chối FULL_PERMISSIONS / deprecated / UNDER_MAINTENANCE / rental; chặn trường input nguy hiểm: cookie/login/password/session, `pageFunction`/`*Function`, `webhooks`, `outputConnector`/`mcpConnectors`, `proxyUrl`/proxy tự đặt…).
- `health.ts` + job `apify-health` (cron mỗi 6 giờ): `GET /users/me` + `/users/me/limits` cho token còn sống; cập nhật status/usage/cycle, gỡ `exhausted` khi qua `exhausted_until` hoặc còn credit; lỗi tạm thời giữ nguyên trạng thái; không bump `updated_at`. Job dọn `apify_runs` cũ.
- Services `src/server/services/apify-tokens.ts` + actions `src/server/actions/apify.ts` (mẫu `notification-channels` / `drive-credentials`): list (staff: token công ty — chỉ xem tên/trạng thái/credit, không sửa — + token cá nhân của mình; admin: tất cả), preview (kiểm tra token, không lưu), create (disclaimer `connection` bắt buộc, kiểm tra upstream **ngoài** transaction, insert + `activity_logs` trong transaction), rename, replace token (re-auth), recheck, enable/disable, delete (soft, xoá bí mật, ghi số MCP bị ảnh hưởng), `invalidateGrantCache()` sau mọi thay đổi. Quota `consumeQuota("apify-verify", userId, 10, 60s)` cho thao tác gọi Apify.
- Activity actions mới: `apify_token.create|update|replace_token|recheck|enable|disable|delete` (nhóm `apify_token` trong `ACTIVITY_GROUPS`, nhãn ở `vi/logs.ts` + `vi/account.ts`, danh mục ở `03-database-schema.md` §4; `activity-coverage.test.ts` tăng số đếm).
- Redact: thêm mẫu giá trị `apify_api_[A-Za-z0-9]+`; `scripts/cli.ts reencrypt` thêm cột mới.

## 5. Kho token & xoay vòng

- Kho của MCP (tính khi dựng grant, cache cùng grant): token `scope='company'` + token `scope='personal' AND owner_id = chủ MCP`, `deleted_at is null`, `status in ('active','exhausted')` (exhausted chỉ dùng lại khi `exhausted_until <= now`). Grant chỉ giữ **id + nhãn + apify_user_id + số liệu credit**, không giữ bí mật.
- Chọn token cho 1 lần chạy: gộp theo `apify_user_id` (token không biết user id = nhóm riêng); bỏ nhóm có token `invalid/disabled/exhausted` còn hạn; còn lại chọn **ngẫu nhiên có trọng số theo credit còn** (`limit_usd − usage_usd`, dữ liệu cache ≤ 5 phút — quá cũ thì gọi `/users/me/limits` trước); yêu cầu credit còn ≥ min(trần lần chạy, $0.05).
- Start run lỗi thuộc nhóm xoay (`rotate != null`): `exhausted` → **đọc lại `/users/me/limits` (miễn phí) trước**: chỉ khi credit còn thật sự < min(trần lần chạy, $0,05) mới đánh dấu **cả nhóm cùng `apify_user_id`** hết tới `cycle_end_at` (không có → +24 h); không xác nhận được (vd một Actor đắt / mức phí tối thiểu) → chỉ bỏ qua tài khoản ở lần này; `invalid` → token `invalid` + status_message; `busy` (RAM/run đồng thời) → không đánh dấu, chỉ bỏ qua lần này. Thử token kế tiếp — tối đa **3 lần**, tổng thời gian vẫn trong ngân sách tool (≤ 45 s). Nhóm không xoay (input sai, Actor không tồn tại/full-permission, 429, 5xx) → trả lỗi ngay.
- Hết token dùng được → lỗi `apify_no_token` (VI): "Không còn token Apify nào dùng được (hết credit / lỗi)…" + hint tới trang Kết nối → Apify.
- Đã start → ghi `apify_runs` (token ghim). Client huỷ ngay sau khi start → abort run (không tốn tiền vô ích).
- Mọi lần đổi trạng thái token → cập nhật DB (không bump `updated_at`) + `invalidateGrantCache()`.

## 6. Danh mục việc (catalog)

Nguồn: nghiên cứu Store 2026-10-14 (`providers/apify.md` phần Actor). Mỗi việc: `key`, tên/mô tả tiếng Việt, `input` zod chuẩn hoá (vd. `{ url }`, `{ keyword, limit }`, `{ page_url, limit }`), `limit` mặc định + tối đa, `actors: [chính, dự phòng…]` mỗi Actor có hàm `buildInput(params)` (luôn **ghi đè mọi trường giới hạn** — số kết quả, số trang, số review — và **không bao giờ** truyền cookie/login), `timeoutSecs`, `memoryMbytes` (≤ 4096), `resultFields` gợi ý, `beta` (mặc định ẩn), ghi chú hạn chế (vd. Shopee VN best-effort).

Việc lõi (~30): shopee_search, shopee_product, shopee_shop_products, shopee_reviews, lazada_search, lazada_product, lazada_reviews, tiktokshop_search, tiktokshop_product, tiktokshop_reviews, tiktok_search_videos, tiktok_hashtag_videos, tiktok_profile_videos, tiktok_comments, tiktok_top_ads (Creative Center), facebook_ads_library, facebook_page_posts, facebook_page_info, facebook_group_posts, facebook_comments, instagram_profile, instagram_posts, instagram_hashtag, youtube_search, youtube_channel, youtube_comments, google_maps_places, google_maps_reviews, google_serp, google_ads_transparency, web_page_read, website_crawl. Beta (ẩn): tiki_*, tiktok_trends, google_trends, google_shopping.

Fallback Actor: chỉ chuyển sang Actor dự phòng khi Actor chính **không chạy được** (404, deprecated, maintenance, full-permission, input bị Apify từ chối) — **không** tự chạy lại khi run đã tốn tiền mà kết quả xấu (AI có thể gọi lại với `actor_choice: "fallback"`).

## 7. MCP

### Settings (`mcp_servers.settings`, snake_case; parser từng trường như các khoá khác)

| Khoá                  | Mặc định               | Ghi chú                                                                                                             |
| --------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `apify_enabled`       | false (chỉ `=== true`) | bật nhóm tool `apify_*` (cần kho token ≥ 1); = "nền tảng Apify" của MCP (A5) — không có nền tảng quảng cáo thì bắt buộc `true` + kho ≥ 1 token |
| `apify_run_max_usd`   | 1                      | trần mỗi lần chạy, 0.05–20, **áp dụng cả ở Cơ bản** (A3)                                                            |
| `apify_daily_max_usd` | 10                     | trần/ngày mỗi MCP (giờ VN), 0–1.000, 0 = không giới hạn; **chỉ áp ở advanced** — basic: `effectiveMcpSettings` → `UNLIMITED` |
| `apify_store_actors`  | false (chỉ `=== true`) | Actor ngoài danh mục — **chỉ admin bật** (service kiểm tra như `tiktokGmvMaxWrite`); nhân viên giữ/tắt được         |

- Admin bật `apify_store_actors` (false → true) cần **xác thực lại** (mật khẩu + 2FA, `withReauth` như công tắc GMV Max; log reauth ghi lý do `apify_store_actors`); nhân viên bật → lỗi trường `settings.apifyStoreActors` ("Chỉ quản trị viên được bật Actor ngoài danh mục Apify.").
- Nhân viên trên MCP có công tắc GMV Max do admin bật: **không** nâng `apify_run_max_usd`, **không** nâng / bỏ (đặt 0) `apify_daily_max_usd` → lỗi trường `settings.apifyRunMaxUsd` / `settings.apifyDailyMaxUsd` (quy tắc widening hiện có; chuyển nâng cao → Cơ bản cũng bị chặn như trước).
- **Cùng quy tắc khi `apify_store_actors` do admin bật vẫn bật** (bảo mật M1, `assertNoStaffApifyStoreWidening`): nhân viên không nâng trần lần chạy, không nâng / bỏ trần ngày, không chuyển nâng cao → Cơ bản (lỗi trường tương ứng / `settings.protectionMode`, câu `MCP_ERRORS.apifyStoreStaffWidening`); tắt công tắc rồi lưu thì hết ràng buộc.
- Chế độ Cơ bản chỉ giữ **trần mỗi lần chạy** (chủ dự án 2026-10-15: không thêm trần ngày tối thiểu cho Cơ bản).
- Form: ô USD của Apify dùng `parseUsdText` (dấu `.` hoặc `,` thập phân, tối đa 2 chữ số, **không** nhóm hàng nghìn — "0.125" / "1.000" là lỗi, không bao giờ thành 125 / 1000 như ô ngân sách).
- Parser: `apify_enabled` / `apify_store_actors` chỉ `=== true`; trần thiếu / hỏng → mặc định (1 / 10). `effectiveMcpSettings` ở `basic`: `apifyDailyMaxUsd = UNLIMITED`, `apifyRunMaxUsd` giữ nguyên.

### Tool (prefix `apify_`; bản thực tế 2026-10-15, code `src/server/mcp/tools/apify/`)

Toolset `apify` chỉ đăng ký khi `apify_enabled === true` **và** kho có ≥ 1 token (company + personal của **chủ MCP**, chưa xoá, `active|exhausted`); `"apify"` nằm trong danh sách loại trừ của `COMMON_TOOL_PERMISSIONS`; mỗi handler kiểm tra lại (`assertApifyEnabled` → `permission_denied` khi MCP đã tắt Apify). 5 tool (8 khi bật `apify_store_actors`).

| Tool | Loại | Input → kết quả |
|---|---|---|
| `apify_list_tasks` | read (không gọi Apify) | `{group?, task?, include_beta?}` → danh mục: `key`, mô tả, `input` rút gọn (`trường: "bắt buộc · kiểu (mặc định …)"`), `limit` mặc định / tối đa, chi phí ước tính, `has_fallback`, ghi chú hạn chế (bỏ ghi chú khi danh sách > ~22k ký tự); có `task` → `task_detail` (JSON Schema đầy đủ, ví dụ input, Actor chính / dự phòng + trường kết quả). Luôn kèm **`pool`**: số tài khoản / tài khoản dùng được, credit còn ước tính, `next_reset_at`, `run_max_usd`, `daily_max_usd` (null = không có), `spent_today_usd`, `left_today_usd`. Không lộ token, tên token, email, username Apify. |
| `apify_run_task` | write (tốn tiền, **chạy ngay**, không xác nhận 2 bước) | `{task, input, limit?, max_charge_usd?, wait_secs? ≤ 25 (mặc định 20), actor_choice?: "primary" \| "fallback"}`; `limit` = số kết quả, kẹp theo tối đa của việc. Input Actor **đã dựng** được quét giá trị giống bí mật (`containsSecretValue` của `redact.ts`: token, `?token=` / `?key=`, link tải tạm `/dl/adr_…`…) → `apify_input_invalid` (L5). Actor của danh mục tính phí theo tài nguyên (`APIFY_USAGE_BILLED_ACTORS`: `apify~rag-web-browser`, `apify~website-content-crawler`) → `timeout` hạ để RAM × thời gian × 0,2 USD/CU ≤ trần (M2; phí proxy không nằm trong trần, cảnh báo trong kết quả). Start với `waitForFinish=0` (khoá trần ngày giữ ngắn), rồi long-poll `GET /actor-runs/{id}?waitForFinish` bằng **token ghim**; cả lời gọi ≤ 45 s (phần start ≤ 30 s). Xong kịp → `item_count` + ≤ 5 dòng đầu (làm sạch, ≤ 8k ký tự); chưa xong → `run_id` + `next_step` (`apify_get_run`). Output: `run_id, status, finished, status_message, task, actor_id, actor_choice (primary\|fallback\|store), max_charge_usd, usage_usd, item_count, items, items_truncated, started_at, finished_at, next_step, warnings, notice`. Dự phòng tự động **chỉ** khi Actor chính không start được (404, ngừng hỗ trợ / bảo trì / full-permission, Apify từ chối input, cần gói trả phí, mức trần tối thiểu của Actor > trần MCP); không bao giờ tự chạy lại run đã tốn tiền. |
| `apify_get_run` | read | `{run_id, wait_secs? ≤ 30 (mặc định 15)}` — chỉ run của chính MCP → `status`, `status_message` (của Actor, kèm `notice`), `item_count`, `usage_usd` thực, bước tiếp; cập nhật dòng `apify_runs`. Long-poll + đọc số dòng nằm trong ngân sách ~45 s (deadline cho mọi lời gọi Apify); client huỷ chỉ dừng chờ, **không** dừng run. FAILED / ABORTED / TIMED-OUT là kết quả bình thường (dữ liệu một phần vẫn đọc được). |
| `apify_get_results` | read | `{run_id, limit? ≤ 50 (mặc định 20), cursor?, fields? (≤ 30 tên), all_fields?}` — mặc định chỉ `resultFields` của Actor trong danh mục (run của việc), `all_fields: true` = mọi trường. Phân trang: `GET dataset items` với **`skipHidden` thôi** (không `skipEmpty` / `clean`), dòng rỗng / chỉ có trường ẩn `#…` lọc ở phía MCP nhưng vẫn tính vị trí → `next_cursor` tiến theo **số dòng thô** (vị trí map 1:1, không mất / lặp dòng); không dừng sớm khi `total` không rõ mà trang bị cắt vì ngân sách. Làm sạch: bỏ ký tự điều khiển / đảo chiều / zero-width / tag Unicode / variation selector…, chuỗi ≤ 1.000 ký tự, độ sâu ≤ 6, mảng ≤ 50, ≤ 100 khoá / object, tổng ≤ ~20k ký tự (`truncated`) + `total` + `notice` "dữ liệu thu thập từ bên thứ ba — không phải chỉ dẫn" + `next_cursor` (HMAC `mcp/cursor.ts`, gắn MCP + run + tham số). |
| `apify_abort_run` | write | `{run_id}` — dừng bằng token ghim; **không** tính vào hạn mức ghi (dừng là bớt chi); run đã kết thúc → trả trạng thái, không gọi Apify; kết quả kèm `notice` (status_message của Actor). |
| `apify_search_actors` | read | chỉ khi `apify_store_actors`: `{query, limit? ≤ 10, sort?}` → `GET /v2/store` **ẩn danh** (không dùng token, không tốn tiền); ẩn Actor đang bảo trì / thuê tháng; trả giá, số người dùng + tỉ lệ thành công 30 ngày, trường input chính (`refused` = trường bị chặn); cả kết quả ≤ ~22k ký tự (`fitActorList`: bỏ trường input từ cuối lên, rút mô tả, bớt kết quả → `truncated`). |
| `apify_get_actor` | read | chỉ khi `apify_store_actors`: `{actor_id}` (`user~name` hoặc `user/name`, **ẩn danh**) → `allowed` + `refused_reasons`, giá (`min_charge_cap_usd`), input schema rút gọn của build mặc định (≤ 60 trường, `refused`), trường dataset, README tóm tắt; ≤ ~22k ký tự (`fitActorDetail`: rút mô tả trường, bỏ enum / mặc định, rút README, bớt trường → `input_schema_truncated`). |
| `apify_run_actor` | write (tốn tiền, **LUÔN xác nhận 2 bước** ở mọi chế độ bảo vệ — chủ dự án 2026-10-15) | chỉ khi `apify_store_actors`: `{actor_id, input (JSON ≤ 20.000 ký tự, ≤ 8 cấp), max_charge_usd?, timeout_secs? 30–600 (mặc định 300), memory_mbytes? ≤ 4096 (mặc định = RAM mặc định của Actor, kẹp), wait_secs? ≤ 25, fields?, confirm_token?, reason?}` → (cả 2 bước) quét trường input nguy hiểm + giá trị giống bí mật (dưới) → kiểm tra Actor (từ chối full-permission, deprecated, bảo trì, rental, Standby) → trần như `apify_run_task`; Actor tính phí theo tài nguyên (pay-per-usage **hoặc** PPE có `isPPEPlatformUsagePaidByUser` true / không rõ): `timeout` hạ để RAM (GB) × thời gian (giờ) × 0,2 USD/CU ≤ trần (phí proxy không nằm trong trần) → lần gọi đầu: `confirmation_required` + preview (Actor, `input_summary` đã làm sạch, `max_charge_usd`, timeout / RAM, giá) + `confirm_token` (`confirm.ts` `runConfirmFlow` với `alwaysConfirm`, như `ads_delete_object`); gọi lại cùng tham số + token → trần ngày sơ bộ (trước khi tiêu token) → `admitWrite` (chỉ khi thực thi) → `validate-input` → chạy như `apify_run_task` (`task: null`, `actor_choice: "store"`). Replay token đã dùng → kết quả cũ (`replayed: true`), kết quả lưu để replay **không** chứa dòng dữ liệu. |

Annotations: run → `readOnly false, destructive true, idempotent false, openWorld true`; abort → `false, false, true, true`; đọc có gọi Apify → `READ_ANNOTATIONS` + `openWorldHint: true`; `apify_list_tasks` → `READ_ANNOTATIONS`.

Quy tắc chung:

- **Trần lần chạy** = min(`max_charge_usd` AI xin, `apify_run_max_usd`) → gửi `maxTotalChargeUsd` (Apify tự dừng run khi chạm trần); luôn áp dụng, **cả ở Cơ bản** (A3). Actor có mức trần tối thiểu: AI bỏ trống → dùng trần MCP (đủ thì chạy); AI **tự đặt** thấp hơn mức tối thiểu → `apify_run_cap_too_low` nêu mức tối thiểu (không bao giờ tự nâng sau lưng AI — L4); trần MCP thấp hơn → `apify_run_cap_too_low` (việc trong danh mục thử Actor dự phòng trước). `timeout` ≤ 600 s. **`memory` luôn gửi** (lũy thừa của 2 trong 128–4096 MB; việc trong danh mục không đặt → **1024 MB**) để chi phí start / RAM không phụ thuộc mặc định của Actor. Actor tính phí theo tài nguyên chặn chi phí bằng timeout × memory (M2, xem từng tool); phí proxy không nằm trong trần (UI + kết quả tool nói rõ).
- **Trần ngày** (chỉ `advanced`): kiểm tra sơ bộ (thông báo thân thiện, trước khi tính hạn mức ghi) **và** kiểm tra **nguyên tử** trong `startActorRunForMcp`: dưới `pg_advisory_xact_lock(hashtext('apify:<mcpId>'))` cộng chi tiêu hôm nay (`mcpApifySpendToday`, giờ VN: run đã kết thúc có `usage_usd` → giá trị thực, còn lại → `max_charge_usd`) + trần lần này ≤ `apify_daily_max_usd`, rồi chèn **dòng giữ chỗ** `status = 'STARTING'`, `run_id = 'pending:<uuid>'`, `max_charge_usd` = trần → các lời gọi song song thấy nhau, không vượt trần. Start xong → dòng thành bản ghi run (run id + token thật); thất bại chắc chắn (validate, từ chối, hết token…) → xoá; không chắc đã start (`start_uncertain`, client huỷ giữa POST, lỗi lạ) → **giữ** (vẫn tính trần trong ngày). Vượt → `apify_daily_budget_exceeded`.
- **Một POST start duy nhất** (§4): không thử lại; nhận lại run khi tìm thấy (cảnh báo "không chạy 2 lần"); không thấy → `apify_start_uncertain` (có thể đã chạy — AI không gọi lại ngay; trần vẫn tính). Client huỷ giữa POST → tìm run vừa tạo và abort; client huỷ ngay sau start → abort.
- **Xoay token**: credit cache > 5 phút → đọc lại `/users/me/limits` trước khi chọn; lỗi loại hết credit khi start → đọc lại limits, chỉ đánh dấu cả tài khoản `exhausted` khi credit thật sự không đủ (§5); ≤ 3 lần thử, không thử cùng token 2 lần; mọi tài khoản chỉ bị bỏ qua (bận / chưa xác nhận hết credit) → trả lỗi đó thay vì `apify_no_token`. `validate-input` (miễn phí) trước mỗi start.
- **Hạn mức ghi**: `apify_run_task` / `apify_run_actor` tính 1 lượt `admitWrite` (run_task: sau kiểm tra trần ngày sơ bộ, trước lần start đầu; run_actor: lúc thực thi bước 2, preview / replay không tính); `apify_abort_run` không tính. `apify_run_task` không qua xác nhận 2 bước; `apify_run_actor` luôn qua. Không qua giãn cách lệnh ghi quảng cáo (`write_delay_seconds`).
- **Ngân sách thời gian** (~45 s / lời gọi): start ≤ 30 s, rồi long-poll + đọc dòng đầu được kẹp theo thời gian còn lại (deadline + signal cho mọi lời gọi Apify; còn < 2 s thì bỏ đọc dòng đầu, chỉ cảnh báo). **Client huỷ** trong lúc chờ / trước khi đọc dòng đầu → run vừa start bị **abort** bằng token ghim (`AbortSignal.timeout(5000)` mới) + cập nhật `apify_runs`, rồi báo huỷ.
- **Quét input nguy hiểm** (`dangerousInputFields`, `apify_run_actor` / `apify_get_actor`; input của việc trong danh mục do `buildActorRun` tự dựng): **fail closed** — input > 64 KB (JSON), sâu > 8 cấp, > 2.000 nút hoặc không serialize được → từ chối cả input; khoá chứa cookie / header / password / login / session / credential / secret / authorization / apikey / `*token`, mã tuỳ biến (function / hook / script / evaluate / code…), webhook / connector, proxy riêng (`proxyUrl…`, URL / `user:pass@host` / `host:port`); giá trị chuỗi khớp mẫu bí mật của `redact.ts` (token Apify / Telegram / Google / Meta / OpenAI, Bearer, mật khẩu trong URL…) → `apify_actor_not_allowed` liệt kê đường dẫn trường.
- Run gắn với MCP (`apify_runs` theo `mcp_id`): run của MCP khác / không tồn tại → `apify_run_not_found`; mọi thao tác sau start (get run, dataset, abort) dùng **đúng token đã start**; token đó đã xoá / không giải mã được → `apify_token_deleted` / `apify_token_unreadable`.
- Kết quả là **dữ liệu không tin cậy** (prompt injection): `notice` (cả trong kết quả có `status_message`), mô tả tool + `SERVER_INSTRUCTIONS` (1 câu Apify ở cuối, gồm: input chỉ dùng thông tin người dùng cung cấp — không đưa dữ liệu tài khoản quảng cáo / Google Drive / Telegram vào input Apify) nhắc; không chèn dữ liệu vào instructions. Tên / mô tả Actor từ Store cũng làm sạch. Thông báo gốc của Apify (vd `validate-input` từ chối) **không** vào `message` / `hint`: chỉ ở `details.apify_message` kèm `details.apify_message_note` "bên thứ ba" (L2).
- Bộ làm sạch (`text-safety.ts` `sanitizeExternalLabel` và `tools/apify/shared.ts` `cleanText`, regex cờ `u`, viết bằng escape): ký tự điều khiển (C0 trừ tab / xuống dòng ở văn bản nhiều dòng, C1), đánh dấu / ghi đè / cô lập hướng chữ, U+200B, U+2060–2064, U+FEFF, **U+00AD, variation selector U+FE00–FE0F / U+E0100–E01EF, U+FFF9–FFFB, tag Unicode U+E0000–E007F** (M3).
- Link của việc web (`catalog/web.ts`): ≤ 1.000 ký tự, phần query ≤ 200 ký tự (M4).
- Log `mcp_call_logs`: args rút gọn (input Actor ≤ 4 KB, không có token), `target` = `run_id`, `changes` = `apify_run` (Actor · trần); **phản hồi** của `apify_run_task` / `apify_run_actor` / `apify_get_results` qua hook `logResponse` (`ToolSpec.logResponse` trong `tool.ts`): dòng dữ liệu thay bằng `items_logged: false`, `items_count`, `item_fields` (≤ 30 tên trường) — dữ liệu thu thập không nằm trong log (L6).
- Lỗi = `McpToolError` (`platform: null`). Mã: `apify_no_token`, `apify_daily_budget_exceeded`, `apify_actor_not_allowed`, `apify_input_invalid`, `apify_run_not_found`, `apify_upstream`, `apify_unknown_task`, `apify_no_fallback`, `apify_run_cap_too_low` (mức tối thiểu của Actor > trần MCP), `apify_actor_not_found`, `apify_actor_id_invalid`, `apify_token_deleted`, `apify_token_unreadable`, `apify_no_dataset`, `apify_start_uncertain`, và mã Apify giữ tên `apify_<code>` (`apify_out_of_credit`, `apify_account_busy`, `apify_paid_plan_required`, `apify_insufficient_permissions`, `apify_charge_limit_invalid`, `apify_response_too_large`…) + mã chung (`write_rate_limited`, `timeout`, `invalid_cursor`, `permission_denied`). Câu tiếng Việt: `src/lib/i18n/vi/apify-errors.ts`.

## 8. UI (đồng bộ design system hiện tại)

- **Kết nối**: tab thứ 4 **Apify** (kiểm tra 360 px: rút gọn nhãn tab nếu cần) — bảng: Tên, Phạm vi (Công ty / Cá nhân), Tài khoản Apify (username · gói), Credit (đã dùng / giới hạn, ngày reset), Trạng thái, Kiểm tra lần cuối, menu thao tác; nhân viên thấy token công ty ở dạng chỉ xem. Nút chính `brand` "Thêm token Apify". `PageGuide` hướng dẫn lấy token (Console → Settings → API & Integrations) + cảnh báo ToS nhiều tài khoản + khuyên đặt hard limit chi tiêu trong Apify Console.
- **Thêm token** `/connections/apify/new`: `DisclaimerGate kind="connection"`; form: Tên, Token (`SecretInput`), Phạm vi (admin: Công ty/Cá nhân; staff: cố định Cá nhân) → "Kiểm tra" (hiện username, gói, credit còn, ngày reset) → Lưu; sau khi lưu có nút "Thêm token khác". Lựa chọn Apify cũng xuất hiện ở wizard `/connections/new` (nhóm mới "Nguồn dữ liệu").
- **Chi tiết** `/connections/apify/[id]`: thông tin, credit, MCP đang dùng được (ẩn danh với staff), lịch sử chạy gần đây (từ `apify_runs`, tối đa 20), nút Kiểm tra lại / Đổi tên / Thay token (re-auth) / Tắt-Bật / Xoá (`ConfirmDialog` gõ tên).
- **MCP wizard / tab Cấu hình** (A5, 2026-10-15): bước **Nền tảng & tài khoản** — **thẻ nền tảng Apify** sau 4 thẻ nền tảng quảng cáo, cùng kiểu (BrandIcon, tiêu đề "Apify", 1 dòng mô tả, công tắc "Dùng Apify trong MCP này"; thân thẻ: kho token của chủ MCP — số token / tài khoản Apify / dùng được ngay / công ty – cá nhân; không có token dùng được → công tắc khoá + link "Thêm token Apify"); luôn hiện, kể cả khi chủ MCP chưa có kết nối quảng cáo. Bước **Quyền** — **thẻ quyền Apify** trong cùng danh sách với thẻ quyền từng nền tảng (chỉ khi đã bật): ô "Trần mỗi lần chạy (USD)", công tắc "Cho phép Actor ngoài danh mục" (badge "Chỉ quản trị viên"), ghi chú điều khoản. Bước Bảo vệ (Nâng cao) — "Trần Apify mỗi ngày (USD)". Ghi chú Cơ bản: trần mỗi lần chạy vẫn áp dụng. Tab Tổng quan: khối Apify trong "Phạm vi MCP" + các dòng Apify. Danh sách MCP: icon Apify cạnh icon nền tảng.
- Chuỗi tiếng Việt ở `src/lib/i18n/vi/apify.ts` (+ `mcp.ts`, `connections.ts`, `guides.ts`); icon thương hiệu Apify trong `BRAND_MARKS`.

## 9. Pháp lý & bảo mật

- `legal.ts` (VI + EN): thêm Apify vào danh sách bên thứ ba (Chính sách quyền riêng tư §5 Chia sẻ dữ liệu, Điều khoản §6 dịch vụ bên thứ ba), nêu trách nhiệm hợp pháp của việc thu thập dữ liệu, tác giả Actor xem được input/output; cập nhật `updatedAt`.
- Miễn trừ trách nhiệm `connection`: thêm 1 đoạn Apify → **tăng `DISCLAIMER_VERSIONS.connection`** (mọi người đồng ý lại khi thêm kết nối lần tới) + cập nhật hash test.
- Token Apify = quyền chi tiền: mã hoá AAD, không trả client/AI/log, re-auth khi thay, redact `apify_api_…`. Không có tool "gọi API Apify tuỳ ý"; không bao giờ gọi `PUT /users/me/limits`.
- Không đưa dữ liệu nhạy cảm (token, mật khẩu) vào input Actor; chặn trường cookie/login.

## 10. Kiểm thử

- Unit: client (fake fetch: header Bearer, không `?token=`, redirect error, retry GET, không retry start), phân loại lỗi, pool (gộp user id, trọng số, xoay khi exhausted/invalid/busy, hết token), catalog (mỗi việc: input → input Actor có giới hạn ép, không cookie), làm sạch kết quả, settings/schema.
- Service (Postgres thật): quyền admin/staff (company vs personal), preview/create/replace/delete, activity logs, users delete.
- Flows MCP (`world.ts`): tool chỉ hiện khi bật + có token; run_task chọn token, xoay khi token đầu hết credit, trần lần chạy/ngày, run của MCP khác → không thấy.
- E2E: tab Apify (admin vs staff), trang thêm (disclaimer), 404 token người khác.
- **Chưa test live** (không có token): sau khi build, chủ dự án thêm 1 token thật (nên gói Starter — gói Free một số Actor Shopee trả dữ liệu mẫu) để smoke test từng việc; Shopee VN để "best-effort".

## 11. Câu hỏi còn mở (cần token thật)

Xem `providers/apify.md` §15: status/type chính xác khi hết credit lúc start; run đang chạy khi hết credit; scoped token chạy Actor Store được không; độ trễ `monthlyUsageUsd`; `maxTotalChargeUsd` với Actor pay-per-usage.

## 12. Bản thực tế (2026-10-15)

Tham chiếu chính khi sửa code Apify. Chi tiết tool / quy tắc: §7 (đã đồng bộ) + `04-mcp-design.md` "Tool Apify".

### 12.1 File / module

| Phần | File |
|---|---|
| Hợp đồng dùng chung | `src/lib/schemas/apify.ts` (scope / status, `APIFY_TOKEN_RE`, zod input, DTO, `APIFY_LIMITS`: tên ≤ 80, trần lần chạy 0,05–20 (1), trần ngày 0–1.000 (10)), `src/server/apify/types.ts` |
| DB | `src/server/db/schema/apify.ts`, migration `drizzle/0009_apify.sql` (+ `meta/0009_snapshot.json`) |
| Gọi Apify (không `next/*`) | `src/server/apify/client.ts` (fetch + Bearer, host cố định, `redirect: "error"`, retry GET 429/5xx), `errors.ts` (`ApifyError` + `rotate`), `actors.ts` (users/me, limits, store, actor, build, validate-input, start + phục hồi, run, recent runs, abort, dataset, `dangerousInputFields`, `storeActorRefusals`), `store.ts` (mã hoá / giải mã, `loadGrantApifyTokens`, ghi trạng thái không bump `updated_at`), `pool.ts` (chọn / xoay token, giữ chỗ trần ngày, `startActorRunForMcp`, bản ghi run, `mcpApifySpendToday`, dọn run cũ), `health.ts` |
| Danh mục | `src/server/apify/catalog.ts` + `catalog/{shopee,lazada,tiktokshop,tiki,tiktok,facebook,instagram,youtube,google,web,common}.ts` — **32 việc lõi + 6 beta ẩn** (`tiki_search`, `tiki_product`, `tiki_reviews`, `tiktok_trends`, `google_trends`, `google_shopping`; `include_beta` mới hiện); hằng `APIFY_MAX_TIMEOUT_SECS = 600`, `APIFY_MAX_MEMORY_MBYTES = 4096` |
| Service / action | `src/server/services/apify-tokens.ts` (list / detail / preview / create / rename / enable / replace / recheck / delete / `getMcpApifyPoolSummary`; `ApifyServiceError`), `src/server/actions/apify.ts` (7 action; tạo cần miễn trừ trách nhiệm `connection`; gọi Apify: `consumeQuota("apify-verify", 10/phút)`; thay token: re-auth) |
| Job | `src/server/jobs/apify-health.ts` — `apify.health`, cron **`10 */6 * * *`** (APP_TIMEZONE): kiểm tra lại mọi token sống chưa tắt (`/users/me` + limits, song song 3; lỗi tạm thời giữ nguyên dòng; gỡ `exhausted` khi qua hạn / còn credit) + xoá `apify_runs` > **90 ngày** |
| MCP | `src/server/mcp/tools/apify/{index,list-tasks,run-task,run-actor,run-common,get-run,get-results,abort-run,search-actors,get-actor,shared,store-shared}.ts`; `mcp/types.ts` (`McpGrant.apifyTokens`, 4 khoá settings), `settings.ts` (parser + `effectiveMcpSettings`), `grant.ts` (nạp kho token chỉ khi `apifyEnabled`), `registry.ts`, `instructions.ts`, `tool.ts` (`ToolSpec.logResponse`), `confirm.ts` (`apify_run_actor` luôn 2 bước); danh mục: `APIFY_USAGE_BILLED_ACTORS` + `ApifyActorRunPlan.usageBilled` trong `catalog.ts` |
| Cấu hình MCP | `src/lib/schemas/mcp-servers.ts` (form + `toStoredMcpSettings`, `parseUsdText`), `src/server/services/mcp-servers.ts` (`assertApifyStoreSwitchAllowed`, re-auth khi admin bật Actor ngoài danh mục, nhân viên không nới trần Apify trên MCP có GMV Max hoặc có Actor ngoài danh mục do admin bật — `assertNoStaffApifyStoreWidening`) |
| UI | `src/app/(dashboard)/connections/_components/apify-tokens-table.tsx`, `connections/apify/{page,new,[id]}/**` (form thêm, kết quả kiểm tra, badge, chi tiết, đổi tên, thay token), `connections/new` (nhóm "Nguồn dữ liệu"), `mcp-servers/_components/apify-sections.tsx` (+ wizard, tab Cấu hình, bước Bảo vệ, Tổng quan), `components/app/platform-icon.tsx` (`BRAND_MARKS.apify`), `nav.ts` |
| Chuỗi | `src/lib/i18n/vi/apify.ts` (UI), `apify-errors.ts` (lỗi server), `mcp.ts` (khối Apify), `connections.ts`, `guides.ts`, `logs.ts` / `account.ts` (nhãn `apify_token.*`), `legal.ts`, `disclaimers.ts` (`connection` = 2026-10-14) |
| Bảo mật / vận hành | `crypto/secret-box.ts` (`aad.apifyTokenCredentials`), `audit/redact.ts` (`apify_api_…`), `audit/activity-log.ts` (7 action `apify_token.*`, nhóm `apify_token`), `env.ts` (`APIFY_API_BASE_URL` https, không có trong compose), `services/users.ts` (chặn xoá người dùng còn token, xoá hẳn token đã xoá mềm + run của nó), `scripts/cli.ts` `reencrypt` |

### 12.2 Bảng & settings

- `apify_tokens`, `apify_runs`: §3 + `03-database-schema.md` (gồm dòng giữ chỗ trần ngày `STARTING` / `pending:<uuid>`).
- `mcp_servers.settings`: `apify_enabled` (false), `apify_run_max_usd` (1; 0,05–20; luôn áp dụng), `apify_daily_max_usd` (10; 0–1.000, 0 = không giới hạn; `basic` → không áp dụng), `apify_store_actors` (false; chỉ admin bật, bật cần xác thực lại).
- `activity_logs`: `apify_token.create|update|replace_token|recheck|enable|disable|delete` (+ `disclaimerVersion` khi tạo).

### 12.3 Kiểm thử đã có

- Unit (không mạng, fake fetch `src/server/apify/__fixtures__/apify-fetch.ts`): `src/server/apify/{client,errors,actors,pool,health,catalog}.test.ts`, `src/server/mcp/tools/apify/shared.test.ts` — 2026-10-15: 248 đạt, 18 bỏ qua (phần cần Postgres).
- Postgres thật: `src/server/services/apify-tokens.test.ts` (quyền admin / nhân viên, công ty / cá nhân, preview / tạo / thay / xoá, activity log), `src/server/services/mcp-servers-apify.test.ts` (công tắc chỉ admin + re-auth, nhân viên không nới trần), cập nhật `users-admin.test.ts`, `authz-matrix.test.ts`, `scripts/cli.integration.test.ts`.
- Flows MCP: `src/server/mcp/__tests__/flows/apify.flows.test.ts` (tool chỉ hiện khi bật + có token, chọn / xoay token, trần lần chạy / ngày, run của MCP khác không thấy, phân trang 1:1 với dòng rỗng + `skipHidden`, log phản hồi không có dữ liệu, client huỷ → abort, `apify_run_actor` 2 bước + replay…); cập nhật `settings.test.ts`, `mcp-servers.test.ts` (schema), `redact.test.ts`, `env.test.ts`, `activity-coverage.test.ts`, `jobs/index.test.ts`, `extensions-compat.test.ts`, `unit.test.ts`.
- E2E: `tests/e2e/apify.spec.ts` (tab Apify admin / nhân viên, trang thêm + miễn trừ trách nhiệm, 404 token người khác), `tests/e2e/authz-matrix.spec.ts`.
- Pháp lý: `src/lib/disclaimers.test.ts` (mã băm `connection@2026-10-14`), `src/lib/legal.test.ts`.

### 12.4 Apify là nền tảng của MCP (A5, 2026-10-15)

- **Form** (`mcp-servers/_components/apify-sections.tsx`): `ApifyPlatformCard` (bước 2, truyền vào `PlatformsSection` qua `extraCards` — hiện cả khi không có kết nối quảng cáo; id công tắc `mcp-apify-enabled`), `ApifyPermissionsCard` (bước 3, truyền vào `PermissionsSection` qua `extraCards` khi `apifyEnabled`; `PermissionsSection` chỉ còn hiện "Hãy chọn ít nhất 1 nền tảng…" khi không có nền tảng nào kể cả Apify), `ApifyScopeBlock` (Tổng quan "Phạm vi MCP", cần `apifyPool` của chủ MCP). Bỏ nhóm "Lấy dữ liệu (không bắt buộc)". Lỗi server `settings.apifyEnabled` → bước 2 (wizard `mapServerErrors`) / focus công tắc trên thẻ nền tảng (tab Cấu hình); `settings.apifyRunMaxUsd` / `settings.apifyStoreActors` → bước 3.
- **Kiểm tra**: client `validatePlatformsStep` + zod `mcpConfigSchema` / `createMcpSchema` / `updateMcpSchema` (`refineAtLeastOnePlatform`, lỗi ở `platforms`): ≥ 1 nền tảng quảng cáo **hoặc** `settings.apifyEnabled`; câu "Chọn ít nhất 1 nền tảng (Meta, TikTok, Google Ads, OpenAI Ads hoặc Apify).". Service `assertApifyOnlyHasPool` (tạo + lưu, trong transaction): không có nền tảng quảng cáo + Apify bật → kho của **chủ MCP** (`loadGrantApifyTokens`, đúng kho grant xoay vòng) phải có ≥ 1 token, không thì lỗi trường `settings.apifyEnabled` (`MCP_ERRORS.apifyOnlyNoToken`).
- **Trang**: `/mcp-servers/new` mở wizard (và hỏi miễn trừ trách nhiệm `mcp`) khi có ≥ 1 kết nối quảng cáo **hoặc** token Apify dùng được ngay (`hasUsableApifyToken`, `src/lib/schemas/apify.ts`); không có → trạng thái trống nêu cả hai + nút "Thêm kết nối" (brand) / "Thêm token Apify".
- **Danh sách MCP**: `McpListItem.apifyEnabled` → icon Apify cạnh icon nền tảng (bảng + thẻ mobile), bộ lọc Nền tảng có "Apify"; MCP không có nền tảng quảng cáo không hiện tóm tắt quyền.
- **MCP endpoint**: MCP chỉ dùng Apify không có `mcp_platform_permissions` → chỉ `apify_*` (+ `telegram_*` / `drive_*` nếu cấu hình nguồn / kênh); `serverInstructionsFor(grant)` trả `SERVER_INSTRUCTIONS_NO_ADS` (không nhắc `ads_list_accounts`). Tool `assertApifyEnabled` hướng chủ MCP tới "Nền tảng & tài khoản".
- **Test**: `src/lib/schemas/mcp-servers.test.ts` (A5: chỉ Apify hợp lệ, không chọn gì → lỗi, cả create / update / config schema), `src/server/services/mcp-servers-apify-only.test.ts` (Postgres: tạo / sửa MCP chỉ dùng Apify cho nhân viên và admin, kho theo chủ MCP, kho trống → lỗi `settings.apifyEnabled`, tắt Apify khi không có nền tảng → lỗi `platforms`), `apify.flows.test.ts` (MCP chỉ dùng Apify: chỉ tool `apify_*`, instructions không có `ads_*`, chạy việc được), `unit.test.ts` (`serverInstructionsFor`), e2e `tests/e2e/mcp-servers.spec.ts` (thẻ Apify ở bước 2).

### 12.5 CHƯA thử với Apify thật (chưa có token)

- Dạng lỗi chính xác khi **hết credit** lúc start (HTTP status + `error.type`: 402 / 403 `platform-feature-disabled` / `not-enough-usage-*`…) — code phân loại theo nhiều biến thể và đọc lại limits trước khi đánh dấu `exhausted`; cần xác nhận bằng tài khoản thật.
- Run đang chạy khi tài khoản hết credit (bị dừng hay chạy tiếp, `statusMessage`); độ trễ cập nhật `monthlyUsageUsd`; `maxTotalChargeUsd` với Actor pay-per-usage / PPE + usage.
- **Chất lượng dữ liệu Shopee VN** (best-effort; gói Free một số Actor trả dữ liệu mẫu) và mọi việc trong danh mục với input thật.
- **Scoped token** (token giới hạn quyền): có chạy được Actor Store không sở hữu, đọc được `/users/me/limits` không.
- Phục hồi sau POST mơ hồ (`recovered` / `start_uncertain`) trên mạng thật.
- Việc cần làm: chủ dự án thêm 1 token thật (nên gói Starter) → smoke test từng nhóm việc, ghi kết quả vào `providers/apify.md` §15 và sửa danh mục nếu Actor hỏng.
