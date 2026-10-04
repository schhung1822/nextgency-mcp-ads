---
paths:
  - "src/server/audit/**"
  - "src/server/crypto/**"
  - "src/server/env.ts"
  - "scripts/worker.ts"
  - "src/instrumentation.ts"
---

# Quy tắc log & bí mật (đọc kèm `.claude/docs/05-security.md` §3–5 và `03-database-schema.md` §3–5)

- Mã hoá: AES-256-GCM, keyring `ENCRYPTION_KEYS` (`ver:base64`, key đầu active), IV 12 byte ngẫu nhiên, **AAD bắt buộc** (`connection:<id>:credentials`, `mcp:<id>:key`), định dạng `v<ver>.<iv>.<tag>.<ct>`. Không tự chế thuật toán; không dùng ECB/CBC; không tái dùng IV.
- Key MCP: `amcp_` + 32 byte random base64url; lưu HMAC-SHA256 với `MCP_KEY_PEPPER` + prefix 12 ký tự + bản mã hoá. So sánh secret bằng `timingSafeEqual`.
- `env.ts`: validate bằng zod ở runtime, thiếu biến → throw thông báo rõ; không export secret ra client; không dùng `NEXT_PUBLIC_*` cho secret/config deploy.
- Redact (`redact.ts`) **trước** mọi lần ghi log/stdout: theo tên khoá nhạy cảm + mẫu giá trị (Meta `EAA…`, OpenAI `sk-…`, `Bearer …`, private key PEM, `amcp_…`). Cap kích thước bằng `capJson()` (16 KB request / 32 KB response).
- `activity_logs`: ghi đồng bộ trong transaction nghiệp vụ. `mcp_call_logs`: batch writer singleton (1 s / 200 dòng, buffer ≤10k, đếm dòng bị bỏ), `synchronous_commit=off` chỉ cho batch log; flush khi SIGTERM qua `instrumentation.ts`.
- Log là append-only: không có code UPDATE/DELETE dòng log (ngoài drop partition theo retention).
- Worker (pg-boss): `createQueue` trước `schedule`; cron có `tz: APP_TIMEZONE`; job idempotent; `logs.maintain` dùng `SET LOCAL lock_timeout='5s'`; retention đọc từ `app_settings` (mặc định 3 tháng, 1–24); dừng graceful khi SIGTERM.
