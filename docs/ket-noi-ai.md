# Kết nối MCP với Claude, ChatGPT, Gemini

> Áp dụng cho **Ads MCP by: noti.vn** (10/2026). Giao diện các AI thay đổi thường xuyên — nếu tên menu khác, tìm mục *Connectors / Apps / MCP*.

## Trước khi bắt đầu
1. Tạo MCP trong Ads MCP (**MCP → Tạo MCP**), sao chép link dạng:
   ```
   https://mcp.congty.vn/mcp/amcp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```
   Xem lại link sau này: trang MCP → tab **Kết nối AI** → **Xem lại link** (phải nhập lại mật khẩu/OTP).
2. **Link = mật khẩu.** Không dán vào nhóm chat, tài liệu chia sẻ, ảnh chụp màn hình. Lộ link → **Bảo mật → Xoay key**.
3. Server phải truy cập được từ Internet qua **HTTPS hợp lệ** và **IPv4** (bản ghi A).
4. Mở link bằng trình duyệt sẽ thấy trang “Đây là endpoint MCP…” — nghĩa là link đúng và máy chủ đang chạy.

## Claude (claude.ai web, desktop, mobile)
**Gói**: Free (giới hạn 1 connector tuỳ chỉnh), Pro, Max, Team, Enterprise.

**Cá nhân (Free/Pro/Max)**:
1. claude.ai → **Customize → Connectors** (claude.ai/customize/connectors) → **+ Add → Add custom connector** (một số tài khoản chỉ có nút **Add custom connector**).
2. Name: `Ads MCP`; URL: dán link MCP → **Continue**.
3. **Authentication**: chọn **No sign in** (có nơi ghi *No sign-in*) — **không điền** OAuth Client ID/Secret.
4. **Add**. Trong cuộc trò chuyện, bấm nút **+ → Connectors** → bật **Ads MCP**.

**Team / Enterprise**: chỉ **Owner/Primary owner** thêm được: **Organization settings → Connectors → Add → Custom → Web** → dán link. Cả workspace dùng chung **1 link** (= 1 MCP, cùng phạm vi quyền) → nên tạo MCP riêng cho workspace với quyền phù hợp. Thành viên bấm **Connect** ở **Customize → Connectors** của mình.

**Lưu ý**:
- Claude kết nối từ dải IP `160.79.104.0/21` — nếu MCP có **danh sách IP cho phép**, phải thêm dải này; nếu VPS có tường lửa, không chặn dải này.
- Mỗi lệnh tool tối đa ~240 giây, kết quả ~150.000 ký tự — app tự chia trang khi dữ liệu lớn.
- Claude hỏi quyền trước khi chạy tool ghi: chọn *Allow once* để xem từng thao tác.

## Claude Code (CLI)
```bash
claude mcp add --transport http ads-noti https://mcp.congty.vn/mcp/<key> --scope user
claude mcp list          # kiểm tra trạng thái: ✓ Connected
```
- `--scope user`: dùng cho mọi dự án trên máy. Dùng `--scope project` sẽ ghi link vào `.mcp.json` của dự án — **đừng commit file đó** vì link là bí mật.
- Kết quả tool lớn bị cắt ở 25.000 token (biến môi trường `MAX_MCP_OUTPUT_TOKENS`) — hỏi khoảng ngày ngắn hơn hoặc nhờ AI dùng phân trang.
- Trong phiên: gõ `/mcp` để xem tool, kết nối lại.

## ChatGPT (chatgpt.com)
**Gói / quyền ghi**: trang trợ giúp của OpenAI ghi quyền ghi (bật/tắt, sửa…) dành cho Business, Enterprise, Edu và gói Pro chỉ đọc; tài liệu cho nhà phát triển không giới hạn theo gói — kiểm tra thực tế trên gói của bạn. Chỉ dùng trên **web**. Từ 10/2026 không còn bước bật **Developer mode**: MCP tự thêm được tạo thành **plugin**.
1. Mở <https://chatgpt.com/plugins> → **“+” → Add custom MCP server** (có thể hiện *Create custom MCP server*).
2. Đặt tên `Ads MCP`; mục **Connection** dán link MCP vào **Server URL**; **Authentication: No authentication**.
3. **I understand and want to continue** → **Create as a plugin**.
4. Cài plugin: <https://chatgpt.com/plugins?view=personal> → mở plugin → **“+”**. Trong cuộc trò chuyện gõ **@** và chọn **Ads MCP** (tác vụ hẹn giờ dùng plugin: tạo trong tab **Work**).

**Business / Enterprise**: admin cấp quyền **Create custom MCP servers** (tên mới của *Developer mode*). ChatGPT **“đóng băng” danh sách tool** → sau khi đổi quyền MCP trong Ads MCP, vào chatgpt.com/plugins → mở plugin → **Refresh** để ChatGPT thấy tool mới.

Muốn AI tự chạy theo lịch (vd tự tắt quảng cáo có CPA cao): xem trang **Mẹo chạy tự động** trong app.

## Gemini CLI
Sửa file `~/.gemini/settings.json` (Windows: `%USERPROFILE%\.gemini\settings.json`):
```json
{
  "mcpServers": {
    "adsnoti": {
      "httpUrl": "https://mcp.congty.vn/mcp/<key>",
      "timeout": 120000
    }
  }
}
```
- Tên server **không dùng dấu gạch dưới** `_` (dùng `adsnoti`, `ads-noti`).
- `httpUrl` = Streamable HTTP (đúng loại Ads MCP hỗ trợ); **không** dùng `url` (SSE cũ).
- Khởi động lại `gemini`, gõ `/mcp` để xem trạng thái và danh sách tool. Kết quả quá ~40.000 ký tự có thể bị cắt.

## Gemini Enterprise (Google Cloud)
1. Admin vào **Gemini Enterprise → Connectors / Data stores → Add custom MCP server**.
2. URL: dán link MCP; Authentication: **No authentication**.
3. Chỉ hỗ trợ Streamable HTTP và chứng chỉ TLS hợp lệ (Caddy tự lo).
4. Như Claude Team: cả tổ chức dùng chung 1 link → tạo MCP riêng với quyền phù hợp.

## Gemini app (gemini.google.com)
Tính năng *Connected Apps → Add a custom app* hiện chỉ cho tài khoản US/tiếng Anh và có thể yêu cầu OAuth → **chưa hỗ trợ ở v1**. Dùng Gemini CLI hoặc Gemini Enterprise.

## Câu lệnh mẫu
- “Liệt kê các tài khoản quảng cáo tôi được dùng.” *(AI luôn gọi bước này trước để biết tiền tệ, múi giờ, quyền)*
- “Chi tiêu, lượt nhấp, CPA hôm qua của tất cả tài khoản Meta, TikTok, Google Ads và OpenAI Ads, xếp theo chi tiêu.” *(mỗi tài khoản giữ tiền tệ riêng — AI không cộng chéo tiền tệ)*
- “Báo cáo các chiến dịch YouTube tuần qua của tài khoản Google Ads X: lượt xem, tỉ lệ xem, CPV, tỉ lệ xem hết video.”
- “Từ khoá nào của chiến dịch Search Y có chi phí cao nhưng không có chuyển đổi trong 14 ngày qua?”
- “Báo cáo theo ngày từ 1/9 đến 30/9 của chiến dịch X.”
- “Tắt các quảng cáo có CPA trên 200.000đ trong 7 ngày qua.” → AI hiện **bản xem trước** → bạn đồng ý → AI xác nhận.
- “Tăng ngân sách nhóm Y lên 1 triệu/ngày.” *(bị chặn nếu vượt giới hạn % thay đổi đã cấu hình)*
- “Nhân bản chiến dịch Z, thêm hậu tố ‘T10’.” *(bản sao luôn ở trạng thái tạm dừng)*
- “Gửi tóm tắt chi tiêu hôm qua vào nhóm Telegram của team.” *(cần MCP được cấp kênh Telegram và bật “AI được gửi tin”)*

## Lưu ý theo nền tảng
- **Meta**: số liệu trong ngày có độ trễ, chuyển đổi được ghi nhận muộn.
- **TikTok Ads**: số liệu chậm khoảng 30 phút, có lúc tới 2 giờ. Đổi ngân sách có thể chỉ có hiệu lực từ 00:00 hôm sau — AI sẽ báo thời điểm có hiệu lực. TikTok ngừng cho tạo chiến dịch thủ công (Manual) qua API từ 31/12/2026; sửa, bật/tắt chiến dịch có sẵn vẫn dùng được.
- **Google Ads (gồm YouTube)**: quảng cáo YouTube là chiến dịch **Video** / **Demand Gen** trong tài khoản Google Ads — kết nối Google Ads là xem được, không cần kết nối riêng. Hỏi AI theo kênh (Search, YouTube, Performance Max…) và chỉ số video (lượt xem, tỉ lệ xem, CPV, tỉ lệ xem 25/50/75/100%). Chiến dịch **Video chỉ xem được** qua API — bật/tắt, sửa ngân sách hãy làm trong Google Ads. Số liệu chậm 1–3 giờ. ID tài khoản 10 số, có hoặc không có dấu gạch (`123-456-7890`).
- **OpenAI Ads**: không có xoá (chỉ lưu trữ) và không có sao chép gốc của nền tảng.

## Thông báo Telegram (tuỳ chọn)
Ads MCP có thể gửi tin vào nhóm/kênh Telegram của bạn:
1. **Kết nối quảng cáo → Thêm kết nối → Kênh thông báo → Telegram**: dán bot token (tạo bot với **@BotFather**), chat ID của nhóm/kênh (và ID chủ đề nếu nhóm bật Topics) → **Kiểm tra & lưu** → **Gửi tin thử**. Thêm bot vào nhóm/kênh và cấp quyền gửi tin trước khi kiểm tra.
2. Chọn sự kiện hệ thống muốn nhận: kết nối quảng cáo sắp hết hạn / lỗi / hoạt động lại; quản trị viên nhận thêm thông báo cập nhật phần mềm.
3. Trong **MCP → Tạo/Sửa MCP**: chọn kênh Telegram, rồi bật **AI được gửi tin** (AI dùng tool `telegram_send_message`, có giới hạn tin/giờ) và/hoặc **Tự báo khi AI thay đổi quảng cáo** (mỗi lần AI bật/tắt, đổi ngân sách, sửa, tạo, sao chép, xoá thành công).

Tin do AI gửi luôn có tiêu đề “🤖 Tin từ AI · MCP <tên>”; AI không bao giờ thấy bot token hay chat ID. Hướng dẫn chi tiết từng bước nằm ngay trong trang thêm kết nối Telegram của app.

## Khi có lỗi
| Hiện tượng | Xử lý |
|---|---|
| **404** / “server not found” | Link sai hoặc MCP đã tắt / hết hạn / xoá / xoay key → lấy lại link trong tab **Kết nối AI** |
| **403** | IP không nằm trong danh sách cho phép của MCP |
| **429** | Vượt giới hạn lệnh/phút → đợi, hoặc tăng giới hạn trong cấu hình MCP |
| Không thấy tool ghi | MCP chưa cấp quyền tương ứng (Bật/Tắt, Sửa, Sao chép…) hoặc ChatGPT Business chưa *Refresh* |
| Lệnh dài bị ngắt sau 125 giây (lỗi 524) | Tên miền đi qua Cloudflare proxy → chia nhỏ yêu cầu, hoặc chuyển tên miền sang *DNS only* (cần chứng chỉ công khai) - xem [deploy-vps.md §9.7](deploy-vps.md#97-giới-hạn-thời-gian-125-giây-và-mcp) |
| Claude không thêm được connector | Kiểm tra bản ghi A IPv4, chứng chỉ HTTPS, tường lửa cho dải `160.79.104.0/21` |

Mọi lượt gọi đều được ghi ở **Nhật ký → Nhật ký MCP** (client, tool, tham số đã che bí mật, kết quả, giá trị trước → sau).
