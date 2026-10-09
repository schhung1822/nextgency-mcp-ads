# TikTok API for Business (Marketing API) — tài liệu tham chiếu

> Research ngày 2026-10-02 (đọc ~80 trang doc + changelog tới 2026-09-18); **rà lại toàn bộ với doc chính thức ngày 2026-10-08** — không có changelog mới sau 2026-09-18; mọi chỉ số trước đây đánh dấu nghi ngờ đều đã xác nhận. **Rà phần upload media 2026-10-09** (ảnh UPLOAD_BY_FILE, ràng buộc `video_url`, upload video theo phần + `UPLOAD_BY_FILE_ID`, `deadlineAt` — §4 "File, identity, pixel"). **[H]** đọc trực tiếp doc chính thức · **[L]** không có trong doc · **UNVERIFIED** = chưa kiểm chứng được, adapter xử lý an toàn (ghi rõ cách).
> Doc portal là SPA; lấy markdown gốc qua JSON backend (dùng khi chạy `/provider-api-check tiktok`):
> - Trang theo id: `GET https://business-api.tiktok.com/gateway/api/doc/client/node/get/v2/?language=ENGLISH&doc_id=<id>`
> - Cây menu: `GET https://business-api.tiktok.com/gateway/api/doc/client/platform/tree/get/?identify_key=c0138ffadd90a955c1f0670a56fe348d1d40680b3c89461e09f78ed26785164b&language=ENGLISH&is_need_content=false`
> - Link người đọc: `https://business-api.tiktok.com/portal/docs?id=<doc_id>`

## 1. Phiên bản & base URL
- **v1.3** là version duy nhất (không có lịch sunset). Hằng số `TIKTOK_API_VERSION` (mặc định `v1.3`).
- Base: `https://business-api.tiktok.com/open_api/v1.3/<path>/` — **luôn giữ dấu `/` cuối**: thiếu dấu `/` TikTok trả **HTTP 308** (chuyển hướng), không phải envelope JSON → adapter luôn tự thêm.
- Sandbox: `https://sandbox-ads.tiktok.com/open_api/v1.3/` — **1 QPS / 30 QPM / 1.000 QPD**; report chỉ mock data; không hỗ trợ Smart+, copy, async report. Trỏ adapter sang sandbox bằng env **`TIKTOK_BASE_URL`** (`https://sandbox-ads.tiktok.com/open_api`; chỉ chấp nhận `https://`, không user/pass/query — token được gửi tới host này; để trống = production).

### Thay đổi lớn ảnh hưởng trực tiếp app
1. **Từ sau 2026-12-31 KHÔNG tạo được Manual Campaign qua `/campaign/create/`** [H]. `/campaign/update/` và `/campaign/status/update/` vẫn chạy (báo trước 3 tháng khi gỡ). `/adgroup/create/`, `/ad/create/` và copy task cho chiến dịch Manual có sẵn sau mốc này: **UNVERIFIED** (doc không nói) → adapter vẫn cho gọi, cảnh báo mốc 31/12/2026.
2. **Upgraded Smart+** (GA 2026-01-23): `/smart_plus/campaign|adgroup|ad/{get,create,update,status/update}/`, `/smart_plus/adgroup/budget/update/`, `/smart_plus/campaign/copy/task/create|check/`. **Create chỉ hỗ trợ `APP_PROMOTION`, `WEB_CONVERSIONS`, `LEAD_GENERATION`** và **cần account được allowlist qua sales rep**; get/report thì không. Update Smart+ là **incremental**. Không gọi quá 1 lần create/update/status mỗi 5 giây trên cùng 1 Smart+ ad.
   - Từ **2026-02-27** Smart+ non-CBO nhận cả `BUDGET_MODE_DAY` và `BUDGET_MODE_TOTAL` [H].
   - Object Upgraded Smart+ trả **`current_budget`** = ngân sách đang hiệu lực (`budget` có thể là giá trị hẹn giờ) → adapter đọc `current_budget` khi có (summary, "before" khi đổi ngân sách).
3. **Smart+ legacy** (`/campaign/spc/*`): tạo đã dừng 2026-03-31, update dừng 2026-06-30 → coi như chết; từ chối copy/sửa.
4. **Không được ghi Upgraded Smart+ qua endpoint manual**. Mọi object get về có `campaign_automation_type` = `MANUAL | SMART_PLUS | UPGRADED_SMART_PLUS` → **route mọi thao tác ghi theo field này**.
5. **Custom Identity** (`CUSTOMIZED_USER`) non-Spark trên placement TikTok/Automatic: account tạo từ 2026-01-15 không tạo được; account cũ không được hỗ trợ cho ad mới → ad mới dùng Spark Ads (`TT_USER`, `BC_AUTH_TT`, `AUTH_CODE`). Kiểm tra `/advertiser/info/` field `can_use_custom_identity` (gọi riêng).
6. `ad_id_v2` định danh ad xuyên Manual/Smart+; với Upgraded Smart+ `ad_id` là creative id. Không trộn `ad_id` và `ad_id_v2` trong 1 report.
7. Không còn: subplacement `TIKTOK_LITE`, placement `PLACEMENT_TOPBUZZ`, `auto_targeting_enabled`, `targeting_expansion`; `BUDGET_MODE_DAY` không còn cho chiến dịch **non-CBO** REACH/VIDEO_VIEWS/ENGAGEMENT.
8. TikTok có MCP chính thức (~400 tool, OAuth) — tham khảo cách đặt tên, không dùng.

## 2. Credential (dán token)
Header: **`Access-Token: <token>`** (KHÔNG phải `Authorization: Bearer`).

Token advertiser dài hạn **không hết hạn** và **không có refresh** (chỉ mất khi advertiser thu hồi hoặc gọi revoke). Token 24h chỉ áp dụng cho TikTok account (`tt_user`) — không dùng.

Cách user tự lấy token (không cần OAuth trong app):
1. business-api.tiktok.com/portal → đăng ký developer: **xác minh email** (bấm *Send Code*, mã dùng lại được trong 48 giờ), điền hồ sơ → **chờ hồ sơ developer được duyệt trước** rồi mới tạo app. Tối đa **5 app / developer**.
2. My Apps → tạo app, chọn scopes (duyệt **2–3 ngày làm việc**), thêm redirect URL. Đổi scope sau này → app bị duyệt lại 2–3 ngày làm việc **và advertiser phải uỷ quyền lại** để token mới có scope mới.
3. Mở "Advertiser authorization URL" → advertiser đồng ý → redirect về `redirect_uri?auth_code=...`. `auth_code` sống **≤ 1 giờ, dùng 1 lần** → đổi ngay.
4. Đổi code (app hỗ trợ sẵn nút "Đổi auth_code lấy token" trong form kết nối):
```
POST /open_api/v1.3/oauth2/access_token/      (chỉ nhận JSON)
{"app_id":"..","secret":"..","auth_code":"..","return_advertiser_ids":true}
→ {"code":0,"data":{"access_token":"..","scope":[1,2,4,6,8],"advertiser_ids":["7xx"]}}
```
Đây là nơi **duy nhất** trả về `scope` của token → lưu vào `connections.meta.scope` (dạng **chuỗi số**). Business Center rất lớn: gửi `return_advertiser_ids:false` để tránh response khổng lồ (app hiện gửi `true`; danh sách TKQC lấy lại qua `/oauth2/advertiser/get/`).
- Thu hồi: TikTok For Business → cài đặt **Authorization / uỷ quyền** của tài khoản (hoặc Business Center → Settings → Authorizations) → chọn app → **Remove**.

### Form kết nối
| Field | Bắt buộc | Ghi chú |
|---|---|---|
| `access_token` | ✔ | (hoặc dùng helper đổi `auth_code`) |
| `app_id` | ✔ | cần cho `/oauth2/advertiser/get/` |
| `secret` | ✔ | cần cho `/oauth2/advertiser/get/`, revoke |

### Kiểm tra & liệt kê
- `GET /user/info/` (chỉ token): lỗi 40104 rỗng, 40105 invalid, 40102 hết hạn.
- `GET /oauth2/advertiser/get/?app_id=&secret=` → `[{advertiser_id, advertiser_name}]` (sai cặp app → 40101/40113).
- `GET /advertiser/info/?advertiser_ids=[..]&fields=[..]` → `currency`, `timezone`/`display_timezone`, `status` (`STATUS_ENABLE`, `STATUS_LIMIT`, `STATUS_DISABLE`, `STATUS_PENDING_*`, **`STATUS_CONTRACT_PENDING` → pending**), `balance`, `owner_bc_id`, `role`, `company`, `country`, `rejection_reason`, `create_time` (batch 100 [L]). **`advertiser_account_type` không có trong doc → không yêu cầu.** Field `can_use_custom_identity` phải gọi riêng.
- Business Center: `GET /bc/get/` (page_size ≤50); ad accounts của BC: `GET /bc/asset/get/?bc_id=&asset_type=ADVERTISER` (**không có** `/bc/advertiser/get/` ở v1.3).
- Thiếu quyền xuất hiện muộn dưới dạng **40001** → hướng dẫn user cấp lại scope.
- **Múi giờ** (doc 1739593083610113): `timezone` = múi giờ của tài khoản quảng cáo, có thể ở dạng độ lệch GMT (vd `Etc/GMT-7`, `Intl` hỗ trợ); `display_timezone` chỉ là **tên hiển thị**. Adapter dùng `timezone` (hợp lệ IANA/`Etc/GMT±N`), không có/không hợp lệ mới dùng `display_timezone`, cả hai hỏng → `UTC` + cảnh báo; `display_timezone` lưu ở `extra.displayTimezone` (sửa 2026-10-08 — trước đây ưu tiên `display_timezone`, sai).

### Scope
Cần bật 5 nhóm: **1** Ad Account Management, **2** Ads Management, **4** Reporting, **6** Creative Management, **8** Pixel Management (tuỳ chọn **3** Audience). TikTok có thể trả **id cấp 1** (1, 2, 4…) **hoặc chỉ id con** của nhóm → adapter coi một nhóm là **đã cấp** khi có id cấp 1 **hoặc bất kỳ id con** nào:

| Nhóm | Id cấp 1 | Id con được tính |
|---|---|---|
| Ad Account Management | 1 | 10, 100, 15x (150–159) |
| Ads Management | 2 | 20, 21, 22, 2xx (200–299: 200/201 campaign, 210/211 ad group, 220/221 ad) |
| Reporting | 4 | 40–44 |
| Creative Management | 6 | 60, 61, 69, 601, 610, 611, 693 |
| Pixel Management | 8 | 80, 800 |

Một số scope id dài **19 chữ số** (vượt `Number.MAX_SAFE_INTEGER`) → luôn giữ dạng **chuỗi**, không `Number()`.

## 3. Báo cáo
### Sync `GET /report/integrated/get/`
- Account: `advertiser_id`, hoặc `advertiser_ids` (≤5, cùng 1 user), hoặc `bc_id` + `report_type=BC`.
- `report_type=BASIC`; `data_level`: `AUCTION_ADVERTISER|AUCTION_CAMPAIGN|AUCTION_ADGROUP|AUCTION_AD`.
- `dimensions`: tối đa **1 ID** (`advertiser_id|campaign_id|adgroup_id|ad_id|ad_id_v2`) + **1 thời gian** (`stat_time_day|stat_time_hour`).
- Giới hạn khoảng ngày: `stat_time_day` ≤ **30 ngày**; `stat_time_hour` ≤ 1 ngày; không dimension thời gian ≤ 365 ngày. `start_date/end_date` YYYY-MM-DD, inclusive, **theo múi giờ ad account**. `query_lifetime=true` bỏ qua ngày.
- `metrics` (mặc định chỉ `spend,impressions`) — có thể kèm attribute: `campaign_name, adgroup_name, ad_name, currency, objective_type, budget, bid_strategy`.
- `filtering` của report là **mảng** `[{"field_name":"campaign_ids","filter_type":"IN","filter_value":"[\"1\",\"2\"]"}]` — `filter_value` là **chuỗi JSON**. ID filter ≤100 (≤30 campaign khi level ad).
- **Mặc định loại object đã xoá** (`STATUS_NOT_DELETE`) → muốn đủ spend phải filter status `STATUS_ALL` (nặng hơn). Tên field lọc trạng thái **theo cấp** (đã kiểm chứng 2026-10-08): `campaign_status` (AUCTION_CAMPAIGN), `adgroup_status` (AUCTION_ADGROUP), `ad_status` (AUCTION_AD); cấp advertiser không có.
- `page`, `page_size` ≤ **1000**; `enable_total_metrics`.
- Mọi metric trả về là **string**. Tham số GET dạng mảng/object phải JSON-encode + URL-encode.

Ví dụ:
```
GET /open_api/v1.3/report/integrated/get/?advertiser_id=7xx&report_type=BASIC&data_level=AUCTION_CAMPAIGN
 &dimensions=["campaign_id","stat_time_day"]
 &metrics=["campaign_name","spend","impressions","reach","clicks","ctr","cpc","cpm","conversion","cost_per_conversion","complete_payment","complete_payment_roas","total_complete_payment_rate"]
 &start_date=2026-09-01&end_date=2026-09-30&page=1&page_size=1000
```

Metric hữu ích (tất cả đã xác nhận trên trang Metrics chính thức, 2026-10-08):
- Core: `spend, impressions, reach, frequency, cpm, cost_per_1000_reached`
- Click: `clicks, ctr, cpc` (click **đích**); `engagements, engagement_rate` (mọi click)
- Kết quả: `conversion, cost_per_conversion, conversion_rate` (/click), `conversion_rate_v2` (/impression), `result, cost_per_result, result_rate`
- Video: `video_play_actions, video_watched_2s, video_watched_6s, video_views_p25|p50|p75|p100, average_video_play, engaged_view, engaged_view_15s`
- Social: `likes, comments, shares, follows, profile_visits`
- Web (pixel): `complete_payment, cost_per_complete_payment, complete_payment_rate` (tỷ lệ), **`total_complete_payment_rate` = GIÁ TRỊ mua hàng**, `complete_payment_roas`, `initiate_checkout, web_event_add_to_cart, on_web_order, user_registration, form, total_landing_page_view`
- Tin nhắn: `messaging_total_conversation_tiktok_direct_message`
- Onsite/shop: `onsite_total_purchase, onsite_shopping, onsite_form, total_onsite_shopping_value, onsite_shopping_roas`
- **Lưới an toàn** (giữ lại dù không còn chỉ số nghi ngờ): TikTok trả `40002` nêu **nguyên tên** một chỉ số không cơ bản (vd không có cho tài khoản này) → adapter bỏ chỉ số đó, thử lại **đúng 1 lần** và cảnh báo (tiếng Việt). Chỉ số cơ bản (spend, impressions…) không bao giờ bị bỏ.

Lưu ý:
- Sync chỉ tính **20.000 ad tạo gần nhất** (header `X-Tt-Ads-Throttle` cảnh báo) → chia theo ID filter hoặc dùng async.
- Độ trễ: số liệu gần thời gian thực có thể trễ **≥ 2 giờ**; reach/frequency ~**16 giờ**. Dữ liệu T-1 chốt sau **12:00 UTC**.
- Timeout → **không retry y nguyên**, thu hẹp request (≤7 ngày, ít metric, filter ID).
- Adapter tự chia khoảng ngày >30 ngày thành nhiều cửa sổ ≤30 ngày rồi ghép.

### Async
`POST /report/task/create/` (giống body sync, không giới hạn ngày, không phân trang, filter chỉ ID/country, **≤500 task / ad account / giờ**) → `task_id` → `GET /report/task/check/` (`QUEUING|PROCESSING|SUCCESS|FAILED|CANCELED`) → `GET /report/task/download/` (CSV hoặc `download_url` 1h).

## 4. CRUD (POST body JSON; GET tham số trên query, mảng/object JSON-encode)
Quy tắc chung: ID là **string**; **create mặc định `operation_status=ENABLE` → luôn gửi `DISABLE`**; `request_id` (chuỗi int64) trên create = idempotency **chỉ 10 giây** (xem §6 "Create không retry mù"); status update 1–20 id/call.
- **Code 20001 (thành công một phần)** trên status update: id TikTok trả trong `data.<cấp>_ids` là id đã đổi; phần còn lại của lô → cảnh báo, **không** ghi vào `changes`. Không có danh sách id → giữ cả lô + cảnh báo kiểm tra lại (hình dạng response **UNVERIFIED**). Xoá 1 đối tượng mà TikTok báo không xoá được → lỗi.

### Trạng thái chuẩn hoá (`operation_status` + `secondary_status`)
| Điều kiện | NormalizedStatus |
|---|---|
| `DELETE` / secondary `*_DELETE` | deleted |
| secondary `*_DENY` (AUDIT_DENY, PARTIAL_AUDIT_DENY, REVIEW_DENY…), `REVIEW_DISAPPROVED`, `NOT_APPROVED` | rejected |
| `FROZEN` / `ACCOUNT_PUNISH` | disabled |
| `operation_status=DISABLE` hoặc secondary `*DISABLE` (cha đang tắt) | paused |
| `*_PARTIAL_AUDIT_NO_DELIVERY`, `*_AUDIT`, `*_REAUDIT`, `*_IN_REVIEW` | pending_review |
| `*_UNAVAILABLE`, `*CONTRACT_PENDING` | disabled (không bao giờ "active") |
| `*TIME_DONE`, `*_STATUS_DONE` | archived |
| `ENABLE` | active |

Summary còn có `extra.configuredStatus` = `ACTIVE|PAUSED|DELETED` (từ `operation_status`) — trạng thái chủ TK đã bật/tắt, kể cả khi cha đang tắt (dùng cho kiểm tra lịch ngân sách trọn đời ở mcp-core).

### Campaign
- `GET /campaign/get/` — `filtering{campaign_ids(≤100), primary_status, objective_type, campaign_automation_type, ...}`, `fields`, `page_size ≤1000`, `exclude_field_types_in_response=["NULL_FIELD"]`.
- `POST /campaign/create/` — `advertiser_id, campaign_name (≤512, không emoji), objective_type` ∈ `REACH|TRAFFIC|VIDEO_VIEWS|ENGAGEMENT|APP_PROMOTION|LEAD_GENERATION|WEB_CONVERSIONS|PRODUCT_SALES|RF_REACH` (Sales = `virtual_objective_type:"SALES"` + `sales_destination`), `budget_optimize_on` (CBO), `budget_mode` (CBO: `BUDGET_MODE_TOTAL|BUDGET_MODE_DYNAMIC_DAILY_BUDGET|BUDGET_MODE_DAY`; non-CBO: `BUDGET_MODE_INFINITE|TOTAL|DAY`, **DAY không dùng cho REACH/VIDEO_VIEWS/ENGAGEMENT**), `budget`, `operation_status:"DISABLE"`, `request_id`.
- `POST /campaign/update/` — chỉ sửa `campaign_name, budget, special_industries, po_number`. Objective & budget_mode bất biến. Ngân sách mới ≥ 105% số đã chi (doc Budget 1739381246298114). **Doc không nói thời điểm hiệu lực của budget chiến dịch** [L] → adapter `effectiveAt=null` + cảnh báo; áp khung khoá 23:55–00:00 giống ad group (cho nhất quán). doc_id trang "Update a campaign": chưa xác định [L].
- `POST /campaign/status/update/` — `{advertiser_id, campaign_ids[1-20], operation_status: ENABLE|DISABLE|DELETE}`. DELETE không hoàn tác.

### Ad group
- `GET /adgroup/get/` (filter tương tự).
- `POST /adgroup/create/` — bắt buộc: `advertiser_id, campaign_id, adgroup_name, budget_mode, budget` (bỏ qua nếu CBO), `schedule_type` (`SCHEDULE_FROM_NOW|SCHEDULE_START_END`; lifetime cần START_END), `schedule_start_time` ("YYYY-MM-DD HH:MM:SS" **UTC+0**, không quá 12h trong quá khứ), `optimization_goal, billing_event, pacing`; thường cần `promotion_type` (WEBSITE…), `placement_type` + `placements[]` (bất biến sau tạo; hợp lệ: `PLACEMENT_TIKTOK|PLACEMENT_PANGLE|PLACEMENT_GLOBAL_APP_BUNDLE`), `location_ids` (**ID số**: VN=`"1562822"`, US=`"6252001"`; tra `/tool/region/` hoặc `/tool/targeting/search/`), `pixel_id + optimization_event` cho CONVERT/VALUE, `bid_type` (`BID_TYPE_NO_BID` | `BID_TYPE_CUSTOM` + `bid_price`/`conversion_bid_price`). Targeting: `gender, age_groups (AGE_18_24..), languages, audience_ids, interest_category_ids, ...`.
  - **Chế độ ngân sách cấp nhóm** (non-CBO): `BUDGET_MODE_DAY`, **`BUDGET_MODE_DYNAMIC_DAILY_BUDGET`** (ngân sách ngày linh hoạt), `BUDGET_MODE_TOTAL`. Chiến dịch CBO cũng nhận `BUDGET_MODE_DYNAMIC_DAILY_BUDGET`.
  - **Ngân sách ngày linh hoạt chi được tới 125%/ngày** [H] (doc Budget 1739381246298114: "Daily costs will not exceed 125% of the average daily budget. Weekly costs will not exceed the average daily budget * 7"). → Adapter đánh dấu `Budget.dynamic = true` (`toBudget`) và `moneyOf` của `tiktok_create_campaign`/`tiktok_create_adgroup` khai báo `dynamic: true`; guardrail so **số tiền × 1,25** với trần ngày (từ chối khi > trần ÷ 1,25; so bằng micros nguyên) ở tạo mới, `ads_update_budget` và `ads_set_status` → active (cả ngân sách CBO cấp chiến dịch). Preview/lỗi có giải thích tiếng Việt. (Sửa 2026-10-08 — trước đây tính như ngân sách ngày thường: trần 1.000.000 VND vẫn có thể chi 1.250.000/ngày.)
  - Chiến dịch non-CBO đặt `BUDGET_MODE_DAY` → **không nhận nhóm `BUDGET_MODE_TOTAL`**; chiến dịch non-CBO REACH/VIDEO_VIEWS/ENGAGEMENT còn để `BUDGET_MODE_DAY` → adapter chặn tạo thêm nhóm.
  - `SCHEDULE_FROM_NOW` (không ngày kết thúc) **chỉ đi với chế độ ngân sách ngày** (của nhóm, hoặc của chiến dịch khi CBO).
  - Số tiền: đơn vị chính, làm tròn theo độ chính xác TikTok — USD tối đa 2 chữ số thập phân, JPY số nguyên; VND **UNVERIFIED** → adapter làm tròn số nguyên (an toàn) qua `roundMoney`.

| optimization_goal | billing_event |
|---|---|
| CLICK, PAGE_VISIT | CPC |
| SHOW, REACH | CPM |
| ENGAGED_VIEW, ENGAGED_VIEW_FIFTEEN | CPV |
| CONVERT, INSTALL, IN_APP_EVENT, TRAFFIC_LANDING_PAGE_VIEW, LEAD_GENERATION, CONVERSATION, FOLLOWERS, VALUE… | OCPM |

- **`POST /adgroup/update/` là THAY THẾ TOÀN BỘ, không incremental** (doc 1739586761631745: "Even if you only want to update one data field, you need to specify all required data fields") → adapter phải GET → merge thay đổi → bỏ field read-only → gửi đủ. Không đổi được placement.
  - **`schedule_start_time`: "cannot be updated if the `schedule_start_time` for the ad group is earlier than the current time"** [H], và `schedule_start_time` **bắt buộc đi cùng `schedule_type`** [H] → nhóm đã bắt đầu, không đổi lịch: **bỏ cả `schedule_start_time`, `schedule_type`, `schedule_end_time`** khỏi body (TikTok giữ nguyên lịch). Từ chối yêu cầu đổi start time của nhóm đã chạy. Start ≥ now−12h, ≤ 2028-01-01; end ≤ 2038-01-01 (UTC+0).
  - Đổi **ngày kết thúc** của nhóm đã chạy: gửi `schedule_type` + `schedule_end_time` mới **kèm `schedule_start_time` cũ không đổi** — **UNVERIFIED** (giả định TikTok chấp nhận vì giá trị start không thay đổi; nếu bị từ chối, lỗi được trả nguyên cho người dùng).
  - **`budget` không sửa được khi chiến dịch bật CBO (`budget_optimize_on`)** [H] (GET trả budget 0.0) → không gửi `budget`/`bid_type` cho nhóm CBO.
  - **Chỉ gửi `budget` khi người gọi đổi ngân sách** (từ 2026-10-08): doc không đánh dấu `budget` là bắt buộc, còn ngân sách gửi lại bị kiểm tra "at least 105% of the current spend" → sửa tên/targeting/ngày kết thúc cuối ngày có thể bị từ chối. Bỏ `budget` có được chấp nhận ở mọi trường hợp không, và có huỷ `scheduled_budget` không: **UNVERIFIED** — nếu TikTok từ chối vì ngân sách, lỗi được đổi thành thông báo tiếng Việt rõ ràng (gợi ý thử lại đầu ngày / dùng `ads_update_budget`).
- `POST /adgroup/status/update/` — `adgroup_ids[1-20]`, `allow_partial_success`.
- `POST /adgroup/budget/update/` (doc 1739591133130817) — `budget:[{adgroup_id,budget}]` (lifetime, hiệu lực ngay) / `scheduled_budget:[...]` (daily, **hiệu lực 00:00 hôm sau** theo giờ account) [H]. **Không đặt/sửa ngân sách trong khung khoá 23:55–00:00 giờ account** [H]. Muốn đổi daily ngay → `/adgroup/update/` (full replacement) — **UNVERIFIED**, adapter không dùng. Tool phải báo rõ cho AI khi nào hiệu lực.

### Ad
- `GET /ad/get/` (filter `ad_ids ≤100`, `ad_ids_v2`, `modified_after`…).
- `POST /ad/create/` — `{advertiser_id, adgroup_id, creatives:[...]}` (≤20/call; ≤50 ad/ad group). Mỗi creative: `ad_name, ad_format (SINGLE_VIDEO|SINGLE_IMAGE|CAROUSEL_ADS), identity_type, identity_id, video_id | tiktok_item_id, image_ids` (ảnh cover **bắt buộc** cho video non-Spark), `ad_text, call_to_action (LEARN_MORE|SHOP_NOW|SIGN_UP|ORDER_NOW|CONTACT_US|...), landing_page_url, operation_status:"DISABLE"`.
- `POST /ad/update/` (doc 1739953405142018) — `patch_update:true` chỉ incremental cho `ad_name, identity_*, video_id, image_ids, music_id, tiktok_item_id, ad_text, ad_texts`; field khác (CTA, URL…) phải gửi **full creative**.
- `POST /ad/status/update/` — `ad_ids[1-20]`.

### Upgraded Smart+ (khi account được allowlist)
- `POST /smart_plus/campaign/create/` (`request_id` bắt buộc; objective chỉ `APP_PROMOTION|WEB_CONVERSIONS|LEAD_GENERATION`), `/smart_plus/adgroup/create/` (`targeting_spec`, `targeting_optimization_mode AUTOMATIC|MANUAL`), `/smart_plus/ad/create/` (`creative_list[{creative_info{...}}]`, `ad_text_list`, `call_to_action_list ≤3`, `landing_page_url_list`).
- Đổi URL đích ad Smart+ (`/smart_plus/ad/update/`): `landing_page_url_list` bị thay cả danh sách → adapter đọc danh sách hiện tại, **chỉ thay phần tử đầu** (giữ field khác + các URL còn lại), cảnh báo khi ad có nhiều URL.
- Trạng thái: `/smart_plus/campaign/status/update/` (`campaign_ids`), `/smart_plus/adgroup/status/update/` (`adgroup_ids`), `/smart_plus/ad/status/update/` với **`smart_plus_ad_ids`** (không phải `ad_ids`) (doc 1853452461203458).
- Ngân sách: `/smart_plus/adgroup/budget/update/` và budget campaign Smart+ **hiệu lực ngay** (không có scheduled budget). Đọc ngân sách hiện tại từ **`current_budget`**.

### File, identity, pixel
- `POST /file/image/ad/upload/` → `image_id` (+ `image_url` sống 1 giờ). `file_name` 1–100 ký tự, trùng trong account → **40911** (áp dụng cả ảnh) → adapter tự thêm `_<yyyymmddhhmmss>_<rand>` và thử lại 1 lần.
  - **Rà 2026-10-09 [H]** (doc 1739067433456642, https://business-api.tiktok.com/portal/docs?id=1739067433456642): `upload_type` `UPLOAD_BY_FILE` (mặc định) | `UPLOAD_BY_URL` | `UPLOAD_BY_FILE_ID`. **UPLOAD_BY_FILE** = `multipart/form-data`: `advertiser_id`, `upload_type`, `file_name`, `image_file` (file), `image_signature` (**MD5** của file — adapter gửi hex chữ thường). URL/FILE_ID = `application/json`. Khuyến nghị: ≤ **50 MB**, **JPG/JPEG/PNG** (không WebP/GIF), tổng pixel ≤ **3.686.400** (1440×2560). **Request timeout phía TikTok 10 s** cho endpoint này ("transmission speed depends on network bandwidth") → ảnh lớn có thể lỗi khi mạng chậm.
  - Adapter: có `MediaUploadRequest.bytes` → UPLOAD_BY_FILE (không bao giờ tải URL; kiểm tra magic JPG/PNG, ≤ 50 MB = `TIKTOK_IMAGE_MAX_BYTES`); không có bytes → UPLOAD_BY_URL như cũ. Không retry mù sau timeout/5xx (ảnh có thể đã lưu).
- `POST /file/video/ad/upload/` (`UPLOAD_BY_URL` + `video_url`; `file_name` **duy nhất trong account** — lỗi 40911) → poll `/file/video/ad/info/` (40901 = đang transcode) trong ngân sách `MediaUploadRequest.maxWaitMs` (mặc định 60 s; hết giờ → trả `video_id` + `processing: true`).
  - **Rà 2026-10-09 [H]** (doc 1737587322856449, https://business-api.tiktok.com/portal/docs?id=1737587322856449) — ràng buộc `video_url` (dùng cho link tạm relay, doc 15 §8): (1) "File size: **better within 10MB**" (chỉ là khuyến nghị; `video_file` khuyến nghị ≤ 500 MB); (2) TikTok **kiểm tra `Content-Type` của response** — `text/*` (text/html, text/plain) bị coi là không hợp lệ; nếu response có `Content-MD5` TikTok sẽ **đối chiếu dữ liệu**; (3) URL phải là URL hợp lệ đã encode (khoảng trắng → `%20`); (4) tỉ lệ/định dạng/độ phân giải/bitrate như `video_file`: tỉ lệ 9:16, 16:9, 1:1; `.mp4 .mov .mpeg .avi`; ≥ 540×960 / 640×640 / 960×540 (guide 1738963828459521). Tên mặc định = phần tên file trong path URL (adapter luôn gửi `file_name` nên path không bắt buộc có đuôi). **Request timeout 10 s** (TikTok tải URL đồng bộ hay bất đồng bộ: **UNVERIFIED**). Upload lại cùng video bằng FILE/URL luôn sinh `video_id` **mới**. Response `data` là **mảng 1 phần tử**; có thể chỉ có `video_id` (chờ 30 s–5 phút rồi `/file/video/ad/search/`).
  - **UNVERIFIED** (doc không nói): có theo redirect không, có dùng `Range`/HEAD không, số lần tải lại, timeout tải, IP/user-agent của crawler → relay nên trả 200 trực tiếp (không redirect), `Content-Type: video/mp4|video/quicktime`, `Content-Length`, hỗ trợ cả GET thường lẫn Range, **không** gửi `Content-MD5` trừ khi chắc đúng.
  - **`deadlineAt`** (`src/server/providers/media-deadline.ts`): timeout lệnh upload (ảnh URL/FILE 60 s, video URL 120 s) = min(own, deadlineAt − now − 1 s); còn < 2 s → không gửi; lệnh upload bị timeout → **không retry**, lỗi "có thể đã tạo trên nền tảng - kiểm tra thư viện media". Poll `/file/video/ad/info/` dừng ở `deadlineAt` (thắng `maxWaitMs`); 1 lần gọi info quá chậm → trả `video_id` + `processing: true`.
  - **Upload theo phần — rà 2026-10-09 [H]** (job nền cho video lớn, `uploadTikTokVideoChunked` = `AdsProvider.uploadVideoChunked`). Nguồn: guide 1738963828459521 (https://business-api.tiktok.com/portal/docs?id=1738963828459521), `/file/start/upload/` 1737721229896705, `/file/transfer/upload/` 1737721489945601, `/file/finish/upload/` 1737721642924033, video upload 1737587322856449 (lấy qua `gateway/api/doc/client/node/get/v2`):
    - Kho tạm: file sống **24 giờ**; file > 20 MB chia phần: "The chunk size for the chunks excluding the last chunk is fixed at **20MB**. The size of the last chunk can be between **5MB and 25 MB**".
    - `POST /file/start/upload/` JSON {`advertiser_id`, `size` (byte), `content_type` = `video` (enum image/video/music), `name` ≤ 100 ký tự} → `upload_id`, `file_name`, `start_offset`, `end_offset` (phần đầu). Ví dụ response trong doc dùng khoá **PascalCase** (`UploadId`, `StartOffset`…) trái với bảng field snake_case → adapter đọc cả hai.
    - `POST /file/transfer/upload/` **multipart/form-data** {`advertiser_id`, `upload_id`, `signature` = **MD5 của phần** (checksum), `start_offset`, `file` (phần file)} → `start_offset`/`end_offset` của phần **tiếp theo**; `start_offset == end_offset` → đã gửi hết → gọi finish. Không có chữ ký cho cả file.
    - `POST /file/finish/upload/` JSON {`advertiser_id`, `upload_id`} → `file_id` (hiệu lực 24 giờ), `file_name`, `create_time`, `size`.
    - `POST /file/video/ad/upload/` JSON {`advertiser_id`, `upload_type`: `UPLOAD_BY_FILE_ID`, `file_id`, `file_name` duy nhất} — mỗi lần gọi (FILE/URL/FILE_ID) sinh `video_id` **mới** → không retry sau timeout. Lỗi liên quan: 40900 MD5 không khớp, 40905 file không tồn tại, 40907 file quá lớn, 40910 file hết hạn, 40911 trùng tên.
    - Adapter: theo đúng offset TikTok trả (kiểm tra 0 ≤ start < end ≤ size, mỗi phần ≤ 32 MB), đọc nguồn bằng `readChunk` (1 phần trong RAM), timeout 180 s/phần, `onProgress(start_offset)`; lỗi mạng/timeout/5xxxx hoặc 40900 → gửi lại **chính phần đó** ≤ 2 lần; lỗi khác → ném lỗi (không khởi động lại cả upload); finish lỗi tạm thời → gửi lại ≤ 2 lần; FILE_ID trùng tên (40911) → đổi tên gửi lại 1 lần; poll info tới `deadlineAt`.
    - **UNVERIFIED**: gửi lại cùng `start_offset` sau timeout (phần trước có thể đã tới) — TikTok có nhận ghi đè không; finish lặp lại sau timeout; `name` ở start có phải duy nhất không (adapter luôn gửi tên duy nhất); `UPLOAD_BY_FILE_ID` có bị giới hạn timeout 10 s như UPLOAD_BY_FILE không; rate limit riêng của các endpoint `/file/*/upload/`.
  - Mã lỗi file (Return codes 1737172488964097, 2026-10-09): 40907 file quá lớn · 40910 file hết hạn · 40912 URL ảnh không dùng được · 40915 file không đúng quy cách.
- `GET /identity/get/` (page_size ≤100), `GET /pixel/list/` (page_size ≤20), `GET /tool/region/`, `POST /tool/targeting/search/`.
  - Kiểm tra `identity_id` của `tiktok_create_ads` nằm trong `/identity/get/`: **chưa làm (adapter không kiểm tra)** — `/identity/get/` có thể chỉ trả identity theo `identity_type` được lọc (UNVERIFIED), kiểm tra sai sẽ chặn nhầm Spark Ads. AI được hướng dẫn lấy `identity_id` từ `ads_lookup kind=identities`; TikTok tự từ chối identity sai.

## 5. Sao chép
- Endpoint chính thức `POST /campaign/copy/task/create/` (doc 1788434394151938) → poll `GET /campaign/copy/task/check/` (doc 1788434463507458); hướng dẫn "Copy a Manual Campaign" 1788434533212162. Chỉ cho **campaign**, **cần allowlist**, cùng advertiser, 1–20 ad group, ≤50 ad/ad group. **Không có endpoint copy ad group / ad.**
  - Rate: task create **1 QPS / 30 QPM** per app (không tính rate chung); task check 2 QPS / 60 QPM [H].
  - **Trạng thái mặc định**: campaign `operation_status` mặc định `DISABLE`, nhưng **ad group và ad mặc định `ENABLE`** [H]. `deep_copy_mode=DEFAULT` bỏ qua `adgroup_list` → không đặt được trạng thái con. Adapter dùng `deep_copy_mode=CUSTOM` + `adgroup_list[{adgroup_id, adgroup_name, operation_status:"DISABLE", ad_list[{ad_id, ad_name, operation_status:"DISABLE"}]}]` liệt kê mọi ad group/ad chưa xoá, rồi vẫn gọi status DISABLE cho **mọi** ad group mà task trả về (kể cả nhóm không ánh xạ được); thất bại / thành công một phần → cảnh báo to.
  - **Đặt tên trong CUSTOM** [H]: mỗi phần tử `adgroup_list` nhận lịch/ngân sách/tên riêng (`adgroup_name`, `schedule_*`, `budget`); `ad_list[].ad_name` mặc định là `"COPIED_{{original_name}}_{{original_id}}"`. Kết quả task check **không có id nguồn** → adapter gửi tên gốc cho từng nhóm/ad rồi ánh xạ theo tên; dự phòng theo hậu tố `_<id nguồn>` (tên mặc định); **không** đoán theo vị trí — không khớp → mapping báo "Không ánh xạ được" + cảnh báo kiểm tra.
  - Kết quả create: `task_id` ("" khi lỗi) + `adgroup_error_list`. Check: `task_status` ∈ `RUNNING|SUCCESS|FAILURE`; `task_result.campaign_id`, `adgroup_result_list[].adgroup_id/ad_result_list[]`; lỗi `campaign_error_infos`, `adgroup_error_list`, `ad_error_list`, `smart_creative_error_list` (doc ghi string array — adapter vẫn JSON.stringify nếu gặp object).
  - Poll timeout/lỗi mạng: luôn trả `task_id` cho người dùng; KHÔNG chạy lại sao chép (tránh trùng).
  - Copy task cho chiến dịch Manual sau 2026-12-31: **UNVERIFIED**.
- Adapter: thử copy task → nếu 40118 (chưa allowlist) / 40001 → **DIY deep copy**:
  1. Đọc cây: `/campaign/get/` → `/adgroup/get/` (`STATUS_NOT_DELETE`) → `/ad/get/`, `page_size=1000`, `exclude_field_types_in_response=["NULL_FIELD"]`.
  2. Kiểm tra `campaign_automation_type` (UPGRADED_SMART_PLUS → dùng `/smart_plus/*`; SMART_PLUS legacy → từ chối).
  3. Bỏ field read-only/output (id, create_time, modify_time, secondary_status, campaign_automation_type, split_test_*, schedule_infos, ad_id_v2, is_aco, …; bỏ `placements` nếu placement_type AUTOMATIC).
  4. Tạo campaign `DISABLE` + `request_id` mới + tên mới.
  5. Tạo ad group với **lịch mới** (start không quá 12h trong quá khứ; lifetime cần end mới); khi phải dời start lên hiện tại, **end dời cùng khoảng** (giữ nguyên số ngày chạy, để ngân sách trọn đời không bị dồn vào ít ngày hơn); CBO giữ `bid_type` nhất quán. Campaign/ad group tạo theo quy tắc "Create không retry mù" (§6).
  6. Tạo ad theo batch ≤20 creative/call (rate `/ad/create/` 5 QPS). `/ad/create/` **không có `request_id`** → không retry; timeout/5xx → tra `/ad/get/` theo tên trong ad group (tạo sau thời điểm gọi) trước khi báo lỗi; lỗi luôn `retryable=false` + gợi ý kiểm tra trước khi thử lại.
  7. Trả bảng map id + lỗi (lỗi không phải ProviderError → "lỗi không xác định", không lộ chi tiết nội bộ); lỗi giữa chừng → gợi ý dọn bản nháp.
- Không copy chéo account khi chưa share asset (`POST /creative/asset/share/`) hoặc re-upload; ad Custom Identity non-Spark không tạo lại được.
- **Sau 2026-12-31 DIY copy manual campaign sẽ hỏng** (vì `/campaign/create/` bị khoá).

## 6. Rate limit & lỗi
Envelope: `{"code":0,"message":"OK","request_id":"..","data":{..}}`, gần như luôn HTTP 200 → **luôn kiểm tra `code`** (0 OK, 20001 partial success).

Rate limit **theo developer app** (mỗi endpoint đếm riêng): Basic 10 QPS / 600 QPM / 864k QPD (Advanced 20/1200, Premium 30/1800, Ultimate 50/3000). Riêng: `/ad/create/` 5 QPS/150 QPM; `/report/task/create/` 2/60 (+ ≤500 task/ad account/giờ); copy task create 1 QPS/30 QPM, copy task check 2/60. Sandbox: 1 QPS / 30 QPM / 1.000 QPD.

| Code | Ý nghĩa | Xử lý |
|---|---|---|
| 40000, 40002, 40009, 40010, 40014, 40065, 40700, 41002 | Tham số sai | không retry, trả message |
| 40006, 40051 | Endpoint/version không khả dụng | `unsupported`, gợi ý kiểm tra `TIKTOK_API_VERSION` |
| 40011 | Danh sách id quá dài / sai | `invalid_request`, gợi ý **chia nhỏ danh sách id** |
| 40001, 40125 | Thiếu quyền/scope | hướng dẫn cấp lại scope |
| 40102/40104/40105/40106 | Token hỏng | đánh dấu connection invalid |
| 40101, 40110, 40113 | Sai app_id/secret/auth_code | sửa credential |
| 40007 | Object không tồn tại | — |
| 40100, 40016 | Throttle app (QPM) | nghỉ **5 phút** endpoint đó; vượt QPD → đến 00:00 UTC |
| 40133 | Throttle theo advertiser | backoff |
| 40118 | Chưa allowlist | fallback (vd DIY copy) |
| 40202 | Xung đột ghi | retry |
| 40901 | Video đang transcode | retry sau |
| 40911 | Trùng file_name (video **và ảnh**) | đổi tên |
| 50000, 50002, 51xxx, 60001 | Lỗi server/bảo trì | backoff có jitter |
| HTTP 308 không có envelope | thiếu dấu `/` cuối URL | adapter luôn thêm `/` |

**Create không retry mù** (sửa 2026-10-08; `client.ts` `tiktokCreateRetryDecision`, `create-checked.ts`): `request_id` chỉ chống trùng **10 giây** → `/campaign/create/`, `/adgroup/create/`, `/campaign/copy/task/create/` chỉ retry khi chắc chắn TikTok **chưa thực hiện** (throttle **40100 / 40133**) **và** lần gửi lại nằm trong ~8 giây kể từ lần đầu (cùng `request_id`). Timeout / HTTP 5xx / 50000 / 50002 / lỗi mạng / **40050** (trùng `request_id`, hình dạng response UNVERIFIED) → **không** gửi lại mà tra lại đối tượng: campaign qua `/campaign/get/` lọc `campaign_name` (field lọc **UNVERIFIED**; bị từ chối → đọc danh sách không lọc) + so khớp tên chính xác + `create_time` ≥ lúc gọi − 10 phút; ad group qua `/adgroup/get/` `campaign_ids=[cha]` + tên + `create_time`. Tìm thấy → dùng id + cảnh báo; không thấy/không tra được → lỗi `retryable=false` + gợi ý "kiểm tra trong TikTok Ads Manager trước khi thử lại". Copy task kết quả không rõ → không fallback DIY, lỗi `retryable=false`. `/ad/create/` (không có `request_id`) không bao giờ retry (§5 bước 6). Token bucket phía client: 10 QPS mặc định, 5 cho `/ad/create/`, 1 cho copy & async report.

Phân trang: `page`/`page_size` → `data.page_info{page,page_size,total_number,total_page}`.

### Env adapter đọc
| Biến | Mặc định | Ghi chú |
|---|---|---|
| `TIKTOK_API_VERSION` | `v1.3` | |
| `TIKTOK_BASE_URL` | `https://business-api.tiktok.com/open_api` | sandbox `https://sandbox-ads.tiktok.com/open_api`; chỉ `https://`, sai → lỗi `unsupported`, không gửi request |

## 7. Map sang tool MCP
| Tool | TikTok adapter gọi |
|---|---|
| `ads_list_accounts` | cache từ `/oauth2/advertiser/get/` + `/advertiser/info/` |
| `ads_get_report` | `/report/integrated/get/` (tự chia cửa sổ ≤30 ngày, ID batch ≤100, page 1000, kèm attribute name) |
| `ads_list_objects` / `ads_get_object` | `/campaign|adgroup|ad/get/` (+ `/smart_plus/*/get/`) |
| `ads_set_status` | `/{level}/status/update/` hoặc `/smart_plus/*/status/update/` theo `campaign_automation_type` |
| `ads_update_budget` | campaign `/campaign/update/`; ad group `/adgroup/budget/update/` (báo hiệu lực) |
| `ads_update_object` | campaign update (tên); adgroup GET→merge→`/adgroup/update/`; ad `patch_update` |
| `ads_copy_object` | copy task (nếu allowlist) → fallback DIY §5 |
| `ads_delete_object` | status `DELETE` |
| `ads_upload_media` | `/file/image/ad/upload/` (UPLOAD_BY_FILE multipart khi có bytes — Drive; còn lại UPLOAD_BY_URL), `/file/video/ad/upload/` (UPLOAD_BY_URL, gồm link tạm `/dl/…`); video lớn (job nền): `/file/start|transfer|finish/upload/` → UPLOAD_BY_FILE_ID |
| `ads_lookup` | `/identity/get/`, `/pixel/list/`, `/tool/region/`, `/tool/targeting/search/` |
| `tiktok_create_campaign` / `tiktok_create_adgroup` / `tiktok_create_ads` | §4, DISABLE + `request_id`, cảnh báo mốc 2026-12-31 |

## Nguồn (doc_id trên `https://business-api.tiktok.com/portal/docs?id=`)
Versioning 1740029169927169 · What's New 1740029165513730 · Rate limits 1740029171730433 · Return codes 1737172488964097 · Authorization 1738373141733378 · Obtain token 1739965703387137 · Permission scope 1753986142651394 · Advertiser info 1739593083610113 · Sync report 1740302848100353 · Metrics 1751443967255553 · Async report 1740302766489602 · Campaign create 1739318962329602 · Adgroup create 1739499616346114 · Adgroup update 1739586761631745 · Adgroup budget update 1739591133130817 · Budget 1739381246298114 · Ad create 1739953377508354 · Ad update 1739953405142018 · Copy task create 1788434394151938 · Copy task check 1788434463507458 · Upgraded Smart+ 1853452461203458 · Smart+ compatibility 1854112742370306 · Copy manual campaign 1788434533212162 · Image upload 1739067433456642 · Video upload 1737587322856449 · Upload videos/images guide 1738963828459521 · Files (chunk upload) 1737719988918274 · Official MCP 1869388085523458
