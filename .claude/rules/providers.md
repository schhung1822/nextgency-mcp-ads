---
paths:
  - "src/server/providers/**"
---

# Quy tắc provider adapter (đọc file nền tảng tương ứng trong `.claude/docs/providers/` TRƯỚC khi sửa)

- `src/server/providers/**` **không import `next/*`**, không truy cập DB trực tiếp (nhận credential/account qua `ProviderContext`). Implement interface `AdsProvider` (02-architecture.md §4); khai báo `capabilities` trung thực (`native|emulated|gated|unsupported`).
- **Không code endpoint theo trí nhớ.** Đọc `providers/<platform>.md`; OpenAI: grep `openai-ads.openapi.json`. Nghi ngờ / tài liệu cũ → `/provider-api-check <platform>`.
- Version API là hằng số đọc env: `META_API_VERSION` (v26.0), `GOOGLE_ADS_API_VERSION` (v25), `TIKTOK_API_VERSION` (v1.3; `TIKTOK_BASE_URL` tuỳ chọn để trỏ sandbox, chỉ https), OpenAI v1.
- HTTP qua `http.ts`: `fetch` + `AbortSignal.timeout(60_000)` kết hợp signal request; retry có jitter **chỉ** cho lỗi retryable theo bảng lỗi của nền tảng; token bucket theo (platform, app/account/IP); đọc header usage (Meta `X-Business-Use-Case-Usage`…) để giảm tốc; log request id nền tảng.
- Create/copy: **không retry mù** sau timeout — dùng idempotency (TikTok `request_id`, OpenAI `Idempotency-Key`) hoặc kiểm tra tồn tại trước (Meta/Google). OpenAI 503 trên thao tác ghi → GET lại trước khi retry.
- Tiền qua `money.ts`: Meta minor units theo offset tiền tệ (**VND = 1**, USD = 100); Google & OpenAI budget/bid = micros (BigInt/integer, không float); báo cáo OpenAI/TikTok/Meta insights trả đơn vị chính; Google `cost_micros` ÷ 1e6.
- Ngày: theo múi giờ tài khoản (`dates.ts`); TikTok báo cáo ngày ≤30 ngày/lần → tự chia cửa sổ; TikTok lịch ad group UTC; Google `start_date_time` giờ account.
- Gotcha bắt buộc nhớ:
  - Meta: create mặc định ACTIVE → luôn `status=PAUSED`; `is_adset_budget_sharing_enabled` khi ABO; luôn gửi `targeting_automation.advantage_audience`; attribution `7d_view/28d_view` trả rỗng — không dùng; deep copy sync ≤3 ad.
  - TikTok: header `Access-Token`, URL phải có `/` cuối, luôn kiểm tra `code` trong body (HTTP gần như luôn 200), create mặc định ENABLE → gửi `DISABLE`, `/adgroup/update/` là full replacement (GET→merge→gửi đủ; ad group đã chạy thì bỏ `schedule_start_time` quá khứ), route theo `campaign_automation_type` (Smart+ dùng `current_budget`), tạo chiến dịch Manual qua `/campaign/create/` ngừng từ 2026-12-31. Token advertiser không hết hạn; đổi `auth_code` ngay (sống ≤1 giờ, dùng 1 lần).
  - Google (gồm YouTube): **không gửi `developer-token`** (bỏ từ 2026-09-09); `login-customer-id` khi qua MCC; `updateMask` xoá field thiếu trong body; campaign mới cần `contains_eu_political_advertising`; Search không còn nhắm ngôn ngữ thủ công (từ 2026-09-30); chiến dịch VIDEO (YouTube) chỉ đọc — từ chối mọi thao tác ghi; budget shared → cảnh báo; không có copy native.
  - OpenAI: 1 key = 1 account; update gửi lại object/list đầy đủ; luôn gửi `fields[]` cho insights; không có xoá (archive không hoàn tác) và không có copy native; rate limit cả theo IP.
- Lỗi chuẩn hoá thành `ProviderError` (code, retryable, `userMessageVi`, `hint`, upstream code/subcode/message/requestId). Không để token lọt vào message lỗi.
- Test: Vitest + MSW với fixture JSON thật (đã xoá dữ liệu nhạy cảm) cho từng endpoint; test quy đổi tiền, chia cửa sổ ngày, map lỗi, logic copy.
