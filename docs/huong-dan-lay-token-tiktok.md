# Hướng dẫn lấy token TikTok Ads (TikTok API for Business)

> Áp dụng cho **Ads MCP by: noti.vn**. Cập nhật theo TikTok Marketing API **v1.3** (rà lại 08/10/2026).

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
5. **Scope of permission** — bật tối thiểu:

| Nhóm quyền                | Dùng để                                                  |
| ------------------------- | -------------------------------------------------------- |
| **Ad Account Management** | Liệt kê TKQC, đọc tiền tệ/múi giờ                        |
| **Ads Management**        | Đọc/sửa/bật tắt/sao chép/tạo chiến dịch, nhóm, quảng cáo |
| **Reporting**             | Kéo số liệu                                              |
| **Creative Management**   | Tải ảnh/video, identity                                  |
| **Pixel Management**      | Chọn pixel khi tạo nhóm quảng cáo chuyển đổi             |
| Audience Management       | (tuỳ chọn) dùng tệp đối tượng                            |

Chỉ cần bật quyền con (vd chỉ “Read” của một nhóm) thì Ads MCP vẫn tính nhóm đó là đã có quyền. 6. Gửi duyệt. TikTok duyệt app trong khoảng **2–3 ngày làm việc**. 7. Khi app được duyệt, mở app → ghi lại **App ID** và **Secret**.

> [!NOTE]
> **Đổi scope sau này**: app bị TikTok duyệt lại (**2–3 ngày làm việc**), sau đó advertiser phải **uỷ quyền lại** (Bước 2–3) thì token mới có quyền mới. Token cũ giữ nguyên quyền cũ.

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
