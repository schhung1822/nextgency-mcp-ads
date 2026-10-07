# Đặc tả sản phẩm — Ads MCP by: noti.vn

> Nguồn sự thật cho **chức năng**. Khi yêu cầu mới mâu thuẫn với file này → hỏi chủ dự án rồi cập nhật file trước khi code.

## 1. Mục tiêu
Web app source-available (chỉ đơn vị được noti.vn cấp quyền mới được dùng — `LICENSE`), tự host trên VPS (Docker + PostgreSQL), cho phép một đội marketing:
1. **Kết nối** tài khoản quảng cáo **Meta (Facebook/Instagram), OpenAI Ads (ChatGPT Ads)** (Google Ads, TikTok Ads: *sắp ra mắt* — thẻ mờ + popup "chưa sẵn sàng", xem `12-platform-rollout.md`) bằng cách **dán token/credential từ app developer của chính họ** (không có nút "Đăng nhập bằng Facebook/Google"). Mỗi nền tảng thêm được **nhiều** kết nối; mỗi kết nối có thể chứa nhiều tài khoản quảng cáo; dùng đồng thời nhiều nền tảng.
2. **Tạo MCP server** (link `https://<domain>/mcp/<key>`) để dùng với **Claude, ChatGPT, Gemini**. Mỗi MCP giới hạn: nền tảng nào, tài khoản nào, quyền gì.
3. Từ AI, user ra lệnh: **kéo toàn bộ chỉ số theo ngày yêu cầu**, **sửa**, **bật/tắt**, **sao chép**, **tạo mới** chiến dịch/nhóm/quảng cáo, (tuỳ quyền) **xoá/lưu trữ**.
4. **Ghi log chi tiết** mọi hoạt động MCP và mọi thao tác của nhân sự; lưu **3 tháng mặc định** (admin chỉnh được số tháng).

Tên hiển thị: **Ads MCP by: noti.vn** (logo trong `logo/`). Giao diện **tiếng Việt**.

## 2. Vai trò & đăng nhập
- **Không có đăng ký công khai.** Chỉ đăng nhập bằng **email + mật khẩu**.
- Lần chạy đầu: trang `/setup` (chỉ mở khi DB chưa có user nào **và** nhập đúng `SETUP_TOKEN` từ biến môi trường) → tạo **Admin đầu tiên** (không bắt buộc 2FA). Hoặc dùng CLI `create-admin`.
- **Chỉ Admin tạo tài khoản**, chọn role **Admin** hoặc **Nhân viên (staff)**. Admin đặt mật khẩu tạm → user buộc đổi mật khẩu ở lần đăng nhập đầu.
- **Mật khẩu**: tối thiểu **8 ký tự** (quyết định chủ dự án 2026-10-02).
- **2FA (TOTP — Google Authenticator/Authy…)**: **tuỳ chọn, mặc định tắt cho mọi người kể cả Admin** (quyết định chủ dự án 2026-10-02) — mỗi người tự bật/tắt trong trang Tài khoản. Admin có 2 công tắc trong Cài đặt: "Bắt buộc 2FA cho quản trị viên" và "Bắt buộc 2FA cho mọi người" (khuyên bật khi đưa lên máy chủ thật). Có **mã dự phòng** (10 mã, dùng 1 lần).
- Quên mật khẩu: không gửi email ở v1. Admin đặt lại mật khẩu/2FA cho nhân viên; Admin quên → lệnh CLI trong container (`pnpm cli user:reset-password <email>`).
- Admin có thể: khoá/mở khoá tài khoản, đặt lại mật khẩu, đặt lại 2FA, đổi role, xem & thu hồi phiên đăng nhập. Không tự hạ quyền/khoá chính mình; luôn phải còn ≥1 Admin hoạt động (có 2FA nếu chính sách bắt buộc 2FA cho admin).

### Ma trận quyền
| Chức năng | Admin | Nhân viên |
|---|---|---|
| Quản lý người dùng | ✔ | ✘ |
| Cài đặt hệ thống (retention log, bắt buộc 2FA, version API…) | ✔ | ✘ |
| Kết nối quảng cáo: tạo/sửa/xoá/kiểm tra | ✔ tất cả (thấy cả của nhân viên, có cột "Người tạo") | ✔ **chỉ của mình** |
| Dùng kết nối khi tạo MCP | mọi kết nối | **chỉ kết nối của mình** |
| MCP: tạo/sửa/tắt/xoá/xoay key | ✔ tất cả (thấy "Người tạo") | ✔ **chỉ của mình** |
| Xem lại link MCP (reveal) | ✔ (ghi log) | ✔ của mình (ghi log, cần nhập lại mật khẩu/OTP) |
| Nhật ký MCP | ✔ tất cả | ✔ chỉ MCP của mình |
| Nhật ký nhân sự | ✔ tất cả | ✘ (chỉ xem "Hoạt động của tôi" trong trang Tài khoản) |
| Xuất log CSV | ✔ | ✔ phần được xem |

Mọi kiểm tra quyền thực hiện **phía server** (server action / route / MCP), không dựa vào việc ẩn nút.

## 3. Kết nối quảng cáo (Connections)
- Màn hình danh sách: tab **Tất cả | Meta | OpenAI Ads** (theo nền tảng đã phát hành); cột: Tên, Nền tảng, Người tạo (Admin), Số tài khoản QC, Trạng thái token (Hoạt động / Sắp hết hạn / Lỗi / Tắt), Hạn token, Kiểm tra lần cuối.
- **Thêm kết nối** = wizard 3 bước: (1) chọn nền tảng → (2) form credential + **khung hướng dẫn từng bước lấy token** (ảnh/chữ, link tới trang dev) → (3) **Kiểm tra & đồng bộ**: gọi API xác thực, hiện danh sách tài khoản QC tìm thấy (tên, ID, tiền tệ, múi giờ, trạng thái) → user bật/tắt từng tài khoản được phép dùng → Lưu.
- Trường credential theo nền tảng (chi tiết trong `providers/*.md`):
  - **Meta**: access token (System User), app_id/app_secret (tuỳ chọn), business_id (tuỳ chọn).
  - **OpenAI Ads**: API key (1 key = 1 tài khoản QC).
- Credential **mã hoá AES-256-GCM** trước khi lưu; UI chỉ hiện 4 ký tự cuối. Không bao giờ trả credential về trình duyệt sau khi lưu (sửa = nhập lại).
- **Kiểm tra định kỳ** (job hằng ngày): xác thực lại, cập nhật danh sách tài khoản, đánh dấu sắp hết hạn (Meta token 60 ngày) → cảnh báo trên Tổng quan.
- **Tài khoản QC phát hiện SAU khi tạo kết nối** (đồng bộ định kỳ, bấm "Đồng bộ tài khoản", hoặc **thay token**) được thêm ở trạng thái **tắt** (`is_enabled=false`) cho tới khi user bật ở trang chi tiết kết nối ("Tài khoản mới phát hiện sẽ ở trạng thái tắt cho tới khi bạn bật"). Lý do: MCP chọn "tất cả tài khoản trong kết nối" không được âm thầm mở rộng sang tài khoản chưa ai duyệt. Chỉ lần tạo kết nối (wizard bước 3) mới bật mặc định theo lựa chọn của user — và ngay ở đó tài khoản **đã đóng / bị tắt / chờ duyệt** cùng tài khoản **quản lý (MCC)** mặc định **TẮT** (`isDefaultEnabled`; xem preview `defaultEnabled`), user có thể bật tay (`enabledExternalIds`). Trạng thái kết nối (`statusMessage` = chuyện gì xảy ra, `statusHint` = việc cần làm tiếp, vd bấm "Thay token") luôn tách hai trường. Tài khoản đã có giữ nguyên trạng thái bật/tắt.
- **Thay token** là thao tác nhạy cảm: nhập lại mật khẩu + mã 2FA (nếu đã bật), tính chung hạn mức sai 5 lần/15 phút (xem §4).
- Xoá kết nối: cảnh báo các MCP đang dùng nó (MCP vẫn tồn tại nhưng mất quyền truy cập các tài khoản đó).

## 4. Tạo MCP
Wizard 4 bước (đúng thứ tự yêu cầu của chủ dự án):
1. **Đặt tên** (bắt buộc) + mô tả (tuỳ chọn).
2. **Chọn nền tảng** dùng trong MCP (Meta / OpenAI Ads — chỉ hiện nền tảng mà user có kết nối) → với mỗi nền tảng chọn **kết nối** và **tài khoản QC** (mặc định "tất cả tài khoản **đang bật** trong kết nối", hoặc chọn từng tài khoản). Tài khoản mới phát hiện sau này ở trạng thái tắt nên không tự lọt vào phạm vi "tất cả" (§3). Với kết nối Meta có thêm **Trang Facebook** (chỉ đọc bài viết & chỉ số): "Không dùng Trang" / "Tất cả Trang đang bật" / "Chọn từng Trang" (`11-meta-pages.md`).
3. **Chọn quyền theo từng nền tảng** (checkbox, có mô tả dễ hiểu):
   - **Xem** (`read`) — danh sách tài khoản/chiến dịch, toàn bộ chỉ số theo ngày. *Luôn bật nếu chọn nền tảng.*
   - **Bật/Tắt** (`status`) — chạy/tạm dừng chiến dịch, nhóm, quảng cáo.
   - **Sửa** (`update`) — đổi tên, ngân sách, giá thầu, lịch chạy, nhắm mục tiêu, nội dung.
   - **Sao chép** (`copy`) — nhân bản chiến dịch/nhóm/quảng cáo (bản sao luôn ở trạng thái tạm dừng).
   - **Tạo mới** (`create`) — tạo chiến dịch/nhóm/quảng cáo, tải ảnh/video (luôn tạo ở trạng thái tạm dừng).
   - **Xoá / Lưu trữ** (`delete`) — *mặc định tắt*, hiện cảnh báo đỏ "không hoàn tác".
4. **Bảo vệ** (có giá trị mặc định an toàn, người mới có thể bấm Tiếp):
   - Xác nhận 2 bước cho thao tác ghi (mặc định **bật**) — xem `04-mcp-design.md` §6.
   - Giới hạn thay đổi ngân sách mỗi lần (mặc định ±50%; cũng áp dụng **cộng dồn trong 24 giờ**).
   - Theo từng loại tiền của các tài khoản đã chọn ở bước 2:
     - **Trần ngân sách/ngày** — **bắt buộc** cho mỗi loại tiền khi MCP có quyền Bật/Tắt, Sửa, Sao chép hoặc Tạo mới (ô có nhãn "Bắt buộc"; thiếu thì không tạo/lưu được). MCP tạo trước bản cập nhật bảo mật mà chưa có trần vẫn chạy nhưng hiện cảnh báo đỏ ở trang MCP và badge "Chưa đặt trần" ở danh sách; lần lưu cấu hình sau phải nhập trần. MCP chỉ có quyền Xem (hoặc Xoá) không cần trần.
     - **Trần ngân sách trọn đời** — khi đã có trần ngày, ngân sách trọn đời tự bị giới hạn ở trần ngày × số ngày chạy (× 30 nếu chưa có ngày kết thúc); ô này đặt thêm một mức tối đa cố định (lấy mức thấp hơn).
     - **Trần giá thầu/CPA** (tuỳ chọn) — giá thầu, CPC tối đa, chi phí mục tiêu mà AI đặt.
   - **Giới hạn thao tác ghi / 10 phút** (mặc định 20; 1–1000) — số lần AI thực sự thay đổi quảng cáo (bật/tắt, sửa, tạo, sao chép, xoá…) trong 10 phút.
   - Ngày hết hạn MCP (tuỳ chọn), giới hạn số lệnh/phút (mặc định 60), danh sách IP cho phép (tuỳ chọn — lưu ý sẽ chặn Claude Code/Gemini CLI chạy trên máy cá nhân).
   - Chi tiết cách server áp dụng: `04-mcp-design.md` §6; khoá lưu trong `mcp_servers.settings`: `03-database-schema.md`.
→ **Hoàn tất**: bấm "Tạo MCP" mở hộp **xác thực lại** (mật khẩu + mã TOTP nếu đã bật 2FA — vì link dùng được ngay) → hiện link `https://<domain>/mcp/<key>` (nút Sao chép) + tab hướng dẫn kết nối **Claude / ChatGPT / Gemini / Claude Code / Gemini CLI** (copy-paste được).

Sau khi tạo: trang chi tiết MCP gồm Tổng quan (lượt gọi, lỗi, lần dùng cuối, tóm tắt cấu hình bảo vệ), Cấu hình (sửa bước 2–4, thanh "Có thay đổi chưa lưu"), Bảo mật (xoay key → link cũ chết ngay; tắt/bật; xoá — gõ tên để xác nhận), Nhật ký (log của MCP này), Hướng dẫn kết nối.
- **Tạo MCP**, **Xem lại link** và **Xoay key** đều yêu cầu **xác thực lại** mỗi lần: nhập mật khẩu + mã TOTP 6 số (khi tài khoản bật 2FA; khi hệ thống bật "bắt buộc 2FA cho mọi người" mà user chưa bật 2FA thì bị từ chối). Sai quá **5 lần trong 15 phút** (tính chung cho MỌI thao tác nhạy cảm: tạo/xem lại/xoay MCP, thay token, đổi vai trò, tạo admin, đặt lại mật khẩu/2FA của admin, khoá/mở khoá/xoá một admin, nới lỏng cài đặt bảo mật, đổi mật khẩu, mã dự phòng — và khi phiên không còn mới (> 10 phút từ lúc đăng nhập/xác thực lại): xuất log, thu hồi phiên của một admin, đặt lại mật khẩu/2FA của nhân viên — theo người thực hiện) → khoá tạm, báo thử lại sau. Mỗi lần thành công/thất bại đều ghi `activity_logs` (`mcp.create` / `mcp.key.reveal` / `mcp.key.rotate`…, lần sai có `metadata.reauth=true`; không bao giờ ghi key).
- Danh sách MCP: Tên, **Người tạo** (Admin thấy tất cả), Nền tảng (icon), Quyền (badge), Trạng thái, Lần dùng cuối, Lượt gọi 7 ngày.
- Đổi cấu hình MCP có hiệu lực ngay ở request kế tiếp (tool list dựng theo từng request). Lưu ý ChatGPT Business/Enterprise "đóng băng" tool list → hướng dẫn admin workspace refresh.

## 5. Khả năng MCP từ phía AI (ví dụ lệnh tiếng Việt)
- "Kéo chỉ số hôm qua của tất cả tài khoản Meta và OpenAI Ads, xếp theo chi tiêu" → `ads_get_report`.
- "Báo cáo theo ngày từ 1/9 đến 30/9 của chiến dịch X" → `ads_get_report` (granularity day, filter campaign).
- "Tắt các quảng cáo có CPA > 200k trong 7 ngày qua" → `ads_get_report` → `ads_set_status`.
- "Tăng ngân sách nhóm Y lên 1 triệu/ngày" → `ads_update_budget` (preview → xác nhận).
- "Nhân bản chiến dịch Z, thêm hậu tố 'T10'" → `ads_copy_object`.
- "Tạo chiến dịch OpenAI Ads mới…" → `openai_ads_create_*`.
Danh mục tool đầy đủ: `04-mcp-design.md`.

## 6. Nhật ký (Logs)
Một trang `/logs` với **2 tab tách biệt**:
### Tab "Nhật ký MCP"
Mỗi request tới `/mcp/<key>` = 1 dòng: thời gian, MCP (tên + người tạo), client (Claude/ChatGPT/Gemini… từ `clientInfo`/User-Agent), IP, method (`tools/list`, `tools/call`…), tên tool, nền tảng, tài khoản QC, ID đối tượng tác động, loại (đọc/ghi), tham số (đã che bí mật), kết quả tóm tắt, **giá trị trước → sau** với thao tác ghi, trạng thái (thành công / lỗi / bị từ chối quyền / vượt giới hạn / chờ xác nhận), mã lỗi + request id phía nền tảng, thời gian xử lý.
Bộ lọc: khoảng thời gian, MCP, người tạo, nền tảng, tài khoản, tool, trạng thái, chỉ thao tác ghi. Click dòng → ngăn chi tiết JSON. Xuất CSV.
### Tab "Nhật ký nhân sự"
Mọi thao tác của Admin & Nhân viên: đăng nhập (thành công/thất bại), đăng xuất, bật/tắt/đặt lại 2FA, đổi mật khẩu, tạo/sửa/khoá user, tạo/sửa/xoá/kiểm tra kết nối, tạo/sửa/tắt/xoá/xoay key/xem lại link MCP, đổi cài đặt, xuất log. Mỗi dòng: thời gian, người thực hiện (email + role), hành động, đối tượng, IP, thiết bị, chi tiết thay đổi (diff trước/sau, đã che bí mật), kết quả.
### Lưu trữ
- Mặc định **3 tháng**; Admin chỉnh trong Cài đặt (1–24 tháng, riêng cho log MCP và log nhân sự). Job hằng ngày xoá phần cũ (drop partition theo tháng) — dữ liệu được giữ **ít nhất** N tháng.
- Log là append-only: không có UI sửa/xoá từng dòng.

## 7. Trang & điều hướng
Sidebar trái (kiểu Shopify admin): **Tổng quan · Kết nối quảng cáo · MCP · Nhật ký · Mẹo chạy tự động · Người dùng (Admin) · Cài đặt (Admin)**; góc dưới: tài khoản của tôi, giao diện Sáng/Tối, đăng xuất.
- `/login`, `/login/2fa`, `/setup`, `/account` (hồ sơ, đổi mật khẩu, 2FA, phiên đăng nhập, hoạt động của tôi)
- `/` Tổng quan: thẻ số liệu (kết nối, tài khoản QC, MCP hoạt động, lượt gọi 24h, tỉ lệ lỗi), biểu đồ lượt gọi 7/30 ngày theo nền tảng, cảnh báo token, hoạt động gần đây.
- `/connections`, `/connections/new`, `/connections/[id]`
- `/mcp-servers`, `/mcp-servers/new`, `/mcp-servers/[id]` (KHÔNG dùng `/mcp/*` — đó là endpoint MCP)
- `/logs?tab=mcp|staff`
- `/automation-tips` Mẹo chạy tự động (mọi vai trò, chỉ nội dung tĩnh — 2026-10-07): cách cho Claude / ChatGPT / Gemini tự chạy theo lịch qua MCP (tác vụ hẹn giờ của chính ứng dụng AI; app **không** tự gửi lệnh cho AI). Bộ soạn quy tắc "tắt quảng cáo khi CPA vượt ngưỡng" (`src/lib/automation-prompt.ts`) xuất câu lệnh đầy đủ + `SKILL.md`; 2 chế độ Chỉ báo cáo / Tự tắt (MCP riêng: Xem + Bật/Tắt, tắt xác nhận 2 bước, trần thấp, giới hạn ghi nhỏ). Nội dung từng ứng dụng AI kiểm tra ngày 2026-10-07 — tính năng thay đổi nhanh, rà lại định kỳ. Điện thoại: mục nằm trong sheet Menu của thanh dưới.
- `/users` (Admin), `/settings` (Admin)
- **Trang công khai (không cần đăng nhập, 2026-10-05)**: `/privacy` (Chính sách quyền riêng tư), `/terms` (Điều khoản dịch vụ), `/data-deletion` (Hướng dẫn xoá dữ liệu) - URL dán vào Meta App Dashboard / OpenAI. Tiếng Việt trước, bản tiếng Anh cùng trang. **Đơn vị vận hành** (tổ chức tự cài đặt) là bên kiểm soát dữ liệu; noti.vn chỉ là nhà phát triển phần mềm. Admin điền tuỳ chọn ở Cài đặt → **Thông tin pháp lý**: `legal_org_name` (≤ 120 ký tự, trống = tên miền), `legal_contact_email` (email hợp lệ hoặc trống = "quản trị viên hệ thống tại <tên miền>"); không phải thay đổi nới lỏng bảo mật (không hỏi mật khẩu), có ghi `settings.update`. Số tháng lưu nhật ký trên trang lấy từ cài đặt thật. Nội dung: `src/lib/i18n/vi/legal.ts`; mọi người đã đăng nhập sao chép URL tuyệt đối ở khối "Liên kết cho ứng dụng" (sidebar, menu điện thoại, ⌘K).
Yêu cầu UX: dễ hiểu cho người không rành kỹ thuật — mỗi trang có tiêu đề + 1 câu mô tả, trạng thái trống có hướng dẫn + nút hành động chính, form có helper text, xác nhận trước thao tác nguy hiểm, toast phản hồi bằng tiếng Việt.

## 8. Ngoài phạm vi v1 (ghi nhận để làm sau)
OAuth mode cho MCP (cho Gemini app / workspace dùng chung) · gửi email (quên mật khẩu, cảnh báo) · Conversions API · chia sẻ kết nối giữa nhân viên · đa ngôn ngữ UI (cấu trúc i18n sẵn, chỉ có `vi`) · webhook/thông báo Telegram/Zalo.

## 9. Quyết định mặc định (chủ dự án có thể đổi)
| # | Quyết định | Mặc định đã chọn |
|---|---|---|
| D1 | Xem lại link MCP sau khi tạo | Cho phép (key lưu mã hoá + hash), yêu cầu nhập lại mật khẩu/OTP, ghi log |
| D2 | Xác nhận 2 bước cho thao tác ghi | Bật mặc định, tắt được theo từng MCP |
| D3 | Quyền Xoá | Mặc định tắt; Meta = xoá thật, OpenAI = archive (đều không hoàn tác) |
| D4 | Admin dùng kết nối của nhân viên trong MCP của mình | Cho phép |
| D5 | Retention | 2 cài đặt riêng (MCP / nhân sự), mặc định 3 tháng |
