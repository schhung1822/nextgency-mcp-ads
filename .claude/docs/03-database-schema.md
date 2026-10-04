# Database schema (PostgreSQL 18 + Drizzle)

Quy ước: tên bảng/cột `snake_case`; id bảng của app là `uuid` mặc định `uuidv7()` (built-in PG18); thời gian `timestamptz` lưu **UTC**, hiển thị theo `Asia/Ho_Chi_Minh`; soft delete bằng `deleted_at` cho connections/mcp_servers; mọi FK có index. Schema app ở `public`, pg-boss tự quản schema `pgboss` (loại khỏi drizzle bằng `schemaFilter: ["public"]`).

## 1. Bảng của Better Auth (sinh bằng `npx auth@latest generate`, KHÔNG viết tay)
`user` (id text, name, email unique, email_verified, image, created_at, updated_at, **role**, **banned**, **ban_reason**, **ban_expires**, **two_factor_enabled**) · `session` (+ **impersonated_by**, ip_address, user_agent) · `account` (provider `credential`, password hash scrypt) · `verification` · `two_factor` (secret + backup codes mã hoá bằng `BETTER_AUTH_SECRET`) · `rate_limit` (khi `rateLimit.storage: "database"`).
Thêm field qua `user.additionalFields`: `must_change_password boolean default false`, `created_by_id text null`.

## 2. Bảng ứng dụng
### `app_settings`
| Cột | Kiểu | Ghi chú |
|---|---|---|
| key | text PK | |
| value | jsonb | |
| updated_by | text → user.id | |
| updated_at | timestamptz | |
Key mặc định: `log_retention_months_mcp`=3, `log_retention_months_staff`=3 (1–24), `require_2fa_all`=false, `session_max_hours`=12, `mcp_default_settings`={…}. Giá trị khởi tạo lấy từ env `LOG_RETENTION_MONTHS` nếu có.
**Khoá nội bộ của hệ thống cập nhật** (xem `10-update-system.md`; KHÔNG nằm trong `SETTING_SCHEMAS` nên form Cài đặt và `getAllSettings` không bao giờ đọc/ghi chúng; `updated_by` luôn null): `update_latest` = `{version, tag, publishedAt, notes (≤4000 ký tự, text thuần), url, checkedAt}` (job `update.check` hoặc "Kiểm tra ngay" ghi) · `update_check_error` = `{at, message}` (lần kiểm tra gần nhất lỗi; xoá khi lần sau thành công) · `updater_heartbeat` = `{at, version, composeProject}` (service `updater` ghi mỗi 30 s; UI coi online khi `at` < 90 s).

### `connections` — kết nối nền tảng (1 bộ credential)
| Cột | Kiểu | Ghi chú |
|---|---|---|
| id | uuid PK | sinh trong app trước khi insert (để dùng làm AAD mã hoá) |
| owner_id | text → user.id | người tạo; staff chỉ thấy của mình |
| platform | enum `platform` (`meta`,`tiktok`,`google_ads`,`openai_ads`) | enum giữ đủ 4 giá trị; bản build chỉ dùng nền tảng đã phát hành (`12-platform-rollout.md`) |
| name | text | tên gợi nhớ do user đặt |
| credentials_encrypted | text | `v<ver>.<iv>.<tag>.<ct>` AES-256-GCM, AAD `connection:<id>:credentials`, JSON các field credential |
| credential_hint | text | 4 ký tự cuối của token chính |
| status | text CHECK (`active`,`expiring`,`invalid`,`disabled`) | |
| status_message | text | lỗi gần nhất (tiếng Việt) |
| token_expires_at | timestamptz null | Meta 60 ngày… |
| scopes | text[] null | scope đọc được |
| meta | jsonb | thông tin KHÔNG bí mật: app_id, login_customer_id, features đã probe (OpenAI), access tier… |
| last_checked_at, created_at, updated_at, deleted_at | timestamptz | |
Index: `(owner_id)`, `(platform)`, `(status) where deleted_at is null`.

### `ad_accounts` — tài khoản QC tìm thấy qua kết nối
| Cột | Kiểu | Ghi chú |
|---|---|---|
| id | uuid PK | |
| connection_id | uuid → connections ON DELETE CASCADE | |
| platform | enum platform | |
| external_id | text | Meta `act_123`, OpenAI `adacct_…` |
| name | text | |
| currency | char(3) | |
| timezone | text | IANA |
| status | text | chuẩn hoá: `active`,`disabled`,`pending`,`closed`,`unknown` |
| status_raw | text | giá trị gốc |
| is_enabled | boolean default true | user bật/tắt cho phép dùng trong MCP |
| is_manager | boolean default false | tài khoản quản lý (MCC) — dành cho nền tảng có tài khoản quản lý |
| parent_external_id | text null | cây MCC |
| extra | jsonb | min_daily_budget, business, balance… |
| last_synced_at, created_at, updated_at | timestamptz | |
`UNIQUE (connection_id, external_id)`; index `(platform, external_id)`.

### `mcp_servers`
| Cột | Kiểu | Ghi chú |
|---|---|---|
| id | uuid PK | |
| owner_id | text → user.id | |
| name, description | text | |
| key_hash | text UNIQUE | HMAC-SHA256(key, `MCP_KEY_PEPPER`) |
| key_prefix | text | 12 ký tự đầu (hiển thị) |
| key_encrypted | text | AES-GCM, AAD `mcp:<id>:key` — phục vụ "xem lại link" (D1) |
| status | text CHECK (`active`,`disabled`) | hết hạn tính theo `expires_at` |
| expires_at | timestamptz null | |
| settings | jsonb | `{"two_step_confirm": true, "budget_change_max_pct": 50, "max_daily_budget": {"VND": 5000000}, "max_lifetime_budget": {"VND": 100000000}, "max_bid": {"VND": 50000}, "rate_limit_per_min": 60, "write_rate_limit_per_10min": 20, "allowed_ips": []}` — snake_case, tiền theo **đơn vị chính**; ghi bằng `toStoredMcpSettings` (zod `mcpSettingsSchema`, `src/lib/schemas/mcp-servers.ts`), đọc bằng `parseMcpSettings` (`src/server/mcp/settings.ts`: từng trường sai → mặc định an toàn, `allowed_ips` hỏng → không IP nào khớp). Khoá thiếu (bản ghi cũ) → mặc định: `max_lifetime_budget`/`max_bid` = `{}`, `write_rate_limit_per_10min` = 20 |
| last_used_at | timestamptz | cập nhật thưa (≤1 lần/phút) |
| last_client | text | vd "claude-ai 1.0" |
| key_rotated_at, created_at, updated_at, deleted_at | timestamptz | |
Index: `(owner_id) where deleted_at is null`.

### `mcp_platform_permissions`
`mcp_id uuid → mcp_servers CASCADE`, `platform`, `permissions text[]` CHECK ⊆ {`read`,`status`,`update`,`copy`,`create`,`delete`} và chứa `read`. PK `(mcp_id, platform)`.

### `mcp_account_scopes`
`id uuid PK`, `mcp_id → mcp_servers CASCADE`, `connection_id → connections CASCADE`, `ad_account_id uuid null → ad_accounts CASCADE` (**null = mọi tài khoản đang bật của kết nối, kể cả tài khoản đồng bộ sau này**). `UNIQUE NULLS NOT DISTINCT (mcp_id, connection_id, ad_account_id)`.
Khi nạp grant: chỉ lấy tài khoản có `is_enabled = true`, connection `status <> 'disabled'` và chưa xoá; một TKQC (cùng platform + external_id) xuất hiện qua nhiều kết nối của MCP chỉ được giữ **một** dòng — kết nối khoẻ nhất (active > expiring > invalid), rồi cũ nhất (`dedupeAccounts`), để không liệt kê/cộng trùng chi tiêu; staff MCP chỉ được tham chiếu connection của chính owner (kiểm tra ở service khi lưu **và** khi nạp grant).

### `meta_pages` — Trang Facebook của kết nối Meta (migration `0004_meta_pages`, thiết kế `11-meta-pages.md`)
| Cột | Kiểu | Ghi chú |
|---|---|---|
| id | uuid PK | |
| connection_id | uuid → connections ON DELETE CASCADE | chỉ kết nối `meta` |
| external_id | text | Page ID |
| name, category, link, picture_url | text (null trừ name) | picture_url là link CDN của Meta, có thể hết hạn |
| followers_count | integer null | |
| verification_status | text null | `blue_verified`·`gray_verified`·`not_verified` |
| is_published | boolean null | |
| tasks | text[] NOT NULL default `{}` | task của via trên Trang đã chuẩn hoá (bỏ tiền tố `PROFILE_PLUS_`): `ANALYZE` → chỉ số, `ADVERTISE` → bài quảng cáo, `CREATE_CONTENT`/`MANAGE`/`MODERATE` → bài viết; rỗng = chỉ thấy qua BM |
| sources | text[] NOT NULL default `{}` | ⊆ {`me_accounts`,`owned_pages`,`client_pages`} |
| business_id, business_name | text null | BM chứa Trang |
| is_enabled | boolean default true | bật/tắt cho MCP; Trang mới chỉ bật sẵn ở **lần đồng bộ Trang đầu tiên** của kết nối, các lần sau vào ở trạng thái tắt (như TKQC, L10) |
| is_missing | boolean default false | lần đồng bộ thành công gần nhất không còn thấy → giữ dòng (scope tham chiếu) nhưng không đưa cho MCP |
| extra | jsonb | dự phòng |
| last_synced_at, created_at, updated_at | timestamptz | |
`UNIQUE (connection_id, external_id)`; index `(external_id)`. Đồng bộ cùng TKQC (`verifyCredentials` → `upsertMetaPages`); kết quả lần đồng bộ ghi ở `connections.meta.pagesSync` (`{ok, at, count, warnings}`). **Không lưu page access token** (chỉ cache trong bộ nhớ, `providers/meta/pages.ts`).

### `mcp_page_scopes`
`id uuid PK`, `mcp_id → mcp_servers CASCADE`, `connection_id → connections CASCADE`, `page_id uuid null → meta_pages CASCADE` (**null = mọi Trang đang bật của kết nối, kể cả Trang đồng bộ sau này**). `UNIQUE NULLS NOT DISTINCT (mcp_id, connection_id, page_id)`; index `connection_id`, `page_id`.
Chỉ cho kết nối Meta có trong phạm vi TKQC của MCP. Khi nạp grant (`McpGrant.pages`, chỉ khi MCP có quyền `read` trên Meta): Trang `is_enabled` và không `is_missing`, connection chưa xoá/không `disabled`; staff chỉ kết nối của chính mình; một Trang qua nhiều kết nối → giữ 1 dòng (`dedupePages`: kết nối có task `ANALYZE` trước, rồi độ khoẻ, rồi cũ nhất).

### `mcp_pending_actions` — xác nhận 2 bước
| Cột | Kiểu | Ghi chú |
|---|---|---|
| id | uuid PK | |
| token_hash | text UNIQUE | SHA-256 của confirm_token (token thô chỉ trả cho AI) |
| mcp_id | uuid | |
| tool_name | text | |
| args_hash | text | SHA-256 của args đã chuẩn hoá (bỏ `confirm_token`, sort key) |
| args | jsonb | args đã redact (audit) |
| preview | jsonb | |
| status | text CHECK (`pending`,`consumed`,`expired`) | |
| result | jsonb null | kết quả lần thực thi (trả lại nếu client gửi lặp) |
| expires_at, consumed_at, created_at | timestamptz | TTL 10 phút; job dọn hằng giờ |

### `mcp_call_stats_hourly` — số liệu biểu đồ
`bucket timestamptz`, `mcp_id uuid`, `owner_id text`, `platform text`, `tool_name text`, `calls int`, `errors int`, `writes int`, `duration_ms_sum bigint`. PK `(bucket, mcp_id, platform, tool_name)`. Worker upsert mỗi 5 phút từ `mcp_call_logs`; giữ 13 tháng.

### `system_update_requests` - yêu cầu cập nhật hệ thống (migration `0002_system_update_requests` + `0003_system_update_requests_target_strict`)
Hợp đồng giữa web và service `updater` (`10-update-system.md` §3). Web chỉ **INSERT** dòng `pending`; `updater` nhận việc, chạy và ghi kết quả. Không partition.
| Cột | Kiểu | Ghi chú |
|---|---|---|
| id | uuid PK default `uuidv7()` | |
| from_version | text NOT NULL | phiên bản đang chạy lúc yêu cầu |
| target_version | text NOT NULL | semver không có `v`; CHECK regex chặt `^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$` (migration `0003`; giá trị này đi vào tên image nên DB là lớp chặn thứ hai sau zod và updater) |
| status | text NOT NULL default `pending` | CHECK `pending`·`running`·`succeeded`·`failed`·`rolled_back` |
| step | text null | CHECK null hoặc `backup`·`pull`·`migrate`·`restart`·`healthcheck`·`rollback` |
| message | text null | ngắn, tiếng Việt, đã redact (hiện trên UI) |
| log | text null | đuôi log kỹ thuật ≤ 64 KB, đã redact; web **không** đọc/hiển thị cột này |
| requested_by | **text** → user.id ON DELETE SET NULL | (id của Better Auth là text, không phải uuid) |
| created_at, updated_at | timestamptz NOT NULL default now() | |
| started_at, finished_at | timestamptz null | |
Index: **unique một phần** `system_update_requests_open_uq` trên `((true)) WHERE status IN ('pending','running')` (chỉ 1 yêu cầu mở tại một thời điểm); `(created_at DESC)`.
Quy ước: `updater` nhận việc bằng `UPDATE … SET status='running', started_at=now() WHERE id=(SELECT id … WHERE status='pending' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`; dòng `running` quá 30 phút → `failed`; **dòng `pending` có `created_at` cũ hơn 10 phút KHÔNG được nhận** (updater đánh `failed`, `message` = lý do): tránh việc updater vừa bật lại sau nhiều ngày tự chạy một yêu cầu cũ không ai trông. Web coi dòng `pending` quá 10 phút không ai nhận là bị bỏ quên: không còn chặn yêu cầu mới và được đánh `failed` khi admin gửi yêu cầu kế tiếp.

## 3. Bảng log (partition theo tháng)
Drizzle chưa có DSL partition (issue #2854) → khai báo bảng bình thường trong schema, **sửa tay migration sinh ra** để thêm `PARTITION BY RANGE ("created_at")`, và tạo migration custom (`drizzle-kit generate --custom --name=logs_partitioning`) chứa hàm quản lý partition. PK/unique của bảng partition phải chứa `created_at`. `drizzle.config.ts`: `tablesFilter: ["*", "!*_p2*", "!*_default"]` để kit bỏ qua partition con.

### `mcp_call_logs`
| Cột | Kiểu | Ghi chú |
|---|---|---|
| id | uuid default uuidv7() | PK `(created_at, id)` |
| created_at | timestamptz default now() | partition key |
| mcp_id | uuid | **không FK** (log phải còn sau khi MCP bị xoá) |
| mcp_name, owner_id, owner_email | text | snapshot |
| jsonrpc_id, method, tool_name | text | method: `initialize`, `tools/list`, `tools/call`, `server/discover`… |
| protocol_version, client_name, client_version | text | |
| ip | inet | từ `x-forwarded-for` (Caddy) |
| user_agent | text | |
| platform, ad_account_id | text null | ad_account_id = external id |
| object_ids | text[] null | |
| action_kind | text | `read` \| `write` \| `protocol` |
| status | text | `success`,`error`,`denied`,`rate_limited`,`pending_confirmation`,`invalid_request` |
| error_code, error_message | text null | |
| upstream_request_ids | text[] null | request id của nền tảng |
| duration_ms | integer | |
| request | jsonb | args **đã redact**, ≤16 KB (vượt → `{_truncated,_bytes,preview}`) |
| response | jsonb | tóm tắt kết quả ≤32 KB |
| changes | jsonb null | `[{object_id, field, before, after}]` cho thao tác ghi |
| pending_action_id | uuid null | liên kết xác nhận 2 bước |
| request_bytes, response_bytes | integer | |
| truncated | boolean default false | |
Index (≤5 vì bảng ghi nhiều): `(mcp_id, created_at desc)`, `(owner_id, created_at desc)`, `(platform, ad_account_id, created_at desc)`, `(created_at desc) where status <> 'success'`. Tìm text lỗi: `pg_trgm` GIN partial trên `error_message`. **Không** GIN cả jsonb.

### `activity_logs` (nhật ký nhân sự)
| Cột | Kiểu | Ghi chú |
|---|---|---|
| id, created_at | như trên | PK `(created_at, id)` |
| actor_id | text null | null khi đăng nhập thất bại với email không tồn tại / hệ thống |
| actor_email, actor_role | text | snapshot |
| action | text | xem danh mục §4 |
| target_type, target_id, target_label | text null | `user`,`connection`,`mcp`,`setting`… |
| status | text | `success` \| `failure` |
| ip | inet | |
| user_agent | text | |
| metadata | jsonb | diff `{before, after}` đã redact, lý do, số dòng export… |
Index: `(actor_id, created_at desc)`, `(action, created_at desc)`, `(target_type, target_id, created_at desc)`.

### Hàm quản lý partition (migration custom)
```sql
CREATE OR REPLACE FUNCTION app_ensure_monthly_partitions(p_parent text, p_ahead int DEFAULT 3)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE base timestamp := date_trunc('month', now() AT TIME ZONE 'UTC'); i int;
BEGIN
  FOR i IN 0..p_ahead LOOP
    EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
      p_parent || '_p' || to_char(base + make_interval(months => i), 'YYYYMM'), p_parent,
      (base + make_interval(months => i))     AT TIME ZONE 'UTC',
      (base + make_interval(months => i + 1)) AT TIME ZONE 'UTC');
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION app_drop_expired_partitions(p_parent text, p_keep_months int)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE r record; n int := 0;
  cutoff text := to_char(date_trunc('month', now() AT TIME ZONE 'UTC') - make_interval(months => p_keep_months), 'YYYYMM');
BEGIN
  FOR r IN SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent
           WHERE p.relname = p_parent AND c.relname ~ ('^' || p_parent || '_p[0-9]{6}$') LOOP
    IF right(r.relname, 6) < cutoff THEN EXECUTE format('DROP TABLE IF EXISTS %I', r.relname); n := n + 1; END IF;
  END LOOP;
  RETURN n;
END $$;

CREATE TABLE IF NOT EXISTS mcp_call_logs_default PARTITION OF mcp_call_logs DEFAULT;   -- lưới an toàn; cảnh báo nếu có dữ liệu
CREATE TABLE IF NOT EXISTS activity_logs_default PARTITION OF activity_logs DEFAULT;
SELECT app_ensure_monthly_partitions('mcp_call_logs', 3), app_ensure_monthly_partitions('activity_logs', 3);
```
- Giữ "N tháng" = N tháng trọn + tháng hiện tại (dữ liệu được giữ **ít nhất** N tháng).
- Job `logs.maintain` chạy `SET LOCAL lock_timeout='5s'` trước khi drop (DROP partition lấy ACCESS EXCLUSIVE trên bảng cha); thất bại thì thử lại hôm sau.
- Postgres chạy với `-c default_toast_compression=lz4`.

## 4. Danh mục `activity_logs.action`
`setup.first_admin` · `auth.login.success` · `auth.login.failure` · `auth.logout` · `auth.2fa.enable` · `auth.2fa.disable` · `auth.2fa.backup_codes.regenerate` · `auth.password.change` · `user.create` · `user.update` · `user.role.change` · `user.ban` · `user.unban` · `user.delete` · `user.password.reset` · `user.2fa.reset` · `user.sessions.revoke` · `connection.create` · `connection.update` · `connection.delete` · `connection.test` · `connection.accounts.toggle` · `connection.pages.toggle` · `mcp.create` · `mcp.update` · `mcp.enable` · `mcp.disable` · `mcp.delete` · `mcp.key.rotate` · `mcp.key.reveal` · `settings.update` · `logs.export` · `system.update_check` · `system.update_requested` · `system.update_succeeded` · `system.update_failed` · `system.update_rolled_back`
Nhóm `system` = hệ thống cập nhật: web ghi `system.update_check` (admin bấm "Kiểm tra ngay"; job tự chạy KHÔNG ghi) và `system.update_requested` (cùng transaction với dòng `system_update_requests`); `updater` ghi 3 action còn lại cùng transaction với việc đổi trạng thái (actor = `requested_by`).
Sự kiện đăng nhập/2FA lấy từ `hooks.after` của Better Auth (`/sign-in/email`, `/two-factor/*`, `/sign-out`) + `databaseHooks.session.create.after`.

## 5. Ghi log
- `activity_logs`: ghi **đồng bộ, cùng transaction** với thao tác (không mất log).
- `mcp_call_logs`: batch writer singleton (`globalThis`), flush mỗi 1 giây hoặc 200 dòng, buffer tối đa 10k (đếm số dòng bị bỏ và cảnh báo), insert trong transaction `SET LOCAL synchronous_commit = off`; flush khi SIGTERM (`instrumentation.ts`).
- Màn hình log: luôn bắt buộc khoảng thời gian (mặc định 24h/7 ngày) để prune partition; phân trang keyset `WHERE (created_at, id) < ($ts, $id) ORDER BY created_at DESC, id DESC LIMIT 50`; danh sách **không** select `request/response/changes` (chỉ tải ở ngăn chi tiết); không `count(*)` chính xác (hiện "50+").
- Tuỳ chọn tăng cứng: role DB của web chỉ có INSERT/SELECT trên bảng log; DDL partition chạy bằng role maintenance trong worker.

## 6. Migration
- `drizzle-kit generate` khi dev → commit thư mục `drizzle/`. Không dùng `push` cho production.
- Container `migrate` (cùng image) chạy `dist/migrate.mjs`: `pg_advisory_lock(7272701)` → `migrate()` của drizzle-orm → `app_ensure_monthly_partitions(...)` → unlock. `web`/`worker` chỉ khởi động sau khi `migrate` thành công.
- Đổi schema bảng log: `ALTER TABLE` trên bảng cha (tự lan xuống partition); không `CREATE INDEX CONCURRENTLY` trên bảng cha.
