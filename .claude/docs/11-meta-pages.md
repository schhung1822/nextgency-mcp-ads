# Trang Facebook (Meta Pages): bài viết & chỉ số, chỉ đọc

> **Trạng thái: ĐÃ LÀM (2026-10-04, chưa commit).** API tham chiếu: `providers/meta.md` §10 (test thật 2026-10-03 bằng `scripts/dev-probe-meta-pages.ts`). Điều chỉnh do test ghi ở §10; khác biệt giữa thiết kế và bản đã làm ghi ở §11 - **§11 là nguồn đúng khi hai phần mâu thuẫn**.

## 1. Quyết định của chủ dự án (2026-10-03)

| #   | Quyết định                                                                                                                                               |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | Phạm vi **chỉ Facebook Page**. Không làm Instagram, không đọc nội dung bình luận (chỉ đếm số bình luận).                                                 |
| P2  | Nguồn Trang: `/me/accounts` (via quản lý trực tiếp) **và** Trang trong BM qua `business_management` (`/me/businesses` → `owned_pages` + `client_pages`). |
| P3  | **Có phân quyền theo Trang**: mỗi MCP chọn Trang được phép, giống cách chọn TKQC.                                                                        |

Mặc định (D-P, đổi được nếu chủ dự án muốn khác):

- **D-P1**: tính năng chỉ đọc: không đăng/sửa/xoá bài, không ẩn bình luận.
- **D-P2**: có lấy **bài quảng cáo** (`ads_posts`, gồm bài ẩn) nếu token có `pages_manage_ads` và via có task ADVERTISE. Thiếu quyền thì tool báo trong `warnings`, không lỗi cả lệnh.
- **D-P3**: nội dung bài trả cho AI: danh sách cắt `message` ở 500 ký tự (`message_truncated: true`); `meta_get_post` trả đầy đủ.

## 2. Token & quyền cần xin (cập nhật hướng dẫn kết nối Meta)

Bên cạnh các scope quảng cáo hiện có, thêm: `pages_show_list`, `pages_read_engagement`, `read_insights`, `pages_read_user_content`, `business_management`, `pages_manage_ads`.

- Via cần task **ANALYZE** trên Trang để xem chỉ số. Đọc bài cần CREATE_CONTENT/MANAGE/MODERATE; admin Trang có đủ.
- App ở Development mode, via có vai trò trên app → không cần App Review.
- Kiểm tra kết nối (`debug_token.granular_scopes` hoặc `/me/permissions`) → hiển thị khả năng theo từng tính năng: "Danh sách Trang", "Trang trong BM", "Bài viết", "Chỉ số", "Bài quảng cáo". Thiếu scope thì hiện cảnh báo kèm tên scope cần tick.

## 3. Page access token (bảo mật)

- **Không lưu DB.** Khi tool cần: `GET /{page_id}?fields=access_token` bằng user token của connection → cache **trong bộ nhớ process** theo khoá `(connection_id, page_external_id, hash(user token))`, TTL 5 phút (`PAGE_TOKEN_TTL_MS`), tối đa 1.000 mục (LRU). Xoá cache của connection khi cập nhật token, xoá hoặc vô hiệu hoá connection.
- Client Meta (`src/server/providers/meta/client.ts`) thêm chế độ `pageToken`: gửi `access_token=<page token>` và tính `appsecret_proof` theo **page token** khi connection có app secret. Không dùng lại `accessTokenOverride` (vì nó bỏ qua proof).
- Page token không bao giờ nằm trong output tool, lỗi, `warnings`, log hay UI. `redact` đã che key `access_token`; bổ sung test redact cho URL có page token.
- Lỗi 190 khi dùng page token → bỏ khỏi cache, thử lấy lại 1 lần. Vẫn lỗi thì báo "via không còn quyền trên Trang" (không đánh connection `invalid`, trừ khi user token cũng lỗi 190).

## 4. Dữ liệu (theo skill `/db-change`)

### `meta_pages`: Trang tìm thấy qua kết nối Meta

| Cột                                                           | Kiểu                                 | Ghi chú                                                                                                      |
| ------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| id                                                            | uuid PK `uuidv7()`                   |                                                                                                              |
| connection_id                                                 | uuid → connections ON DELETE CASCADE | chỉ connection platform `meta`                                                                               |
| external_id                                                   | text                                 | Page ID                                                                                                      |
| name, category                                                | text                                 |                                                                                                              |
| link, picture_url                                             | text null                            |                                                                                                              |
| followers_count                                               | integer null                         |                                                                                                              |
| verification_status                                           | text null                            | `blue_verified`·`gray_verified`·`not_verified`                                                               |
| tasks                                                         | text[]                               | task của via trên Trang (từ `me/accounts.tasks` hoặc `client_pages.permitted_tasks`); rỗng = chỉ thấy qua BM |
| sources                                                       | text[]                               | ⊆ {`me_accounts`,`owned_pages`,`client_pages`}                                                               |
| business_id, business_name                                    | text null                            | BM chứa Trang (nếu có)                                                                                       |
| is_published                                                  | boolean null                         |                                                                                                              |
| is_enabled                                                    | boolean default true                 | admin/owner bật tắt cho MCP                                                                                  |
| extra                                                         | jsonb                                | dự phòng                                                                                                     |
| last_synced_at, created_at, updated_at                        | timestamptz                          |                                                                                                              |
| `UNIQUE (connection_id, external_id)`; index `(external_id)`. |

Khả năng suy ra (không lưu cột): `can_read_posts` = tasks ∩ {CREATE_CONTENT, MANAGE, MODERATE} ≠ ∅; `can_read_insights` = `ANALYZE` ∈ tasks; `can_read_ads_posts` = `ADVERTISE` ∈ tasks. Tasks rỗng nghĩa là Trang chỉ liệt kê được.

### `mcp_page_scopes`

Giống `mcp_account_scopes`: `id`, `mcp_id → mcp_servers CASCADE`, `connection_id → connections CASCADE`, `page_id uuid null → meta_pages CASCADE` (**null = mọi Trang đang bật của kết nối, gồm cả Trang đồng bộ sau này**). `UNIQUE NULLS NOT DISTINCT (mcp_id, connection_id, page_id)`.

- Không thêm quyền mới vào `mcp_platform_permissions`. Tool Trang đăng ký khi MCP có quyền `read` cho `meta` **và** có ít nhất 1 dòng `mcp_page_scopes`.
- Nạp grant (`src/server/mcp/grant.ts`): chỉ lấy Trang `is_enabled`, connection `status <> 'disabled'` và chưa xoá. Một Trang xuất hiện qua nhiều kết nối thì giữ 1 dòng: ưu tiên kết nối có task ANALYZE, rồi theo độ khoẻ (active > expiring > invalid), rồi cũ nhất. Staff chỉ tham chiếu connection của chính mình (kiểm tra khi lưu **và** khi nạp grant).
- **Phạm vi Trang chỉ dành cho các tool Trang chỉ đọc**, không liên quan việc chạy quảng cáo: `page_id` khi tạo quảng cáo / nhóm quảng cáo (`meta_create_ad`, `meta_create_adset`) phải thuộc Trang của **tài khoản quảng cáo** (`act_x/promote_pages` + Trang `me/accounts` có task ADVERTISE, như `ads_lookup kind=pages`), kiểm tra lại ở cả preview và lúc thực thi (`04-mcp-design.md` §3).

### `activity_logs.action` mới

`connection.pages.sync` · `connection.pages.toggle` (bật/tắt Trang). Thay đổi phạm vi Trang của MCP ghi chung vào `mcp.update`, kèm diff.

## 5. Đồng bộ Trang

- Chạy cùng đồng bộ TKQC (`src/server/jobs/accounts-sync.ts` và nút "Đồng bộ" ở trang kết nối) cho connection Meta. Hàm adapter: `syncPages(ctx)` trong `src/server/providers/meta/pages.ts`.
- Bước 1: `me/accounts` (fields §10.2, `limit=100`, phân trang, tối đa 2.000 Trang).
- Bước 2: nếu có `business_management`: `me/businesses` (tối đa 50 BM) → mỗi BM gọi `owned_pages` và `client_pages` (tối đa 2.000 Trang mỗi BM). Thiếu quyền hoặc lỗi 10/200 thì bỏ qua bước này và ghi cảnh báo, không làm hỏng bước 1.
- Gộp theo Page ID: hợp `sources`, ưu tiên `tasks` từ `me/accounts`. Trang không còn thấy thì **giữ dòng nhưng đánh dấu** (`extra.missing_since`) và không trả cho MCP, để không làm mất phạm vi đã chọn khi Meta trả thiếu tạm thời. Xoá hẳn sau 30 ngày.
- Không gọi `access_token` lúc đồng bộ.

## 6. Tool MCP (đều `read`, `readOnlyHint: true`; theo skill `/add-mcp-tool`)

Tất cả tool tự kiểm tra `page_id` / `post_id` thuộc grant. Post ID có dạng `PAGEID_POSTID`, nên phải kiểm tra phần `PAGEID`. Với bài quảng cáo, kiểm tra thêm `from.id` / Trang sở hữu khi đọc. Mọi call ghi `mcp_call_logs` (không có before/after).

| Tool                     | Tham số chính                                                                                                                                                                           | Trả về                                                                                                                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `meta_list_pages`        | `q?`, `limit` (mặc định 50, tối đa 200), `cursor`                                                                                                                                       | `page_id`, tên, danh mục, followers, verification, nguồn (Trực tiếp / BM + tên BM), `capabilities {posts, insights, ads_posts}`, `connection_status`. **Gọi đầu tiên** cho các tool Trang.                   |
| `meta_list_page_posts`   | `page_id`, `source` = `published` (mặc định) \| `feed` \| `ads` \| `scheduled`, `since?`/`until?` (YYYY-MM-DD), `limit` (≤100, mặc định 25), `cursor`, `include_counts` (mặc định true) | `post_id`, `created_time` (ISO UTC), `message` (cắt 500), `permalink_url`, `full_picture`, `media_type`, `status_type`, `is_published`, `is_hidden`, `promotable_id`, `counts {reactions, comments, shares}` |
| `meta_get_post`          | `post_id`                                                                                                                                                                               | Toàn bộ `message`, `attachments` (+ `subattachments` ≤10), `call_to_action`, `counts`, reaction theo loại, `promotable_id`, gợi ý dùng với `meta_create_ad` kiểu `existing_post`                             |
| `meta_get_post_insights` | `post_ids` (1–20, gọi gộp `?ids=`), `metrics` = preset `basic` \| `video` \| `all` hoặc danh sách trong whitelist                                                                       | Mỗi bài: `views` (`post_media_view`), `unique_viewers`, `clicks`, `clicks_by_type`, `reactions_by_type`, nhóm video; kèm `raw` theo tên metric Meta; `warnings`                                              |
| `meta_get_page_insights` | `page_id`, `since`, `until` (tối đa 2 năm, adapter chia khúc 90 ngày), `period` = `day` (mặc định) \| `week` \| `days_28`, `metrics` preset `overview` \| `video` \| danh sách          | `rows [{date, metric…}]`, `totals` (chỉ với metric cộng được, không cộng `page_follows`/unique), `timezone_note`, `warnings`                                                                                 |

- Preset `overview`: `page_media_view`, `page_total_media_view_unique`, `page_post_engagements`, `page_total_actions`, `page_views_total`, `page_follows`, `page_daily_follows_unique`, `page_daily_unfollows_unique`.
- Metric chỉ nhận trong whitelist (`providers/meta.md` §10.5), validate bằng zod. Gặp lỗi "invalid metric" thì gọi lại từng metric một, trả metric hỏng trong `warnings` để cập nhật whitelist.
- Cảnh báo cố định trong `warnings`:
  - Ngày của Page Insights theo giờ Thái Bình Dương (cho tới khi test thật xác nhận khác).
  - Số liệu cập nhật ~24h.
  - Trang < 100 lượt thích không có chỉ số.
  - Thiếu task ANALYZE hoặc thiếu scope.
- Rate limit: bộ giới hạn theo Trang (khoá `meta:page:<id>`) dùng `src/server/providers/rate-limit.ts`; đọc `X-Business-Use-Case-Usage`; lỗi 32/80001 → `rate_limited` kèm thời gian chờ.
- Thêm vào server instructions: "Trang Facebook: gọi `meta_list_pages` trước; chỉ số Trang tính theo ngày giờ Thái Bình Dương".

## 7. Giao diện (theo skill `/new-page`, chuỗi trong `src/lib/i18n/vi.ts`)

- **Chi tiết kết nối Meta**: thêm tab "Trang".
  - Bảng: ảnh + tên, danh mục, người theo dõi, nguồn (badge "Trực tiếp" / "BM: <tên>"), khả năng (Bài viết · Chỉ số · Bài QC, mờ đi nếu không có), công tắc "Cho phép dùng".
  - Nút "Đồng bộ Trang", và cảnh báo thiếu scope ở đầu tab.
  - Owner và admin đều thao tác được; staff chỉ trên kết nối của mình.
- **Form MCP**: thêm khối "Trang Facebook" dưới khối TKQC. Mỗi kết nối Meta có 2 lựa chọn: "Mọi Trang đang bật (kể cả Trang mới)" hoặc chọn từng Trang. Có ô tìm kiếm khi > 20 Trang.
- **Hướng dẫn lấy token**: cập nhật danh sách scope ở mục 2.
- Kiểm tra sáng/tối + 390/1440px, chụp màn hình.

## 8. Kiểm thử

- Unit (fixture): gộp nguồn Trang và tasks; suy ra capabilities; chia khúc 90 ngày; quy đổi `end_time` sang nhãn ngày; fallback khi gặp invalid metric; cache page token (TTL, xoá khi đổi token); `appsecret_proof` theo page token; redact.
- Flow test (`src/server/mcp/__tests__/flows`):
  - Grant theo Trang: staff không thấy Trang của người khác.
  - `post_id` của Trang ngoài grant → lỗi không lộ thông tin.
  - Tool không đăng ký khi MCP không có phạm vi Trang.
- Test thật với token via: chạy hết danh sách `providers/meta.md` §10.7 và ghi kết quả vào đó (bỏ nhãn [L]).
- `security-reviewer` trước khi báo xong (page token, owner check, log).

## 9. Thứ tự làm (khi chủ dự án bảo "làm")

1. Test thật các mục §10.7 bằng token via (script trong `src/server/mcp/__dev__`, không commit token), rồi chốt whitelist và múi giờ.
2. Migration `meta_pages` + `mcp_page_scopes`, service, activity log.
3. Adapter `meta/pages.ts` (sync, posts, insights) + client `pageToken` + cache.
4. Grant + 5 tool + instructions + test.
5. UI tab "Trang" + khối phạm vi trong form MCP + hướng dẫn token.
6. `/verify`, chụp màn hình, `security-reviewer`, cập nhật `04-mcp-design.md`, `03-database-schema.md` và checklist trong `08-roadmap.md`.

## 11. Bản đã làm (2026-10-04) - khác thiết kế ở đâu
- **Bảng**: `meta_pages` dùng cột `is_missing` (thay cho `extra.missing_since`); Trang không còn thấy được giữ nguyên, **không xoá sau 30 ngày** (giống TKQC). Migration `drizzle/0004_meta_pages.sql`.
- **Đồng bộ**: `AdsProvider.listPages?` (Meta: `listMetaPages`) chạy trong `verifyCredentials` mỗi khi liệt kê TKQC (tạo kết nối, thay token, "Đồng bộ tài khoản", job `accounts.sync`); wizard xem trước (`previewConnection`) không gọi. Lỗi đọc Trang không làm hỏng kết nối: Trang đã lưu giữ nguyên, `connections.meta.pagesSync = {ok:false, warnings}`. Trang mới chỉ **bật sẵn ở lần đồng bộ Trang đầu tiên** của kết nối; các lần sau vào ở trạng thái tắt.
- **Activity log**: chỉ thêm `connection.pages.toggle`. Không có `connection.pages.sync` riêng - đồng bộ Trang nằm trong `connection.create` / `connection.update` (metadata `pages`) và `connection.test`.
- **Phạm vi MCP** (`connectionScopeSchema.pageIds`, chỉ kết nối Meta): bỏ trống hoặc `[]` = không Trang; `null` = mọi Trang đang bật (kể cả bật sau); danh sách = các Trang đó. Form: "Không dùng Trang" / "Tất cả Trang đang bật" (mặc định khi kết nối đã có Trang) / "Chọn từng Trang". `pruneToSelectable` bỏ Trang đã tắt khỏi lựa chọn (hết Trang → "Không dùng Trang").
- **Grant**: `McpGrant.pages` chỉ nạp khi MCP có `read` trên Meta; toolset `meta_pages` (5 tool, `src/server/mcp/tools/meta-pages/`) đăng ký khi có ≥1 Trang. `assertPageGrant` chạy trước mọi lời gọi mạng; `post_id` được ràng vào Trang qua tiền tố `PAGEID_`; cursor bài viết được ký (bind MCP + tool + Trang + truy vấn).
- **Context**: `providerCtx.connection(connectionId)` (cùng kiểm tra owner/disabled/invalid như context TKQC).
- **Client Meta**: `GraphRequest.pageAccessToken` (proof theo page token), bucket rate-limit theo Trang (`meta:page:<id>`), `graphBatch({pageAccessToken})`; `mapGraphError` map 190-không-subcode "Page Access Token" và 210 thành `invalid_request`.
- **Chỉ số Trang `week`/`days_28`**: Meta trả cửa sổ trượt kết thúc vào MỖI ngày (test thật) → adapter chỉ giữ các cửa sổ không chồng nhau, tính lùi từ `until`. Kết quả quá dài → giữ các dòng gần nhất + `rows_truncated`, `totals` vẫn cả khoảng.
- **Chỉ số bài**: mỗi op batch gửi `period=lifetime` và ưu tiên series `lifetime` (một số metric video trả cả series `day`, test thật).
- **UI**: thẻ "Trang Facebook" dưới thẻ TKQC ở trang kết nối Meta (bật/tắt, nguồn Trực tiếp/BM, khả năng Bài viết/Chỉ số/Bài QC, trạng thái đồng bộ, gợi ý scope thiếu dựa trên `connections.scopes`); khối Trang trong form MCP. Hướng dẫn token Meta có thêm `read_insights`, `pages_read_user_content` và use case "Manage everything on your Page". **Không** thêm cảnh báo thiếu scope Trang ở mức kết nối (gây nhiễu cho kết nối chỉ chạy quảng cáo).
- **Kiểm thử**: `providers/meta/pages.test.ts` (22), `mcp/__tests__/flows/meta-pages.flows.test.ts` (4, adapter thật + Graph giả + DB + endpoint thật), test schema phạm vi Trang, test grant. Đã chạy thật end-to-end qua endpoint MCP với kết nối "Test 2" (22 Trang, 5 tool, log không chứa token) và chụp UI sáng/tối 1440/390.

### Sau rà soát bảo mật (2026-10-04, `security-reviewer`: không có lỗi Nghiêm trọng/Cao)
- **M1/L1**: mọi lời gọi bằng page token (kể cả batch chỉ số bài) đi qua `withPageToken`: page token trong cache bị từ chối → lấy lại 1 lần bằng user token (user token chết → `auth_invalid` thật, kết nối bị đánh dấu đúng); token mới vẫn bị từ chối → `permission_denied` trên Trang, **không** đánh dấu kết nối.
- **L2**: Trang mới chỉ bật sẵn khi kết nối chưa có Trang **và** chưa có `mcp_page_scopes` nào trỏ tới kết nối.
- **L3**: danh sách bài lọc bỏ bài có id không thuộc Trang; chi tiết bài kiểm tra `id` trả về đúng post và đúng Trang.
- **L4**: `forgetPageTokens(connectionId)` khi xoá kết nối / thay token (cache có chỉ mục theo kết nối).
- **L5**: `connection.test` (đồng bộ) ghi `metadata.pages` (total/inserted/missing).
- **L6**: `scripts/dev-probe-meta-pages.ts` chỉ chạy khi `ALLOW_DEV_PROBE=1`, `DATABASE_URL` loopback, `NODE_ENV` ≠ production.
- **L7**: đồng bộ BM dừng khi đã đủ 2.000 Trang.

## 10. Điều chỉnh sau test thật (2026-10-03)
- **Lấy page token, gọi nhầm user token**: Meta trả `190` không subcode ("must be called with a Page Access Token") hoặc `210`. `mapGraphError` hiện map mọi `190` → `auth_invalid` → sẽ đánh **sai** connection `invalid`. Adapter Trang phải luôn dùng page token cho edge Trang, và `mapGraphError` cần phân biệt 190 có message này (map thành lỗi nội bộ, không đổi trạng thái connection).
- **Không dùng `ids=`** (bị bỏ ở v26). `meta_get_post_insights` nhiều bài → Batch API (`graphBatch`, mỗi op `GET <post_id>/insights?metric=…`) hoặc gọi tuần tự từng bài.
- **Chuẩn hoá task**: bỏ tiền tố `PROFILE_PLUS_` ở `client_pages.permitted_tasks`; bỏ qua task lạ (`REVENUE`, `FACEBOOK_ACCESS`, `MANAGE_LEADS`) khi suy ra capabilities.
- **Đồng bộ Trang**: `/me/accounts` (có `business_management`) đã trả cả Trang trong BM → bước 2 (BM) chủ yếu để gắn `business_name` và bắt Trang hiếm hoi chỉ thấy qua BM. Giữ nhưng không chặn nếu lỗi.
- **Ngày của Page Insights theo America/Los_Angeles** (đã xác nhận). Tool trả `date` theo giờ LA và `timezone: "America/Los_Angeles"`, `warnings` nói rõ khác giờ TKQC/Việt Nam.
- **Giới hạn khoảng ngày** thực tế 93 ngày; giữ chia khúc 90 ngày. `error_user_msg` của Meta theo ngôn ngữ via → không dựa vào text để phân loại lỗi, dùng code/subcode.
- **Trang thử nghiệm sẵn có**: "SiliconZ" (55k follower, bài cuối 31/12/2025) đủ dữ liệu insights để làm fixture (đã ẩn danh khi đưa vào test).

## 12. Bình luận bài viết (2026-11-15, v1.2.1) - chỉ đọc
**Quyết định chủ dự án (2026-11-15, thay P1 "không đọc nội dung bình luận"):** cho AI **đọc** bình luận bài viết của Trang được kết nối; **chỉ đọc** (không trả lời / ẩn / xoá); lọc **mới nhất / cũ nhất**; nội dung bình luận **giữ nguyên** (không che số điện thoại / email).

**Test thật 2026-11-15** (`scripts/dev-probe-meta-comments.ts`, Trang SiliconZ, bài 193 bình luận cấp 1 / 374 tính cả trả lời):
- `GET /{post_id}/comments` bằng **page token** (Graph: cần task **MODERATE**; tài liệu: thiếu quyền có thể trả **dữ liệu rỗng**). Bằng **user token** → `190/2069032` "Invalid OAuth 2.0 Access Token" (sẽ bị hiểu nhầm là kết nối chết) → luôn dùng page token.
- Bình luận của **khách không có `from`** (Meta không trả tên / id người dùng); chỉ bình luận của chính Trang có `from.id` = Trang. Nội dung vẫn có thể chứa tên / số điện thoại do khách tự viết.
- Field đọc được (từng field riêng đều OK): `id, message, created_time, from{id,name}, like_count, comment_count, parent{id}, attachment{type,url,media}, is_hidden, can_hide, can_remove, can_reply_privately, message_tags, permalink_url, user_likes`.
- `filter=toplevel|stream`, `order=reverse_chronological|chronological` (cần `summary=true`), `summary.total_count` (có thể lớn hơn số trả về). Không truyền order → Meta lọc mặc định (thiếu bình luận). **`since` bị bỏ qua** (trả cả bình luận cũ hơn) → không có lọc theo ngày.
- Trả lời lồng trong 1 lần gọi: `comments.order(chronological).limit(N){…}`. id bình luận = `<id số của bài>_<id>` (phần sau `_` của post_id).

**Bản đã làm:**
- Adapter `listMetaPostComments` (`providers/meta/pages.ts`): page token qua `pageGet` (`withPageToken`, proof theo page token, bucket theo Trang); fields không xin tên người bình luận (`from{id}` chỉ để biết Trang tự viết); `filter=toplevel`, `order` newest/oldest, `summary=true`; kèm tối đa `REPLIES_PER_COMMENT`=5 trả lời đầu (cũ → mới) + `pageReplied`; `commentId` = xem trả lời của 1 bình luận (phải thuộc đúng bài, kiểm tra trước khi gọi Meta); bỏ dòng có id không thuộc bài; nội dung làm sạch ký tự ẩn / bidi (`sanitizeExternalLabel`, một dòng), cắt `COMMENT_TEXT_CHARS`=2.000 + `messageTruncated`.
- Tool `meta_list_post_comments` (toolset Trang, `read`, `READ_ANNOTATIONS`): `post_id` (Trang phải trong phạm vi MCP - `assertPageGrant` trước mọi lời gọi), `order` newest (mặc định) | oldest, `comment_id?`, `include_replies` (mặc định true), `limit` ≤100 (25), `cursor` ký theo MCP + tool + Trang + truy vấn. Trả `total_count`, `comments[{comment_id, parent_id, message, message_truncated, created_time, like_count, reply_count, is_hidden, by_page, attachment, permalink_url, replies?, page_replied?}]`, `next_cursor`, `warnings` (thiếu MODERATE, cắt chữ, chỉ 5 trả lời đầu, total_count).
- Khả năng Trang thêm `comments` (= task MODERATE): `meta_list_pages.capabilities.comments`, chip "Bình luận" ở thẻ Trang (kết nối Meta). Chỉ dẫn MCP: `meta_list_page_posts (counts.comments) → meta_list_post_comments`.
- Kiểm thử: `providers/meta/pages.test.ts` (4 test mới), `mcp/__tests__/flows/meta-pages.flows.test.ts` (endpoint thật + DB + Graph giả: tool có trong danh sách, đọc bằng page token, cursor ký, Trang ngoài phạm vi bị từ chối, không lộ token); chạy adapter thật trên SiliconZ.

## 13. Tin nhắn Messenger của Trang (2026-11-15, v1.2.1) - chỉ đọc
**Quyết định chủ dự án (2026-11-15):** AI đọc **danh sách cuộc trò chuyện + nội dung tin nhắn** Messenger của Trang; **chỉ đọc**; **bật riêng từng MCP, mặc định tắt, chỉ admin bật** (công tắc `meta_page_messages`); **hiện tên khách thật**; **tự che số điện thoại, email** trong tin trước khi gửi cho AI. Instagram Direct: chưa (thiếu `instagram_manage_messages` - lỗi 230 - và cần doanh nghiệp đã xác minh).

**Test thật 2026-11-15** (`scripts/dev-probe-meta-conversations.ts`, Trang SiliconZ):
- `GET /{page_id}/conversations?platform=messenger&folder=inbox|page_done|spam|other[&user_id=<PSID>]` + `fields=id,updated_time,message_count,unread_count,participants,link,snippet,can_reply`; `GET /{t_…}?fields=…` và edge **`GET /{t_…}/messages`** (phân trang `after`) + `fields=id,created_time,from,to,message,attachments{mime_type,name,file_url,image_data{url}},sticker,shares{link}`. **Chỉ page token** (user token: danh sách → 190, node hội thoại → 100/33). Token cần **`pages_messaging`** (token dev có, không có `pages_manage_metadata` vẫn đọc được); via cần task MESSAGING / MODERATE.
- `participants` có **tên thật** + `email` = bí danh `<PSID>@facebook.com` (không xin). Tài liệu nói "chỉ 20 tin gần nhất" nhưng thực tế đọc được cả 28/28 tin (tin cũ từ 2021). Advanced Access không cần với app + Trang cùng doanh nghiệp (đọc được hội thoại với khách thật).
- Chạy adapter thật: 25 hội thoại, 376 tin, che 32 số điện thoại, không còn mẫu SĐT / email nào lọt.

**Bản đã làm:**
- Che thông tin liên hệ: `src/lib/pii-mask.ts` `maskContactInfo` — SĐT Việt Nam (0 / 84 / +84 + 8–10 số, có thể cách bởi khoảng trắng / chấm / gạch) và số quốc tế có `+` → `[SĐT ẩn …678]` (giữ 3 số cuối để phân biệt); email → `[email ẩn]`; không đụng giá, số lượng, ngày, mã đơn không bắt đầu bằng 0 / 84. Áp cho nội dung tin, đoạn trích (`snippet`) và tên tệp đính kèm; đếm vào `masked {phones, emails}`.
- Adapter (`providers/meta/pages.ts`): `listMetaConversations` (folder, `customerId` = `user_id`, cursor; bỏ hội thoại không có Trang trong `participants`), `getMetaConversationMessages` (kiểm tra node hội thoại có Trang trước khi đọc tin, khác → `not_found`; `fromPage`, đính kèm ≤10, link chia sẻ chỉ http(s)); lỗi quyền → `PageAccessKind "messages"` (nêu `pages_messaging`). Khả năng Trang `messages` = task MESSAGING hoặc MODERATE (chip "Tin nhắn").
- Tool (toolset Trang, chỉ đăng ký khi `settings.metaPageMessages === true`): `meta_list_conversations` (`page_id`, `folder`, `customer_id?`, `limit` ≤50, cursor ký) và `meta_get_conversation` (`page_id`, `conversation_id`, `limit` ≤100, cursor ký; mới nhất trước). `assertPageGrant` trước mọi lời gọi. `logResponse`: `mcp_call_logs` chỉ lưu số lượng + mã hội thoại, không tên / nội dung / SĐT. Cảnh báo cố định `MESSAGES_DATA_NOTE` + cảnh báo thiếu task.
- Công tắc MCP `meta_page_messages` (form bước "Chọn quyền", thẻ Meta, hiện khi đã chọn Trang; tổng quan MCP có dòng "Đọc tin nhắn Trang"): chỉ admin bật; bật khi sửa → xác thực lại; khi đang bật nhân viên không thêm Trang / "Tất cả Trang" (`assertNoStaffMetaMessagesWidening`). Hướng dẫn token Meta thêm `pages_messaging`. Chỉ dẫn MCP: `meta_list_conversations → meta_get_conversation`, không tìm cách khôi phục SĐT.
- Kiểm thử: `pii-mask.test.ts`, `pages.test.ts` (5 test hộp thư), `services/mcp-servers-meta-messages.test.ts` (admin-only, xác thực lại, không nới Trang), `settings.test.ts`, flows `meta-pages.flows.test.ts` (công tắc tắt → không có tool; bật → đọc bằng page token, đã che; log không chứa tên / nội dung / SĐT / token).
