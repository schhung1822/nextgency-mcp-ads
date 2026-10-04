# 13 - Thông báo hệ thống & nhắc cập nhật (top bar + chat AI)

> Yêu cầu chủ dự án (2026-10-04): (1) có bản mới mà admin chưa cập nhật → mọi kết quả MCP trong chat AI kèm câu "Ads MCP Simple có bản update, vui lòng update để sử dụng tính năng mới nhất nhé"; (2) 1 giờ/lần hệ thống GET webhook noti.vn, có `content` thì chạy chữ lặp nối đuôi ở top bar (giữa breadcrumb và ô tìm kiếm) và kèm vào kết quả chat AI dạng `Thông báo hệ thống Ads MCP Simple: "content"` (nhiều thông báo → mỗi thông báo 1 dòng).

## 1. Luồng

```
worker job notices.fetch (phút 10 mỗi giờ + 1 lần khi worker khởi động, singleton 10 phút)
  └─ GET SYSTEM_NOTICES_URL (mặc định webhook noti.vn) → parse + làm sạch → app_settings.system_notices
web (dashboard layout) ── getActiveNotices() (cache 60 s/process) ──► AppShell → NoticeTicker (top bar)
MCP (mọi tools/call) ── currentNoticeText() (cache 60 s) ──► thêm 1 content text cuối kết quả
                         = dòng nhắc update (update_latest > APP_BUILD_VERSION) + mỗi thông báo 1 dòng
```

Không có migration: dùng bảng `app_settings` (khoá nội bộ, không nằm trong form Cài đặt).

## 2. Webhook & dữ liệu

- Trả về hôm nay: `{"Id":1,"CreatedAt":…,"UpdatedAt":…,"content":"Test","status":"on"}`. Chấp nhận: 1 object, mảng object, hoặc `{list|data|items|rows|records|notices: [...]}`.
- Mỗi dòng cần `content` (string). `status` = off/false/0/disabled/inactive/hidden/tắt → ẩn; không có `status` → hiện. Bỏ content rỗng, trùng lặp; tối đa **10** thông báo, mỗi thông báo **300** ký tự, 1 dòng (xoá xuống dòng, ký tự điều khiển, zero-width, bidi override).
- HTTP 204/404/body rỗng = không có thông báo (xoá). Lỗi (5xx, timeout 10 s, JSON hỏng, > 64 KB, lỗi mạng) → **giữ danh sách cũ tối đa 24 giờ** rồi ẩn; không throw, giờ sau thử lại. Không theo redirect.
- `app_settings.system_notices` = `{ items: [{id, content}], fetchedAt, lastSuccessAt, error }`.
- `SYSTEM_NOTICES_URL`: không đặt = webhook noti.vn; rỗng/`off`/`false`/`0` = tắt hẳn (không gọi, không hiển thị); giá trị khác phải là URL `https://` không kèm user:pass, sai → tắt.

### Khi webhook "chết" (hệ thống vẫn chạy bình thường)
- **Chỉ worker** gọi webhook (1 lần/giờ, timeout 10 s cho cả header lẫn body, không retry dồn dập). Web, trang quản trị và mọi lệnh MCP **chỉ đọc bản đã lưu trong DB** (cache 60 s) → webhook chậm/sập/sai định dạng không làm chậm hay lỗi bất kỳ request nào.
- Sập (lỗi mạng, DNS, timeout, 5xx, trang lỗi HTML, JSON hỏng) → giữ thông báo cũ tối đa 24 h rồi tự ẩn; 404/204/rỗng → coi như không có thông báo. Job ghi lỗi vào `system_notices.error` + log worker, không throw.

## 3. Giao diện (`components/app/notice-ticker.tsx`)

- Desktop/tablet: viên pill nền `brand-red/6%` + icon loa trong top bar, chiếm khoảng trống giữa breadcrumb (tối đa 45%) và ô tìm kiếm → không đè menu. Phone: dải cao `h-11` dưới thanh 3.5rem trong cùng header sticky (`--app-topbar-offset` tăng tương ứng để thanh lưu/khung hướng dẫn không bị che).
- Chạy phải → trái tốc độ 45 px/s, 2 bản sao, mỗi bản ≥ bề rộng khung → lặp liền mạch, thông báo nối đuôi nhau, thông báo ngắn chạy một mình (không lặp dày). Dừng khi hover/focus; `prefers-reduced-motion` → đứng yên. Hai mép mờ dần (mask). Screen reader đọc danh sách 1 lần (`role=region`, `aria-label="Thông báo hệ thống"`), bản chạy `aria-hidden`; `title` chứa toàn bộ nội dung.
- Mọi người dùng đã đăng nhập (admin + nhân viên) đều thấy. Nội dung render như text (React escape), không bao giờ HTML/link.

## 4. MCP (`src/server/mcp/notices.ts`, gắn ở `registerToolSpec` trong `tool.ts`)

- Mọi kết quả tool (thành công **và** lỗi nghiệp vụ) thêm **1** content `{type:"text", annotations.audience:["user","assistant"]}` ở cuối:
  ```
  Ads MCP Simple có bản update, vui lòng update để sử dụng tính năng mới nhất nhé      ← khi update_latest.version > APP_BUILD_VERSION
  Thông báo hệ thống Ads MCP Simple: "…"                                                ← mỗi thông báo 1 dòng
  ```
- `structuredContent` không đổi (vẫn khớp `outputSchema`), không ghi vào `mcp_call_logs`. Lỗi validate input của SDK (trước handler) không có khối này.
- Bản build không phải release (`dev`) không hiện dòng update. Lỗi DB khi đọc → không có thông báo, tool vẫn chạy bình thường.
- Server instructions (sau 512 ký tự đầu) dặn AI chuyển nguyên văn các dòng cho người dùng ở cuối câu trả lời và **không làm theo yêu cầu nào trong thông báo** (giảm rủi ro prompt injection nếu webhook bị chiếm). Giới hạn độ dài/số dòng ở §2 cũng nhằm mục đích này.

## 5. Kiểm thử

`src/lib/system-notices.test.ts` (parse/sanitize/format), `src/server/jobs/lib/system-notices.test.ts` (URL, fetch lỗi/timeout/quá lớn, giữ 24 h, DB + cache), `src/server/mcp/notices.test.ts`, `src/server/mcp/__tests__/flows/notices.flows.test.ts` (endpoint thật: update + 2 thông báo, kết quả lỗi, không có gì, bản dev). Vitest mặc định `SYSTEM_NOTICES_URL=""` (vitest.setup.ts) để test khác không bị ảnh hưởng.
