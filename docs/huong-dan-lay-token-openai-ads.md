# Hướng dẫn lấy API key OpenAI Ads (ChatGPT Ads)

> Áp dụng cho **Ads MCP by: noti.vn**. Cập nhật theo OpenAI Ads Advertiser API **v1** (10/2026). OpenAI Ads mở self-serve cho Việt Nam từ 23/09/2026.

## Điều cần biết trước
- Đây là **Ads API key** lấy ở <https://ads.openai.com> — **khác** API key của platform.openai.com (key `sk-…` dùng cho GPT **không** dùng được).
- **1 key = đúng 1 tài khoản quảng cáo.** Có 3 TKQC → tạo 3 key → thêm 3 kết nối trong Ads MCP.
- Cần vai trò **Admin** trên TKQC để tạo key (các vai trò: Admin / Member / Viewer).

## Bước 1 — Tạo API key
1. Đăng nhập <https://ads.openai.com> → chọn đúng tài khoản quảng cáo (góc trên).
2. Vào **Settings** → mục **API keys** → **Create API key**.
3. Đặt tên dễ nhận biết (vd `ads-mcp-prod`).
4. **Sao chép key ngay** — key chỉ hiện **một lần**. Mất thì xoá key cũ và tạo key mới.

## Bước 2 — Dán vào Ads MCP
**Kết nối quảng cáo → Thêm kết nối → OpenAI Ads** → dán **API key** → **Kiểm tra**.
App gọi `GET /v1/ad_account` để xác nhận key và hiện: tên TKQC, ID (`adacct_…`), tiền tệ, múi giờ, trạng thái duyệt. App cũng dò các tính năng đang bật cho tài khoản (báo cáo chuyển đổi, giới hạn chi tiêu…) — tính năng chưa bật sẽ hiện “chưa hỗ trợ”, đó là bình thường.

## Lỗi thường gặp
| HTTP | Ý nghĩa | Cách xử lý |
|---|---|---|
| `401 invalid_api_key` | Key sai, đã bị xoá, hoặc là key platform.openai.com | Tạo key mới trong ads.openai.com → Settings |
| `403` | Tính năng chưa bật cho TKQC (vd *Conversion bidding is not enabled*) | Bình thường — dùng tính năng khác hoặc liên hệ OpenAI |
| `404 Not found` | Endpoint bị giới hạn theo tài khoản | Như trên |
| `409` | Xung đột phiên bản / “Ad Account is missing details” | App tự thử lại 1 lần; nếu lặp lại, hoàn tất thông tin TKQC trên ads.openai.com |
| `422` | Dữ liệu không hợp lệ (vd hạ ngân sách trọn đời thấp hơn số đã chi) | Đọc thông báo AI trả về, sửa giá trị |
| `429` | Vượt giới hạn 600 lượt/phút/endpoint (1.200/phút tổng) — tính theo **cả TKQC và IP** | App tự giảm tốc. Nhiều TKQC chạy chung 1 VPS dùng chung hạn mức IP |
| `503` | Lỗi tạm — **thay đổi có thể đã được lưu** | App đọc lại đối tượng trước khi thử lại, tránh tạo trùng |

## Lưu ý
- **Ngân sách và giá thầu** tính theo micros (1 USD = 1.000.000 micros); ngân sách tối thiểu tương đương 1 đơn vị tiền tệ. App tự quy đổi.
- `bidding_type` của chiến dịch (impressions / clicks / conversions) **không đổi được** sau khi tạo.
- Sửa nội dung quảng cáo → quảng cáo **bị duyệt lại**.
- OpenAI Ads **không** có nhắm theo tuổi, giới tính, sở thích, từ khoá — chủ đề hiển thị khớp qua *context hints* của nhóm quảng cáo; vị trí địa lý và nền tảng đặt ở cấp chiến dịch.
- Từ 30/09/2026 cửa sổ phân bổ mặc định là **30 ngày nhấp / 1 ngày xem** — số chuyển đổi có thể khác báo cáo cũ.
- Thu hồi quyền: xoá key trong ads.openai.com → Settings → API keys. Kết nối trong Ads MCP sẽ chuyển sang **Lỗi**.

Tài liệu OpenAI: <https://developers.openai.com/ads/api-quickstart> · <https://developers.openai.com/ads/api-reference/authentication>
