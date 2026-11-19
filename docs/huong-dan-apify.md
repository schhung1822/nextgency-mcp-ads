# Hướng dẫn: lấy dữ liệu qua Apify

> Áp dụng cho **Ads MCP by: Nextgency** (10/2026). Giao diện Apify Console thay đổi theo thời gian — nếu tên menu khác, tìm mục tương ứng (_Settings_, _API & Integrations_, _Billing_, _Limits_). Giá Apify ghi trong tài liệu này đọc ngày 14/10/2026, có thể đổi: xem <https://apify.com/pricing>.

Ads MCP có thể nhờ **Apify** lấy dữ liệu công khai trên sàn thương mại điện tử, mạng xã hội, Google và website — ví dụ giá và đánh giá sản phẩm Shopee, quảng cáo Facebook đang chạy của đối thủ, video TikTok nổi bật — để trợ lý AI (Claude, ChatGPT, Gemini) **phân tích ngay trong cuộc trò chuyện**. Bạn chỉ cần dán **API token** của Apify; hệ thống tự chọn công cụ thu thập phù hợp.

## Mục lục

- [Apify là gì, Ads MCP dùng để làm gì](#apify-là-gì-ads-mcp-dùng-để-làm-gì)
- [Chi phí](#chi-phí)
- [Bước 1 — Tạo tài khoản Apify và lấy API token](#bước-1--tạo-tài-khoản-apify-và-lấy-api-token)
- [Bước 2 — Đặt giới hạn chi tiêu trong Apify (nên làm)](#bước-2--đặt-giới-hạn-chi-tiêu-trong-apify-nên-làm)
- [Bước 3 — Thêm token trong Ads MCP](#bước-3--thêm-token-trong-ads-mcp)
- [Xoay vòng token hoạt động thế nào](#xoay-vòng-token-hoạt-động-thế-nào)
- [Bước 4 — Bật Apify cho MCP](#bước-4--bật-apify-cho-mcp)
- [Bước 5 — Nhờ AI lấy dữ liệu và phân tích](#bước-5--nhờ-ai-lấy-dữ-liệu-và-phân-tích)
- [Quản lý token Apify](#quản-lý-token-apify)
- [Giới hạn](#giới-hạn)
- [Xử lý lỗi thường gặp](#xử-lý-lỗi-thường-gặp)
- [Bảo mật và pháp lý](#bảo-mật-và-pháp-lý)
- [Ghi chú vận hành cho quản trị viên](#ghi-chú-vận-hành-cho-quản-trị-viên)

---

## Apify là gì, Ads MCP dùng để làm gì

**Apify** (<https://apify.com>, công ty Apify Technologies s.r.o., Cộng hoà Séc) là nền tảng chạy **Actor** — chương trình thu thập dữ liệu web chạy trên máy chủ của Apify. Phần lớn Actor do cộng đồng viết và bán trên **Apify Store**; mỗi lần chạy tính tiền vào tài khoản Apify của người chạy.

Trong Ads MCP:

1. Bạn (hoặc quản trị viên) dán **API token** Apify vào **Kết nối → tab Apify**.
2. Bạn bật Apify cho một MCP.
3. Trong cuộc trò chuyện, AI gọi các công cụ `apify_*`: hệ thống chọn **Actor phù hợp trong danh mục đã chọn lọc** (khoảng 35 việc, mỗi việc có Actor chính + Actor dự phòng), chạy bằng token của bạn với giới hạn an toàn, rồi trả kết quả gọn cho AI phân tích.

| Nhóm            | Việc AI làm được                                                                                                                   |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Shopee**      | Tìm sản phẩm theo từ khoá, chi tiết sản phẩm từ link, sản phẩm của một shop, đánh giá                                              |
| **Lazada**      | Tìm sản phẩm, chi tiết sản phẩm, đánh giá                                                                                          |
| **TikTok Shop** | Tìm sản phẩm, chi tiết sản phẩm, đánh giá                                                                                          |
| **TikTok**      | Video theo từ khoá / hashtag / kênh, bình luận video, quảng cáo hiệu quả cao tại Việt Nam (TikTok Creative Center)                 |
| **Facebook**    | Thư viện quảng cáo (quảng cáo đang chạy theo từ khoá hoặc Trang), bài viết và thông tin Trang công khai, nhóm công khai, bình luận |
| **Instagram**   | Thông tin tài khoản, bài / reel, bài theo hashtag                                                                                  |
| **Threads**     | Bài viết của một tài khoản, tìm bài theo từ khoá / hashtag, trả lời (bình luận) của bài viết, thông tin tài khoản                  |
| **YouTube**     | Tìm video, video của một kênh, bình luận                                                                                           |
| **Google**      | Địa điểm và đánh giá Google Maps, kết quả Google Search, quảng cáo trên Google Ads Transparency Center                             |
| **Website**     | Đọc nội dung một trang (landing page), đọc nhiều trang của một website                                                             |

AI **không** lấy được dữ liệu cần đăng nhập (nhóm kín, tài khoản riêng tư, tin nhắn…): hệ thống không bao giờ gửi cookie, mật khẩu hay thông tin đăng nhập cho Actor. Trang Facebook, tài khoản quảng cáo **của chính bạn** thì dùng công cụ `meta_*` / `ads_*` chính thức (chính xác hơn, không tốn tiền Apify).

---

## Chi phí

- Apify tính tiền **theo lần chạy**: phần lớn Actor tính theo số kết quả / sự kiện (_pay-per-event_), một số tính theo tài nguyên đã dùng (_pay-per-usage_). Giá theo gói của tài khoản — gói càng cao càng rẻ.
- Với giới hạn mặc định của danh mục, **mỗi lần chạy thường tốn từ dưới 0,01 USD tới khoảng 0,4 USD** (ước tính theo giá gói Free — mức cao nhất). `apify_list_tasks` cho AI biết chi phí ước tính của từng việc.
- Gói Apify (đọc 14/10/2026):

| Gói          | Giá / tháng | Credit dùng mỗi tháng | Ghi chú                                                                                   |
| ------------ | ----------- | --------------------- | ----------------------------------------------------------------------------------------- |
| **Free**     | 0 USD       | 5 USD                 | Hết 5 USD là dừng tới chu kỳ sau. Một số Actor (vd Shopee) trả **dữ liệu mẫu** ở gói Free |
| **Starter**  | 19 USD      | 19 USD                | Nên dùng nếu chạy thường xuyên                                                            |
| **Scale**    | 199 USD     | 199 USD               |                                                                                           |
| **Business** | 999 USD     | 999 USD               |                                                                                           |

- Credit đặt lại theo **chu kỳ của tài khoản** (không phải ngày 1 dương lịch) và **không cộng dồn** sang chu kỳ sau. Ads MCP hiện ngày đặt lại ở cột **Credit**.
- **Ai trả tiền?** Tài khoản Apify của token được chọn cho lần chạy đó. Token **dùng chung công ty** → tài khoản Apify của công ty trả, kể cả khi nhân viên là người hỏi AI.
- Ads MCP luôn đặt **trần chi phí mỗi lần chạy** (mặc định 1 USD — Apify tự dừng lần chạy khi chạm trần) và, ở chế độ **Tùy chỉnh nâng cao**, **trần mỗi ngày** cho từng MCP (Bước 4).

---

## Bước 1 — Tạo tài khoản Apify và lấy API token

1. Đăng ký tài khoản tại <https://apify.com> (**Sign up**). Mỗi người / mỗi đơn vị **một** tài khoản — xem cảnh báo điều khoản ở [Xoay vòng token](#xoay-vòng-token-hoạt-động-thế-nào).
2. Vào **Apify Console → Settings → API & Integrations** (<https://console.apify.com/settings/integrations>).
3. Có hai cách:
   - Sao chép **Personal API token** có sẵn, hoặc
   - **Khuyên dùng:** bấm **+ Create new token**, đặt tên `Ads MCP` (có thể đặt ngày hết hạn) → sao chép. Token riêng cho Ads MCP giúp bạn thu hồi riêng mà không ảnh hưởng chỗ khác đang dùng Apify.
4. Token có dạng `apify_api_…`. Dán vào Ads MCP ở Bước 3.

> ⚠ **Token Apify là thông tin chi tiền.** Ai có token có thể chạy Actor bằng tiền của bạn, đọc dữ liệu trong tài khoản Apify, thậm chí **nâng giới hạn chi tiêu**. Không gửi token qua chat, email, ảnh chụp màn hình. Lộ token: vào **Settings → API & Integrations** xoá hoặc đổi (_rotate_) token, rồi bấm **Thay token** trong Ads MCP.

### Token giới hạn quyền (scoped token) — nâng cao

Apify cho tạo token **giới hạn quyền** (bật _Limit token permissions_ khi tạo token). Hiện **chưa xác minh** được token giới hạn quyền có chạy được Actor công khai trên Apify Store và đọc được credit của tài khoản hay không, nên **mặc định hãy dùng token thường**. Nếu muốn thử token giới hạn quyền:

- Cấp quyền **chạy Actor** và **đọc dữ liệu** (dataset) mà Ads MCP cần, và bật quyền truy cập **bộ nhớ mặc định của lần chạy** (_default run storages_) — thiếu quyền này AI không đọc được kết quả.
- Bấm **Kiểm tra** ở Bước 3; nếu báo lỗi quyền, không hiện được credit, hoặc AI báo lỗi khi chạy → quay lại dùng token thường.

---

## Bước 2 — Đặt giới hạn chi tiêu trong Apify (nên làm)

Đây là **lớp bảo vệ cuối cùng**, nằm ngay trong tài khoản Apify:

1. **Apify Console → Billing → Limits**.
2. Đặt **giới hạn chi tiêu tháng** (_monthly usage limit_ — hard limit) ở mức bạn chấp nhận được. Chạm mức này, Apify chặn mọi lần chạy mới của tài khoản tới chu kỳ sau.

Ads MCP **không bao giờ** tự đổi giới hạn này. Gói Free tự giới hạn ở 5 USD credit.

---

## Bước 3 — Thêm token trong Ads MCP

1. **Kết nối** → tab **Apify** → **Thêm token Apify**.
   (Hoặc **Kết nối** → **Thêm kết nối** → nhóm **Nguồn dữ liệu** → thẻ **Apify**.)
   Trước khi hiện form, Ads MCP hiện popup **Miễn trừ trách nhiệm**: kéo đọc hết, chờ hết đếm ngược 10 giây, tick ô đồng ý → **Tôi đồng ý và bắt đầu**. Phiên bản ngày **14/10/2026** có thêm mục về Apify: nếu trước đó bạn đã đồng ý bản cũ, bạn sẽ được hỏi lại **một lần**.
2. Điền form:

| Ô           | Điền                                                                                                            | Ví dụ                        |
| ----------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| **Tên**     | Tên gợi nhớ (tối đa 80 ký tự)                                                                                   | `Apify công ty`, `Apify Lan` |
| **Token**   | Token ở Bước 1                                                                                                  | `apify_api_…`                |
| **Phạm vi** | **Dùng chung công ty** (chỉ quản trị viên chọn được) hoặc **Cá nhân**. Nhân viên luôn là Cá nhân. Xem bảng dưới |                              |

3. Bấm **Kiểm tra**: hệ thống hỏi Apify (không tốn credit) và hiện **tên người dùng Apify**, **gói**, **credit đã dùng / giới hạn**, **ngày đặt lại**. Nếu token thuộc **cùng tài khoản Apify** với một token đã lưu, hệ thống báo hai token **dùng chung credit**.
4. Bấm **Kiểm tra & lưu** (hệ thống kiểm tra lại token với Apify rồi mới lưu). Muốn thêm token khác (tài khoản Apify khác), bấm **Thêm token khác**.

Token được mã hoá trước khi lưu và **không bao giờ hiển thị lại** (chỉ 4 ký tự cuối). Hệ thống **không lưu** email hay mật khẩu proxy của tài khoản Apify.

### Token công ty và token cá nhân

|                     | Token **công ty** (dùng chung)                             | Token **cá nhân**                           |
| ------------------- | ---------------------------------------------------------- | ------------------------------------------- |
| Ai thêm / sửa / xoá | Quản trị viên                                              | Chủ token (quản trị viên cũng quản lý được) |
| Nhân viên thấy gì   | Tên, trạng thái, credit — không thấy token, không sửa được | Chỉ token của chính mình                    |
| MCP nào dùng được   | **Mọi MCP** bật Apify                                      | Chỉ **MCP của chính chủ token**             |
| Ai trả tiền         | Tài khoản Apify của công ty                                | Tài khoản Apify của chủ token               |

**Kho token của một MCP = token công ty + token cá nhân của chủ MCP.** Quản trị viên sửa MCP của nhân viên thì MCP đó vẫn dùng token cá nhân của nhân viên, không dùng token cá nhân của quản trị viên.

---

## Xoay vòng token hoạt động thế nào

Mỗi lần AI chạy một việc:

1. Hệ thống lấy kho token của MCP và **gộp các token cùng một tài khoản Apify** thành một nhóm (chúng dùng chung credit).
2. Bỏ qua tài khoản đang **Hết credit**, token **không hợp lệ** hoặc **đã tắt**. Tài khoản còn lại phải còn credit ít nhất bằng mức nhỏ hơn giữa trần lần chạy và 0,05 USD.
3. Chọn **ngẫu nhiên, ưu tiên tài khoản còn nhiều credit** (credit còn càng nhiều, càng hay được chọn). Số credit được cập nhật tối đa 5 phút một lần.
4. Nếu Apify báo **hết credit** khi bắt đầu chạy → cả tài khoản đó chuyển **Hết credit** tới ngày đặt lại, hệ thống **tự thử token khác** (tối đa 3 lần). Token bị Apify từ chối → **Token không hợp lệ**. Tài khoản đang bận (hết RAM hoặc quá số lần chạy cùng lúc) → chỉ bỏ qua lần này.
5. Không còn token nào dùng được → AI báo lỗi `apify_no_token`.
6. Một lần chạy đã bắt đầu thì luôn dùng **đúng token đó** cho tới khi xong (xem tiến độ, đọc kết quả, dừng).

Hệ thống tự kiểm tra lại mọi token **6 giờ một lần** (credit, trạng thái) và tự mở lại tài khoản **Hết credit** khi qua ngày đặt lại hoặc khi bạn đã nâng giới hạn.

> ⚠ **Điều khoản Apify cấm một người lập nhiều tài khoản.** Điều khoản chung của Apify (mục 4.3) không cho một người tạo hoặc dùng **nhiều tài khoản Personal**, kể cả đăng ký bằng email khác. Xoay vòng chỉ hợp lệ giữa token của **các tài khoản Apify thật, khác chủ** (ví dụ mỗi nhân sự hoặc mỗi đơn vị một tài khoản). **Đừng** lập nhiều tài khoản Free để gom credit miễn phí — Apify có thể khoá tài khoản. Thêm nhiều token của **cùng một** tài khoản không làm tăng credit (chỉ để tách quyền hoặc thay token).

---

## Bước 4 — Bật Apify cho MCP

**MCP → Tạo MCP** (hoặc trang MCP → tab **Cấu hình**):

1. Bước **Nền tảng & tài khoản** → thẻ **Apify** (nằm ngay sau các thẻ Meta / TikTok Ads / Google Ads / OpenAI Ads): bật công tắc. Apify là **một nền tảng** như các nền tảng quảng cáo — MCP cần **ít nhất 1 nền tảng** (Meta, TikTok, Google Ads, OpenAI Ads **hoặc Apify**), nên:
   - một MCP có thể **vừa** xem / sửa / bật tắt / tạo quảng cáo **vừa** lấy dữ liệu Apify để phân tích;
   - hoặc **chỉ dùng Apify** (không chọn nền tảng quảng cáo nào) — AI khi đó chỉ thấy công cụ `apify_*` (và Telegram nếu MCP có kênh). Chưa có kết nối quảng cáo nào vẫn tạo được MCP chỉ dùng Apify, miễn là kho có token dùng được.

   Thẻ hiện kho token của **chủ MCP**: số token, số tài khoản Apify, số token dùng được ngay, bao nhiêu token công ty / cá nhân. Chưa có token dùng được → công tắc bị khoá, kèm nút **Thêm token Apify**. MCP chỉ dùng Apify mà kho trống thì không lưu được (báo lỗi ở thẻ Apify).
2. Bước **Quyền** → thẻ **Apify** (hiện khi đã bật Apify ở bước 1, cùng danh sách với thẻ quyền của các nền tảng quảng cáo):
   - **Trần mỗi lần chạy (USD)** — 0,05–20, mặc định **1**. **Luôn áp dụng**, kể cả ở chế độ bảo vệ **Cơ bản**. AI có thể xin trần thấp hơn cho một lần chạy, không bao giờ cao hơn.
   - **Cho phép Actor ngoài danh mục** _(Chỉ quản trị viên)_ — cho AI tìm và chạy Actor bất kỳ trên Apify Store (hệ thống vẫn loại Actor rủi ro và chặn trường nhập nguy hiểm). Mặc định tắt. Nhân viên không bật được (tắt được nếu quản trị viên đã bật). Chỉ bật khi thật cần: Actor ngoài danh mục chưa được kiểm tra trước.
3. Bước **Bảo vệ** → bật **Tùy chỉnh nâng cao** → **Trần Apify mỗi ngày (USD)** — mặc định **10**, `0` = không giới hạn. Tính tổng chi phí Apify của MCP trong một ngày (giờ Việt Nam), lần chạy chưa xong tính theo trần đã đặt. Chế độ **Cơ bản**: không có trần ngày.

Lưu ý:

- Mỗi lần chạy Actor được tính vào **Giới hạn thao tác ghi / 10 phút** (chế độ Tùy chỉnh nâng cao). Chạy Actor **không** qua xác nhận 2 bước và **không** qua giãn cách lệnh ghi quảng cáo.
- Nhân viên dùng MCP có quyền thay đổi GMV Max do quản trị viên bật thì không tự nới được trần Apify.
- ChatGPT Business / Enterprise: sau khi đổi cấu hình MCP, vào chatgpt.com/plugins → mở plugin → **Refresh**.

Công cụ AI nhận được:

| Công cụ               | Có khi                                 | Dùng để                                                             |
| --------------------- | -------------------------------------- | ------------------------------------------------------------------- |
| `apify_list_tasks`    | MCP bật Apify và có token              | Xem danh mục việc, giới hạn, chi phí ước tính, tình trạng kho token |
| `apify_run_task`      | như trên                               | Chạy một việc trong danh mục (tốn tiền Apify)                       |
| `apify_get_run`       | như trên                               | Xem tiến độ lần chạy (trạng thái, số kết quả, chi phí thực)         |
| `apify_get_results`   | như trên                               | Đọc kết quả (đã làm sạch, chia trang)                               |
| `apify_abort_run`     | như trên                               | Dừng lần chạy                                                       |
| `apify_search_actors` | Thêm **Cho phép Actor ngoài danh mục** | Tìm Actor trên Apify Store                                          |
| `apify_get_actor`     | như trên                               | Xem chi tiết Actor                                                  |
| `apify_run_actor`     | như trên                               | Chạy Actor ngoài danh mục (tốn tiền Apify)                          |

---

## Bước 5 — Nhờ AI lấy dữ liệu và phân tích

Nói rõ **cái gì, ở đâu, bao nhiêu** (từ khoá, link, số lượng). AI tự chọn việc phù hợp.

### Phân tích sản phẩm Shopee

> "Tìm 40 sản phẩm Shopee cho từ khoá **serum vitamin C**, lập bảng giá, giảm giá, điểm đánh giá, số đánh giá; gợi ý mức giá cạnh tranh cho sản phẩm của tôi đang bán 289.000đ."

> "Đọc 100 đánh giá 1–3 sao của sản phẩm này <link Shopee>, tóm tắt 5 lý do khách chê nhiều nhất và đề xuất 3 góc quảng cáo xử lý các lý do đó."

### Quảng cáo Facebook của đối thủ

> "Trang **<tên hoặc link Trang đối thủ>** đang chạy những quảng cáo nào trong Thư viện quảng cáo Facebook? Gom theo thông điệp chính, định dạng, ngày bắt đầu; quảng cáo nào chạy lâu nhất?"

### Xu hướng TikTok

> "Lấy 30 video TikTok nổi bật với hashtag **#skincare** tuần này, phân tích câu mở đầu 3 giây đầu và kiểu nội dung có nhiều lượt xem nhất."

> "Các quảng cáo TikTok hiệu quả cao ở Việt Nam ngành làm đẹp (TikTok Creative Center) có điểm gì chung?"

### Lắng nghe trên Threads

> "Tìm 30 bài Threads mới nhất có từ khoá **kem chống nắng** trong 7 ngày qua, gom theo chủ đề khen / chê và cho biết thương hiệu nào được nhắc nhiều nhất."

> "Lấy 30 bài gần đây của tài khoản Threads **@<đối thủ>**, bài nào nhiều lượt thích / trả lời nhất và vì sao? Đọc tiếp các trả lời của bài cao nhất để xem khách hỏi gì."

### Đánh giá Google Maps

> "Lấy 100 đánh giá Google Maps mới nhất của **<tên cửa hàng, địa chỉ>**, tóm tắt điểm khen / chê, so sánh với **<đối thủ>**."

### Kết hợp với số liệu quảng cáo

> "Lấy chi phí, CPA các chiến dịch Meta tuần qua của TKQC X, rồi xem đối thủ Y đang chạy quảng cáo gì; đề xuất 3 mẫu quảng cáo mới cho tôi."

Mẹo:

- Việc lâu (đọc nhiều trang website, Google Maps, nhiều đánh giá) có thể chưa xong trong một lượt: AI báo **đang chạy** — nói "**kiểm tra lần chạy Apify vừa rồi**" để AI xem tiếp và đọc kết quả.
- Kết quả rỗng hoặc lạ (hay gặp với Shopee): nói "**thử lại bằng Actor dự phòng**". Hệ thống không tự chạy lại khi lần chạy đã tốn tiền.
- Mỗi lần chạy tốn tiền: nói rõ số lượng vừa đủ, không cần "lấy hết".

---

## Quản lý token Apify

**Kết nối** → tab **Apify**: bảng token với **Tên**, **Phạm vi** (Công ty / Cá nhân), **Tài khoản Apify** (tên người dùng · gói), **Credit** (đã dùng / giới hạn, ngày đặt lại), **Trạng thái**, **Kiểm tra lần cuối**. Nhân viên thấy token công ty ở dạng chỉ xem.

| Trạng thái             | Nghĩa                                                                         | Cần làm                                                                             |
| ---------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **Hoạt động**          | Dùng được                                                                     | —                                                                                   |
| **Hết credit**         | Tài khoản Apify đã dùng hết credit / chạm giới hạn chi tiêu, tới ngày đặt lại | Đợi ngày đặt lại, hoặc nâng gói / giới hạn trong Apify Console rồi **Kiểm tra lại** |
| **Token không hợp lệ** | Apify từ chối token (đã xoá, đổi, hết hạn) hoặc tài khoản bị khoá             | Tạo token mới → **Thay token**                                                      |
| **Lỗi**                | Lỗi khác khi kiểm tra                                                         | Xem dòng lỗi → **Kiểm tra lại**                                                     |
| **Đã tắt**             | Bạn đã tắt token                                                              | **Bật** lại khi cần                                                                 |

Bấm vào một token để mở trang chi tiết:

| Nút / khung                 | Dùng để                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| **Kiểm tra lại**            | Hỏi lại Apify về token, credit, ngày đặt lại                                                |
| **Đổi tên**                 | Đổi tên gợi nhớ                                                                             |
| **Thay token**              | Dán token mới (nhập lại mật khẩu, mã 2FA nếu đã bật)                                        |
| **Tắt** / **Bật**           | Tắt = không MCP nào dùng token này cho tới khi bật lại                                      |
| **Xoá**                     | Xoá token đã lưu (gõ tên để xác nhận, không hoàn tác); hệ thống báo số MCP bị ảnh hưởng     |
| **MCP dùng được token này** | Danh sách MCP có thể xoay vòng qua token (nhân viên thấy MCP của người khác ở dạng ẩn danh) |
| **Lần chạy gần đây**        | 20 lần chạy gần nhất: MCP, việc / Actor, trạng thái, chi phí, thời điểm                     |

---

## Giới hạn

| Giới hạn                       | Mức                                                                                                                                                                           |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Shopee Việt Nam**            | **Best-effort**: Shopee chặn thu thập dữ liệu mạnh, có lúc kết quả thiếu hoặc rỗng; gói Free một số Actor trả dữ liệu mẫu. Thử Actor dự phòng, hoặc dùng Lazada / TikTok Shop |
| Thư viện quảng cáo Facebook    | Chi tiêu, phạm vi tiếp cận chỉ có với quảng cáo nhắm châu Âu hoặc quảng cáo chính trị (giới hạn của Meta)                                                                     |
| Dữ liệu cần đăng nhập          | Không lấy được (nhóm kín, tài khoản riêng tư, tin nhắn)                                                                                                                       |
| Threads                        | Chỉ phần Threads hiện cho khách chưa đăng nhập (tìm kiếm thường ít hơn số bài yêu cầu). Actor chính lấy tối thiểu 10 bài mỗi lần và cần trần mỗi lần chạy ≥ 0,1 USD           |
| Số kết quả mỗi lần chạy        | Theo từng việc (giới hạn mặc định và tối đa — AI xem bằng `apify_list_tasks`)                                                                                                 |
| Kết quả AI đọc mỗi lượt        | ≤ 50 mục, khoảng 24.000 ký tự (chuỗi dài bị cắt); phần còn lại đọc tiếp bằng trang sau                                                                                        |
| Thời gian chờ                  | AI chờ ≤ 25 giây khi bắt đầu chạy, ≤ 30 giây mỗi lần kiểm tra; lần chạy lâu hơn vẫn tiếp tục trên Apify                                                                       |
| Một lần chạy                   | Tối đa 10 phút, RAM tối đa 4 GB                                                                                                                                               |
| Trần mỗi lần chạy              | 0,05–20 USD (mặc định 1)                                                                                                                                                      |
| Trần mỗi ngày (mỗi MCP)        | 0–1.000 USD, mặc định 10, `0` = không giới hạn — chỉ ở chế độ Tùy chỉnh nâng cao                                                                                              |
| Lần chạy AI xem được           | Chỉ lần chạy do **chính MCP đó** bắt đầu                                                                                                                                      |
| Lịch sử lần chạy trong Ads MCP | Giữ 90 ngày. Dữ liệu gốc nằm trong tài khoản Apify theo thời hạn lưu của gói Apify                                                                                            |
| Kiểm tra token trên web        | 10 lần / phút / người                                                                                                                                                         |

---

## Xử lý lỗi thường gặp

### Khi thêm / kiểm tra token

| Hiện tượng                                           | Cách xử lý                                                                  |
| ---------------------------------------------------- | --------------------------------------------------------------------------- |
| Báo token không đúng định dạng (`apify_api_…`)       | Sao chép lại token ở **Settings → API & Integrations**, không thừa dấu cách |
| Báo token sai / không tìm thấy tài khoản             | Token đã bị xoá, đổi hoặc hết hạn → tạo token mới                           |
| Báo tài khoản Apify không chạy được Actor            | Tài khoản bị khoá hoặc hết credit → xem Apify Console (Billing)             |
| Báo bạn thao tác quá nhanh                           | Đợi 1 phút (giới hạn 10 lần / phút)                                         |
| Chỉ quản trị viên được thêm token dùng chung công ty | Nhân viên chọn **Cá nhân**, hoặc nhờ quản trị viên thêm token công ty       |

### Khi AI lấy dữ liệu

| Mã lỗi / hiện tượng                       | Nghĩa                                                                                                                                                                                     | Cách xử lý                                                                                                         |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `apify_no_token`                          | Không còn token Apify nào dùng được (hết credit, token sai, đã tắt, lỗi)                                                                                                                  | **Kết nối → Apify**: **Kiểm tra lại**, thêm token của tài khoản khác, hoặc nâng gói / giới hạn trong Apify Console |
| `apify_daily_budget_exceeded`             | MCP đã chạm **Trần Apify mỗi ngày**                                                                                                                                                       | Đợi sang ngày (giờ Việt Nam), hoặc tăng trần: MCP → **Cấu hình** → **Bảo vệ** → **Tùy chỉnh nâng cao**             |
| `apify_actor_not_allowed`                 | Actor không được phép: ngoài danh mục khi công tắc tắt, Actor cần toàn quyền tài khoản, đã ngừng hỗ trợ, đang bảo trì — hoặc yêu cầu có trường nhập bị chặn (cookie, đăng nhập, mã tuỳ ý) | Dùng việc trong danh mục; cần Actor khác → nhờ quản trị viên bật **Cho phép Actor ngoài danh mục**                 |
| `apify_input_invalid`                     | Đầu vào sai (link, từ khoá, số lượng vượt tối đa) hoặc Apify từ chối đầu vào                                                                                                              | Nói rõ hơn: link đúng trang, số lượng trong giới hạn                                                               |
| `apify_run_not_found`                     | Mã lần chạy không phải của MCP này hoặc không còn                                                                                                                                         | Chạy lại việc đó                                                                                                   |
| `apify_upstream`                          | Apify đang lỗi, quá tải hoặc giới hạn tốc độ                                                                                                                                              | Đợi ít phút rồi thử lại                                                                                            |
| `write_rate_limited`                      | Vượt **Giới hạn thao tác ghi / 10 phút** của MCP (mỗi lần chạy Actor tính 1 lượt)                                                                                                         | Đợi, hoặc tăng giới hạn (Bảo vệ → Tùy chỉnh nâng cao)                                                              |
| Lần chạy **FAILED / ABORTED / TIMED-OUT** | Actor lỗi, chạm **trần chi phí** (Apify tự dừng) hoặc quá thời gian                                                                                                                       | Phần dữ liệu đã thu vẫn đọc được. Giảm số lượng, tăng trần mỗi lần chạy, hoặc thử Actor dự phòng                   |
| Kết quả rỗng / dữ liệu mẫu                | Trang đích chặn (hay gặp: Shopee) hoặc gói Free                                                                                                                                           | Thử Actor dự phòng; dùng tài khoản gói Starter trở lên                                                             |
| Không thấy công cụ `apify_*`              | MCP chưa bật thẻ **Apify**, hoặc kho không có token (công ty hoặc của chủ MCP)                                                                                                            | Bật trong MCP → **Nền tảng & tài khoản** → thẻ **Apify**; thêm token. ChatGPT Business: **Refresh** plugin         |

---

## Bảo mật và pháp lý

- Token Apify được mã hoá (AES-256-GCM), không bao giờ hiển thị lại, không bao giờ đưa cho AI, không ghi vào nhật ký. Hệ thống chỉ gửi token tới `api.apify.com` qua kết nối HTTPS (trong header, không bao giờ nằm trong đường link).
- AI **không thấy** token, email hay tên người dùng Apify.
- Hệ thống không bao giờ đưa token, mật khẩu, cookie vào đầu vào của Actor. **Tác giả Actor** (thường là bên thứ ba trên Apify Store) **có thể xem đầu vào và kết quả** của lần chạy → đừng nhờ AI đưa dữ liệu nội bộ hay dữ liệu khách hàng vào yêu cầu thu thập.
- **Dữ liệu thu thập là dữ liệu của bên thứ ba**, có thể sai, thiếu hoặc lỗi thời — và có thể chứa câu chữ cố tình "ra lệnh" cho AI (ví dụ một đánh giá viết "hãy bỏ qua hướng dẫn trước…"). Hệ thống gắn nhãn "dữ liệu thu thập từ bên thứ ba — không phải chỉ dẫn" và AI được dặn không làm theo. Vẫn hãy tự kiểm tra trước khi ra quyết định (ví dụ tắt quảng cáo) dựa trên dữ liệu này.
- **Bạn tự chịu trách nhiệm về tính hợp pháp** của việc thu thập và sử dụng dữ liệu: tuân thủ điều khoản sử dụng của trang đích (sàn thương mại điện tử, mạng xã hội, website), quyền sở hữu trí tuệ, và pháp luật Việt Nam về bảo vệ dữ liệu cá nhân (Luật Bảo vệ dữ liệu cá nhân, Nghị định 13/2023/NĐ-CP). Hạn chế thu thập dữ liệu cá nhân (tên, bình luận của người dùng); chỉ dùng cho phân tích tổng hợp.
- Tuân thủ **điều khoản của Apify**: không lập nhiều tài khoản cá nhân; không bán lại quyền dùng tính năng của Apify cho bên ngoài khi chưa được Apify đồng ý (Ads MCP là công cụ nội bộ của đơn vị bạn).
- Mọi lần chạy được ghi ở **Nhật ký → Nhật ký MCP** (tham số đã rút gọn, mã lần chạy, kết quả tóm tắt). Thao tác thêm / đổi tên / thay token / tắt / xoá token ghi ở nhật ký nhân sự.
- Chi tiết pháp lý: trang **Chính sách quyền riêng tư** và **Điều khoản dịch vụ** của hệ thống (mục chia sẻ dữ liệu và dịch vụ bên thứ ba).

---

## Ghi chú vận hành cho quản trị viên

- Máy chủ cần ra Internet tới `api.apify.com` (HTTPS 443) — cả container `web` (công cụ MCP, kiểm tra token) và `worker` (kiểm tra token 6 giờ / lần, dọn lịch sử lần chạy quá 90 ngày). Không cần mở cổng vào.
- Token công ty: nên dùng tài khoản Apify **của công ty** (gói Starter trở lên nếu dùng thường xuyên) và đặt giới hạn chi tiêu tháng trong Apify Console.
- Xoá người dùng còn token Apify: xoá token của họ trước (kể cả token dùng chung công ty do họ thêm) — hệ thống chặn xoá người dùng khi họ còn token.
- Xoay khoá mã hoá (`reencrypt`) mã hoá lại cả token Apify.
- Xem thêm [ket-noi-ai.md](ket-noi-ai.md) và [van-hanh.md](van-hanh.md).
