# Hướng dẫn lấy token TikTok Ads (TikTok API for Business)

> Áp dụng cho **Ads MCP by: noti.vn**. Cập nhật theo TikTok Marketing API **v1.3** (rà lại 08/10/2026; mục GMV Max rà ngày 10/10/2026).

TikTok không có “token vĩnh viễn tự tạo” như Meta. Bạn cần: (1) một **developer app** trên TikTok API for Business, (2) **advertiser uỷ quyền** cho app → nhận `auth_code`, (3) **đổi `auth_code` lấy access token**. Token advertiser **không hết hạn** và **không cần làm mới** (chỉ mất khi bị thu hồi).

## Bạn cần chuẩn bị

- Tài khoản **TikTok For Business** có quyền Admin/Operator trên các TKQC (hoặc Business Center chứa TKQC).
- Địa chỉ Ads MCP của bạn (ví dụ `https://ads.congty.vn`): dùng làm URL nhận redirect.

## Bước 1 — Đăng ký developer & tạo app

1. Vào <https://business-api.tiktok.com/portal> → đăng nhập → **Become a developer**.
   - **Xác minh email**: bấm **Send Code**, nhập mã gửi tới email (mã dùng lại được trong **48 giờ**).
   - Điền thông tin công ty/hồ sơ developer → gửi. **Chờ hồ sơ developer được duyệt trước** rồi mới tạo được app.
   - Mỗi developer tạo tối đa **5 app**.
2. **My Apps → Create new app**.
3. Điền tên app, mô tả mục đích (vd “Quản lý quảng cáo nội bộ qua AI”).
4. **Advertiser redirect URL**: nhập đúng `https://<tên miền Ads MCP của bạn>/connections/new` (bước hướng dẫn trong trang **Thêm kết nối → TikTok** hiện sẵn địa chỉ chính xác để sao chép). Không dùng `localhost` hay website khác để tránh nhầm.
5. **Scope of permission** — tick **TẤT CẢ** nhóm quyền và **mọi ô con**, **trừ 2 ô** `GMV MAX → Session` và `GMV MAX → Exclusive Authorization` (để trống). Cách nhanh: tick ô của từng nhóm cấp 1 để chọn trọn nhóm, mở từng nhóm kiểm tra không sót ô con nào, rồi bỏ tick 2 ô kia:

| Nhóm quyền                               | Dùng để                                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Ad Account Management**                | Liệt kê TKQC, đọc tiền tệ/múi giờ                                                                            |
| **Ads Management** (mọi ô con)           | Đọc/sửa/bật tắt/sao chép/tạo chiến dịch, nhóm, quảng cáo                                                     |
| **Ads Management → GMV MAX** (trừ 2 ô) | GMV Max (TikTok Shop): Store Management, Identity And Video, custom anchor. **Không tick** Session và Exclusive Authorization |
| **Reporting** (mọi ô con)                | Kéo số liệu                                                                                                  |
| **Reporting → GMV MAX Report**           | Kéo số liệu GMV Max                                                                                          |
| **Creative Management**                  | Tải ảnh/video, identity                                                                                      |
| **Pixel Management**                     | Chọn pixel khi tạo nhóm quảng cáo chuyển đổi                                                                 |
| **Audience Management**                  | Dùng tệp đối tượng                                                                                           |
| **Onsite Commerce Store**                | Đọc sản phẩm TikTok Shop (chọn sản phẩm cho GMV Max)                                                         |
| Mọi nhóm quyền khác có trong danh sách   | Tick luôn - thiếu ô nào thì thao tác cần ô đó lỗi `40001`, muốn thêm sau phải chờ TikTok duyệt lại           |

Cấp đủ quyền cho app **không có nghĩa AI được làm hết**: AI chỉ làm những gì bạn cho phép trong từng MCP (Chỉ xem, Bật/Tắt, Sửa…); riêng thay đổi GMV Max chỉ **quản trị viên** bật được trong MCP. 6. Gửi duyệt. TikTok duyệt app trong khoảng **2–3 ngày làm việc**. 7. Khi app được duyệt, mở app → ghi lại **App ID** và **Secret**.

> [!NOTE]
> **Đổi scope sau này**: app bị TikTok duyệt lại (**2–3 ngày làm việc**), sau đó advertiser phải **uỷ quyền lại** (Bước 2–3) thì token mới có quyền mới. Token cũ giữ nguyên quyền cũ.

> [!TIP]
> Chạy **GMV Max (TikTok Shop)**? Kiểm tra kỹ các ô **Ads Management → GMV MAX** (Store Management, Identity And Video, custom anchor), **Reporting → GMV MAX Report** và **Onsite Commerce Store** đã được tick, còn **GMV MAX → Session** và **GMV MAX → Exclusive Authorization** để trống. Chi tiết: mục [GMV Max (TikTok Shop)](#gmv-max-tiktok-shop).

## Bước 2 — Advertiser uỷ quyền, lấy `auth_code`

1. Trong trang app, sao chép **Advertiser authorization URL**.
2. Mở URL đó bằng trình duyệt đã đăng nhập tài khoản TikTok For Business **có quyền trên TKQC** → chọn các TKQC/Business Center → **Confirm**.
3. Trình duyệt chuyển về redirect URL dạng:
   ```
   https://<tên miền Ads MCP của bạn>/connections/new?auth_code=XXXXXXXXXXXXXXXX&code=XXXXXXXXXXXXXXXX&state=...
   ```
   Sao chép giá trị `auth_code` trên thanh địa chỉ (chỉ phần sau `auth_code=` và trước dấu `&`).

> [!WARNING]
> `auth_code` **chỉ sống tối đa 1 giờ và chỉ dùng được 1 lần** — hãy đổi lấy token **ngay** (Bước 3). Nếu đổi thất bại (lỗi `40110`/`40113`), quay lại Bước 2 lấy mã mới — đừng thử lại mã cũ.

## Bước 3 — Đổi `auth_code` lấy access token

**Cách dễ nhất (trong Ads MCP)**: **Kết nối → Thêm kết nối → TikTok** → chọn chế độ **auth_code** → điền App ID, Secret, dán `auth_code` → app tự đổi lấy access token, ghi nhận scope và hiện danh sách TKQC được uỷ quyền.

> Lần đầu thêm kết nối, Ads MCP hiện popup **Miễn trừ trách nhiệm**: kéo đọc hết nội dung, chờ hết đếm ngược 10 giây, tick ô **Tôi đã đọc kỹ, hiểu và đồng ý…** rồi bấm **Tôi đồng ý và bắt đầu** (bấm **Huỷ** = không kết nối). Đã xác nhận thì những lần sau không hỏi lại, trừ khi nội dung được cập nhật phiên bản mới.

**Cách thủ công** (nếu cần):

```bash
curl -X POST "https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/" \
  -H "Content-Type: application/json" \
  -d '{"app_id":"<APP_ID>","secret":"<SECRET>","auth_code":"<AUTH_CODE>","return_advertiser_ids":true}'
```

Kết quả có `"code":0` và `data.access_token`, `data.advertiser_ids`, `data.scope`. Lưu `access_token` an toàn (đây là “mật khẩu” của các TKQC).

- Business Center **rất nhiều TKQC**: dùng `"return_advertiser_ids":false` để phản hồi gọn — Ads MCP vẫn tự lấy danh sách TKQC sau khi lưu.
- Lưu ý URL API **phải có dấu `/` cuối** (`.../access_token/`); thiếu dấu `/` TikTok trả chuyển hướng (HTTP 308).

## Bước 4 — Dán vào Ads MCP

| Ô            | Giá trị                                       |
| ------------ | --------------------------------------------- |
| Access token | Từ Bước 3 (bắt buộc)                          |
| App ID       | Bắt buộc — dùng để liệt kê TKQC được uỷ quyền |
| Secret       | Bắt buộc                                      |

Bấm **Kiểm tra** → chọn TKQC → **Lưu**. Dán token có sẵn thì TikTok không cho kiểm tra scope — dùng chế độ **auth_code** để Ads MCP ghi nhận scope và cảnh báo nếu thiếu quyền.

## GMV Max (TikTok Shop)

> Rà theo tài liệu chính thức của TikTok ngày 10/10/2026. Tên nút/menu của TikTok ghi theo giao diện **tiếng Anh**; giao diện tiếng Việt có thể ghi khác một chút.

**GMV Max** là quảng cáo tự động của **TikTok Shop** (GMV Max sản phẩm và GMV Max cho LIVE). Ads MCP đọc GMV Max qua **chính kết nối TikTok Ads** ở trên — **không cần tạo kết nối riêng**. App chỉ cần **đủ quyền** (tick tất cả, Bước 1). Trong trang **Thêm kết nối → TikTok Ads**, bấm **Xem hướng dẫn GMV Max** để xem bản hướng dẫn này ngay trong ứng dụng.

> [!WARNING]
> **Dùng AI để XEM và PHÂN TÍCH chỉ số GMV Max; hạn chế bật/tắt hay sửa chiến dịch.** GMV Max tự tối ưu theo ngày. TikTok khuyên giữ mỗi mức ROI mục tiêu **ít nhất 3 ngày trọn vẹn** (LIVE: sửa ROI tối đa 1 lần/ngày). Tạm dừng, xoá, sửa ROI hoặc sửa sản phẩm trong ngày sẽ **mất Bảo vệ ROI** (tín dụng quảng cáo) của ngày đó.
>
> Vì vậy trong Ads MCP: mặc định AI **chỉ xem** GMV Max. AI chỉ bật/tắt, sửa, sao chép, tạo mới hay xoá chiến dịch GMV Max khi **quản trị viên bật “Cho phép AI thay đổi GMV Max (TikTok Shop)”** trong MCP, và **mọi thay đổi luôn phải xác nhận 2 bước** — xem [Cho AI thay đổi GMV Max](#cho-ai-thay-đổi-gmv-max-chỉ-quản-trị-viên).

> [!CAUTION]
> Chiến dịch GMV Max **tạo mới hoặc sao chép** qua API **CHẠY NGAY** và tiêu tiền ngay — TikTok không cho tạo ở trạng thái tạm dừng — và có thể **tự tạm dừng quảng cáo Shop khác** dùng cùng cửa hàng / sản phẩm / tài khoản TikTok ở **mọi** TKQC.

### Cần chuẩn bị

- Một **TikTok Shop** đang hoạt động ở **Việt Nam, Indonesia, Malaysia, Philippines, Singapore, Thái Lan hoặc Mỹ**.
- Một **Business Center** chứa cả cửa hàng và tài khoản quảng cáo (TKQC) muốn dùng cho GMV Max.
- Bạn là **Admin** của Business Center (vai trò Standard là chưa đủ), có quyền **Ad promotion** với cửa hàng, và là **Admin** hoặc **Operator** của TKQC.
- Mỗi cửa hàng chỉ có **1 TKQC GMV Max** tại một thời điểm.

### Bước G1 — Đưa cửa hàng vào Business Center

**Cửa hàng của bạn:**

1. Mở <https://business.tiktok.com/> → menu trái **Accounts** → **Shops**.
2. Bấm **Add Shop** → chọn cửa hàng → **Start setup in TikTok Seller Center**.
3. Làm tiếp trong Seller Center → **Finish Setup**.
   - _Bạn sẽ thấy:_ cửa hàng hiện trong danh sách **Shops** của Business Center.

**Agency (cửa hàng của khách):**

1. Xin chủ cửa hàng **mã cửa hàng** (shop code).
2. Business Center → **Add shop** → **Request access to TikTok shop partners** → nhập mã → **Request**.
   - _Bạn sẽ thấy:_ chủ cửa hàng nhận email; khi họ duyệt, cửa hàng hiện trong Business Center của bạn.
3. Mở cửa hàng → **Assign new member** để cấp quyền cho người chạy quảng cáo.

### Bước G2 — Chọn TKQC GMV Max cho cửa hàng

Làm **một trong hai** cách:

**Cách A — Seller Center (chủ cửa hàng):**

1. Đăng nhập **TikTok Shop Seller Center** → menu trái **Shop Ads** → **Manage account** (bản tiếng Việt: **Quảng cáo Shop** → **Quản lý tài khoản**).
2. Mục **GMV Max account** → **Add GMV Max account** (phần **Authorization needed**).
3. Chọn TKQC → xác nhận. Nên đặt làm **primary ad account** để xem số liệu GMV Max ngay trong Seller Center.
   - _Bạn sẽ thấy:_ TKQC hiện trong mục **GMV Max account**.
   - Cách này cần TKQC, tài khoản TikTok và cửa hàng nằm **cùng một Business Center**.

**Cách B — Business Center (agency hoặc chủ cửa hàng):**

1. Business Center → menu trái **Accounts** → **TikTok Shop Accounts**.
2. Chọn cửa hàng → **Set up GMV Max** → chọn TKQC → **Request GMV Max authorization** → **Confirm**.
   - _Bạn sẽ thấy:_ yêu cầu ở trạng thái **Pending**.
3. Chủ cửa hàng nhận email + thông báo trong Business Center → bấm **Approve**.
   - _Bạn sẽ thấy:_ TKQC có nhãn **GMV Max account** trong Business Center.

> [!CAUTION]
> Đổi cửa hàng sang **TKQC GMV Max khác**: mọi chiến dịch GMV Max của cửa hàng ở TKQC cũ **tự tạm dừng** và phải tạo lại ở TKQC mới. Chỉ đổi khi thật cần.

### Bước G3 — GMV Max cho LIVE (tuỳ chọn)

1. Kết nối tài khoản TikTok chính thức của cửa hàng vào Business Center → bấm **Turn on exclusive LIVE GMV Max permissions**.
2. Business Center → **Accounts** → chọn tài khoản TikTok đó → **Link ad account** → chọn TKQC GMV Max → **Confirm**.
   - Một tài khoản TikTok chỉ cấp quyền cho **một** Business Center tại một thời điểm.

### Bước G4 — Cấp đủ quyền cho app (tick tất cả) rồi cấp quyền lại

1. **TikTok API for Business → My Apps** → chọn app → mục **Scope of permission** → bấm biểu tượng chỉnh sửa.
2. Tick **tất cả** nhóm quyền và mọi ô con (như bảng ở Bước 1), **trừ** **GMV MAX → Session** và **GMV MAX → Exclusive Authorization**. Kiểm tra kỹ: **Ads Management → GMV MAX** (Store Management, Identity And Video, custom anchor), **Reporting → GMV MAX Report** và **Onsite Commerce Store**.
   - _Bạn sẽ thấy:_ mọi ô trong Scope of permission đều được tick.
3. Ghi lý do → **Submit**. TikTok duyệt lại app trong **2–3 ngày làm việc**.
4. Token cũ **không tự có quyền mới**: advertiser mở lại **Advertiser authorization URL** (Bước 2) → nhận `auth_code` mới.
5. Trong Ads MCP: kết nối **mới** → **Đổi auth_code**; kết nối **đã có** → mở kết nối → **Thay token** → **Đổi auth_code** (mã sống 1 giờ, dùng 1 lần).

### Bước G5 — Kiểm tra

1. Bấm **Kiểm tra kết nối** (khi thêm mới) hoặc **Kiểm tra lại** (trang chi tiết kết nối). Ads MCP đọc danh sách cửa hàng GMV Max của tối đa 10 TKQC đầu tiên:
   - Sẵn sàng → mục **Lưu ý** có dòng “GMV Max (TikTok Shop): tài khoản … đã sẵn sàng với … cửa hàng”.
   - Thiếu quyền → dòng “Token chưa có quyền GMV Max (Store Management / GMV MAX Report)…” → làm lại Bước G4.
   - Không dùng TikTok Shop → không có dòng nào về GMV Max (bình thường).
2. Lưu kết nối, chọn TKQC đó khi tạo MCP. Mức quyền **Chỉ xem** là đủ để AI phân tích GMV Max; muốn AI thay đổi GMV Max xem mục dưới.
3. Hỏi AI: “**Kiểm tra cửa hàng GMV Max của TKQC X**” → AI dùng `tiktok_gmv_max_shops` và cho biết cửa hàng nào sẵn sàng, cửa hàng nào chưa và vì sao.

Cửa hàng chưa sẵn sàng thường do: TKQC chưa là **GMV Max account** của cửa hàng (G2), thiếu quyền **Ad promotion** hoặc không phải **Admin** Business Center, hoặc cửa hàng ở ngoài 7 thị trường có GMV Max.

### Cho AI thay đổi GMV Max (chỉ quản trị viên)

Mặc định MCP **chỉ xem** GMV Max. Muốn AI bật/tắt, sửa, sao chép, tạo mới hay xoá chiến dịch GMV Max:

1. **Quản trị viên** mở **MCP → Tạo MCP** (hoặc MCP có sẵn → tab **Cấu hình**) → bước **Chọn quyền** → thẻ **TikTok Ads**: chọn các quyền cần dùng (Bật/Tắt, Sửa, Sao chép, Tạo mới, Xoá/Lưu trữ) rồi bật **Cho phép AI thay đổi GMV Max (TikTok Shop)** (mặc định tắt).
   - Nếu TKQC đã chọn có cửa hàng GMV Max (theo lần **Kiểm tra kết nối** gần nhất), cảnh báo hiện nổi bật ngay dưới công tắc.
2. Bước **Bảo vệ**: bật **Tùy chỉnh nâng cao** và nhập **Trần ngân sách/ngày** cho loại tiền của TKQC. Ở chế độ **Cơ bản** (mặc định của MCP mới, không có trần) AI vẫn bật/tắt và đổi ngân sách GMV Max được (luôn xác nhận 2 bước) nhưng **không tạo mới / sao chép** được chiến dịch GMV Max.
3. **Nhân viên** thấy công tắc bị khoá với dòng “Chỉ quản trị viên bật được - nhờ quản trị viên mở MCP này để bật”. Nhân viên tắt được nếu quản trị viên đã bật, nhưng sau khi lưu chỉ quản trị viên bật lại được.
4. Trang tổng quan MCP hiện dòng **AI thay đổi GMV Max: Bật / Tắt**.

Ảnh hưởng của từng quyền tới GMV Max:

| Quyền                  | Ảnh hưởng                                                                                                                                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Bật/Tắt**            | Tạm dừng giữa ngày làm **mất Bảo vệ ROI** của ngày đó. Bật lên có thể **tự tạm dừng quảng cáo Shop khác** dùng cùng cửa hàng / sản phẩm / tài khoản TikTok ở mọi TKQC.                                                                                                       |
| **Sửa**                | Ngân sách: tự tăng ngân sách có thể chi tới **khoảng 31 lần** ngân sách ngày, ngày khuyến mãi thêm 50%. ROI mục tiêu: giữ **ít nhất 3 ngày** (LIVE: tối đa 1 lần/ngày), sửa ROI làm mất Bảo vệ ROI. Sản phẩm / video: mất Bảo vệ ROI của ngày sửa, GMV Max phải tối ưu lại. |
| **Sao chép / Tạo mới** | Chiến dịch mới **CHẠY NGAY**, tiêu tiền ngay. Mỗi sản phẩm chỉ ở **1** chiến dịch GMV Max sản phẩm đang bật; có thể tự tạm dừng quảng cáo Shop khác.                                                                                                                         |
| **Xoá/Lưu trữ**        | **Không hoàn tác**, mất dữ liệu tối ưu đã học và mất Bảo vệ ROI của ngày xoá.                                                                                                                                                                                                 |

Luôn áp dụng: **mọi thay đổi GMV Max phải xác nhận 2 bước** (kể cả khi MCP tắt xác nhận 2 bước hoặc ở chế độ bảo vệ Cơ bản). Ở chế độ **Tùy chỉnh nâng cao**: **bắt buộc có trần ngân sách/ngày**, tính theo **mức chi tối đa có thể mỗi ngày** (gồm tự tăng ngân sách, ngày khuyến mãi). Ở chế độ **Cơ bản**: tạo mới / sao chép GMV Max bị từ chối (bật/tắt, đổi ngân sách không có trần). Khi AI đổi ROI mục tiêu quá sớm (GMV Max sản phẩm: chưa đủ 3 ngày; LIVE: đã đổi trong ngày), bản xem trước có cảnh báo.

Không làm qua MCP: đổi **tài khoản GMV Max độc quyền** của cửa hàng (exclusive authorization — làm vậy sẽ tạm dừng mọi chiến dịch GMV Max ở TKQC cũ), phiên **Max delivery / Creative boost**. GMV Max không có nhóm quảng cáo — muốn đổi nội dung thì sửa **sản phẩm** và **video** của chiến dịch.

### Câu hỏi mẫu cho AI (chỉ phân tích)

- “Tổng chi tiêu, doanh thu, ROI và số đơn GMV Max 7 ngày qua của TKQC X, chia theo ngày.”
- “So sánh các chiến dịch GMV Max sản phẩm tháng này: chiến dịch nào ROI thấp hơn mục tiêu?”
- “Top 10 sản phẩm theo doanh thu tuần qua trong chiến dịch GMV Max Y. Sản phẩm nào tốn tiền mà ít đơn?”
- “Video nào trong chiến dịch Y kéo nhiều đơn nhất? Video nào chi nhiều mà chưa ra đơn?”
- “Phiên LIVE nào hôm qua có ROI tốt nhất?”
- “Chiến dịch GMV Max nào đang kém? Chỉ phân tích và đề xuất, chưa sửa gì.”

Khi đọc số liệu GMV Max, nhớ:

- ROI và số đơn của GMV Max **gồm cả đơn tự nhiên** — không so trực tiếp với ROAS của báo cáo TikTok thường.
- Chi tiêu GMV Max **có thể không nằm (đầy đủ)** trong báo cáo TikTok thường (TikTok loại GMV Max tạo từ TikTok Shop; loại tạo nơi khác chưa được xác minh) — **không cộng** hai báo cáo với nhau vì có thể bị trùng hoặc sai.
- Báo cáo GMV Max cấp tài khoản chỉ tính chiến dịch **chưa xoá**; cần tổng chi tiêu đầy đủ (gồm chiến dịch đã xoá) thì hỏi theo **cấp chiến dịch**.
- Một số chỉ số GMV Max trễ tới khoảng **11 giờ**; dữ liệu chỉ có từ **27/09/2024**.

Tài liệu TikTok: [Hướng dẫn về GMV Max](https://ads.tiktok.com/help/article/gmv-max-guidelines?lang=vi) · [Bảo vệ ROI](https://ads.tiktok.com/help/article/about-roi-protection-for-gmv-max-campaigns?lang=vi) · [Phương pháp hay nhất cho GMV Max sản phẩm](https://ads.tiktok.com/help/article/best-practices-for-product-gmv-max?lang=vi) · [Xin quyền GMV Max trong Business Center](https://ads.tiktok.com/help/article/how-to-request-gmv-max-authorization-in-business-center) · [Thêm tài khoản GMV Max trong Seller Center](https://ads.tiktok.com/help/article/how-to-request-gmv-max-authorization-for-tiktok-accounts) · [Cấp quyền LIVE GMV Max](https://ads.tiktok.com/help/article/how-to-authorize-an-ad-account-to-run-a-live-gmv-max-campaign-in-business) · [Khắc phục cài đặt tài khoản GMV Max](https://ads.tiktok.com/help/article/troubleshoot-account-settings-for-gmv-max-in-tiktok-ads-manager) · [Đổi quyền của app](https://business-api.tiktok.com/portal/docs?id=1738855280338946)

## Lỗi thường gặp

| Mã                                 | Ý nghĩa                                                     | Cách xử lý                                                                            |
| ---------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `40001`, `40125`                   | Token thiếu quyền (scope)                                   | Bật thêm scope ở Bước 1 (chờ duyệt lại), **uỷ quyền lại** (Bước 2–3) để lấy token mới |
| `40102`, `40104`, `40105`, `40106` | Token hết hạn / rỗng / không hợp lệ / đã bị thu hồi         | Uỷ quyền lại để lấy token mới                                                         |
| `40101`, `40110`, `40113`          | Sai App ID / Secret / `auth_code` (hoặc mã đã dùng/hết hạn) | Kiểm tra lại, lấy `auth_code` mới                                                     |
| `40100`, `40016`                   | Vượt hạn mức gọi của app (QPM)                              | App tự nghỉ 5 phút cho endpoint đó                                                    |
| `40118`                            | Tính năng chưa được TikTok mở (allowlist)                   | Liên hệ TikTok sales rep nếu cần (vd Smart+)                                          |
| `40006`, `40051`                   | Endpoint/phiên bản API không khả dụng                       | Kiểm tra `TIKTOK_API_VERSION` (mặc định `v1.3`)                                       |
| `40011`                            | Danh sách id quá dài                                        | Chia nhỏ danh sách (ít id hơn mỗi lần)                                                |
| `40007`                            | Đối tượng không tồn tại                                     | Kiểm tra lại ID                                                                       |

## Lưu ý quan trọng về TikTok (2026)

- **Từ sau 31/12/2026, TikTok không cho tạo Manual Campaign qua API** (`/campaign/create/`). Sửa/bật/tắt vẫn được. Ads MCP sẽ cảnh báo khi AI tạo chiến dịch mới.
- **Smart+ (bản nâng cấp)**: tạo/sửa cần TKQC được TikTok allowlist qua sales rep, và chỉ tạo được mục tiêu App, Website conversions, Lead generation; đọc số liệu thì không cần allowlist.
- Quảng cáo mới dùng **Spark Ads** (danh tính TikTok thật); Custom Identity không còn tạo mới cho TKQC mở từ 15/01/2026.
- Hạn mức gọi API tính theo **developer app** (gói Basic: 10 lượt/giây, 600/phút). Nhiều đơn vị dùng chung 1 app sẽ chia nhau hạn mức — mỗi công ty nên có app riêng.
- Số liệu hôm nay có thể trễ từ 2 giờ trở lên; reach/frequency trễ tới ~16 giờ; số liệu hôm qua chốt sau 12:00 UTC.
- **Thu hồi quyền**: đăng nhập TikTok For Business → phần cài đặt **Authorization (uỷ quyền)** của tài khoản / Business Center (**Settings → Authorizations**) → chọn app → **Remove**. Sau đó xoá kết nối trong Ads MCP.
- Thử nghiệm với **sandbox** của TikTok: quản trị viên máy chủ đặt biến môi trường `TIKTOK_BASE_URL=https://sandbox-ads.tiktok.com/open_api` (sandbox chỉ 1 lượt/giây, dữ liệu báo cáo giả).

Tài liệu TikTok: <https://business-api.tiktok.com/portal/docs?id=1738373141733378> (Authorization) · <https://business-api.tiktok.com/portal/docs?id=1739965703387137> (Obtain token) · <https://business-api.tiktok.com/portal/docs?id=1753986142651394> (Permission scope)
