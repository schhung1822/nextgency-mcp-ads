# 17 — TikTok Social: tài khoản TikTok (không trả tiền) qua TikTok Social MCP

> Trạng thái: **đã làm 2026-11-15 (chưa commit / phát hành); thử thật với tài khoản của chủ dự án.** §9 = bản thực tế. API: TikTok Social MCP Server (chính thức, ra mắt ~2026-11-05), tài liệu
> `business-api.tiktok.com/portal/docs/tiktok-social-mcp-server/v1.3` + "Available tools…" + "How to connect a custom agent…".
> Dữ kiện đã kiểm chứng thật ghi **[L]** (live), chưa kiểm chứng ghi **[?]**. Script thử: `scripts/dev-probe-tiktok-social.ts`.

## 1. Quyết định của chủ dự án (2026-11-15)

| #   | Quyết định |
| --- | ---------- |
| TS1 | **Cách 1**: Ads MCP Simple là *client* của TikTok Social MCP (OAuth 2.1 + PKCE + Dynamic Client Registration). **Không** cần developer app, không xin duyệt; hợp với bản mã nguồn mở / tự host (mỗi bản cài tự đăng ký client của mình). Không gọi thẳng Organic API. |
| TS2 | **Bình luận chỉ đọc** (không trả lời / ẩn / xoá / thích / viết bình luận). |
| TS3 | **Tự che số điện thoại + email** trong nội dung bình luận (và mọi văn bản do người ngoài viết: nhắc tên thương hiệu…) trước khi gửi cho AI — dùng chung `src/lib/pii-mask.ts` (v1.2.1). |
| TS4 | **Không giới hạn số kết nối**: mỗi lần đăng nhập 1 tài khoản TikTok = 1 kết nối riêng; mỗi MCP chọn nhiều kết nối; 1 kết nối dùng được cho nhiều MCP. |

Mặc định đề xuất (đổi được):

- **TSD1** — Mỗi tài khoản TikTok (`open_id` / id tài khoản) chỉ có **1 kết nối còn sống** trong cả hệ thống. Kết nối lại cùng tài khoản (chủ kết nối hoặc admin) = **thay token** của kết nối cũ, không tạo dòng mới. Người khác đăng nhập trùng → lỗi "Tài khoản TikTok này đã được người khác kết nối — liên hệ quản trị viên" (không nêu tên với nhân viên). Lý do: chưa biết TikTok có huỷ token cũ khi cùng tài khoản cấp quyền lần 2 không; 1 dòng dùng chung nhiều MCP là đủ.
- **TSD2** — Quyền giống kết nối quảng cáo: nhân viên thấy / quản lý kết nối của mình; admin thấy tất cả; MCP của nhân viên chỉ dùng kết nối của chủ MCP; MCP của admin dùng được mọi kết nối.
- **TSD3** — TikTok Social là **một nền tảng của MCP** ngang Meta / TikTok / Google Ads / OpenAI Ads / Apify (như Apify A5): MCP chỉ dùng TikTok Social là hợp lệ.
- **TSD4** — Đợt 1 **chỉ đọc toàn bộ**. Không làm đăng video / ảnh (TikTok chưa mở qua MCP OAuth), không làm cấp mã Spark (`account_user_post_authorize_*`, là thao tác ghi) — để đợt sau nếu chủ dự án muốn.

## 2. TikTok Social MCP (đọc tài liệu 2026-11-15)

- Server: `https://business-api.tiktok.com/open_mcp/tt-ads-mcp-organic-social` (Streamable HTTP, JSON-RPC). Gọi không token → **401** [L].
- Metadata OAuth: `GET {server}/oauth/.well-known/openid-configuration` [L] → `authorization_endpoint {server}/oauth/tiktok/authorize`, `token_endpoint …/token`, `registration_endpoint …/register`, `revocation_endpoint …/revoke`, `code_challenge_methods_supported ["S256"]`, `token_endpoint_auth_methods_supported ["none"]` (public client, không secret).
- Scope hỗ trợ: `user.info.basic, user.info.username, user.info.stats, user.info.profile, user.account.type, user.insights, video.list, video.insights, comment.list, comment.list.manage, video.publish, video.upload, biz.spark.auth, discovery.search.words`. Trang đồng ý cấp **toàn bộ** (không chọn từng scope) [?].
- DCR: `POST …/register` `{client_name, redirect_uris[], token_endpoint_auth_method:"none", grant_types:["authorization_code","refresh_token"], response_types:["code"]}` → `client_id` ngay, **không duyệt** [L 2026-11-15].
- Authorize: `…/authorize?response_type=code&resource={server}&client_id&redirect_uri&code_challenge&code_challenge_method=S256[&state]` → về `redirect_uri?code=…`. `redirect_uri` phải `https://` (cho phép `http://localhost|127.0.0.1|::1` khi thử).
- Token: `POST …/token` (form-urlencoded) `grant_type=authorization_code, code, code_verifier, redirect_uri, client_id` → `access_token` (**1 ngày**), `refresh_token` (**1 năm**), `scope`, `expires_in 86400`, `refresh_token_expires_in 31536000`. Làm mới: `grant_type=refresh_token`. Quyền kết nối sống **1 năm**, sau đó phải đăng nhập lại.
- Giới hạn: **6 lần/giây mỗi tool mỗi người dùng TikTok**. Tool khả dụng tuỳ khu vực và loại tài khoản.
- ~40 tool, mỗi tool bọc 1 endpoint Organic API (bảng §6). Đăng video / ảnh không dùng được qua MCP OAuth.

## 3. Kiến trúc

```
Kết nối → TikTok Social → "Kết nối tài khoản TikTok"
   │  (server action) lấy client_id (DCR 1 lần / redirect_uri) + PKCE + state → cookie mã hoá httpOnly 10 phút
   ▼
TikTok đăng nhập + đồng ý → GET {APP_URL}/api/tiktok-social/callback?code&state
   │  kiểm tra phiên đăng nhập = người bắt đầu, state khớp, đổi code (PKCE) → token
   │  gọi tool tài khoản để biết open_id / username / tên hiển thị → TSD1 (trùng?) → lưu (mã hoá AAD)
   ▼
tiktok_social_accounts  ── mcp_tiktok_social_scopes ── MCP (chọn tài khoản)
   ▼
tool tiktok_social_* (đọc) → src/server/tiktok-social/client.ts: JSON-RPC tools/call (Bearer, tự làm mới token,
   khoá theo dòng khi làm mới) → chuẩn hoá + che SĐT/email + làm sạch ký tự → AI
```

Module mới `src/server/tiktok-social/` (không import `next/*`):

- `oauth.ts` — metadata (hằng số, không tin URL lạ), DCR, PKCE, đổi code, làm mới, thu hồi. Host cố định `business-api.tiktok.com`, `redirect: "error"`, `cache: "no-store"`, timeout.
- `client.ts` — MCP JSON-RPC: `initialize` (nếu server yêu cầu phiên) + `tools/call`; nhận cả `application/json` và `text/event-stream`; phân loại lỗi (401 → làm mới 1 lần → vẫn lỗi = `invalid`; 429 → `rate_limited`; tool lỗi `isError` → `upstream`). Không đưa token vào lỗi / log.
- `store.ts` — chỗ **duy nhất** mã hoá / giải mã token (AAD `tiktok_social_account:<id>:credentials`), làm mới token có khoá `pg_advisory_xact_lock(hashtext('ttsocial:<id>'))` + đọc lại trong transaction (refresh token có thể xoay vòng).
- `tools.ts` — bản đồ tool Ads MCP Simple → tool TikTok + chuẩn hoá kết quả (§6).
- Service `src/server/services/tiktok-social-accounts.ts` + actions `src/server/actions/tiktok-social.ts`; route `src/app/api/tiktok-social/callback/route.ts`.
- Job `tiktok-social.health` (mỗi 6 giờ): làm mới token sắp hết (< 6 giờ) cho kết nối còn sống; đánh dấu `expiring` khi quyền 1 năm còn < 14 ngày, `invalid` khi refresh bị từ chối.

## 4. Dữ liệu (migration mới, bảng thường)

### `tiktok_social_clients` — client DCR của bản cài

| Cột | Kiểu | Ghi chú |
| --- | --- | --- |
| id | uuid pk | |
| redirect_uri | text unique | `${APP_URL}/api/tiktok-social/callback` — đổi tên miền → đăng ký client mới |
| client_id | text | không bí mật (public client) |
| created_at | timestamptz | |

### `tiktok_social_accounts`

| Cột | Kiểu | Ghi chú |
| --- | --- | --- |
| id | uuid pk uuidv7() | sinh trước insert (AAD) |
| owner_id | text → user.id RESTRICT | người kết nối |
| name | text | tên gợi nhớ (mặc định = tên hiển thị TikTok), ≤ 80 |
| tiktok_user_id | text | id ổn định của tài khoản (open_id / business id) — **unique trong các dòng chưa xoá** (TSD1) |
| username, display_name, avatar_url | text null | hiển thị |
| account_type | text null | BUSINESS / CREATOR / PERSONAL [?] |
| client_id | text | client đã cấp token (làm mới phải dùng đúng client) |
| credentials_encrypted | text | `{accessToken, refreshToken}` AES-256-GCM |
| access_expires_at, refresh_expires_at | timestamptz | |
| scopes | text[] | |
| status | text CHECK in ('active','expiring','invalid','disabled') | |
| status_message | text null | tiếng Việt, đã redact |
| last_checked_at, last_used_at, created_at, updated_at, deleted_at | timestamptz | soft delete: xoá bí mật + thu hồi token ở TikTok (best-effort) |

### `mcp_tiktok_social_scopes`

`id`, `mcp_id → mcp_servers CASCADE`, `account_id → tiktok_social_accounts CASCADE`, unique (`mcp_id`, `account_id`). Không có "tất cả tài khoản" (chọn từng tài khoản rõ ràng).

Activity log: `tiktok_social.connect|reconnect|rename|enable|disable|delete` (+ `disclaimerVersion` khi kết nối).

## 5. Bảo mật

- Token chỉ trên server, mã hoá; không trả client / AI / log; `redact` thêm mẫu nếu token có tiền tố nhận ra được [?].
- Callback: cookie `__Host-ttsocial_oauth` (mã hoá + AAD, httpOnly, Secure khi https, SameSite=Lax, 10 phút, dùng 1 lần) chứa `state`, `code_verifier`, `userId`, `clientId`, `redirectUri`, `reconnectId?`. Sai phiên / state / hết hạn → trang lỗi tiếng Việt, không đổi code.
- Quota `consumeQuota("tiktok-social-connect", userId, 10, 60s)`.
- Dữ liệu TikTok là **dữ liệu không tin cậy** (prompt injection): `sanitizeExternalLabel`, nhắc trong mô tả tool + `SERVER_INSTRUCTIONS`.
- Che SĐT / email (TS3) trong mọi văn bản do người ngoài viết (bình luận, trả lời, bài nhắc tên, chú thích video của người khác); kết quả có `masked {phones, emails}`.
- Log `mcp_call_logs`: phản hồi của tool bình luận / nhắc tên qua `logResponse` → chỉ số lượng + id, không nội dung / tên người.
- Pháp lý: thêm TikTok Social vào danh sách bên thứ ba (`legal.ts`), đoạn miễn trừ `connection` → tăng `DISCLAIMER_VERSIONS.connection` nếu cần.

## 6. Tool MCP (prefix `tiktok_social_`, đều đọc) — chốt sau khi thử thật

Bản đồ dự kiến (tên tool TikTok theo tài liệu "Available tools"):

| Tool Ads MCP Simple | Tool TikTok |
| --- | --- |
| `tiktok_social_list_accounts` (không gọi TikTok) | — kết nối trong phạm vi MCP: id, username, tên, trạng thái |
| `tiktok_social_get_account` | `account_user_get` (+ `account_user_benchmark_get`) |
| `tiktok_social_list_videos` | `account_user_post_list_get` (+ `account_user_post_setting_get` khi cần) |
| `tiktok_social_list_comments` | `account_user_comment_list_get`, `account_user_comment_reply_list_get` |
| `tiktok_social_list_mentions` | `account_user_mention_post_list_get` / `_post_get` / `_top_word_list_get` / `_top_hashtag_list_get` / `_hashtag_video_list_get` / `_comment_list_get` / `_comment_get` / `_hashtag_manage_list_get` / `_hashtag_verify_list_get` |
| `tiktok_social_trends` | `discovery_search`, `discovery_search_recommend_get`, `discovery_cml_list_get`, `discovery_cml_post_list_get` |
| `tiktok_social_hashtag_suggestions` | `account_user_hashtag_suggestion_get` |
| `tiktok_social_spark_recommendations` | `account_user_post_recommend_get` (+ `account_user_post_authorize_status_get` — đọc) |

Không làm (đợt 1): `account_user_comment_create|reply_create|like_update|visibility_update|delete` (TS2), `account_user_post_publish|photo_publish|publish_status_get`, `account_user_post_authorize_setting_update|authorize_update|authorize_delete`, `account_user_mention_hashtag_add|delete` (TSD4).

## 7. Giao diện

- **Kết nối**: tab **TikTok Social** (cạnh Apify): bảng Tài khoản (avatar, @username, tên), Loại, Người kết nối (admin), Trạng thái, Hạn đăng nhập lại, menu (Kết nối lại / Đổi tên / Tắt-Bật / Xoá). Nút `brand` "Kết nối tài khoản TikTok" → `DisclaimerGate kind="connection"` → chuyển sang TikTok.
- **MCP wizard / Cấu hình**: thẻ nền tảng **TikTok Social** ở bước "Nền tảng & tài khoản": chọn tài khoản (checkbox); bước Quyền: thẻ mô tả "chỉ đọc".
- Tổng quan MCP + danh sách MCP: icon TikTok Social.

## 8. Kiểm thử

- Unit (fake fetch): DCR / PKCE / token / refresh / revoke; client JSON-RPC (JSON + SSE, 401 → refresh 1 lần, 429); chuẩn hoá + che SĐT/email từng tool.
- Postgres: service (quyền admin / nhân viên, TSD1 trùng tài khoản, kết nối lại, xoá), làm mới có khoá, callback (state / phiên / hết hạn).
- Flows MCP: tool chỉ hiện khi MCP có tài khoản; tài khoản ngoài phạm vi bị từ chối; log không có nội dung bình luận.
- Live: `scripts/dev-probe-tiktok-social.ts` với tài khoản TikTok của chủ dự án.

## 9. Bản thực tế (2026-11-15)

### 9.1 Thử thật (`scripts/dev-probe-tiktok-social.ts` + MCP dev)

- DCR không cần duyệt [L]; `initialize` không bắt buộc, server không dùng phiên (`mcp-session-id` không có) [L]; `tools/list` = **35 tool** [L].
- Kết quả tool = `content[0].text` chứa JSON của Business API `{code, message, request_id, data}`; lỗi cũng nằm trong text (`isError` không bật) [L].
- Token: `access_token` 86.400 s, `refresh_token` 31.536.000 s; làm mới **không xoay** refresh token, hạn 1 năm không dời [L]. Đăng nhập cấp đủ 14 scope (không chọn từng scope) [L].
- `account_user_get` **không** trả id ổn định của tài khoản → khoá chống trùng (TSD1) = `username` (chữ thường). Đổi username trên TikTok → kết nối lại sẽ tạo dòng mới (chấp nhận).
- `account_user_post_recommend_get` (gợi ý Spark) → 40130 (thiếu scope `biz.ads.recommend`, kiểu đăng nhập MCP không cấp) → **bỏ** khỏi bộ tool [L].
- Tài khoản Creator (không Business): nhắc tên thương hiệu trả `data: {}`; `hashtag/verify` → 40002 [L]. Tool trả rỗng + cảnh báo.
- `account_user_hashtag_suggestion_get`: keyword có dấu cách → 40002; `language` dạng `vi-VN` (không phải `vi`) [L].
- `account_user_mention_comment_list_get`: trường `commenter_handle_name` trong tài liệu **không hợp lệ** — đúng là `commenter_display_name` (+ `comment_type`, `thumbnail_url`) [L].
- Bình luận: `create_time` là epoch (chuỗi) ở bình luận gốc, "YYYY-MM-DD HH:MM:SS" (UTC) ở trả lời; có `username`, `display_name`, `user_id` (băm), `unique_identifier`, `profile_image` (link ký) — hai trường cuối và `user_id` không trả cho AI. Bình luận chưa có trả lời không có `reply_list`.
- `account_user_get` chỉ số ngày gần nhất = 0 (trễ 24–48 giờ) [L] → cảnh báo trong tool.
- Chuẩn ngành (`account_user_benchmark_get`) chạy được với tài khoản Creator [L].

### 9.2 Mã nguồn

| Phần | File |
|---|---|
| DB | `src/server/db/schema/tiktok-social.ts`, `drizzle/0010_tiktok_social.sql` |
| Gọi TikTok | `src/server/tiktok-social/api.ts` (DCR, PKCE, token, revoke, tools/call JSON + SSE, phân loại lỗi), `store.ts` (mã hoá, client DCR theo redirect URI, làm mới có khoá advisory, `withTiktokSocialToken`, grant), `data.ts` (chuẩn hoá + che), `health.ts` |
| Service / action / route | `src/server/services/tiktok-social-accounts.ts`, `src/server/actions/tiktok-social.ts`, `src/app/api/tiktok-social/callback/route.ts` |
| MCP | `src/server/mcp/tools/tiktok-social/{index,shared,tools}.ts`, `grant.ts` (`tiktokSocialAccounts`), `registry.ts`, `instructions.ts` |
| Cấu hình MCP | `src/lib/schemas/mcp-servers.ts` (`tiktokSocialAccountIds`, quy tắc "ít nhất 1 nền tảng"), `src/server/services/mcp-servers.ts` (`tiktokSocialIdsFor`, `assertNotEmptyMcp`) |
| UI | `connections/_components/tiktok-social-table.tsx`, `connections/tiktok-social/{page,new}`, `mcp-servers/_components/tiktok-social-sections.tsx` (+ wizard, tab Cấu hình, Tổng quan) |
| Job | `src/server/jobs/tiktok-social-health.ts` (`20 */6 * * *`) |
| Khác | `audit/activity-log.ts` (6 action `tiktok_social.*`), `crypto/secret-box.ts` (AAD), `services/users.ts` (chặn xoá người dùng còn tài khoản), `scripts/cli.ts` (reencrypt) |

### 9.3 Kiểm thử

`src/server/tiktok-social/{api,data}.test.ts` (unit), `src/server/services/tiktok-social-accounts.test.ts` (Postgres: state, trùng tài khoản, đăng nhập nhầm, xoá + thu hồi), `src/server/mcp/__tests__/flows/tiktok-social.flows.test.ts` (MCP chỉ TikTok Social, quy tắc chủ, che SĐT, log không có nội dung, làm mới token).

### 9.4 Chưa thử thật

- Tài khoản **Business** (nhắc tên thương hiệu, hashtag thương hiệu).
- TikTok có huỷ token cũ khi **cùng** tài khoản cấp quyền lần 2 không (TSD1 đã tránh bằng 1 dòng / tài khoản). Đã thử 2026-11-15: kết nối thêm tài khoản **thứ 2** (@tgd123456) trong cùng trình duyệt - tài khoản đầu vẫn dùng được [L]; tài khoản mới không có Advanced Access vẫn đọc được chỉ số / video / xu hướng [L].
- Hết hạn 1 năm; job `tiktok-social.health` chạy trên worker thật; bản cài production (redirect `https://`).
