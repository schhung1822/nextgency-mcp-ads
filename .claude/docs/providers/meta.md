# Meta (Facebook/Instagram) Marketing API — tài liệu tham chiếu

> Research ngày 2026-10-02 từ developers.facebook.com (rà lại 2026-10-02 sau review adapter: §4 xoá/lưu trữ, §5 ad không có start/end time, validate_only, §6 deep copy). **Rà lại 2026-10-03**: không có version mới hơn v26.0; **Rà 2026-10-09**: ràng buộc `advideos` `file_url` (§5 Media); upload video theo phần `upload_phase` + `deadlineAt` (§5 Media "Upload theo phần"). **Rà 2026-10-15 (v1.1.2)**: §5 Media "Ảnh bìa video, trạng thái, khôi phục" (thumbnails, `video_status` gồm `expired`, `adimages` chỉ `bytes`/`copy_from`, `advideos?title=`, host graph-video bị đánh dấu deprecated). **Rà 2026-10-16 (v1.1.4)**: §5 "Bài có sẵn + lời chào", "Đổi creative của quảng cáo có sẵn" (creative bất biến, dedupe `object_story_id`, lỗi 1815471/1815573/1885088…), §9 điểm test thật. **Rà 2026-10-16 (v1.1.6)** (đọc bản `.md` chính thức ở `developers.facebook.com/documentation/ads-commerce/marketing-api/...`): §5 "Vị trí hiển thị" (enum + luật kết hợp), "Lịch chạy ad set (start_time)", "Lưu trữ (ARCHIVED)", §8 "Liệt kê đối tượng đã xoá", cache Trang quảng cáo, §7 mã lỗi, §10.1 lỗi quyền của tool Trang. Bổ sung **§10 Pages API** (danh sách Trang, bài viết, Page/Post Insights) cho tính năng Trang Facebook — thiết kế ở `.claude/docs/11-meta-pages.md`. Nhãn: **[T]** đã test thật bằng token (2026-10-03, `scripts/dev-probe-meta-pages.ts`) · **[H]** xác nhận trên trang chính thức · **[M]** chính thức nhưng chưa đầy đủ · **[L]** suy luận, phải test thật.
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
- **v26** (changelog https://developers.facebook.com/documentation/ads-commerce/marketing-api/marketing-api-changelog/version26.0, đọc lại 2026-10-16 [H]) — mỗi mục có phạm vi riêng:
  - Bỏ placement Instagram Explore Feed: "Applies to v26.0+" (không ghi ngày áp dụng mọi version; app pin v26 nên đã áp dụng).
  - Bỏ Messenger Stories (`messenger_positions: story`, tự gỡ khỏi vị trí): v26.0+, "Will apply to all versions late August 2026".
  - **Ngày 2026-10-27 (mọi version)** chỉ dành cho: chiến dịch HEF (nhà ở / việc làm / tài chính) phải gửi `advantage_audience` tường minh trên `POST act/adsets` **và** `POST /{adset_id}/copies` khi có nhắm mục tiêu giới hạn (xem §6); poll ads bị từ chối; `applink_treatment=web_only` cho Web & App; bỏ field Delivery Estimate `daily_outcomes_curve` / `budget_guardrail` / `estimate_dau`.
  - Lookalike `country` / `location_spec` bị bỏ qua (mọi version từ 2026-09-01).
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
- **Nhắn tin / mua qua tin nhắn — rà 2026-10-15** (https://developers.facebook.com/docs/marketing-api/reference/ads-action-stats/): [H] `onsite_conversion.messaging_conversation_started_7d` ("Messaging Conversations Started" → metric `messages`), `onsite_conversion.messaging_first_reply` ("New Messaging Conversations"), `onsite_conversion.messaging_block`, `onsite_conversion.messaging_user_subscribed`; mua hàng: `omni_purchase` (gộp kênh), `offsite_conversion.fb_pixel_purchase`, `onsite_conversion.purchase` ("On-Facebook Purchases"). [L] **Không có action type riêng có tài liệu** cho "mua qua tin nhắn" (`onsite_conversion.messaging_purchase`, `message_to_buy`… chưa kiểm chứng); nhiều khả năng sự kiện CAPI `business_messaging` nằm trong `omni_purchase` và/hoặc `onsite_conversion.purchase`.
  Adapter (v1.1.3, D5): kết quả chính vẫn là `results` / `cost_per_result` (đúng goal của ad set); `purchases` / `conversion_value` / ROAS chọn **loại đầu tiên có mặt** theo thứ tự `omni_purchase → purchase → offsite_conversion.fb_pixel_purchase → onsite_web_purchase → onsite_conversion.purchase` — `onsite_conversion.purchase` chỉ là phương án dự phòng, **không bao giờ cộng** với loại khác. `messaging_first_reply` không gộp vào `messages`; có sẵn trong `extra.actions` khi `metrics=all`.

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
- **Vị trí hiển thị (placement) — rà 2026-10-16, v1.1.6 B5** (https://developers.facebook.com/documentation/ads-commerce/marketing-api/audiences/reference/placement-targeting; Instagram guide https://developers.facebook.com/documentation/ads-commerce/marketing-api/guides/instagramads/get-started; changelog v24 https://developers.facebook.com/docs/graph-api/changelog/version24.0/ và v26 https://developers.facebook.com/documentation/ads-commerce/marketing-api/marketing-api-changelog/version26.0):
  - [H] Enum trên trang tham chiếu: `facebook_positions` = feed, right_hand_column, marketplace, video_feeds, story, search, instream_video, facebook_reels, facebook_reels_overlay, profile_feed, notification · `instagram_positions` = stream, story, explore, explore_home, reels, profile_feed, ig_search, profile_reels · `messenger_positions` = sponsored_messages, story · `audience_network_positions` = classic, rewarded_video · `threads_positions` = threads_stream · `whatsapp_positions` = status. **Trang tham chiếu chưa cập nhật** theo changelog:
    - [H] v24: "Attempting to create or update an ad campaign with the Facebook video feeds ad placement will produce an error" → `video_feeds` đã chết (thay bằng `facebook_reels`).
    - [H] v26 ("Applies to v26.0+", không có ngày áp dụng mọi version): "The Instagram Explore Feed placement is no longer available" (cả `POST act/adsets` và `POST /{adset_id}`); [L] changelog không nêu tên enum → coi **cả `explore` và `explore_home`** là đã bỏ (guide cũ bắt `explore_home` đi kèm `explore`).
    - [H] v26 (mọi version từ cuối 8/2026): "The Messenger Stories placement (`story` in `messenger_positions`) is no longer available. Campaigns using this placement will have it automatically removed from their effective placements."
    - [L] groups_feed, instant_article, suggested_video, biz_disco_feed không có trong danh sách hiện tại. SDK Python không có enum vị trí (kiểu `list<string>`) [M].
  - Adapter (`targeting.ts`): input `facebook_positions` = enum `FACEBOOK_POSITIONS` (danh sách trên trừ `video_feeds`), `instagram_positions` = `stream, story, reels, profile_feed, ig_search, profile_reels`; `[]` = bỏ chọn riêng (mọi vị trí của nền tảng). Không có input `messenger_positions` / `audience_network_positions` (Meta tự chọn khi `publisher_platforms` có messenger / audience_network).
  - [H] Luật kết hợp (kiểm tra bằng `placementProblems` trên targeting **sẽ gửi** — payload tạo mới hoặc targeting đã merge khi sửa, nên vị trí hiện có của nhóm cũng được tính; lỗi → từ chối trước mọi POST, cả preview):
    - "If you select `story`, you must use Facebook `feed` or Instagram `story` and `device_platforms: mobile` because Facebook Stories is mobile-only" → adapter đòi `device_platforms` **chỉ có** `mobile` trên targeting sẽ gửi (thiếu hoặc có desktop → từ chối, yêu cầu AI tự đặt `["mobile"]`; không tự sửa targeting; targeting hiện có đã mobile-only thì qua).
    - "If you select `marketplace`, `search`, `profile_feed`, or `notification`, you must use `feed`."
    - Instagram `ig_search` cần `stream` (guide Instagram). Explore cần `stream` + `explore` (không còn dùng).
    - `facebook_positions` cần `publisher_platforms` có `facebook` (tương tự instagram/messenger/audience_network). Khi sửa mà đổi `publisher_platforms` bỏ một nền tảng, adapter tự bỏ `*_positions` của nền tảng đó (trừ khi truyền tường minh → báo lỗi xung đột).
    - "You cannot use Audience Network alone" → từ chối `publisher_platforms: ["audience_network"]`.
    - Chỉ cảnh báo (phụ thuộc creative/objective, adapter không biết lúc tạo nhóm): `instream_video` không kèm `feed` chỉ được nhận ở US, GB, FR, ES, DE, MX, IN, TH với mục tiêu VIDEO_VIEWS / POST_ENGAGEMENT ("not supported for the `CONVERSIONS` objective"); chỉ `right_hand_column` không dùng được cho video / collection / canvas.
    - Không tìm thấy luật cho `facebook_reels_overlay` hay Instagram `story` cần `stream` → không chặn.
  - Targeting hiện có còn vị trí đã bỏ (`video_feeds`, `explore`, `explore_home`, Messenger `story`): adapter **bỏ khỏi payload + cảnh báo** (gửi lại sẽ làm hỏng cả lệnh sửa); bỏ xong mà danh sách rỗng → từ chối, yêu cầu truyền vị trí mới (không tự đổi thành "mọi vị trí").
  - Mã lỗi vị trí có tài liệu [H]: **1815609** "Placement Not Supported By Objective", **1815610** "Device Platform Not Supported By Objective". Các mã 1487057 / 1885366 / 1815891 **không có** trong error reference [L] — chưa map.
- Objective → optimization_goal / promoted_object:

| Objective | optimization_goal | promoted_object / ghi chú |
|---|---|---|
| OUTCOME_AWARENESS | REACH, IMPRESSIONS, AD_RECALL_LIFT, THRUPLAY | `page_id` |
| OUTCOME_TRAFFIC | LINK_CLICKS, LANDING_PAGE_VIEWS | destination_type WEBSITE/MESSENGER/WHATSAPP/PHONE_CALL |
| OUTCOME_ENGAGEMENT | POST_ENGAGEMENT, THRUPLAY, CONVERSATIONS, PAGE_LIKES | CONVERSATIONS cần destination_type MESSENGER/WHATSAPP/INSTAGRAM_DIRECT |
| OUTCOME_LEADS | LEAD_GENERATION, QUALITY_LEAD | `destination_type=ON_AD`, `{"page_id":..}` |
| OUTCOME_SALES | OFFSITE_CONVERSIONS, VALUE | `{"pixel_id":..,"custom_event_type":"PURCHASE"}` |
| OUTCOME_SALES | CONVERSATIONS (v1.1.3) | destination_type MESSENGER/WHATSAPP/INSTAGRAM_DIRECT + `{"page_id":..}`; tuỳ chọn `pixel_id` + `custom_event_type` (phải đi cùng nhau) [M: guide CTM/CTWA ghi SALES→CONVERSATIONS với `{page_id}`, bảng ODAX mapping ghi thêm pixel] |
| OUTCOME_SALES | MESSAGING_PURCHASE_CONVERSION (v1.1.3) | "Tối đa lượt mua qua tin nhắn": **chỉ MESSENGER** (bỏ trống → adapter gửi MESSENGER), `{"page_id":..}` (tuỳ chọn thêm `pixel_id` + `custom_event_type=PURCHASE`), `billing_event=IMPRESSIONS`, bid `LOWEST_COST_WITHOUT_CAP`/`COST_CAP`, không gửi `attribution_spec` — chi tiết bên dưới |
| OUTCOME_APP_PROMOTION | APP_INSTALLS | `{"application_id":..,"object_store_url":..}` |

- Giới hạn: đổi budget ad set tối đa **4 lần/giờ** (`613/1487632`); không đổi daily↔lifetime; `daily_budget ≥ min_daily_budget` của account; ~5.000 ad set/account, 50 ad/ad set.
- **Lịch chạy ad set (`start_time`) — rà 2026-10-16, v1.1.6 B4**:
  - [H] Campaign: "At the campaign level, `start_time` is a read only field. You can setup `start_time` at the ad set level." (ad-campaign-group reference) → adapter từ chối `ads_update_object` `start_time` ở cấp chiến dịch (trước đây gửi thẳng).
  - [L] Ad set: mục Updating của reference liệt kê `start_time` là trường sửa được, **không** ghi giới hạn; không có mã lỗi chính thức. Ads Manager khoá ngày bắt đầu khi nhóm đã chạy (nguồn bên thứ ba). Quyết định v1.1.6: khi `start_time` hiện tại ≤ bây giờ (đã/đáng lẽ đã bắt đầu, kể cả nhóm tạm dừng từ đầu) → từ chối trước mọi ghi (cả preview), gợi ý chỉ đổi `end_time` hoặc sao chép nhóm rồi đặt `start_time` cho bản sao. Gửi lại đúng thời điểm cũ (khác offset) = không đổi. `start_time` mới ở quá khứ → cảnh báo bắt đầu ngay khi bật.
  - Mô tả `meta_create_adset.start_time`: muốn chạy từ 00:00 một ngày thì đặt ngay lúc tạo.
- **Mua hàng qua tin nhắn (`MESSAGING_PURCHASE_CONVERSION`) — rà 2026-10-15, v1.1.3 D1/D2/D4** (nguồn: reference ad set + SDK `adset.py` enum [H, chỉ enum]; Help "Purchases through messaging" https://www.facebook.com/business/ads/click-to-message-ads/purchases-through-messaging [H, UI]; diễn đàn lỗi 2490408 [L]):
  - Ads Manager: Doanh số → Ứng dụng nhắn tin → **chỉ Messenger** → "Maximize number of purchases through messaging". [H] "only available for ads that click to Messenger" (trang CAPI Business Messaging lại nói Messenger + WhatsApp — adapter chỉ cho Messenger).
  - Adapter (`checkAdsetGoal` / `buildAdsetPayload`): chỉ `OUTCOME_SALES` (ENGAGEMENT bị Meta trả 2490408 [L] → từ chối trước); `destination_type` MESSENGER (khác → từ chối); `promoted_object.page_id` bắt buộc; `pixel_id` + `custom_event_type` tuỳ chọn, đi cùng nhau, chỉ `PURCHASE`; `billing_event=IMPRESSIONS`; bid (của nhóm, hoặc của chiến dịch CBO) chỉ `LOWEST_COST_WITHOUT_CAP` / `COST_CAP` [L COST_CAP]; không gửi `attribution_spec` (ngoài OFFSITE_CONVERSIONS/APP_INSTALLS chỉ dùng được 1-day click [H]). Preview luôn chạy `validate_only` + cảnh báo điều kiện tiên quyết.
  - Điều kiện tiên quyết (app không kiểm tra trước được — cần page token / `page_events`): Trang có **≥5 sự kiện mua hàng từ cuộc trò chuyện Messenger trong 30 ngày** gửi về Meta — qua Conversions API for Business Messaging (`POST /{PAGE_ID}/dataset` → `POST /{DATASET_ID}/events` với `action_source:"business_messaging"`, `messaging_channel:"messenger"`) hoặc "Tạo đơn" trong Meta Business Suite. Thiếu → Meta từ chối goal (mã lỗi chưa có tài liệu; ứng viên `100/2490408`).
  - `CONVERSATIONS` dưới SALES: như nhánh ENGAGEMENT/LEADS (destination nhắn tin + `page_id`), thêm luật `pixel_id` ⇔ `custom_event_type`. Nhánh ENGAGEMENT/LEADS giữ nguyên.
  - **Tối đa GIÁ TRỊ lượt mua qua tin nhắn ("Value", chỉ Messenger) — rà 2026-10-28, CHƯA hỗ trợ**:
    - [H, UI] Click to Message Ads (https://www.facebook.com/business/ads/click-to-message-ads): "Giá trị: Tăng tối đa doanh thu tạo ra trên mỗi lượt bán (chỉ click đến Messenger)". Trang "Purchases through messaging" chỉ mô tả *số* lượt mua.
    - [H] Reference ad set v26.0 (https://developers.facebook.com/docs/marketing-api/reference/ad-campaign), bảng ODAX: Sales + Messenger = `CONVERSATIONS, OFFSITE_CONVERSIONS, LINK_CLICKS, IMPRESSIONS, REACH`; `VALUE` chỉ có ở Sales + Website (và App). `VALUE` = "Optimize for maximum total purchase value within the specified attribution window". `MESSAGING_PURCHASE_CONVERSION` chỉ có trong enum, không mô tả, không có trong bảng ODAX.
    - [H] Enum `OptimizationGoal` SDK Python (`facebook_business/adobjects/adset.py`, nhánh main, đọc 2026-10-28): **không có** goal riêng cho giá trị mua qua tin nhắn — nhóm messaging chỉ `MESSAGING_PURCHASE_CONVERSION`, `MESSAGING_APPOINTMENT_CONVERSION`, `MESSAGING_DEEP_CONVERSATION_AND_FOLLOW`; nhóm value chỉ `VALUE`, `IN_APP_VALUE`, `ADVERTISER_SILOED_VALUE`.
    - [H] Conversions API for Business Messaging (https://developers.facebook.com/docs/marketing-api/conversions-api/business-messaging): "purchase optimization" cho Messenger + WhatsApp (không Instagram); sự kiện `Purchase` có `custom_data.value` + `currency` (chỉ trong payload mẫu); "You can only link one dataset to a page"; không nhắc tối ưu giá trị.
    - Kết luận: **không có tài liệu API công khai** cho tổ hợp này. Ứng viên [L]: `optimization_goal=VALUE` + `destination_type=MESSENGER` + `promoted_object={page_id, pixel_id: <dataset của Trang>, custom_event_type: PURCHASE}`. Adapter hiện không chặn tổ hợp này (nhánh `VALUE` chỉ đòi `pixel_id` + `custom_event_type`) nhưng mô tả tool không hướng dẫn, không có cảnh báo điều kiện, `LOWEST_COST_WITH_MIN_ROAS` bị từ chối → coi là chưa hỗ trợ. Xác minh: tạo 1 nhóm "Giá trị" trong Ads Manager rồi `GET /{adset_id}?fields=optimization_goal,destination_type,promoted_object,billing_event,bid_strategy,attribution_spec` (hoặc `ads_get_object`) để lấy đúng payload Meta lưu, sau đó chạy `validate_only` với payload đó.
  - **Quảng cáo khách hàng tiềm năng trong Messenger** (`LEAD_GENERATION|QUALITY_LEAD` + `destination_type=MESSENGER`): [H] "Beginning with v24.0, the ability to create lead ads that generate leads in Messenger with the API is being deprecated" → adapter từ chối (cả khi tạo ad set lẫn tạo ad trong ad set như vậy có sẵn).

### Media
- Ảnh: `POST /act_{id}/adimages` (multipart `filename`, `bytes` base64, hoặc `copy_from={"source_account_id","hash"}`) → `images.<name>.hash`.
- Video: `POST /act_{id}/advideos` (`file_url` hoặc `source`); file lớn dùng resumable (start → transfer → finish) trên graph-video; poll `GET /{video_id}?fields=status` tới `ready` trong ngân sách chờ (`MediaUploadRequest.deadlineAt` nếu có — thắng `maxWaitMs`; không thì `maxWaitMs`, mặc định `META_TIMINGS.videoMaxWaitMs` 60 s; hết giờ hoặc 1 lần gọi status quá chậm → trả id + `processing: true`; tên video `file_url` = `"<name hoặc fileName> · <6 hex>"` gửi cả `name` + `title` (v1.1.2 D8); job chunked gửi `title` = name || fileName ở bước finish).
- **`deadlineAt`** (`src/server/providers/media-deadline.ts`): timeout lệnh tạo (`adimages`, `advideos` file_url) = min(120 s, deadlineAt − now − 1 s); còn < 2 s → không gửi ("chưa tạo gì"); lệnh tạo bị timeout → **không retry**, lỗi "có thể đã tạo trên nền tảng - kiểm tra thư viện media".
- **Upload theo phần (resumable) — rà 2026-10-09** (job nền cho video lớn, `uploadMetaVideoChunked` = `AdsProvider.uploadVideoChunked`):
  - [H] Reference `/act_{id}/advideos` (https://developers.facebook.com/docs/marketing-api/reference/ad-account/advideos/): `upload_phase` = `start | transfer | finish | cancel`; `file_size` (int64, byte, dùng khi chunked); `upload_session_id`; `start_offset` ("start position in byte of the chunk that is being sent, inclusive"); `end_offset`; `video_file_chunk` ("The chunk of the video, between start_offset and end_offset"). Response có `video_id`, `upload_session_id`, `start_offset`, `end_offset`, `success`.
  - [H] Guide Business Creative Asset Management (https://developers.facebook.com/docs/business-management-apis/business-creative-asset-management/get-started): host **`graph-video.facebook.com`**; response `transfer` = offset của phần **tiếp theo** (ví dụ dạng **chuỗi** `{"start_offset":"52428800","end_offset":"104857601"}` → Meta tự chọn cỡ phần, ~50 MB); "Send all additional chunks until start_offset equals end_offset"; "If you get errors during an upload, you can retry uploading that chunk".
  - [H] SDK chính thức Meta `facebook-python-business-sdk` `facebook_business/video_uploader.py` (https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/video_uploader.py, đọc 2026-10-09): start gửi `file_size` + `upload_phase=start`; transfer gửi `upload_phase=transfer`, `start_offset`, `upload_session_id` + file part `video_file_chunk` = byte `[start_offset, end_offset)`; lỗi transfer subcode **1363037** kèm `error_data.start_offset/end_offset` → gửi lại theo khoảng Meta chỉ định; `is_transient` → chờ 1 s gửi lại; finish gửi `upload_phase=finish`, `upload_session_id`, **`title`**; chờ encode bằng `GET /{video_id}?fields=status` (`video_status` khác `processing` = xong, khác `ready` = lỗi).
  - Adapter: start (timeout 120 s) → transfer từng phần theo offset Meta trả (kiểm tra 0 ≤ start < end ≤ size, mỗi phần ≤ 64 MB — offset lớn hơn bị từ chối trước khi đọc và huỷ phiên; đọc nguồn bằng `readChunk` từng mẩu ≤ 16 MB, kiểm tra đủ byte, ghép `File` trực tiếp từ các mẩu (không `Buffer.concat`); timeout 300 s/phần) → `onProgress(start_offset)` → finish (`title` = name || fileName) → poll tới `deadlineAt`. Một phần lỗi mạng/timeout/5xx/`is_transient` hoặc 1363037 → gửi lại **chính phần đó** ≤ 2 lần; lỗi khác → `upload_phase=cancel` (best effort) rồi ném lỗi; **không bao giờ** tự khởi động lại cả upload. Finish lỗi tạm thời → gửi lại ≤ 2 lần; nếu lần sau bị từ chối nhưng `video_status` đã `processing/ready` → coi là xong.
  - **[L] / UNVERIFIED**: giới hạn upload một lần (non-resumable `file_url`/`source`) **1 GB / 20 phút** chỉ là suy luận từ tài liệu Video API cũ — không có trong reference advideos / Page videos hiện tại; cỡ phần do Meta quyết định (ví dụ ~50 MB) — không có con số chính thức; gửi lại cùng `start_offset` sau timeout (phần trước có thể đã tới) — kỳ vọng Meta trả 1363037 + offset đúng (theo SDK), chưa test thật; finish lặp lại sau timeout — hành vi chưa có tài liệu.
  - Không dùng: Resumable Upload API cấp app (`POST /{app-id}/uploads` → `POST /upload:<session>` header `file_offset`, trả file handle — https://developers.facebook.com/docs/graph-api/video-uploads, host rupload) và các edge video khác (`/{page-id}/videos`, `video_ads`): advideos có nhận file handle không — **UNVERIFIED**, nên giữ luồng `upload_phase` đã có tài liệu cho advideos.
- **`file_url` — rà 2026-10-09** (dùng cho link tạm relay, doc 15 §8):
  - [H] Reference `/act_{id}/advideos` (https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/ad-account/advideos): `file_url` chỉ ghi "SELF_EXPLANATORY"; lỗi liên quan: **389** "Unable to fetch video file from URL", 352 định dạng không hỗ trợ, 382 file quá nhỏ, 6000/6001 lỗi upload.
  - [H] Guide FB Video Ads (https://developers.facebook.com/documentation/ads-commerce/marketing-api/guides/videoads/fbvideoads): URL phải là video **công khai** qua **http/https**; "urls requiring authentication are not currently supported"; dung lượng "Up to 10 GB recommended"; khuyến nghị MP4 (H.264/H.265), 1280×720.
  - [H] Graph `/{page-id}/videos` (https://developers.facebook.com/docs/graph-api/reference/page/videos/): `file_url` = "Accessible URL of a video file. Cannot be used with `upload_phase`."
  - **UNVERIFIED** (không có trong tài liệu): timeout khi Meta tải, có theo redirect không, có yêu cầu `Content-Type` cụ thể không, có dùng `Range`/HEAD/tải nhiều lần không, IP/user-agent crawler → relay trả 200 trực tiếp (không redirect), `Content-Type` video thật, `Content-Length`, hỗ trợ Range; không chặn bot (Cloudflare challenge) trên `/dl/*`.
- Ảnh: adapter chỉ upload `bytes` (base64 multipart, ≤ 30 MB); URL chỉ mang tính thông tin (không cần http(s) khi có bytes — Drive).
- **Ảnh bìa video, trạng thái, khôi phục — rà 2026-10-15 (v1.1.2, đọc tài liệu v25.0/v26.0; chi tiết: `15-google-drive-media.md` §18.9)**:
  - [H] VideoThumbnail (https://developers.facebook.com/docs/graph-api/reference/video-thumbnail/): `id, height, width, is_preferred, name, scale, uri`; edge `GET /{video-id}/thumbnails` (https://developers.facebook.com/docs/graph-api/reference/video/thumbnails/) trả `data` + `paging` (tạo thumbnail chỉ với video của Trang, ≤ 10 MB, nên cùng tỉ lệ khung). SDK chính thức `adobjects/advideo.py` có `get_thumbnails()` và field `picture`, `status`, `title`. Adapter đọc gộp `GET /{video_id}?fields=status,picture,thumbnails{uri,is_preferred,width,height}` [M: field expansion, pipeboard dùng `fields=picture,thumbnails,status` bằng token ads]; chọn `is_preferred`, không có thì cái đầu [L: thứ tự không có tài liệu], không có thì `picture` **chỉ khi `ready`** [M: lúc `processing` `picture` là ảnh placeholder].
  - [H] VideoStatus (https://developers.facebook.com/docs/graph-api/reference/video-status/): `video_status` `ready` = "uploaded, encoded, thumbnails extracted", `processing`, `error`; guide FB Video Ads (https://developers.facebook.com/documentation/ads-commerce/marketing-api/guides/videoads/fbvideoads) thêm `expired` và các phase `uploading_phase{status, bytes_transferred}`, `processing_phase`, `publishing_phase` (`status` `not_started|in_progress|complete|error`, `errors[{code,message}]` theo SDK); `processing_progress` 0–100. Adapter (`classifyVideoStatus`): `ready` → dùng được; `processing` + giá trị lạ → còn xử lý (log cảnh báo, không log dữ liệu); `error` / `expired` / phase `error` → thất bại kèm `errors[].message` đã làm sạch.
  - [H] AdCreativeVideoData (https://developers.facebook.com/docs/marketing-api/reference/ad-creative-video-data/): `image_hash` = ảnh trong thư viện làm thumbnail; `image_url`: "You should not use image URLs returned from the FB CDN but instead have the image hosted on your own servers" → ảnh bìa tự động: tải `uri` (URL fbcdn có chữ ký, hạn không có tài liệu [L]) qua `MutationOptions.fetchImage` của mcp-core (SSRF guard, https) rồi `POST act/adimages bytes` → `image_hash`. `uri` không trả/ghi log/lưu; preview chỉ dùng cho `validate_only`.
  - [H] `adimages` (https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/ad-account/adimages): tham số chỉ `bytes` (Base64) và `copy_from` — **không có `url`**; AdImage `url` là tạm thời, không dùng để tạo creative. Ảnh Feed: JPG/PNG ≤ 30 MB (Ads Guide). [L] hash = MD5 nội dung (upload lại cùng bytes → cùng hash) — chưa kiểm chứng.
  - [M] Thiếu ảnh bìa video → `100` / subcode **1443226** "Please specify one of image_hash or image_url in the video_data" (pipeboard; không có trong error reference) → adapter luôn gửi ảnh bìa. Lỗi Meta không tải được `image_url`: `100` / **3858258** [H].
  - [H] `GET /act_{id}/advideos` (https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/ad-account/advideos): lọc `title` ("Video name used in the video names filter"), min/max length/width/height/aspect; không có `since`/`until`; không có idempotency key. Adapter: tên `file_url` duy nhất `"<tên> · <6 hex>"` gửi cả `name` và `title` [L: field nào nuôi bộ lọc `title` chưa rõ]; timeout mơ hồ → `GET advideos?title=…&fields=id,title,created_time&limit=10` một lần (timeout 6 s), so khớp tiêu đề + `created_time ≥ lúc gửi − 60 s`, đúng 1 → `recovered: true`. [M] `filtering=[{"field":"id","operator":"IN","value":[…]}]` trên `advideos` (pipeboard) — dùng cho `getMediaStatus(verifyAccount)`, lỗi/không thấy → `not_found`.
  - [H] Video API overview (https://developers.facebook.com/docs/video-api/overview/): "The `graph-video.facebook.com` host for video uploads has been deprecated. Use the `graph.facebook.com` host" (không có ngày). **Chưa đổi host** của job chunked (`META_VIDEO_HOST`) — cần test `upload_phase` trên `graph.facebook.com` trước. Luồng mới `/act/video_ads` + `rupload` không dùng (system user có thể không được hỗ trợ).
  - Ngưỡng (v1.1.2 D6): `file_url` đồng bộ trong lượt gọi chỉ cho video Drive ≤ 20 MB; lớn hơn → job nền chunked (bước `start` trả `video_id` ngay). [L] `file_url` đồng bộ hay bất đồng bộ — chưa có tài liệu, cần đo.

### Creative `POST /act_{id}/adcreatives` (hoặc inline trong ad)
- Link/ảnh: `object_story_spec={"page_id","instagram_user_id","link_data":{"link","message","name","description","image_hash","call_to_action":{"type":"SHOP_NOW","value":{"link":".."}}}}`; carousel = `child_attachments` 2–10.
- Video: `video_data={"video_id","image_hash|image_url","message","title","call_to_action"}`.
- Bài có sẵn: `object_story_id="<PAGEID>_<POSTID>"`.
- **Creative nhắn tin (click-to-message) — rà 2026-10-15, v1.1.3 D3** (https://developers.facebook.com/documentation/ads-commerce/marketing-api/ad-creative/messaging-ads/click-to-messenger, `…/click-to-whatsapp`, `…/click-to-instagram`; AdCreativeLinkData / AdCreativeVideoData reference):
  - Áp dụng khi ad set có `destination_type` MESSENGER / WHATSAPP / INSTAGRAM_DIRECT (adapter đọc `destination_type`, `promoted_object` của ad set). `value.app_destination` ("Required" [H]) luôn theo đích của ad set: MESSENGER / WHATSAPP / INSTAGRAM_DIRECT (Instagram cần `instagram_user_id`). **Loại nút không cố định**: ví dụ chính thức click-to-Messenger dùng cả `LEARN_MORE` lẫn `MESSAGE_PAGE` [H] → adapter nhận mọi loại CTA người dùng chọn, thiếu thì tự đặt nút nhắn tin khớp (`MESSAGE_PAGE` / `WHATSAPP_MESSAGE` / `INSTAGRAM_MESSAGE`); chỉ từ chối nút nhắn tin của **app khác** (vd `WHATSAPP_MESSAGE` trong ad set MESSENGER) và `lead_gen_form_id`. CTA của ad set nhắn tin không mang `value.link` (trước v1.1.3 adapter gửi `value.link` cho `LEARN_MORE`…; nay gửi `app_destination`).
  - `link`: reference chỉ bắt buộc với carousel [H]; ví dụ CTM dùng `https://fb.com/messenger_doc/` [M] → adapter mặc định Messenger `https://fb.com/messenger_doc/`, WhatsApp `https://api.whatsapp.com/send` [H ví dụ CTWA], Instagram: không gửi `link` [L]. Ad set không phải nhắn tin: `link` vẫn bắt buộc như cũ.
  - `page_id` của creative (hoặc phần `PAGEID` của bài có sẵn) phải **trùng** `promoted_object.page_id` của ad set [M: AdPromotedObject "creative must promote that Page"] → khác thì từ chối trước khi POST.
  - `page_welcome_message` (string, trong `link_data` / `video_data`) [H]: văn bản ≤ 300 ký tự (mặc định của Meta "Hello! Can I get more info on this?"), hoặc chuỗi JSON VISUAL_EDITOR khi có câu hỏi gợi ý (ice breaker: title ≤ 80, response ≤ 300; số tối đa không ghi — adapter đặt 4 [L]):
    ```json
    {"type":"VISUAL_EDITOR","version":2,"landing_screen_type":"welcome_message","media_type":"text",
     "text_format":{"customer_action_type":"ice_breakers","message":{"ice_breakers":[{"title":"…","response":"…"}],"quick_replies":[],"text":"…"}},
     "user_edit":false,"surface":"visual_editor_new"}
    ```
    Tool nhận `creative.welcome_message` = chuỗi hoặc `{text, ice_breakers[]}`; adapter làm sạch (bỏ ký tự điều khiển trừ xuống dòng, bidi, zero-width, BOM; title một dòng; trùng title → từ chối), không có ice breaker → gửi chuỗi thường; có → `JSON.stringify` VISUAL_EDITOR. Hiện **chỉ cho ad set đích Messenger** (WhatsApp cần "JSON object passed as a string" + `autofill_message`; Instagram chưa có tài liệu) — ad set khác → từ chối.
  - Bài có sẵn trong ad set nhắn tin — **tài liệu mâu thuẫn** [M]: trang click-to-Messenger có ví dụ `object_story_id` + `call_to_action={"type":"MESSAGE_PAGE","value":{"app_destination":"MESSENGER"}}` ở cấp creative, nhưng mục Limitations cùng trang ghi `object_story_id` không được hỗ trợ; trang click-to-Instagram có ví dụ bài Facebook dùng `MESSAGE_PAGE`/`MESSENGER`. Adapter: chỉ ad set **MESSENGER** được gắn CTA cấp creative (+ kiểm tra Trang của bài); WHATSAPP / INSTAGRAM_DIRECT giữ nguyên như trước (gửi `object_story_id` không đổi); mọi trường hợp đều có cảnh báo trong preview "Meta có thể không nhận — nếu bị từ chối hãy tạo creative mới".
  - **Bài có sẵn + lời chào (v1.1.4 E1)** — rà 2026-10-16: `page_welcome_message` có 3 chỗ [H]: tham số **cấp creative** (string, `POST /act/adcreatives`, cũng là field đọc "Page welcome message for CTM ads"), `object_story_spec.*_data.page_welcome_message`, `asset_feed_spec.additional_data.page_welcome_message`. `object_story_spec` không đi cùng `object_story_id` → bài có sẵn chỉ còn **chỗ cấp creative** [M]. Adapter: `creative.existing_post.welcome_message` (cùng schema/làm sạch) chỉ khi ad set đích MESSENGER (khác → cùng thông báo từ chối như link/video) → creative inline `{object_story_id, call_to_action:{MESSAGE_PAGE, app_destination MESSENGER}, page_welcome_message}`. Chưa có ví dụ chính thức nào ghép `page_welcome_message` với `object_story_id` [M] (TOGI làm được trên tài khoản thật, cùng dạng VISUAL_EDITOR `customer_action_type: "ice_breakers"`, `quick_replies: []` [M]).
  - **Dedupe** [H]: "if the `object_story_id` being used is already in use by an existing creative … the API will return the value of the existing creative_id instead of creating a new one" (adcreatives › Limitations). Chưa rõ dedupe có so `page_welcome_message`/CTA không [L] — **đây là rủi ro chính cần test thật của chế độ lời chào trên bài có sẵn** (cả `meta_create_ad` lẫn `meta_update_ad_creative` cách (a)): nếu Meta luôn trả creative cũ thì `meta_update_ad_creative` luôn dừng ở bước đọc lại (an toàn, không đổi gì) và người dùng phải dùng cách (b) nội dung mới → sau khi tạo quảng cáo, adapter đọc lại `GET /{ad_id}?fields=id,creative{id,page_welcome_message}`: không có / khác lời chào → **cảnh báo** (quảng cáo vẫn giữ, không coi là lỗi) gợi ý `meta_update_ad_creative`; đọc lỗi → cảnh báo xem lại bằng `ads_get_object`. Không có lời chào → hành vi cũ, không đọc lại.
  - **Mẫu lời chào đã lưu (Trình quản lý → Cuộc trò chuyện → "Mẫu đã lưu") — test thật 2026-11-12** (`scripts/dev-probe-meta-messaging-live.ts`, TKQC T1, chiến dịch "Tin nhắn Test 123456" tạo trong Trình quản lý, Trang SiliconZ, mẫu "inchare x pre order siliconz.net"):
    - [T] Meta lưu mẫu vào `creative.page_welcome_message` (bài có sẵn → **cấp creative**) dạng chuỗi JSON **`JSON_SETUP`**, không phải VISUAL_EDITOR: `{"message_data":{"message":{"attachment":{"type":"template","payload":{"template_type":"button","text":"…","buttons":[{"title","type":"web_url","url","messenger_extensions":true,"webview_height_ratio":"full"}]}}}},"type":"JSON_SETUP","template_id":"<id mẫu>","is_user_editing":false}` (= tin nhắn Send API của Messenger + `template_id`).
    - [T] **Không có API đọc / liệt kê mẫu**: `GET /{page_id}/welcome_message_flows` (page token và user token, có `pages_messaging`) trả `[]` dù Trang có mẫu — endpoint này chỉ chứa flow do app đối tác tạo (`partner_app_welcome_message_flow_id`); `GET /{template_id}` → `100/33` (không tồn tại / không đọc được); `/{page_id}/message_templates` là tin nhắn tiện ích Messenger (cần `pages_utility_messaging`), không phải mẫu lời chào quảng cáo; `/{page_id}/saved_message_responses` → field không tồn tại.
    - Adapter (v1.1.12): `welcome_message: {from_ad_id}` (meta_create_ad mọi loại creative, meta_update_ad_creative cả 2 cách) đọc quảng cáo nguồn bằng `readNode` (cùng tài khoản quảng cáo, khác → `not_found`) với `creative{object_story_id,effective_object_story_id,object_story_spec,asset_feed_spec,page_welcome_message}`, lấy lời chào ở cấp creative → `object_story_spec.*_data` → `asset_feed_spec.additional_data.page_welcome_message`, rồi gửi **nguyên văn** (giữ `template_id`, nút, câu trả lời nhanh; Meta tự kiểm tra lại bằng `validate_only` trong bản xem trước). Từ chối: không có lời chào; chỉ có `partner_app_welcome_message_flow_id`; JSON hỏng; > 20.000 ký tự. Trang nguồn ≠ Trang đích → chỉ cảnh báo. Hiển thị (`greetingShown`) hiểu cả 3 dạng (text / VISUAL_EDITOR / JSON_SETUP: text ≤640, nút ≤3 kèm url, `template_id`); so sánh khi đọc lại (`greetingVerdict`) theo text + ice breaker + quick reply + nút (title/type/url), không theo `template_id` (Meta có thể bỏ).
    - [T] Test thật 2026-11-12 (TKQC T1, chiến dịch "[TEST Ads MCP] Lời chào mẫu đã lưu", nhóm MESSENGER / CONVERSATIONS, mọi object TẠM DỪNG): `meta_create_ad` bài có sẵn khác bài nguồn + `{from_ad_id}` → `validate_only` qua, tạo được creative MỚI (không dedupe), đọc lại `page_welcome_message` **giống hệt từng byte** (669 ký tự, giữ `template_id`); `meta_update_ad_creative` đổi sang lời chào chữ rồi `{from_ad_id}` trở lại → đều tạo creative mới, kiểm tra lời chào khớp rồi mới gắn; `validate_only` của creative link (`object_story_spec.link_data.page_welcome_message` = JSON_SETUP) cũng qua. Chưa kiểm: Trình quản lý có hiện quảng cáo tạo qua API là "Mẫu đã lưu" hay không (chỉ xem được trên giao diện).
    - [T] **Ma trận Messenger 2026-11-12** (TKQC T1, Trang SiliconZ, lời chào `{from_ad_id}` = mẫu JSON_SETUP, mọi object TẠM DỪNG, chiến dịch CBO 100.000 VND): OUTCOME_SALES + CONVERSATIONS, OUTCOME_ENGAGEMENT + CONVERSATIONS, OUTCOME_SALES + MESSAGING_PURCHASE_CONVERSION (Trang SiliconZ đủ điều kiện) × creative bài có sẵn / ảnh + link / video (ảnh bìa image_hash) → **9/9 tạo được**, đọc lại lời chào **giống hệt** bản gốc (giữ `template_id`), CTA `MESSAGE_PAGE`; Meta lưu lời chào ở cấp creative (bài có sẵn), `object_story_spec.link_data` (link), `object_story_spec.video_data` (video). **OUTCOME_LEADS + CONVERSATIONS + MESSENGER → Meta từ chối** (`100/2490408` "không thể dùng mục tiêu hiệu quả đã chọn cho mục tiêu chiến dịch") → adapter từ chối trước khi POST (`checkAdsetGoal`). Thêm nhóm khác mục tiêu vào chiến dịch CBO chi phí thấp nhất → `100/1885760` (mọi nhóm phải cùng optimization_goal) → map lỗi riêng + gợi ý tạo chiến dịch mới.
    - Quảng cáo mẫu của Trình quản lý dùng nhóm **đa đích** `destination_type=MESSAGING_INSTAGRAM_DIRECT_MESSENGER` + `asset_feed_spec.optimization_type=DOF_MESSAGING_DESTINATION` (Messenger + Instagram) — tool vẫn chỉ tạo / sửa lời chào cho nhóm đích MESSENGER (đa đích: chưa hỗ trợ; `meta_update_ad_creative` từ chối creative có `asset_feed_spec`).
  - Không làm: đa đích (`MESSAGING_*` destination + `asset_feed_spec.optimization_type="DOF_MESSAGING_DESTINATION"`), Messenger lead form (`ctm_lead_gen_template_id`), WhatsApp `autofill_message`.
- Advantage+ creative: `degrees_of_freedom_spec.creative_features_spec.<feature>.enroll_status=OPT_IN|OPT_OUT` → **mặc định gửi OPT_OUT cho mọi feature user không yêu cầu**.
- `url_tags` cho UTM.

### Quảng cáo video trực tiếp (livestream) — test thật 2026-11-12 (v1.1.12)
Nguồn: chiến dịch tạo trong Trình quản lý ("Test live chuyển đổi" Doanh số → website, "Chiến dịch Lượt tương tác mới" Tương tác → Messenger; TKQC T1, Trang "Giáp Đức Thắng" đang phát live) đọc bằng `scripts/dev-probe-meta-messaging-live.ts`, rồi tạo lại bằng tool (mọi object TẠM DỪNG, tên "[TEST Ads MCP] Live …"). Tài liệu Meta chỉ có tên field (`promoted_object.live_video_destination` "The live video destination type for live video ads", CTA `WATCH_LIVE_VIDEO` / `JOIN_LIVE_VIDEO`, `destination_type` enum có `FACEBOOK_LIVE` / `INSTAGRAM_LIVE`) — mọi điều dưới đây là [T].
- **Chiến dịch**: công tắc "Quảng cáo video trực tiếp" = `promoted_object.live_video_destination` = `FACEBOOK` | `INSTAGRAM` (vị trí chạy video trực tiếp). `FACEBOOK_LIVE` → `#100 Invalid parameter`. `validate_only` nhận với SALES / ENGAGEMENT / TRAFFIC / AWARENESS / LEADS. Đọc lại: `GET /{campaign}?fields=promoted_object` (ads_get_object campaign nay đọc thêm `promoted_object`).
- **Nhóm quảng cáo**: bình thường (Trình quản lý: Doanh số → website `OFFSITE_CONVERSIONS` + pixel, `destination_type=UNDEFINED`, attribution thêm `ENGAGED_VIDEO_VIEW` 1 ngày; Tương tác → `MESSENGER` + `CONVERSATIONS`). Trong chiến dịch live, `validate_only` + tạo thật qua tool: SALES × {website OFFSITE_CONVERSIONS, VALUE; Messenger CONVERSATIONS, MESSAGING_PURCHASE_CONVERSION} ✅; ENGAGEMENT × {Messenger CONVERSATIONS; `ON_POST` POST_ENGAGEMENT; `ON_VIDEO` THRUPLAY; `ON_PAGE` PAGE_LIKES; website OFFSITE_CONVERSIONS (pixel + sự kiện, vd CONTENT_VIEW)} ✅; ENGAGEMENT website LINK_CLICKS / LANDING_PAGE_VIEWS ❌ (2490408 / 1885014).
- **ENGAGEMENT cần destination "trên quảng cáo"** (áp dụng cả chiến dịch KHÔNG live): POST_ENGAGEMENT / THRUPLAY / PAGE_LIKES không có `destination_type` → `100/2490408`; có `ON_POST` / `ON_VIDEO` / `ON_PAGE` → OK. Adapter (`ENGAGEMENT_DESTINATION`): tự đặt khi bỏ trống (OFFSITE_CONVERSIONS → `WEBSITE`), truyền sai → từ chối; ENGAGEMENT thêm goal OFFSITE_CONVERSIONS. Trước v1.1.12 tool không có ON_POST/ON_VIDEO/ON_PAGE → nhóm Tương tác "trên quảng cáo" luôn bị Meta từ chối.
- **Ngân sách**: nhóm 100.000 ₫/ngày tạo được trong chiến dịch live nhưng **mọi quảng cáo trong đó bị từ chối** `100/1885272` "Ngân sách nhóm quảng cáo phải đạt mức tối thiểu là 259.539 ₫" (mức tối thiểu tuỳ tài khoản); nâng 300.000 ₫ → tạo được; thêm quảng cáo thứ 2 vào cùng nhóm → đòi 519.078 ₫ = 2 × 259.539 → **mức tối thiểu tính theo MỖI quảng cáo live trong nhóm**. Adapter: cảnh báo khi tạo nhóm trong chiến dịch live (`LIVE_ADSET_BUDGET_NOTE`) + map 1885272 kèm gợi ý `ads_update_budget`.
- **Bài live**: `GET /{page_id}/live_videos?fields=id,title,description,status,creation_time,broadcast_start_time,planned_start_time,permalink_url,live_views,video{id}` (user token đọc được, không cần page token). Field gây lỗi: `is_reference_only` ("Copyright API only opens to page users" / "page is not qualified to use Video Copyright API"), `dash_preview_url` / `ingest_streams` (#10 stream keys). `video.length` lúc đang phát = 28800 (giữ chỗ) → không trả. `video.post_id` = `"0"` → **object_story_id = `<page_id>_<video.id>`** (đúng là cái Trình quản lý dùng; permalink dạng `/<profile id>/videos/<video.id>`). status: `LIVE` đang phát, `VOD` đã phát xong; `SCHEDULED_*` chưa có bài. Tool: `ads_lookup kind=live_videos parent_id=<page_id>` (Trang phải thuộc `advertisablePages`), id = object_story_id.
- **Quảng cáo**: creative = `object_story_id` của bài live (Trình quản lý: `object_type=VIDEO`; nút website `SEE_DETAILS` + link được Trình quản lý **gắn vào chính bài** — `GET /{post}?fields=call_to_action` → `{type:SEE_DETAILS, value:{link, link_format:"VIDEO_LPP"}}`). Qua API (tool): `creative.call_to_action` cấp creative cùng `object_story_id` → Meta nhận và lưu đúng (SEE_DETAILS / LEARN_MORE + link, WATCH_LIVE_VIDEO, MESSAGE_PAGE); bài viết không bị sửa. Lưu ý: `call_to_action_type` đọc lại = nút **của bài** (có thể khác) — xem `call_to_action`. **Nút hiển thị (chủ dự án xem `preview_shareable_link` 2026-11-12): bài live đã có nút (do Trình quản lý hoặc quảng cáo đầu tiên gắn) thì MỌI quảng cáo dùng bài đều hiện nút đó, bất kể creative gửi nút gì; bài chưa có nút thì nút của quảng cáo đầu tiên gắn luôn vào bài.** Đọc nút của bài: `GET /{page}_{video}?fields=call_to_action` cần **page token** (user token → #10 pages_read_engagement / Page Public Content Access; tham số `ids=` bị bỏ từ v26: "The ids query parameter is deprecated in v26.0+"). Adapter: `readMetaPostCta` (pages.ts, page token trong bộ nhớ) — `meta_create_ad` trong chiến dịch live (`checkLivePostCta`, cả preview): nút của bài khác nút quảng cáo cần (nhóm nhắn tin = nút nhắn tin của app; nhóm khác = `call_to_action.type`; không truyền nút mà bài có nút nhắn tin + goal website) → **từ chối trước khi ghi**; cùng nút khác link → cảnh báo link hiển thị; bài chưa có nút → cảnh báo nút sẽ dính vào bài; không đọc được → cảnh báo, vẫn tạo. `ads_lookup kind=live_videos` trả `postButton` cho 10 bài đầu. `video_data` với video live → `1443226` (bắt buộc ảnh bìa) → không dùng. Messenger: lời chào ở cấp creative như bài có sẵn (cả `{from_ad_id}` lấy từ quảng cáo live của Trình quản lý, VISUAL_EDITOR có `auto_follow_up` / `reengagement` / `image_format` / `video_format` — chép nguyên văn OK).
- Chưa làm / chưa kiểm: quảng cáo đặt trước cho live sắp diễn ra (SCHEDULED), Instagram live (`INSTAGRAM`, thường là quảng cáo hợp tác), sao chép chiến dịch live (`ads_copy_object`).
- **`meta_update_ad_creative` trong chiến dịch live** (đọc thêm `campaign{promoted_object}` của quảng cáo): cả 3 cách chạy `checkLivePostCta` với bài của creative mới — đổi sang bài live **khác** mà nút của bài không hợp nhóm → từ chối trước khi ghi; vẫn **cùng bài** quảng cáo đang dùng (vd chỉ đổi lời chào) → chỉ cảnh báo (nút hiển thị không đổi); `creative_id` trỏ bài live khác → cùng luật. Chế độ đọc tối giản (fallback #100) không đọc `promoted_object` → bỏ qua kiểm tra.

### Ad `POST /act_{id}/ads`
`name, adset_id, creative={"creative_id":".."}, status=PAUSED`. Sau khi sửa, ad vào review lại (`effective_status` PENDING_REVIEW).
- **Ad KHÔNG có field `start_time`/`end_time`** (lịch chạy nằm ở ad set; ad chỉ có `ad_schedule_start_time`/`ad_schedule_end_time`). Đọc `fields=start_time` trên ad → lỗi `#100` [H]. Campaign dùng `start_time`/`stop_time`; ad set dùng `start_time`/`end_time`.

### Đổi creative của quảng cáo có sẵn (v1.1.4 E2, `meta_update_ad_creative`) — rà 2026-10-16
- **Creative bất biến** [H]: `POST /{creative_id}` chỉ nhận `account_id`, `adlabels`, `name`, `status`; sửa nội dung → `100/1815573` "The parameter is not supported" [M]. Đổi nội dung = tạo creative mới rồi gắn: `POST /{ad_id}` `creative={"creative_id":"<id>"}` [H] (pipeboard làm y vậy [M]). Ad giữ **id**, trạng thái, số liệu (insights theo `ad_id`); creative cũ vẫn nằm trong tài khoản.
- Luồng adapter: đọc ad `fields=name,status,effective_status,adset{id,name,status,effective_status,destination_type,promoted_object,optimization_goal,is_dynamic_creative},campaign{id,name,status,effective_status,objective,smart_promotion_type},creative{id,name,status,object_story_id,effective_object_story_id,object_story_spec,asset_feed_spec,product_set_id,call_to_action,call_to_action_type,page_welcome_message,url_tags,instagram_user_id,authorization_category,platform_customizations}` (+ `account_id` = ranh giới grant, khác → `not_found` chuẩn) → dựng creative → `POST /act/adcreatives` (tên `<tên ad> - creative <yyyy-mm-dd hh:mm giờ TKQC> · <4 hex>`, không `status`; preview = `validate_only` trên `act/adcreatives` — [H] `execution_options` (enum có `validate_only`) là tham số tạo của https://developers.facebook.com/docs/marketing-api/reference/ad-account/adcreatives/ ; đã thêm vào allow-list của `validateOnly`) → có lời chào thì **đọc lại** `GET /{creative_id}?fields=id,account_id,page_welcome_message,object_story_spec` (thiếu / khác → lỗi, **không** gắn; so nội dung, JSON VISUAL_EDITOR so theo text + ice breaker) → `POST /{ad_id}` `creative={"creative_id"}` (không retry mù).
- 3 cách (đúng một): (a) `welcome_message`: creative có `object_story_spec.link_data` / `video_data` → **ưu tiên nhánh spec** (khi đó `object_story_id` có thể chỉ là bài ẩn): chép key đã có tài liệu (`link_data`: link, message, name, description, caption, image_hash, picture, call_to_action; `video_data`: video_id, image_hash, image_url, message, title, link_description, call_to_action; có `image_hash` thì bỏ `picture`/`image_url`), đặt `*_data.page_welcome_message`, CTA ép `app_destination: MESSENGER`; không có spec dùng được mà có `object_story_id` (bài có sẵn) → `{object_story_id, CTA nhắn tin Messenger giữ lại nếu đang có (MESSAGE_PAGE hoặc CTA có app_destination MESSENGER), không thì MESSAGE_PAGE, page_welcome_message **cấp creative** (chỗ duy nhất cho bài có sẵn — §5 "Bài có sẵn + lời chào"), instagram_user_id cũ}` + cảnh báo "Meta có thể dùng lại creative cũ của bài viết; nếu vậy hệ thống dừng, không đổi gì". Chép thêm `authorization_category` (khác NONE) và `url_tags`; Advantage+ creative gửi OPT_OUT như khi tạo + cảnh báo không chép tính năng Advantage+ và tuỳ chỉnh nâng cao của creative cũ (cắt ảnh, theo vị trí hiển thị, tuyên bố miễn trừ…). **Từ chối, không chép bản thiếu**: carousel (`child_attachments` — con có `picture` fbcdn ký + CTA `value.link`), `platform_customizations`, dạng khác (photo_data, template_data, không có spec). URL ảnh đọc từ Meta (fbcdn ký) chỉ gửi cho Meta, preview/log hiện nhãn `<ảnh hiện tại của creative>`; chữ đọc từ Meta trong bản xem trước (`message`, `name`, `description`, `link`…) được làm sạch + cắt độ dài (bản gửi Meta giữ nguyên). (b) `creative` = cùng builder với `meta_create_ad` (mọi luật nhắn tin, ảnh bìa video tự động, `image_drive_file` qua hook Drive của mcp-core) trên ad set của quảng cáo; `page_id` mặc định Trang của ad set nhắn tin / creative cũ. (c) `creative_id`: đọc creative (cùng TKQC, không DELETED/asset_feed_spec/catalog, Trang khớp ad set nhắn tin + được quảng cáo), preview chỉ từ đọc.
- Timeout / 5xx: tạo creative → tìm lại theo tên duy nhất (`act/adcreatives?fields=id,name&filtering=[name EQUAL]&limit=25`; AdCreative không có `created_time` đáng tin [L]); gắn → đọc lại `GET /{ad_id}?fields=id,creative{id}`, đã là creative mới → coi như xong. Gắn lỗi sau khi đã tạo → `hint` nêu id creative mồ côi + cách thử lại bằng `creative_id`. Meta trả lại đúng creative ad đang dùng → không gắn, báo "không cần đổi".
- Từ chối (trước mọi POST, cả preview): ad / ad set / campaign `ARCHIVED`/`DELETED` (Meta chỉ cho đổi tên [H]); ad set `is_dynamic_creative` [H: DCO 1 ad/ad set, creative phải asset_feed_spec]; creative có `asset_feed_spec` (FLEX/DCO — swap lỗi `3858355` [M]); catalog (`product_set_id` ở creative hoặc `promoted_object`); campaign `smart_promotion_type` `AUTOMATED_SHOPPING_ADS`/`SMART_APP_PROMOTION` (ASC/AAC kiểu cũ, cấm update từ 2026-05-19 [H]; giá trị enum `AUTOMATED_SHOPPING_ADS` [M]); `welcome_message` ngoài ad set MESSENGER; Trang khác `promoted_object.page_id` hoặc không thuộc `advertisablePages`.
- Luôn cảnh báo: Meta duyệt lại (`effective_status` → PENDING_REVIEW/IN_PROCESS [M]); có thể quay lại giai đoạn học (significant edit [M]); trạng thái ad giữ nguyên (đang chạy thì chạy tiếp sau duyệt — phiên bản cũ có chạy trong lúc duyệt hay không: **chưa có tài liệu** [L]); đổi sang bài / nội dung khác làm mất social proof (thích, bình luận gắn với `effective_object_story_id` [M]). Giữ social proof = dùng lại đúng bài (`object_story_id`).
- Lỗi map (`client.ts` `CREATIVE_ERRORS`, `invalid_request`, giữ `error_user_msg` đã làm sạch ≤300 ký tự "Meta báo: …", không retry): `1815471` lời chào không hợp lệ [M: chỉ nguồn bên thứ ba (ManyChat 2020), có thể là code cấp cao] · `1815573` không sửa được creative [M: pipeboard] · `1885088`/`1487056`/`1487566` đã lưu trữ / xoá (chỉ đổi tên) [H] · `1487007` nhóm quảng cáo đã qua ngày kết thúc → gia hạn `end_time` rồi thử lại [H] (map toàn cục nên sửa trạng thái / ngân sách cũng nhận hint này) · `1885998` creative ↔ DCO không khớp [M: pipeboard] · `3858355` định dạng linh hoạt [M: pipeboard] · `1885029` Trang ≠ đối tượng quảng cáo · `1885557`/`2490155`/`2446289`/`1487472` bài không dùng được. Mã quyền (10/200/294) và throttle giữ map cũ. `mapGraphError` (toàn cục) xoá mọi URL fbcdn / fbsbx khỏi `message`, `error_user_title`, `error_user_msg` trước khi map → "Meta báo: …", hint và `upstream` không bao giờ chứa URL ký.
- `ads_get_object` level=ad đọc thêm `creative{…call_to_action,page_welcome_message…}` (E4) để AI thấy lời chào / nút hiện tại.
- **Chống hỏng khi Meta từ chối field (#100, "nonexisting field", không subcode / message có "field" — `isGraphFieldError`)**: `ads_get_object` level=ad thử lại 1 lần với danh sách field v1.1.3 (im lặng, kết quả không có warnings); `meta_update_ad_creative` đọc lại ad / creative đích với field tối thiểu (creative `id,name,status,object_story_id,effective_object_story_id,object_story_spec,url_tags`; ad set / campaign không có `is_dynamic_creative` / `smart_promotion_type`) rồi đọc riêng từng node: ad set `id,is_dynamic_creative`, campaign `id,smart_promotion_type`, creative `id,asset_feed_spec,product_set_id,platform_customizations`; không đọc được field nào trong số này → **từ chối** (không đoán), đọc được → chạy tiếp kèm cảnh báo thiếu nút / lời chào / Instagram cũ (nút dùng MESSAGE_PAGE). Lỗi quyền / not_found không thử lại.

### Sửa / bật tắt
- `POST /{id}` với `status=ACTIVE|PAUSED|ARCHIVED|DELETED` (DELETED không hoàn tác — chỉ khi MCP có quyền `delete` + xác nhận).
- `POST /{id}` với `name`, `daily_budget`/`lifetime_budget` (minor units), `bid_amount`, `end_time`, `targeting`.
- `spend_cap` campaign đổi tối đa 10 lần/ngày (`17/1885172`).
- **Lưu trữ (ARCHIVED) — rà 2026-10-16, v1.1.6 D3** (`ads_set_status` status `archived` → `AdsProvider.archiveObjects` = `archiveMetaObjects`: batch `POST /{id} status=ARCHIVED`, cùng luồng đọc batch + kiểm tra TKQC như `setMetaStatus`):
  - [H] Status guide (https://developers.facebook.com/documentation/ads-commerce/marketing-api/best-practices/manage-your-ad-object-status): "An `ARCHIVED` object has only two fields you can change: `name` and `status`. You can also only change `status` to `DELETED`." Bảng chuyển trạng thái: ARCHIVED → chỉ `DELETED`; DELETED → không đổi được. Ad set reference: "An archived ad set can only update two fields: `name` and `campaign_status` … can only be changed to `DELETED`"; Ad reference tương tự.
  - [H] **Mâu thuẫn**: guide "Manage campaigns" (https://developers.facebook.com/documentation/ads-commerce/marketing-api/get-started/manage-campaigns) ghi "You can restore it by setting the status back to `ACTIVE`". Adapter theo reference + status guide: coi lưu trữ là **không bật lại được** (chỉ đổi tên / xoá); `ads_set_status` active/paused có id đang ARCHIVED → **từ chối cả lệnh trước mọi ghi** (cả preview), gợi ý sao chép đối tượng (`ads_copy_object`, bản sao tạm dừng) rồi bật bản sao (lỗi Meta 1885088 / 1487056 / 1487566 vẫn map nếu xảy ra).
  - [H] Con kế thừa: "If the status of a campaign is set to … `ARCHIVED` … all the objects below it automatically inherit that status" → cảnh báo đối tượng con ngừng phân phối. Đối tượng lưu trữ chỉ hiện trên edge khi lọc `effective_status=["ARCHIVED"]`.
  - [H] Giới hạn số đối tượng lưu trữ: status guide 100.000 mỗi loại (campaign / ad set / ad); trang Best Practices cũ vẫn ghi 5.000 (mâu thuẫn). Lỗi **1487990** "This Ad Account has already too many archived adgroups" → map `invalid_request` tiếng Việt (`client.ts` `CREATIVE_ERRORS`).
  - Adapter: bỏ qua (cảnh báo) đối tượng đã ARCHIVED / DELETED; luôn cảnh báo "gần như không hoàn tác"; preview chỉ đọc. Tool (Agent D) yêu cầu quyền `status` + `delete` và luôn xác nhận 2 bước.
  - **Batch không rõ kết quả** (bật/tắt và lưu trữ): một op của batch ghi không có câu trả lời / timeout / 5xx (`timeout`, `upstream_error`, `unknown`…) = **có thể đã thực hiện**. Không đối tượng nào xác nhận thành công mà có op không rõ → ném lỗi của op không rõ (không bao giờ lỗi "từ chối chắc chắn" như #200 của op khác — để D5 không hoàn slot hạn mức ghi), kèm `audit` (`errorCode: status_outcome_unknown`, `changes` = các thay đổi có thể đã áp dụng → ghi vào log MCP) và liệt kê id cần kiểm tra lại bằng `ads_get_object`. Có op thành công → trả thành công + cảnh báo từng id không rõ. Op bị từ chối chắc chắn: rate_limited, quota_exceeded, action_required, auth_invalid, permission_denied, invalid_request, not_found, unsupported.
- Batch: `POST /` `batch=[{"method":"POST","relative_url":"<id>","body":"status=PAUSED"}]` tối đa **50** op, mỗi op tính rate limit riêng. Async batch: `POST /act_{id}/async_batch_requests`.

## 6. Sao chép (native)
- `POST /{campaign_id}/copies` — `deep_copy`, `status_option` (PAUSED mặc định | ACTIVE | INHERITED_FROM_SOURCE), `rename_options={"rename_strategy":"ONLY_TOP_LEVEL_RENAME|DEEP_RENAME|NO_RENAME","rename_prefix","rename_suffix"}`, `start_time/end_time` → `{copied_campaign_id, ad_object_ids:[{ad_object_type,source_id,copied_id}]}`.
- `POST /{adset_id}/copies` — thêm `campaign_id` (đích) → `copied_adset_id`.
- `POST /{ad_id}/copies` — `adset_id` (đích), `creative_parameters` → `copied_ad_id`.
- **Giới hạn deep copy: ≤3 object con (tổng ad set + ad) khi sync** (51 khi async) [H]. Campaign có >3 con → không deep copy sync; dùng chiến lược bên dưới. Chiến lược an toàn (giống MCP noti.vn hiện tại):
  1. Copy campaign shallow → 2. copy từng ad set vào campaign mới (`deep_copy=true` nếu ≤3 ad, ngược lại shallow) → 3. copy từng ad với `adset_id` mới → 4. trả bảng map id nguồn→id mới + warnings; lỗi 1 nhánh không dừng cả lượt.
- Chỉ copy trong cùng ad account. Khác account = tạo lại + `adimages copy_from`.
- Không copy được ASC/AAC legacy; interest deprecated → `100/1487694`; EU thiếu DSA → `3858079/3858081`.
- **HEF + `advantage_audience` (v1.1.6 F, hạn 2026-10-27 mọi version)** — [H] changelog v26 "Explicit `advantage_audience` flag required for HEF campaigns": chiến dịch Special Ad Category Housing / Employment / Financial products and services có nhắm mục tiêu giới hạn ("custom audience inclusions or detailed targeting") mà không gửi rõ cờ → lỗi, trên `POST /{ad-account-id}/adsets` và `POST /{adset-id}/copies`.
  - Tạo ad set: `buildTargeting` **luôn** gửi `targeting.targeting_automation.advantage_audience` (0|1) → đã đúng (test cho cả 3 danh mục).
  - Sao chép: [H] reference `/{ad_set_id}/copies` (đọc 2026-10-16) chỉ có `campaign_id`, `deep_copy`, `end_time`, `rename_options`, `start_time`, `status_option` — **không có tham số targeting** → bản sao chỉ thừa hưởng targeting của nhóm nguồn [?: changelog không nói cách gửi cờ trên copies]. Adapter đọc `targeting` của nhóm nguồn + `special_ad_categories` của chiến dịch đích (sao chép chiến dịch sâu: từng nhóm); HEF + có `custom_audiences` / `flexible_spec` / `interests` / `behaviors` mà `targeting_automation.advantage_audience` không có → **cảnh báo** (preview và execute) yêu cầu đặt rõ bằng `meta_update_targeting` (gửi cờ tường minh) rồi sao chép lại. Chỉ cảnh báo, không chặn: Meta có trả về cờ ngầm định khi đọc targeting hay không chưa kiểm chứng [?]; không tự sửa nhóm nguồn.

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
| 100/2490408 | "Optimization Goal Isn't Available — You can't use the selected optimization goal for your campaign objective" (thấy với `MESSAGING_PURCHASE_CONVERSION` + ENGAGEMENT [L diễn đàn]; có thể cũng là lỗi khi Trang/tài khoản chưa đủ điều kiện mua qua tin nhắn [L]) | không retry; `invalid_request` + thông báo tiếng Việt nêu cả hai nguyên nhân + hint kiểm tra trong Ads Manager / dùng CONVERSATIONS |
| 100/1815471 [M], 1815573 [M], 1885088, 1487056, 1487566, 1885998 [M], 3858355 [M], 1885029, 1885557, 2490155, 2446289, 1487472 | Lỗi creative / sửa quảng cáo (v1.1.4, chi tiết §5 "Đổi creative"; [M] = chỉ nguồn bên thứ ba) | không retry; `invalid_request` + thông báo tiếng Việt + "Meta báo: …" (đã xoá URL ký) + hint |
| 100/1487007 | "part of a scheduled ad set that has reached its end date" — nhóm quảng cáo đã qua `end_time` [H] | không retry; `invalid_request` + hint gia hạn `end_time` (ads_update_object level=ad_group) |
| 100/1487990 | "This Ad Account has already too many archived adgroups" [H] | không retry; `invalid_request` + gợi ý xoá bớt đối tượng lưu trữ / dùng paused |
| 100/1815609, 100/1815610 | Vị trí / thiết bị không hỗ trợ cho objective [H] (chưa map riêng — đi nhánh 100 chung, giữ `error_user_msg`) | không retry |
| 1815001 | [L] Không có trong error reference; quan sát khi `ads_list_objects` gửi `effective_status` có `DELETED` lên edge (§8) | adapter không gửi DELETED lên edge nữa (B3) |
| 31 (vd subcode 3858385) | "This request requires the user to take a pending action" — Meta nghi truy cập trái phép, chặn tạo/sửa quảng cáo tới khi chủ tài khoản xác thực trong Trình quản lý quảng cáo (quảng cáo đang chạy vẫn chạy) [T 2026-10-13, khách báo] | không retry; `action_required` + hint xác thực trên Meta; token vẫn hợp lệ (không đánh `invalid`) |

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
| `ads_upload_media` | `/adimages`, `/advideos` (`file_url` ≤ 20 MB từ Drive; video lớn = job nền `upload_phase` start/transfer/finish trên graph-video); tên duy nhất + tìm lại bằng `advideos?title=` |
| `ads_get_media_upload` | `GET /{video_id}?fields=status,picture,thumbnails{…}` (`getMediaStatus`); `video_id` lạ → `act/advideos?filtering=[id IN]` |
| `ads_lookup` | promote_pages, adspixels, instagram_accounts, customaudiences, search adinterest/adgeolocation (`kind=pages` luôn đọc mới) |
| `meta_create_campaign` / `meta_create_adset` / `meta_create_ad` | §5, luôn PAUSED, hỗ trợ validate_only |
| `meta_update_targeting` | `POST /{adset_id} targeting=` |
| `meta_update_ad_creative` | `POST /act/adcreatives` (preview `validate_only`) → đọc lại lời chào → `POST /{ad_id} creative={"creative_id"}` (§5 "Đổi creative") |
| `meta_list_pages` | cache `meta_pages` (sync `/me/accounts` + BM `owned_pages`/`client_pages`) |
| `meta_list_page_posts` | `/{page}/{published_posts|feed|ads_posts|scheduled_posts}` bằng page token (§10.4) |
| `meta_get_post` | `GET /{PAGEID_POSTID}` bằng page token |
| `meta_get_post_insights` | batch `GET /{post}/insights?metric=…&period=lifetime` bằng page token (§10.5) |
| `meta_get_page_insights` | `GET /{page}/insights?period=…&since&until(+1)` chia khúc 90 ngày, ngày giờ LA (§10.5) |

### Liệt kê đối tượng đã xoá (v1.1.6 B3)
- [H] Status guide (https://developers.facebook.com/documentation/ads-commerce/marketing-api/best-practices/manage-your-ad-object-status), cột DELETED "Query as edges with status filter": "No if status filter does not contain `DELETED`, **and error if it does**"; đối tượng đã xoá chỉ đọc được theo id. (Trang tham chiếu `act/campaigns|adsets` vẫn liệt kê DELETED trong enum `effective_status` — mâu thuẫn, theo guide.) "A request with no filters returns only campaigns that were not archived or deleted" [H].
- Adapter (`listMetaObjects`): `statuses` chỉ gồm `deleted`/`removed` → `invalid_request` + gợi ý `ads_get_object` theo id / `ads_get_report` bật `include_deleted` / lọc `archived`, **không** gọi Meta; lẫn trạng thái khác → bỏ DELETED khỏi `effective_status` + cảnh báo. Insights (`report.ts`, filter `<level>.effective_status`) vẫn nhận DELETED (§4) — không đổi.

### Cache Trang quảng cáo (v1.1.6 D4)
- `advertisablePages` (`promote_pages` + `me/accounts` có task ADVERTISE, 2 GET) chạy ở mọi lần tạo nhóm / quảng cáo / đổi creative, cả preview lẫn execute → cache trong process **5 phút**, khoá = `sha256(token + "\0" + act_id)` (không giữ token thô; thay token tự trượt cache), gộp lời gọi đang chạy, **chỉ cache kết quả thành công**, đối tượng trả về bị freeze. `ads_lookup kind=pages` luôn đọc mới (và làm mới cache). `assertAdvertisablePages`: Trang không có trong cache → đọc mới **1 lần** rồi mới từ chối. Xoá theo kết nối qua `forgetPageTokens` (đã được gọi khi thay token / tắt / xoá kết nối). Rủi ro chấp nhận: Trang vừa bị gỡ quyền vẫn "được phép" tối đa 5 phút — Meta vẫn từ chối khi tạo thật.

## 9. Cần test thật khi implement
- **v1.1.6**: (1) đổi `start_time` của ad set đã chạy / tạm dừng từ đầu nhưng `start_time` đã qua — Meta có thật từ chối không, mã lỗi gì (adapter đang chặn trước); (2) `status=ACTIVE` trên campaign ARCHIVED — lỗi gì (guide nói khôi phục được, reference nói không); (3) mã lỗi thật khi `effective_status` có DELETED trên edge (1815001?) và khi gửi `video_feeds` / `explore` / `explore_home` / Facebook `story` đứng riêng; (4) targeting cũ còn `explore_home` khi sửa nhóm trên v26; (5) HEF: sao chép nhóm nguồn chưa có cờ `advantage_audience` sau 2026-10-27 — lỗi gì; `GET targeting` có trả cờ khi chưa từng đặt không; bản sao có thừa hưởng cờ của nguồn không; (6) Facebook story với `device_platforms` mobile + desktop có thật bị từ chối không.
- **v1.1.4 (§5 "Bài có sẵn + lời chào", "Đổi creative")** — `validate_only` trước, rồi trên quảng cáo thử:
  1. `POST adcreatives` `object_story_id` + CTA `MESSAGE_PAGE`/`MESSENGER` + `page_welcome_message` cấp creative (chuỗi thường, rồi JSON VISUAL_EDITOR): qua hay lỗi gì; đọc lại `page_welcome_message` có giữ nguyên JSON không (adapter so theo text + ice breaker).
  2. **Dedupe (rủi ro chính)**: bài đã có creative (không lời chào) → tạo lại kèm lời chào trả id mới hay id cũ? Id cũ có lời chào không? (nếu luôn trả id cũ thì cách (a) với bài có sẵn không dùng được → cân nhắc thử inline `creative={...}` khi update, hoặc chỉ dùng cách (b) bài khác / nội dung mới).
  3. Inline creative trong `POST /act/ads` (meta_create_ad) có bị dedupe như `adcreatives` không; đọc lại `GET /{ad_id}?fields=creative{id,page_welcome_message}` có trả lời chào ở cấp creative không, hay nằm trong `object_story_spec`.
  4. Bài ảnh, bài video, bài link đã có CTA riêng, bài album: CTA cấp creative có đè/xung đột không.
  5. Creative từ `object_story_spec`: Meta trả `object_story_spec` đọc được có đủ để gửi lại không (key read-only nào làm lỗi; `picture` + `image_hash` cùng lúc); `authorization_category` gửi lại được không (carousel / `platform_customizations` hiện bị từ chối — nếu cần hỗ trợ, test chép lại `child_attachments` với `image_hash`).
  6. `POST /{ad_id} creative={"creative_id"}` trên ad ACTIVE và PAUSED (MESSENGER): `effective_status` sau khi đổi (PENDING_REVIEW/IN_PROCESS?), `issues_info`; **phiên bản cũ có tiếp tục phân phối trong lúc duyệt lại không**; thời gian duyệt; có reset learning không (`learning_stage_info` của ad set).
  7. Field đọc `creative{call_to_action,page_welcome_message,instagram_user_id,product_set_id,asset_feed_spec}` lồng trong ad có lỗi `#100` ở creative nào không (adapter đọc chung một lần; `ads_get_object` cũng đọc `call_to_action`, `page_welcome_message`).
  8. `act/adcreatives?filtering=[name EQUAL]` có lọc thật không (adapter tìm lại theo tên sau timeout, `limit=25`).
  9. Mã lỗi thật khi đổi creative của ad DCO / FLEX / catalog / ASC kiểu cũ (adapter chặn trước, cần mã để map khi Meta tự báo) và khi ad PENDING_REVIEW; `1815471` về dạng `code` hay `error_subcode`.
  10. `smart_promotion_type` của chiến dịch Advantage+ hợp nhất mới (không được chặn nhầm).
- **v1.1.3 (§5 "Mua hàng qua tin nhắn", "Creative nhắn tin", §4)** — chạy bằng `validate_only` (không tạo object):
  1. `MESSAGING_PURCHASE_CONVERSION` + `OUTCOME_SALES` + `MESSENGER` + `promoted_object={page_id}` có qua không; nếu không, thử thêm `pixel_id` (dataset của Trang) + `custom_event_type=PURCHASE`, và thử dạng `OFFSITE_CONVERSIONS` + `MESSENGER` + dataset.
  2. Trang/tài khoản **chưa** đủ điều kiện trả mã lỗi nào (code/subcode/`error_user_msg`); `validate_only` có bắt được không hay chỉ lộ ra khi tạo/bật chạy.
  3. `COST_CAP` (và `LOWEST_COST_WITH_BID_CAP`, đang bị từ chối) có dùng được với goal này không.
  4. SALES + CONVERSATIONS cần `{page_id}` hay `{page_id, pixel_id, custom_event_type}`; có dùng được với WHATSAPP / INSTAGRAM_DIRECT không (hai bảng chính thức mâu thuẫn).
  5. ENGAGEMENT + `MESSAGING_PURCHASE_CONVERSION` ở v26.0 còn lỗi 2490408 không.
  6. `link` có bắt buộc trong `link_data` của CTM không; `https://fb.com/messenger_doc/` có được chấp nhận; Instagram Direct không gửi `link` có qua không.
  7. `page_welcome_message` dạng chuỗi JSON VISUAL_EDITOR có được chấp nhận khi cả `object_story_spec` được JSON-encode (hay Meta cần object); chuỗi thường có `{{user_first_name}}` có được thay tên không.
  8. Tên action type của "mua qua tin nhắn" trong insights (`GET /{adset_id}/insights?fields=actions,action_values,results&action_breakdowns=action_type`) và có đếm trùng giữa `omni_purchase` và `onsite_conversion.purchase` không.
  9. Ad set đích MESSENGER có chạy placement Instagram không, hay Meta tự giới hạn.
  10. `/copies` ad set có goal này có giữ nguyên goal không.
  11. Bài có sẵn (`object_story_id`) trong ad set nhắn tin: MESSENGER + CTA `MESSAGE_PAGE` cấp creative có được nhận không (Limitations nói không hỗ trợ); WHATSAPP / INSTAGRAM_DIRECT không có CTA thì sao.
  12. `LEARN_MORE` (và các CTA khác) với `value.app_destination` trong ad set MESSENGER / WHATSAPP / INSTAGRAM_DIRECT; `lead_gen_form_id` bị từ chối là đúng.
- **v1.1.2 (§5 "Ảnh bìa video")**: đọc `thumbnails`/`picture` bằng token system user chỉ quyền ads (video `advideos` không gắn Trang); `POST advideos file_url` đồng bộ hay bất đồng bộ + thời gian theo cỡ 10/20 MB; `advideos?title=` khớp chính xác hay chứa, `name` có ghi vào `title` không; `filtering` id trên `advideos`; giá trị `video_status` thực tế (`expired`, `publishing_phase`); subcode 1443226 khi thiếu ảnh bìa ở v26.0; `adimages` cùng bytes → cùng hash; `upload_phase` chạy được trên `graph.facebook.com`.
- `debug_token` dùng chính token (không app secret) với system user token.
- Enum chính xác của placement IG Explore đã bị bỏ (v1.1.6 coi cả `explore` và `explore_home` là đã bỏ [L]).
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
- **Lỗi quyền ở tool Trang (v1.1.6 B7)** — [H] insights reference (https://developers.facebook.com/docs/graph-api/reference/insights/): "A Page access token requested by a person who can perform the ANALYZE task on the Page", quyền `read_insights` + `pages_read_engagement`, lỗi 200 "Permissions error"; feed reference: task CREATE_CONTENT/MANAGE/MODERATE + `pages_read_engagement` + `pages_read_user_content`; code 10 "Application does not have permission for this action" [H]. `mapGraphError` toàn cục gợi ý `ads_management` (đúng cho quảng cáo, sai cho Trang) → `pages.ts` `pagePermissionError(e, kind)` viết lại lỗi `permission_denied` có mã Graph 10 / 200–299 / 294 theo việc đang làm: `insights` (read_insights + pages_read_engagement + task ANALYZE), `posts` (pages_read_engagement + pages_read_user_content + vai trò nội dung), `token` (lấy page token: pages_show_list + pages_read_engagement + vai trò trên Trang); kèm "Meta báo: …" (đã làm sạch, ≤200 ký tự), hint "không liên quan quyền ads_management". Lỗi vai trò do adapter tự tạo (không có page token, page token bị từ chối 2 lần) giữ nguyên.

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

### 10.4b Bình luận bài viết (test thật 2026-11-15, chi tiết: `11-meta-pages.md` §12)
- `GET /{post_id}/comments?filter=toplevel&order=reverse_chronological|chronological&summary=true` + `fields=id,message,created_time,from{id},like_count,comment_count,parent{id},is_hidden,attachment{type,url},permalink_url[,comments.order(chronological).limit(5){…}]` — **chỉ page token** (user token → `190/2069032`), via cần task MODERATE (thiếu → có thể trả rỗng).
- Khách bình luận: **không có `from`**; chỉ bình luận của Trang có `from.id`. `since` bị bỏ qua. id bình luận = `<id số của bài>_<id>`. `total_count` có thể lớn hơn số trả về.

### 10.4c Tin nhắn Messenger (test thật 2026-11-15, chi tiết: `11-meta-pages.md` §13)
- `GET /{page_id}/conversations?platform=messenger&folder=…[&user_id=]`, `GET /{t_id}`, `GET /{t_id}/messages` (phân trang) — **chỉ page token** + quyền `pages_messaging`, via task MESSAGING / MODERATE. `participants` có tên thật + bí danh email `<PSID>@facebook.com` (không xin). Instagram (`platform=instagram`) → 230 khi thiếu `instagram_manage_messages`.

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
