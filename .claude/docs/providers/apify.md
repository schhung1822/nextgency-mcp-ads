# Apify API v2 — tài liệu tham chiếu

> Research ngày **2026-10-14** từ nguồn chính thức: OpenAPI spec **đã lưu tại [apify.openapi.json](apify.openapi.json)** (OpenAPI 3.1.2, `info.version` = `v2-2026-10-08T073338Z`, 131 path, 240 schema — tải từ `https://docs.apify.com/api/openapi.json`), các trang `https://docs.apify.com/**.md` (mục lục `https://docs.apify.com/llms.txt`), mã nguồn MCP server chính thức `github.com/apify/apify-mcp-server` (package `@apify/actors-mcp-server` 0.18.3) và `github.com/apify/apify-client-js` (2.25.1). Một số điểm thử **live** bằng request không token / token giả (không tốn tiền) — ghi "(live)". Khi implement: **grep spec để lấy schema chính xác**, không đoán.
>
> Mức tin cậy: **[H]** tài liệu/spec chính thức hoặc đã thử live · **[M]** suy ra từ mã nguồn chính thức · **[L]** nguồn bên thứ ba / chưa xác minh — cần token thật để test (§15).
>
> Thiết kế tích hợp: [`16-apify.md`](../16-apify.md). Code: `src/server/apify/` (client, errors, actors, pool, store, health).

## 1. Tổng quan

- Base URL **`https://api.apify.com`**, mọi endpoint dưới **`/v2`** [H]. Không có version theo ngày trong path. App: hằng số `DEFAULT_APIFY_API_BASE_URL`, override bằng env `APIFY_API_BASE_URL` (chỉ `https://`, dùng cho test/sandbox — không có trong compose/`.env.example`).
- Prefix canonical **`/v2/actors/...`**; `/v2/acts/...` deprecated nhưng vẫn chạy [H]. App chỉ dùng `/v2/actors/` và `/v2/actor-runs/` (bản `/actors/{id}/runs/{runId}` là bản cũ).
- Envelope: thành công `{"data": {...}}`; lỗi `{"error": {"type", "message", "data"?}}`. Ngoại lệ: **dataset items**, **KV record** và `validate-input` (`{"valid": true}`) trả thẳng nội dung [H].
- Danh sách phân trang `offset`/`limit`/`desc` → `data: {total, offset, limit, count, desc, items}`; giới hạn `limit` tối đa có thể đổi — không hard-code [H].
- ID tài nguyên: ID (`vKg4IjxZbEYTYeW8T`) **hoặc** `username~resource-name` (dấu **ngã `~`**) [H]. App kiểm tra mọi segment path bằng regex `[A-Za-z0-9._~-]` rồi `encodeURIComponent` (`apifyPath()`).
- Thuật ngữ: **Actor** (chương trình serverless, đa số do cộng đồng viết) → **run** (một lần chạy) → **default dataset** (kết quả dạng bảng) / **default key-value store** (INPUT, file).

## 2. Xác thực & token

- Header **`Authorization: Bearer <token>`** [H]. Query `?token=` cũng được Apify nhận nhưng URL bị log → **app không bao giờ dùng** (`client.ts` từ chối query tên `token`, `redirect: "error"` để header không đi theo redirect).
- Token có tiền tố **`apify_api_`** [M] — zod `APIFY_TOKEN_RE` (`src/lib/schemas/apify.ts`); redact theo mẫu `apify_api_[A-Za-z0-9]+`.
- Lấy token: Apify Console → **Settings → API & Integrations** (`https://console.apify.com/settings/integrations`) [H].
- Loại token [H `integrations/api.md`]:
  - **Mặc định (unscoped)**: toàn quyền tài khoản — chạy mọi Actor, đọc/xoá dữ liệu, **sửa giới hạn chi tiêu (`PUT /v2/users/me/limits`)** → tương đương "token chi tiền": mã hoá AES-256-GCM (AAD `apify_token:<id>:credentials`), không trả client/AI/log, thay token phải re-auth.
  - **Organization**: "Personal API token" trong org (quyền của thành viên) và "Organization API token".
  - **Scoped token** ("Limit token permissions"): quyền account-level + resource-specific; khi chạy Actor có chế độ Full / Restricted access; phải bật **"default run storages"** để đọc dataset của run nó khởi chạy. [L] Chưa rõ scoped token có chạy được Actor Store không thuộc sở hữu và có đọc được `/users/me/limits` không ⇒ khuyên dùng token thường.
  - Token có thể đặt ngày hết hạn và rotate trong Console (giữ token cũ thêm 24 h tuỳ chọn) [H].
- **Kiểm tra token (miễn phí): `GET /v2/users/me`** [H]. Token sai → **401 `user-or-token-not-found`**; thiếu token → **401 `token-not-provided`** (live).
  - Trả về (`UserPrivateInfo`): `id`, `username`, `profile`, **`email`**, **`proxy{password, groups}`**, `plan{id, tier, monthlyUsageCreditsUsd, maxMonthlyUsageUsd, maxConcurrentActorRuns, …}`, `effectivePlatformFeatures.ACTORS{isEnabled, disabledReason, …}`, `isPaying`.
  - **App lưu/hiện**: `id` (→ `apify_user_id`), `username`, `plan.id`, `plan.tier`, `ACTORS.isEnabled`. **Không bao giờ lưu/trả AI/log**: `email` (PII) và `proxy.password` (dùng được Apify Proxy bằng tiền chủ token) — `actors.ts getUserInfo()` chỉ đọc các trường cho phép.
- **ToS khi xoay vòng token** — General Terms §4.3 "Prohibition of Multiple Accounts" (bản 2026-07-09) [H]: một người **không được lập/dùng nhiều tài khoản Personal**, kể cả khác email. ⇒ Xoay vòng chỉ hợp lệ giữa token của **các tài khoản thật khác nhau** (mỗi nhân sự/khách hàng một tài khoản); nhiều token cùng một tài khoản **dùng chung credit** (app gộp theo `apify_user_id`). UI và tài liệu người dùng phải nói rõ.

## 3. Credit / usage

### `GET /v2/users/me/limits` [H `AccountLimits`]

```
data.monthlyUsageCycle { startAt, endAt }          // chu kỳ hiện tại (KHÔNG phải tháng dương lịch)
data.limits  { maxMonthlyUsageUsd, maxActorMemoryGbytes, maxConcurrentActorJobs, … }
data.current { monthlyUsageUsd, actorMemoryGbytes, activeActorJobCount, … }
```

- **Credit còn trước khi bị chặn cứng** = `limits.maxMonthlyUsageUsd − current.monthlyUsageUsd` [M] (`remainingCreditUsd()`); reset tại `monthlyUsageCycle.endAt`, không cộng dồn [H].
- Phần trả trước (gói trả phí, vượt thì tính overage) = `plan.monthlyUsageCreditsUsd − current.monthlyUsageUsd` [M].
- `PUT /v2/users/me/limits` đổi hard limit — **app không bao giờ gọi**.
- [L] Độ trễ cập nhật `monthlyUsageUsd` với phí pay-per-event chưa rõ ⇒ cache ≤ 5 phút + biên an toàn ($0.05).

### Gói (apify.com/pricing, đọc 2026-10-14) [H]

| Gói      | Giá/tháng | Usage trả trước | Max RAM | Run đồng thời                          |
| -------- | --------- | --------------- | ------- | -------------------------------------- |
| Free     | $0        | $5              | 16 GB   | 5 (pricing) / 25 (trang Limits) ⚠      |
| Starter  | $19       | $19             | 64 GB   | 32                                     |
| Scale    | $199      | $199            | 256 GB  | 128                                    |
| Business | $999      | $999            | 512 GB  | 256                                    |

- Free hết $5 → bị chặn tới chu kỳ sau. Gói trả phí hết phần trả trước → tạm dừng tới khi tăng usage limit (trần $100 Starter / $1.000 Scale / $5.000 Business) [H].
- 1 CU = 1 GB RAM × 1 giờ, tính theo giây; $0.2/CU ở Free/Starter [H].

## 4. Endpoint app dùng (đều dưới `/v2`)

| Nhóm     | Endpoint                                                                 | Hàm (`actors.ts`)                | Ghi chú                                                                                     |
| -------- | ------------------------------------------------------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------- |
| User     | `GET /users/me` · `GET /users/me/limits`                                 | `getUserInfo`, `getLimits`, `getAccountInfo` | miễn phí                                                                         |
| Store    | `GET /store`                                                             | `searchStore`                    | không cần token (live); `limit ≤ 10` khi `includeInputSchema`                               |
| Actor    | `GET /actors/{actorId}`                                                  | `getActor`                       | `pricingInfos[]`, `defaultRunOptions`, `actorPermissionLevel`, `readmeSummary`              |
| Build    | `GET /actors/{actorId}/builds/default`                                   | `getActorDefaultBuild`           | `actorDefinition.input` (input schema), `readme`, `actorDefinition.storages.dataset.views` |
| Validate | `POST /actors/{actorId}/validate-input`                                  | `validateActorInput`             | **miễn phí, không chạy**; sai → 400 `invalid-input`                                         |
| Run      | `POST /actors/{actorId}/runs`                                            | `startActorRun`                  | §5                                                                                          |
| Run      | `GET /actor-runs/{runId}?waitForFinish≤60` · `POST /actor-runs/{runId}/abort` · `GET /actor-runs?desc&limit&startedAfter` | `getRun`, `abortRun`, `listRecentRuns` | list **không** lọc theo Actor: lọc `actId` phía app                    |
| KV       | `GET /actor-runs/{runId}/key-value-store/records/INPUT`                  | (nội bộ `startActorRun`)         | so INPUT khi khôi phục sau lỗi mơ hồ                                                        |
| Dataset  | `GET /datasets/{datasetId}/items`                                        | `getDatasetItems`                | §6                                                                                          |

**Không dùng**: `run-sync*` (giữ kết nối tới 300 s rồi 408 — vượt 60 s của ChatGPT), `resurrect`, `metamorph`, `PUT/DELETE` storage, `PUT /users/me/limits`, webhooks, schedules, tasks.

## 5. Chạy Actor

### `POST /v2/actors/{actorId}/runs` [H `actors_runs_post`]

- Body = **INPUT của Actor** (JSON, ≤ 9.437.184 byte → 413 `request-too-large`).
- Query app gửi (luôn đặt trần phía server, `startActorRun`):

| Param               | App                                                                                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `timeout` (giây)    | 1–**600** (mặc định Actor thường 3.600–7.200 s; `0` = không giới hạn → không bao giờ gửi)                                                                 |
| `memory` (MB)       | luỹ thừa 2, **128–4.096** (`clampMemoryMbytes`), **luôn gửi** (bỏ trống = 1.024; Actor ngoài danh mục: truyền `defaultRunOptions.memoryMbytes` của Actor - vẫn bị kẹp) — mặc định Actor có thể 8–32 GB                                                   |
| `maxTotalChargeUsd` | trần tiền của run, 4 chữ số thập phân (`usdParam`); phải ≥ `minimalMaxTotalChargeUsd` của Actor (400 `max-total-charge-usd-below-minimum`)                |
| `waitForFinish`     | **≤ 25 s** (Apify cho tới 60)                                                                                                                              |
| `build`             | tuỳ chọn                                                                                                                                                  |
| `maxItems`          | **không gửi** — LEGACY, không đảm bảo số item, đang bị deprecate (apify-sdk-js#768) → dùng `maxTotalChargeUsd`                                            |
| `webhooks`, `restartOnError`, `forcePermissionLevel` | không gửi                                                                                                               |

- Phản hồi **201** `data` = Run object. Thiếu token → **402 `x402-payment-required`** (Apify mời trả tiền x402 không cần tài khoản) — **402 không phải lúc nào cũng là hết tiền**, phải xem `error.type` (live).
- **Không có Idempotency-Key cho start run** [H] → app **không bao giờ gửi lại POST start** (một Apify chậm có thể đã tạo run #1 - chưa ghi nhận, không tính vào trần ngày, không abort được - và lần gửi lại tạo run #2). `startActorRun`: sau lỗi mơ hồ (timeout, mạng, 5xx, 201 không đọc được) tra `GET /actor-runs?desc=1&limit=25&startedAfter=<t−60s>`, lọc `actId` (id thật qua `GET /actors/{username~name}`) và **chỉ run bắt đầu sau lúc gửi POST (dung sai lệch đồng hồ 10 s)**, bỏ run **đã ghi cho MCP khác** (`isRunTaken` → `apify_runs`), đọc `INPUT` của ≤ 3 ứng viên và chỉ **nhận run có INPUT giống hệt** (`recovered: true`); không thấy (hoặc tra cứu lỗi) → `start_uncertain` (run có thể tồn tại: giữ chỗ trần ngày được giữ, AI không được chạy lại ngay). Client huỷ giữa chừng → tìm run vừa tạo (cùng điều kiện) và **abort**.
- HTTP timeout của POST = `waitForFinish` + 15 s.

### Luồng trong ngân sách ~45 s/tool (ChatGPT cắt ở 60 s)

1. `apify_run_task`/`apify_run_actor`: validate-input (miễn phí) → start với `waitForFinish ≤ 25`.
2. Kết thúc kịp → trả tóm tắt + vài dòng đầu; chưa → `run_id` + bước tiếp theo.
3. `apify_get_run`: `GET /actor-runs/{runId}?waitForFinish≤30`.
4. Ngay sau khi kết thúc, `usageTotalUsd`/`stats` có thể còn sơ bộ (spec khuyên đợi ~10 s rồi GET lại); `itemCount` của dataset trễ tới ~5 s [H].
5. MCP chính thức làm tương tự (`waitSecs` 0–45, mặc định 30; chỉ trả status + storage ID + `nextStep`) [H/M].

### Run object (rút gọn, spec `Run`) [H] → `ApifyRun` (`runOf()`)

`id`, `actId`, `userId`, `startedAt`, `finishedAt`, **`status`**, **`statusMessage`** (Actor tự viết — dữ liệu không tin cậy, app làm sạch + cắt 500 ký tự), `stats{durationMillis, computeUnits, …}`, **`chargedEventCounts`**, **`options`**{`timeoutSecs`, `memoryMbytes`, `maxTotalChargeUsd`}, `exitCode`, **`defaultDatasetId`**, `defaultKeyValueStoreId`, **`usageTotalUsd`** (tổng tiền thật của run), `usageUsd`, `platformUsageBillingModel`. Trường `output` có trong tài liệu nhưng không có trong spec [L] — không dùng.

### Trạng thái [H]

| Status                                           | Loại                    |
| ------------------------------------------------ | ----------------------- |
| `READY`                                          | khởi tạo                |
| `RUNNING`                                        | đang chạy               |
| `TIMING-OUT` / `ABORTING`                        | chuyển tiếp             |
| `SUCCEEDED` / `FAILED` / `TIMED-OUT` / `ABORTED` | kết thúc (`APIFY_TERMINAL_STATUSES`) |

Abort chỉ có tác dụng với READY/RUNNING/TIMING-OUT. Run bị abort/timeout **vẫn có thể có dữ liệu một phần**. MCP chính thức coi FAILED/ABORTED/TIMED-OUT là kết quả bình thường, không phải lỗi tool [M].

## 6. Dataset

### `GET /v2/datasets/{datasetId}/items` [H]

- `limit` **mặc định là KHÔNG giới hạn** ("No limit exists…") → app **luôn gửi `limit`** (≤ 100, `getDatasetItems`), `format=json`, `clean=true` mặc định (= `skipHidden` + `skipEmpty`, có thể trả ít hơn `limit`) — hoặc `skipHidden` / `skipEmpty` gửi riêng khi truyền (khi đó `clean` chỉ gửi nếu yêu cầu rõ; `{ skipHidden: true }` giữ item rỗng để offset phân trang ổn định), `fields`/`omit` (đường dẫn chấm, ≤ 30, tên được kiểm tra), `offset`, `desc`.
- Header **`X-Apify-Pagination-Total`** (+ `-Offset`, `-Limit`, `-Count`) (live). Item < 9 MB; app cắt body 8 MB.
- Đọc dataset **tính platform usage** (`DATASET_READS`) [H]; endpoint có thể trả 402 khi tài khoản hết credit [H spec, thực tế L].
- `GET /datasets/{id}` có `itemsPublicUrl` và **`urlSigningSecretKey`** (bí mật) → không bao giờ đưa AI/log (app không gọi endpoint này).
- **Quyền**: run/dataset thuộc tài khoản đã chạy; mặc định "Restricted" [H] ⇒ **mọi thao tác sau (get run, dataset, abort) dùng đúng token đã start** — bảng `apify_runs.token_id` (token ghim). Token khác tài khoản → 404.
- Lưu trữ: dataset không tên hết hạn sau **7 ngày** (hoặc theo `dataRetentionDays` của gói) [H].

## 7. Tìm Actor & input schema / README

### `GET /v2/store` [H + live]

- Params: `search`, `sortBy` (`relevance`|`popularity`|`newest`|`lastUpdate`), `category`, `username`, `pricingModel` (rỗng → 400), `limit` (mặc định & tối đa 1.000), `offset`, `responseFormat` (`full`|`agent`), **`includeUnrunnableActors`** (mặc định false: Apify **ẩn Actor không an toàn để chạy tự động** — app giữ mặc định).
- **`includeInputSchema=true`** — không có trong spec nhưng chạy thật và MCP chính thức dùng: thêm `inputSchema` rút gọn; **bắt buộc `limit ≤ 10`** (> 10 → 400 `invalid-parameter`). App gửi `limit ≤ 10`, bị 400 thì tìm lại không có tham số này.
- Item: `id`, `name`, `username`, `title`, `description`, `categories`, `notice` (`NONE`|`RESIDENTIAL_PROXY_REQUIRED`|`UNDER_MAINTENANCE`), `stats{totalUsers30Days, publicActorRunStats30Days{SUCCEEDED, TOTAL, …}, lastRunStartedAt}`, `currentPricingInfo{pricingModel, minimalMaxTotalChargeUsd, isPPEPlatformUsagePaidByUser, pricingPerEvent.actorChargeEvents}`.
- Live 2026-10-14: Store lọc an toàn **sau** phân trang (`count` 1000 nhưng 941 item) → không dựa vào `count`; tìm "shopee" → 356 Actor, toàn PPE. Header `X-RateLimit-Limit: 60`.
- Chọn Actor tốt: `notice=NONE`, `LIMITED_PERMISSIONS`, `totalUsers30Days` cao, **tỉ lệ thành công 30 ngày** = SUCCEEDED/TOTAL (ví dụ live: một Actor review Shopee chỉ ~38%, một Actor khác ~99,8%).

### Chi tiết Actor

- `GET /v2/actors/{username~name}` (công khai không cần token, live): `id`, `isDeprecated`, **`actorPermissionLevel`**, **`pricingInfos[]`** (lịch sử — bản hiện hành = `startedAt` ≤ now mới nhất; Actor pay-per-usage có thể không có), `defaultRunOptions`, `readmeSummary` (AI sinh), `notice`, `stats`, `actorStandby`.
- `GET /v2/actors/{id}/builds/default`: `actorDefinition.input` (JSON Schema đầy đủ), `inputSchema` (chuỗi), `readme` (Markdown đầy đủ, live 35.856 ký tự — app cắt 5.000, giữ xuống dòng), `actorDefinition.storages.dataset.views` (field kết quả), `min/max/defaultMemoryMbytes`.

## 8. Giá & kiểm soát chi phí

| `pricingModel`           | Thực tế                                                     | Ai trả gì                                                                                                                                         |
| ------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PAY_PER_EVENT` (PPE)    | phổ biến nhất                                               | theo event của tác giả, giá theo **bậc gói** (`plan.tier` FREE…DIAMOND); đa số đã gồm platform usage, `isPPEPlatformUsagePaidByUser=true` → trả thêm |
| `FREE`                   | = "pay per usage" — **không miễn phí**                      | trả platform usage (CU, proxy, transfer, storage)                                                                                                 |
| `FLAT_PRICE_PER_MONTH`   | rental — **khai tử 2026-10-01**                             | (lịch sử)                                                                                                                                         |
| `PRICE_PER_DATASET_ITEM` | pay-per-result — đã migrate sang PPE (blog 2026-04-14)      | (lịch sử)                                                                                                                                         |

- Event tổng hợp: `apify-actor-start` (mặc định $0.00005, **1 event / GB RAM**) và `apify-default-dataset-item` [H + live].
- **`maxTotalChargeUsd`** (mỗi run): platform cưỡng chế — chạm trần thì ngừng tính tiền, ngừng đẩy dữ liệu và tự abort run; "never charged for produced events over the defined limit" [H]. Spec nói áp mọi mô hình giá, MCP chính thức nói "chỉ PPE" ⇒ **[L] với Actor `FREE` không dựa vào nó** — chặn bằng `timeout × memory` (`maxCU = memoryMB/1024 × timeoutSecs/3600`, × $0.2/CU, chưa tính proxy).
- Trần là per run, không per user — nhiều run song song cộng dồn [H] ⇒ app có thêm **trần ngày mỗi MCP** (chế độ nâng cao): `startActorRunForMcp({ dailyMaxUsd })` **giữ chỗ nguyên tử** trước khi chạy — trong transaction có `pg_advisory_xact_lock(hashtext('apify:<mcpId>'))` đọc chi tiêu hôm nay (`mcpApifySpendToday`: run xong = `usage_usd`, chưa xong / giữ chỗ = `max_charge_usd`) và chèn dòng `apify_runs` trạng thái `STARTING` (run_id `pending:<uuid>`) nếu chi tiêu + trần lần này ≤ trần ngày, nếu không → `daily_budget_exceeded`. Start thành công → dòng giữ chỗ thành bản ghi run (claim nguyên tử, xem §9); thất bại chắc chắn → xoá; client huỷ giữa POST → run tìm thấy bị abort và được ghi theo **chi phí thật** (không thấy run → xoá giữ chỗ); có thể đã start (`start_uncertain`, lỗi lạ, tra cứu lỗi) → **giữ** với trạng thái `UNKNOWN` (vẫn tính trần trong ngày). Mọi lời gọi Apify trên đường start (limits, validate, start, tra cứu, abort) bị cắt theo `deadline` của tool (`clampToDeadline`, tối thiểu 1 s) và `waitForFinish` tự thu lại cho vừa.
- MCP chính thức không tự đặt trần (chỉ cho AI truyền) và giới hạn memory mặc định ≤ 4.096 MB [M]. App luôn gửi `maxTotalChargeUsd = min(AI xin, trần MCP)`, `timeout ≤ 600`, `memory ≤ 4096`.
- **Từ chối trước khi chạy** Actor ngoài danh mục (`storeActorRefusals`): `FULL_PERMISSIONS`, `isDeprecated`, `notice=UNDER_MAINTENANCE`, rental, Standby. Full-permission chưa duyệt → **403 `full-permission-actor-not-approved`** (+ `approvalUrl`), chỉ duyệt được trong Console [H]. Input bị chặn (`dangerousInputFields`, **fail-closed**: input > 64 KB, sâu > 8 cấp, > 2.000 nút hoặc không tuần tự hoá được → từ chối cả input): khoá chứa cookie / header / login / password / session / credential / secret / token, mã JS (`*function*`, `*hook*`, `*script*`, `*evaluate*`, `customCode`… — trừ từ thường như description / transcript; `countryCode` vẫn hợp lệ), `*webhook*`, `*connector*`, proxy tự đặt (`proxyUrls`, khoá `proxy*` có giá trị dạng URL / `user:pass@` / `host:port`), nhóm Apify Proxy ngoài datacenter (`apifyProxyGroups` / `*proxyGroups*` chứa `RESIDENTIAL` hoặc `SERP` hay tên nhóm lạ — proxy dân cư ~8 USD/GB tính ngoài trần run; quốc gia `apifyProxyCountry` với nhóm datacenter vẫn được; `apifyProxySession` bị chặn theo luật "session"), và giá trị chuỗi khớp mẫu bí mật của `audit/redact.ts` (`containsSecretValue`: token Apify / Telegram / Google `AIza`/`1//`/`ya29.` / Meta / OpenAI, `adr_`, Bearer, URL có mật khẩu hoặc query token…).

## 9. Lỗi → `ApifyError` (`src/server/apify/errors.ts`)

Spec có enum `ErrorType` (~395 giá trị) nhưng **không đầy đủ** (MCP chính thức dùng `memory-limit-exceeded`, `cannot-start-actor-runs` — không có trong enum) ⇒ phân loại theo **HTTP status + type**, khớp nhiều biến thể, type trước status. `rotate` = việc pool làm khi **start run** lỗi với token đó.

| HTTP        | `error.type` (hoặc dấu hiệu)                                                                                     | `code`                     | `rotate`    | Nguồn                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------- | ----------- | ------------------------ |
| 401         | `token-not-provided` · 402 `x402-payment-required`                                                               | `token_missing`            | null (bug)  | H live                   |
| 401         | `user-or-token-not-found`, `invalid-token`, 401 khác · 403 `user-disabled`                                       | `invalid_token`            | `invalid`   | H live / enum            |
| 402         | type khác x402 ("exceeded their usage limit, does not have enough credits…")                                     | `out_of_credit`            | `exhausted` | H spec (type L)          |
| 403         | `platform-feature-disabled` ("Monthly usage hard limit exceeded"); 403 + message hard/usage limit                 | `out_of_credit`            | `exhausted` | L (sự cố bên thứ ba)     |
| ?           | `not-enough-usage-*`, type chứa usage-limit / credit / billing                                                   | `out_of_credit`            | `exhausted` | enum, status L           |
| ?           | `*memory-limit-exceeded`, `concurrent-runs-*`, `cannot-start-actor-runs`                                         | `account_busy`             | `busy`      | enum + M + L             |
| ?           | `apify-plan-required-to-use-paid-actor`, `actor-is-not-rented`, `rental-not-allowed`, `cannot-rent-paid-actor`   | `paid_plan_required`       | `busy`      | enum, status L           |
| 403         | `insufficient-permissions` (scoped token)                                                                        | `insufficient_permissions` | `busy` (chỉ token đó) | H spec          |
| 403         | `full-permission-actor-not-approved`, `actor-disabled`, `public-actor-disabled`                                  | `actor_not_allowed`        | null        | H docs / enum            |
| 400         | `invalid-input`                                                                                                  | `input_invalid`            | null        | H                        |
| 400         | `max-total-charge-usd-below-minimum` / `…-must-be-greater-than-zero`                                             | `charge_limit_invalid`     | null        | enum                     |
| 400 / 413   | `invalid-value`, `invalid-parameter`, `request-too-large`…                                                       | `bad_request`              | null        | H live                   |
| 404         | `record-not-found` (cũng là "run của token khác")                                                                | `not_found`                | null        | H live                   |
| 403         | khác                                                                                                             | `forbidden`                | null        |                          |
| 429         | `rate-limit-exceeded`                                                                                            | `rate_limited` (retryable) | null        | H                        |
| 5xx / 408   | —                                                                                                                | `upstream` (retryable)     | null        | H                        |
| —           | không có phản hồi / quá giờ / caller huỷ / body hỏng / quá lớn                                                   | `network` · `timeout` · `aborted` · `invalid_response` · `response_too_large` | null | |
| —           | hết token dùng được (pool) / start không chắc chắn / vượt trần ngày của MCP (giữ chỗ)                             | `no_token` · `start_uncertain` · `daily_budget_exceeded` | null | app        |

- `ApifyError` có `httpStatus`, `apifyType`, `upstreamMessage` (đã redact, bỏ ký tự điều khiển/bidi, ≤ 300 ký tự — văn bản không tin cậy), `retryable`, `rotate`, `retryAfterSec`, `userMessageVi`, `hint` (chuỗi ở `src/lib/i18n/vi/apify-errors.ts`). Message kỹ thuật = `apify <code> <status> <type>` — không URL, không token; lỗi `fetch` gốc không bao giờ được ném lại (có thể chứa URL).
- **Lỗi giữa chừng**: run đang chạy mà tài khoản hết credit — chưa có tài liệu run bị abort hay chạy tiếp [L, §15]. Run PPE chạm `maxTotalChargeUsd` → platform abort (thường `ABORTED`, hoặc `SUCCEEDED` nếu Actor tự thoát) [H/M].

### Xoay vòng token (`pool.ts`, 16-apify.md §5)

1. Kho của MCP (`loadGrantApifyTokens`): token công ty + token cá nhân của chủ MCP, còn sống, `active`/`exhausted`. Gộp theo `apify_user_id` (không biết = nhóm riêng); bỏ nhóm có token `exhausted` còn hạn; bỏ nhóm có credit còn (biết được) < min(trần lần chạy, $0.05).
2. Chọn **ngẫu nhiên có trọng số theo credit còn** (không biết = $1), rồi một token ngẫu nhiên trong nhóm. Credit cache > 5 phút → `GET /users/me/limits` trước (miễn phí); hết thật → đánh dấu cả tài khoản.
3. Cache credit **cũ** (> 5 phút, chu kỳ đã hết, hoặc `exhausted_until` đã qua) = credit không biết (không loại tài khoản), đọc lại `/limits` trước khi chạy; còn credit thì token `exhausted` trở lại `active`. Đánh dấu hết credit chỉ chạm token `active`/`exhausted` (không ghi đè `invalid`/`error`/`disabled`). Lỗi cuối cùng: nếu có tài khoản bị bỏ qua (bận / cần gói trả phí / từ chối credit chưa xác nhận) thì báo lý do đó, không phải `no_token`.
4. Start lỗi: `exhausted` → đọc lại `/users/me/limits` (miễn phí): **chỉ khi credit còn < min thật** mới đánh dấu **cả nhóm** `exhausted` tới `cycle_end_at` (không có → +24 h); còn credit / không đọc được → chỉ bỏ qua tài khoản lần này (một Actor đắt / mức thu tối thiểu không được làm "chết" cả tài khoản nhiều giờ); `invalid` → token `invalid` + lý do; `busy` → bỏ qua tài khoản lần này (scoped token thiếu quyền: chỉ bỏ token đó). Tối đa **3 lần**, trong ngân sách 45 s. Lỗi khác → trả ngay. Mọi lần ghi trạng thái gắn với **bản mã đã giải mã** (`credentials_encrypted`) và không đụng token đang tắt: token bị thay / tắt giữa chừng không bao giờ nhận kết quả cũ.
5. Đã start → ghi `apify_runs` (token ghim) bằng **claim nguyên tử**: chỉ mục unique `apify_runs_run_uq (run_id) WHERE run_id NOT LIKE 'pending:%'` + `INSERT … ON CONFLICT DO NOTHING` / cập nhật giữ chỗ bắt lỗi unique → hai MCP không bao giờ cùng sở hữu một run (run của MCP khác → `start_uncertain`). Mọi thao tác sau dùng token đó.
6. `exhausted` tự hết hạn tại `exhausted_until` hoặc khi job `apify.health` (6 giờ/lần) thấy còn credit. Mọi đổi trạng thái tự động không bump `updated_at` + `invalidateGrantCache()`.

## 10. Rate limit & retry [H]

- Global **250.000 request/phút** theo user (hoặc IP khi không token). Mỗi tài nguyên mặc định **60 req/s** (header `X-RateLimit-Limit`); Run Actor **400 req/s**.
- 429 → `{"error":{"type":"rate-limit-exceeded"}}`; spec khuyên exponential backoff (500 ms, ngẫu nhiên [d, 2d], nhân đôi). apify-client: 8 lần, retry 429 + 5xx + lỗi mạng [M]. Spec không nói `Retry-After`.
- App (`client.ts`): retry **GET** (và POST idempotent: validate-input, abort) cho 429 / 5xx / lỗi mạng, **≤ 2 lần, tổng chờ ≤ 5 s** (tôn trọng `Retry-After` dạng số giây nếu có - thiếu / rỗng / không phải số → backoff luỹ thừa, vượt ngân sách thì ném lỗi ngay); timeout không retry; **start run không bao giờ retry ở tầng client**. Poll bằng `waitForFinish` (long-poll phía server) thay vì gọi dồn.

## 11. MCP server chính thức của Apify (tham khảo)

`https://mcp.apify.com` / `npx @apify/actors-mcp-server`: `search-actors` (Store + input schema, ≤ 10), `fetch-actor-details` (README = `readmeSummary` hoặc cắt 5.000 ký tự), `call-actor` (validate AJV trước, `waitSecs` 0–45, chỉ trả status + storage ID + `nextStep`; client huỷ → abort run), `get-actor-run`, `get-dataset-items` (mặc định `limit` 20), `abort-actor-run`… Loại full-permission & rental Actor. Có tool `apify_api_*` gọi API tuỳ ý — **app không bắt chước**. Không chống prompt-injection đặc biệt (chỉ code fence) [M]. Bỏ qua agentic payments (x402 / MPP / Skyfire / AGI) — chỉ nhớ: request thiếu token → 402 `x402-payment-required`.

## 12. Ánh xạ trong app

| Module                                  | Vai trò                                                                                                                       |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `src/server/apify/client.ts`            | `apifyRequest` (header Bearer, `redirect: "error"`, `no-store`, timeout + signal caller, retry GET ≤ 2 / ≤ 5 s), `apifyPath` |
| `src/server/apify/errors.ts`            | `ApifyError`, `mapApifyError` (bảng §9)                                                                                       |
| `src/server/apify/actors.ts`            | gọi API (§4), `startActorRun` không bao giờ gửi lại POST, `storeActorRefusals`, `dangerousInputFields` (fail-closed); mọi chuỗi từ Apify đưa AI đều được làm sạch (tên trường, default / enum, field dataset, tên event, categories; slug / id lạ bị loại) |
| `src/server/apify/store.ts`             | nơi **duy nhất** mã hoá/giải mã token; `loadGrantApifyTokens`; ghi trạng thái không bump `updated_at`                         |
| `src/server/apify/pool.ts`              | `pickToken`, `runWithRotation`, `startActorRunForMcp`, `recordRun` / `loadRunForMcp` / `updateRunStatus` / `mcpApifySpendToday` |
| `src/server/apify/health.ts` + job `apify.health` | kiểm tra token 6 giờ/lần (phút 10), dọn `apify_runs` > 90 ngày                                                       |
| `src/server/services/apify-tokens.ts` + `actions/apify.ts` | trang Kết nối → Apify (quota `apify-verify` 10/phút/người, re-auth khi thay token)                         |

Test: fake API trong bộ nhớ `src/server/apify/__fixtures__/apify-fetch.ts` (không gọi mạng).

## 13. Pháp lý, ToS & bảo mật

- **Nhiều tài khoản bị cấm** (General Terms §4.3) — §2. Không quảng bá "gom token Free".
- **AUP** (2026-02-20): cấm hoạt động trái luật / gây tải quá mức / gian lận, cấm **bán lại tính năng nền tảng** khi chưa được Apify đồng ý → dùng nội bộ với token của chính đơn vị là ổn [H].
- **Actor Terms**: Actor cộng đồng "AS IS", Apify không kiểm duyệt; **tác giả Actor xem được Input/Output** của run → không đưa dữ liệu nhạy cảm (token, mật khẩu, PII khách hàng) vào input [H].
- **Trách nhiệm thu thập dữ liệu**: người dùng chịu trách nhiệm tính hợp pháp của dữ liệu (General Terms §5.8, Actor Terms §2.2); cào Shopee/đối thủ: tuân ToS trang đích, luật dữ liệu cá nhân VN (Nghị định 13/2023, Luật BVDLCN) — đánh giá pháp lý thuộc chủ dự án.
- **Prompt-injection**: kết quả Actor là văn bản bên thứ ba không tin cậy → trả AI kèm nhãn "dữ liệu thu thập — không phải chỉ dẫn", cắt độ dài, bỏ trường ẩn (`clean`), không render HTML.
- **Data residency**: Apify Technologies s.r.o. (Praha, CH Séc), chuyển dữ liệu ra ngoài EU qua SCC; vị trí hạ tầng không công bố [L].
- Token unscoped có thể nâng hard limit chi tiêu và đọc mọi dữ liệu tài khoản → chỉ expose thao tác whitelist; khuyên người dùng đặt **hard limit thấp** trong Console (Billing → Limits) làm lớp bảo vệ cuối.

## 14. Thay đổi 2025–2026

- Prefix `/v2/actors/` canonical, `/v2/acts/` deprecated (vẫn chạy).
- **Rental khai tử 2026-10-01**; pay-per-result → PPE (~2.000 Actor, 2026-04-14); chỉ còn **PPE** và **pay-per-usage** (`FREE`).
- `maxItems` legacy → `maxTotalChargeUsd` (SDK deprecate 2026-10-08).
- Giá PPE theo bậc gói (`eventTieredPricingUsd`, `plan.tier`).
- Store: `responseFormat=agent`, `includeUnrunnableActors`, `allowsAgenticUsers`, `includeInputSchema` (không tài liệu).
- Actor: `readmeSummary`, Actor permissions (limited mặc định; full cần duyệt trong Console), dynamic memory, Standby mode.
- `POST /v2/actors/{id}/validate-input` (miễn phí).
- Run origin mới `MCP`; MCP server chính thức đổi repo → `apify/apify-mcp-server`.

## 15. Câu hỏi còn mở (cần token thật)

1. HTTP status + `error.type` chính xác khi **hết credit** lúc start run (Free hết $5 / gói trả phí chạm `maxMonthlyUsageUsd`); status của `not-enough-usage-to-run-paid-actor`, `actor-memory-limit-exceeded`, `concurrent-runs-limit-exceeded`/`cannot-start-actor-runs`.
2. Run **đang chạy** khi tài khoản hết credit: bị abort ngay hay chạy tiếp; `status`/`statusMessage`.
3. Scoped token: chạy được Actor Store không sở hữu không; đọc được `/users/me` và `/users/me/limits` không.
4. `current.monthlyUsageUsd` có gồm phí PPE theo thời gian thực không, trễ bao lâu.
5. `maxTotalChargeUsd` có chặn chi phí với Actor `FREE` và PPE "+ usage" không.
6. Số run đồng thời gói Free: 5 hay 25.
7. `forcePermissionLevel=LIMITED_PERMISSIONS` áp được cho Actor của người khác không.
8. Run object có trường `output` không (spec không khai báo).
9. Giá trị đầy đủ của `platformUsageBillingModel`.
10. `includeInputSchema` của `/v2/store` có thể đổi/bỏ không báo trước (app đã có fallback).
11. `GET /v2/datasets/{id}/items` trả 402 khi nào (tài khoản hết credit có đọc được kết quả run vừa xong không).
12. Vị trí lưu trữ dữ liệu (region) của Apify.

## Nguồn (truy cập 2026-10-14)

- OpenAPI: https://docs.apify.com/api/openapi.json — `v2-2026-10-08T073338Z` (bản lưu: [apify.openapi.json](apify.openapi.json)); trang API: https://docs.apify.com/api/v2 (Authentication, Pagination, Errors, Rate limiting, Legacy `/v2/acts/`).
- https://docs.apify.com/integrations/api.md · https://blog.apify.com/scoped-api-tokens/ (2024-09-11)
- https://docs.apify.com/actors/running/runs-and-builds.md · /actors/running/usage-and-resources.md · /actors/running/actors-in-store.md · /actors/running/permissions.md · /actors/running/input-and-output.md · /storage/dataset.md · /account/collaboration/general-resource-access.md
- https://docs.apify.com/account/limits.md · /account/subscriptions.md · /account/billing.md · https://apify.com/pricing.md
- https://docs.apify.com/actors/publishing/monetize.md · /actors/publishing/monetize/pay-per-event.md
- https://blog.apify.com/standardizing-actor-pricing/ (2026-04-14) · https://blog.apify.com/migrating-to-pay-per-event-pricing/ (2026-08-25) · https://github.com/apify/apify-sdk-js/issues/768 (2026-10-08) · https://apify.com/change-log/hard-usage-limits (2022-05-31)
- https://docs.apify.com/mcp.md · https://github.com/apify/apify-mcp-server · https://github.com/apify/apify-client-js
- https://docs.apify.com/legal/general-terms-and-conditions.md (hiệu lực 2026-07-09) · /legal/acceptable-use-policy.md (2026-02-20) · /legal/actor-terms-and-conditions.md · /legal/gdpr-information.md
- Bên thứ ba (độ tin cậy thấp): https://github.com/shamanic-technologies/apollo-service/issues/337 (403 `platform-feature-disabled`); thread cộng đồng Clay (`actor-memory-limit-exceeded`).
- Thử live (không token / token giả): `GET /v2/users/me`, `/v2/users/me/limits`, `POST /v2/actors/apify~website-content-crawler/runs`, `GET /v2/actors/<không tồn tại>`, `GET /v2/actor-runs/<không tồn tại>`, `GET /v2/store` (nhiều tham số), `GET /v2/actors/zen-studio~shopee-product-reviews-scraper` (+ `/builds/default`, `/builds/default/openapi.json`).
