# 13 - Thông báo hệ thống (chỉ top bar web)

> Yêu cầu chủ dự án (2026-10-04): 1 giờ/lần hệ thống GET webhook noti.vn, có `content` thì chạy chữ lặp nối đuôi ở top bar (giữa breadcrumb và ô tìm kiếm).
>
> **Quyết định chủ dự án 2026-10-05**: thông báo hệ thống **chỉ hiện trên top bar web**. Kết quả MCP trong chat AI **không** kèm thông báo hệ thống, cũng **không** kèm dòng nhắc cập nhật ("Ads MCP Simple có bản update…") - bản 1.0.1 từng kèm cả hai, đã gỡ (xem §4).

## 1. Luồng

```
worker job notices.fetch (phút 10 mỗi giờ + 1 lần khi worker khởi động, singleton 10 phút)
  └─ GET SYSTEM_NOTICES_URL (mặc định webhook noti.vn) → parse + làm sạch → app_settings.system_notices
web (dashboard layout) ── getActiveNotices() (cache 60 s/process) ──► AppShell → NoticeTicker (top bar)
```

Không có migration: dùng bảng `app_settings` (khoá nội bộ, không nằm trong form Cài đặt).

## 2. Webhook & dữ liệu

- Trả về hôm nay: `{"Id":1,"CreatedAt":…,"UpdatedAt":…,"content":"Test","status":"on"}`. Chấp nhận: 1 object, mảng object, hoặc `{list|data|items|rows|records|notices: [...]}`.
- Mỗi dòng cần `content` (string). `status` = off/false/0/disabled/inactive/hidden/tắt → ẩn; không có `status` → hiện. Bỏ content rỗng, trùng lặp; tối đa **10** thông báo, mỗi thông báo **300** ký tự, 1 dòng (xoá xuống dòng, ký tự điều khiển, zero-width, bidi override).
- HTTP 204/404/body rỗng = không có thông báo (xoá). Lỗi (5xx, timeout 10 s, JSON hỏng, > 64 KB, lỗi mạng) → **giữ danh sách cũ tối đa 24 giờ** rồi ẩn; không throw, giờ sau thử lại. Không theo redirect.
- `app_settings.system_notices` = `{ items: [{id, content}], fetchedAt, lastSuccessAt, error }`.
- `SYSTEM_NOTICES_URL`: không đặt = webhook noti.vn; rỗng/`off`/`false`/`0` = tắt hẳn (không gọi, không hiển thị); giá trị khác phải là URL `https://` không kèm user:pass, sai → tắt.

### Khi webhook "chết" (hệ thống vẫn chạy bình thường)
- **Chỉ worker** gọi webhook (1 lần/giờ, timeout 10 s cho cả header lẫn body, không retry dồn dập). Web và trang quản trị **chỉ đọc bản đã lưu trong DB** (cache 60 s); MCP không đọc thông báo → webhook chậm/sập/sai định dạng không làm chậm hay lỗi bất kỳ request nào.
- Sập (lỗi mạng, DNS, timeout, 5xx, trang lỗi HTML, JSON hỏng) → giữ thông báo cũ tối đa 24 h rồi tự ẩn; 404/204/rỗng → coi như không có thông báo. Job ghi lỗi vào `system_notices.error` + log worker, không throw.

## 3. Giao diện (`components/app/notice-ticker.tsx`)

- Desktop/tablet: viên pill nền `brand-red/6%` + icon loa trong top bar, chiếm khoảng trống giữa breadcrumb (tối đa 45%) và ô tìm kiếm → không đè menu. Phone: dải cao `h-11` dưới thanh 3.5rem trong cùng header sticky (`--app-topbar-offset` tăng tương ứng để thanh lưu/khung hướng dẫn không bị che).
- Chạy phải → trái tốc độ 45 px/s, 2 bản sao, mỗi bản ≥ bề rộng khung → lặp liền mạch, thông báo nối đuôi nhau, thông báo ngắn chạy một mình (không lặp dày). Dừng khi hover/focus; `prefers-reduced-motion` → đứng yên. Hai mép mờ dần (mask). Screen reader đọc danh sách 1 lần (`role=region`, `aria-label="Thông báo hệ thống"`), bản chạy `aria-hidden`; `title` chứa toàn bộ nội dung.
- Mọi người dùng đã đăng nhập (admin + nhân viên) đều thấy. Nội dung render như text (React escape), không bao giờ HTML/link.

## 4. MCP: không kèm thông báo

- MCP không kèm thông báo hệ thống hay dòng nhắc cập nhật (quyết định chủ dự án 2026-10-05, lý do: nội dung webhook bên ngoài không được đi vào ngữ cảnh AI — chống prompt injection). Kết quả tool (thành công và lỗi) chỉ gồm nội dung của chính tool; server instructions không nhắc tới thông báo.
- Đã gỡ ở bản sửa bảo mật sau 1.0.1: `src/server/mcp/notices.ts`, phần gắn trong `registerToolSpec` (`tool.ts`), `buildMcpNoticeText` / `MCP_UPDATE_NOTICE` (`src/lib/system-notices.ts`) và câu dặn AI trong `instructions.ts`. Bản cập nhật mới vẫn xem được trên web (Cài đặt → Cập nhật), không liên quan MCP.

## 5. Kiểm thử

`src/lib/system-notices.test.ts` (parse/sanitize), `src/server/jobs/lib/system-notices.test.ts` (URL, fetch lỗi/timeout/quá lớn, giữ 24 h, DB + cache), `src/server/mcp/__tests__/flows/notices.flows.test.ts` (hồi quy qua endpoint thật: đang có bản update + 2 thông báo → kết quả tool thành công và lỗi đều chỉ có nội dung của tool), `src/server/mcp/__tests__/unit.test.ts` (server instructions không nhắc thông báo). Vitest mặc định `SYSTEM_NOTICES_URL=""` (vitest.setup.ts) để test khác không bị ảnh hưởng.
