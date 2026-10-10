# Kết nối MCP với Claude, ChatGPT, Gemini

> Áp dụng cho **Ads MCP by: noti.vn** (10/2026). Giao diện các AI thay đổi thường xuyên — nếu tên menu khác, tìm mục *Connectors / Apps / MCP*.

## Trước khi bắt đầu
1. Tạo MCP trong Ads MCP (**MCP → Tạo MCP** — đọc hết và xác nhận popup **Miễn trừ trách nhiệm** trước), sao chép link dạng:
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

Muốn AI tự chạy theo lịch (vd tự tắt quảng cáo có CPA cao): xem trang **Mẹo sử dụng** → **Chạy tự động** trong app.

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
- “Nhân bản chiến dịch Z, thêm hậu tố ‘T10’.” *(bản sao luôn ở trạng thái tạm dừng - trừ GMV Max: bản sao chạy ngay, xem lưu ý bên dưới)*
- “Gửi tóm tắt chi tiêu hôm qua vào nhóm Telegram của team.” *(cần MCP được cấp kênh Telegram và bật “AI được gửi tin”)*
- “Trong thư mục Drive ‘Creative T10’ có những video nào mới tuần này?” *(cần MCP được cấp thư mục Google Drive — xem mục Google Drive bên dưới)*
- “Lên quảng cáo TikTok (tạm dừng) cho TKQC X bằng video ‘ra-mat-sp.mp4’ trong thư mục Creative T10, nội dung theo file.”
- “Tổng chi tiêu, doanh thu, ROI GMV Max 7 ngày qua của TKQC TikTok X, theo ngày; sản phẩm và video nào kéo đơn nhiều nhất?” *(GMV Max - TikTok Shop: mặc định chỉ phân tích, xem lưu ý bên dưới)*
- “Đọc các dòng ‘Chờ lên’ trong sheet Kế hoạch creative, lên quảng cáo cho từng dòng rồi ghi trạng thái vào sheet.”

## Lưu ý theo nền tảng
- **Meta**: số liệu trong ngày có độ trễ, chuyển đổi được ghi nhận muộn.
- **TikTok Ads**: số liệu chậm khoảng 30 phút, có lúc tới 2 giờ. Đổi ngân sách có thể chỉ có hiệu lực từ 00:00 hôm sau — AI sẽ báo thời điểm có hiệu lực. TikTok ngừng cho tạo chiến dịch thủ công (Manual) qua API từ 31/12/2026; sửa, bật/tắt chiến dịch có sẵn vẫn dùng được.
- **TikTok GMV Max (TikTok Shop)**: dùng chung kết nối TikTok Ads (app cần **đủ quyền** - tick tất cả, kể cả mọi ô GMV MAX - xem [huong-dan-lay-token-tiktok.md — GMV Max](huong-dan-lay-token-tiktok.md#gmv-max-tiktok-shop)). **Dùng AI để xem và phân tích chỉ số; hạn chế bật/tắt hay sửa** vì GMV Max tự tối ưu theo ngày: TikTok khuyên giữ mỗi mức ROI mục tiêu ít nhất 3 ngày, và tạm dừng / xoá / sửa ROI hoặc sản phẩm trong ngày làm mất Bảo vệ ROI của ngày đó. Mặc định MCP **chỉ xem** GMV Max; AI chỉ bật/tắt, sửa (ngân sách, ROI, sản phẩm, video), sao chép, tạo mới hay xoá chiến dịch GMV Max khi **quản trị viên bật “Cho phép AI thay đổi GMV Max (TikTok Shop)”** ở bước **Chọn quyền** của MCP (nhân viên không tự bật được). Mọi thay đổi GMV Max **luôn phải xác nhận 2 bước** và **bắt buộc có trần ngân sách/ngày** (tính theo mức chi tối đa có thể mỗi ngày, gồm tăng ngân sách tự động, ngày khuyến mãi). Chiến dịch GMV Max **tạo mới / sao chép chạy NGAY** (không tạo ở trạng thái tạm dừng được). GMV Max không có nhóm quảng cáo; đổi tài khoản GMV Max độc quyền của cửa hàng và phiên Max delivery / Creative boost không làm qua MCP - xem [Cho AI thay đổi GMV Max](huong-dan-lay-token-tiktok.md#cho-ai-thay-đổi-gmv-max-chỉ-quản-trị-viên). ROI và số đơn GMV Max gồm cả đơn tự nhiên; chi tiêu GMV Max có thể không nằm (đầy đủ) trong báo cáo TikTok thường — không cộng hai báo cáo vì có thể bị trùng hoặc sai. Câu hỏi mẫu:
  - “Kiểm tra cửa hàng GMV Max của TKQC X - cửa hàng nào sẵn sàng, cửa hàng nào chưa và vì sao?”
  - “So sánh các chiến dịch GMV Max sản phẩm tháng này: chiến dịch nào ROI thấp hơn mục tiêu?”
  - “Top 10 sản phẩm theo doanh thu tuần qua trong chiến dịch GMV Max Y; sản phẩm nào tốn tiền mà ít đơn?”
  - “Phiên LIVE nào hôm qua có ROI tốt nhất?”
  - “Chiến dịch GMV Max nào đang kém? Chỉ phân tích và đề xuất, chưa sửa gì.”
- **Google Ads (gồm YouTube)**: quảng cáo YouTube là chiến dịch **Video** / **Demand Gen** trong tài khoản Google Ads — kết nối Google Ads là xem được, không cần kết nối riêng. Hỏi AI theo kênh (Search, YouTube, Performance Max…) và chỉ số video (lượt xem, tỉ lệ xem, CPV, tỉ lệ xem 25/50/75/100%). Chiến dịch **Video chỉ xem được** qua API — bật/tắt, sửa ngân sách hãy làm trong Google Ads. Số liệu chậm 1–3 giờ. ID tài khoản 10 số, có hoặc không có dấu gạch (`123-456-7890`).
- **OpenAI Ads**: không có xoá (chỉ lưu trữ) và không có sao chép gốc của nền tảng.

## Thông báo Telegram (tuỳ chọn)
Ads MCP gửi tin vào nhóm / kênh / chat riêng trên Telegram qua bot của bạn. Hướng dẫn đầy đủ (tạo bot, lấy Chat ID / Thread ID, giới hạn, xử lý lỗi): **[huong-dan-telegram.md](huong-dan-telegram.md)**.

1. **Kết nối → tab Telegram → Thêm kết nối Telegram**: dán bot token (tạo bot với **@BotFather**), Chat ID (và Thread ID nếu nhóm bật Chủ đề), chọn sự kiện hệ thống → **Kiểm tra & lưu** → **Gửi tin thử**. Thêm bot vào nhóm/kênh và cấp quyền gửi tin trước.
2. **MCP → Tạo/Sửa MCP**: bước Nền tảng chọn kết nối Telegram (chỉ kết nối của chủ MCP); bước Quyền bật **AI được gửi tin** và/hoặc **Tự báo khi AI thay đổi quảng cáo** (mặc định tắt); bước Bảo vệ đặt **Giới hạn tin Telegram / giờ**.
3. Trong AI: “Gửi tóm tắt chi tiêu hôm qua vào nhóm Marketing.” Tin luôn có tiêu đề “🤖 Tin từ AI · MCP <tên>” và dòng ghi nguồn “Ads MCP Simple” ở cuối; AI không bao giờ thấy bot token hay Chat ID.

**Kèm ảnh / video / tệp** (1 tệp mỗi tin, chú thích ≤ 800 ký tự, ảnh ≤ 10 MB, mọi tệp ≤ 50 MB, 20 lượt gửi tệp / 10 phút / MCP): link https công khai tải trực tiếp (mọi AI), tệp đính kèm trong **ChatGPT bản web**, hoặc tệp chữ AI tự viết (CSV/TSV/TXT/MD/JSON ≤ 256 KB). Ảnh do ChatGPT/Gemini tự tạo chưa gửi được. Chi tiết: [huong-dan-telegram.md — Bước 6](huong-dan-telegram.md#bước-6--nhờ-ai-gửi-tin-ảnh-video-tệp).

## Google Drive / Google Sheet (tuỳ chọn)
AI **không chuyển được file** (ảnh, video) sang MCP, nên Ads MCP tự lấy file từ Google Drive: bạn chỉ cần nói tên file / thư mục, dán link Drive hoặc trỏ tới một dòng trong Google Sheet. Hướng dẫn đầy đủ (quản trị viên cài đặt, chia sẻ, khai báo, mẫu sheet, câu lệnh mẫu, giới hạn, xử lý lỗi): **[huong-dan-google-drive.md](huong-dan-google-drive.md)**.

1. **Quản trị viên** (một lần): **Cài đặt → Google Drive hệ thống** — dán khoá JSON service account (và API key nếu muốn dùng link Drive công khai).
2. **Kết nối → tab Google Drive**: chia sẻ thư mục ảnh/video (quyền **Người xem**) hoặc Google Sheet (**Người chỉnh sửa** nếu muốn AI ghi trạng thái) cho **email hệ thống**, rồi **Thêm thư mục / sheet**.
3. **MCP → Tạo/Sửa MCP**: bước Nền tảng chọn thư mục / sheet ở khối **Google Drive**; bước Quyền bật quyền **Tạo mới** cho nền tảng muốn tải ảnh/video lên, giữ **Cho phép dùng link Drive công khai** và **Cho phép ghi trạng thái vào Google Sheet** (mặc định bật).
4. Trong AI: “Lên quảng cáo TikTok tạm dừng cho TKQC X bằng video ‘ra-mat-sp.mp4’ trong thư mục Creative T10” hoặc “Đọc các dòng ‘Chờ lên’ trong sheet Kế hoạch creative, lên quảng cáo cho từng dòng rồi ghi trạng thái vào sheet”.

- **Ảnh** dùng được cho cả 4 nền tảng (Meta ≤ 30 MB; Google Ads ≤ 5 MB JPEG/PNG/GIF; TikTok ≤ 30 MB JPG/PNG; OpenAI Ads ≤ 20 MB JPEG/PNG/WebP). **Video** (MP4/MOV ≤ 500 MB) chỉ Meta và TikTok: TikTok ≤ 10 MB / Meta ≤ 50 MB xong ngay; lớn hơn được **tải nền** vài phút — nói “kiểm tra video đã tải xong chưa” để AI xem tiến độ.
- File đã tải lên đúng TKQC trước đó được **dùng lại mã media** (không tải lại) — trừ khi file trên Drive đã thay đổi. Mọi quảng cáo AI tạo đều **tạm dừng**.
- Tệp đính kèm trong **ChatGPT bản web** cũng tải lên được (video tối đa 10 MB TikTok / 50 MB Meta — lớn hơn hãy đưa lên Google Drive).

## Khi có lỗi
| Hiện tượng | Xử lý |
|---|---|
| **404** / “server not found” | Link sai hoặc MCP đã tắt / hết hạn / xoá / xoay key → lấy lại link trong tab **Kết nối AI** |
| **403** | IP không nằm trong danh sách cho phép của MCP |
| **429** | Vượt giới hạn lệnh/phút → đợi, hoặc tăng giới hạn trong cấu hình MCP |
| Không thấy tool ghi | MCP chưa cấp quyền tương ứng (Bật/Tắt, Sửa, Sao chép…) hoặc ChatGPT Business chưa *Refresh* |
| AI báo “MCP này chưa được quản trị viên cho phép thay đổi chiến dịch GMV Max” | Mặc định MCP chỉ xem GMV Max → nhờ **quản trị viên** mở MCP → tab **Cấu hình** → **Chọn quyền** → thẻ TikTok Ads → bật **Cho phép AI thay đổi GMV Max (TikTok Shop)**, rồi đặt **Trần ngân sách/ngày** cho loại tiền của TKQC |
| Lệnh dài bị ngắt sau 125 giây (lỗi 524) | Tên miền đi qua Cloudflare proxy → chia nhỏ yêu cầu, hoặc chuyển tên miền sang *DNS only* (cần chứng chỉ công khai) - xem [deploy-vps.md §9.7](deploy-vps.md#97-giới-hạn-thời-gian-125-giây-và-mcp) |
| Claude không thêm được connector | Kiểm tra bản ghi A IPv4, chứng chỉ HTTPS, tường lửa cho dải `160.79.104.0/21` |
| Không thấy tool `drive_*` | MCP chưa được cấp thư mục / sheet Google Drive và (link công khai tắt hoặc chưa có API key hệ thống, hoặc MCP không có quyền Tạo mới); `drive_sheet_update_rows` chỉ có khi sheet bật ghi trạng thái + MCP bật “ghi trạng thái vào Google Sheet” |
| “Không tìm thấy file trong các thư mục được cấp” | File không nằm trong thư mục đã cấp cho MCP và không phải link công khai → kiểm tra bằng `drive_list_sources`, xem bảng lỗi trong [huong-dan-google-drive.md — Phần 8](huong-dan-google-drive.md#phần-8--xử-lý-lỗi-thường-gặp) |
| Không thấy tool `telegram_send_message` / AI báo lỗi gửi Telegram | MCP chưa gán kết nối Telegram hoặc chưa bật **AI được gửi tin**; lỗi gửi tin / tệp: xem [huong-dan-telegram.md — Xử lý lỗi](huong-dan-telegram.md#xử-lý-lỗi-thường-gặp) |
| Meta/TikTok báo không tải được video Drive | Tên miền đi qua Cloudflare đang challenge `/dl/*` → [deploy-vps.md §9.2 bước 10](deploy-vps.md#92-cấu-hình-cloudflare-dashboard) |

Mọi lượt gọi đều được ghi ở **Nhật ký → Nhật ký MCP** (client, tool, tham số đã che bí mật, kết quả, giá trị trước → sau).
