---
name: add-mcp-tool
description: Quy trình thêm hoặc sửa một tool MCP (chung `ads_*`, riêng nền tảng `meta_*|tiktok_*|google_ads_*|openai_ads_*`, kênh thông báo `telegram_*`, hoặc Google Drive / Google Sheet `drive_*`) — schema, quyền, annotations, kiểm tra grant, adapter, xác nhận 2 bước, log, test, cập nhật tài liệu. Dùng mỗi khi tạo/sửa file trong src/server/mcp/tools/.
argument-hint: "<tool_name> [mô tả ngắn]"
---

# Thêm / sửa tool MCP: `$ARGUMENTS`

Đọc trước: `.claude/docs/04-mcp-design.md` (§3–6), file nền tảng liên quan trong `.claude/docs/providers/`, `src/server/mcp/registry.ts`.

## 1. Thiết kế (viết ra trước khi code)
- Tên snake_case ≤40 ký tự, đúng tiền tố. Có trùng chức năng tool hiện có không? (ưu tiên mở rộng tool chung hơn là thêm tool mới; tổng tool một MCP nên ≤40).
- Quyền cần (`read|status|update|copy|create|delete`) và nền tảng áp dụng.
- Input: `platform`, `account_id` (string — không enum), `level`, tham số riêng; tiền = đơn vị chính; ngày `YYYY-MM-DD`/preset. Output: object, có `currency`, `warnings`, `next_cursor` nếu liệt kê.
- Annotations theo bảng §3. Ghi hay đọc? Có cần xác nhận 2 bước / guardrail ngân sách?
- Capability từng nền tảng: native / emulated / gated / unsupported → unsupported thì trả `isError` với giải thích, không giả vờ.

## 2. Code
1. Adapter: thêm/sửa method trong `src/server/providers/<platform>/` (đọc tài liệu nền tảng; không code endpoint theo trí nhớ). Test adapter với fixture MSW.
2. Tool: `src/server/mcp/tools/<common|platform>/<tool>.ts` — `register(server, ctx)` với `title` (VI), `description` ("Dùng khi…", tool cần gọi trước), `inputSchema` zod, `outputSchema`, `annotations`.
3. Handler: `assertGrant(ctx.grant, { platform, accountId, permission })` **đầu tiên** → (ghi) `confirmOrPreview()` → giải mã credential trong phạm vi request → adapter → chuẩn hoá → trả `structuredContent` + `content` text ngắn. Lỗi → `toToolError()` (`isError: true`, message VI + hint).
4. Bọc `withCallLogging()` (platform, account, object_ids, action_kind, `changes` before/after cho ghi).
5. Đăng ký trong `registry.ts` với `permission` + `platform` đúng để chỉ hiện khi grant cho phép.

## 3. Test
- Unit: grant từ chối account/platform/quyền ngoài phạm vi; validate input; map lỗi; (ghi) preview → confirm → replay trả kết quả cũ; guardrail.
- Thử thật qua MCP client (Inspector / Claude Code) với connection dev: `tools/list` có/không có tool theo quyền; gọi tool đọc; tool ghi chỉ trên object thử nghiệm được chủ dự án cho phép.

## 4. Tài liệu
- Cập nhật bảng danh mục tool ở `.claude/docs/04-mcp-design.md` §4 (và bảng map trong `providers/<platform>.md` §"Map sang tool MCP").
- Nếu thêm quyền/khả năng mới ảnh hưởng UI wizard → cập nhật `01-product-spec.md` §4.
- Chạy `/verify`.
