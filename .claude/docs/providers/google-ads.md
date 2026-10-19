# Google Ads API — tài liệu tham chiếu (gồm YouTube Ads)

> Research ngày 2026-10-02 từ developers.google.com/google-ads/api (+ probe endpoint thật); **rà lại với doc chính thức ngày 2026-10-08** (developer token, ngôn ngữ Search, YouTube/Video/Demand Gen, passkey, lỗi mới). Toàn bộ 151 field GAQL adapter chọn trước đây đều có trong v25. **[H]** chính thức/probe · **[M]** gián tiếp · **[L]** phải test · **UNVERIFIED** = chưa kiểm chứng được, adapter xử lý an toàn (ghi rõ cách).
> Skill `anthropic-skills:google-ads-ga4` đã LỖI THỜI (nói v18, dùng OOB redirect đã chết) — không tin skill đó, tin file này + doc chính thức.

## 1. Phiên bản
| Version | Phát hành | Sunset |
|---|---|---|
| v22 | 2025-10-15 | 10/2026 (dự kiến) |
| v23.x | 2026-01..03 | 02/2027 |
| v24.x | 2026-04..06 | 05–06/2027 |
| **v25** (dùng; 25.1 ngày 2026-08-19, 25.2 ngày 2026-09-23) | 2026-07-22 | 08/2027 |
| v26 | sắp phát hành (10/2026) | — |

- Major mỗi 3–4 tháng, minor ~hàng tháng (không breaking), sunset ~1 năm. Pin `GOOGLE_ADS_API_VERSION=v25` (mặc định trong code; đọc env); nâng cấp = đổi URL + đọc breaking changes. Chưa chuyển v26 khi chưa phát hành.
- Base REST: `https://googleads.googleapis.com/v25/`. Discovery doc (sinh type TS): `https://googleads.googleapis.com/$discovery/rest?version=v25`.

### 1.1 Thay đổi quan trọng
1. **Developer token đã sunset 2026-09-09** [H]: header `developer-token` "optional and ignored", Google **sẽ từ chối developer token ở một major version sau** → adapter **KHÔNG BAO GIỜ gửi header `developer-token`** (kể cả khi credential cũ còn lưu giá trị). Access level gắn vào **Google Cloud project** sở hữu OAuth client / service account.
2. **Service account dùng trực tiếp, không cần domain-wide delegation** [H]: thêm email SA làm user trong Google Ads (tốt nhất ở MCC), JWT không có `sub`. **Khuyến nghị mặc định.**
3. **Mọi campaign mới bắt buộc `contains_eu_political_advertising`** (`CONTAINS_EU_POLITICAL_ADVERTISING|DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING`), thiếu → `FieldError.REQUIRED`. Từ 2026-04-01 account có campaign chưa khai báo → mọi mutate campaign bị chặn `MutateError.EU_POLITICAL_ADVERTISING_DECLARATION_REQUIRED` (mutate chỉ set field này vẫn được) → tool "khai báo hàng loạt". Có thêm **khai báo cấp tài khoản** trong giao diện Google Ads; thiếu → `CriterionError.MISSING_EU_POLITICAL_ADVERTISING_SELF_DECLARATION`. Trạng thái đọc được qua `customer.contains_eu_political_advertising` (adapter chưa đọc field này trong luồng khám phá account — tránh làm hỏng truy vấn cốt lõi; chỉ nêu trong gợi ý lỗi).
4. v23: `Campaign.start_date/end_date` → **`start_date_time/end_date_time`** dạng `"yyyy-MM-dd HH:mm:ss"` (giờ account) — áp dụng cả lịch của ngân sách trọn đời (CUSTOM_PERIOD) chiến dịch Demand Gen.
5. v22: `metrics.video_views` bị bỏ → `metrics.video_trueview_views`, `video_trueview_view_rate`, `trueview_average_cpv`.
6. **Từ 2026-09-30 chiến dịch Search không còn nhắm mục tiêu ngôn ngữ thủ công** [H]: tạo campaign_criterion LANGUAGE trên Search → `ContextError.OPERATION_NOT_PERMITTED_FOR_CONTEXT`. Adapter: bỏ `language_ids` khỏi `google_ads_create_search_campaign`; sao chép Search bỏ qua tiêu chí LANGUAGE (cảnh báo, không tính là thiếu targeting).
7. **Demand Gen**: ngân sách tối thiểu **5 USD/ngày** (từ 2026-04-01) → `CampaignBudgetError.BUDGET_BELOW_DAILY_MINIMUM`. Mức quy đổi cho tiền tệ khác **UNVERIFIED** → adapter chỉ cảnh báo, không chặn.
8. **Smart campaign**: ngừng tạo từ 2026-09-23 (đọc/báo cáo vẫn được).
9. `DURING` chỉ nhận: TODAY, YESTERDAY, LAST_7_DAYS, LAST_14_DAYS, LAST_30_DAYS, LAST_BUSINESS_WEEK, THIS_MONTH, LAST_MONTH, THIS_WEEK_SUN_TODAY, THIS_WEEK_MON_TODAY, LAST_WEEK_SUN_SAT, LAST_WEEK_MON_SUN. Quý/năm → tự tính `BETWEEN`.
10. TARGET_CPA / TARGET_ROAS chuẩn chỉ còn dạng portfolio; campaign đơn dùng `maximizeConversions.targetCpaMicros` / `maximizeConversionValue.targetRoas`. Enhanced CPC deprecated.
11. Search page cố định **10.000 dòng**; gửi `pageSize` → lỗi `PAGE_SIZE_NOT_SUPPORTED`.
12. v23+: không share 1 ad cho nhiều ad group (`AD_SHARING_NOT_ALLOWED`) → copy phải tạo ad mới.
13. Dữ liệu theo ngày/tuần/giờ chỉ giữ **37 tháng** (từ 2026-06-01).
14. Đăng nhập: tạo refresh token mới cần 2SV; người dùng Google Ads API bị "enforce" phải dùng **passkey** (triển khai dần từ 2026-08-05; **TOTP/SMS không được chấp nhận**; passkey mới có thể cần tới **7 ngày** mới dùng được).
15. Google có MCP chính thức (Python, **chỉ đọc**) — tool ghi của chúng ta là mới.

## 2. Credential (không login trong app)
### Access level (theo Cloud project của OAuth client / service account)
| Level | Gọi được | Ops/ngày | Cách có |
|---|---|---|---|
| Test | chỉ test account | 15.000 | tự có khi bật API |
| **Explorer** | test + production | **2.880** production | Cloud Console → Google Ads API → Overview → "Upgrade access level" (thường auto duyệt) |
| Basic | test + production | 15.000 | cần brand verification (consent screen External + In production + Verify Branding) |
| Standard | | không giới hạn | audit thủ công ~10 ngày |

- "Ngày" của hạn mức = **24 giờ trượt** (không reset lúc nửa đêm). 1 call `search`/`searchStream` = 1 op; page tiếp theo miễn phí; mỗi mutate operation = 1 op; request lỗi vẫn tính. Explorer chặn: tạo account, quản lý user, keyword planner, reach planning, billing (không cần cho app này).
- Project dùng **billing dùng thử (free trial)** bị từ chối nâng Explorer/Basic. Project được nâng cấp sau 2026-09-09 mà vẫn không được duyệt → dùng **Cloud project mới** (theo hướng dẫn Google; chi tiết điều kiện **UNVERIFIED**).

### Cách A — Service account (khuyến nghị mặc định)
1. Tạo/chọn Cloud project → bật Google Ads API → xin Explorer.
2. IAM → Service Accounts → tạo SA → tải **JSON key**.
3. Google Ads (ưu tiên **MCC**) → Admin → Access and security → Users → "+" → dán email SA → quyền **Standard** (hoặc Read only nếu chỉ báo cáo). **1 email tối đa 20 account** → thêm ở MCC rồi đặt `login_customer_id` = MCC.
4. Lấy access token (không cần thư viện):
   JWT RS256 claims `iss=client_email, scope=https://www.googleapis.com/auth/adwords, aud=https://oauth2.googleapis.com/token, iat, exp≤1h` (**không có `sub`**) → `POST https://oauth2.googleapis.com/token` `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<jwt>`.
- Org Cloud tạo sau 2024-05-03 mặc định chặn tạo SA key (`iam.managed.disableServiceAccountKeyCreation`) → dùng project cá nhân hoặc Cách B.
- SA không bị passkey / bẫy 7 ngày / hết hạn 6 tháng → lý do khuyến nghị.

### Cách B — OAuth client + refresh token
User tạo OAuth client trong **project của họ**, lấy refresh token bằng 1 trong 3 cách:
1. `gcloud auth application-default login --scopes=https://www.googleapis.com/auth/adwords,https://www.googleapis.com/auth/cloud-platform --client-id-file=credentials.json`
2. **CLI helper đóng gói sẵn trong repo**: `docker compose run --rm -p 127.0.0.1:8085:8085 web node dist/cli.mjs google:refresh-token --client-id … --host 0.0.0.0` qua SSH tunnel (secret nhập ẩn / `GOOGLE_ADS_CLIENT_SECRET`) (Desktop client, loopback `http://127.0.0.1:<port>`, `access_type=offline`, `prompt=consent`) → in refresh token.
3. OAuth Playground **với client của chính họ** (Web app, redirect `https://developers.google.com/oauthplayground`, tick "Use your own OAuth credentials"; dùng client mặc định của Playground thì token bị thu hồi sau 24h).
- **Bẫy 7 ngày**: consent screen External + trạng thái **Testing** → refresh token hết hạn sau 7 ngày → phải "Publish app" → **In production** và **Verify Branding** (xác minh thương hiệu — gỡ hẳn bẫy 7 ngày và là điều kiện của Basic) hoặc dùng Internal (Workspace).
- Người dùng bị enforce 2SV: đăng nhập bằng **passkey** (TOTP/SMS bị từ chối; `TWO_STEP_VERIFICATION_NOT_ENROLLED`).
- Token chết khi: 6 tháng không dùng, user thu hồi, >100 refresh token/client, chính sách Workspace. Token endpoint trả `{"error":"invalid_grant"}` → UI báo "dán lại refresh token".

### Header `login-customer-id`
= ID **MCC dùng để xác thực** (10 số, bỏ gạch). Bắt buộc khi truy cập account con qua MCC (thiếu → `USER_PERMISSION_DENIED`). `listAccessibleCustomers` bỏ qua header này.
Adapter lưu `connections.meta.login_customer_map` (customer → root đi qua). Thứ tự chọn header: **map → `login_customer_id` nhập tay → không gửi**. Account truy cập trực tiếp nằm ngoài cây MCC được map về chính nó → **không ép header MCC** cho account đó (sai MCC → `USER_PERMISSION_DENIED`/`CUSTOMER_NOT_FOUND`).

### Form kết nối
```
auth_type:            service_account | oauth_refresh_token   (bắt buộc)
service_account_json: textarea JSON key                        (khi SA)
client_id, client_secret, refresh_token                        (khi OAuth)
login_customer_id:    10 số, tự bỏ dấu gạch                    (tùy chọn, MCC)
customer_ids:         allow-list tùy chọn (mặc định tự khám phá)
```
`developer_token`: **không còn ô trong form**; parser vẫn đọc giá trị cũ đã lưu (để credential cũ re-validate được) nhưng **không bao giờ gửi**.
Khi lưu: mint access token → `GET /v25/customers:listAccessibleCustomers` → với mỗi manager chạy query `customer_client` → hiển thị cây account. Map lỗi → hướng dẫn:
- `CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION` / `DEVELOPER_TOKEN_NOT_APPROVED` / `ACTION_NOT_PERMITTED` → "xin Explorer cho Cloud project của OAuth client/SA; billing dùng thử bị từ chối; project nâng cấp sau 09/09/2026 không được duyệt → project mới"
- `invalid_grant` → token hết hạn / consent đang Testing (Publish + Verify Branding, passkey, khuyến nghị SA)
- `USER_PERMISSION_DENIED` → điền `login_customer_id`
- `SERVICE_DISABLED` → bật Google Ads API trong project
Cache access token tới ~5 phút trước khi hết hạn (in-memory).

## 3. REST
Headers: `Authorization: Bearer <access_token>`, `Content-Type: application/json`, `login-customer-id` (nếu qua MCC). **Không gửi `developer-token`.** Log header response `request-id`.

- `GET /v25/customers:listAccessibleCustomers` → `{"resourceNames":["customers/123..."]}` (chỉ account truy cập trực tiếp; SA thêm ở MCC → chỉ trả MCC).
- `POST /v25/customers/{cid}/googleAds:search` body `{"query":"..","pageToken":"..","searchSettings":{"returnTotalResultsCount":true,"returnSummaryRow":true}}` → `{results, nextPageToken, fieldMask, requestId}`. Dùng cho tool tương tác.
- `POST .../googleAds:searchStream` → **mảng JSON các batch**; dùng cho export lớn.
- JSON: GAQL snake_case, response lowerCamelCase; **int64 trả về là string** (`"costMicros":"1234000"`); giá trị 0/mặc định thường bị bỏ → mặc định 0.

Cây MCC (chạy trên MCC với login-customer-id = MCC):
```sql
SELECT customer_client.client_customer, customer_client.id, customer_client.descriptive_name,
       customer_client.currency_code, customer_client.time_zone, customer_client.manager,
       customer_client.status, customer_client.level, customer_client.test_account, customer_client.hidden
FROM customer_client WHERE customer_client.status = 'ENABLED'
```
Không query metrics trên manager account → fan-out từng account con.

## 4. GAQL báo cáo
Theo ngày cấp campaign:
```sql
SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.advertising_channel_sub_type,
  segments.date,
  metrics.impressions, metrics.clicks, metrics.ctr, metrics.average_cpc, metrics.average_cpm, metrics.cost_micros,
  metrics.conversions, metrics.conversions_value, metrics.cost_per_conversion,
  metrics.video_trueview_views, metrics.all_conversions, metrics.all_conversions_value,
  metrics.search_impression_share, metrics.search_budget_lost_impression_share
FROM campaign
WHERE segments.date BETWEEN '2026-09-01' AND '2026-09-30' AND campaign.status != 'REMOVED'
ORDER BY segments.date
```
- Ad group: `FROM ad_group` (`ad_group.id, name, status, type, cpc_bid_micros, campaign.id, campaign.advertising_channel_type`).
- Ad: `FROM ad_group_ad` (`ad_group_ad.ad.id, ad.type, ad.final_urls, ad.responsive_search_ad.headlines, ...descriptions, ad_group_ad.status, ad_group_ad.policy_summary.approval_status`) + `ad_group_ad.status != 'REMOVED'`.
- Keyword: `FROM keyword_view` (`ad_group_criterion.criterion_id, keyword.text, keyword.match_type, status, quality_info.quality_score`).
- Search terms: `FROM search_term_view`. PMax theo kênh: `segments.ad_network_type` (v23+).
- Mọi dòng (trừ account) có `extra.advertising_channel_type` (+ `advertising_channel_sub_type` ở cấp campaign) và `extra.youtube` (VIDEO/DEMAND_GEN).
- Ngày: `BETWEEN 'YYYY-MM-DD' AND '...'`; `segments.week/month/quarter` phải là ngày đầu kỳ.
- **Múi giờ**: mọi ngày theo `customer.time_zone`. **Không cộng chéo tiền tệ.**
- **Object REMOVED**: adapter mặc định lọc `<resource>.status != 'REMOVED'` → chi tiêu của object đã xoá không có trong báo cáo cấp campaign/ad group/ad/keyword (vẫn có ở cấp account) → luôn **cảnh báo** khi không bật `includeDeleted`.
- **Ngày-giờ (v23+)**: `campaign.start_date_time` / `end_date_time` dạng `"yyyy-MM-dd HH:mm:ss"` theo **múi giờ account** (không có offset; thay cho `start_date`/`end_date` cũ). `end_date_time` = `2037-12-30 …` nghĩa là **không có ngày kết thúc** [M].
- **Đơn vị**: `cost_micros, average_cpc, average_cpm, cost_per_conversion, amount_micros` là **micros** (÷1.000.000); `conversions_value` đã là tiền (double); `ctr`, impression share, `video_*_rate` là tỷ lệ 0–1 (IS <10% trả 0.0999). Adapter trả tỷ lệ video dạng **%**.
- Dòng toàn metric = 0 bị bỏ khi segment. Conversion còn thay đổi vài ngày → kéo lại N ngày gần nhất. Dữ liệu cũ hơn 37 tháng trống → cảnh báo.
- Kiểm tra field tương thích: `POST /v25/googleAdsFields:search` hoặc chạy với `validateOnly`.

### 4.1 YouTube trong báo cáo (preset `video`)
| Field (v25) | Trả ra | Ghi chú |
|---|---|---|
| `metrics.video_trueview_views` | `metrics.video_views` | chỉ số chuẩn hoá |
| `metrics.video_trueview_view_rate` | `extra.video_view_rate_pct` (%) | |
| `metrics.trueview_average_cpv` | `extra.average_cpv` (đơn vị chính) | **UNVERIFIED: đơn vị** — đọc như micros (giống `average_cpc`); kèm `extra.cost_per_view` = spend ÷ views để đối chiếu |
| `metrics.video_quartile_p25/p50/p75/p100_rate` | `extra.video_quartile_p25_pct`… | |
| `metrics.video_watch_time_duration_millis`, `metrics.average_video_watch_time_duration_millis` | `extra.video_watch_time_ms`, `extra.average_video_watch_time_ms` | |
| `metrics.engagements`, `metrics.youtube_likes`, `metrics.youtube_comments`, `metrics.youtube_shares` | `extra.*` | `youtube_*` mới ở v25 |

- Không áp dụng cho `keyword_view`. Độ tương thích của từng chỉ số mở rộng với từng resource (customer/ad_group_ad…) **UNVERIFIED** → nếu Google trả `queryError` nêu tên một chỉ số mở rộng, adapter **thử lại đúng 1 lần chỉ với `video_trueview_views`** và cảnh báo; cursor trang sau gắn với truy vấn rút gọn.
- **Lọc loại chiến dịch** (field Google-only `channelTypes` trên ReportFilters / ListQuery): giá trị `campaign.advertising_channel_type` (`SEARCH, DISPLAY, SHOPPING, HOTEL, VIDEO, MULTI_CHANNEL, LOCAL, SMART, PERFORMANCE_MAX, LOCAL_SERVICES, TRAVEL, DEMAND_GEN`) hoặc alias **`youtube` = VIDEO + DEMAND_GEN** → `campaign.advertising_channel_type IN (...)`. Ở cấp account → lỗi (dùng level=campaign).
- **Lọc mạng** (field Google-only `adNetworkTypes` trên ReportFilters): `SEARCH, SEARCH_PARTNERS, CONTENT, MIXED, YOUTUBE, GOOGLE_TV` → thêm `segments.ad_network_type` vào SELECT + `IN (...)`; dùng cho **phần YouTube của PMax** (`channelTypes=[PERFORMANCE_MAX]`, `adNetworkTypes=[YOUTUBE]`). Giá trị `YOUTUBE` cho PMax **UNVERIFIED**.
- **Chỉ số video ngoài kênh video = `null`** (sửa 2026-10-08, quy tắc "thiếu chỉ số → null, không phải 0"): dòng báo cáo có `campaign.advertising_channel_type` khác `VIDEO`/`DEMAND_GEN`/`PERFORMANCE_MAX` (Search, Shopping, Display…) → `metrics.video_views` và các `extra.*` chỉ dành cho video (view rate, CPV, quartile, watch time, `youtube_*`) là `null` thay vì 0 mặc định của Google; `extra.engagements` giữ nguyên. Cấp account hoặc không biết kênh → giữ như cũ.
- Segment `segments.ad_sub_network_type` (YOUTUBE_INSTREAM/INFEED/SHORTS) và `segments.ad_using_video`: **chưa làm** (cần thêm tham chiều segment vào contract) — dùng `google_ads_run_gaql`.

## 5. Mutate
`POST /v25/customers/{cid}/<collection>:mutate` (`campaigns, campaignBudgets, adGroups, adGroupAds, ads, adGroupCriteria, campaignCriteria, biddingStrategies, assets, campaignAssets`) hoặc `googleAds:mutate` (đa resource). Body: `operations[]`, `partialFailure`, `validateOnly` (→ dùng cho preview), `responseContentType` (`MUTABLE_RESOURCE` trả object đã tạo).

Resource name: `customers/C/campaigns/ID`, `adGroups/ID`, `adGroupAds/AG~AD`, `adGroupCriteria/AG~CRIT`, `ads/AD`, `campaignBudgets/ID`, `assets/ID`.

- **Status**: `{"operations":[{"update":{"resourceName":"customers/C/campaigns/111","status":"PAUSED"},"updateMask":"status"}],"partialFailure":true}` — tương tự `adGroups`, `adGroupAds`, `adGroupCriteria`. Xoá = `{"remove":"customers/C/campaigns/111"}` → REMOVED **không hoàn tác**.
- **Remove không retry tự động** (sửa 2026-10-08): remove gửi lại sau khi Google đã áp dụng sẽ lỗi ("đã xoá") → `mutate` coi op `remove` là không idempotent (không retry 5xx/timeout). Sau lỗi, `deleteObject` **đọc lại trạng thái**: đã `REMOVED` → coi như thành công + cảnh báo; chưa → lỗi `retryable=false` "Thao tác xoá có thể đã được thực hiện" + gợi ý kiểm tra bằng `ads_get_object`.
- **updateMask**: field trong mask mà thiếu trong body → **bị xoá**; field trong body không có trong mask → bỏ qua.
- **Budget**: `campaignBudgets:mutate` `amountMicros` + mask `amount_micros`. Budget mới mặc định `explicitlyShared:true` → tạo cho 1 campaign đặt `false`. **Trước khi sửa phải đọc `explicitly_shared` + `reference_count`** và cảnh báo nếu budget dùng chung. Demand Gen: cảnh báo mức tối thiểu 5 USD/ngày (§1.1).
  - **Bội số đơn vị tính tiền**: budget/bid micros phải là bội của `currency_constant.billable_unit_micros`. Adapter (`units.ts`) đọc `SELECT currency_constant.code, currency_constant.billable_unit_micros FROM currency_constant WHERE currency_constant.code = '<CUR>'` **1 lần/tiến trình/tiền tệ** (lỗi → thử lại sau 1 giờ) trước mỗi lần quy đổi tiền (đổi ngân sách, giá thầu, tạo Search campaign, keyword có CPC), rồi **làm tròn xuống** bội số gần nhất (không bao giờ vượt số đã kiểm tra trần) + cảnh báo. Không đọc được → làm tròn theo độ chính xác tiền tệ như cũ (VND/JPY… số nguyên, còn lại 2 chữ số). Giá trị thật của VND/KRW/IDR: **UNVERIFIED**.
  - **Ngân sách ngày Google có thể chi tới ~2× trong một ngày** (trung bình theo tháng ≤ 30,4 × ngân sách ngày). Trần ngày của MCP so với **ngân sách cấu hình**, không phải chi tiêu thực tế trong ngày (04-mcp-design.md §6).
- **Đổi tên**: `name` + mask `name` (tên campaign duy nhất trong account).
- **Lịch**: `startDateTime`/`endDateTime` `"yyyy-MM-dd HH:mm:ss"` giờ account; start không ở quá khứ; **bỏ ngày kết thúc** = đưa `end_date_time` vào `updateMask` nhưng không gửi giá trị [M]. Từ **v23** (`start_date_time`/`end_date_time` thay `start_date`/`end_date`) lịch chiến dịch vẫn **theo ngày**: start = 00:00:00, end = 23:59:59 của ngày đó (release notes v23) → adapter làm tròn + cảnh báo; kiểm tra trần trọn đời của `ads_update_object` dùng **cùng cách làm tròn** (`time.ts` `googleScheduleIso`).
- **Chiến dịch VIDEO (YouTube) chỉ đọc**: mutate trên VIDEO cần reservation / không được phép cho loại chiến dịch (`VideoCampaignError.MUTATE_REQUIRES_RESERVATION`, `OperationAccessDeniedError.OPERATION_NOT_PERMITTED_FOR_CAMPAIGN_TYPE`) → adapter **đọc trước `campaign.advertising_channel_type`** (có sẵn trong các truy vấn đọc trước của status/budget/update/delete, keyword, RSA, copy) và **từ chối** mọi thao tác ghi lên chiến dịch VIDEO và con của nó: `ProviderError code="unsupported"`, thông điệp "Chiến dịch Video (YouTube) chỉ xem được qua API - hãy chỉnh trong Google Ads." Không gửi request ghi nào.
- **Tạo sau lỗi 5xx/timeout**: Google có thể đã áp dụng thao tác trước khi lỗi → create (`googleAds:mutate`, `adGroupAds`, `adGroupCriteria`, `assets`, search campaign…) **không bao giờ retry tự động**, lỗi trả `retryable=false` + gợi ý "Có thể đã tạo — hãy kiểm tra trước khi thử lại"; adapter kiểm tra tồn tại khi rẻ (campaign/ad group theo tên, RSA theo bộ tiêu đề + final URL trong ad group, keyword theo text + match type + negative, asset YouTube theo `youtube_video_id`). `validateOnly` không có tác dụng phụ → được retry.
- **`request-id`**: header response của mọi request (kể cả mutate) → lưu vào log/`MutateResponse.requestId`.
- **Bidding**: tCPA `{"maximizeConversions":{"targetCpaMicros":"50000000"}}` mask `maximize_conversions.target_cpa_micros`; Max clicks `{"targetSpend":{}}`; manual `{"manualCpc":{}}`; bid ad group/keyword `cpcBidMicros`. PMax chỉ MaximizeConversions/Value.
- **RSA**: sửa nội dung ở `ads:mutate`; trạng thái ở `adGroupAds`.
- Lỗi từng operation (partial failure) đưa vào cảnh báo đều qua `redactString` (không lộ secret nếu Google echo lại).

### Tạo Search campaign nguyên khối (temp id âm)
```json
POST /v25/customers/C/googleAds:mutate
{"validateOnly": true, "mutateOperations": [
 {"campaignBudgetOperation":{"create":{"resourceName":"customers/C/campaignBudgets/-1","name":"Budget Q4","amountMicros":"500000000","deliveryMethod":"STANDARD","explicitlyShared":false}}},
 {"campaignOperation":{"create":{"resourceName":"customers/C/campaigns/-2","name":"Search Q4","status":"PAUSED",
   "advertisingChannelType":"SEARCH","campaignBudget":"customers/C/campaignBudgets/-1","manualCpc":{},
   "networkSettings":{"targetGoogleSearch":true,"targetSearchNetwork":true,"targetContentNetwork":false,"targetPartnerSearchNetwork":false},
   "containsEuPoliticalAdvertising":"DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING","startDateTime":"2026-10-05 00:00:00"}}},
 {"campaignCriterionOperation":{"create":{"campaign":"customers/C/campaigns/-2","location":{"geoTargetConstant":"geoTargetConstants/2704"}}}},
 {"adGroupOperation":{"create":{"resourceName":"customers/C/adGroups/-3","campaign":"customers/C/campaigns/-2","name":"AG 1","status":"ENABLED","type":"SEARCH_STANDARD","cpcBidMicros":"10000000"}}},
 {"adGroupAdOperation":{"create":{"adGroup":"customers/C/adGroups/-3","status":"ENABLED","ad":{"finalUrls":["https://example.com"],
   "responsiveSearchAd":{"headlines":[{"text":"H1"},{"text":"H2"},{"text":"H3"}],"descriptions":[{"text":"D1"},{"text":"D2"}]}}}}},
 {"adGroupCriterionOperation":{"create":{"adGroup":"customers/C/adGroups/-3","status":"ENABLED","keyword":{"text":"giày chạy bộ","matchType":"PHRASE"}}}}
]}
```
- Temp id âm, duy nhất trong request, khai báo trước khi tham chiếu. ≤10.000 op/request.
- RSA: 3–15 headline ≤30 ký tự, 2–4 description ≤90, path ≤15; keyword ≤80.
- Campaign luôn **PAUSED**. Geo 2704 = Việt Nam [M] → tra bằng `geoTargetConstants:suggest`, không hard-code. **Không có tiêu chí ngôn ngữ** (từ 2026-09-30 Search không nhận; Google tự xác định ngôn ngữ). `ads_lookup kind=languages` vẫn còn cho các loại chiến dịch khác.
- **PMax / Video / Demand Gen**: không tạo trong v1. PMax chỉ đọc/báo cáo/bật-tắt/ngân sách/đổi tên/tCPA-ROAS; Demand Gen tạo = v2.

### Asset video YouTube
- Google Ads không nhận file video: video quảng cáo là **video YouTube**. Tạo asset từ link YouTube (`youtube.com/watch?v=`, `youtu.be/`, `youtube.com/shorts/`, `/embed/`, `/live/`) hoặc ID 11 ký tự:
  ```json
  POST /v25/customers/C/assets:mutate
  {"operations":[{"create":{"name":"YouTube dQw4w9WgXcQ","youtubeVideoAsset":{"youtubeVideoId":"dQw4w9WgXcQ"}}}]}
  ```
  (`asset.type` là output-only, không gửi.) Trước khi tạo: `SELECT asset.resource_name FROM asset WHERE asset.type = 'YOUTUBE_VIDEO' AND asset.youtube_video_asset.youtube_video_id = '<id>'` → có rồi thì dùng lại (không tạo trùng, không retry mù).
- Qua `ads_upload_media` (type=video, url = link YouTube; adapter không tải gì) hoặc tool riêng `google_ads_add_youtube_video` (`video`, `name?`; permission `create`; không có tiền). Video phải ở chế độ Công khai / Không công khai.
- Ảnh: chỉ nhận **bytes đã tải qua SSRF guard của mcp-core** (`MediaUploadRequest.bytes`); không có bytes → từ chối "Lỗi nội bộ: ảnh chưa được tải qua bộ lọc an toàn." (adapter không tự tải URL). JPEG/PNG/GIF ≤ 5 MB.
- Upload video lên YouTube (resumable upload qua YouTube Data API): để sau.

### Nhắm mục tiêu chiến dịch & asset Search (v1.1.7, research doc chính thức 2026-10-19)
Code: `targeting.ts` (`google_ads_get_campaign_targeting`, `google_ads_update_campaign_targeting`, schema dùng chung với `google_ads_create_search_campaign`), `assets.ts` (`google_ads_list_assets`, `google_ads_create_assets`, `google_ads_link_assets`). v26 ra 2026-10-14 nhưng không đổi gì ở phần này → giữ v25.
- **Loại vị trí** `campaign.geoTargetTypeSetting.positiveGeoTargetType`: `PRESENCE_OR_INTEREST` (mặc định Google — người ở / thường ở **hoặc quan tâm** tới khu vực) | `PRESENCE` (chỉ người ở / thường ở). `SEARCH_INTEREST` bị Google chặn cho Search/Shopping/Display từ 2023 (`settingError.SETTING_VALUE_NOT_COMPATIBLE_WITH_CAMPAIGN`) → không mở. Negative giữ mặc định `PRESENCE` (không mở). Sửa bằng `campaignOperation.update` với mask **chính xác** `geo_target_type_setting.positive_geo_target_type` (không dùng `buildUpdate` — mask cấp trên `geo_target_type_setting` sẽ xoá negative). Tạo chiến dịch: **không** gửi khi người dùng không chọn (giữ mặc định Google — quyết định chủ dự án 2026-10-19).
- **Bán kính** `campaignCriterion.proximity`: `geoPoint.{latitudeInMicroDegrees, longitudeInMicroDegrees}` (int32, adapter đổi bằng phép tính chuỗi, không float), `radius` (double, ≤2 chữ số thập phân), `radiusUnits` `KILOMETERS` | `MILES` (không có METERS). Chỉ nhắm (không loại trừ được), cấp chiến dịch. Google: tối thiểu 1 km; tối đa không công bố → adapter tự giới hạn 800 km / 500 dặm; ≤500 bán kính + ≤10.000 vị trí / chiến dịch. Có bán kính thì chiến dịch bắt buộc có khai báo EU (v25.2+). PMax: PROXIMITY không có trong danh sách tiêu chí PMax chính thức **[L]** → cảnh báo, bước xem trước (`validateOnly`) sẽ báo nếu Google từ chối. Nhãn (`label`) chỉ hiện trong kết quả, không gửi lên Google.
- **Lịch chạy** `campaignCriterion.adSchedule`: `dayOfWeek`, `startHour` 0–23, `endHour` 0–24 (24 chỉ với phút ZERO), phút `ZERO|FIFTEEN|THIRTY|FORTY_FIVE`; ≤6 khung / ngày, không chồng nhau, theo **múi giờ tài khoản**; qua nửa đêm phải tách 2 ngày. Các trường bất biến → tool **thay cả danh sách** theo kiểu diff: khung giống hệt giữ nguyên (giữ `bid_modifier`), khung khác remove + create trong 1 mutate nguyên khối; khung bị bỏ có điều chỉnh giá thầu → cảnh báo mất điều chỉnh.
- **Vị trí** location/proximity/adSchedule đều bất biến → đổi = remove + create cùng 1 `googleAds:mutate`. `remove_criterion_ids` chỉ nhận LOCATION/PROXIMITY của đúng chiến dịch. Gỡ hết vị trí + bán kính (chiến dịch thành nhắm mọi quốc gia) bị từ chối trừ khi `allow_no_location: true`. `google_ads_update_campaign_targeting` **luôn xác nhận 2 bước** (`alwaysConfirm`, rà soát bảo mật 2026-10-19: nhắm mục tiêu quyết định tiền tiêu ở đâu). Mất kết nối khi gửi → đọc lại, chỉ báo "đã áp dụng" khi thấy dấu hiệu của thay đổi trên Google, không thì trả lỗi.
- **Asset Search** (`assetOperation` chỉ create/update — **không xoá được asset**, chỉ gỡ liên kết): sitelink (`linkText` ≤25, `description1/2` ≤35 cả hai hoặc không, URL ở `finalUrls` cấp asset), callout (≤25), call (`countryCode` + `phoneNumber`; số phải có trên website hoặc domain đã xác minh, không số cao cấp/vanity — nếu không bị từ chối "Số điện thoại chưa xác minh"), structured snippet (header cố định theo ngôn ngữ — tiếng Anh hoặc tiếng Việt: Thương hiệu, Tiện nghi, Kiểu, Loại, Điểm đến, Dịch vụ, Khóa học, Vùng lân cận, Chương trình, Phạm vi bảo hiểm, Cấp bằng, Khách sạn nổi bật, Model; 3–10 giá trị ≤25), price (`type`, `priceQualifier`, `languageCode`, 3–8 `priceOfferings` có `finalUrl`, `price{amountMicros, currencyCode}`), promotion (`promotionTarget`, đúng một trong `percentOff` (1.000.000 = 100%) / `moneyAmountOff`, tối đa một trong `promotionCode` / `ordersOverAmount`). Độ dài: đếm code point NFC, ký tự CJK/full-width tính 2. Giá / số tiền giảm là **số hiển thị trong quảng cáo, không phải chi tiêu** → `moneyOf: () => []` (test khoá đúng 3 khoá tiền), đổi micros bằng `roundMoney`/`toMicros` theo tiền tệ tài khoản (không dùng bộ nhớ đệm đơn vị tính tiền của ngân sách). Tạo asset dùng lại asset ADVERTISER giống hệt (lọc GAQL) thay vì tạo trùng; `google_ads_create_assets` **chỉ tạo vào thư viện** (quyền Tạo mới) — không gắn vào chiến dịch.
- **Liên kết** `campaignAsset` / `customerAsset` (`fieldType` SITELINK, CALLOUT, CALL, STRUCTURED_SNIPPET, PRICE, PROMOTION; resource name `campaignAssets/{campaignId}~{assetId}~{fieldType}`, `customerAssets/{assetId}~{fieldType}`): `google_ads_link_assets` (quyền Sửa, **luôn xác nhận**) gắn (tạo mới hoặc bật lại link PAUSED) / gỡ (remove). **Thứ bậc**: chiến dịch có ≥1 asset cấp chiến dịch của một loại thì asset cùng loại ở cấp tài khoản **không** hiển thị cho chiến dịch đó → tool cảnh báo khi gắn / gỡ link cuối. Từ chối asset do Google tự tạo (`AUTOMATICALLY_CREATED`), chiến dịch VIDEO / SMART (Smart không còn tạo mới được từ 2026-09-23).
- **Chưa kiểm chứng với tài khoản thật [L]**: header tiếng Anh "Service catalog" (canonical) vs "Services" (bí danh); tạo lại link đã REMOVED cùng resource name (nếu Google trả `RESOURCE_ALREADY_EXISTS` → thông báo đã map); `languageCode="vi"` cho price asset; PROXIMITY trên PMax / Demand Gen; tối thiểu 0,7 dặm. Tất cả đi qua bước xem trước `validateOnly` nên Google từ chối ngay ở preview.

## 6. Sao chép
**Không có endpoint copy** [H]. Cách làm:
1. Đọc cây bằng GAQL: campaign settings, campaign_budget, campaign_criterion (location, negative, schedule, device), campaign_asset, campaign_shared_set, ad_group, ad_group_criterion, ad_group_ad, ad_group_asset, label.
2. Bỏ field output-only (resourceName, id, status phục vụ, primaryStatus, quality info, policy summary…).
3. Đổi tên " (bản sao)", status PAUSED, set `containsEuPoliticalAdvertising`, `startDateTime` không ở quá khứ — khi start gốc đã qua và phải dời về hôm nay, **`endDateTime` dời cùng số ngày** (giữ nguyên độ dài lịch chạy, ngân sách tổng không bị dồn vào ít ngày hơn) + cảnh báo.
4. Budget mới non-shared (hoặc dùng lại budget shared).
5. Tạo lại trong **1 `googleAds:mutate`** dùng temp id (chia chunk <10.000 op, ad group đi kèm con).
- Chỉ sao chép chiến dịch **Search**; VIDEO → lỗi "chỉ xem được qua API"; PMax → lỗi riêng; loại khác → lỗi "chỉ hỗ trợ Search".
- Sao chép **quảng cáo** (chỉ RSA) sang nhóm khác: đọc `campaign.advertising_channel_type` + `ad_group.type` của nhóm đích → VIDEO bị từ chối (chỉ đọc), nhóm không phải `SEARCH_STANDARD` bị từ chối kèm giải thích.
- Copy được (adapter hiện tại): settings, bidding (gồm portfolio), budget mới non-shared, criteria LOCATION (kèm negative), negative KEYWORD, AD_SCHEDULE, **DEVICE kèm `bid_modifier`** (0 = loại trừ thiết bị, phải copy; 1.0/không có = bỏ qua) [L: tạo device criterion trên campaign mới cần test thật], keyword + negative cấp nhóm, nội dung RSA (tạo ad mới), **`campaign_shared_set` ENABLED** (danh sách từ khoá phủ định dùng chung — liên kết bằng `campaignSharedSetOperation`, cùng account), **PROXIMITY** (v1.1.7: geo point + bán kính, địa chỉ chỉ làm nhãn; chỉ có địa chỉ → gửi địa chỉ để Google định vị; không có cả hai → vẫn fail closed), **liên kết asset cấp chiến dịch** (v1.1.7: `campaign_asset` ENABLED, nguồn ADVERTISER, loại SITELINK/CALLOUT/CALL/STRUCTURED_SNIPPET/PRICE/PROMOTION → gắn lại cùng asset; loại khác / asset Google tự tạo → cảnh báo, không tính là thiếu targeting).
- **LANGUAGE**: bỏ qua kèm **cảnh báo** (Search không còn nhận ngôn ngữ thủ công từ 2026-09-30) — **không** tính là thiếu targeting, không cần `allow_incomplete_targeting`.
- **Fail closed**: tiêu chí nhắm/loại trừ không tạo lại được (PROXIMITY thiếu dữ liệu, LOCATION_GROUP, USER_LIST/AUDIENCE, IP_BLOCK, PLACEMENT/CONTENT_LABEL phủ định, BRAND_LIST, AGE_RANGE/GENDER…, mọi loại khác ngoài danh sách trên, cả cấp nhóm) → **dừng với lỗi tiếng Việt liệt kê đủ**, trừ khi input `allow_incomplete_targeting: true` (`CopyRequest.allowIncomplete`). Đọc GAQL bị `truncated` → dừng, không sao chép một phần.
- **EU**: chiến dịch gốc chưa khai báo `contains_eu_political_advertising` → **không tự khai báo**; yêu cầu người dùng chạy `google_ads_declare_eu_political` (bắt buộc chọn true/false, không có mặc định) rồi sao chép lại.
- **Mục tiêu chuyển đổi**: `conversion_goal_campaign_config.goal_config_level = CAMPAIGN` (mục tiêu riêng cấp chiến dịch) không được sao chép → cảnh báo đặt lại.
- Không copy được: lịch sử hiệu suất, quality score, duyệt chính sách, asset tự tạo, object đã REMOVED. Copy khác account: opt-in, báo cáo phần bị bỏ qua. PMax copy: để v2.

## 7. Thư viện Node
**Dùng REST + `fetch`** (Node ≥22) với wrapper typed mỏng; tự ký JWT bằng `node:crypto`. KHÔNG dùng `google-ads-api` (Opteo, cộng đồng, ~126MB, lỗi gRPC với google-gax 6.4.0, ép developer_token). Google **không có** client Node chính thức.

## 8. Rate limit & lỗi
- Ops/ngày theo access level (§2, 24 giờ trượt); QPS giới hạn theo customer + project (token bucket động) → `QuotaError.RESOURCE_TEMPORARILY_EXHAUSTED` (429). Vượt quota → `RESOURCE_EXHAUSTED` → không retry, báo user.
- Sửa đồng thời cùng campaign → `DatabaseError.CONCURRENT_MODIFICATION`.
- Khuyến nghị: concurrency toàn cục 4–8, tối đa 1–2 request đồng thời mỗi customer, gộp mutate.

Lỗi REST:
```json
{"error":{"code":400,"status":"INVALID_ARGUMENT","details":[{"@type":"type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure",
 "errors":[{"errorCode":{"fieldError":"REQUIRED"},"message":"...","location":{"fieldPathElements":[{"fieldName":"operations","index":0}]}}],"requestId":"..."}]}}
```
Lỗi hạ tầng dùng `google.rpc.ErrorInfo` (vd `CREDENTIALS_MISSING`, `SERVICE_DISABLED`) → parse cả 2 dạng.

| Loại | Xử lý |
|---|---|
| 429 TEMPORARILY_EXHAUSTED, 500 INTERNAL/TRANSIENT, 503, 504, 409 ABORTED, CONCURRENT_MODIFICATION | backoff 5s/10s/20s…, tối đa ~5 lần, tôn trọng `retryDelay` |
| 401 OAUTH_TOKEN_EXPIRED | refresh 1 lần rồi retry |
| `invalid_grant`, OAUTH_TOKEN_REVOKED | user phải dán lại credential |
| 400 INVALID_ARGUMENT, USER_PERMISSION_DENIED, CLOUD_PROJECT_NOT_APPROVED…, EU_POLITICAL_ADVERTISING_DECLARATION_REQUIRED | không retry, trả hướng dẫn |
| `contextError.OPERATION_NOT_PERMITTED_FOR_CONTEXT` | `invalid_request` — vd ngôn ngữ thủ công trên Search (từ 2026-09-30) |
| `videoCampaignError.MUTATE_REQUIRES_RESERVATION`, `operationAccessDeniedError.OPERATION_NOT_PERMITTED_FOR_CAMPAIGN_TYPE` | `unsupported` — chiến dịch Video chỉ xem được |
| `criterionError.MISSING_EU_POLITICAL_ADVERTISING_SELF_DECLARATION` | `invalid_request` — khai báo cấp tài khoản trong giao diện Google Ads |
| `campaignBudgetError.BUDGET_BELOW_DAILY_MINIMUM` | `invalid_request` — Demand Gen ≥ 5 USD/ngày |
| `authenticationError.TWO_STEP_VERIFICATION_NOT_ENROLLED` | `auth_invalid` — bật 2SV bằng passkey hoặc dùng SA |

### Env adapter đọc
| Biến | Mặc định |
|---|---|
| `GOOGLE_ADS_API_VERSION` | `v25` |

## 9. YouTube Ads
YouTube **không có API quảng cáo riêng**: quảng cáo YouTube được quản lý trong **Google Ads** → là một phần của kết nối Google Ads (UI: một thẻ "Google Ads (gồm YouTube)" ở bước 1 trang Thêm kết nối; form Google Ads luôn kèm giải thích YouTube).

| Loại chiến dịch | Báo cáo / danh sách | Bật-tắt / ngân sách / giá thầu | Sửa / xoá | Tạo mới |
|---|---|---|---|---|
| **VIDEO** (TrueView, Shorts…) | ✔ (preset `video`, lọc `youtube`/`VIDEO`) | ✘ chỉ đọc | ✘ chỉ đọc | ✘ (API không cho) |
| **DEMAND_GEN** (gồm vị trí YouTube) | ✔ | ✔ (ngân sách ≥ 5 USD/ngày: cảnh báo) | ✔ (tên, lịch) | để sau (v2) |
| **PERFORMANCE_MAX** | ✔ kể cả phần YouTube (`adNetworkTypes=[YOUTUBE]` → `segments.ad_network_type`) | ✔ | ✔ (tên, lịch) | ✘ (v1) |

- Summary chiến dịch/nhóm/quảng cáo có `extra.advertising_channel_type`, `extra.advertising_channel_sub_type`, `extra.youtube`; chiến dịch VIDEO trong `ads_get_object` có `config.read_only=true` và `config.video_ad_inventory_control` (`allow_in_stream`, `allow_in_feed`, `allow_shorts` — `campaign.video_campaign_settings.video_ad_inventory_control.*`).
- Quảng cáo video: `ad_group_ad.ad.video_ad.video.asset`, `video_responsive_ad.{videos,headlines,long_headlines,descriptions}`, `demand_gen_video_responsive_ad.{videos,headlines,business_name}` → adapter đổi asset thành ID YouTube qua `asset.youtube_video_asset.youtube_video_id` (1 truy vấn `asset` mỗi trang) → `extra.youtube_videos[{asset, youtube_video_id, title, url}]`.
- Danh sách có chiến dịch VIDEO → cảnh báo "chỉ xem được qua API".
- `VideoResponsiveAdInfo` **sửa được qua API từ v24** (release notes) — adapter **vẫn chặn** mọi thao tác ghi lên chiến dịch VIDEO (an toàn; mở sau nếu cần).
- **Khai báo quảng cáo chính trị EU** (`google_ads_declare_eu_political`): truy vấn chọn thêm `campaign.advertising_channel_type`, **bỏ qua chiến dịch VIDEO** kèm cảnh báo "khai báo trong giao diện Google Ads" (chiến dịch Video chỉ đọc qua API).

## 10. Map sang tool MCP
| Tool | Google adapter gọi |
|---|---|
| `ads_list_accounts` | cache từ `listAccessibleCustomers` + `customer_client` |
| `ads_get_report` | `googleAds:search` theo level (account/campaign/ad_group/ad/keyword), quy đổi micros; lọc `channelTypes` / `adNetworkTypes` (Google-only) |
| `ads_list_objects` / `ads_get_object` | GAQL; lọc `channelTypes` (Google-only); ID YouTube cho quảng cáo video |
| `ads_set_status` | `<entity>:mutate` mask status, partialFailure (từ chối VIDEO) |
| `ads_update_budget` | đọc shared/reference_count → `campaignBudgets:mutate` (từ chối VIDEO, cảnh báo Demand Gen) |
| `ads_update_object` | mutate với `updateMask` tường minh (name, bid, start/end) (từ chối VIDEO) |
| `ads_copy_object` | GAQL đọc → `googleAds:mutate` temp id (§6) |
| `ads_delete_object` | `remove` op (từ chối VIDEO) |
| `ads_upload_media` | ảnh: `assets:mutate imageAsset` (bytes); video: link YouTube → `youtubeVideoAsset` |
| `ads_lookup` | `geoTargetConstants:suggest`, `language_constant`, conversion actions, user lists |
| `google_ads_run_gaql` | chỉ SELECT (validate chặn mutate) |
| `google_ads_create_search_campaign` | §5 nguyên khối, PAUSED, có EU declaration, không có ngôn ngữ; tuỳ chọn `positive_geo_target_type` (không gửi khi bỏ trống), `proximities`, `ad_schedules` (cần ≥1 `location_ids` hoặc `proximities`) |
| `google_ads_get_campaign_targeting` / `google_ads_update_campaign_targeting` | GAQL `campaign` + `campaign_criterion` (LOCATION/PROXIMITY/AD_SCHEDULE) + `geo_target_constant`; cập nhật 1 `googleAds:mutate` nguyên khối, luôn xác nhận (§5 “Nhắm mục tiêu chiến dịch”) |
| `google_ads_list_assets` / `google_ads_create_assets` / `google_ads_link_assets` | GAQL `asset` / `customer_asset` / `campaign_asset`; `assetOperation` create (dùng lại asset giống hệt); `campaignAssetOperation` / `customerAssetOperation` create / update status / remove, link luôn xác nhận |
| `google_ads_add_keywords` / `google_ads_create_rsa` | `adGroupCriteria` / `campaignCriteria` / `adGroupAds:mutate` (từ chối VIDEO) |
| `google_ads_add_youtube_video` | `assets:mutate youtubeVideoAsset` (dùng lại asset có sẵn) |
| `google_ads_declare_eu_political` | query `missing_eu_political_advertising_declaration = true` → mutate field (bỏ qua VIDEO, cảnh báo khai báo trong UI) |

## Nguồn
Sunset: https://developers.google.com/google-ads/api/docs/sunset-dates · Release notes: /docs/release-notes · Developer token sunset: /docs/api-policy/developer-token · Access levels: /docs/api-policy/access-levels · Service accounts: /docs/oauth/service-accounts · Single-user: /docs/oauth/single-user-authentication · 2-Step / passkey: /docs/oauth/2sv · REST auth: /rest/auth · Search: /rest/common/search · Mutate: /rest/common/mutate · EU political: /docs/api-policy/eu-par · Date ranges: /docs/query/date-ranges · Quotas: /docs/best-practices/quotas · Errors: /docs/best-practices/understand-api-errors · Search campaigns: /docs/campaigns/search-campaigns/getting-started · Video campaigns: /docs/video/overview · Demand Gen: /docs/demand-gen/overview · Assets: /docs/assets/overview · PMax: /performance-max/create-campaign (tất cả dưới https://developers.google.com/google-ads/api; đường dẫn 2SV/Video/Demand Gen/Assets **UNVERIFIED** — kiểm tra lại khi chạy `/provider-api-check google-ads`)
