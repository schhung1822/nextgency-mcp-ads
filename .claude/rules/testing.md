---
paths:
  - "**/*.test.ts"
  - "**/*.test.tsx"
  - "tests/**"
  - "vitest.config.*"
  - "playwright.config.*"
---

# Quy tắc test

- Unit/integration: **Vitest**, đặt cạnh file (`foo.ts` → `foo.test.ts`). E2E: **Playwright** trong `tests/e2e/`.
- Adapter nền tảng: mock HTTP bằng **MSW** với fixture JSON lấy từ response thật đã xoá dữ liệu nhạy cảm (`src/server/providers/<platform>/__fixtures__/`). Không gọi API thật trong test tự động; không commit token thật.
- Bắt buộc có test cho: quy đổi tiền (Meta offset 1/100, micros), chia cửa sổ ngày, map lỗi → `ProviderError`, chuẩn hoá metric, logic copy (map id, bỏ field read-only), redact, secret-box (mã hoá/giải mã/AAD sai → lỗi/xoay khoá), HMAC key MCP, kiểm tra grant (staff không chạm tài nguyên người khác), luồng xác nhận 2 bước (hết hạn, sai args, replay).
- DB test: Postgres thật qua docker (`docker compose up -d db`) với database riêng `adsmcp_test`; migrate trước khi chạy; dọn dữ liệu theo test.
- E2E tối thiểu: setup admin → bật 2FA → tạo staff → staff đăng nhập; tạo kết nối (provider mock) → tạo MCP → gọi `/mcp/<key>` bằng MCP client SDK → `tools/list` đúng theo quyền → log xuất hiện.
- Tên test mô tả hành vi: "trả 404 khi key đã bị xoay", "staff không thấy kết nối của người khác".
- Test phải xanh trước khi báo xong; nếu bỏ qua test nào, nói rõ lý do.
