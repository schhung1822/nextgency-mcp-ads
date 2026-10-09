# Hướng dẫn: kênh thông báo Telegram

> Áp dụng cho **Ads MCP by: noti.vn** (10/2026). Giao diện Telegram thay đổi theo phiên bản app — nếu tên menu khác, tìm mục tương ứng (_Quản trị viên_, _Thêm thành viên_, _Chủ đề / Topics_).

Ads MCP gửi tin vào **nhóm, kênh hoặc chat riêng** trên Telegram thông qua một **bot** do bạn tạo. Bạn không cần biết lập trình: tạo bot mất 2 phút trong chính app Telegram.

## Mục lục

- [Telegram nhận được những tin gì](#telegram-nhận-được-những-tin-gì)
- [Bước 1 — Tạo bot với @BotFather](#bước-1--tạo-bot-với-botfather)
- [Bước 2 — Thêm bot vào nhóm / kênh / chat riêng](#bước-2--thêm-bot-vào-nhóm--kênh--chat-riêng)
- [Bước 3 — Lấy Chat ID và Thread ID](#bước-3--lấy-chat-id-và-thread-id)
- [Bước 4 — Thêm kết nối Telegram trong Ads MCP](#bước-4--thêm-kết-nối-telegram-trong-ads-mcp)
- [Bước 5 — Gán kết nối Telegram cho MCP](#bước-5--gán-kết-nối-telegram-cho-mcp)
- [Bước 6 — Nhờ AI gửi tin, ảnh, video, tệp](#bước-6--nhờ-ai-gửi-tin-ảnh-video-tệp)
- [Quản lý kết nối Telegram](#quản-lý-kết-nối-telegram)
- [Giới hạn](#giới-hạn)
- [Xử lý lỗi thường gặp](#xử-lý-lỗi-thường-gặp)
- [Bảo mật](#bảo-mật)
- [Ghi chú vận hành cho quản trị viên](#ghi-chú-vận-hành-cho-quản-trị-viên)

---

## Telegram nhận được những tin gì

| Loại tin                  | Khi nào gửi                                                                                                                                            | Bật ở đâu                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| **Cảnh báo hệ thống**     | Kết nối quảng cáo **sắp hết hạn**, **bị lỗi**, **hoạt động lại**. Quản trị viên nhận thêm: **có bản cập nhật mới**, **cập nhật thành công / thất bại** | Kết nối Telegram → **Sự kiện hệ thống**             |
| **AI thay đổi quảng cáo** | Mỗi lần AI bật/tắt, đổi ngân sách, sửa, tạo, sao chép hoặc xoá thành công: 1 tin tóm tắt **trước → sau**                                               | MCP → công tắc **Tự báo khi AI thay đổi quảng cáo** |
| **Tin từ AI**             | Khi bạn bảo AI gửi báo cáo, có thể kèm **1 ảnh, video hoặc tệp**                                                                                       | MCP → công tắc **AI được gửi tin**                  |

Ví dụ tin AI tự báo khi thay đổi quảng cáo:

```text
⏸ AI đã tạm dừng 2 quảng cáo
MCP: Báo cáo hằng ngày · Meta · TKQC act_1234567890
Tool: ads_set_status
• QC Serum 01 (1201…): Đang chạy → Tạm dừng
• QC Serum 02 (1202…): Đang chạy → Tạm dừng
Lý do: CPA vượt 200.000 ₫

Ads MCP Simple
```

Ví dụ tin AI gửi theo yêu cầu:

```text
🤖 Tin từ AI · MCP Báo cáo hằng ngày
Chi tiêu hôm qua (09/10): Meta 4.250.000 ₫, TikTok 2.100.000 ₫ …

Ads MCP Simple
```

**Mọi tin** (cả tin hệ thống, tin thử, chú thích ảnh/video/tệp) kết thúc bằng dòng ghi nguồn chữ nghiêng **"Ads MCP Simple"** (bấm vào mở <https://s.noti.vn/s/ads-mcp-simple>). Dòng này luôn có, không tắt được.

---

## Bước 1 — Tạo bot với @BotFather

1. Trong Telegram, tìm **@BotFather** (bot chính thức của Telegram, có dấu tích xanh) hoặc mở <https://t.me/BotFather> → **Start**.
2. Gửi lệnh `/newbot`.
3. Đặt **tên hiển thị**, ví dụ `Ads MCP - Cảnh báo`.
4. Đặt **username** kết thúc bằng `bot`, ví dụ `congty_ads_mcp_bot`.
5. BotFather trả về **bot token** dạng `123456789:AAH…`. Sao chép token này — dán vào Ads MCP ở Bước 4.

> ⚠ **Ai có bot token đều điều khiển được bot.** Không gửi token qua chat, email, ảnh chụp màn hình. Lộ token: gửi `/revoke` cho @BotFather để lấy token mới, rồi bấm **Thay token** trong Ads MCP.

Một bot dùng được cho nhiều kết nối (mỗi kết nối một nhóm hoặc một chủ đề). Không cần tạo bot mới cho mỗi nhóm.

---

## Bước 2 — Thêm bot vào nhóm / kênh / chat riêng

| Nơi nhận                         | Cách thêm                                                       | Quyền cần có                                                                           |
| -------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **Nhóm**                         | Mở nhóm → **Thêm thành viên** → tìm username của bot            | Thành viên được gửi tin. Nếu nhóm hạn chế quyền gửi tin, đặt bot làm **quản trị viên** |
| **Nhóm bật Chủ đề (Topics)**     | Như nhóm                                                        | Bot phải được gửi tin trong chủ đề bạn chọn                                            |
| **Kênh**                         | Mở kênh → **Quản trị viên** → **Thêm quản trị viên** → chọn bot | Bật quyền **Đăng tin** (Post messages)                                                 |
| **Chat riêng** (gửi cho 1 người) | Người nhận mở chat với bot và bấm **Start**                     | —                                                                                      |

Bot vẫn gửi được tin khi bật _Privacy mode_ — chế độ này chỉ giới hạn tin bot **đọc** được.

---

## Bước 3 — Lấy Chat ID và Thread ID

### Chat ID

**Cách 1 — Telegram Web (dễ nhất):**

1. Mở <https://web.telegram.org/a/> trên máy tính, đăng nhập.
2. Bấm vào nhóm / kênh.
3. Nhìn thanh địa chỉ: số sau dấu `#`, dạng `-1001234567890`, chính là **Chat ID** (nhớ giữ dấu `-`).

**Cách 2 — getUpdates:**

1. Gửi một tin vào nhóm, có nhắc tên bot (`@congty_ads_mcp_bot xin chào`).
2. Mở trình duyệt vào `https://api.telegram.org/bot<token>/getUpdates` (thay `<token>` bằng bot token).
3. Tìm đoạn `"chat":{"id":-100…` — số đó là Chat ID.

> Đường link ở cách 2 **chứa bot token** — không gửi hay chụp màn hình cho ai. Nếu báo lỗi (bot đã đặt webhook), dùng cách 1.

Kênh hoặc nhóm **công khai** có thể dùng `@tên_kênh` thay cho số.

> Các bot bên thứ ba như @userinfobot, @getidsbot **không phải của Telegram** và đọc được tin bạn chuyển tiếp cho chúng. Ưu tiên 2 cách chính thức ở trên.

### Thread ID (chỉ khi nhóm bật Chủ đề)

1. Trong nhóm bật Chủ đề, mở chủ đề muốn nhận tin.
2. Nhấn giữ (điện thoại) hoặc chuột phải (máy tính) một tin trong chủ đề → **Sao chép liên kết**.
3. Liên kết có dạng `https://t.me/c/1234567890/42/100`: số ở **giữa** (`42`) là **Thread ID**.

Để trống Thread ID = gửi vào chủ đề **General**.

---

## Bước 4 — Thêm kết nối Telegram trong Ads MCP

1. **Kết nối quảng cáo** → tab **Telegram** → **Thêm kết nối Telegram**.
   (Hoặc **Kết nối quảng cáo** → **Thêm kết nối** → nhóm **Kênh thông báo** → thẻ **Telegram**.)
2. Điền form **Thông tin bot và chat**:

| Ô                                                       | Điền                                                                                                                               | Ví dụ                             |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| **Tên kết nối**                                         | Tên gợi nhớ, hiện khi chọn kết nối cho MCP                                                                                         | `Nhóm Marketing`, `Cảnh báo QC`   |
| **Bot token**                                           | Token từ @BotFather (Bước 1)                                                                                                       | `123456789:AAH…`                  |
| **Chat ID**                                             | Bước 3                                                                                                                             | `-1001234567890` hoặc `@ten_kenh` |
| **Chủ đề (Thread ID)** _(tuỳ chọn)_                     | Chỉ cho nhóm bật Chủ đề                                                                                                            | `42`                              |
| **Sự kiện hệ thống**                                    | Tick **Sức khoẻ kết nối quảng cáo** (báo khi kết nối sắp hết hạn, lỗi, hoạt động lại). Quản trị viên có thêm **Cập nhật hệ thống** |                                   |
| **Nhận cảnh báo của mọi kết nối** _(chỉ quản trị viên)_ | Bật để nhận cả cảnh báo kết nối của nhân viên. Mặc định chỉ nhận cho kết nối của chính bạn                                         |                                   |

3. Bấm **Kiểm tra** (tuỳ chọn): hệ thống hỏi Telegram để xác nhận token, chat, quyền gửi tin của bot — **chưa lưu gì**. Kết quả hiện khung **Bot và chat hợp lệ** (bot, chat, loại chat, chủ đề) kèm **Lưu ý** nếu có, ví dụ:
   - _"Đây là chat riêng: người nhận phải mở chat với @bot và bấm Start…"_
   - _"Đây là nhóm thường: nếu Telegram nâng cấp nhóm thành supergroup, hệ thống sẽ tự cập nhật Chat ID mới."_
   - _"Telegram không có hàm kiểm tra chủ đề: hãy bấm Gửi tin thử…"_
4. Bấm **Kiểm tra & lưu**. Kiểm tra đạt thì kết nối được lưu và bạn được đưa tới trang chi tiết.
5. Bấm **Gửi tin thử** → mở Telegram, phải thấy tin **"✅ Tin thử từ Ads MCP"**. Đây là cách chắc chắn nhất để biết bot gửi đúng nhóm, đúng chủ đề.

Bot token được mã hoá trước khi lưu và **không bao giờ hiển thị lại** (chỉ 4 ký tự cuối).

> Tin **AI thay đổi quảng cáo** và **Tin từ AI** không chọn ở đây — chúng bật riêng trong từng MCP (Bước 5).

---

## Bước 5 — Gán kết nối Telegram cho MCP

**MCP → Tạo MCP** (hoặc trang MCP → tab **Cấu hình** với MCP có sẵn):

1. Bước **Nền tảng & tài khoản** → nhóm **Thông báo (không bắt buộc)** → khối **Kết nối Telegram**: tick kết nối muốn dùng (tối đa 20).
2. Bước **Quyền** → khối **Telegram**:
   - **AI được gửi tin** — AI gửi báo cáo/thông báo khi bạn yêu cầu, có thể kèm 1 ảnh, video hoặc tệp.
   - **Tự báo khi AI thay đổi quảng cáo** — mỗi thao tác ghi thành công gửi 1 tin tóm tắt trước → sau vào **mọi** kết nối Telegram đã chọn.
   - Cả hai **mặc định tắt**.
3. Bước **Bảo vệ** → **Giới hạn tin Telegram / giờ**: số tin AI được chủ động gửi trong 1 giờ (1–200, mặc định 20). Tin tự báo khi AI thay đổi quảng cáo **không** tính vào giới hạn này.

**Quy tắc quan trọng:** MCP chỉ dùng được **kết nối Telegram của chính chủ MCP** — kể cả MCP của quản trị viên cũng không dùng kết nối Telegram của người khác. Quản trị viên sửa MCP của nhân viên sẽ chỉ thấy kết nối Telegram của nhân viên đó.

Với ChatGPT bản Business/Enterprise: sau khi đổi cấu hình MCP, vào chatgpt.com/plugins → mở plugin → **Refresh** để ChatGPT thấy tool mới.

Tool AI nhận được:

| Tool                     | Có khi                                | Dùng để                                                      |
| ------------------------ | ------------------------------------- | ------------------------------------------------------------ |
| `telegram_list_channels` | MCP được gán ≥ 1 kết nối Telegram     | Xem các kênh được gửi (không thấy token, không thấy Chat ID) |
| `telegram_send_message`  | Thêm công tắc **AI được gửi tin** bật | Gửi tin chữ, hoặc 1 ảnh / video / tệp kèm chú thích          |

---

## Bước 6 — Nhờ AI gửi tin, ảnh, video, tệp

### 6.1 Tin chữ

> "Tóm tắt chi tiêu, số đơn, CPA hôm qua của tất cả TKQC Meta và TikTok rồi gửi vào nhóm Telegram **Nhóm Marketing**."

- Tin tối đa **3.500 ký tự**, văn bản thuần (AI không chèn được định dạng HTML hay nút bấm).
- MCP chỉ có 1 kết nối Telegram thì không cần nói tên nhóm.
- Gửi tin chữ **không** qua xác nhận 2 bước (không đụng quảng cáo hay tiền). AI chỉ gửi khi bạn yêu cầu hoặc để báo kết quả việc bạn giao.

### 6.2 Gửi kèm ảnh / video / tệp — 3 nguồn

Mỗi tin kèm **đúng 1 tệp**; khi có tệp, nội dung tin thành **chú thích**, tối đa **800 ký tự** (có thể để trống). Muốn gửi nhiều tệp → AI gửi nhiều tin (mỗi tin tính 1 lượt trong giới hạn tin/giờ).

**Nguồn 1 — Link công khai (dùng được với mọi AI):**

> "Gửi ảnh này https://congty.vn/static/banner-t10.jpg vào nhóm Marketing, chú thích: _Banner tuần 41 đã duyệt_."

- Link phải là **https**, **tải trực tiếp được tệp, không cần đăng nhập**. Máy chủ Ads MCP tự tải về rồi gửi lên Telegram (Telegram không thấy link gốc).
- Link xem file Google Drive (`…/file/d/…/view`), Dropbox, OneDrive dạng trang xem là **trang web, không phải tệp** → bị từ chối. Với file Google Drive công khai, có thể thử link tải trực tiếp dạng `https://drive.google.com/uc?export=download&id=<mã file>` (file lớn có thể bị Google chèn trang cảnh báo — khi đó dùng nguồn khác).
- Không dùng được địa chỉ nội bộ (`localhost`, IP mạng LAN…).

**Nguồn 2 — Tệp bạn đính kèm trong ChatGPT (chỉ ChatGPT bản web):**

Bấm **+** trong ô chat của chatgpt.com, đính kèm tệp, rồi gõ:

> "Gửi file PDF tôi vừa đính kèm vào nhóm Marketing, chú thích: _Báo cáo tháng 9_."

- App ChatGPT trên điện thoại hiện chưa chuyển tệp đúng cách (AI báo lỗi _chat_upload_) → dùng bản web.
- Claude và Gemini chưa chuyển được tệp bạn đính kèm cho MCP → dùng link công khai.

**Nguồn 3 — Tệp chữ do AI tự viết (dùng được với mọi AI):**

> "Xuất bảng chi tiêu 7 ngày qua theo từng chiến dịch thành file CSV rồi gửi vào nhóm Marketing."

- Đuôi `.csv`, `.tsv`, `.txt`, `.md`, `.json`, tối đa **256 KB**.
- CSV/TSV mở bằng Excel hiển thị **đúng tiếng Việt** (hệ thống tự thêm mã UTF-8).
- Hệ thống tự **chặn công thức** trong CSV/TSV (ô bắt đầu bằng `=`, `@`, hoặc `+`/`-` không phải số được thêm dấu `'`) để mở file không chạy lệnh lạ. Số âm, phần trăm, số điện thoại `+84…` vẫn giữ nguyên.
- Token, mật khẩu lỡ có trong nội dung được che trước khi gửi.

### 6.3 Loại tệp được phép

| Loại     | Định dạng                                                                                      | Gửi dạng                                 |
| -------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Ảnh      | JPG, PNG, WebP ≤ 10 MB                                                                         | **Ảnh** (xem ngay trong chat)            |
| Ảnh lớn  | JPG, PNG, WebP 10–50 MB                                                                        | Tự chuyển sang **tệp**                   |
| Ảnh động | GIF                                                                                            | **Tệp** (bảo AI "gửi dạng ảnh" nếu muốn) |
| Video    | MP4 ≤ 50 MB                                                                                    | **Video** (xem trực tiếp)                |
| Video    | MOV ≤ 50 MB                                                                                    | **Tệp**                                  |
| Tài liệu | PDF; Word / Excel / PowerPoint **DOCX, XLSX, PPTX** (không có macro, không có đối tượng nhúng) | Tệp                                      |
| Tệp chữ  | CSV, TSV, TXT, MD, JSON                                                                        | Tệp                                      |

**Bị chặn:** mọi loại khác — tệp chạy được (exe, apk, bat…), zip, HTML, SVG, XML, JavaScript, Office có macro (`.docm`, `.xlsm`…). Hệ thống kiểm tra **nội dung thật** của tệp, không tin đuôi tên tệp (đổi `virus.exe` thành `anh.jpg` vẫn bị chặn).

Muốn ép kiểu gửi, nói rõ với AI: "gửi dạng tệp" (giữ nguyên chất lượng ảnh), "gửi dạng ảnh", "gửi dạng video".

### 6.4 Không gửi được

- **Ảnh do ChatGPT / Gemini tự tạo** trong cuộc trò chuyện: AI không có tệp gốc để chuyển cho tool. Tải ảnh về máy rồi đính kèm lại (ChatGPT web), hoặc đưa lên một chỗ có link công khai.
- Tệp > 50 MB (giới hạn của Telegram cho bot) → gửi **link tải** trong nội dung tin thay vì tệp.

---

## Quản lý kết nối Telegram

**Kết nối quảng cáo** → tab **Telegram**: bảng các kết nối với **Tên**, **Người tạo** (quản trị viên thấy), **Chat**, **Chủ đề**, **Sự kiện**, **Trạng thái** (**Hoạt động** / **Lỗi** / **Đã tắt**), **Gửi lần cuối**. Nhân viên chỉ thấy kết nối của mình; quản trị viên thấy tất cả.

Bấm vào một kết nối để mở trang chi tiết:

| Nút / khung                       | Dùng để                                                                                                                                                                                                                       |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Gửi tin thử**                   | Gửi ngay 1 tin vào chat/chủ đề đã chọn                                                                                                                                                                                        |
| **Kiểm tra lại**                  | Hỏi lại Telegram về token, chat, quyền của bot. Kết nối **Lỗi** hoạt động lại khi kiểm tra đạt                                                                                                                                |
| **Cài đặt**                       | Đổi tên, Chat ID, Thread ID, sự kiện hệ thống → **Lưu** trên thanh _Có thay đổi chưa lưu_ (Chat ID / Thread ID được kiểm tra lại khi lưu)                                                                                     |
| **Thay token**                    | Dán bot token mới sau khi `/revoke` ở @BotFather (nhập lại mật khẩu) → **Kiểm tra & thay token**                                                                                                                              |
| **Tắt kết nối** / **Bật kết nối** | Tắt = không gửi gì (kể cả từ MCP) cho tới khi bật lại                                                                                                                                                                         |
| **Xoá kết nối**                   | Xoá kết nối và bot token đã lưu, gỡ khỏi mọi MCP đang dùng (gõ tên để xác nhận, không hoàn tác)                                                                                                                               |
| **MCP đang dùng kết nối này**     | Danh sách MCP được gán                                                                                                                                                                                                        |
| **Lần gửi gần đây**               | 50 tin gần nhất: **Thời gian**, **Nguồn** (Hệ thống / AI gửi tin / AI thay đổi QC / Tin thử), **Sự kiện**, **Trạng thái** (Đang chờ / Đã gửi / Thất bại), **Nội dung / lỗi**, **MCP**. Xem đầu tiên khi "không nhận được tin" |

Tin hệ thống trùng lặp được gộp: mỗi kết nối quảng cáo chỉ báo **1 lần mỗi ngày** cho cùng một trạng thái.

---

## Giới hạn

| Giới hạn                             | Mức                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------- |
| Tin chữ                              | ≤ 3.500 ký tự                                                                         |
| Chú thích khi kèm tệp                | ≤ 800 ký tự                                                                           |
| Số tệp mỗi tin                       | 1                                                                                     |
| Ảnh gửi dạng ảnh                     | ≤ 10 MB (lớn hơn tự gửi dạng tệp)                                                     |
| Mọi tệp                              | ≤ 50 MB                                                                               |
| Tệp chữ AI tự viết                   | ≤ 256 KB                                                                              |
| Tin AI gửi mỗi giờ (mỗi MCP)         | Theo **Giới hạn tin Telegram / giờ** (1–200, mặc định 20). Tin có tệp cũng tính 1 tin |
| Lượt gửi tệp mỗi MCP                 | 20 lượt / 10 phút, **tính cả lần tải lỗi**                                            |
| Gửi tệp đồng thời                    | 1 tệp mỗi lúc cho mỗi MCP; tối đa 2 tệp cùng lúc trên máy chủ                         |
| Thời gian một lần gửi tệp            | Khoảng 50 giây (tải tệp ≤ 25 giây + gửi lên Telegram ≤ 30 giây)                       |
| Kết nối Telegram mỗi MCP             | ≤ 20                                                                                  |
| Tin tự báo khi AI thay đổi quảng cáo | Không giới hạn theo giờ (mỗi thao tác ghi thành công = 1 tin)                         |

ChatGPT đôi khi gọi tool **hai lần** với cùng một tệp đính kèm: trong 2 phút, lần thứ hai không gửi lại (AI nhận kết quả "đã gửi").

---

## Xử lý lỗi thường gặp

### Khi thêm / kiểm tra kết nối

| Thông báo                                                                               | Cách xử lý                                                            |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Bot token không đúng định dạng (dạng 123456789:ABC…, lấy từ @BotFather).                | Sao chép lại token, không thừa dấu cách.                              |
| Bot token không đúng hoặc đã bị thu hồi.                                                | Lấy token mới từ @BotFather → **Thay token**.                         |
| Chat ID phải là số (nhóm/kênh bắt đầu bằng -100…) hoặc @tên_công_khai…                  | Kiểm tra Bước 3, nhớ dấu `-`.                                         |
| Không tìm thấy chat. Kiểm tra lại Chat ID và chắc chắn @bot đã được thêm vào nhóm/kênh… | Chat ID sai hoặc bot chưa ở trong nhóm.                               |
| Bot chưa được thêm vào nhóm hoặc chưa có quyền gửi tin…                                 | Thêm bot vào nhóm, cấp quyền gửi tin → **Kiểm tra lại**.              |
| @bot chưa là quản trị viên của kênh hoặc chưa có quyền "Đăng tin"…                      | Kênh: **Quản trị viên → Thêm quản trị viên** → bot, bật **Đăng tin**. |
| @bot không còn ở trong nhóm.                                                            | Ai đó đã xoá bot → thêm lại.                                          |
| @bot bị hạn chế, không được gửi tin trong nhóm.                                         | Bỏ hạn chế cho bot trong cài đặt thành viên nhóm.                     |
| Người nhận đã chặn @bot…                                                                | Chat riêng: mở chat với bot, bấm **Start** (hoặc bỏ chặn).            |
| Nhóm này không bật Chủ đề (Topics) nên không dùng được Thread ID…                       | Để trống ô **Chủ đề (Thread ID)**.                                    |
| Không tìm thấy chủ đề theo Thread ID…                                                   | Lấy lại Thread ID (Bước 3) hoặc để trống.                             |
| Bạn kiểm tra Telegram quá nhanh…                                                        | Đợi vài giây.                                                         |
| Không giải mã được bot token đã lưu…                                                    | Khoá mã hoá máy chủ đã đổi → **Thay token**.                          |

### Không nhận được tin

1. Trang chi tiết kết nối → **Lần gửi gần đây**: tin có ở đó không? Trạng thái gì?
   - **Thất bại** + lỗi → làm theo lỗi ở bảng trên.
   - **Đang chờ** lâu → worker không chạy (quản trị viên xem phần cuối).
   - Không có tin nào → kiểm tra MCP đã gán kết nối và bật đúng công tắc chưa; kết nối có bị **Đã tắt** không.
2. Bấm **Gửi tin thử**.
3. Tin vào nhầm chủ đề → sửa **Thread ID**.

### Khi AI gửi tin / tệp

| Mã lỗi                                         | Thông báo                                                                                             | Cách xử lý                                                                                                |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `telegram_rate_limited`                        | MCP này đã gửi N tin Telegram trong 1 giờ qua - vượt giới hạn…                                        | Đợi, hoặc tăng **Giới hạn tin Telegram / giờ** trong MCP.                                                 |
| `telegram_media_rate_limited`                  | MCP này đã thử gửi 20 tệp Telegram trong 10 phút qua…                                                 | Đợi 10 phút.                                                                                              |
| `telegram_busy`                                | MCP này đang gửi một tệp khác vào Telegram… / Máy chủ đang gửi tệp khác…                              | Đợi lần gửi trước xong (≤ 1 phút) rồi thử lại.                                                            |
| `telegram_file_fetch_failed`                   | Không tải được tệp từ đường dẫn.                                                                      | Link không phải tệp tải trực tiếp, cần đăng nhập, hoặc máy chủ nguồn báo lỗi → dùng link khác / đính kèm. |
| `url_not_allowed`                              | Đường dẫn tệp không được phép.                                                                        | Chỉ dùng link **https** công khai.                                                                        |
| `telegram_file_type_not_allowed`               | Loại tệp này không được phép gửi. / Tệp Office có macro… / …đối tượng nhúng… / Tệp HTML/SVG/XML…      | Đổi sang loại được phép (6.3). Office có macro → lưu lại dạng DOCX/XLSX/PPTX hoặc xuất PDF.               |
| `telegram_file_too_large`                      | Tệp vượt quá 50 MB…                                                                                   | Nén, hoặc gửi link tải trong nội dung tin.                                                                |
| `telegram_file_timeout`                        | Tải tệp quá thời gian chờ… / Quá thời gian chờ khi tải tệp lên Telegram - tệp **có thể đã được gửi**… | **Kiểm tra nhóm trước khi gửi lại** để tránh gửi trùng. Dùng tệp nhỏ hơn.                                 |
| `telegram_file_invalid`                        | Tệp rỗng hoặc bị hỏng.                                                                                | Kiểm tra tệp.                                                                                             |
| `caption_too_long`                             | Khi gửi kèm tệp, text là chú thích và tối đa 800 ký tự…                                               | Rút gọn, hoặc gửi nội dung dài bằng một tin chữ riêng.                                                    |
| `attachment_conflict`                          | Mỗi tin chỉ gửi kèm được 1 tệp…                                                                       | Gửi từng tệp một.                                                                                         |
| `file_name_required`                           | file_content cần file_name có đuôi .csv, .tsv, .txt, .md hoặc .json.                                  | Bảo AI đặt tên tệp, vd `bao-cao.csv`.                                                                     |
| `chatgpt_file_unavailable`                     | ChatGPT gửi tham chiếu tệp kiểu chat_upload…                                                          | Đính kèm lại trên ChatGPT bản web, hoặc dùng link công khai.                                              |
| `telegram_duplicate`                           | Tin này đang được một lần gọi trước gửi đi…                                                           | ChatGPT gọi trùng — đợi, kiểm tra nhóm.                                                                   |
| `channel_unavailable` / `telegram_send_failed` | Lý do cụ thể từ Telegram                                                                              | Mở kết nối → **Kiểm tra lại**.                                                                            |
| Không thấy tool `telegram_send_message`        | —                                                                                                     | MCP chưa gán kết nối Telegram hoặc chưa bật **AI được gửi tin**. ChatGPT Business: **Refresh** plugin.    |

---

## Bảo mật

- Bot token được mã hoá (AES-256-GCM), không bao giờ hiển thị lại, không bao giờ đưa cho AI, không ghi vào nhật ký.
- AI **không thấy** bot token và **không thấy** Chat ID — chỉ thấy tên kết nối và tên nhóm.
- AI không đổi được tiêu đề cố định **"🤖 Tin từ AI · MCP <tên>"** → người trong nhóm luôn biết tin nào do AI gửi.
- Link trong nội dung tin AI gửi bị cắt bỏ phần sau dấu `?` (tránh lộ link có chữ ký / mã truy cập).
- MCP chỉ gửi vào kết nối Telegram **của chủ MCP** và đã được gán.
- Tên nhóm, tên kênh, dữ liệu quảng cáo là **dữ liệu** — AI không làm theo câu lệnh nằm trong đó.
- Rủi ro cần biết: AI có quyền gửi tin có thể gửi số liệu quảng cáo vào nhóm đã chọn. Chỉ gán Telegram cho MCP cần dùng, đặt giới hạn tin/giờ hợp lý, và chỉ chọn nhóm mà mọi thành viên được phép xem số liệu.
- Mọi tin AI gửi được ghi ở **Nhật ký → Nhật ký MCP** và **Lần gửi gần đây** của kết nối. Thao tác thêm / sửa / thay token / xoá kết nối ghi ở nhật ký nhân sự.

---

## Ghi chú vận hành cho quản trị viên

- **Worker phải chạy.** Tin hệ thống và tin **Tự báo khi AI thay đổi quảng cáo** đi qua hàng đợi do container `worker` gửi (tự thử lại khi Telegram giới hạn tốc độ hoặc lỗi mạng; tin chờ quá 1 giờ bị bỏ). Tin AI gửi theo yêu cầu (`telegram_send_message`) và **Gửi tin thử** được gửi trực tiếp. Kiểm tra: `docker compose ps`, `docker compose logs -f --tail=200 worker`.
- Máy chủ cần ra Internet tới `api.telegram.org` (HTTPS 443). Biến `TELEGRAM_API_BASE_URL` tuỳ chọn (mặc định `https://api.telegram.org`, chỉ đổi khi dùng Bot API server riêng, phải là https).
- Tải tệp từ link (`file_url`, tệp ChatGPT) luôn kết nối **trực tiếp**, không qua proxy — máy chủ chỉ ra Internet qua proxy sẽ không gửi được tệp từ link (tin chữ vẫn gửi được).
- Tệp chỉ nằm tạm trong RAM khi gửi (không ghi đĩa), tối đa 2 tệp cùng lúc mỗi tiến trình (dùng chung với việc tải ảnh từ Google Drive).
- Lịch sử gửi tin được dọn theo thời hạn lưu **nhật ký MCP** (Cài đặt → Lưu trữ nhật ký).
- Xem thêm [van-hanh.md](van-hanh.md) và [ket-noi-ai.md](ket-noi-ai.md).
