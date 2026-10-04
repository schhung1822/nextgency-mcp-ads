---
paths:
  - "src/server/providers/**"
---

# Quy tắc provider adapter (đọc file nền tảng tương ứng trong `.claude/docs/providers/` TRƯỚC khi sửa)

- `src/server/providers/**` **không import `next/*`**, không truy cập DB trực tiếp (nhận credential/account qua `ProviderContext`). Implement interface `AdsProvider` (02-architecture.md §4); khai báo `capabilities` trung thực (`native|emulated|gated|unsupported`).
- **Không code endpoint theo trí nhớ.** Đọc `providers/<platform>.md`; OpenAI: grep `openai-ads.openapi.json`. Nghi ngờ / tài liệu cũ → `/provider-api-check <platform>`.
- Version API là hằng số đọc env: `META_API_VERSION` (v26.0), OpenAI v1.
- HTTP qua `http.ts`: `fetch` + `AbortSignal.timeout(60_000)` kết hợp signal request; retry có jitter **chỉ** cho lỗi retryable theo bảng lỗi của nền tảng; token bucket theo (platform, app/account/IP); đọc header usage (Meta `X-Business-Use-Case-Usage`…) để giảm tốc; log request id nền tảng.
- Create/copy: **không retry mù** sau timeout — dùng idempotency (OpenAI `Idempotency-Key`) hoặc kiểm tra tồn tại trước (Meta). OpenAI 503 trên thao tác ghi → GET lại trước khi retry.
- Tiền qua `money.ts`: Meta minor units theo offset tiền tệ (**VND = 1**, USD = 100); OpenAI budget/bid = micros (BigInt/integer, không float); báo cáo OpenAI/Meta insights trả đơn vị chính.
- Ngày: theo múi giờ tài khoản (`dates.ts`).
- Gotcha bắt buộc nhớ:
  - Meta: create mặc định ACTIVE → luôn `status=PAUSED`; `is_adset_budget_sharing_enabled` khi ABO; luôn gửi `targeting_automation.advantage_audience`; attribution `7d_view/28d_view` trả rỗng — không dùng; deep copy sync ≤3 ad.
  - OpenAI: 1 key = 1 account; update gửi lại object/list đầy đủ; luôn gửi `fields[]` cho insights; không có xoá (archive không hoàn tác) và không có copy native; rate limit cả theo IP.
- Lỗi chuẩn hoá thành `ProviderError` (code, retryable, `userMessageVi`, `hint`, upstream code/subcode/message/requestId). Không để token lọt vào message lỗi.
- Test: Vitest + MSW với fixture JSON thật (đã xoá dữ liệu nhạy cảm) cho từng endpoint; test quy đổi tiền, chia cửa sổ ngày, map lỗi, logic copy.
