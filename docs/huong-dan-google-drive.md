# Hướng dẫn: dùng Google Drive / Google Sheet làm nguồn ảnh, video quảng cáo

> Áp dụng cho **Ads MCP by: noti.vn** (10/2026). Giao diện Google Cloud và Google Drive thay đổi thường xuyên — nếu tên menu khác, tìm mục tương ứng (_APIs & Services_, _IAM & Admin_, _Credentials_, _Chia sẻ_).

Tài liệu này dành cho 2 nhóm người:

- **Quản trị viên** (người cài đặt Ads MCP): làm **Phần 1** một lần cho cả công ty, đọc thêm **Phần 9** (vận hành).
- **Nhân viên marketing**: làm **Phần 2 → Phần 6**. Không cần biết gì về Google Cloud.

## Mục lục

- [Hiểu nhanh trong 1 phút](#hiểu-nhanh-trong-1-phút)
- [Phần 1 — Quản trị viên: cài đặt Google Drive hệ thống (một lần)](#phần-1--quản-trị-viên-cài-đặt-google-drive-hệ-thống-một-lần)
- [Phần 2 — Chia sẻ thư mục / Google Sheet cho email hệ thống](#phần-2--chia-sẻ-thư-mục--google-sheet-cho-email-hệ-thống)
- [Phần 3 — Khai báo thư mục / Google Sheet trong Ads MCP](#phần-3--khai-báo-thư-mục--google-sheet-trong-ads-mcp)
- [Phần 4 — Mẫu Google Sheet kế hoạch creative](#phần-4--mẫu-google-sheet-kế-hoạch-creative)
- [Phần 5 — Gán thư mục / sheet cho MCP](#phần-5--gán-thư-mục--sheet-cho-mcp)
- [Phần 6 — Dùng với AI: câu lệnh mẫu](#phần-6--dùng-với-ai-câu-lệnh-mẫu)
- [Phần 7 — Giới hạn cần biết](#phần-7--giới-hạn-cần-biết)
- [Phần 8 — Xử lý lỗi thường gặp](#phần-8--xử-lý-lỗi-thường-gặp)
- [Phần 9 — Bảo mật, quyền riêng tư và thu hồi quyền](#phần-9--bảo-mật-quyền-riêng-tư-và-thu-hồi-quyền)
- [Phần 10 — Ghi chú vận hành cho quản trị viên](#phần-10--ghi-chú-vận-hành-cho-quản-trị-viên)

---

## Hiểu nhanh trong 1 phút

**Vấn đề:** Claude, ChatGPT, Gemini **không chuyển được file** ảnh/video sang MCP. Bạn không thể "gửi video cho AI rồi bảo AI lên quảng cáo".

**Cách Ads MCP giải quyết:** creative nằm trên Google Drive. Bạn chỉ cần nói với AI **tên file, tên thư mục, dán link Drive** hoặc **chỉ tới một dòng trong Google Sheet**. Ads MCP tự lấy file từ Drive rồi đẩy thẳng lên Meta / TikTok / Google Ads / OpenAI Ads — **không lưu file trên máy chủ**.

**Không có nút "Đăng nhập Google".** Hệ thống đọc Drive bằng một **email hệ thống** (tên kỹ thuật: _service account_, có dạng `ads-mcp-drive@ten-project.iam.gserviceaccount.com`). Bạn chỉ cần **chia sẻ** thư mục / sheet cho email đó — giống như chia sẻ cho một đồng nghiệp.

**Ba cách đưa creative vào:**

| Cách                                                     | Ai thiết lập                                  | Ai dùng được                                                                         |
| -------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Thư mục / sheet của công ty**                          | Quản trị viên khai báo                        | Mọi nhân viên gán được vào MCP của mình (chỉ đọc file)                               |
| **Thư mục / sheet riêng**                                | Từng người tự khai báo                        | Chỉ người đó (và quản trị viên)                                                      |
| **Link Drive công khai** ("Bất kỳ ai có đường liên kết") | Không cần khai báo — dán link vào chat với AI | MCP bật công tắc "Cho phép dùng link Drive công khai" + quản trị viên đã lưu API key |

**Nền tảng nào nhận gì:**

|                            | Ảnh | Video                                                              |
| -------------------------- | --- | ------------------------------------------------------------------ |
| Meta (Facebook, Instagram) | ✔   | ✔                                                                  |
| TikTok Ads                 | ✔   | ✔                                                                  |
| Google Ads (gồm YouTube)   | ✔   | ✘ — video phải đăng lên YouTube trước, rồi đưa link YouTube cho AI |
| OpenAI Ads                 | ✔   | ✘ — chỉ nhận ảnh                                                   |

**Mọi quảng cáo AI tạo ra đều ở trạng thái tạm dừng.** Bạn kiểm tra trong trình quản lý quảng cáo rồi tự bật.

---

## Phần 1 — Quản trị viên: cài đặt Google Drive hệ thống (một lần)

Mất khoảng 10–15 phút. Cần tài khoản Google có quyền tạo project trên Google Cloud (miễn phí, không cần thẻ thanh toán cho các API dùng ở đây).

> Có thể dùng chung Google Cloud project với kết nối Google Ads. Thông tin Drive vẫn được lưu riêng.

### Bước 1. Tạo hoặc chọn project Google Cloud

1. Mở <https://console.cloud.google.com/projectcreate>.
2. Đặt tên project, ví dụ `ads-mcp` → **Create**. (Hoặc chọn project có sẵn ở ô chọn project trên cùng.)

### Bước 2. Bật 2 API

1. Vào **APIs & Services → Library**.
2. Tìm **Google Drive API** → **Enable**.
3. Quay lại Library, tìm **Google Sheets API** → **Enable**.

Phải bật **cả hai**, kể cả khi chưa dùng Google Sheet. Thiếu một trong hai, hệ thống báo _"Project Google Cloud chưa bật Google Drive API hoặc Google Sheets API."_

### Bước 3. Tạo service account (email hệ thống)

1. Vào **IAM & Admin → Service Accounts → + Create service account**.
2. **Service account name**: ví dụ `ads-mcp-drive`. Google tự điền **Service account ID** và hiện email dạng `ads-mcp-drive@ads-mcp.iam.gserviceaccount.com`.
3. Bấm **Create and continue**. Ở bước gán vai trò (_Grant this service account access to project_), **bỏ qua — không cần chọn role nào**. Bấm **Done**.

### Bước 4. Tạo khoá JSON

1. Trong danh sách Service Accounts, bấm vào service account vừa tạo.
2. Tab **Keys → Add key → Create new key → JSON → Create**.
3. Trình duyệt tải về một file `.json`. **Đây là bí mật**: ai có file này đọc được mọi thư mục đã chia sẻ cho email hệ thống. Không gửi qua chat/email, không lưu vào Drive chung. Xoá file sau khi dán vào Ads MCP (Bước 6).

Nếu Google báo _"Service account key creation is disabled"_: tổ chức Google Cloud của bạn đang chặn tạo khoá. Nhờ người quản trị Google Cloud tắt chính sách `iam.disableServiceAccountKeyCreation` (hoặc `iam.managed.disableServiceAccountKeyCreation`) cho riêng project này, hoặc dùng một project khác không bị chặn.

### Bước 5 (tuỳ chọn). Tạo API key — để AI đọc link Drive công khai

Chỉ cần nếu bạn muốn nhân viên **dán link Drive "Bất kỳ ai có đường liên kết"** vào chat mà không phải khai báo thư mục. Bỏ qua bước này thì tính năng link công khai tắt cho mọi MCP.

1. Vào **APIs & Services → Credentials → + Create credentials → API key**.
2. Mở key vừa tạo (**Edit API key**):
   - **API restrictions** → **Restrict key** → chỉ tick **Google Drive API** → **Save**.
   - **Application restrictions**: để _None_ (nếu chắc chắn IP ra Internet của máy chủ cố định, có thể chọn _IP addresses_ và nhập IP đó).
3. Sao chép key — dạng `AIza…`, 39 ký tự.

### Bước 6. Dán vào Ads MCP

1. Đăng nhập Ads MCP bằng tài khoản quản trị viên → **Cài đặt** → thẻ **Google Drive hệ thống**.
2. Ô **Service account JSON**: mở file `.json` bằng Notepad, chọn tất cả (Ctrl+A), sao chép và dán **toàn bộ** nội dung (bắt đầu bằng `{` và kết thúc bằng `}`).
3. Ô **API key (link Drive công khai)**: dán key `AIza…` (nếu đã làm Bước 5).
4. Bấm **Lưu thông tin xác thực** → hộp thoại **Xác nhận lưu thông tin Google Drive** hiện ra → nhập mật khẩu (và mã 2FA nếu đã bật) → **Lưu**.

Khi lưu, hệ thống **đăng nhập Google bằng khoá JSON và đọc thử Drive**. Sai khoá hoặc chưa bật API sẽ báo lỗi ngay, không lưu gì. Riêng **API key chỉ được kiểm tra định dạng** — key sai hoặc chưa giới hạn đúng API sẽ báo lỗi ở lần đầu AI dùng một link công khai.

Lưu thành công, thẻ hiển thị: **Email service account** (có nút sao chép), **Dự án Google Cloud**, **Mã khoá** (4 ký tự cuối), **API key** (4 ký tự cuối, hoặc _"Chưa có - link công khai tắt"_), **Kiểm tra lần cuối**, **Thư mục / sheet đang dùng**.

Nút **Kiểm tra** (chỉ có sau khi đã lưu) đăng nhập lại Google bằng khoá **đang lưu** để xem nó còn hoạt động không. Dùng khi thẻ hiện trạng thái lỗi.

**Đổi / gỡ thông tin sau này:**

| Muốn                                 | Làm                                                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Đổi khoá JSON                        | Dán khoá mới vào ô **Thay service account JSON** → **Lưu thông tin xác thực**. Để trống = giữ khoá cũ.                          |
| Đổi API key                          | Dán key mới → **Lưu thông tin xác thực**. Để trống = giữ key cũ.                                                                |
| Tắt link Drive công khai cho mọi MCP | Tick **Xoá API key (tắt link Drive công khai)** → **Lưu thông tin xác thực**.                                                   |
| Gỡ hẳn Google Drive hệ thống         | **Xoá** (nhập lại mật khẩu). Phải xoá hết thư mục / sheet đang dùng thông tin này ở **Kết nối → Google Drive** trước.           |

Khoá JSON và API key được mã hoá, **không bao giờ hiển thị lại**, không bao giờ đưa cho AI.

### Bước 7. Báo cho nhân viên

Email hệ thống giờ hiện ở **Kết nối → tab Google Drive** (khối **Email hệ thống**, có nút sao chép) cho mọi người. Gửi nhân viên đường dẫn tới tài liệu này từ Phần 2.

> Đừng quên kiểm tra **Phần 10**: worker phải chạy (video lớn), và nếu tên miền đi qua Cloudflare thì không được chặn đường dẫn `/dl/*`.

---

## Phần 2 — Chia sẻ thư mục / Google Sheet cho email hệ thống

### Lấy email hệ thống

Ads MCP → **Kết nối** → tab **Google Drive** → khối **Email hệ thống** → bấm nút sao chép. Email có đuôi `.iam.gserviceaccount.com`.

Nếu khối này báo **"Chưa cấu hình Google Drive"**: quản trị viên chưa làm Phần 1. Bạn vẫn có thể dùng service account riêng (Phần 3.4, nâng cao) hoặc nhờ quản trị viên.

### Chia sẻ thư mục ảnh / video

1. Mở <https://drive.google.com>, bấm chuột phải vào thư mục → **Chia sẻ** → **Chia sẻ**.
2. Ô _Thêm người, nhóm…_: dán email hệ thống.
3. Chọn quyền **Người xem**.
4. Bỏ tick **Thông báo cho mọi người** (email hệ thống không đọc thư) → **Chia sẻ** (hoặc **Gửi**).

Thư mục con và mọi file bên trong tự được chia sẻ theo. Không cần chia sẻ từng file.

### Chia sẻ Google Sheet

Như trên, nhưng chọn quyền theo việc bạn muốn AI làm:

| Bạn muốn                                                             | Quyền cho email hệ thống |
| -------------------------------------------------------------------- | ------------------------ |
| AI chỉ đọc sheet                                                     | **Người xem**            |
| AI đọc sheet **và ghi lại trạng thái** (Đã lên / Lỗi, mã quảng cáo…) | **Người chỉnh sửa**      |

Khi ghi, AI chỉ ghi vào 5 cột hệ thống (Phần 4) — không bao giờ sửa cột khác.

> **Lưu ý về file trong sheet:** link Drive trong sheet phải trỏ tới file mà hệ thống đọc được — file nằm trong **thư mục đã khai báo và gán cho MCP**, hoặc file **công khai** "Bất kỳ ai có đường liên kết" (khi MCP cho phép link công khai). Chỉ chia sẻ sheet thôi là chưa đủ để AI lấy file.

### Bộ nhớ dùng chung (Shared drive)

> ⚠ **Không thêm email hệ thống làm thành viên của cả một Bộ nhớ dùng chung.** Khi đó email hệ thống đọc được **mọi** thư mục trong Shared drive, và bất kỳ ai trong công ty biết link đều khai báo được một thư mục bất kỳ trong đó (người khai báo đầu tiên thành chủ). Chỉ chia sẻ **từng thư mục** cần dùng.

Thư mục nằm trong Shared drive vẫn khai báo được nếu Shared drive cho phép chia sẻ với người bên ngoài (cài đặt của Shared drive: cho phép người ngoài tổ chức và người không phải thành viên truy cập tệp). Nếu Google không cho chia sẻ riêng thư mục đó, hãy để creative ở **Drive của tôi** hoặc một Shared drive riêng chỉ dành cho creative.

### Công ty chỉ cho chia sẻ trong tên miền

Nếu Google Workspace của công ty chỉ cho chia sẻ với địa chỉ `@congty.vn`, bạn sẽ không thêm được email hệ thống (đuôi `iam.gserviceaccount.com` là "người ngoài"). Nhờ quản trị viên Google Workspace cho phép chia sẻ ra ngoài tên miền (ít nhất cho đơn vị tổ chức hoặc thư mục chứa creative): **Admin console → Ứng dụng → Google Workspace → Drive và Tài liệu → Cài đặt chia sẻ**.

Trường hợp này **link công khai cũng không dùng được** (file chỉ chia sẻ trong tên miền không phải là công khai) — phải đi đường chia sẻ thư mục + khai báo.

### Không nên chia sẻ

- Thư mục chứa dữ liệu nhạy cảm (hợp đồng, bảng lương, dữ liệu khách hàng…): mọi file ảnh/video trong thư mục đã khai báo đều được AI liệt kê qua MCP được cấp.
- Thư mục bạn **không định khai báo ngay**. Hãy khai báo (Phần 3) ngay sau khi chia sẻ để bạn là người khai báo đầu tiên.

---

## Phần 3 — Khai báo thư mục / Google Sheet trong Ads MCP

Chia sẻ xong, bạn phải **khai báo** để hệ thống biết thư mục/sheet đó là của ai và ai được dùng.

### 3.1 Mở trình khai báo

Một trong hai cách:

- **Kết nối** → tab **Google Drive** → nút **Thêm thư mục / sheet**.
- **Kết nối** → **Thêm kết nối** → nhóm **Kho creative** → thẻ **Google Drive**.

> Lần đầu thêm kết nối, Ads MCP hiện popup **Miễn trừ trách nhiệm**: kéo đọc hết nội dung, chờ hết đếm ngược 10 giây, tick ô **Tôi đã đọc kỹ, hiểu và đồng ý…** rồi bấm **Tôi đồng ý và bắt đầu** (bấm **Huỷ** = không kết nối). Đã xác nhận thì những lần sau không hỏi lại, trừ khi nội dung được cập nhật phiên bản mới.

Trang **Thêm thư mục / sheet Google Drive** có 3 bước. Panel **Hướng dẫn** bên phải giải thích từng bước.

### 3.2 Bước 1 · Loại & phạm vi

**Bạn muốn khai báo gì?**

- **Thư mục Google Drive** — thư mục chứa ảnh (JPG, PNG, GIF, WebP) và video (MP4, MOV).
- **Google Sheet** — bảng kế hoạch creative, mỗi dòng một creative (xem Phần 4).

**Ai được dùng?** (chỉ quản trị viên thấy lựa chọn này)

| Phạm vi           | Ai thấy              | Ai gán vào MCP                                                                                  | Ai sửa / xoá           |
| ----------------- | -------------------- | ----------------------------------------------------------------------------------------------- | ---------------------- |
| **Công ty**       | Mọi người            | Mọi nhân viên, cho MCP của mình (chỉ đọc file; sheet ghi được cột trạng thái nếu sheet bật ghi) | Chỉ quản trị viên      |
| **Riêng của tôi** | Bạn và quản trị viên | Chỉ MCP của bạn                                                                                 | Bạn (và quản trị viên) |

Nhân viên luôn khai báo phạm vi **Riêng**. Thư mục dùng chung của công ty do quản trị viên khai báo.

Bấm **Tiếp tục**.

### 3.3 Bước 2 · Chia sẻ & kiểm tra

1. **Chia sẻ cho email nào?**
   - **Email hệ thống (khuyên dùng)** — không cần tạo gì thêm.
   - **Service account riêng** — dùng khoá service account của chính bạn (nâng cao, xem 3.4).
   - Thư mục / sheet **Công ty** luôn được đọc bằng email hệ thống.
2. Ô **Email để chia sẻ**: bấm sao chép, chia sẻ thư mục/sheet cho email này (Phần 2) nếu chưa làm.
3. Dán link:
   - **Link thư mục**: dạng `https://drive.google.com/drive/folders/1AbC…`. Cách lấy: mở thư mục trên Drive, sao chép địa chỉ trên thanh trình duyệt (hoặc chuột phải → **Chia sẻ → Sao chép đường liên kết**).
   - **Link Google Sheet (đúng tab)**: mở sheet, **bấm vào đúng tab** chứa danh sách creative ở dưới cùng, rồi sao chép địa chỉ trên thanh trình duyệt. Link phải có đuôi `#gid=…`, ví dụ `https://docs.google.com/spreadsheets/d/1XyZ…/edit#gid=123456789`. Đổi tên tab sau này vẫn dùng được.
   - Sheet: ô **Dòng tiêu đề** — dòng chứa tên cột, thường là `1`.
4. Bấm **Kiểm tra**. Hệ thống đọc thử và hiện khung **Đã đọc được**:
   - Thư mục: **Tên trên Google Drive**, **Nội dung (cấp đầu)** — số ảnh · số video · số thư mục con; ghi chú **Bộ nhớ dùng chung (Shared drive)** nếu có. Thư mục chưa có ảnh/video vẫn khai báo được.
   - Sheet: tên, **Tab**, số dòng, **Dòng tiêu đề** (các tên cột đọc được), **Quyền của email**: _"Người chỉnh sửa - ghi trạng thái được"_ hoặc _"Người xem - chỉ đọc"_.
5. Nếu báo **Chưa đọc được thư mục / sheet**, đọc thông báo lỗi và xem [Phần 8](#phần-8--xử-lý-lỗi-thường-gặp). Sửa xong bấm **Kiểm tra** lại. Sửa link sau khi đã kiểm tra thì phải bấm **Kiểm tra** lần nữa.
6. Bấm **Tiếp tục**.

### 3.4 Service account riêng (nâng cao, tuỳ chọn)

Chỉ cần khi bạn **không muốn** chia sẻ thư mục cho email hệ thống của công ty (ví dụ thư mục của khách hàng, hoặc công ty chưa cấu hình Google Drive hệ thống).

1. Làm Bước 1–4 của Phần 1 trong **project Google Cloud của bạn** (bật cả Google Drive API và Google Sheets API, tạo service account, tải khoá JSON).
2. **Kết nối** → tab **Google Drive** → khối **Service account riêng** (nhãn _Nâng cao_) → **Thêm service account** (hoặc nút **Thêm service account** ngay ở Bước 2 của trình khai báo).
3. **Tên gợi nhớ** (ví dụ "Drive cá nhân của Lan") + dán **Service account JSON** → **Kiểm tra & thêm**.
4. Chia sẻ thư mục cho **email của service account riêng** này, rồi khai báo như 3.3 và chọn **Service account riêng**.

Service account riêng chỉ dùng cho thư mục / sheet **riêng** của chính bạn. Không dùng email hệ thống làm service account riêng (hệ thống sẽ báo _"Đây là service account hệ thống - không cần thêm riêng…"_). Link công khai luôn đọc bằng API key của hệ thống, không có API key riêng.

### 3.5 Bước 3 · Cài đặt & lưu

- **Tên hiển thị**: tên dễ nhận ra, hiện trong danh sách và khi chọn nguồn cho MCP. Để trống = dùng tên trên Google Drive.
- **Thư mục**: **Thư mục con AI được duyệt** — _Chỉ thư mục này_, _1 cấp con_, _2 cấp con_, _3 cấp con_. Áp dụng khi AI liệt kê file kèm thư mục con; nhiều cấp thì chậm hơn. AI vẫn mở được từng thư mục con khi bạn nói tên (ví dụ "thư mục Tuần 41/Video").
- **Sheet**: khối **Ánh xạ cột**. Hệ thống tự gợi ý theo tên cột mẫu (Phần 4); nếu sheet của bạn đặt tên khác, chọn lại:
  - **Cột AI đọc**: _Link Drive_ (**Bắt buộc**), _Tên creative_, _Nền tảng_, _Tài khoản QC_, _Nội dung_, _Tiêu đề_, _Link đích_. Cột nào không có thì chọn _Không dùng_.
  - Công tắc **Cho phép AI ghi trạng thái vào sheet** — chỉ bật được khi email có quyền **Người chỉnh sửa**. Nếu email mới có quyền Người xem: cấp thêm quyền rồi quay lại Bước 2 bấm **Kiểm tra** lại.
  - Mục **Cột ghi trạng thái (nâng cao)**: _Trạng thái_ (**bắt buộc** khi bật ghi), _Mã media_, _Mã quảng cáo_, _Link bài viết_, _Link chiến dịch_, _Ghi chú hệ thống_, _Cập nhật lúc_ (tuỳ chọn).
- Bấm **Lưu thư mục / sheet**.

Lưu xong bạn được đưa tới trang chi tiết với thông báo **Đã khai báo** — bước tiếp theo là gán cho MCP (Phần 5).

### 3.6 Quy tắc khai báo (để tránh dùng nhầm thư mục của người khác)

- Mỗi thư mục / sheet chỉ khai báo được **một lần**. **Người khai báo đầu tiên là chủ.** Người sau dán cùng link sẽ bị từ chối.
- Một Google Sheet được tính theo **cả file**: các tab khác của cùng file chỉ người đã khai báo mới khai báo thêm được, và phải cùng phạm vi (công ty / riêng).
- Không khai báo được thư mục **nằm trong** thư mục riêng của người khác, hoặc **chứa** thư mục riêng của người khác — kể cả quản trị viên khai báo thư mục công ty. Lý do: tránh việc thư mục riêng của ai đó bị dùng chung ngoài ý muốn. Cần dùng chung → nhờ chủ thư mục riêng xoá khai báo của họ trước.
- Thư mục con của một thư mục đã khai báo **không cần** khai báo lại.
- Với nhân viên, mọi trường hợp bị từ chối (không tìm thấy, sai loại, trong thùng rác, đã có người khai báo, liên quan thư mục riêng của người khác) hiện **cùng một** thông báo chung. Quản trị viên thấy lý do chi tiết (ví dụ _"Đã được khai báo bởi lan@congty.vn."_).

### 3.7 Trang chi tiết thư mục / sheet

Bấm vào một dòng trong tab **Google Drive** để mở. Trên cùng có trạng thái (**Hoạt động** / **Lỗi** / **Đã tắt**) và các nút:

| Nút                      | Làm gì                                                                                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Kiểm tra lại**         | Đọc lại thư mục/sheet ngay. Dùng sau khi bạn sửa chia sẻ. Nguồn đang lỗi sẽ hoạt động lại khi kiểm tra đạt. Hệ thống cũng tự kiểm tra **6 giờ/lần**. |
| **Sửa cài đặt**          | Đổi tên hiển thị, số cấp thư mục con; với sheet: dòng tiêu đề, ánh xạ cột, ghi trạng thái.                                                           |
| **Xoá**                  | Gỡ thư mục/sheet khỏi Ads MCP và khỏi mọi MCP đang dùng (phải gõ đúng tên để xác nhận). **File trên Google Drive không bị ảnh hưởng.**               |
| **Mở trên Google Drive** | Mở thư mục/sheet gốc.                                                                                                                                |

Các khung thông tin:

- **Thông tin**: loại, phạm vi, **Đọc bằng** (email hệ thống hay service account riêng), người tạo, tên và mã trên Google, kiểm tra lần cuối.
- **Đang dùng trong MCP**: những MCP được gán nguồn này.
- Thư mục — **File trong thư mục**: lưới ảnh thu nhỏ của ảnh/video AI thấy được, lọc **Tất cả / Ảnh / Video**, bấm thư mục con để đi vào, **Tải thêm** khi có nhiều file. Mỗi file ghi **Đã dùng ở N TKQC** (đã tải lên những tài khoản nào) hoặc **Chưa dùng**. File không phải ảnh/video (PDF, Docs…) được bỏ qua.
- Sheet — **Xem trước sheet**: 20 dòng đầu theo ánh xạ cột và **Thống kê trạng thái** (bao nhiêu dòng Chờ lên, Đã lên, Lỗi…).

Thư mục / sheet công ty: nhân viên chỉ xem và gán cho MCP của mình; chỉ quản trị viên sửa hoặc xoá.

---

## Phần 4 — Mẫu Google Sheet kế hoạch creative

Dùng khi bộ phận media lên kế hoạch nhiều creative một lúc. **Mỗi dòng = một creative.**

### 4.1 Các cột

Tên cột dưới đây là tên hệ thống tự nhận ra. Đặt tên khác cũng được — chọn lại ở bước **Ánh xạ cột**.

| Cột                | Bắt buộc              | Ai điền        | Ý nghĩa                                                                                                                                                                                            |
| ------------------ | --------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Link Drive`       | ✔                     | Bạn            | Link file trên Drive (hoặc mã file). Nhiều file trong một ô (vd video + ảnh bìa): cách nhau bằng xuống dòng (Alt+Enter / Ctrl+Enter trong ô), dấu cách, dấu phẩy hoặc chấm phẩy — tối đa 10 link/ô |
| `Tên creative`     |                       | Bạn            | Tên media / quảng cáo                                                                                                                                                                              |
| `Nền tảng`         |                       | Bạn            | `Meta`, `Facebook`, `FB`, `Instagram`, `IG` · `TikTok` · `Google`, `Google Ads`, `YouTube` · `OpenAI`, `ChatGPT` (không phân biệt hoa thường)                                                      |
| `Tài khoản QC`     |                       | Bạn            | **ID** (khuyên dùng) hoặc **tên** TKQC đúng như trong Ads MCP. TKQC phải nằm trong MCP. Tên trùng nhiều TKQC → ghi ID                                                                              |
| `Nội dung`         |                       | Bạn            | Nội dung quảng cáo (primary text) gợi ý cho AI                                                                                                                                                     |
| `Tiêu đề`          |                       | Bạn            | Tiêu đề gợi ý                                                                                                                                                                                      |
| `Link đích`        |                       | Bạn            | Trang đích (landing page)                                                                                                                                                                          |
| `Trạng thái`       | ✔ nếu muốn AI ghi lại | Bạn + hệ thống | Để trống hoặc `Chờ lên` (hoặc `Chưa tạo ads`, `Chưa tạo`, `Chưa lên`) = cần lên. Hệ thống ghi `Đang xử lý`, `Đã lên`, `Lỗi` — xem 4.4                                                              |
| `Mã media`         |                       | **Hệ thống**   | Mã ảnh/video trên nền tảng                                                                                                                                                                         |
| `Mã quảng cáo`     |                       | **Hệ thống**   | Mã quảng cáo đã tạo                                                                                                                                                                                |
| `Link bài viết`    |                       | **Hệ thống**   | Link bài viết / bài quảng cáo AI vừa tạo từ dòng này (vd bài trên Facebook, TikTok) — bấm để xem nhanh                                                                                             |
| `Link chiến dịch`  |                       | **Hệ thống**   | Link chiến dịch trong trình quản lý quảng cáo (Meta Ads Manager, TikTok Ads Manager…)                                                                                                              |
| `Ghi chú hệ thống` |                       | **Hệ thống**   | Lý do lỗi hoặc ghi chú của AI                                                                                                                                                                      |
| `Cập nhật lúc`     |                       | **Hệ thống**   | Dạng `09/10/2026 14:05 · MCP Lên QC tuần 41` (giờ Việt Nam + tên MCP)                                                                                                                              |

Hai cột **Link bài viết** và **Link chiến dịch** (thêm ngày 10/10/2026) là **tuỳ chọn**: thêm hai cột này vào sheet rồi chọn chúng trong mục **Cột ghi trạng thái (nâng cao)** khi khai báo sheet — sheet đã khai báo trước đó: **Kết nối** → tab **Google Drive** → mở sheet → **Sửa cài đặt** để chọn. Sau khi tạo quảng cáo từ một dòng, AI ghi link bài viết và link chiến dịch nếu biết (chỉ link `https://`, không đoán). Sheet không có hai cột này vẫn chạy bình thường.

### 4.2 Dòng tiêu đề để dán nhanh

Sao chép khối dưới đây, bấm vào ô **A1** của tab mới trong Google Sheet rồi dán (Ctrl+V) — mỗi tên cột tự vào một ô:

```text
Link Drive	Tên creative	Nền tảng	Tài khoản QC	Nội dung	Tiêu đề	Link đích	Trạng thái	Mã media	Mã quảng cáo	Link bài viết	Link chiến dịch	Ghi chú hệ thống	Cập nhật lúc
```

Thứ tự đầy đủ (14 cột): Link Drive | Tên creative | Nền tảng | Tài khoản QC | Nội dung | Tiêu đề | Link đích | Trạng thái | Mã media | Mã quảng cáo | Link bài viết | Link chiến dịch | Ghi chú hệ thống | Cập nhật lúc.

### 4.3 Dòng ví dụ

Dán vào ô **A2** (thay link và ID bằng của bạn):

```text
https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/view	Ra mắt serum - video 15s	TikTok	7212345678901234567	Da sáng sau 7 ngày, ưu đãi 30% tuần này	Serum Vitamin C	https://congty.vn/serum	Chờ lên
https://drive.google.com/file/d/1BcDeFgHiJkLmNoPqRsTuVwXyZ123456/view, https://drive.google.com/file/d/1CdEfGhIjKlMnOpQrStUvWxYz234567/view	Ra mắt serum - video dọc + ảnh bìa	TikTok	7212345678901234567	Da sáng sau 7 ngày	Serum Vitamin C	https://congty.vn/serum	Chưa tạo ads
https://drive.google.com/file/d/1DeFgHiJkLmNoPqRsTuVwXyZ345678/view	Banner serum 1080x1080	Facebook	Shop Mỹ Phẩm - TKQC chính	Freeship toàn quốc cho đơn từ 299k	Serum Vitamin C	https://congty.vn/serum
```

Dòng 3 có 2 file trong một ô (video + ảnh bìa) và ghi `Chưa tạo ads` — hệ thống hiểu như `Chờ lên`. Dòng 4 để trống **Trạng thái** — cũng được tính là "Chờ lên". Dòng 4 ghi **tên** TKQC thay cho ID (được, miễn tên không trùng). Các cột từ **Mã media** trở đi để trống — hệ thống tự ghi.

### 4.4 Trạng thái của một dòng

```text
(trống) / Chờ lên  →  Đang xử lý  →  Đã lên
                                  ↘  Lỗi
```

| Ý nghĩa           | Hệ thống ghi | Bạn cũng có thể gõ                               |
| ----------------- | ------------ | ------------------------------------------------ |
| Cần lên quảng cáo | `Chờ lên`    | để trống, `Chưa tạo ads`, `Chưa tạo`, `Chưa lên` |
| AI đang làm       | `Đang xử lý` | —                                                |
| Đã lên xong       | `Đã lên`     | `Đã tạo ads`, `Đã tạo`                           |
| Có lỗi            | `Lỗi`        | —                                                |

- Không phân biệt hoa thường, có dấu hay không dấu, thừa dấu cách: `chua tao ads`, `ĐÃ TẠO` đều được hiểu đúng. **Thống kê trạng thái** ở trang xem sheet cũng gộp theo nghĩa (vd `Chưa tạo ads` tính vào `Chờ lên`).
- Khi bạn bảo AI "lên các dòng Chờ lên", AI chỉ đọc dòng **cần lên** (trống, `Chờ lên` hoặc các cách gõ ở bảng trên). Có thể bảo AI đọc dòng có trạng thái khác (vd "các dòng Đã tạo ads"), hoặc mọi dòng.
- Giá trị không có trong bảng (vd `Tạm dừng`) được giữ nguyên: AI bỏ qua dòng đó khi lên các dòng chờ, trừ khi bạn bảo đọc đúng trạng thái đó.
- Sau khi xử lý, AI ghi `Đã lên` + **Mã media**, **Mã quảng cáo**, **Link bài viết**, **Link chiến dịch** (nếu sheet có các cột này), **Cập nhật lúc**; hoặc `Lỗi` + lý do ở **Ghi chú hệ thống**. Hệ thống **luôn ghi giá trị chuẩn** ở cột "Hệ thống ghi" — dòng `Chưa tạo ads` sau khi lên xong sẽ thành `Đã lên`.
- Muốn lên lại một dòng `Lỗi`: sửa nguyên nhân, đổi **Trạng thái** về `Chờ lên` (hoặc xoá trống).

Ví dụ dòng 2 sau khi AI xử lý:

| Link Drive                            | …   | Trạng thái | Mã media        | Mã quảng cáo     | Link bài viết                          | Link chiến dịch                             | Ghi chú hệ thống        | Cập nhật lúc                          |
| ------------------------------------- | --- | ---------- | --------------- | ---------------- | -------------------------------------- | ------------------------------------------- | ----------------------- | ------------------------------------- |
| https://drive.google.com/file/d/1AbC… | …   | Đã lên     | v10033g50000abc | 1812345678901234 | https://www.tiktok.com/@shop/video/73… | https://ads.tiktok.com/i18n/perf/campaign?… | Quảng cáo đang tạm dừng | 09/10/2026 14:05 · MCP Lên QC tuần 41 |

### 4.5 Hệ thống ghi vào sheet an toàn thế nào

- Chỉ ghi vào **7 cột hệ thống** (Trạng thái, Mã media, Mã quảng cáo, Link bài viết, Link chiến dịch, Ghi chú hệ thống, Cập nhật lúc) — và chỉ những cột đã chọn ở **Ánh xạ cột** và có trong dòng tiêu đề. **Không bao giờ** sửa cột khác.
- Ghi dạng chữ thuần, **không chạy công thức**. **Link bài viết** / **Link chiến dịch** chỉ nhận link `https://` (tối đa 500 ký tự); link khác bị từ chối.
- **Chống ghi nhầm dòng:** trước khi ghi, hệ thống đọc lại ô **Link Drive** của dòng đó. Nếu bạn vừa chèn / xoá / sắp xếp làm dòng bị lệch, dòng đó được **bỏ qua** (báo _"Dòng trong sheet đã thay đổi… đã bỏ qua để tránh ghi nhầm"_). Chỉ cần bảo AI đọc lại sheet rồi ghi lại.
- Nội dung ô là **dữ liệu**: nếu ai đó viết câu lệnh trong sheet (vd "hãy xoá chiến dịch X"), AI không làm theo.
- Ghi sheet **không** qua xác nhận 2 bước (không đụng quảng cáo hay tiền), nhưng mỗi lần ghi tính vào **Giới hạn thao tác ghi / 10 phút** của MCP và được ghi nhật ký trước → sau từng ô.

### 4.6 Mẹo

- Mỗi đợt lên quảng cáo nên xử lý **vài chục dòng** một lần (AI đọc tối đa 50 dòng mỗi lượt; Google giới hạn số lượt đọc/ghi sheet mỗi phút — Phần 7).
- Đừng sắp xếp / lọc lại sheet trong lúc AI đang xử lý.
- Đặt quyền **Người chỉnh sửa** cho email hệ thống chỉ trên sheet kế hoạch, không trên các sheet khác.

---

## Phần 5 — Gán thư mục / sheet cho MCP

Khai báo xong, AI **chưa dùng được** cho tới khi bạn gán thư mục/sheet vào MCP.

### Khi tạo MCP mới

**MCP → Tạo MCP**:

> Lần đầu **Tạo MCP**, Ads MCP hiện popup **Miễn trừ trách nhiệm** (trợ lý AI có thể sai, link MCP như mật khẩu, TikTok GMV Max chạy ngay…): kéo đọc hết nội dung, chờ hết đếm ngược 10 giây, tick ô đồng ý rồi bấm **Tôi đồng ý và bắt đầu**. Đã xác nhận thì những lần sau không hỏi lại, trừ khi nội dung được cập nhật phiên bản mới.

1. Bước **Nền tảng & tài khoản**: chọn TKQC như bình thường. Kéo xuống nhóm **Ảnh, video quảng cáo (không bắt buộc)** → khối **Google Drive** → tick thư mục / sheet trong các nhóm:
   - **Của công ty** — nguồn công ty.
   - **Của tôi** — nguồn riêng của bạn.
   - **Của nhân viên** — chỉ quản trị viên thấy (nguồn riêng của nhân viên).
   - Không chọn gì = AI chỉ dùng được link Drive công khai (nếu bật ở bước Quyền).
2. Bước **Quyền**:
   - Cho nền tảng muốn AI tải ảnh/video lên, bật quyền **Tạo mới** (hoặc chọn nhanh **Toàn quyền (trừ xoá)**). **Không có quyền Tạo mới ở ít nhất 1 nền tảng thì AI chỉ xem được file, không tải lên được.**
   - Khối **Google Drive** có 2 công tắc:
     - **Cho phép dùng link Drive công khai** (mặc định bật) — AI lấy được ảnh/video từ link "Bất kỳ ai có đường liên kết" bạn dán vào chat, kể cả thư mục chưa khai báo. Nếu thấy _"Quản trị viên chưa lưu API key…"_ thì công tắc chưa có tác dụng.
     - **Cho phép ghi trạng thái vào Google Sheet** (mặc định bật) — chỉ có tác dụng với sheet đã bật **Cho phép AI ghi trạng thái vào sheet** ở Phần 3.
3. Bước **Bảo vệ**: nên giữ **Xác nhận 2 bước cho thao tác ghi** (AI phải cho bạn xem trước khi tải file/tạo quảng cáo). **Giới hạn thao tác ghi / 10 phút** cũng giới hạn số lần ghi sheet.

### Khi sửa MCP có sẵn

Trang MCP → tab **Cấu hình**: khung **Nền tảng** (khối **Google Drive** để chọn nguồn) và khung **Quyền** (2 công tắc). Lưu lại.

Hai công tắc Google Drive **mặc định bật cho mọi MCP**, kể cả MCP đã tạo từ trước. Nếu không muốn MCP nào đó dùng link công khai hoặc ghi sheet, tắt trong tab **Cấu hình**.

### Ai gán được nguồn nào

| MCP của       | Gán được                                                   |
| ------------- | ---------------------------------------------------------- |
| Nhân viên     | Nguồn **công ty** + nguồn **riêng của chính nhân viên đó** |
| Quản trị viên | Mọi nguồn (kể cả nguồn riêng của nhân viên)                |

Nguồn đang **Lỗi** hoặc **Đã tắt** vẫn hiện trong danh sách nhưng AI không đọc được cho tới khi nguồn hoạt động lại.

### Sau khi gán

Với ChatGPT bản Business/Enterprise: vào chatgpt.com/plugins → mở plugin → **Refresh** để ChatGPT thấy các tool Drive mới (xem [ket-noi-ai.md](ket-noi-ai.md)).

Các tool AI nhận được:

| Tool                      | Có khi                                                    | Dùng để                              |
| ------------------------- | --------------------------------------------------------- | ------------------------------------ |
| `drive_list_sources`      | MCP có nguồn Drive hoặc dùng được link công khai          | Xem các thư mục/sheet được cấp       |
| `drive_list_files`        | Có ít nhất 1 thư mục, hoặc dùng được link công khai       | Liệt kê ảnh/video trong thư mục      |
| `drive_sheet_read`        | Có ít nhất 1 Google Sheet                                 | Đọc các dòng của sheet               |
| `drive_sheet_update_rows` | Có sheet bật ghi + công tắc ghi sheet bật + quyền Tạo mới | Ghi trạng thái vào sheet             |
| `ads_upload_media`        | Có quyền Tạo mới                                          | Tải ảnh/video lên TKQC, lấy mã media |
| `ads_get_media_upload`    | Có quyền Tạo mới                                          | Xem tiến độ video đang tải nền       |

---

## Phần 6 — Dùng với AI: câu lệnh mẫu

### 6.1 AI làm gì phía sau

```text
Bạn nói yêu cầu
  → AI xem nguồn được cấp (drive_list_sources)
  → AI liệt kê file (drive_list_files) hoặc đọc sheet (drive_sheet_read)
  → AI tải file lên TKQC, lấy mã media (ads_upload_media)      ← xác nhận 2 bước
  → AI tạo quảng cáo bằng mã media, luôn TẠM DỪNG              ← xác nhận 2 bước
  → (sheet) AI ghi Đã lên / Lỗi + mã quảng cáo, link bài viết, link chiến dịch (drive_sheet_update_rows)
```

Bạn không cần nhớ tên tool. Chỉ cần nói rõ: **nền tảng**, **TKQC**, **file / thư mục / sheet nào**, và nội dung quảng cáo (hoặc "theo sheet").

### 6.2 Ví dụ A — Chọn file trong thư mục rồi tạo quảng cáo tạm dừng

> "Trong thư mục Drive **Creative T10**, thư mục con **Tuần 41/Video**, có những video nào sửa sau ngày 5/10? Lấy video **ra-mat-serum.mp4**, tạo một quảng cáo TikTok **tạm dừng** trong nhóm quảng cáo **Serum - Nữ 25-34** của TKQC **7212345678901234567**, nội dung: _Da sáng sau 7 ngày, ưu đãi 30% tuần này_, link đích https://congty.vn/serum."

AI sẽ:

1. Liệt kê video trong `Tuần 41/Video` (tên, dung lượng, độ phân giải, thời lượng, đã tải lên TKQC nào chưa).
2. Gọi tải video lên TKQC → hiện **bản xem trước** (tên file, nguồn, dung lượng; nếu là video lớn: ghi rõ "tải nền") → hỏi bạn đồng ý.
3. Bạn trả lời **"Đồng ý"** → AI tải lên, nhận mã video.
4. AI chuẩn bị quảng cáo → bản xem trước → bạn đồng ý → quảng cáo được tạo ở trạng thái **tạm dừng**.

### 6.3 Ví dụ B — Lên quảng cáo theo Google Sheet và ghi trạng thái

> "Đọc các dòng **Chờ lên** trong sheet **Kế hoạch creative T10**. Với mỗi dòng: tải file lên đúng TKQC ghi trong sheet, tạo quảng cáo **tạm dừng** trong chiến dịch **Ra mắt serum** dùng nội dung, tiêu đề, link đích của dòng đó, rồi ghi trạng thái, mã quảng cáo, link bài viết và link chiến dịch vào sheet. Làm lần lượt 10 dòng đầu, báo lại dòng nào lỗi."

AI sẽ đọc tối đa 10 dòng, báo các vấn đề phát hiện trước (thiếu link, nền tảng lạ, TKQC không thuộc MCP, MCP không có quyền tạo trên nền tảng đó…), xin xác nhận từng thao tác tải/tạo (nếu MCP bật xác nhận 2 bước), rồi ghi `Đã lên` / `Lỗi` vào sheet.

Mẹo: nói "**gộp xác nhận**" hoặc "cho tôi xem trước toàn bộ rồi tôi đồng ý một lần" để AI trình bày danh sách trước khi làm.

### 6.4 Ví dụ C — Dán link Drive công khai vào chat

> "Dùng ảnh này https://drive.google.com/file/d/1DeFgHiJkLmNoPqRsTuVwXyZ345678/view?usp=sharing làm ảnh cho quảng cáo Meta tạm dừng trong nhóm **Retarget 30 ngày** của TKQC **act_1234567890**, tiêu đề _Freeship toàn quốc_."

Điều kiện: file đang chia sẻ **"Bất kỳ ai có đường liên kết"**, quản trị viên đã lưu API key, MCP bật **Cho phép dùng link Drive công khai**. Link **thư mục** công khai cũng dùng được — AI liệt kê file ở cấp đầu của thư mục đó (không duyệt thư mục con).

### 6.5 Ví dụ D — Video lớn, tải ở chế độ nền

> "Tải video **TVC-60s-final.mov** (380 MB) trong thư mục **Creative T10** lên TKQC Meta **act_1234567890**."

Video TikTok > 10 MB hoặc Meta > 50 MB được **tải nền**: AI xin xác nhận (bản xem trước ghi rõ tải nền, vài phút), rồi trả lời kiểu _"Đã đưa video vào hàng đợi, mã lượt tải …"_. Bạn có thể làm việc khác. Vài phút sau:

> "Kiểm tra video đã tải xong chưa."

AI xem tiến độ (`ads_get_media_upload`): **đang chờ → đang tải (x%) → đang xử lý → xong** (kèm mã video) hoặc **lỗi** (kèm lý do). Xong rồi thì:

> "Dùng video vừa tải để tạo quảng cáo tạm dừng trong nhóm **Video views T10**."

Video đã tải lên đúng TKQC đó trước đây sẽ **không tải lại** — AI dùng ngay mã cũ.

### 6.6 Ví dụ E — Ảnh đính kèm trong ChatGPT

Chỉ **ChatGPT bản web** (chatgpt.com): bấm **+** đính kèm ảnh vào tin nhắn, rồi gõ:

> "Tải ảnh tôi vừa đính kèm lên TKQC OpenAI Ads **Shop Mỹ Phẩm** rồi tạo quảng cáo tạm dừng trong nhóm **Serum** với tiêu đề _Serum Vitamin C - giảm 30%_."

- Ảnh: theo giới hạn từng nền tảng (Phần 7). Video đính kèm: tối đa 10 MB (TikTok) / 50 MB (Meta) — lớn hơn hãy đưa lên Google Drive.
- **Không** dùng được: ảnh do ChatGPT/Gemini **tự tạo** trong cuộc trò chuyện (AI không có tệp gốc để chuyển) — tải ảnh về máy rồi đính kèm lại, hoặc đưa lên Drive. App ChatGPT trên điện thoại hiện chưa chuyển tệp đúng cách — dùng bản web.
- Claude và Gemini chưa chuyển được tệp bạn đính kèm cho MCP → dùng Google Drive.

### 6.7 Xác nhận 2 bước và dùng lại file

- MCP bật **Xác nhận 2 bước cho thao tác ghi**: mỗi lần **tải file lên** và **tạo quảng cáo**, AI cho bạn xem bản xem trước (tên file, nguồn, dung lượng, độ phân giải/thời lượng, cảnh báo) và chỉ làm khi bạn đồng ý.
- **Dùng lại, không tải trùng:** file Drive đã tải lên **đúng TKQC đó** trước đây → AI nhận ngay mã media cũ, **không hỏi xác nhận, không tải lại**. Trang chi tiết thư mục ghi "Đã dùng ở N TKQC".
- Hệ thống tự tải lại khi file trên Drive đã bị **thay nội dung** (cùng tên nhưng nội dung khác).
- Nền tảng báo mã media không còn (vd ai đó đã xoá trong thư viện)? Bảo AI: "tải lại file đó, không dùng mã cũ".

### 6.8 Câu lệnh hay dùng khác

- "Liệt kê các thư mục và sheet Google Drive MCP này được dùng."
- "Trong thư mục Creative T10 có ảnh nào chưa dùng ở TKQC 7212345678901234567?"
- "Đọc toàn bộ sheet Kế hoạch creative T10, thống kê bao nhiêu dòng Đã lên, Lỗi; liệt kê lý do các dòng Lỗi."
- "Các lượt tải video nền gần đây của MCP này thế nào?"

---

## Phần 7 — Giới hạn cần biết

### Ảnh (từ Drive hoặc tệp đính kèm ChatGPT)

| Nền tảng   | Định dạng           | Dung lượng tối đa | Ghi chú                                                                                                                                                  |
| ---------- | ------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Meta       | JPG, PNG, GIF, WebP | 30 MB             |                                                                                                                                                          |
| Google Ads | JPEG, PNG, GIF      | 5 MB              |                                                                                                                                                          |
| TikTok Ads | JPG, PNG            | 30 MB             | > 10 MB: AI cảnh báo (TikTok chỉ chờ 10 giây mỗi lần tải ảnh, dễ báo hết thời gian) — nên nén. Ảnh quá lớn về điểm ảnh (> 3.686.400 px) cũng bị cảnh báo |
| OpenAI Ads | JPEG, PNG, WebP     | 20 MB             | Ảnh nhỏ hơn 640×640: AI cảnh báo                                                                                                                         |

### Video (chỉ Meta và TikTok)

|                         | TikTok   | Meta     |
| ----------------------- | -------- | -------- |
| Định dạng               | MP4, MOV | MP4, MOV |
| Tối đa                  | 500 MB   | 500 MB   |
| Tải ngay trong lượt gọi | ≤ 10 MB  | ≤ 50 MB  |
| Tải nền (vài phút)      | > 10 MB  | > 50 MB  |

Video nhỏ có thể trả về kèm "nền tảng đang xử lý" — mã video vẫn dùng được ngay.

### Tải nền

- Tối đa **3** video đang tải nền **mỗi MCP**, **5** cho tất cả MCP của **một người**, **30** video chờ trong **toàn hệ thống**. Vượt thì AI báo _"…đang có N video tải lên ở chế độ nền - chưa nhận thêm"_ → đợi vài phút.
- Máy chủ tải **lần lượt từng video**: nhiều người cùng tải video lớn thì phải chờ lâu hơn.
- Lượt tải chờ quá 24 giờ bị huỷ; lượt tải bị gián đoạn (máy chủ khởi động lại) được đánh dấu lỗi sau khoảng 30–40 phút không có tiến độ — chỉ cần bảo AI tải lại.

### Google Sheet

- AI đọc tối đa **50 dòng** mỗi lượt (mặc định 20), ghi tối đa **50 dòng** mỗi lần.
- Google giới hạn khoảng **60 lượt đọc + 60 lượt ghi sheet mỗi phút cho cả hệ thống** (mọi người dùng chung một email hệ thống). Ads MCP chia thêm: **20 đọc + 20 ghi / phút / MCP**, **25 + 25 / phút / người** (gộp mọi MCP của người đó). Vượt thì báo _"Google Sheet đang bận…"_ hoặc _"MCP này đã dùng hết 20 lượt…"_ → đợi khoảng 1 phút, xử lý nhiều dòng hơn trong mỗi lần ghi.
- Mỗi lần ghi sheet tính 1 lượt trong **Giới hạn thao tác ghi / 10 phút** của MCP.

### Khác

- Mỗi MCP gán tối đa **50** thư mục / sheet.
- Thư mục con: tối đa 3 cấp khi liệt kê kèm thư mục con.
- Máy chủ chỉ tải **một tệp mỗi lúc cho mỗi MCP** (ảnh/video nhỏ). Gọi dồn dập thì báo _"MCP này đang tải một tệp khác"_ → thử lại sau vài giây.

---

## Phần 8 — Xử lý lỗi thường gặp

Thông báo lỗi trong app và trong câu trả lời của AI đều bằng tiếng Việt. Tìm câu gần giống trong các bảng dưới.

### 8.1 Khi quản trị viên cài đặt (Cài đặt → Google Drive hệ thống)

| Thông báo                                                                            | Nguyên nhân / cách xử lý                                                                    |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Nội dung không phải JSON hợp lệ…                                                     | Dán thiếu. Mở file `.json` bằng Notepad, Ctrl+A, dán lại toàn bộ.                           |
| File JSON không phải khoá service account (trường "type" phải là "service_account"). | Dán nhầm file (vd OAuth client). Tạo khoá ở **Service account → Keys** (Phần 1 Bước 4).     |
| File JSON thiếu client_email / private_key… / private_key… không đọc được.           | File bị sửa hoặc hỏng → tạo khoá JSON mới.                                                  |
| Service account Google không hợp lệ hoặc khoá đã bị thu hồi.                         | Khoá đã bị xoá trong Google Cloud, hoặc service account bị tắt → tạo khoá mới, dán lại.     |
| Project Google Cloud chưa bật Google Drive API hoặc Google Sheets API.               | Bật cả hai (Phần 1 Bước 2), đợi 2–5 phút rồi lưu lại.                                       |
| API key Google phải có dạng AIza… (39 ký tự).                                        | Sao chép thiếu/thừa ký tự.                                                                  |
| Service account này đã được thêm (bởi bạn hoặc người khác).                          | Email này đang là service account riêng của ai đó → dùng service account khác cho hệ thống. |
| Đang có N thư mục / sheet dùng thông tin này…                                        | Muốn **Xoá** phải xoá các nguồn đó trước.                                                   |
| Dán service account JSON hoặc API key mới trước khi lưu.                             | Chưa nhập gì mới.                                                                           |

### 8.2 Khi khai báo thư mục / sheet

| Thông báo                                                                                                                                    | Nguyên nhân / cách xử lý                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chưa cấu hình Google Drive cho hệ thống - liên hệ quản trị viên.                                                                             | Quản trị viên chưa làm Phần 1. Tạm thời dùng service account riêng (3.4).                                                                          |
| Email hệ thống chưa có quyền truy cập file / thư mục này.                                                                                    | Chưa chia sẻ, hoặc chia sẻ nhầm email → chia sẻ lại (Phần 2) rồi **Kiểm tra**.                                                                     |
| Không tìm thấy file hoặc thư mục trên Google Drive.                                                                                          | Link sai, file đã xoá/chuyển, hoặc chưa chia sẻ cho đúng email. Thư mục trong Shared drive: email chưa được thêm vào thư mục.                      |
| Link Google Drive / Google Sheet không hợp lệ. / Link này không phải thư mục Google Drive. / Link này không phải Google Sheet.               | Dán đúng loại: thư mục `drive.google.com/drive/folders/…`, sheet `docs.google.com/spreadsheets/d/…`.                                               |
| Mở đúng tab trong Google Sheet rồi sao chép link (link phải có #gid=…).                                                                      | Bạn sao chép link của cả file. Bấm vào tab ở dưới cùng, sao chép lại địa chỉ.                                                                      |
| Thư mục / file đang nằm trong thùng rác của Google Drive.                                                                                    | Khôi phục từ thùng rác hoặc dùng thư mục khác.                                                                                                     |
| Không khai báo được link này: không tìm thấy, sai loại, đang trong thùng rác, đã có người khác khai báo…                                     | (Nhân viên) Kiểm tra link, chia sẻ, thùng rác. Nếu vẫn bị → thư mục đã có chủ hoặc liên quan thư mục riêng của người khác → liên hệ quản trị viên. |
| Thư mục / sheet này đã được người khác khai báo. / Đã được khai báo bởi …                                                                    | Mỗi nguồn chỉ có một chủ. Nhờ chủ gán thay, hoặc quản trị viên khai báo thành nguồn công ty (chủ cũ xoá khai báo riêng trước).                     |
| Bạn đã khai báo thư mục / sheet này rồi.                                                                                                     | Đã có trong danh sách — mở nó trong tab Google Drive.                                                                                              |
| Google Sheet này đã được khai báo ở phạm vi khác…                                                                                            | Các tab của cùng file phải cùng phạm vi và cùng người khai báo.                                                                                    |
| Thư mục này nằm trong thư mục riêng của người khác. / Thư mục này chứa N thư mục riêng của người khác…                                       | Chọn thư mục khác, hoặc nhờ chủ thư mục riêng xoá khai báo trước.                                                                                  |
| Dòng tiêu đề đang trống - kiểm tra lại số thứ tự dòng tiêu đề.                                                                               | Ô **Dòng tiêu đề** sai (vd sheet có tiêu đề ở dòng 2).                                                                                             |
| Cần chọn cột chứa link Drive (vd. "Link Drive"). / Cột không có trong dòng tiêu đề của sheet. / Mỗi cột trong sheet chỉ được chọn cho 1 mục. | Sửa **Ánh xạ cột**.                                                                                                                                |
| Email đang chỉ có quyền Người xem trên sheet… / Email hệ thống chưa có quyền Người chỉnh sửa trên sheet - không bật được ghi trạng thái.     | Cấp quyền **Người chỉnh sửa** cho email hệ thống → **Kiểm tra** lại → bật ghi.                                                                     |
| Cần chọn cột trạng thái (vd. "Trạng thái") để bật ghi trạng thái.                                                                            | Mở **Cột ghi trạng thái (nâng cao)**, chọn cột Trạng thái.                                                                                         |
| Bạn thao tác quá nhanh - thử lại sau ít giây.                                                                                                | Đợi vài giây.                                                                                                                                      |

### 8.3 Nguồn đang báo "Lỗi" trong danh sách

| Thông báo trên trang chi tiết                                                          | Cách xử lý                                                                                                        |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Không đọc được thư mục / sheet + lý do                                                 | Thường do bỏ chia sẻ, đổi quyền, xoá hoặc chuyển thư mục → sửa trên Drive rồi **Kiểm tra lại**.                   |
| Không tìm thấy trang tính (tab) đã khai báo trong Google Sheet.                        | Tab đã bị xoá → xoá nguồn và khai báo lại bằng link của đúng tab.                                                 |
| Thư mục / Sheet này hiện nằm bên trong thư mục cá nhân của người khác đã được đăng ký… | Ai đó đã chuyển thư mục vào thư mục riêng của người khác → chuyển ra ngoài (hoặc xoá nguồn) rồi **Kiểm tra lại**. |
| Thông tin xác thực Google Drive đang lỗi (đầu tab)                                     | Quản trị viên mở **Cài đặt → Google Drive hệ thống → Kiểm tra** để xem lý do.                                     |

### 8.4 Khi AI dùng Drive / Sheet

AI thường đọc mã lỗi (dạng `drive_…`) kèm thông báo; bạn chỉ cần đọc phần tiếng Việt.

| Mã lỗi                                       | Thông báo                                                                                   | Cách xử lý                                                                                                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `drive_not_in_scope`                         | Không tìm thấy file trong các thư mục được cấp cho MCP này.                                 | File không nằm trong thư mục đã gán cho MCP và không phải link công khai → gán thư mục vào MCP (Phần 5) hoặc chuyển file vào thư mục đã gán.                           |
| `drive_source_not_in_scope`                  | … không thuộc phạm vi của MCP này.                                                          | AI dùng sai mã nguồn → bảo AI "xem lại danh sách nguồn Drive được cấp".                                                                                                |
| `drive_not_public`                           | File chưa được chia sẻ công khai "Bất kỳ ai có link".                                       | Đổi chia sẻ file thành **Bất kỳ ai có đường liên kết**, hoặc đưa file vào thư mục đã khai báo. Công ty chỉ chia sẻ trong tên miền → bắt buộc dùng thư mục đã khai báo. |
| `drive_public_links_disabled`                | MCP này không cho phép dùng link Google Drive công khai.                                    | Bật công tắc trong tab **Cấu hình** của MCP, hoặc dùng thư mục đã gán.                                                                                                 |
| `drive_api_key_invalid`                      | API key Google không hợp lệ hoặc không được phép gọi Google Drive API.                      | Quản trị viên kiểm tra key (giới hạn API: **Google Drive API**) và lưu lại.                                                                                            |
| `drive_not_configured`                       | Chưa cấu hình Google Drive cho hệ thống.                                                    | Quản trị viên làm Phần 1 (link công khai cần API key).                                                                                                                 |
| `drive_permission_denied`                    | Email hệ thống chưa có quyền truy cập file / thư mục này.                                   | Chia sẻ lại cho email hệ thống.                                                                                                                                        |
| `drive_not_found`                            | Không tìm thấy file hoặc thư mục trên Google Drive.                                         | File đã bị xoá/chuyển.                                                                                                                                                 |
| `drive_subfolder_not_found`                  | Không tìm thấy thư mục con "…"                                                              | Tên thư mục con sai → hỏi AI "trong thư mục X có những thư mục con nào?".                                                                                              |
| `drive_not_downloadable`                     | File này không phải ảnh hoặc video tải được (vd. Google Docs, Sheets, Slides).              | Chỉ dùng ảnh/video thật.                                                                                                                                               |
| `drive_unsupported_type`, `media_wrong_type` | Loại file không được hỗ trợ. / … không nhận loại ảnh này.                                   | Đổi định dạng theo bảng Phần 7 (vd WebP → JPG cho Google Ads/TikTok).                                                                                                  |
| `media_too_large`                            | Ảnh … vượt giới hạn N MB của … / Video … vượt giới hạn 500 MB. / Video đính kèm … quá lớn…  | Nén file. Video đính kèm ChatGPT quá lớn → đưa lên Drive.                                                                                                              |
| —                                            | … chỉ nhận ảnh - không tải được video.                                                      | Google Ads: đăng video lên YouTube rồi đưa link YouTube. OpenAI Ads: chỉ dùng ảnh.                                                                                     |
| `drive_abusive_file`                         | Google đánh dấu file này có thể độc hại - chỉ chủ file mới tải được.                        | Tải lại file gốc lên Drive.                                                                                                                                            |
| `drive_size_unknown`                         | Google Drive không cho biết dung lượng / phiên bản của video này.                           | Tải lại video lên Drive rồi thử lại.                                                                                                                                   |
| `drive_rate_limited`                         | Google Drive đang giới hạn số lượt gọi.                                                     | Thử lại sau ít phút.                                                                                                                                                   |
| `drive_sheet_busy`                           | Google Sheet đang bận… / MCP này đã dùng hết 20 lượt đọc/ghi Google Sheet trong một phút.   | Đợi khoảng 1 phút; xử lý nhiều dòng hơn mỗi lần ghi.                                                                                                                   |
| `drive_timeout`, `drive_upstream_error`      | Google Drive phản hồi quá lâu. / Google Drive / Google Sheets đang gặp lỗi.                 | Thử lại sau ít phút.                                                                                                                                                   |
| `drive_invalid_sheet`                        | Sheet thiếu cột bắt buộc hoặc dòng tiêu đề không đúng.                                      | Ai đó đổi tên/xoá cột → sửa tên cột trong sheet hoặc **Sửa cài đặt** (ánh xạ cột).                                                                                     |
| `drive_sheet_tab_not_found`                  | Không tìm thấy trang tính (tab) đã khai báo…                                                | Khai báo lại bằng link của đúng tab.                                                                                                                                   |
| `drive_writeback_disabled`                   | Sheet này không bật ghi trạng thái.                                                         | Bật **Cho phép AI ghi trạng thái vào sheet** ở trang sheet **và** **Cho phép ghi trạng thái vào Google Sheet** trong MCP.                                              |
| `row_moved`                                  | Dòng trong sheet đã thay đổi (bị chèn, xoá hoặc sắp xếp lại) - đã bỏ qua để tránh ghi nhầm. | Bảo AI đọc lại sheet rồi ghi lại.                                                                                                                                      |
| `drive_auth_failed`, `drive_api_disabled`    | Service account Google không hợp lệ… / Project Google Cloud chưa bật…                       | Báo quản trị viên (8.1).                                                                                                                                               |
| `media_busy`                                 | MCP này đang tải một tệp khác… / Máy chủ đang tải tệp khác…                                 | Thử lại sau vài giây.                                                                                                                                                  |
| `permission_denied`                          | … cần quyền "Tạo mới"…                                                                      | Bật quyền **Tạo mới** cho nền tảng trong MCP.                                                                                                                          |
| `chatgpt_file_unavailable`                   | ChatGPT gửi tham chiếu tệp kiểu chat_upload…                                                | Dùng ChatGPT bản web để đính kèm, hoặc dùng Google Drive.                                                                                                              |
| Không thấy tool `drive_*`                    | —                                                                                           | MCP chưa gán thư mục/sheet, và link công khai không dùng được (công tắc tắt / chưa có API key / không có quyền Tạo mới). ChatGPT Business: **Refresh** plugin.         |

### 8.5 Video tải nền

| Mã lỗi / tình huống                                | Thông báo                                                                                                          | Cách xử lý                                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `upload_limit_reached`                             | MCP này / Các MCP của chủ sở hữu MCP này đang có N video tải lên ở chế độ nền… / Hệ thống đang có nhiều video chờ… | Đợi vài phút cho lượt trước xong (hỏi AI tiến độ).                                         |
| `upload_queue_unavailable`                         | Không đưa được video vào hàng đợi tải nền (bộ xử lý nền chưa sẵn sàng).                                            | Thử lại sau ít phút; nếu vẫn lỗi, quản trị viên kiểm tra **worker** (Phần 10).             |
| `upload_not_found`                                 | Không tìm thấy lượt tải nền này trong MCP.                                                                         | Bảo AI xem các lượt tải gần đây (không kèm mã).                                            |
| Lượt tải báo lỗi                                   | Việc tải lên bị gián đoạn do worker khởi động lại… / Lượt tải bị dừng vì quá lâu không cập nhật tiến độ…           | Bảo AI tải lại.                                                                            |
| Lượt tải báo lỗi                                   | File video trên Google Drive đã bị thay đổi, xoá hoặc chuyển vào thùng rác sau khi yêu cầu tải lên.                | Đừng sửa/di chuyển video khi đang tải; tải lại.                                            |
| Lượt tải báo lỗi                                   | Video không còn nằm trong thư mục Google Drive được cấp cho MCP…                                                   | Video bị chuyển khỏi thư mục, hoặc thư mục bị gỡ khỏi MCP.                                 |
| Lượt tải báo lỗi                                   | Tài khoản quảng cáo không còn trong phạm vi của MCP… / MCP đã bị tắt, hết hạn hoặc bị xoá…                         | MCP vừa bị sửa/tắt trong lúc tải → kiểm tra cấu hình MCP.                                  |
| Lượt tải báo lỗi                                   | Yêu cầu tải video lên chờ quá lâu nên đã bị huỷ…                                                                   | Chờ quá 24 giờ (thường do worker không chạy) → quản trị viên kiểm tra worker, rồi tải lại. |
| Lượt tải báo lỗi                                   | Video đã lên nền tảng nhưng lượt tải đã bị đánh dấu lỗi trước đó…                                                  | Video thật ra đã lên; mã video nằm trong **Nhật ký MCP**.                                  |
| Tin nhắn trả về                                    | Tệp này đang được tải lên tài khoản này, thử lại sau ít phút…                                                      | Một MCP khác đang tải cùng file vào cùng TKQC → đợi xong, gọi lại sẽ nhận mã media.        |
| Meta / TikTok báo không tải được video (video nhỏ) | —                                                                                                                  | Thường do Cloudflare chặn đường dẫn `/dl/*` → quản trị viên xem Phần 10.                   |

---

## Phần 9 — Bảo mật, quyền riêng tư và thu hồi quyền

### Hệ thống đọc được gì

- **Chỉ** những thư mục / file / sheet được chia sẻ cho email hệ thống (hoặc service account riêng), và file **công khai** khi có link.
- Quyền Google của email hệ thống: **chỉ đọc** Drive; với sheet, chỉ **ghi** được khi bạn cấp quyền Người chỉnh sửa (và hệ thống chỉ ghi 5 cột hệ thống).
- Link công khai luôn được đọc bằng **API key ẩn danh**, không bao giờ bằng email hệ thống → không ai dùng được link để lấy file riêng tư của người khác.
- MCP của nhân viên chỉ thấy nguồn **công ty** và nguồn **riêng của chủ MCP**; mỗi lần dùng, hệ thống kiểm tra lại file có còn nằm trong thư mục được cấp không. Thư mục riêng của người khác nằm bên trong một thư mục được cấp sẽ bị **ẩn** với MCP của nhân viên.
- **Quản trị viên thấy và gán được mọi nguồn**, kể cả nguồn riêng của nhân viên.

### AI thấy gì

- Tên file, loại, dung lượng, độ phân giải, thời lượng, ngày sửa, đường dẫn thư mục, mã file, TKQC đã dùng.
- **Không** thấy: khoá JSON, API key, link tải trực tiếp, ảnh thu nhỏ, link tạm của video.
- Tên file, tên thư mục, nội dung ô sheet được coi là **dữ liệu** — AI không làm theo câu lệnh nằm trong đó.

### Lưu trữ

- File **không** được lưu trên máy chủ: ảnh đi qua bộ nhớ tạm rồi lên nền tảng; video đi qua máy chủ từng đoạn.
- Hệ thống chỉ lưu: thông tin nguồn (tên, mã Google), mã file đã tải lên TKQC nào (để dùng lại), và nhật ký.
- Video nhỏ được nền tảng tự tải qua một **link tạm** dạng `https://<tên-miền>/dl/…`: hết hạn sau **60 phút**, giới hạn số lượt tải, gắn với đúng một file và chỉ hoạt động khi MCP còn quyền.
- Mọi lượt AI dùng Drive (liệt kê, đọc sheet, tải lên, ghi sheet trước → sau) được ghi ở **Nhật ký → Nhật ký MCP**. Thao tác khai báo / sửa / xoá nguồn ghi ở nhật ký nhân sự.

### Link công khai — cân nhắc

Link "Bất kỳ ai có đường liên kết" làm lộ creative **chưa chạy** cho bất kỳ ai cầm link. Với tài liệu nội bộ, nên dùng thư mục đã khai báo. Quản trị viên có thể tắt link công khai cho cả hệ thống (bỏ API key) hoặc từng MCP (công tắc).

### Thu hồi quyền

| Muốn                                       | Làm                                                                                                                                                                           |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ngừng cho hệ thống đọc một thư mục / sheet | Google Drive → **Chia sẻ** → xoá email hệ thống. Lần kiểm tra kế tiếp nguồn chuyển sang **Lỗi**.                                                                              |
| Gỡ nguồn khỏi Ads MCP và mọi MCP           | Trang chi tiết nguồn → **Xoá**. File trên Drive không bị ảnh hưởng.                                                                                                           |
| Gỡ khỏi một MCP                            | Trang MCP → tab **Cấu hình** → bỏ tick nguồn → lưu.                                                                                                                           |
| Ngừng ghi sheet                            | Tắt **Cho phép AI ghi trạng thái vào sheet** (trang sheet) hoặc hạ quyền email xuống **Người xem**.                                                                           |
| Xoá service account riêng                  | **Kết nối → Google Drive → Service account riêng → Xoá** (xoá các nguồn đang dùng nó trước).                                                                                  |
| Quản trị viên: vô hiệu hoá toàn bộ         | **Cài đặt → Google Drive hệ thống → Xoá**, và/hoặc trong Google Cloud: xoá khoá (**IAM & Admin → Service accounts → Keys**), xoá API key (**APIs & Services → Credentials**). |
| Nghi lộ file khoá JSON                     | Google Cloud → xoá khoá đó ngay, tạo khoá mới, dán vào **Cài đặt → Google Drive hệ thống**.                                                                                   |

---

## Phần 10 — Ghi chú vận hành cho quản trị viên

- **Worker phải chạy.** Video lớn (TikTok > 10 MB, Meta > 50 MB) do container `worker` tải nền, mỗi lần một video. Worker dừng → lượt tải nằm chờ (quá 24 giờ bị huỷ). Worker cũng chạy kiểm tra định kỳ nguồn Drive (6 giờ/lần), dọn link tạm hết hạn (hằng ngày) và đánh dấu lượt tải bị treo (10 phút/lần). Kiểm tra: `docker compose ps` (worker `running`), `docker compose logs -f --tail=200 worker`. Xem [van-hanh.md](van-hanh.md).
- **Đường dẫn `/dl/*` phải truy cập được từ Internet** để máy chủ Meta/TikTok tải video nhỏ. Tên miền đi qua **Cloudflare**: không bật Bot Fight Mode, challenge, Under Attack Mode, Browser Integrity Check cho `/dl/*`, không tạo rule "Cache Everything" cho `/dl/*` — xem [deploy-vps.md §9.2 bước 10](deploy-vps.md#92-cấu-hình-cloudflare-dashboard). Dùng **Cloudflare Access**: phải **Bypass** `/dl/*` — xem [deploy-vps.md §10b.8](deploy-vps.md#10b8-cloudflare-access-cho-giao-diện-web-tuỳ-chọn). Triệu chứng khi bị chặn: AI báo Meta/TikTok không tải được video.
- **Băng thông:** video đi Drive → máy chủ → nền tảng, tốn băng thông cả chiều vào lẫn ra (không ghi đĩa). Video 500 MB = khoảng 1 GB lưu lượng.
- **Bộ nhớ:** ảnh được giữ tạm trong RAM (tối đa 2 tệp cùng lúc mỗi tiến trình, dùng chung với Telegram); video tải nền chỉ giữ một đoạn (≤ 64 MB) mỗi lúc.
- **Máy chủ ra Internet qua proxy:** việc tải ảnh/video từ link (và tệp đính kèm ChatGPT) luôn kết nối trực tiếp, không đi qua proxy — máy chủ chỉ ra Internet qua proxy sẽ không tải được.
- **Quota Google:** mọi người dùng chung quota của project chứa service account (Sheets ~60 đọc + 60 ghi/phút). Nhiều đội cùng xử lý sheet lớn → cân nhắc chia đợt.
- **Đổi khoá mã hoá máy chủ:** lệnh `reencrypt` ([van-hanh.md](van-hanh.md)) mã hoá lại cả khoá JSON và API key Google Drive.
