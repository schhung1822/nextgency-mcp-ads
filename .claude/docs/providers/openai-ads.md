# OpenAI Ads (ChatGPT Ads) Advertiser API — tài liệu tham chiếu

> Research ngày 2026-10-02 từ tài liệu chính thức https://developers.openai.com/ads (đọc toàn bộ `llms-full.txt`); rà lại 2026-10-02 sau review adapter (list params, insights fields/ngày, conversions exclusive end, objective/billing_event_type, daily_spend_limit, oCPC, idempotency) + OpenAPI spec chính thức **đã lưu tại [openai-ads.openapi.json](openai-ads.openapi.json)** (OpenAPI 3.1, `info.version` 2.3.0, 73 path). Khi implement: **grep spec đó để lấy schema chính xác**, không đoán.
> Mỗi trang doc có bản markdown: `https://developers.openai.com/ads/<slug>.md`; tổng hợp: `https://developers.openai.com/ads/llms-full.txt`.

## 1. Tổng quan
- Base URL: **`https://api.ads.openai.com/v1`** (KHÁC `api.openai.com`; key platform.openai.com không dùng được).
- Versioning theo path `/v1`; changelog trên trang API Overview:
  2026-06-03 location targeting + conversion endpoints · 06-11 insights theo product/country/device · 06-16 bidding theo conversion (oCPC) · 07-16 CAPI `obref` · 08-25 custom audience add/remove/replace/merge · 09-09 giới hạn chi tiêu ngày cấp account · 09-10 tách platform `desktop_web|ios_web|android_web` · **09-30 attribution window tuỳ chọn; mặc định đổi thành 30 ngày click / 1 ngày view theo thời điểm tương tác quảng cáo** (làm số conversion khác báo cáo cũ).
- Khả dụng: self-serve từ 2026-05 (US) → 2026-09-23 mở thêm **Việt Nam**, ID, MY, PH, SG, TH, TW (>60 nước). Ads chỉ hiện cho user ChatGPT Free/Go.

## 2. Xác thực (dán API key)
- Header: `Authorization: Bearer <OPENAI_ADS_API_KEY>`; body JSON (upload ảnh nhận cả multipart).
- **1 key = đúng 1 ad account** ("Each Ads API key is scoped to one ad account"). Nhiều account → nhiều key → nhiều connection.
- Lấy key: ads.openai.com → **Settings** → tạo API key (hiển thị 1 lần). Cần role **Admin** trên ad account (roles: Admin/Member/Viewer) [M].
- Kiểm tra key: **`GET /ad_account`** → `id (adacct_…), name, legal_name, brand_name, url, status, timezone, currency_code, review{status,reason}`. Currency & timezone cố định từ lúc tạo account.
- Header `Idempotency-Key` (tuỳ chọn) trên create — **bắt buộc** khi tạo ad group Maximize. Luôn gửi cho mọi create.
  - Adapter: key **tất định, không bao giờ ngẫu nhiên** — suy ra từ `opts.idempotencyKey` (mcp-core truyền id pending-action) + account + tool, nếu không có thì hash(account + tool + input chuẩn hoá). Retry 429/5xx giữ nguyên key; hết lượt retry 5xx → `retryable=false` + gợi ý "Có thể đã tạo — kiểm tra trước khi thử lại".
- OAuth (`auth.openai.com`, scopes `ads.admin.all.read|write`) + header `OpenAI-Ad-Account` + `GET /ad_accounts` chỉ dành **partner**, không self-serve → để sau (feature flag). **Không gửi `OpenAI-Ad-Account` khi dùng key thường.**
- Conversions API dùng host khác `https://bzr.openai.com/v1/events?pid=<PIXEL_ID>` và **key khác** (CAPI key) — ngoài phạm vi v1.

### Form kết nối
| Field | Bắt buộc | Ghi chú |
|---|---|---|
| `api_key` | ✔ | Ads API key; validate bằng `GET /ad_account`, lưu id/tên/currency/timezone |
Khi lưu: probe tính năng (403/404 = chưa bật) và cache vào `connections.meta.features`: `/conversions/event_settings`, insights có `segments[]`, `/ad_account/spend_limit_windows`, bulk.

## 3. Cấu trúc
Ad account → **Campaign** (`cmpn_…`) → **Ad group** (`adgrp_…`) → **Ad** (`ad_…`).

**Campaign**: `name, description, start_time/end_time` (Unix giây), `status` (active/paused/archived), `objective` (`reach|clicks|conversions`) và `billing_event_type` (`impression|click`) có trong `CampaignItemBody` (spec 2.3.0) [M: quan hệ với `bidding_type` cần test], `budget` = đúng 1 trong `daily_spend_limit_micros` | `lifetime_spend_limit_micros` (tối thiểu 1.000.000), `bidding_type` (`impressions` mặc định | `clicks` | `conversions`) — **bất biến**, `conversion_event_setting_ids` (đúng 1 cho conversions, bất biến), `targeting`, `landing_page_configuration.query_string_template` (macro UTM `{campaign_id}`, `{ad_id}`, `{oppref}`), `mode` (`product_feed`…). Budget đổi lifetime→daily được, không đổi ngược; lifetime không hạ dưới số đã chi.

**Targeting** (chỉ ở campaign):
- `locations.countries[]` (ISO-2) hoặc `locations.include[{id}]` + `excluded_locations` (≤2.500 id; loại country/region/market; tra `GET /geo_lookup/search?q=&limit=` ≤100 hoặc CSV https://developers.openai.com/ads/openai-geotargets.csv; tên địa danh phải đúng chính tả bản địa).
- `platforms.included[]`: `ios_app, android_app, web, desktop_web, ios_web, android_web`.
- Custom audience include (≥25.000 user khớp) / exclude.
- **KHÔNG có** targeting ngôn ngữ, tuổi, giới tính, sở thích, keyword. Chủ đề khớp qua `context_hints` của ad group.

**Ad group**: `campaign_id, name, description, context_hints[]` (≤2.000 gợi ý văn bản tự do — không phải keyword), `status`, `product_set`, `bidding_config`:
- `billing_event_type`: impression | click; `strategy`: `fixed_bid|maximize_clicks|maximize_conversions`; `max_bid_micros` là **giá mỗi sự kiện** (CPM $60 → gửi `60000`). **Campaign `bidding_type=conversions` (oCPC): `max_bid_micros` là CPA MỤC TIÊU (giá mỗi chuyển đổi)**, không phải giá mỗi click → mô tả/preview/cảnh báo phải ghi "CPA mục tiêu". Adapter làm tròn budget/bid về đơn vị tiền nhỏ nhất (USD: bội 10.000 micros; VND: bội 1.000.000); bid theo impression làm tròn 1/1000 đơn vị (CPM chẵn đơn vị nhỏ nhất) [L: spec không nêu ràng buộc]; `custom_audience_bid_multipliers[]` 0,1×–10× (chỉ fixed bid).

| bidding_type campaign | billing_event_type | strategy |
|---|---|---|
| impressions | impression | fixed_bid |
| clicks | click | fixed_bid / maximize_clicks |
| conversions | click | fixed_bid / maximize_conversions |
Maximize cần daily budget + `Idempotency-Key`.

**Ad**: `creative.type` = `chat_card` (`title` 3–50 ký tự, `body` ≤100, `target_url` ≤2.048 phải crawl được, `file_id`, `image_crop` tuỳ chọn) | `product_ad_template`. Read-only: `review_status` (in_review/approved/rejected), `serving_issues`. Sửa creative → **duyệt lại**. Không chuyển ad sang ad group khác.

Giới hạn self-serve: 5.000 campaign / 5.000 ad group / 5.000 ad mỗi account.

## 4. Endpoint (đều dưới `/v1`)
| Nhóm | Endpoint |
|---|---|
| Account | `GET /ad_account` · `POST /ad_account/pause|activate` · `POST /ad_account/daily_spend_limit` (+ `/delete`) giới hạn chi tiêu ngày toàn account (có ngày kết thúc exclusive, `window_id`) · `/ad_account/spend_limit_windows` |
| Campaign | `GET /campaigns` (`limit` 1–500, `after/before`, `order`, `name` (lọc theo tên), `include[]=serving_issues`) · `POST /campaigns` · `GET/POST /campaigns/{id}` (**update dùng POST**) · `POST /campaigns/{id}/activate|pause|archive` |
| Ad group | `GET /ad_groups` (`campaign_id` **tuỳ chọn** theo spec 2.3.0, `name`, phân trang) · `POST /ad_groups` · `GET/POST /ad_groups/{id}` (`include[]=bid_too_low`) · `/activate|pause|archive` |
| Ad | `GET /ads` (`ad_group_id` **tuỳ chọn** theo spec 2.3.0, `name`) · `POST /ads` · `GET/POST /ads/{id}` · `POST /ads/{id}/preview` (hết hạn 24h) · `/activate|pause|archive` |
| Upload | `POST /upload` JSON `{image_url}` hoặc multipart `file` (JPEG/PNG/WebP ≥640×640) → `file_id` |
| Geo | `GET /geo_lookup/search?q=` |
| Insights | `GET /ad_account/insights`, `/campaigns/{id}/insights`, `/ad_groups/{id}/insights`, `/ads/{id}/insights` |
| Conversion report | `POST /conversions/insights` |
| Audit | `GET /audit_logs` (lọc campaign/ad group/ad/actor/thời gian; `limit` 1–100) |
| Bulk (preview, bật theo account, không có trong spec) | `POST /bulk_mutation_jobs` → poll `GET /bulk_mutation_jobs/{id}` + `/operations`; ≤1.000 op; `validate_only`, `partial_failure`; 10 req/10s |

- **Cập nhật = thay thế cả object/list** khi gửi `budget`, `bidding_config`, `creative`, `targeting`, `context_hints`, `conversion_event_setting_ids` → adapter phải GET → merge → gửi đủ.
- **KHÔNG có xoá cứng**: chỉ `archive` và **không hoàn tác** (map sang quyền `delete`, bắt buộc xác nhận).
- **KHÔNG có copy native**.
- Liệt kê: `campaign_id`/`ad_group_id` là tham số lọc tuỳ chọn trên `/ad_groups`, `/ads` (spec) — bỏ trống có thể liệt kê toàn account [M: test]; vẫn có thể đi campaigns → ad_groups → ads, hoặc insights `aggregation_level=ad` + `includes[]=zero_impression_items`.
- **409 khi sửa (không phải tạo)**: revision conflict → đọc lại object và ghép lại thay đổi rồi gửi 1 lần (không gửi lại body cũ). **503/timeout khi sửa**: đọc lại và so sánh **chính các trường đã đổi** (không chỉ `updated_at`) trước khi thử lại.
- Phân trang: `{object:"list", data, first_id, last_id, has_more}` → trang sau `after=<last_id>`.

### Insights — tham số
- `aggregation_level`: `ad_account|campaign|ad_group|ad`
- `time_granularity`: `hourly|daily|monthly|none`
- `time_ranges[]`: **chuỗi JSON**, vd `{"type":"date_range","since":"2026-09-01","until":"2026-09-07","timezone":"<tz account>"}` (`until` inclusive); `unix_range` (end exclusive, tròn giờ), `hour_range`. **Cận không được ở tương lai** → adapter kẹp `until` về hôm nay (giờ account) + cảnh báo số liệu hôm nay chưa chốt.
- **`fields[]` — nếu bỏ trống chỉ trả `impressions` → LUÔN gửi danh sách field**. Adapter dùng **tên phẳng** thống nhất (ví dụ chính thức `fields[]=campaign_id`; mọi key của `InsightItemBody` trong spec đều phẳng: `readable_time, campaign_id, campaign_name, campaign_status, ad_group_id, ad_review_status, impressions, clicks, spend, ctr, cpc, cpm, conversions, cpa, post_click_cvr, order_created_attributed_sales, order_created_roas`); env `OPENAI_ADS_INSIGHTS_FIELD_STYLE=canonical` để chuyển sang dạng có chấm; parser đọc cả hai [M: test thật].
- `limit` mặc định **20** nếu không gửi (tối đa 2000) → luôn gửi `limit`.
- `filters[]` JSON (`IN|GREATER_THAN|LESS_THAN`), `sort[]`, `segments[]` (một trong `product|country|device|platform`, bật theo account), `includes[]` (`zero_impression_items`), `limit` 1–2000, `after/before`
- Attribution: `attribution_window_days` (7/14/30), `view_through_attribution_window_days` (0/1), `attribution_time_basis` (`ad_event_time|conversion_time`)
- Deprecated: `attributed_sales_amount`, `attributed_sales_count`, `roas`.
- Độ trễ: impressions/clicks vài phút; spend muộn hơn; conversion xử lý theo ngày. Lịch sử: daily/monthly 365 ngày; hourly & product ~30 ngày.

### Conversion insights `POST /conversions/insights`
`aggregation_level` (campaign|ad_group|ad), 1 `time_ranges` (≤365 ngày) với **ngày kết thúc EXCLUSIVE** (khác GET insights) → adapter gửi `until = ngày cuối + 1`; chuyển đổi xử lý theo ngày và cận không ở tương lai → khoảng gồm hôm nay được cắt tới hết hôm qua. `time_granularity` (none|daily), `entity_ids`, `group_by_entity`, `breakdown` (country|device), `include:["attributed_events"]`. `order_created_attributed_sales` trả về dạng **chuỗi thập phân** (vd `"100.50"`) → parse. **Không phân trang — >2.000 dòng trả 413** → adapter tự chia nhỏ khoảng ngày. Có thể 404 nếu account chưa bật.

## 5. Đơn vị tiền — dễ sai
| Chỗ | Đơn vị |
|---|---|
| budget, bid (`*_micros`) | **micros** (×1.000.000) |
| insights `spend`, `cpc`, `cpm`, `cpa` | **đơn vị chính** (vd 12.50) |
| CAPI event value | đơn vị nhỏ nhất (cents) |
| `ctr` | **tỷ lệ** (×100 ra %) |
`null` = không có dữ liệu, KHÔNG phải 0.

## 6. Sao chép (tự làm)
1. GET campaign → `GET /ad_groups?campaign_id=` → `GET /ads?ad_group_id=` (phân trang).
2. Tạo lại theo thứ tự với `status: paused`, tên + hậu tố, `Idempotency-Key` mới cho mỗi object.
3. Giữ: `bidding_type`, budget, targeting, `landing_page_configuration`, `conversion_event_setting_ids`, `bidding_config`, `context_hints`, `product_set`; dùng lại `file_id`.
4. Ad mới phải duyệt lại. Nếu Bulk API được bật → dùng bulk job.

## 7. Rate limit & lỗi
- **600 req/phút mỗi endpoint, 1.200 req/phút tổng — áp dụng theo cả ad account LẪN IP**. VPS quản lý nhiều account từ 1 IP dùng chung hạn mức IP → token bucket toàn cục < 1.200/phút.
- Lỗi: `{"error":{"message","type","param","code"}}` + header `x-request-id` (luôn log + trả cho AI).

| HTTP | Ý nghĩa | Xử lý |
|---|---|---|
| 400 | validation / cursor sai | không retry |
| 401 `invalid_api_key` | key hỏng | đánh dấu connection invalid |
| 403 | tính năng chưa bật (vd "Conversion bidding is not enabled") | báo capability unsupported |
| 404 "Not found" | endpoint bị gate theo account | báo chưa bật |
| 409 | revision/idempotency conflict; "Ad Account is missing details" ngẫu nhiên | retry 1 lần |
| 413 | conversion report quá lớn | chia nhỏ |
| 422 | vd `budget_window_amount_below_spend` | không retry |
| 429 | rate limit | backoff, giữ nguyên `Idempotency-Key` |
| 503 | **thay đổi có thể đã được lưu** | GET lại object trước khi retry |

## 8. Capability của adapter
| Capability | Trạng thái |
|---|---|
| Báo cáo theo ngày (account/campaign/ad group/ad; daily/monthly/hourly) | native |
| Conversion insights | native, có thể bị gate |
| List/get campaign, ad group, ad | native |
| Bật/tắt | native (`/pause`, `/activate`) |
| Sửa tên/budget/lịch/targeting/bid/context hints/creative | native (gửi object đầy đủ) |
| Tạo campaign → ad group → upload → ad | native (paused + Idempotency-Key) |
| Upload ảnh | native |
| Xoá | → `archive` (không hoàn tác, cần xác nhận) |
| Sao chép | giả lập (§6) |
| Bulk | tuỳ account (probe 404, fallback từng call) |
| Ngân sách cấp ad group, video creative, keyword/tuổi/giới tính/ngôn ngữ/sở thích targeting, đổi objective, chuyển ad sang ad group khác, nhiều account/1 key | **không hỗ trợ** |

## 9. Map sang tool MCP
| Tool | OpenAI adapter gọi |
|---|---|
| `ads_list_accounts` | từ các connection (mỗi key 1 account) |
| `ads_get_report` | `/ad_account/insights` + `fields[]` tường minh + phân trang `last_id` |
| `ads_list_objects` / `ads_get_object` | `/campaigns`, `/ad_groups?campaign_id=`, `/ads?ad_group_id=` |
| `ads_set_status` | `/{type}/{id}/pause|activate` |
| `ads_update_budget` | `POST /campaigns/{id}` với `budget` đầy đủ (chỉ cấp campaign) |
| `ads_update_object` | GET → merge → `POST /{type}/{id}` (cảnh báo creative sẽ duyệt lại) |
| `ads_copy_object` | §6 |
| `ads_delete_object` | `/archive` |
| `ads_upload_media` | `POST /upload` (`image_url`) |
| `ads_lookup` | `/geo_lookup/search`, `/conversions/event_settings` |
| `openai_ads_get_conversions` | `POST /conversions/insights` |
| `openai_ads_create_campaign` / `_create_ad_group` / `_create_ad` | §3, paused + Idempotency-Key |

## Nguồn
https://developers.openai.com/ads · /ads/api-overview · /ads/api-quickstart · /ads/api-reference/authentication · /ads/api-reference/insights · /ads/reporting · /ads/bulk-api · /ads/conversions-api · /ads/openapi.json · /ads/llms-full.txt · Tham khảo MCP cộng đồng: github.com/HYPD-AI/openai-ads-mcp, github.com/devaimani/openai-ads-mcp
