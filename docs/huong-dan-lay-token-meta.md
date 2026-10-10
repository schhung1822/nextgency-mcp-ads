# Hướng dẫn lấy token Meta (Facebook / Instagram Ads)

> Áp dụng cho **Ads MCP by: noti.vn**. Cập nhật theo Meta Marketing API **v26.0** (10/2026). Giao diện Meta thay đổi thường xuyên - tên menu có thể hơi khác. Trong app, khung **Hướng dẫn** bên phải form kết nối có cùng nội dung.

Cách khuyến nghị: **token cá nhân của via** (User token tạo từ app developer của bạn). **1 token quản lý được mọi tài khoản quảng cáo (TKQC) và Trang mà via được phân quyền, trên mọi Business Manager (BM)** - không cần đi qua BM. App tự đổi token ngắn hạn sang token dài hạn (~60 ngày) khi bạn điền App ID + App Secret.

Cách khác: **System User token** trong Business Settings (có thể đặt hạn Never) - nhưng chỉ thấy tài sản đã gán cho system user trong **1 BM**. Xem [cuối trang](#cách-khác-system-user-token-trong-bm).

## Bạn cần chuẩn bị

- Via (tài khoản Facebook) đang được phân quyền trên các TKQC và Trang cần dùng.
- Via là **Admin hoặc Developer** của app ở Bước 1 (khi đó không cần App Review - Standard Access).

## Bước 1 - Tạo app trên Meta for Developers

1. Đăng nhập <https://developers.facebook.com/apps> **bằng chính via quản lý các TKQC** → **Create app**.
2. Use case: chọn **Create & manage ads with Marketing API**. Không cần gắn Business portfolio.
3. Đặt tên app (vd `Ads MCP - Công ty ABC`) và email liên hệ.

## Bước 2 - Chuyển app sang **Live mode** (bắt buộc)

App ở chế độ _Development_ vẫn đọc được số liệu, nhưng **tạo quảng cáo với creative mới sẽ lỗi `100/1885183`**.

1. App settings → Basic: điền **Privacy Policy URL** (có thể dùng trang chính sách của website công ty) và chọn **Category**.
2. Trên thanh trên cùng, gạt **App Mode: Development → Live**.

## Bước 3 - Lấy App ID và App Secret

App settings → Basic: sao chép **App ID**, bấm **Show** để lấy **App Secret**. Hai giá trị này nên điền vào form: app dùng chúng để **tự đổi token ngắn hạn (1-2 giờ) sang token dài hạn (~60 ngày)**, đọc hạn token và ký `appsecret_proof`.

## Bước 4 - Tạo token trong Graph API Explorer

1. Mở <https://developers.facebook.com/tools/explorer/>.
2. **Meta App**: chọn đúng app ở Bước 1. **User or Page**: chọn **User Token**.
3. **Add permissions**:

| Scope                   | Bắt buộc    | Dùng để                                                          |
| ----------------------- | ----------- | ---------------------------------------------------------------- |
| `ads_management`        | ✔           | Sửa, bật/tắt, sao chép, tạo quảng cáo                            |
| `ads_read`              | ✔           | Đọc số liệu, danh sách chiến dịch                                |
| `pages_show_list`       | khuyến nghị | Liệt kê Trang để tạo quảng cáo                                   |
| `pages_read_engagement` | khuyến nghị | Đọc Trang/bài viết dùng làm creative (quảng cáo bài viết có sẵn) |
| `pages_manage_ads`      | tuỳ chọn    | Quảng cáo từ bài viết Trang                                      |
| `business_management`   | tuỳ chọn    | Đọc thêm thông tin BM của TKQC; thấy cả Trang trong BM           |
| `read_insights`         | tuỳ chọn    | Tool Trang Facebook: đọc chỉ số Trang và chỉ số bài viết         |
| `pages_read_user_content` | tuỳ chọn  | Tool Trang Facebook: đọc bài khách đăng lên Trang, số bình luận  |

4. **Generate Access Token** → trong hộp thoại của Facebook, **chọn tất cả TKQC/Trang cần dùng** rồi đồng ý. Token bắt đầu bằng `EAA…`.

**Không cần** `read_insights` để kéo số liệu quảng cáo. Chỉ cần khi muốn AI đọc **bài viết và chỉ số Trang Facebook**. Khi đó via phải có quyền **xem thông tin chi tiết** trên Trang.

Không thấy `read_insights` / `pages_read_user_content` trong danh sách quyền? Vào App Dashboard → **Use cases** → **Add use case** → **Manage everything on your Page** → **Customize** → thêm các quyền đó, rồi quay lại Graph API Explorer.

## Bước 5 - Dán vào Ads MCP

**Kết nối → Thêm kết nối → Meta**:

| Ô                   | Giá trị                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------- |
| Access token        | Token ở Bước 4 (bắt buộc)                                                                   |
| App ID / App Secret | Ở Bước 3 (khuyến nghị - để tự đổi sang token ~60 ngày)                                      |
| Business ID         | Bỏ trống (chỉ dùng khi muốn liệt kê thêm TKQC owned/client của 1 BM bằng System User token) |

Bấm **Kiểm tra** → app hiện danh sách TKQC của via trên mọi BM (tên, ID, tiền tệ, múi giờ, trạng thái) → bật các TKQC được phép dùng → **Lưu**.

## Bước 6 - Gia hạn

Token cá nhân sống khoảng **60 ngày**. Trước 7 ngày app cảnh báo trên **Tổng quan**; khi đó làm lại Bước 4 rồi vào trang kết nối → **Thay token**.

## Lỗi thường gặp

| Lỗi                                              | Ý nghĩa                                                                              | Cách xử lý                                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `190` (subcode 463/467/460/458)                  | Token hết hạn / không hợp lệ / via đổi mật khẩu / app bị gỡ                          | Tạo token mới (Bước 4) và bấm **Thay token**                                             |
| `100/1885183`                                    | App chưa **Live**                                                                    | Làm lại Bước 2                                                                           |
| `(#100) Requires business_management permission` | Một số trường thông tin BM cần quyền này                                             | App tự thử lại không đọc các trường đó; nếu vẫn lỗi, thêm `business_management` ở Bước 4 |
| `10`, `200`, `294`                               | Thiếu quyền hoặc via chưa được phân quyền TKQC/Trang                                 | Kiểm tra quyền của via, tạo token mới đủ scope                                           |
| `100/4834011`                                    | Tạo chiến dịch không có ngân sách chiến dịch mà thiếu cài đặt chia sẻ ngân sách nhóm | AI cần truyền `is_adset_budget_sharing_enabled` - báo lại cho người quản trị nếu lặp lại |
| `4`, `17`, `32`, `613`, `80004`…                 | Vượt hạn mức gọi API (rate limit)                                                    | App tự giảm tốc; đợi vài phút                                                            |
| `2635`                                           | Phiên bản API đã ngừng                                                               | Cập nhật Ads MCP lên bản mới                                                             |
| `368`                                            | Bị chặn tạm thời                                                                     | Đợi, giảm tần suất thao tác                                                              |

## Lưu ý

- Token có **toàn quyền chi tiền** trên mọi TKQC của via - không chia sẻ cho người khác.
- Via đổi mật khẩu, bị checkpoint hoặc gỡ app thì token mất hiệu lực - cần tạo token mới.
- Ngân sách Meta tính theo **đơn vị nhỏ nhất** của tiền tệ; riêng **VND không có số lẻ** - app tự quy đổi, bạn và AI luôn làm việc bằng số tiền thật (vd `500000 VND`).
- Attribution window `7d_view`, `28d_view` đã bị Meta bỏ (trả rỗng) - app không cho chọn.
- Có thể tạo nhiều kết nối (nhiều via) và chọn TKQC riêng cho từng MCP để tách quyền theo đội.

## Cách khác: System User token trong BM

Dùng khi muốn token không phụ thuộc via cá nhân (nhân viên nghỉ việc không ảnh hưởng) và chỉ cần tài sản của **1 BM**:

1. <https://business.facebook.com/settings> → **Users → System users** → **Add** (vai trò Employee).
2. **Assign assets**: TKQC (Manage campaigns), Trang (Create ads), App ở Bước 1 (Manage app).
3. **Generate new token** → chọn app → hạn **Never** → tick các scope ở Bước 4 (thêm `business_management`).
4. Dán token, App ID/Secret, và **Business ID** vào form.

Tài liệu Meta: <https://developers.facebook.com/docs/marketing-api/overview/authorization> · <https://developers.facebook.com/docs/business-management-apis/system-users/install-apps-and-generate-tokens>
