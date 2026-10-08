# Chính sách bảo mật — Ads MCP by: noti.vn

Ads MCP giữ token có toàn quyền chi tiền trên tài khoản quảng cáo. Chúng tôi coi mọi báo cáo lỗ hổng là ưu tiên cao.

## Báo cáo lỗ hổng
**Không mở issue, pull request hay thảo luận công khai** cho vấn đề bảo mật.

Gửi báo cáo **riêng tư** cho noti.vn qua một trong các kênh:
1. GitHub: tab **Security → Report a vulnerability** của kho `notivn/Ads-MCP-simple` (Private vulnerability reporting).
2. Kênh liên hệ chính thức tại <https://noti.vn> — ghi rõ tiêu đề “[Security] Ads MCP”.

Nội dung nên có: phiên bản/commit, mô tả, các bước tái hiện, ảnh hưởng (vd lộ token, vượt quyền giữa nhân viên, bỏ qua xác nhận 2 bước, đọc được key MCP từ log), và đề xuất khắc phục nếu có. **Không** gửi token, key MCP hay dữ liệu thật của khách hàng — dùng dữ liệu giả hoặc che bớt.

## Cam kết phản hồi
- Xác nhận đã nhận: trong **3 ngày làm việc**.
- Đánh giá mức độ và kế hoạch xử lý: trong **10 ngày làm việc**.
- Bản vá cho lỗi nghiêm trọng được thông báo tới các đơn vị được cấp quyền trước khi công bố chi tiết.

Vui lòng cho chúng tôi thời gian hợp lý để phát hành bản vá trước khi công bố. Chỉ kiểm thử trên hệ thống do chính bạn vận hành; không tấn công hệ thống của đơn vị khác hay tài khoản quảng cáo không thuộc quyền của bạn.

## Phạm vi hỗ trợ
Chỉ phiên bản phát hành mới nhất (nhánh `main` / tag `v*` mới nhất) nhận bản vá bảo mật. Đơn vị vận hành nên cập nhật thường xuyên (admin bấm **Cập nhật** trong web, hoặc chạy tay theo `docs/deploy-vps.md` §11).

## Khi nghi ngờ bị lộ thông tin
1. **Key MCP lộ**: trang MCP → **Bảo mật → Xoay key** (link cũ chết ngay) và xem **Nhật ký MCP** để kiểm tra lượt gọi lạ.
2. **Token nền tảng lộ**: thu hồi ngay trên Meta/TikTok/Google/OpenAI, tạo token mới, dán lại vào kết nối.
   **Bot token Telegram lộ**: mở @BotFather → `/revoke` để lấy token mới, rồi **Thay token** ở trang kênh Telegram trong Ads MCP.
3. **`.env` lộ**: xoay `ENCRYPTION_KEYS` (xem `docs/van-hanh.md`), đổi `MCP_KEY_PEPPER` (mọi link MCP chết — xoay key từng MCP), đổi `BETTER_AUTH_SECRET` (mọi phiên bị đăng xuất), đổi `POSTGRES_PASSWORD`, và thu hồi toàn bộ token nền tảng (kể cả bot token Telegram).

---

**English:** Please report security vulnerabilities **privately** via GitHub *Security → Report a vulnerability* on `notivn/Ads-MCP-simple` or through the official contact at <https://noti.vn> (subject “[Security] Ads MCP”). Do not open public issues and do not include real tokens or customer data. We acknowledge within 3 business days.
