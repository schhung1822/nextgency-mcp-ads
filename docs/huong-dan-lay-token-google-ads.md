# Hướng dẫn lấy thông tin xác thực Google Ads (gồm YouTube Ads)

> Áp dụng cho **Ads MCP by: Nextgency**. Cập nhật theo Google Ads API **v25** (rà lại 08/10/2026).

## Điều cần biết trước

- **Không cần developer token nữa** (Google bỏ từ 09/09/2026, phiên bản API sau sẽ từ chối). Ads MCP **không gửi** developer token — form không còn ô này. Quyền gọi API giờ gắn với **Google Cloud project** chứa service account / OAuth client của bạn.
- Cloud project phải có access level **Explorer** trở lên mới gọi được TKQC thật (production).
- **Quảng cáo YouTube được quản lý trong Google Ads** — không có kết nối riêng. Kết nối Google Ads là đủ (xem mục [YouTube Ads](#youtube-ads)).
- Có 2 cách xác thực — chọn **một** (khuyến nghị **service account**):

|                           | **Cách A — Service account** (khuyến nghị) | **Cách B — OAuth + refresh token**                                         |
| ------------------------- | ------------------------------------------ | -------------------------------------------------------------------------- |
| Phù hợp                   | Công ty quản lý TKQC qua MCC               | Không tạo được service account key (tổ chức chặn)                          |
| Hết hạn                   | Không (trừ khi xoá key)                    | Chết khi 6 tháng không dùng, bị thu hồi, hoặc **7 ngày nếu app ở Testing** |
| Gắn với người             | Không                                      | Có (tài khoản Google đã cấp quyền)                                         |
| Passkey / xác minh 2 bước | Không cần                                  | Cần (xem Cách B)                                                           |

## Bước 1 — Chuẩn bị Cloud project (cả 2 cách)

1. Vào <https://console.cloud.google.com> → tạo project mới (vd `ads-mcp`). Dùng project có **billing thật** — project đang dùng **billing dùng thử (free trial) bị từ chối** nâng access level.
2. **APIs & Services → Library** → tìm **Google Ads API** → **Enable**.
3. Vào trang **Google Ads API** (APIs & Services → Enabled APIs → Google Ads API) → tab **Overview/Access** → **Upgrade access level** → chọn **Explorer** → gửi. Thường được duyệt tự động trong vài phút.
   - Access level thuộc về **Cloud project của service account / OAuth client** bạn dùng ở bước sau — tạo key/client trong **đúng project này**.
   - Nếu project được nâng cấp sau 09/09/2026 mà vẫn báo `CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION`, hãy tạo một **Cloud project mới** và làm lại Bước 1.

| Access level | Gọi TKQC thật        | Hạn mức                                    |
| ------------ | -------------------- | ------------------------------------------ |
| Test         | ✘ (chỉ test account) | 15.000 / 24 giờ                            |
| **Explorer** | ✔                    | **2.880** thao tác / 24 giờ                |
| Basic        | ✔                    | 15.000 / 24 giờ (cần xác minh thương hiệu) |
| Standard     | ✔                    | Không giới hạn (Google duyệt tay ~10 ngày) |

Hạn mức tính theo **24 giờ trượt** (không reset lúc nửa đêm). 1 lần truy vấn báo cáo = 1 thao tác (trang kế tiếp miễn phí); mỗi thay đổi = 1 thao tác. Explorer đủ cho đa số đội.

## Cách A — Service account (khuyến nghị)

1. Cloud Console → **IAM & Admin → Service Accounts → Create service account** → đặt tên `ads-mcp` → Done (không cần gán role IAM).
2. Mở service account → **Keys → Add key → Create new key → JSON** → tải file về. Đây là bí mật — không gửi qua chat/email.
   - Lỗi _“Service account key creation is disabled”_: tổ chức Google Cloud của bạn bật chính sách `iam.managed.disableServiceAccountKeyCreation` (mặc định với tổ chức tạo sau 05/2024) → nhờ admin Cloud tắt cho project này, dùng project cá nhân, hoặc chuyển sang **Cách B**.
3. Sao chép email service account (dạng `ads-mcp@<project>.iam.gserviceaccount.com`).
4. Vào Google Ads (ưu tiên tài khoản **MCC/Manager**) → **Admin → Access and security → Users → “+”** → dán email service account → quyền **Standard** (hoặc **Read only** nếu chỉ xem báo cáo) → gửi lời mời. Service account được chấp nhận ngay, không cần xác nhận email.
   - Một email chỉ được thêm trực tiếp vào **tối đa 20 TKQC** → **thêm ở MCC** để truy cập mọi TKQC con.
5. Trong Ads MCP: **Thêm kết nối → Google Ads → Kiểu xác thực: Service account** → dán toàn bộ nội dung file JSON → điền **login_customer_id** = ID MCC (10 số, bỏ dấu gạch) nếu bạn thêm service account ở MCC.

> Lần đầu thêm kết nối, Ads MCP hiện popup **Miễn trừ trách nhiệm**: kéo đọc hết nội dung, chờ hết đếm ngược 10 giây, tick ô **Tôi đã đọc kỹ, hiểu và đồng ý…** rồi bấm **Tôi đồng ý và bắt đầu** (bấm **Huỷ** = không kết nối). Đã xác nhận thì những lần sau không hỏi lại, trừ khi nội dung được cập nhật phiên bản mới.

Service account không bị passkey, không bị bẫy 7 ngày, không hết hạn sau 6 tháng — đó là lý do nên chọn cách này.

## Cách B — OAuth client + refresh token

1. Cloud Console → **APIs & Services → OAuth consent screen** (Google Auth Platform):
   - User type: **Internal** (nếu dùng Google Workspace — không bị giới hạn 7 ngày) hoặc **External**.
   - Điền tên app, email hỗ trợ. Scope: thêm `https://www.googleapis.com/auth/adwords`.
   - Nếu chọn External: vào **Audience** → bấm **Publish app** → trạng thái **In production**, rồi vào **Branding → Verify Branding** (xác minh thương hiệu). Cảnh báo “Google hasn’t verified this app” khi đăng nhập là bình thường khi tự dùng (bấm _Advanced → Go to …_).

> [!WARNING]
> **Bẫy 7 ngày**: consent screen _External_ + trạng thái **Testing** → refresh token **tự hết hạn sau 7 ngày**, kết nối báo lỗi `invalid_grant`. Luôn **Publish app → In production** và **xác minh thương hiệu (Verify Branding)** (hoặc dùng Internal) **trước** khi lấy refresh token. Xác minh thương hiệu cũng là điều kiện để xin mức **Basic**.

2. **Credentials → Create credentials → OAuth client ID**:
   - Loại **Desktop app** nếu dùng helper CLI hoặc gcloud; loại **Web application** nếu dùng OAuth Playground (thêm redirect URI `https://developers.google.com/oauthplayground`).
   - Ghi lại **Client ID** và **Client secret**.
3. Lấy **refresh token** — chọn 1 trong 3 cách:
   - **OAuth Playground** (dễ nhất): <https://developers.google.com/oauthplayground> → bánh răng ⚙ → tick **Use your own OAuth credentials** → dán Client ID/secret → ô scope nhập `https://www.googleapis.com/auth/adwords` → **Authorize APIs** → đăng nhập tài khoản Google có quyền trên TKQC → **Exchange authorization code for tokens** → sao chép **Refresh token**.
     _Không_ dùng client mặc định của Playground — token sẽ bị thu hồi sau 24 giờ.
   - **gcloud**: `gcloud auth application-default login --scopes=https://www.googleapis.com/auth/adwords,https://www.googleapis.com/auth/cloud-platform --client-id-file=credentials.json` → refresh token nằm trong file `application_default_credentials.json`.
   - **Helper có sẵn trong Ads MCP** (Desktop client, chuyển hướng về `http://127.0.0.1:8085`):
     ```bash
     # Trên máy tính của bạn: mở đường hầm SSH để trình duyệt local tới được cổng helper trên VPS
     ssh -L 8085:127.0.0.1:8085 user@vps
     # Trong phiên SSH đó, tại thư mục ads-mcp (client secret nhập ẩn khi được hỏi, KHÔNG để trên dòng lệnh):
     docker compose run --rm -p 127.0.0.1:8085:8085 web node dist/cli.mjs google:refresh-token --client-id <CLIENT_ID> --host 0.0.0.0
     ```
     Mở link helper in ra **trên trình duyệt máy bạn**, đăng nhập, đồng ý → helper in refresh token.
     - Cổng chỉ được publish ra `127.0.0.1` của VPS (`-p 127.0.0.1:8085:8085`), truy cập qua đường hầm SSH — không mở cổng ra Internet.
     - `--host 0.0.0.0` chỉ cần khi chạy trong Docker (mặc định helper chỉ nghe `127.0.0.1`).
     - Có thể đưa client secret qua biến môi trường `GOOGLE_ADS_CLIENT_SECRET` (`-e GOOGLE_ADS_CLIENT_SECRET`) hoặc `--client-secret-stdin`. `--client-secret <…>` vẫn chạy nhưng bị cảnh báo (lộ trong `ps`, lịch sử shell).
4. Trong Ads MCP: **Thêm kết nối → Google Ads → Kiểu xác thực: OAuth** → Client ID, Client secret, Refresh token, **login_customer_id** (nếu truy cập TKQC qua MCC).

> [!IMPORTANT]
> **Passkey**: tài khoản Google đăng nhập để tạo refresh token cần bật **xác minh 2 bước**. Google đang bắt buộc (triển khai dần từ 05/08/2026) người dùng Google Ads API đăng nhập bằng **passkey** — **mã TOTP (Authenticator) hay SMS không được chấp nhận**. Passkey vừa tạo có thể cần **tới 7 ngày** mới dùng được, nên tạo passkey trước. Muốn tránh hẳn chuyện này: dùng **Cách A — service account**.

## `login_customer_id` là gì?

Là **ID của tài khoản MCC (Manager) dùng để xác thực** — 10 chữ số, app tự bỏ dấu gạch (`123-456-7890` → `1234567890`).

- Service account / tài khoản Google được thêm ở **MCC** → **bắt buộc** điền, thiếu sẽ lỗi `USER_PERMISSION_DENIED`.
- Được thêm **trực tiếp** vào từng TKQC → để trống.
- Ô _customer_ids_ (tuỳ chọn): giới hạn danh sách TKQC; để trống thì app tự khám phá toàn bộ cây MCC.

## YouTube Ads

YouTube **không có API quảng cáo riêng** — quảng cáo YouTube nằm trong **Google Ads**. Chỉ cần kết nối Google Ads như trên: ở trang Thêm kết nối chọn thẻ “Google Ads (gồm YouTube)” — không có thẻ YouTube riêng.

| Loại chiến dịch                     | AI xem số liệu                                                | AI bật/tắt, đổi ngân sách, sửa         | AI tạo mới  |
| ----------------------------------- | ------------------------------------------------------------- | -------------------------------------- | ----------- |
| **Video** (TrueView, Shorts…)       | ✔ (lượt xem, tỉ lệ xem, quartile, thời gian xem, lượt thích…) | ✘ **chỉ xem** — chỉnh trong Google Ads | ✘           |
| **Demand Gen** (gồm vị trí YouTube) | ✔                                                             | ✔ (ngân sách tối thiểu ~5 USD/ngày), sao chép ✔ | ✔ quảng cáo video / ảnh |
| **Performance Max**                 | ✔ kể cả riêng phần YouTube                                    | ✔                                      | chưa hỗ trợ |

- Google không cho thay đổi chiến dịch **Video** qua API → Ads MCP từ chối kèm thông báo “Chiến dịch Video (YouTube) chỉ xem được qua API - hãy chỉnh trong Google Ads.”
- Muốn dùng video cho quảng cáo: đăng video lên **YouTube** trước (Công khai hoặc Không công khai), rồi nhờ AI thêm bằng link YouTube (Ads MCP tạo asset video từ link, không tải file).
- **Tạo chiến dịch Demand Gen** (MCP cần quyền **Tạo mới** trên Google Ads): đưa AI link video YouTube, link trang đích, **logo vuông** (link ảnh, file Google Drive hoặc tệp đính kèm — tối thiểu 128×128, nên ≤150 KB) và **tên doanh nghiệp** (≤25 ký tự) — Google bắt buộc logo và tên doanh nghiệp. AI tự viết tiêu đề, mô tả nếu bạn không đưa. Chiến dịch luôn tạo ở trạng thái **tạm dừng**, mặc định **chỉ chạy trên YouTube** (In-feed, In-stream, Shorts) — muốn thêm Gmail / Discover / Display thì nói rõ. Ngân sách tối thiểu khoảng 5 USD/ngày quy đổi; thấp hơn thì AI báo mức Google yêu cầu ngay ở bước xem trước.
- **Nhân bản chiến dịch Demand Gen**: “Nhân bản chiến dịch Demand Gen X” — bản sao giữ kênh hiển thị, vị trí, ngôn ngữ, đối tượng và quảng cáo (video, ảnh, băng chuyền, sản phẩm — dùng lại đúng video / ảnh gốc), luôn ở trạng thái tạm dừng.
- Hỏi AI theo kiểu “chi tiêu YouTube tuần này” — AI lọc chiến dịch Video + Demand Gen.

## Lỗi thường gặp

| Lỗi                                                                                                  | Ý nghĩa                                                                                       | Cách xử lý                                                                                                                 |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION`, `DEVELOPER_TOKEN_NOT_APPROVED`, `ACTION_NOT_PERMITTED`  | Cloud project chưa có **Explorer** (hoặc billing dùng thử)                                    | Bước 1.3; project nâng cấp sau 09/09/2026 không được duyệt → tạo project mới                                               |
| `invalid_grant`                                                                                      | Refresh token hết hạn/bị thu hồi — hay gặp nhất là consent screen đang **Testing**            | Publish app → In production + Verify Branding, lấy refresh token mới (hoặc chuyển sang service account)                    |
| `TWO_STEP_VERIFICATION_NOT_ENROLLED`                                                                 | Tài khoản Google chưa bật xác minh 2 bước / passkey                                           | Bật passkey (TOTP/SMS không được chấp nhận) hoặc dùng service account                                                      |
| `USER_PERMISSION_DENIED`                                                                             | Thiếu/sai `login_customer_id`, hoặc service account chưa được thêm vào Google Ads             | Điền ID MCC; kiểm tra Bước A.4                                                                                             |
| `SERVICE_DISABLED`                                                                                   | Chưa bật Google Ads API cho project                                                           | Bước 1.2                                                                                                                   |
| `RESOURCE_EXHAUSTED`                                                                                 | Hết hạn mức thao tác trong 24 giờ                                                             | Đợi vài giờ (24 giờ trượt) hoặc xin Basic/Standard                                                                         |
| `EU_POLITICAL_ADVERTISING_DECLARATION_REQUIRED`, `MISSING_EU_POLITICAL_ADVERTISING_SELF_DECLARATION` | TKQC chưa khai báo quảng cáo chính trị EU                                                     | Khai báo ở **cấp tài khoản** trong Google Ads (cài đặt tài khoản), hoặc nhờ AI chạy tool khai báo hàng loạt cho chiến dịch |
| `OPERATION_NOT_PERMITTED_FOR_CONTEXT`                                                                | Thao tác không được phép (vd nhắm ngôn ngữ cho chiến dịch Tìm kiếm — Google bỏ từ 30/09/2026) | Bỏ nhắm ngôn ngữ; Google tự xác định ngôn ngữ                                                                              |
| `MUTATE_REQUIRES_RESERVATION`, `OPERATION_NOT_PERMITTED_FOR_CAMPAIGN_TYPE`                           | Chiến dịch Video (YouTube) không sửa được qua API                                             | Chỉnh trong Google Ads                                                                                                     |
| `BUDGET_BELOW_PER_DAY_MINIMUM`                                                                       | Ngân sách thấp hơn mức tối thiểu (Demand Gen ~5 USD/ngày)                                     | Tăng ngân sách                                                                                                             |

## Lưu ý

- Số tiền Google trả về theo **micros** (1 VND = 1.000.000 micros) — app tự quy đổi, bạn luôn thấy số tiền thật.
- Không truy vấn số liệu trên tài khoản MCC; app tự lấy từng TKQC con.
- Google chỉ giữ dữ liệu theo ngày **37 tháng** gần nhất.
- Thu hồi quyền: xoá service account khỏi Users trong Google Ads (Cách A) hoặc vào <https://myaccount.google.com/permissions> gỡ app (Cách B).

Tài liệu Google: <https://developers.google.com/google-ads/api/docs/oauth/service-accounts> · <https://developers.google.com/google-ads/api/docs/api-policy/access-levels> · <https://developers.google.com/google-ads/api/docs/api-policy/developer-token> · <https://developers.google.com/google-ads/api/docs/oauth/single-user-authentication>
