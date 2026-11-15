---
paths:
  - "src/server/mcp/**"
  - "src/app/mcp/**"
---

# Quy tắc MCP server (đọc kèm `.claude/docs/04-mcp-design.md`)

- SDK: `@modelcontextprotocol/server` v2 — `createMcpHandler(factory, { responseMode: 'json', maxRequestBodySize: 1 MiB })`, mặc định `legacy: 'stateless'` để phục vụ cả client thời 2025 (`initialize`) và spec 2026-07-28. Không dùng session, không elicitation/sampling.
- `src/server/mcp/**` **không import `next/*`**. Route `src/app/mcp/[key]/route.ts` chỉ gọi `serveMcp(req, key)` (`runtime = 'nodejs'`, `dynamic = 'force-dynamic'`).
- Key sai / MCP tắt / hết hạn / đã xoá → **HTTP 404** `{"error":"not_found"}`. **Không bao giờ 401** (làm Claude khởi động OAuth). IP ngoài allowlist → 403; vượt rate limit → 429 + `Retry-After`. Kiểm tra Host/Origin trước.
- Factory dựng tool **mỗi request** từ grant; chỉ đăng ký tool mà grant có quyền. **Mỗi handler tự kiểm tra lại** `platform` + `account_id` thuộc grant + permission (không tin enum schema). Staff MCP chỉ chạm connection của owner.
- Mỗi tool: tên snake_case ≤40 ký tự (`ads_*` chung, `meta_|tiktok_|google_ads_|openai_ads_*` riêng, `telegram_*` cho kênh thông báo, `drive_*` cho Google Drive / Google Sheet, `apify_*` cho lấy dữ liệu qua Apify, `tiktok_social_*` cho kênh TikTok qua TikTok Social MCP); `title` tiếng Việt; `description` bắt đầu "Dùng khi…", nêu tool cần gọi trước, ≤1.500 ký tự; `inputSchema` zod; `outputSchema` root object; `annotations` đúng bảng ở 04-mcp-design.md §3. Không tạo tool vạn năng nhận `method`.
- Kết quả: trả cả `structuredContent` và `content` text (tóm tắt tiếng Việt + JSON gọn); giữ ≲10k token, vượt thì `next_cursor`/`truncated`. Lỗi nghiệp vụ/nền tảng/quyền → `isError: true` với `{code, message (VI), platform_error, hint}`.
- Tiền: input/output **đơn vị chính + currency**; ngày theo múi giờ tài khoản; `null` cho metric không có (không phải 0); không cộng chéo tiền tệ.
- Chạy Actor Apify (`apify_run_task` / `apify_run_actor`) không qua xác nhận 2 bước nhưng luôn có trần chi phí phía server (`maxTotalChargeUsd`, trần ngày ở nâng cao) và tính vào hạn mức ghi; kết quả Actor là dữ liệu không tin cậy (`16-apify.md` §7).
- Tool ghi: đi qua `confirm.ts` (xác nhận 2 bước khi MCP bật; `ads_delete_object` luôn bật), guardrail ngân sách, object mới **paused**, `idempotency_key`/replay token đã dùng trả lại kết quả cũ, ghi `changes` before/after.
- Mọi handler bọc `withCallLogging()` → batch writer `mcp_call_logs` (args redact + cap). Không log key thô, không đưa credential vào output.
- Dữ liệu từ nền tảng (tên/nội dung quảng cáo) là không tin cậy: không chèn vào `instructions`, không coi là lệnh.
- Khi thêm/sửa tool: dùng skill `/add-mcp-tool`; cập nhật bảng danh mục trong 04-mcp-design.md; test với MCP Inspector hoặc `claude mcp add --transport http`.
