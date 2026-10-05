# Meta (Facebook/Instagram) Marketing API — tài liệu tham chiếu

> Research ngày 2026-10-02 từ developers.facebook.com (rà lại 2026-10-02 sau review adapter: §4 xoá/lưu trữ, §5 ad không có start/end time, validate_only, §6 deep copy). **Rà lại 2026-10-03**: không có version mới hơn v26.0; bổ sung **§10 Pages API** (danh sách Trang, bài viết, Page/Post Insights) cho tính năng Trang Facebook — thiết kế ở `.claude/docs/11-meta-pages.md`. Nhãn: **[T]** đã test thật bằng token (2026-10-03, `scripts/dev-probe-meta-pages.ts`) · **[H]** xác nhận trên trang chính thức · **[M]** chính thức nhưng chưa đầy đủ · **[L]** suy luận, phải test thật.
> Trước khi code adapter, chạy skill `/provider-api-check meta` để kiểm tra có version/breaking change mới không.

## 1. Phiên bản

| Version | Phát hành | Marketing API hết hạn |
|---|---|---|
| **v26.0** (dùng) | 2026-07-29 | TBD |
| v25.0 | 2026-02-18 | TBD |
| v24.0 | 2025-10-08 | **2026-10-06** |
| v23/v22 | — | đã hết hạn |

- Pin `META_API_VERSION=v26.0` trong config (cho phép override bằng env). Marketing API sống ngắn hơn Graph API; Meta chỉ cam kết ≥90 ngày cho version cũ.
- Có **auto-upgrade** cho endpoint không đổi; response có header `X-Ad-Api-Version-Warning` → log lại. Lỗi **2635** = gọi version Ads API đã deprecated.
- Base URL: `https://graph.facebook.com/v26.0/` (upload video lớn: `https://graph-video.facebook.com/v26.0/`).

### Breaking changes cần nhớ (2025–2026)
- **v24**: tạo campaign KHÔNG có ngân sách campaign → **bắt buộc** `is_adset_budget_sharing_enabled=true|false` (lỗi `100/4834011`). Bỏ placement Facebook Video Feeds. Không tạo được Messenger lead ads qua API.
- **v25**: Advantage+ Shopping/App **legacy** (ASC/AAC, `smart_promotion_type=AUTOMATED_SHOPPING_ADS|SMART_APP_PROMOTION`) không thể tạo/copy/sửa (áp dụng mọi version từ 2026-05-19). Lỗi async insights trả `error_code`, `error_message`, `error_user_msg`.
- **v26** (áp dụng mọi version từ **2026-10-27**): bỏ placement Instagram Explore Feed; `messenger_positions: story` bị bỏ qua im lặng; poll ads bị từ chối; ad set thuộc special ad category phải gửi `targeting.targeting_automation.advantage_audience` tường minh.
- **v23**: Advantage+ campaign hợp nhất (`advantage_state_info.advantage_state` read-only); ad set mới mặc định bật Advantage+ audience; `instagram_actor_id` → `instagram_user_id`.
- **OCC 2026-01-12**: attribution window `7d_view`, `28d_view` **trả rỗng không báo lỗi** → không bao giờ cho chọn. Chỉ dùng `1d_click`, `7d_click`, `28d_click`, `1d_view`, `1d_ev`, `default`. Unique metrics + breakdown theo giờ chỉ 13 tháng; `frequency_value` 6 tháng; tổng 37 tháng.
- **OCC 2026-06-22**: `breakdowns=dma` → dùng `comscore_market`.
- **OCC 2026-08-06**: `impression_device`, `hourly_stats_aggregated_by_audience_time_zone`, `frequency_value` cần opt-in trong Ads Manager; sync có thể trả rỗng HTTP 200 → dùng async.
- **v26: tham số `ids` bị bỏ** [T]: `GET /?ids=a,b` trả **HTTP 500**, code 100, `"The ids query parameter is deprecated in v26.0+."` (v25 vẫn chạy; GET từng id riêng vẫn chạy). Áp dụng cho cả campaign và bài viết. Đọc nhiều object → dùng Batch API (`graphBatch`) hoặc GET từng id. `setMetaStatus` (`src/server/providers/meta/mutate.ts`) từng dùng `ids=` → **đã sửa 2026-10-03** sang batch GET (test thật dryRun trên v26 OK). Không dùng lại `ids=` ở bất kỳ đâu.
- **v26 (Graph)**: bỏ tham số giao thức cũ `pretty`, `debug`, `date_format` (code hiện không dùng — giữ nguyên như vậy). Trang New Pages Experience: field `current_location`, `genre`, `network`, `parking`, `start_info` deprecated.
- **Page Insights**: nhiều metric impressions/reach/fans đã bị khai tử cho **mọi version** (2025-11-15 và 2026-06-15) → xem §10.4.
- `use_unified_attribution_setting`, `action_report_time` bị bỏ qua (kết quả giống Ads Manager theo attribution của ad set).
- Special category `CREDIT` → `FINANCIAL_PRODUCTS_SERVICES`.
- `dsa_payor` / `dsa_beneficiary` = EU Digital Services Act (bắt buộc khi target EU).

## 2. Credential (dán token, không login)

> **Quyết định chủ dự án (2026-10-02): dùng token cá nhân của via (user token qua Graph API Explorer) làm cách chính** — 1 token thấy mọi TKQC (`/me/adaccounts`) và Trang (`/me/accounts`) via được phân quyền, trên mọi BM. Khi có App ID + App Secret, adapter `prepareCredentials` tự đổi token ngắn hạn (1–2h) sang token dài hạn (~60 ngày) qua `GET /oauth/access_token?grant_type=fb_exchange_token`. System User token vẫn được hỗ trợ (chỉ thấy tài sản của 1 BM). `business_management` là **tuỳ chọn**: thiếu quyền này adapter tự bỏ field `business{id,name}` khi liệt kê TKQC.


**Khuyến nghị cho user: System User token** (Business Settings → Users → System users):
1. Tạo app loại **Business** (use case "Create & manage ads with Marketing API"), app thuộc Business portfolio của user.
2. Thêm system user (Employee, không cần Admin). Gán tài sản: ad accounts (Manage campaigns), Pages (Create ads), app.
3. Generate token → chọn app, hạn **Never** (hoặc 60 ngày), tick scopes.
4. **App phải ở Live mode** để tạo ad với creative mới (nếu không: lỗi `100/1885183`).

Scopes: `ads_management`, `ads_read`, `business_management`, `pages_show_list`, `pages_read_engagement` (tùy chọn: `pages_manage_ads`, `catalog_management`). **Không cần** `read_insights` cho ads insights. Standard access tự có cho app Business quản lý tài sản của chính business → **không cần App Review**.

Gửi token: tài liệu Marketing API không mô tả xác thực bằng header `Authorization: Bearer` cho Graph API → **giữ `access_token` (+ `appsecret_proof`) trong query/form** như hiện tại; URL luôn được redact trước khi log (`redactUrl`/`redactString`) và client Graph không tự theo redirect (`redirect: "manual"`).

Access tier (đổi tên 2026-05-04): **Limited** (mặc định, rate limit chặt) / **Full** (cần ≥500 call thành công trong 15 ngày, lỗi <15%).

### Form kết nối (UI)
| Field | Bắt buộc | Ghi chú |
|---|---|---|
| `access_token` | ✔ | System User token hoặc long-lived user token |
| `app_id` | — | Cần để gọi `debug_token` lấy hạn token + `appsecret_proof` |
| `app_secret` | — | Nếu app bật "Require App Secret" thì mọi call cần `appsecret_proof = HMAC_SHA256(token, app_secret)` |
| `business_id` | — | Để list `owned_ad_accounts` / `client_ad_accounts` |

### Kiểm tra token
- `GET /debug_token?input_token=<T>&access_token=<APP_ID>|<APP_SECRET>` → `is_valid`, `type` (SYSTEM_USER [M]), `expires_at` (0 = không hết hạn), `data_access_expires_at`, `scopes`, `granular_scopes`.
- Không có app secret: thử `access_token=<chính token>` [M]; fallback `GET /me?fields=id,name` + `GET /me/permissions`.
- Cảnh báo khi token hết hạn < 7 ngày. Lỗi `190` (subcode 463 hết hạn, 467 invalid, 460 đổi mật khẩu, 458 gỡ app) → đánh dấu connection `invalid`.

### Liệt kê ad accounts
```
GET /me/adaccounts?fields=id,account_id,name,account_status,disable_reason,currency,timezone_name,
  timezone_offset_hours_utc,amount_spent,spend_cap,balance,min_daily_budget,business{id,name},user_tasks&limit=200
```
Thêm: `GET /{business_id}/owned_ad_accounts`, `/{business_id}/client_ad_accounts`, `GET /me/businesses`.
`account_status`: 1 ACTIVE, 2 DISABLED, 3 UNSETTLED, 7 PENDING_RISK_REVIEW, 8 PENDING_SETTLEMENT, 9 IN_GRACE_PERIOD, 100 PENDING_CLOSURE, 101 CLOSED.
Tài sản phụ: Pages `GET /act_{id}/promote_pages` hoặc `/me/accounts`; Pixels `GET /act_{id}/adspixels`; IG `GET /act_{id}/instagram_accounts`; audiences `GET /act_{id}/customaudiences`.

## 3. Tiền tệ — CỰC KỲ QUAN TRỌNG
- **Budget/bid/spend_cap/amount_spent/balance** gửi & nhận theo **đơn vị nhỏ nhất** (minor units) với **offset theo tiền tệ**:
  - Offset **1**: **VND**, JPY, KRW, IDR, TWD, CLP, COP, CRC, HUF, ISK, PYG… → `daily_budget=50000` = 50.000đ.
  - Offset **100**: USD, EUR, … → `daily_budget=5000` = 50,00 USD.
- **Insights** (`spend`, `cpc`, `cpm`, cost_per_*) trả theo **đơn vị chính** (major) dạng string.
- Tool MCP nhận/trả **đơn vị chính + mã tiền tệ**; adapter tự quy đổi (`packages/core/money.ts`). Bảng offset lấy từ https://developers.facebook.com/docs/marketing-api/currencies.

## 4. Insights (kéo chỉ số)
Endpoint: `GET /act_{id}/insights` (khuyến nghị: 1 call cấp account với `level=campaign|adset|ad` thay vì N call), hoặc `/{campaign|adset|ad_id}/insights`.

Tham số chính:
- `level`: account|campaign|adset|ad
- `time_range={"since":"YYYY-MM-DD","until":"YYYY-MM-DD"}` (theo **múi giờ ad account**), hoặc `date_preset` (today, yesterday, last_7d, last_30d, this_month, last_month, maximum…; `lifetime` deprecated)
- `time_increment=1` (theo ngày) | `monthly` | `all_days`
- `breakdowns` (age, gender, country, region, publisher_platform, platform_position, device_platform, `comscore_market`…; asset breakdowns chỉ hỗ trợ impressions/clicks/spend/reach/actions/action_values)
- `action_breakdowns` (mặc định action_type), `action_attribution_windows` (chỉ các giá trị hợp lệ ở §1)
- `filtering=[{"field":"campaign.id","operator":"IN","value":[...]}]`, `sort=["spend_descending"]`, `limit` 100–500, cursor `after`
- Object đã xoá/archive: **mặc định insights KHÔNG trả hàng của object DELETED/ARCHIVED** (chi tiêu của chúng vẫn nằm trong tổng cấp account) → adapter cảnh báo khi không bật `includeDeleted`; muốn lấy đủ phải filter `<level>.effective_status IN [...]` với **chỉ các giá trị hợp lệ của cấp đó** [H]:
  - campaign: `ACTIVE, PAUSED, DELETED, ARCHIVED, IN_PROCESS, WITH_ISSUES`
  - adset: như campaign + `CAMPAIGN_PAUSED`
  - ad: như adset + `ADSET_PAUSED, PENDING_REVIEW, DISAPPROVED, PREAPPROVED, PENDING_BILLING_INFO`
  Gửi giá trị không thuộc enum của cấp (vd `ADSET_PAUSED` cho campaign) → lỗi `#100` [L].

Fields nên lấy (preset "basic"/"conversion"/"video"):
- Định danh: `account_id, account_currency, campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name, objective, optimization_goal, attribution_setting, date_start, date_stop`
- Phân phối: `spend, impressions, reach, frequency, clicks, inline_link_clicks, inline_link_click_ctr, outbound_clicks, ctr, cpc, cpm`
- Kết quả: `results, cost_per_result, actions, action_values, cost_per_action_type, purchase_roas, website_purchase_roas, conversions, conversion_values`
- Video: `video_play_actions, video_thruplay_watched_actions, cost_per_thruplay, video_p25..p100_watched_actions, video_avg_time_watched_actions`
- Xếp hạng (cấp ad): `quality_ranking, engagement_rate_ranking, conversion_rate_ranking`
- `action_type` hay dùng: `link_click, landing_page_view, lead, offsite_conversion.fb_pixel_purchase, omni_purchase, onsite_conversion.messaging_conversation_started_7d, video_view, post_engagement`

Mọi số trả về là **string** → parse. Dữ liệu cập nhật ~15 phút, còn thay đổi tới 28 ngày (conversion trễ).

**Async** (dải dài, level=ad theo ngày, nhiều breakdown, hoặc sync lỗi `1` "reduce the amount of data" / `100/1487534`):
1. `POST /act_{id}/insights` (cùng tham số) → `report_run_id`
2. Poll `GET /{report_run_id}?fields=async_status,async_percent_completion,error_code,error_message` đến `Job Completed` + 100%
3. `GET /{report_run_id}/insights?limit=500` + phân trang. Job có thể ~1 giờ; id hết hạn 30 ngày.

## 5. CRUD (POST tạo vào `/act_{id}/<edge>`, sửa `POST /{object_id}`)
Create (`POST /act_{id}/{campaigns|adsets|ads}`) nhận `execution_options=["validate_only"]` → dùng cho preview/dry-run của create.
**Update `POST /{id}`: `execution_options` KHÔNG được tài liệu hoá [L]** → có thể bị bỏ qua = ghi thật khi đang preview. Adapter tính preview của update (ngân sách, sửa object, targeting) **chỉ bằng cách đọc**, không POST.

### Campaign `POST /act_{id}/campaigns`
- Bắt buộc: `name`, `objective` ∈ `OUTCOME_AWARENESS|OUTCOME_TRAFFIC|OUTCOME_ENGAGEMENT|OUTCOME_LEADS|OUTCOME_APP_PROMOTION|OUTCOME_SALES`, `special_ad_categories` (`[]` hoặc HOUSING/EMPLOYMENT/FINANCIAL_PRODUCTS_SERVICES/ISSUES_ELECTIONS_POLITICS/ONLINE_GAMBLING_AND_GAMING + `special_ad_category_country`).
- **Luôn gửi `status=PAUSED`** (mặc định create là ACTIVE!). `buying_type=AUCTION`.
- Ngân sách — chọn 1:
  - CBO (Advantage campaign budget): `daily_budget` hoặc `lifetime_budget` + `bid_strategy`; ad set không có budget.
  - ABO: không budget campaign + **`is_adset_budget_sharing_enabled`** (bắt buộc).
- `bid_strategy`: `LOWEST_COST_WITHOUT_CAP|LOWEST_COST_WITH_BID_CAP|COST_CAP|LOWEST_COST_WITH_MIN_ROAS` — luôn gửi tường minh.

### Ad set `POST /act_{id}/adsets`
- Bắt buộc: `name, campaign_id, optimization_goal, billing_event` (thường IMPRESSIONS), `targeting`, budget (nếu ABO; lifetime cần `end_time`), `status=PAUSED`.
- Thường cần: `bid_amount` (BID_CAP/COST_CAP), `start_time/end_time` ISO-8601 có offset, `promoted_object`, `destination_type`, `dsa_beneficiary/dsa_payor` nếu target EU.
- `targeting` — **luôn gửi `targeting_automation.advantage_audience` (0|1)**:
```json
{"geo_locations":{"countries":["VN"]},"age_min":18,"age_max":65,
 "targeting_automation":{"advantage_audience":1},
 "custom_audiences":[{"id":"..."}],"flexible_spec":[{"interests":[{"id":"6003139266461"}]}],
 "publisher_platforms":["facebook","instagram"]}
```
  Bỏ trống placement = Advantage+ placements. Tìm interest: `GET /search?type=adinterest&q=`; địa điểm: `type=adgeolocation`.
- Objective → optimization_goal / promoted_object:

| Objective | optimization_goal | promoted_object / ghi chú |
|---|---|---|
| OUTCOME_AWARENESS | REACH, IMPRESSIONS, AD_RECALL_LIFT, THRUPLAY | `page_id` |
| OUTCOME_TRAFFIC | LINK_CLICKS, LANDING_PAGE_VIEWS | destination_type WEBSITE/MESSENGER/WHATSAPP/PHONE_CALL |
| OUTCOME_ENGAGEMENT | POST_ENGAGEMENT, THRUPLAY, CONVERSATIONS, PAGE_LIKES | CONVERSATIONS cần destination_type MESSENGER/WHATSAPP/INSTAGRAM_DIRECT |
| OUTCOME_LEADS | LEAD_GENERATION, QUALITY_LEAD | `destination_type=ON_AD`, `{"page_id":..}` |
| OUTCOME_SALES | OFFSITE_CONVERSIONS, VALUE | `{"pixel_id":..,"custom_event_type":"PURCHASE"}` |
| OUTCOME_APP_PROMOTION | APP_INSTALLS | `{"application_id":..,"object_store_url":..}` |

- Giới hạn: đổi budget ad set tối đa **4 lần/giờ** (`613/1487632`); không đổi daily↔lifetime; `daily_budget ≥ min_daily_budget` của account; ~5.000 ad set/account, 50 ad/ad set.

### Media
- Ảnh: `POST /act_{id}/adimages` (multipart `filename`, `bytes` base64, hoặc `copy_from={"source_account_id","hash"}`) → `images.<name>.hash`.
- Video: `POST /act_{id}/advideos` (`file_url` hoặc `source`); file lớn dùng resumable (start → transfer → finish) trên graph-video; poll `GET /{video_id}?fields=status` tới `ready`.

### Creative `POST /act_{id}/adcreatives` (hoặc inline trong ad)
- Link/ảnh: `object_story_spec={"page_id","instagram_user_id","link_data":{"link","message","name","description","image_hash","call_to_action":{"type":"SHOP_NOW","value":{"link":".."}}}}`; carousel = `child_attachments` 2–10.
- Video: `video_data={"video_id","image_hash|image_url","message","title","call_to_action"}`.
- Bài có sẵn: `object_story_id="<PAGEID>_<POSTID>"`.
- Advantage+ creative: `degrees_of_freedom_spec.creative_features_spec.<feature>.enroll_status=OPT_IN|OPT_OUT` → **mặc định gửi OPT_OUT cho mọi feature user không yêu cầu**.
- `url_tags` cho UTM.

### Ad `POST /act_{id}/ads`
`name, adset_id, creative={"creative_id":".."}, status=PAUSED`. Sau khi sửa, ad vào review lại (`effective_status` PENDING_REVIEW).
- **Ad KHÔNG có field `start_time`/`end_time`** (lịch chạy nằm ở ad set; ad chỉ có `ad_schedule_start_time`/`ad_schedule_end_time`). Đọc `fields=start_time` trên ad → lỗi `#100` [H]. Campaign dùng `start_time`/`stop_time`; ad set dùng `start_time`/`end_time`.

### Sửa / bật tắt
- `POST /{id}` với `status=ACTIVE|PAUSED|ARCHIVED|DELETED` (DELETED không hoàn tác — chỉ khi MCP có quyền `delete` + xác nhận).
- `POST /{id}` với `name`, `daily_budget`/`lifetime_budget` (minor units), `bid_amount`, `end_time`, `targeting`.
- `spend_cap` campaign đổi tối đa 10 lần/ngày (`17/1885172`).
- Batch: `POST /` `batch=[{"method":"POST","relative_url":"<id>","body":"status=PAUSED"}]` tối đa **50** op, mỗi op tính rate limit riêng. Async batch: `POST /act_{id}/async_batch_requests`.

## 6. Sao chép (native)
- `POST /{campaign_id}/copies` — `deep_copy`, `status_option` (PAUSED mặc định | ACTIVE | INHERITED_FROM_SOURCE), `rename_options={"rename_strategy":"ONLY_TOP_LEVEL_RENAME|DEEP_RENAME|NO_RENAME","rename_prefix","rename_suffix"}`, `start_time/end_time` → `{copied_campaign_id, ad_object_ids:[{ad_object_type,source_id,copied_id}]}`.
- `POST /{adset_id}/copies` — thêm `campaign_id` (đích) → `copied_adset_id`.
- `POST /{ad_id}/copies` — `adset_id` (đích), `creative_parameters` → `copied_ad_id`.
- **Giới hạn deep copy: ≤3 object con (tổng ad set + ad) khi sync** (51 khi async) [H]. Campaign có >3 con → không deep copy sync; dùng chiến lược bên dưới. Chiến lược an toàn (giống MCP noti.vn hiện tại):
  1. Copy campaign shallow → 2. copy từng ad set vào campaign mới (`deep_copy=true` nếu ≤3 ad, ngược lại shallow) → 3. copy từng ad với `adset_id` mới → 4. trả bảng map id nguồn→id mới + warnings; lỗi 1 nhánh không dừng cả lượt.
- Chỉ copy trong cùng ad account. Khác account = tạo lại + `adimages copy_from`.
- Không copy được ASC/AAC legacy; interest deprecated → `100/1487694`; EU thiếu DSA → `3858079/3858081`.

## 7. Rate limit & lỗi
Business Use Case (mỗi ad account / giờ):

| Use case | Limited | Full |
|---|---|---|
| ads_management | 300 + 40×active ads | 100.000 + 40×active ads |
| ads_insights | 600 + 400×active ads − 0,001×user errors | 190.000 + 400×active ads − … |

Đọc header mọi response: `X-Business-Use-Case-Usage` (có `estimated_time_to_regain_access` phút), `X-Ad-Account-Usage`, `X-FB-Ads-Insights-Throttle`, `X-App-Usage`. Chủ động giảm tốc khi > 75%.

| Code | Ý nghĩa | Xử lý |
|---|---|---|
| 1, 2 | Lỗi tạm / data quá lớn | backoff ~3 lần; insights → thu hẹp hoặc async |
| 4, 17, 32, 613, 80000/80003/80004/80014 | Throttle | circuit breaker theo account, chờ theo header, KHÔNG gọi dồn |
| 100 | Tham số sai (4834011, 1885183, 1487534, 1487694, 33, 1885272…) | không retry; trả `error_user_title`/`error_user_msg` cho AI |
| 190 | Token hỏng | không retry; đánh dấu connection invalid |
| 10, 200, 294 | Thiếu quyền/scope/chưa gán tài sản | không retry; hướng dẫn gán quyền |
| 2635 | Version deprecated | nâng version |
| 32, 80001 | Throttle theo Trang (page token / system user) | chờ theo `X-Business-Use-Case-Usage`, không gọi dồn |
| 283 | Thiếu quyền mở rộng (vd `pages_read_engagement`) | không retry; hướng dẫn tạo lại token với scope thiếu |
| 190/492 | User không có vai trò phù hợp trên Trang | không retry; Trang chỉ liệt kê, không đọc bài/chỉ số |
| 190 **không subcode**, message "must be called with a Page Access Token" | Gọi endpoint Trang bằng user token [T] | lỗi lập trình, **không** đánh connection `invalid` (mapGraphError hiện map mọi 190 → `auth_invalid`) |
| 210 | "A page access token is required to request this resource" [T] | như trên |
| 100/1504016 | Khoảng since–until insights > 93 ngày [T] | chia khúc |
| 100 "Invalid appsecret_proof" (GraphMethodException) | proof tính sai token [T] | tính proof theo đúng token đang gửi |
| 368 | Bị chặn tạm | backoff dài |

Create (POST) timeout → **không retry mù**; kiểm tra bằng list theo tên/created_time trước.

## 8. Map sang tool MCP (xem `.claude/docs/04-mcp-design.md`)
| Tool chung | Meta adapter gọi |
|---|---|
| `ads_list_accounts` | cache `ad_accounts` (sync từ `/me/adaccounts`) |
| `ads_get_report` | `/act/insights` level + time_increment=1, tự chuyển async |
| `ads_list_objects` / `ads_get_object` | `/act/{campaigns|adsets|ads}?fields=...&filtering=`, `GET /{id}` |
| `ads_set_status` | batch `POST /{id} status=` |
| `ads_update_budget` | `POST /{id}` daily_budget/lifetime_budget (quy đổi offset) |
| `ads_update_object` | `POST /{id}` name/end_time/bid_amount |
| `ads_copy_object` | `/copies` theo chiến lược §6 |
| `ads_delete_object` | `status=DELETED` (hoặc ARCHIVED) |
| `ads_upload_media` | `/adimages`, `/advideos` |
| `ads_lookup` | promote_pages, adspixels, instagram_accounts, customaudiences, search adinterest/adgeolocation |
| `meta_create_campaign` / `meta_create_adset` / `meta_create_ad` | §5, luôn PAUSED, hỗ trợ validate_only |
| `meta_update_targeting` | `POST /{adset_id} targeting=` |
| `meta_list_pages` | cache `meta_pages` (sync `/me/accounts` + BM `owned_pages`/`client_pages`) |
| `meta_list_page_posts` | `/{page}/{published_posts|feed|ads_posts|scheduled_posts}` bằng page token (§10.4) |
| `meta_get_post` | `GET /{PAGEID_POSTID}` bằng page token |
| `meta_get_post_insights` | batch `GET /{post}/insights?metric=…&period=lifetime` bằng page token (§10.5) |
| `meta_get_page_insights` | `GET /{page}/insights?period=…&since&until(+1)` chia khúc 90 ngày, ngày giờ LA (§10.5) |

## 9. Cần test thật khi implement
- `debug_token` dùng chính token (không app secret) với system user token.
- Enum chính xác của placement IG Explore đã bị bỏ.
- Subcode lỗi khi deep copy sync quá 3 ad.
- `/copies` trong `async_batch_requests` có được hỗ trợ chính thức không.
- Shape trường `results` (`[{indicator, values}]`).

## 10. Pages API — Trang, bài viết, chỉ số (chỉ đọc)

> Research 2026-10-03 (đọc qua WebFetch, nhiều trang developers.facebook.com mâu thuẫn nhau → giữ nhãn cẩn thận). Thiết kế tính năng: `.claude/docs/11-meta-pages.md`.

### 10.1 Quyền & loại app

| Scope                                   | Dùng cho                                                                                                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pages_show_list`                       | `/me/accounts` [H]                                                                                                                                                  |
| `business_management`                   | Trang trong BM (`/me/businesses`, `owned_pages`, `client_pages`) **và** để `/me/accounts` trả cả Trang được gán qua BM [M — trả lời bug report của Meta trên forum] |
| `pages_read_engagement`                 | Đọc bài, field Trang, insights [H]                                                                                                                                  |
| `read_insights`                         | Page/Post Insights [H]                                                                                                                                              |
| `pages_read_user_content`               | `/feed`, `/posts` (bài khách đăng) [H]; có thể cần cho `reactions/comments.summary` [L] → xin luôn                                                                  |
| `pages_manage_ads` (+ `ads_management`) | `/{page_id}/ads_posts` (bài quảng cáo/bài ẩn) [H]                                                                                                                   |

- App Development mode: xin được **mọi** permission từ user có vai trò trên app; app Business/Consumer tự có Standard Access → **không cần App Review** khi via là admin/dev/tester của app [H]. App kiểu use-case mới có thể phải thêm use case "Manage everything on your Page" thì Graph API Explorer mới hiện các scope Page [L].
- Task của user trên Trang [H]: `ANALYZE` (xem Insights — **bắt buộc cho insights**), `ADVERTISE` (bắt buộc cho `ads_posts`), `CREATE_CONTENT` / `MANAGE` / `MODERATE` (một trong số này cho `/feed`), `MESSAGING`. Admin có tất cả.

### 10.2 Liệt kê Trang

- `GET /me/accounts?fields=id,name,category,tasks,link,picture{url},followers_count,fan_count,verification_status,is_published&limit=100` — Trang via sở hữu/có task [H]. **[T]** với token có `business_management`: trả đủ 22 Trang, **gồm mọi Trang của 5 BM** (owned + client) — không có Trang nào chỉ thấy qua BM. `limit=101` không lỗi ở edge này. `tasks` gồm cả `MANAGE_LEADS`. `fan_count` của New Pages Experience = followers [H]. `access_token` chỉ trả khi user có vai trò (khác Live Contributor) [H] — **không xin field này khi liệt kê** (chỉ lấy khi cần page token, xem 10.3).
- `GET /me/businesses?fields=id,name` [H; quyền `business_management` L] → mỗi BM: `GET /{business_id}/owned_pages` và `/{business_id}/client_pages` (Page node + `summary.total_count`; `client_pages` có `permitted_tasks`) [H]. **[T]** `permitted_tasks` dùng tên có tiền tố `PROFILE_PLUS_` (`PROFILE_PLUS_ANALYZE`, `PROFILE_PLUS_ADVERTISE`, `PROFILE_PLUS_CREATE_CONTENT`, `PROFILE_PLUS_MANAGE`, `PROFILE_PLUS_MODERATE`, `PROFILE_PLUS_MESSAGING`, `PROFILE_PLUS_MANAGE_LEADS`, `PROFILE_PLUS_REVENUE`, `PROFILE_PLUS_FACEBOOK_ACCESS`) → bỏ tiền tố khi chuẩn hoá. Quyền/role cần thiết không ghi trên trang tham chiếu [L].
- Trang chỉ thấy qua BM mà via **không có task** trên Trang → chỉ liệt kê được, **không** lấy được page token → không đọc bài/chỉ số [M/L].

### 10.3 Page access token

- Lấy từ user token: `GET /{page_id}?fields=access_token` (hoặc `/me/accounts?fields=access_token`). Từ **long-lived user token** → page token **không hết hạn** ([T]: `debug_token` → `type: PAGE`, `expires_at: 0`) (chỉ mất hiệu lực khi đổi mật khẩu, mất vai trò, gỡ app — lỗi 190, subcode 460/463/467/492) [H].
- Bắt buộc dùng page token cho: insights, `published_posts`, `scheduled_posts`, `feed`/`posts` [H/M]. Field cơ bản của Page node nhận cả user token [H].
- `appsecret_proof = HMAC_SHA256(<token đang gửi>, app_secret)` → với page token phải tính theo **page token** [T: proof theo page token OK; proof theo user token → `(#100) Invalid appsecret_proof provided in the API argument`; không gửi proof cũng OK khi app không bật "Require App Secret"].
- Quy tắc app: page token **chỉ tồn tại trong bộ nhớ** (cache ngắn hạn), không lưu DB, không log, không trả cho AI/client.

### 10.4 Bài viết

| Edge                         | Nội dung                                                                                                       | Quyền / task                                                                                        |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `/{page_id}/published_posts` | Bài đã đăng của Trang                                                                                          | page token; `pages_read_engagement` [H]                                                             |
| `/{page_id}/feed`            | Bài Trang + bài khách + bài gắn thẻ công khai; cả chưa đăng (lọc `is_published`)                               | page token; `pages_read_engagement` + `pages_read_user_content`; CREATE_CONTENT/MANAGE/MODERATE [H] |
| `/{page_id}/posts`           | Bài của chính Trang (tập con của feed)                                                                         | như `/feed` [H]                                                                                     |
| `/{page_id}/ads_posts`       | Bài dùng cho quảng cáo (gồm bài ẩn) — tham số `exclude_dynamic_ads`, `include_inline_create`, `since`, `until` | `pages_manage_ads` + `pages_show_list` + `ads_management`; ADVERTISE [H]                            |
| `/{page_id}/scheduled_posts` | Bài hẹn giờ                                                                                                    | page token [H]                                                                                      |

- Giới hạn: ~600 bài ranked/năm qua API; `limit` tối đa **100** ([T] `limit=101` → `(#100) The 'limit' parameter should not exceed 100`); bài hết hạn không truy cập được [H]. `since` có tác dụng trên `published_posts` và `posts` [T].
- [T] `published_posts` bằng user token → `(#210) A page access token is required`; `ads_posts` bằng user token → `(#200) Not enough permission`, bằng page token → OK. Field list ở dưới chạy được nguyên văn, gồm `attachments{media_type,type}`, `reactions.summary(true).limit(0)`, `comments.summary(true).limit(0)`; `media_type` thấy `video`, `album`; `status_type` thấy `added_video`, `added_photos`; `promotable_id` = post id.
- Field bài (PagePost) hợp lệ [H]: `id, message, created_time, updated_time, permalink_url, full_picture, status_type, is_published, is_hidden, is_expired, promotable_id, is_eligible_for_promotion, shares, from, story, call_to_action, scheduled_publish_time, attachments{media_type,type,url,unshimmed_url,title,description,media,target,subattachments}`; edge `reactions.summary(total_count)`, `comments.summary(total_count)`, `insights`.
- **Không dùng** (deprecated từ v3.3): `type`→`attachments{media_type}`, `link`→`attachments{unshimmed_url}`, `object_id`→`attachments{target{id}}`, `caption`/`name`→`attachments{title}`, `description`, `source`→`attachments{media{source}}`; `picture` (bài link) [H].
- Reaction enum: LIKE, LOVE, WOW, HAHA, SAD, ANGRY, CARE… [H].

### 10.5 Insights (page token + `read_insights` + `pages_read_engagement` + task ANALYZE)

- `GET /{page_id}/insights?metric=a,b&period=day&since=YYYY-MM-DD&until=YYYY-MM-DD` · `GET /{post_id}/insights?metric=…` (post: hầu hết **lifetime**).
- `period`: `day, week, days_28, month, lifetime, total_over_range`; có `date_preset` [H]. **since/until tối đa 93 ngày mỗi request** ([T]: 89 ngày OK; 119 ngày → code 100, subcode 1504016, `error_user_msg` **theo ngôn ngữ của via** — ở đây là tiếng Việt: "…không được quá 93 ngày (8035200 giây)"; tài liệu ghi 90) → adapter chia khúc 90 ngày cho an toàn. Insights bằng user token → code **190** không subcode. Lưu 2 năm (Trang chưa xuất bản: 5 ngày); chỉ có cho Trang **≥100 lượt thích**; cập nhật ~24h [H]. Với `period=day`, `end_time` đầu tiên = `since` + 1 ngày → nhãn ngày = `end_time` − 1 ngày [H].
- **Múi giờ ngày: America/Los_Angeles** [T]: dữ liệu 25/09–02/10/2026 có `start_time`/`end_time` = `…T07:00:00+0000` (00:00 PDT); mùa đông (PST) sẽ là `08:00` [L]. Ngày `D` = `end_time` đổi về giờ LA rồi trừ 1 ngày. Khác múi giờ TKQC → tool phải ghi rõ trong `warnings`.
- Một metric không hợp lệ làm **hỏng cả request** ([T]: HTTP 400, code 100, `(#100) The value must be a valid insights metric`) → chỉ cho chọn metric trong whitelist dưới đây; gặp lỗi thì tách gọi từng metric và báo metric hỏng trong `warnings`.

**Whitelist Page metric (live trong v26)** [T — cả 14 metric trả dữ liệu theo ngày; breakdown `is_from_ads` trả từng dòng có `is_from_ads: "0"|"1"`; `page_actions_post_reactions_total` trả object, `{}` khi không có]:

| Metric                                                                                                                           | Period                              | Ý nghĩa                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------- |
| `page_media_view`                                                                                                                | day/week/days_28                    | Lượt xem nội dung (thay `page_impressions`); breakdown `is_from_ads`, `is_from_followers` |
| `page_total_media_view_unique`                                                                                                   | day/week/days_28                    | Người xem duy nhất (thay `page_impressions_unique`)                                       |
| `page_post_engagements`                                                                                                          | day/week/days_28                    | Cảm xúc + bình luận + chia sẻ                                                             |
| `page_total_actions`                                                                                                             | day/week/days_28                    | Click thông tin liên hệ / nút CTA                                                         |
| `page_views_total`                                                                                                               | day/week/days_28                    | Lượt xem Trang                                                                            |
| `page_follows`                                                                                                                   | day                                 | Tổng người theo dõi                                                                       |
| `page_daily_follows_unique`, `page_daily_unfollows_unique`                                                                       | day/week/days_28                    | Theo dõi mới / bỏ theo dõi                                                                |
| `page_actions_post_reactions_total`                                                                                              | day                                 | Cảm xúc theo loại                                                                         |
| `page_video_views`, `page_video_views_paid`, `page_video_views_organic`, `page_video_complete_views_30s`, `page_video_view_time` | day/week/days_28 (`view_time`: day) | Video (3s view đang bị Meta xem xét [M])                                                  |

**Whitelist Post metric (lifetime)** [T — cả 14 metric OK trên 1 bài video; `post_clicks_by_type` key `"link clicks"`, `"other clicks"`; `post_reactions_by_type_total` dạng `{"like":3}`]: `post_media_view` (thay `post_impressions`; breakdown `is_from_ads`, `is_from_followers`), `post_total_media_view_unique` (thay `post_impressions_unique`), `post_clicks`, `post_clicks_by_type`, `post_reactions_by_type_total`, `post_activity_by_action_type`; video: `post_video_views`, `post_video_views_organic`, `post_video_views_paid`, `post_video_view_time`, `post_video_avg_time_watched`, `post_video_length`, `post_video_complete_views_organic`, `post_video_complete_views_paid`.

**Đã khai tử — KHÔNG dùng** ([T] đã gọi thử, tất cả trả "must be a valid insights metric": `page_impressions`, `page_impressions_paid`, `page_impressions_unique`, `page_fans`, `page_fan_adds`, `page_fan_removes`, `page_posts_impressions`, `page_video_views_unique`, `page_engaged_users`, `page_tab_views_login_top_unique`, `post_impressions`, `post_impressions_unique`, `post_impressions_paid`, `post_impressions_nonviral`, `post_engaged_users`, `post_video_views_unique`):

- 2025-11-15 (mọi version; blog không nêu tên — tên theo bên thứ ba [L]; trang tham chiếu vẫn liệt kê nhưng coi là đã chết): `page_impressions`, `page_impressions_paid/_viral/_nonviral`, `post_impressions*`, `page_fans`, `page_fans_city/_country/_locale`, `page_fan_adds(_unique)`, `page_fan_removes(_unique)` → dùng `page_media_view` / `post_media_view` / `page_follows`.
- 2026-06-15 (mọi version) [H]: `page_impressions_unique` (+ `_paid/_viral/_nonviral_unique`), cả họ `page_posts_impressions*`, `page_video_views_unique`, `post_impressions_unique`, `post_impressions_paid_unique`, `total_video_impressions*`, `post_video_views_unique`.
- Từ v18: `page_video_views_10s*`, `post_video_views_10s*` [H]. `post_engaged_users`, `page_engaged_users` đã bỏ từ trước [L].
- Meta công bố metric "Page Viewer" (cuối 6/2026) — chưa thấy tên trong API [L].

### 10.6 Rate limit

- Call bằng page token / system user → **BUC**: `4800 × số người tương tác` / 24h; header `X-Business-Use-Case-Usage` [H] — [T] khoá theo **Page ID**, `type: "pages"`: `{"<page_id>":[{"type":"pages","call_count":1,"total_cputime":1,"total_time":1,"estimated_time_to_regain_access":0}]}`. User token → platform limit `200 × users`/giờ, header `X-App-Usage` [H]. Lỗi 32 / 80001 = quá tải theo Trang.

### 10.7 Kết quả test thật (2026-10-03, kết nối "Test 2", via 22 Trang / 5 BM, Trang thử 55k follower)
Đã chốt (ghi [T] ở các mục trên): metric sống/chết (1), múi giờ LA (2), `/me/accounts` trả cả Trang BM (3), `since` (5), text lỗi + `appsecret_proof` (7), giới hạn 93 ngày, `ids` bị bỏ ở v26, mã lỗi khi dùng nhầm user token.

Còn chưa test được:
- Trang **chỉ** thấy qua BM (via này không có trường hợp đó) → page token có lấy được không.
- `reactions/comments.summary` khi **thiếu** `pages_read_user_content` (token test có đủ quyền).
- `feed` có bài khách đăng, `scheduled_posts` có dữ liệu, `ads_posts` có dữ liệu (Trang thử trả rỗng).
- `end_time` mùa đông (PST, dự kiến `08:00Z`).
- Quyền tối thiểu của `owned_pages`/`client_pages`/`me/businesses` (token test có `business_management` nên đều chạy).

## Nguồn
- Versions: https://developers.facebook.com/docs/graph-api/changelog/versions/
- v24/v25/v26 changelog: https://developers.facebook.com/docs/graph-api/changelog/version26.0 (thay số)
- OCC: https://developers.facebook.com/documentation/ads-commerce/marketing-api/out-of-cycle-changes/occ-2026
- Authorization/tiers: https://developers.facebook.com/documentation/ads-commerce/marketing-api/get-started/authorization.md
- System user token: https://developers.facebook.com/docs/business-management-apis/system-users/install-apps-and-generate-tokens
- Insights: https://developers.facebook.com/docs/marketing-api/reference/ad-account/insights/ · async: /docs/marketing-api/insights/async
- Copies: https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-group/copies/
- Rate limit: https://developers.facebook.com/docs/marketing-api/overview/rate-limiting
- Errors: https://developers.facebook.com/documentation/ads-commerce/marketing-api/error-reference
- Currencies: https://developers.facebook.com/docs/marketing-api/currencies
- Pages: https://developers.facebook.com/docs/pages-api/overview · /docs/graph-api/reference/user/accounts/ · /docs/graph-api/reference/page/ · /docs/graph-api/reference/pagepost/ · /docs/graph-api/reference/page/feed/ · /docs/marketing-api/reference/business/owned_pages/ · /client_pages/
- Page/Post Insights: https://developers.facebook.com/docs/graph-api/reference/insights · /docs/platforminsights/page/ · blog 2025-08-15 page-insights-api-updates · v25 changelog (deprecations) · blog 2026-02-18 v25
- Page token: https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived · appsecret_proof: /docs/graph-api/securing-requests · access levels: /docs/graph-api/overview/access-levels
- Meta có MCP chính thức (OAuth, `https://mcp.facebook.com/ads`, beta 2026-04-29) — tham khảo cách đặt tên tool, không dùng.
