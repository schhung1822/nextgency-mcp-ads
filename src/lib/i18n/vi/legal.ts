// Chuỗi giao diện - nhóm "legal": 3 trang công khai /privacy, /terms, /data-deletion (tiếng Việt trước, bản tiếng
// Anh cho người duyệt app của Meta/TikTok/Google/OpenAI ở cuối trang) + khối "Liên kết cho ứng dụng" ở sidebar.
// Nội dung phải khớp hệ thống thật (01-product-spec, 05-security, 11-meta-pages, 14-telegram-notifications,
// 15-google-drive-media, 16-apify, services/connections.ts).
// Đơn vị vận hành (bên kiểm soát dữ liệu) = tổ chức tự cài đặt hệ thống; noti.vn chỉ là nhà phát triển phần mềm.
import type { LegalInfo } from "@/lib/legal"

export type LegalLang = "vi" | "en"

export type LegalBlock =
  | { kind: "p"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  /** the operator's privacy contact: mailto link when set, otherwise "the system administrator at <domain>" */
  | { kind: "contact" }

export interface LegalSection {
  id: string
  title: string
  blocks: LegalBlock[]
}

export interface LegalDoc {
  title: string
  intro: string[]
  sections: LegalSection[]
}

const p = (text: string): LegalBlock => ({ kind: "p", text })
const ul = (...items: string[]): LegalBlock => ({ kind: "ul", items })
const ol = (...items: string[]): LegalBlock => ({ kind: "ol", items })
const contact: LegalBlock = { kind: "contact" }

// ---------------------------------------------------------------------------------------------------------------
// Chính sách quyền riêng tư / Privacy Policy
// ---------------------------------------------------------------------------------------------------------------

function privacyVi(c: LegalInfo): LegalDoc {
  return {
    title: "Chính sách quyền riêng tư",
    intro: [
      `Chính sách này giải thích cách hệ thống Ads MCP tại ${c.domain} (“Hệ thống”) thu thập, sử dụng, lưu trữ và bảo vệ dữ liệu. Hệ thống do ${c.orgName} (“Đơn vị vận hành”, “chúng tôi”) tự cài đặt và vận hành trên máy chủ của mình, sử dụng phần mềm Ads MCP do noti.vn phát triển.`,
      "Đơn vị vận hành là bên kiểm soát dữ liệu trong Hệ thống. noti.vn chỉ là nhà phát triển phần mềm: noti.vn không vận hành Hệ thống này, không lưu trữ và không truy cập dữ liệu của Hệ thống.",
    ],
    sections: [
      {
        id: "gioi-thieu",
        title: "1. Hệ thống dùng để làm gì",
        blocks: [
          p(
            "Hệ thống là công cụ làm việc nội bộ cho đội marketing của Đơn vị vận hành. Người dùng kết nối tài khoản quảng cáo Meta (Facebook/Instagram), TikTok Ads, Google Ads (gồm quảng cáo YouTube) và OpenAI Ads bằng access token, refresh token, khoá service account hoặc API key do chính họ tạo trong ứng dụng nhà phát triển của mình, rồi điều khiển quảng cáo từ trợ lý AI (Claude, ChatGPT, Gemini) qua một đường dẫn MCP riêng: xem chỉ số theo ngày, bật/tắt, sửa, sao chép, tạo mới quảng cáo và đọc bài viết, chỉ số của Trang Facebook."
          ),
          p(
            "Người dùng cũng có thể thêm kênh thông báo Telegram (bot Telegram do chính họ tạo) để nhận tin khi trợ lý AI thay đổi quảng cáo, khi kết nối quảng cáo sắp hết hạn hoặc bị lỗi, khi có bản cập nhật phần mềm, hoặc khi trợ lý AI được phép gửi tin."
          ),
          p(
            "Người dùng cũng có thể khai báo thư mục Google Drive và Google Sheet (bằng cách chia sẻ chúng cho tài khoản dịch vụ - service account - của Hệ thống) để trợ lý AI lấy ảnh, video quảng cáo tải lên tài khoản quảng cáo, đọc kế hoạch creative trong sheet và ghi trạng thái ngược vào sheet."
          ),
          p(
            "Người dùng cũng có thể thêm API token của Apify - nền tảng thu thập dữ liệu web của Apify Technologies s.r.o. (Cộng hoà Séc) - để trợ lý AI lấy dữ liệu công khai trên sàn thương mại điện tử, mạng xã hội, Google và website (ví dụ giá, đánh giá sản phẩm, quảng cáo đang chạy của đối thủ) bằng các chương trình thu thập dữ liệu (“Actor”) chạy trên Apify, rồi phân tích theo yêu cầu của người dùng."
          ),
          p(
            "Không có đăng ký công khai: chỉ người được quản trị viên cấp tài khoản mới đăng nhập được. Hệ thống không dùng tính năng “Đăng nhập bằng Facebook”."
          ),
        ],
      },
      {
        id: "du-lieu",
        title: "2. Dữ liệu chúng tôi xử lý",
        blocks: [
          ul(
            "Tài khoản nhân sự: họ tên, email, vai trò. Mật khẩu chỉ được lưu dưới dạng băm một chiều; khoá bí mật xác thực 2 bước (2FA) và mã dự phòng được mã hoá; phiên đăng nhập kèm địa chỉ IP và thông tin trình duyệt.",
            "Thông tin truy cập nền tảng quảng cáo: access token Meta (kèm App ID, App Secret nếu người dùng nhập); access token TikTok (kèm App ID, App Secret); thông tin Google Ads (OAuth client ID, client secret và refresh token, hoặc tệp khoá JSON của service account, kèm ID tài khoản quản lý nếu có); API key OpenAI Ads. Chúng được mã hoá AES-256-GCM trước khi lưu, không bao giờ hiển thị lại (giao diện chỉ hiện 4 ký tự cuối), không được ghi vào nhật ký và không bao giờ được gửi cho trợ lý AI.",
            "Dữ liệu quảng cáo: danh sách tài khoản quảng cáo (tên, ID, tiền tệ, múi giờ, trạng thái) được lưu để phân quyền. Chiến dịch (kể cả chiến dịch video YouTube chạy qua Google Ads), nhóm quảng cáo, quảng cáo, từ khoá và chỉ số hiệu quả được lấy trực tiếp từ Meta Marketing API, TikTok API for Business, Google Ads API và OpenAI Ads API mỗi khi người dùng yêu cầu, không được lưu thành kho dữ liệu riêng.",
            "Kênh thông báo Telegram: bot token (mã hoá AES-256-GCM như trên, giao diện chỉ hiện 4 ký tự cuối, không ghi vào nhật ký, không gửi cho trợ lý AI), chat ID, tên nhóm/kênh, ID chủ đề (nếu có), tên bot và các loại sự kiện đã đăng ký. Mỗi lần gửi tin được ghi nhật ký gửi (thời gian, nguồn, loại sự kiện, trạng thái, mã lỗi và đoạn xem trước tối đa 300 ký tự đã che thông tin bí mật).",
            "Google Drive và Google Sheet: khoá JSON của service account Google và API key Google (mã hoá AES-256-GCM như trên, giao diện chỉ hiện 4 ký tự cuối, không ghi vào nhật ký, không gửi cho trợ lý AI); email của service account (không bí mật, hiển thị để mọi người chia sẻ thư mục); danh sách thư mục / sheet đã khai báo (mã và tên trên Google Drive, phạm vi công ty / riêng, người khai báo, cấu hình cột, trạng thái kiểm tra). Nội dung file ảnh / video và các ô của sheet chỉ được đọc khi người dùng hoặc trợ lý AI yêu cầu; file được chuyển thẳng từ Google Drive tới nền tảng quảng cáo, không lưu trên máy chủ. Hệ thống lưu mã file và mã media đã tải lên tài khoản quảng cáo (để dùng lại), đường dẫn tạm cho nền tảng tải video (mã bí mật, hết hạn sau 60 phút) và trạng thái các lượt tải video ở chế độ nền. Với sheet được bật ghi, Hệ thống chỉ ghi vào các cột trạng thái / kết quả đã khai báo.",
            "Apify: API token của Apify (mã hoá AES-256-GCM như trên, giao diện chỉ hiện 4 ký tự cuối, không ghi vào nhật ký, không gửi cho trợ lý AI); phạm vi token (dùng chung công ty / cá nhân) và người thêm; thông tin không bí mật của tài khoản Apify lấy từ Apify (mã và tên người dùng Apify, gói dịch vụ, mức đã dùng / giới hạn chi tiêu trong tháng, ngày đặt lại) - Hệ thống không lưu email hay mật khẩu proxy của tài khoản Apify; lịch sử các lần chạy (MCP, Actor, mã lần chạy, trạng thái, chi phí, số kết quả, thời gian). Dữ liệu do Actor thu thập được đọc từ Apify khi trợ lý AI yêu cầu và chuyển cho trợ lý AI, không được lưu thành kho dữ liệu trong Hệ thống (ngoài phần tóm tắt có giới hạn dung lượng trong nhật ký MCP); bản gốc nằm trong tài khoản Apify của chủ token.",
            "Dữ liệu Trang Facebook (chỉ đọc): danh sách Trang mà token được cấp quyền (tên, ID, danh mục, ảnh đại diện, số người theo dõi) được lưu để phân quyền. Bài viết và chỉ số của Trang được đọc qua Graph API khi người dùng yêu cầu. Hệ thống không đăng, sửa, xoá bài viết và không đọc nội dung bình luận hay tin nhắn.",
            "Nhật ký: nhật ký thao tác của nhân sự (thời gian, người thực hiện, hành động, đối tượng, địa chỉ IP, thiết bị) và nhật ký từng lệnh MCP (thời gian, ứng dụng AI, địa chỉ IP, công cụ được gọi, tham số và tóm tắt kết quả, giá trị trước và sau với thao tác ghi). Thông tin bí mật được che trước khi ghi và dung lượng mỗi bản ghi có giới hạn.",
            "Dữ liệu kỹ thuật tạm thời: bộ đếm chống dò mật khẩu và giới hạn tần suất (theo email, địa chỉ IP), các thao tác đang chờ xác nhận 2 bước. Chúng tự động bị xoá khi hết hạn."
          ),
        ],
      },
      {
        id: "muc-dich",
        title: "3. Mục đích sử dụng",
        blocks: [
          ul(
            "Xác thực người dùng, phân quyền và bảo vệ tài khoản.",
            "Thực hiện đúng yêu cầu của người dùng: xem báo cáo, bật/tắt, sửa, sao chép, tạo mới quảng cáo; đọc bài viết và chỉ số Trang.",
            "Gửi thông báo tới nhóm/kênh Telegram mà người dùng đã cấu hình, đúng các sự kiện họ đã bật.",
            "Lấy ảnh, video từ Google Drive để tải lên tài khoản quảng cáo và cập nhật trạng thái trong Google Sheet theo yêu cầu của người dùng.",
            "Chạy Actor trên Apify bằng token đã thêm để thu thập dữ liệu công khai mà người dùng yêu cầu trợ lý AI phân tích.",
            "Ghi nhật ký để kiểm soát thao tác, điều tra sự cố và phát hiện lạm dụng.",
            "Vận hành, bảo trì và cập nhật Hệ thống."
          ),
          p(
            "Chúng tôi không dùng dữ liệu để quảng cáo, không lập hồ sơ người dùng cho mục đích tiếp thị và không bán hay cho thuê dữ liệu."
          ),
        ],
      },
      {
        id: "co-so",
        title: "4. Cơ sở xử lý dữ liệu",
        blocks: [
          ul(
            "Cần thiết để cung cấp công cụ mà nhân sự sử dụng trong công việc.",
            "Sự đồng ý của người dùng: người dùng chủ động kết nối tài khoản quảng cáo, Trang, kênh Telegram, chia sẻ thư mục / sheet Google Drive, thêm token Apify và cấp quyền cho token; có thể rút lại bất cứ lúc nào (mục 8).",
            "Lợi ích chính đáng của Đơn vị vận hành trong việc bảo vệ Hệ thống và tài sản quảng cáo (nhật ký, chống dò mật khẩu).",
            "Nghĩa vụ theo quy định của pháp luật, khi có."
          ),
          p(
            "Đơn vị vận hành chịu trách nhiệm xử lý dữ liệu cá nhân theo quy định của pháp luật Việt Nam về bảo vệ dữ liệu cá nhân."
          ),
        ],
      },
      {
        id: "chia-se",
        title: "5. Chia sẻ dữ liệu",
        blocks: [
          ul(
            "Meta Platforms, TikTok, Google và OpenAI: Hệ thống gọi API của họ bằng token, khoá hoặc API key của bạn, chỉ khi cần để thực hiện yêu cầu. Dữ liệu phía nền tảng tuân theo chính sách quyền riêng tư của Meta, TikTok, Google và OpenAI.",
            "Telegram: nếu bạn thêm kênh thông báo, Hệ thống gửi tin qua Telegram Bot API bằng bot token của bạn tới nhóm/kênh bạn chọn. Tin có thể chứa tên MCP, tên và ID tài khoản quảng cáo, tên đối tượng quảng cáo, thay đổi trạng thái/ngân sách, trạng thái kết nối, thông tin phiên bản phần mềm và nội dung do trợ lý AI soạn (chỉ khi bạn cho phép). Tin không bao giờ chứa token, API key hay đường dẫn MCP. Mọi thành viên của nhóm/kênh đó đều đọc được tin; tin trên Telegram tuân theo chính sách quyền riêng tư của Telegram.",
            "Google Drive và Google Sheets (Google): Hệ thống gọi Google Drive API và Google Sheets API bằng service account hoặc API key do Đơn vị vận hành (hoặc chính bạn) tạo, chỉ với thư mục / sheet đã được chia sẻ cho service account hoặc file đã chia sẻ công khai “Bất kỳ ai có đường liên kết”. Ảnh, video được chuyển tiếp tới nền tảng quảng cáo bạn chọn (Meta, TikTok, Google, OpenAI); với video, nền tảng tải qua một đường dẫn tạm có mã bí mật trên tên miền của Hệ thống. Trợ lý AI chỉ nhận mã file, tên, kích thước và thông số - không nhận khoá, API key hay đường dẫn tạm. Dữ liệu trên Google tuân theo chính sách quyền riêng tư của Google.",
            "Apify (Apify Technologies s.r.o., Cộng hoà Séc, Liên minh Châu Âu): nếu bạn thêm token Apify và MCP được bật Apify, Hệ thống gọi Apify API bằng token đó để chạy Actor. Apify nhận đầu vào của Actor do trợ lý AI soạn theo yêu cầu (ví dụ từ khoá, đường dẫn sản phẩm, Trang, kênh hoặc website cần thu thập) và lưu đầu vào, kết quả của lần chạy trong tài khoản Apify của chủ token; tác giả của Actor (thường là bên thứ ba trên Apify Store) có thể xem đầu vào và kết quả lần chạy. Hệ thống không đưa token quảng cáo, mật khẩu, cookie hay thông tin đăng nhập vào đầu vào Actor. Kết quả là dữ liệu do bên thứ ba thu thập từ trang đích và có thể chứa dữ liệu cá nhân công khai (ví dụ tên người đánh giá, bình luận). Dữ liệu trên Apify tuân theo điều khoản và chính sách quyền riêng tư của Apify (Apify có thể chuyển dữ liệu ra ngoài Liên minh Châu Âu theo điều khoản hợp đồng mẫu).",
            "Trợ lý AI mà bạn kết nối (Claude, ChatGPT, Gemini…): khi bạn thêm đường dẫn MCP vào ứng dụng AI, trợ lý chỉ nhận dữ liệu bạn yêu cầu thông qua các công cụ MCP, trong phạm vi tài khoản, Trang và quyền đã cấp cho đường dẫn đó; trợ lý không bao giờ nhận token hay API key. Nội dung cuộc trò chuyện do nhà cung cấp AI xử lý theo điều khoản của họ.",
            "Máy chủ có thể tự kiểm tra bản cập nhật phần mềm (GitHub) và tải thông báo hệ thống từ noti.vn. Các yêu cầu này không gửi kèm dữ liệu người dùng hay dữ liệu quảng cáo.",
            "Cơ quan nhà nước có thẩm quyền, khi pháp luật yêu cầu."
          ),
          p(
            "Ngoài các trường hợp trên, chúng tôi không chia sẻ dữ liệu cho bên thứ ba."
          ),
        ],
      },
      {
        id: "luu-tru-bao-mat",
        title: "6. Nơi lưu trữ và bảo mật",
        blocks: [
          p(
            `Toàn bộ dữ liệu được lưu trong cơ sở dữ liệu trên máy chủ do Đơn vị vận hành quản lý (${c.domain}); truy cập qua kết nối HTTPS được mã hoá.`
          ),
          ul(
            "Token, API key, khoá service account, bot token Telegram, token Apify và đường dẫn MCP được mã hoá AES-256-GCM; khoá mã hoá được giữ tách khỏi cơ sở dữ liệu.",
            "Mật khẩu được băm một chiều; hỗ trợ xác thực 2 bước (TOTP); tạm khoá khi nhập sai nhiều lần.",
            "Phân quyền theo vai trò Quản trị viên / Nhân viên; nhân viên chỉ thấy kết nối, kênh Telegram và MCP của chính mình; thư mục / sheet Google Drive riêng chỉ chủ sở hữu và quản trị viên thấy; token Apify cá nhân chỉ chủ sở hữu và quản trị viên quản lý, token Apify dùng chung công ty do quản trị viên quản lý (nhân viên chỉ thấy tên, trạng thái và mức đã dùng).",
            "Thao tác ghi do trợ lý AI đề xuất có thể yêu cầu xác nhận 2 bước và bị giới hạn ngân sách tuỳ chế độ bảo vệ của từng MCP (chế độ Cơ bản chỉ áp dụng thời hạn MCP; xoá và thay đổi TikTok GMV Max luôn cần xác nhận); quảng cáo tạo mới hoặc sao chép luôn ở trạng thái tạm dừng, trừ chiến dịch TikTok GMV Max: TikTok không cho tạo ở trạng thái tạm dừng nên chiến dịch GMV Max tạo mới hoặc sao chép sẽ chạy và phát sinh chi phí ngay - chỉ làm được khi quản trị viên đã bật quyền thay đổi GMV Max cho MCP và người dùng xác nhận.",
            "Mỗi lần trợ lý AI chạy Actor trên Apify luôn có trần chi phí do Hệ thống đặt (Apify tự dừng lần chạy khi chạm trần); chế độ bảo vệ Tùy chỉnh nâng cao có thêm trần chi phí mỗi ngày cho từng MCP.",
            "Đường dẫn MCP sai, đã tắt hoặc hết hạn không trả về dữ liệu."
          ),
          p(
            "Không hệ thống nào an toàn tuyệt đối. Khi phát hiện sự cố ảnh hưởng tới dữ liệu, chúng tôi sẽ khắc phục và thông báo cho người bị ảnh hưởng theo quy định."
          ),
        ],
      },
      {
        id: "thoi-han",
        title: "7. Thời gian lưu trữ",
        blocks: [
          ul(
            `Nhật ký MCP: giữ ${c.retentionMcpMonths} tháng gần nhất cộng tháng hiện tại; phần cũ hơn tự động bị xoá vĩnh viễn.`,
            `Nhật ký nhân sự: giữ ${c.retentionStaffMonths} tháng gần nhất cộng tháng hiện tại; phần cũ hơn tự động bị xoá vĩnh viễn.`,
            "Token và API key: tới khi kết nối bị xoá hoặc được thay token; khi xoá kết nối, bản mã hoá của token bị ghi đè ngay.",
            "Bot token Telegram: tới khi kênh thông báo bị xoá hoặc được thay token; khi xoá kênh, Hệ thống ngừng gửi tin và không dùng token đó nữa.",
            `Nhật ký gửi tin Telegram: giữ theo thời hạn của nhật ký MCP (${c.retentionMcpMonths} tháng), sau đó tự động bị xoá.`,
            "Google Drive: khoá service account và API key giữ tới khi bị xoá hoặc thay; thư mục / sheet đã khai báo giữ tới khi bị xoá; đường dẫn tạm cho video hết hạn sau 60 phút và bị xoá sau 24 giờ; lượt tải video ở chế độ nền bị xoá sau 30 ngày; mã media đã tải lên giữ để dùng lại tới khi tài khoản quảng cáo bị xoá khỏi Hệ thống. File trên Google Drive không bị Hệ thống sao chép hay lưu lại.",
            "Token Apify: tới khi bị xoá hoặc được thay token; khi xoá, bản mã hoá của token bị ghi đè ngay. Lịch sử lần chạy Apify: giữ 90 ngày rồi tự động bị xoá. Dữ liệu thu thập nằm trong tài khoản Apify của chủ token theo thời hạn lưu của Apify; Hệ thống không sao chép lưu lại.",
            "Tài khoản nhân sự: tới khi quản trị viên xoá tài khoản.",
            "Phiên đăng nhập, bộ đếm bảo mật, thao tác chờ xác nhận: tự động xoá khi hết hạn.",
            "Dữ liệu quảng cáo và Trang lấy từ nền tảng: không lưu lâu dài, ngoài danh sách tài khoản, Trang và phần tóm tắt trong nhật ký."
          ),
        ],
      },
      {
        id: "quyen",
        title: "8. Quyền của bạn",
        blocks: [
          ul(
            "Xem và sửa thông tin tài khoản của mình trong trang Tài khoản; yêu cầu Đơn vị vận hành cung cấp bản sao dữ liệu về bạn.",
            `Yêu cầu xoá dữ liệu: làm theo Hướng dẫn xoá dữ liệu tại ${c.baseUrl}/data-deletion.`,
            "Rút lại quyền truy cập: xoá kết nối trong Hệ thống, thu hồi token hoặc API key, hoặc gỡ ứng dụng khỏi tài khoản Facebook, TikTok For Business hay tài khoản Google. Sau đó Hệ thống không truy cập được dữ liệu nền tảng của bạn nữa. Với Telegram: xoá kênh thông báo trong Hệ thống và/hoặc thu hồi bot token bằng @BotFather (lệnh /revoke). Với Google Drive: bỏ chia sẻ thư mục / sheet với email service account trên Google Drive, xoá thư mục / sheet trong Hệ thống, hoặc (quản trị viên) xoá khoá service account / API key trong Google Cloud. Với Apify: xoá token trong Hệ thống và/hoặc xoá, đổi token trong Apify Console (Settings → API & Integrations).",
            "Phản đối hoặc yêu cầu hạn chế xử lý, khiếu nại theo quy định của pháp luật."
          ),
        ],
      },
      {
        id: "tre-em",
        title: "9. Trẻ em",
        blocks: [
          p(
            "Hệ thống là công cụ làm việc nội bộ, không dành cho người dưới 18 tuổi và không cố ý thu thập dữ liệu của trẻ em."
          ),
        ],
      },
      {
        id: "thay-doi",
        title: "10. Thay đổi chính sách",
        blocks: [
          p(
            "Chính sách có thể được cập nhật; ngày cập nhật gần nhất ghi ở đầu trang. Với thay đổi quan trọng, Đơn vị vận hành sẽ thông báo cho người dùng trước khi áp dụng."
          ),
        ],
      },
      {
        id: "lien-he",
        title: "11. Liên hệ",
        blocks: [
          p(
            `Mọi câu hỏi hoặc yêu cầu về quyền riêng tư, vui lòng liên hệ ${c.orgName}:`
          ),
          contact,
        ],
      },
    ],
  }
}

function privacyEn(c: LegalInfo): LegalDoc {
  return {
    title: "Privacy Policy",
    intro: [
      `This policy explains how the Ads MCP system at ${c.domain} (the “System”) collects, uses, stores and protects data. The System is self-hosted and operated by ${c.orgName} (the “Operator”, “we”) on its own server, using the Ads MCP software developed by noti.vn.`,
      "The Operator is the data controller for the System. noti.vn is only the software developer: noti.vn does not operate this System and does not store or access its data.",
    ],
    sections: [
      {
        id: "en-about",
        title: "1. What the System does",
        blocks: [
          p(
            "The System is an internal work tool for the Operator’s marketing team. Users connect Meta (Facebook/Instagram), TikTok Ads, Google Ads (including YouTube ads) and OpenAI Ads ad accounts with an access token, refresh token, service account key or API key they create in their own developer app, then manage ads from an AI assistant (Claude, ChatGPT, Gemini) through a private MCP link: daily metrics, pausing/activating, editing, copying and creating ads, and reading Facebook Page posts and insights."
          ),
          p(
            "Users can also add a Telegram notification channel (a Telegram bot they create themselves) to receive messages when an AI assistant changes ads, when an ad connection is about to expire or fails, when a software update is available, or when the AI assistant is allowed to send messages."
          ),
          p(
            "Users can also register Google Drive folders and Google Sheets (by sharing them with the System’s service account) so the AI assistant can take ad images and videos from them, upload them to ad accounts, read a creative plan in a sheet and write status back to that sheet."
          ),
          p(
            "Users can also add an API token for Apify - the web data collection platform of Apify Technologies s.r.o. (Czech Republic) - so the AI assistant can collect publicly available data from e-commerce marketplaces, social networks, Google and websites (for example product prices and reviews, or competitors’ running ads) through data collection programs (“Actors”) that run on Apify, and analyse it at the user’s request."
          ),
          p(
            "There is no public sign-up: only people given an account by an administrator can sign in. The System does not use “Login with Facebook”."
          ),
        ],
      },
      {
        id: "en-data",
        title: "2. Data we process",
        blocks: [
          ul(
            "Staff accounts: name, email, role. Passwords are stored only as one-way hashes; two-factor (2FA) secrets and backup codes are encrypted; sign-in sessions include the IP address and browser information.",
            "Ad platform credentials: Meta access tokens (plus App ID and App Secret if entered); TikTok access tokens (plus App ID and App Secret); Google Ads credentials (OAuth client ID, client secret and refresh token, or a service account JSON key file, plus the manager account ID if any); OpenAI Ads API keys. They are encrypted with AES-256-GCM before storage, never shown again (the interface only shows the last 4 characters), never written to logs and never sent to an AI assistant.",
            "Advertising data: the list of ad accounts (name, ID, currency, time zone, status) is stored for access control. Campaigns (including YouTube video campaigns run through Google Ads), ad sets/ad groups, ads, keywords and performance metrics are fetched directly from the Meta Marketing API, the TikTok API for Business, the Google Ads API and the OpenAI Ads API whenever a user asks, and are not kept as a separate data store.",
            "Telegram notification channels: the bot token (encrypted with AES-256-GCM as above, only the last 4 characters shown, never logged, never sent to an AI assistant), chat ID, group/channel title, topic ID (if any), bot name and the subscribed event types. Each message sent is recorded in a delivery log (time, source, event type, status, error code and a preview of at most 300 characters with secrets masked).",
            "Google Drive and Google Sheets: the Google service account JSON key and the Google API key (encrypted with AES-256-GCM as above, only the last 4 characters shown, never logged, never sent to an AI assistant); the service account email (not secret, shown so people can share folders with it); the registered folders / sheets (Google Drive ID and name, company / personal scope, who registered it, column mapping, check status). Image / video files and sheet cells are only read when a user or the AI assistant asks; files are passed straight from Google Drive to the ad platform and are not stored on the server. The System stores file IDs and the media IDs already uploaded to an ad account (for reuse), temporary links the platform uses to fetch a video (secret token, expire after 60 minutes) and the status of background video uploads. For sheets with write-back enabled, the System only writes to the declared status / result columns.",
            "Apify: the Apify API token (encrypted with AES-256-GCM as above, only the last 4 characters shown, never logged, never sent to an AI assistant); the token scope (shared company / personal) and who added it; non-secret Apify account information fetched from Apify (Apify user ID and username, plan, monthly usage / spending limit, reset date) - the System does not store the Apify account’s email or proxy password; the history of runs (MCP, Actor, run ID, status, cost, number of results, time). Data collected by Actors is read from Apify when the AI assistant asks and passed to the AI assistant; it is not kept as a data store in the System (apart from size-limited summaries in the MCP log); the original stays in the token owner’s Apify account.",
            "Facebook Page data (read-only): the list of Pages the token can access (name, ID, category, profile picture, follower count) is stored for access control. Page posts and insights are read through the Graph API when a user asks. The System does not publish, edit or delete posts and does not read comment or message content.",
            "Logs: staff activity logs (time, actor, action, target, IP address, device) and a log of every MCP request (time, AI app, IP address, tool called, parameters and a result summary, before/after values for write actions). Secrets are masked before logging and each record has a size limit.",
            "Temporary technical data: password-guessing and rate-limit counters (by email, IP address) and actions waiting for two-step confirmation. They are deleted automatically when they expire."
          ),
        ],
      },
      {
        id: "en-purposes",
        title: "3. Purposes",
        blocks: [
          ul(
            "Authenticating users, enforcing permissions and protecting accounts.",
            "Doing what users ask: reporting, pausing/activating, editing, copying and creating ads; reading Page posts and insights.",
            "Sending notifications to the Telegram groups/channels users configured, for the events they enabled.",
            "Taking images and videos from Google Drive to upload them to ad accounts, and updating status in Google Sheets, when users ask.",
            "Running Actors on Apify with the added tokens to collect the publicly available data users ask the AI assistant to analyse.",
            "Keeping logs for accountability, incident investigation and abuse detection.",
            "Operating, maintaining and updating the System."
          ),
          p(
            "We do not use data for advertising, do not profile users for marketing and do not sell or rent data."
          ),
        ],
      },
      {
        id: "en-basis",
        title: "4. Legal basis",
        blocks: [
          ul(
            "Necessity to provide the work tool staff use in their job.",
            "User consent: users choose to connect ad accounts, Pages and Telegram channels, to share Google Drive folders / sheets, to add Apify tokens and to grant permissions to their token, and can withdraw at any time (section 8).",
            "The Operator’s legitimate interest in protecting the System and its ad assets (logs, password-guessing protection).",
            "Legal obligations, where applicable."
          ),
          p(
            "The Operator is responsible for processing personal data in accordance with Vietnamese personal data protection law."
          ),
        ],
      },
      {
        id: "en-sharing",
        title: "5. Sharing",
        blocks: [
          ul(
            "Meta Platforms, TikTok, Google and OpenAI: the System calls their APIs with your token, key or API key, only as needed to fulfil a request. Data on their side is governed by the privacy policies of Meta, TikTok, Google and OpenAI.",
            "Telegram: if you add a notification channel, the System sends messages through the Telegram Bot API with your bot token to the group/channel you chose. Messages may contain the MCP name, ad account names and IDs, ad object names, status/budget changes, connection status, software version information and text written by the AI assistant (only if you allow it). Messages never contain tokens, API keys or MCP links. Every member of that group/channel can read them; messages on Telegram are governed by Telegram’s privacy policy.",
            "Google Drive and Google Sheets (Google): the System calls the Google Drive API and the Google Sheets API with a service account or API key created by the Operator (or by you), only for folders / sheets shared with that service account or files shared publicly with “Anyone with the link”. Images and videos are passed on to the ad platform you choose (Meta, TikTok, Google, OpenAI); for videos, the platform fetches them through a temporary link with a secret token on the System’s domain. The AI assistant only receives file IDs, names, sizes and dimensions - never keys, API keys or temporary links. Data on Google’s side is governed by Google’s privacy policy.",
            "Apify (Apify Technologies s.r.o., Czech Republic, European Union): if you add an Apify token and an MCP server has Apify enabled, the System calls the Apify API with that token to run Actors. Apify receives the Actor input written by the AI assistant on request (for example keywords, product links, Pages, channels or websites to collect) and keeps the input and results of the run in the token owner’s Apify account; the Actor’s author (usually a third party on Apify Store) can see the run input and results. The System never puts ad platform tokens, passwords, cookies or login details into Actor input. Results are data collected by third parties from the target sites and may contain publicly available personal data (for example reviewer names, comments). Data on Apify is governed by Apify’s terms and privacy policy (Apify may transfer data outside the European Union under standard contractual clauses).",
            "The AI assistant you connect (Claude, ChatGPT, Gemini…): when you add your MCP link to an AI app, the assistant only receives the data you request through the MCP tools, within the accounts, Pages and permissions granted to that link; it never receives tokens or API keys. Conversation content is processed by the AI provider under its own terms.",
            "The server may check for software updates (GitHub) and download system notices from noti.vn. These requests do not include user or advertising data.",
            "Competent authorities, when required by law."
          ),
          p("Apart from the above, we do not share data with third parties."),
        ],
      },
      {
        id: "en-storage",
        title: "6. Storage and security",
        blocks: [
          p(
            `All data is stored in a database on a server managed by the Operator (${c.domain}) and accessed over encrypted HTTPS connections.`
          ),
          ul(
            "Tokens, API keys, service account keys, Telegram bot tokens, Apify tokens and MCP links are encrypted with AES-256-GCM; encryption keys are kept separate from the database.",
            "Passwords are hashed; two-factor authentication (TOTP) is supported; repeated wrong attempts trigger a temporary lock.",
            "Role-based access (Administrator / Staff); staff only see their own connections, Telegram channels and MCP servers; personal Google Drive folders / sheets are only visible to their owner and administrators; personal Apify tokens are managed only by their owner and administrators, and shared company Apify tokens by administrators (staff only see their name, status and usage).",
            "Write actions proposed by an AI assistant can require two-step confirmation and be subject to budget limits, depending on each MCP's protection mode (Basic mode only applies the MCP expiry date; deletions and TikTok GMV Max changes always require confirmation); newly created or copied ads always start paused, except TikTok GMV Max campaigns: TikTok does not allow creating them paused, so a newly created or copied GMV Max campaign starts delivering and spending immediately - this is only possible after an administrator has enabled GMV Max changes for the MCP and the user has confirmed.",
            "Every Actor run started by an AI assistant on Apify always has a cost cap set by the System (Apify stops the run when the cap is reached); the Advanced protection mode adds a daily cost cap per MCP.",
            "Invalid, disabled or expired MCP links return no data."
          ),
          p(
            "No system is perfectly secure. If we detect an incident affecting data, we will remediate it and notify affected people as required by law."
          ),
        ],
      },
      {
        id: "en-retention",
        title: "7. Retention",
        blocks: [
          ul(
            `MCP logs: the last ${c.retentionMcpMonths} month${c.retentionMcpMonths === 1 ? "" : "s"} plus the current month are kept; older entries are deleted permanently and automatically.`,
            `Staff activity logs: the last ${c.retentionStaffMonths} month${c.retentionStaffMonths === 1 ? "" : "s"} plus the current month are kept; older entries are deleted permanently and automatically.`,
            "Tokens and API keys: until the connection is deleted or its token is replaced; when a connection is deleted its encrypted token is overwritten immediately.",
            "Telegram bot tokens: until the notification channel is deleted or its token is replaced; once a channel is deleted the System stops sending messages and no longer uses that token.",
            `Telegram delivery logs: kept for the MCP log retention period (${c.retentionMcpMonths} month${c.retentionMcpMonths === 1 ? "" : "s"}), then deleted automatically.`,
            "Google Drive: service account keys and API keys until deleted or replaced; registered folders / sheets until deleted; temporary video links expire after 60 minutes and are deleted after 24 hours; background video uploads are deleted after 30 days; uploaded media IDs are kept for reuse until the ad account is removed from the System. Files on Google Drive are never copied or kept by the System.",
            "Apify tokens: until deleted or replaced; when deleted, the encrypted token is overwritten immediately. Apify run history: kept for 90 days, then deleted automatically. Collected data stays in the token owner’s Apify account for Apify’s retention period; the System does not keep a copy.",
            "Staff accounts: until an administrator deletes the account.",
            "Sessions, security counters and pending confirmations: deleted automatically when they expire.",
            "Advertising and Page data fetched from the platforms: not stored long-term, except the account and Page lists and the summaries in logs."
          ),
        ],
      },
      {
        id: "en-rights",
        title: "8. Your rights",
        blocks: [
          ul(
            "View and correct your own account information on the Account page; ask the Operator for a copy of the data about you.",
            `Request deletion: follow the Data Deletion Instructions at ${c.baseUrl}/data-deletion.`,
            "Withdraw access: delete the connection in the System, revoke the token or API key, or remove the app from your Facebook account, TikTok For Business or Google account. The System can then no longer access your platform data. For Telegram: delete the notification channel in the System and/or revoke the bot token with @BotFather (the /revoke command). For Google Drive: stop sharing the folder / sheet with the service account email in Google Drive, delete the folder / sheet in the System, or (administrators) delete the service account key / API key in Google Cloud. For Apify: delete the token in the System and/or delete or rotate it in Apify Console (Settings → API & Integrations).",
            "Object to or request restriction of processing, and lodge complaints as provided by law."
          ),
        ],
      },
      {
        id: "en-children",
        title: "9. Children",
        blocks: [
          p(
            "The System is an internal work tool, not intended for people under 18, and does not knowingly collect children’s data."
          ),
        ],
      },
      {
        id: "en-changes",
        title: "10. Changes",
        blocks: [
          p(
            "This policy may be updated; the last update date is shown at the top of the page. For material changes, the Operator will inform users before they take effect."
          ),
        ],
      },
      {
        id: "en-contact",
        title: "11. Contact",
        blocks: [
          p(
            `For any privacy question or request, please contact ${c.orgName}:`
          ),
          contact,
        ],
      },
    ],
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Điều khoản dịch vụ / Terms of Service
// ---------------------------------------------------------------------------------------------------------------

function termsVi(c: LegalInfo): LegalDoc {
  return {
    title: "Điều khoản dịch vụ",
    intro: [
      `Điều khoản này áp dụng khi bạn truy cập và sử dụng hệ thống Ads MCP tại ${c.domain} (“Hệ thống”), kể cả qua đường dẫn MCP trong trợ lý AI. Bằng việc đăng nhập hoặc sử dụng đường dẫn MCP, bạn đồng ý với các điều khoản dưới đây.`,
    ],
    sections: [
      {
        id: "don-vi",
        title: "1. Đơn vị cung cấp dịch vụ",
        blocks: [
          p(
            `Hệ thống do ${c.orgName} (“Đơn vị vận hành”) cài đặt, quản lý và cung cấp cho nhân sự được cấp quyền. Phần mềm Ads MCP do noti.vn phát triển và giữ bản quyền; noti.vn không phải là bên cung cấp dịch vụ này.`
          ),
        ],
      },
      {
        id: "giay-phep",
        title: "2. Giấy phép phần mềm",
        blocks: [
          p(
            "Phần mềm được cung cấp theo giấy phép riêng của noti.vn (mã nguồn có thể xem nhưng không phải mã nguồn mở): chỉ đơn vị được noti.vn cấp quyền bằng văn bản mới được cài đặt và vận hành, cho mục đích nội bộ. Khi không có văn bản cấp quyền, không được sao chép, phân phối, bán, cung cấp phần mềm dưới dạng dịch vụ cho bên thứ ba hoặc gỡ bỏ thông báo bản quyền, tên và logo noti.vn."
          ),
        ],
      },
      {
        id: "tai-khoan",
        title: "3. Tài khoản và bảo mật",
        blocks: [
          ul(
            "Chỉ quản trị viên tạo tài khoản; không có đăng ký công khai.",
            "Bạn giữ bí mật mật khẩu, mã xác thực 2 bước và đường dẫn MCP. Đường dẫn MCP có giá trị như một khoá truy cập: ai có đường dẫn sẽ dùng được các quyền đã cấp cho nó.",
            "Báo ngay cho quản trị viên khi nghi bị lộ để xoay khoá MCP, thay token hoặc khoá tài khoản."
          ),
        ],
      },
      {
        id: "su-dung",
        title: "4. Sử dụng được phép",
        blocks: [
          ul(
            "Chỉ kết nối tài khoản quảng cáo, Trang và nhóm/kênh Telegram mà bạn hoặc đơn vị của bạn có quyền quản lý.",
            "Tuân thủ Điều khoản và Tiêu chuẩn quảng cáo của Meta, chính sách quảng cáo của TikTok và Google (gồm YouTube), điều khoản của OpenAI Ads, điều khoản của Telegram và của nhà cung cấp trợ lý AI mà bạn sử dụng.",
            "Chỉ gửi thông báo Telegram tới nhóm/kênh mà mọi thành viên đều được phép xem dữ liệu quảng cáo của đơn vị.",
            "Chỉ chia sẻ cho Hệ thống thư mục Google Drive / Google Sheet mà bạn được phép dùng và không chứa dữ liệu nhạy cảm: mọi file trong đó trợ lý AI có thể đọc qua MCP được cấp. Không thêm email của Hệ thống vào cả một Bộ nhớ dùng chung (Shared drive).",
            "Chỉ thêm token Apify của tài khoản Apify mà bạn hoặc đơn vị của bạn sở hữu hợp pháp, và tuân thủ điều khoản của Apify - kể cả quy định cấm một người tạo hoặc dùng nhiều tài khoản Apify cá nhân (Personal): không lập nhiều tài khoản để gom credit miễn phí.",
            "Chỉ dùng Apify để thu thập dữ liệu một cách hợp pháp: bạn tự chịu hoàn toàn trách nhiệm về việc thu thập và sử dụng dữ liệu, phải tuân thủ điều khoản sử dụng của trang đích (sàn thương mại điện tử, mạng xã hội, website…), quyền sở hữu trí tuệ và pháp luật về bảo vệ dữ liệu cá nhân (Luật Bảo vệ dữ liệu cá nhân, Nghị định 13/2023/NĐ-CP và các văn bản sửa đổi, thay thế); không thu thập dữ liệu cá nhân khi không có cơ sở hợp pháp, không thu thập nội dung cần đăng nhập.",
            "Không dùng Hệ thống cho quảng cáo trái pháp luật, lừa đảo, spam hoặc xâm phạm quyền của người khác.",
            "Không tìm cách vượt phân quyền, dò quét, tấn công hoặc làm quá tải Hệ thống.",
            "Không chia sẻ token, API key, bot token Telegram, token Apify hoặc đường dẫn MCP cho người không được phép."
          ),
        ],
      },
      {
        id: "trach-nhiem-chi-phi",
        title: "5. Chi phí quảng cáo và thao tác của trợ lý AI",
        blocks: [
          ul(
            "Mọi thay đổi trên tài khoản quảng cáo, kể cả thay đổi do trợ lý AI thực hiện qua MCP, đều dùng token hoặc API key do bạn cung cấp và có thể phát sinh chi phí thật. Bạn và đơn vị của bạn chịu trách nhiệm về ngân sách, chi tiêu và nội dung quảng cáo.",
            "Hệ thống có các lớp bảo vệ tuỳ chọn cho từng MCP (chế độ Tùy chỉnh nâng cao): xác nhận 2 bước cho thao tác ghi, giới hạn mức thay đổi ngân sách, trần ngân sách, giới hạn số thao tác, giới hạn địa chỉ IP; chế độ Cơ bản chỉ áp dụng thời hạn MCP (xoá và thay đổi TikTok GMV Max vẫn luôn cần xác nhận); quảng cáo tạo mới hoặc sao chép luôn ở trạng thái tạm dừng, trừ chiến dịch TikTok GMV Max (tạo mới hoặc sao chép sẽ chạy và tiêu tiền ngay, chỉ khi quản trị viên đã bật quyền thay đổi GMV Max cho MCP). Các lớp này giúp giảm rủi ro nhưng không thay thế việc bạn kiểm tra trước khi xác nhận và trước khi bật quảng cáo.",
            "Mỗi lần chạy Actor trên Apify (do bạn hoặc trợ lý AI yêu cầu) phát sinh chi phí tính vào tài khoản Apify của chủ token, kể cả token dùng chung công ty. Trần chi phí mỗi lần chạy và mỗi ngày của Hệ thống giúp giới hạn chi phí nhưng không thay thế giới hạn chi tiêu bạn nên đặt trong tài khoản Apify.",
            "Trợ lý AI có thể hiểu sai yêu cầu: hãy đọc kỹ bản xem trước trước khi xác nhận. Thao tác xoá không hoàn tác được."
          ),
        ],
      },
      {
        id: "ben-thu-ba",
        title: "6. Dịch vụ của bên thứ ba",
        blocks: [
          p(
            "Meta, TikTok, Google (gồm Google Drive, Google Sheets), OpenAI, Telegram, Apify và các trợ lý AI là dịch vụ độc lập với điều khoản riêng. Đơn vị vận hành không kiểm soát việc các nền tảng này thay đổi, giới hạn hoặc gián đoạn API của họ."
          ),
          p(
            "Actor trên Apify Store phần lớn do bên thứ ba phát triển và được cung cấp “nguyên trạng”; Apify, Đơn vị vận hành và noti.vn không bảo đảm chất lượng, độ đầy đủ, độ chính xác hay tính hợp pháp của dữ liệu Actor thu thập. Dữ liệu thu thập là dữ liệu của bên thứ ba, có thể sai hoặc lỗi thời; trợ lý AI có thể phân tích sai."
          ),
        ],
      },
      {
        id: "san-sang",
        title: "7. Tính sẵn sàng",
        blocks: [
          p(
            "Hệ thống được cung cấp “nguyên trạng” và “theo khả năng sẵn có”, không bảo đảm hoạt động liên tục, không có lỗi hoặc phù hợp với mọi mục đích. Hệ thống có thể tạm ngừng để bảo trì hoặc cập nhật."
          ),
        ],
      },
      {
        id: "gioi-han",
        title: "8. Giới hạn trách nhiệm",
        blocks: [
          p(
            "Trong phạm vi pháp luật cho phép, Đơn vị vận hành và noti.vn không chịu trách nhiệm cho thiệt hại gián tiếp, mất doanh thu hoặc lợi nhuận, chi phí quảng cáo phát sinh từ thao tác do người dùng hoặc trợ lý AI thực hiện, hay thiệt hại do gián đoạn của nền tảng bên thứ ba."
          ),
        ],
      },
      {
        id: "mien-tru",
        title: "9. Miễn trừ trách nhiệm khi kết nối và khi tạo MCP",
        blocks: [
          p(
            "Trước khi thêm kết nối (tài khoản quảng cáo, kênh Telegram, thư mục / sheet Google Drive, token Apify) và trước khi tạo MCP, Hệ thống hiển thị nội dung “Miễn trừ trách nhiệm”. Bạn phải đọc hết và xác nhận đồng ý thì mới bắt đầu được; Hệ thống ghi lại tài khoản của bạn, thời gian, địa chỉ IP, thiết bị và phiên bản nội dung bạn đã đồng ý."
          ),
          p(
            "Các nội dung miễn trừ trách nhiệm đó là một phần của Điều khoản này. Khi nội dung được cập nhật, bạn phải đọc và xác nhận lại phiên bản mới trước khi thêm kết nối hoặc tạo MCP."
          ),
        ],
      },
      {
        id: "tam-ngung",
        title: "10. Tạm ngừng và chấm dứt",
        blocks: [
          p(
            "Quản trị viên có thể khoá tài khoản, tắt hoặc xoay khoá đường dẫn MCP, xoá kết nối khi phát hiện vi phạm, rủi ro bảo mật, hoặc khi bạn không còn làm việc với đơn vị. Bạn có thể ngừng sử dụng bất cứ lúc nào bằng cách xoá kết nối và MCP của mình."
          ),
        ],
      },
      {
        id: "rieng-tu",
        title: "11. Quyền riêng tư",
        blocks: [
          p(
            `Việc xử lý dữ liệu tuân theo Chính sách quyền riêng tư tại ${c.baseUrl}/privacy.`
          ),
        ],
      },
      {
        id: "luat",
        title: "12. Luật áp dụng",
        blocks: [
          p(
            "Điều khoản này được điều chỉnh bởi pháp luật Việt Nam. Tranh chấp được ưu tiên giải quyết bằng thương lượng; nếu không thành, tranh chấp được đưa ra cơ quan có thẩm quyền tại Việt Nam."
          ),
        ],
      },
      {
        id: "thay-doi-dk",
        title: "13. Thay đổi điều khoản",
        blocks: [
          p(
            "Điều khoản có thể được cập nhật; ngày cập nhật gần nhất ghi ở đầu trang. Việc tiếp tục sử dụng Hệ thống sau khi thay đổi có hiệu lực đồng nghĩa với việc bạn chấp nhận điều khoản mới."
          ),
        ],
      },
      {
        id: "lien-he-dk",
        title: "14. Liên hệ",
        blocks: [
          p(`Câu hỏi về điều khoản, vui lòng liên hệ ${c.orgName}:`),
          contact,
        ],
      },
    ],
  }
}

function termsEn(c: LegalInfo): LegalDoc {
  return {
    title: "Terms of Service",
    intro: [
      `These terms apply when you access and use the Ads MCP system at ${c.domain} (the “System”), including through an MCP link in an AI assistant. By signing in or using an MCP link you agree to these terms.`,
    ],
    sections: [
      {
        id: "en-provider",
        title: "1. Service provider",
        blocks: [
          p(
            `The System is installed, managed and provided by ${c.orgName} (the “Operator”) to authorised staff. The Ads MCP software is developed and owned by noti.vn; noti.vn is not the provider of this service.`
          ),
        ],
      },
      {
        id: "en-license",
        title: "2. Software license",
        blocks: [
          p(
            "The software is licensed under noti.vn’s proprietary source-available license: only organisations authorised by noti.vn in writing may install and operate it, for internal purposes. Without such authorisation it may not be copied, distributed, sold, offered as a service to third parties, or stripped of its copyright notices, the noti.vn name or logos."
          ),
        ],
      },
      {
        id: "en-accounts",
        title: "3. Accounts and security",
        blocks: [
          ul(
            "Only administrators create accounts; there is no public sign-up.",
            "Keep your password, two-factor codes and MCP links secret. An MCP link works like an access key: anyone holding it can use the permissions granted to it.",
            "Tell an administrator immediately if you suspect a leak so the MCP key can be rotated, the token replaced or the account locked."
          ),
        ],
      },
      {
        id: "en-use",
        title: "4. Acceptable use",
        blocks: [
          ul(
            "Only connect ad accounts, Pages and Telegram groups/channels that you or your organisation are entitled to manage.",
            "Comply with Meta’s Terms and Advertising Standards, the TikTok and Google (including YouTube) advertising policies, the OpenAI Ads terms, Telegram’s terms and the terms of the AI assistant you use.",
            "Only send Telegram notifications to groups/channels whose members are all allowed to see the organisation’s advertising data.",
            "Only share Google Drive folders / Google Sheets with the System that you are allowed to use and that hold no sensitive data: the AI assistant can read every file in them through the MCP servers they are granted to. Do not add the System’s email to a whole shared drive.",
            "Only add Apify tokens of Apify accounts that you or your organisation lawfully own, and comply with Apify’s terms - including the rule that one person may not create or use multiple personal (Personal) Apify accounts: do not create several accounts to pool free credit.",
            "Only use Apify to collect data lawfully: you are solely responsible for collecting and using the data, and must comply with the terms of use of the target sites (marketplaces, social networks, websites…), intellectual property rights and personal data protection law (including Vietnam’s Law on Personal Data Protection and Decree 13/2023/ND-CP, as amended or replaced); do not collect personal data without a lawful basis, and do not collect content that requires logging in.",
            "Do not use the System for unlawful, deceptive or spam advertising or to infringe the rights of others.",
            "Do not attempt to bypass permissions, probe, attack or overload the System.",
            "Do not share tokens, API keys, Telegram bot tokens, Apify tokens or MCP links with unauthorised people."
          ),
        ],
      },
      {
        id: "en-spend",
        title: "5. Ad spend and AI-initiated actions",
        blocks: [
          ul(
            "Every change to an ad account, including changes made by an AI assistant through MCP, uses the token or API key you provided and may incur real costs. You and your organisation are responsible for budgets, spend and ad content.",
            "The System offers optional per-MCP safeguards (Advanced protection mode): two-step confirmation for write actions, budget change limits, budget caps, write-rate limits and an IP allowlist; Basic mode only applies the MCP expiry date (deletions and TikTok GMV Max changes still always require confirmation); newly created or copied ads always start paused, except TikTok GMV Max campaigns (a newly created or copied GMV Max campaign starts delivering and spending immediately, and only when an administrator has enabled GMV Max changes for the MCP). These reduce risk but do not replace your own review before confirming and before activating ads.",
            "Every Actor run on Apify (requested by you or an AI assistant) incurs costs charged to the token owner’s Apify account, including shared company tokens. The System’s per-run and daily cost caps help limit costs but do not replace the spending limit you should set in your Apify account.",
            "An AI assistant can misunderstand a request: read the preview carefully before confirming. Deletions cannot be undone."
          ),
        ],
      },
      {
        id: "en-third",
        title: "6. Third-party services",
        blocks: [
          p(
            "Meta, TikTok, Google (including Google Drive and Google Sheets), OpenAI, Telegram, Apify and AI assistants are independent services with their own terms. The Operator does not control changes, limits or outages of their APIs."
          ),
          p(
            "Actors on Apify Store are mostly developed by third parties and provided “as is”; Apify, the Operator and noti.vn do not guarantee the quality, completeness, accuracy or lawfulness of the data Actors collect. Collected data is third-party data and may be wrong or out of date; the AI assistant may analyse it incorrectly."
          ),
        ],
      },
      {
        id: "en-availability",
        title: "7. Availability",
        blocks: [
          p(
            "The System is provided “as is” and “as available”, without any warranty of uninterrupted or error-free operation or fitness for a particular purpose. It may be paused for maintenance or updates."
          ),
        ],
      },
      {
        id: "en-liability",
        title: "8. Limitation of liability",
        blocks: [
          p(
            "To the extent permitted by law, the Operator and noti.vn are not liable for indirect damages, lost revenue or profit, ad spend resulting from actions taken by users or AI assistants, or damages caused by third-party platform outages."
          ),
        ],
      },
      {
        id: "en-disclaimers",
        title: "9. In-app disclaimers for connections and MCP servers",
        blocks: [
          p(
            "Before adding a connection (ad account, Telegram channel, Google Drive folder / sheet, Apify token) and before creating an MCP server, the System shows a “Disclaimer” (in Vietnamese). You must read it to the end and confirm your agreement before you can continue; the System records your account, the time, IP address, device and the version of the text you accepted."
          ),
          p(
            "Those disclaimers form part of these terms. When a disclaimer is updated, you must read and accept the new version before adding a connection or creating an MCP server."
          ),
        ],
      },
      {
        id: "en-suspension",
        title: "10. Suspension and termination",
        blocks: [
          p(
            "Administrators may lock accounts, disable or rotate MCP links and delete connections in case of violations, security risks, or when you no longer work with the organisation. You may stop using the System at any time by deleting your connections and MCP servers."
          ),
        ],
      },
      {
        id: "en-privacy",
        title: "11. Privacy",
        blocks: [
          p(
            `Data is processed according to the Privacy Policy at ${c.baseUrl}/privacy.`
          ),
        ],
      },
      {
        id: "en-law",
        title: "12. Governing law",
        blocks: [
          p(
            "These terms are governed by the laws of Vietnam. Disputes shall first be resolved by negotiation; failing that, they shall be brought before the competent authorities of Vietnam."
          ),
        ],
      },
      {
        id: "en-changes-terms",
        title: "13. Changes",
        blocks: [
          p(
            "These terms may be updated; the last update date is shown at the top of the page. Continuing to use the System after a change takes effect means you accept the updated terms."
          ),
        ],
      },
      {
        id: "en-contact-terms",
        title: "14. Contact",
        blocks: [
          p(`For questions about these terms, please contact ${c.orgName}:`),
          contact,
        ],
      },
    ],
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Hướng dẫn xoá dữ liệu / Data Deletion Instructions
// ---------------------------------------------------------------------------------------------------------------

function dataDeletionVi(c: LegalInfo): LegalDoc {
  return {
    title: "Hướng dẫn xoá dữ liệu người dùng",
    intro: [
      `Trang này hướng dẫn cách xoá dữ liệu liên quan tới tài khoản Facebook (Meta), TikTok Ads, Google Ads (gồm quảng cáo YouTube), OpenAI Ads, kênh thông báo Telegram, thư mục Google Drive / Google Sheet hoặc token Apify đã được kết nối vào hệ thống Ads MCP tại ${c.domain} (“Hệ thống”), do ${c.orgName} (“Đơn vị vận hành”) vận hành.`,
    ],
    sections: [
      {
        id: "du-lieu-lien-quan",
        title: "1. Dữ liệu nào liên quan tới tài khoản Facebook của bạn",
        blocks: [
          p(
            "Hệ thống không dùng “Đăng nhập bằng Facebook”. Dữ liệu chỉ phát sinh khi một nhân sự dán access token Meta vào Hệ thống, gồm:"
          ),
          ul(
            "Access token (và App ID, App Secret nếu có), được lưu mã hoá.",
            "Danh sách tài khoản quảng cáo và Trang Facebook mà token truy cập được (tên, ID, tiền tệ, múi giờ, danh mục, ảnh đại diện, số người theo dõi).",
            "Nhật ký các lệnh đã chạy trên những tài khoản và Trang đó (thời gian, tham số, tóm tắt kết quả, địa chỉ IP)."
          ),
          p(
            "Chiến dịch, chỉ số quảng cáo, bài viết và chỉ số Trang được đọc trực tiếp từ Meta khi có yêu cầu và không được lưu thành kho dữ liệu riêng."
          ),
          p(
            "Với TikTok Ads, Google Ads (gồm YouTube) và OpenAI Ads, dữ liệu tương tự gồm: thông tin truy cập (access token, App ID/App Secret, refresh token hoặc khoá service account, API key) được lưu mã hoá, danh sách tài khoản quảng cáo và nhật ký lệnh. Với kênh thông báo Telegram: bot token được lưu mã hoá, chat ID, tên nhóm/kênh, ID chủ đề và nhật ký gửi tin."
          ),
          p(
            "Với Google Drive / Google Sheet: khoá service account và API key Google được lưu mã hoá, danh sách thư mục / sheet đã khai báo (mã, tên, cấu hình cột), mã file và mã media đã tải lên tài khoản quảng cáo, đường dẫn tạm và trạng thái các lượt tải video. File ảnh / video không được lưu trên máy chủ của Hệ thống."
          ),
          p(
            "Với Apify: token được lưu mã hoá, thông tin không bí mật của tài khoản Apify (mã, tên người dùng, gói, mức đã dùng) và lịch sử các lần chạy (giữ 90 ngày). Dữ liệu do Actor thu thập nằm trong tài khoản Apify của chủ token, không được lưu trên máy chủ của Hệ thống."
          ),
        ],
      },
      {
        id: "cach-1",
        title: "2. Cách 1: Tự xoá trong Hệ thống",
        blocks: [
          ol(
            "Đăng nhập Hệ thống, mở mục Kết nối.",
            "Chọn kết nối Meta (hoặc TikTok Ads, Google Ads, OpenAI Ads) cần xoá.",
            "Bấm Thêm → Xoá kết nối, rồi xác nhận."
          ),
          p(
            "Kênh Telegram: trong mục Kết nối, mở chế độ xem Telegram, chọn kênh cần xoá → Xoá, rồi xác nhận. Nhân viên xoá được kết nối và kênh do mình tạo; quản trị viên xoá được mọi kết nối và kênh. Quản trị viên cũng có thể khoá hoặc xoá tài khoản nhân sự ở mục Người dùng (nút Thao tác trên dòng của người đó → Khoá tài khoản hoặc Xoá người dùng)."
          ),
          p(
            "Google Drive: trong mục Kết nối, mở chế độ xem Google Drive, chọn thư mục / sheet → Xoá, rồi xác nhận (nguồn bị gỡ khỏi mọi MCP; file trên Google Drive không bị ảnh hưởng). Service account riêng xoá ở cùng chế độ xem; khoá service account và API key của hệ thống do quản trị viên xoá ở mục Cài đặt → Google Drive hệ thống."
          ),
          p(
            "Apify: trong mục Kết nối, mở chế độ xem Apify, chọn token → Xoá, rồi xác nhận (mọi MCP ngừng dùng token đó). Nhân viên xoá được token cá nhân của mình; token dùng chung công ty do quản trị viên xoá."
          ),
        ],
      },
      {
        id: "cach-2",
        title: "3. Cách 2: Gửi yêu cầu cho Đơn vị vận hành",
        blocks: [
          p(
            "Gửi email tới địa chỉ liên hệ bên dưới với tiêu đề “Yêu cầu xoá dữ liệu”, kèm theo:"
          ),
          ul(
            "Tên hoặc ID tài khoản Facebook, ID tài khoản quảng cáo và ID Trang liên quan; hoặc ID nhà quảng cáo TikTok (advertiser ID), ID khách hàng Google Ads (customer ID), ID tài khoản OpenAI Ads; hoặc tên kênh Telegram và chat ID; hoặc tên token Apify và tên người dùng Apify.",
            "Email tài khoản của bạn trong Hệ thống (nếu có).",
            "Phạm vi dữ liệu muốn xoá."
          ),
          p(
            "Chúng tôi có thể đề nghị bạn xác minh quyền sở hữu tài khoản trước khi xử lý. Yêu cầu được xử lý trong tối đa 30 ngày và bạn sẽ nhận email xác nhận khi hoàn tất."
          ),
          contact,
        ],
      },
      {
        id: "cach-3",
        title: "4. Cách 3: Gỡ quyền truy cập ngay từ nền tảng",
        blocks: [
          ul(
            "Facebook: vào Cài đặt & quyền riêng tư → Cài đặt → Ứng dụng và trang web (hoặc Tích hợp doanh nghiệp), chọn ứng dụng đã cấp quyền → Gỡ. Tên mục có thể khác nhau theo phiên bản Facebook; có thể mở trực tiếp facebook.com/settings?tab=applications.",
            "Token của Người dùng hệ thống (System User): trong Meta Business Suite → Cài đặt doanh nghiệp → Người dùng hệ thống, thu hồi token hoặc gỡ tài sản đã gán.",
            "TikTok Ads: đăng nhập TikTok For Business, mở phần cài đặt uỷ quyền (Business Center → Settings → Authorizations, hoặc trang quản lý ứng dụng nhà phát triển), chọn ứng dụng đã được uỷ quyền → Remove (Gỡ).",
            "Google Ads (gồm YouTube): nếu kết nối dùng OAuth + refresh token, vào Tài khoản Google → Bảo mật → Quyền truy cập của bên thứ ba (myaccount.google.com/permissions), chọn ứng dụng → Xoá quyền truy cập. Nếu kết nối dùng service account, xoá email service account khỏi Quản trị → Quyền truy cập và bảo mật → Người dùng trong Google Ads (và có thể xoá khoá của service account trong Google Cloud).",
            "OpenAI Ads: thu hồi (revoke) API key trong trang quản lý OpenAI Ads.",
            "Telegram: mở @BotFather, gửi lệnh /revoke và chọn bot để vô hiệu hoá bot token; hoặc gỡ bot khỏi nhóm/kênh nhận thông báo.",
            "Google Drive / Google Sheet: trên Google Drive mở thư mục / sheet → Chia sẻ → xoá email service account của Hệ thống; quản trị viên có thể xoá khoá của service account (Google Cloud → IAM & Admin → Service accounts → Keys) và API key (APIs & Services → Credentials).",
            "Apify: đăng nhập Apify Console → Settings → API & Integrations, xoá hoặc đổi (rotate) token đã dán vào Hệ thống. Đầu vào và kết quả các lần chạy nằm trong tài khoản Apify (mục Runs / Storage), bạn tự xoá ở đó."
          ),
          p(
            "Sau khi gỡ, token không còn dùng được: Hệ thống không truy cập được dữ liệu của bạn nữa (hoặc không gửi được tin Telegram) và lần kiểm tra kế tiếp sẽ đánh dấu kết nối hoặc kênh bị lỗi. Để xoá cả dữ liệu đã lưu trong Hệ thống, làm thêm Cách 1 hoặc Cách 2."
          ),
        ],
      },
      {
        id: "xoa-giu",
        title: "5. Dữ liệu nào bị xoá, dữ liệu nào được giữ lại",
        blocks: [
          ul(
            "Xoá ngay khi xoá kết nối: token hoặc API key (bản mã hoá bị ghi đè bằng dữ liệu rỗng). Kết nối biến mất khỏi giao diện và mọi MCP mất quyền truy cập các tài khoản, Trang của kết nối đó.",
            "Tên kết nối và danh sách tài khoản quảng cáo, Trang đã đồng bộ được giữ ở trạng thái ẩn cùng bản ghi kết nối đã xoá để đối chiếu nhật ký. Khi bạn gửi yêu cầu theo Cách 2, Đơn vị vận hành xoá hẳn phần dữ liệu này.",
            `Nhật ký MCP và nhật ký nhân sự là nhật ký kiểm toán chỉ ghi thêm, được giữ tới hết thời hạn lưu (lần lượt ${c.retentionMcpMonths} và ${c.retentionStaffMonths} tháng cộng tháng hiện tại) vì lý do bảo mật và pháp lý, sau đó tự động bị xoá vĩnh viễn. Nhật ký không chứa token hay API key.`,
            "Kênh Telegram đã xoá: Hệ thống ngừng gửi tin ngay. Nhật ký gửi tin được giữ theo thời hạn của nhật ký MCP rồi tự động bị xoá.",
            "Thư mục / sheet Google Drive đã xoá: bị gỡ khỏi mọi MCP ngay, Hệ thống không đọc nữa. Khoá service account và API key bị xoá khỏi Hệ thống khi quản trị viên xoá thông tin xác thực. Đường dẫn tạm cho video bị xoá sau 24 giờ kể từ khi hết hạn, lượt tải video nền sau 30 ngày; mã media đã tải lên được giữ tới khi tài khoản quảng cáo bị xoá khỏi Hệ thống.",
            "Token Apify đã xoá: bản mã hoá bị ghi đè ngay, mọi MCP ngừng dùng token đó. Lịch sử lần chạy được giữ 90 ngày rồi tự động bị xoá.",
            "Dữ liệu nằm trên Meta, TikTok, Google (kể cả file trên Google Drive và nội dung Google Sheet), OpenAI, Telegram (kể cả tin nhắn đã gửi vào nhóm/kênh) hoặc Apify (kể cả đầu vào và kết quả các lần chạy) do các nền tảng đó quản lý; xoá trong Hệ thống không xoá dữ liệu trên nền tảng."
          ),
        ],
      },
    ],
  }
}

function dataDeletionEn(c: LegalInfo): LegalDoc {
  return {
    title: "Data Deletion Instructions",
    intro: [
      `This page explains how to delete data related to a Facebook (Meta), TikTok Ads, Google Ads (including YouTube ads) or OpenAI Ads account, a Telegram notification channel, a Google Drive folder / Google Sheet, or an Apify token, connected to the Ads MCP system at ${c.domain} (the “System”), operated by ${c.orgName} (the “Operator”).`,
    ],
    sections: [
      {
        id: "en-linked-data",
        title: "1. What data relates to your Facebook account",
        blocks: [
          p(
            "The System does not use “Login with Facebook”. Data only exists when a staff member pastes a Meta access token into the System:"
          ),
          ul(
            "The access token (and App ID, App Secret if provided), stored encrypted.",
            "The list of ad accounts and Facebook Pages the token can access (name, ID, currency, time zone, category, profile picture, follower count).",
            "Logs of the requests run on those accounts and Pages (time, parameters, result summary, IP address)."
          ),
          p(
            "Campaigns, ad metrics, Page posts and Page insights are read directly from Meta on request and are not kept as a separate data store."
          ),
          p(
            "For TikTok Ads, Google Ads (including YouTube) and OpenAI Ads the data is similar: credentials (access token, App ID/App Secret, refresh token or service account key, API key) stored encrypted, the list of ad accounts, and request logs. For a Telegram notification channel: the bot token stored encrypted, chat ID, group/channel title, topic ID and the delivery log."
          ),
          p(
            "For Google Drive / Google Sheets: the Google service account key and API key stored encrypted, the list of registered folders / sheets (ID, name, column mapping), the file IDs and media IDs already uploaded to ad accounts, temporary links and the status of video uploads. Image / video files are not stored on the System’s server."
          ),
          p(
            "For Apify: the token stored encrypted, non-secret Apify account information (ID, username, plan, usage) and the run history (kept for 90 days). Data collected by Actors stays in the token owner’s Apify account and is not stored on the System’s server."
          ),
        ],
      },
      {
        id: "en-option-1",
        title: "2. Option 1: Delete it yourself in the System",
        blocks: [
          ol(
            "Sign in to the System and open Kết nối (Connections).",
            "Select the Meta (or TikTok Ads, Google Ads, OpenAI Ads) connection to delete.",
            "Click Thêm (More) → Xoá kết nối (Delete connection) and confirm."
          ),
          p(
            "Telegram channels: in Kết nối (Connections), switch to the Telegram view, select the channel → Xoá (Delete) and confirm. Staff can delete the connections and channels they created; administrators can delete any connection or channel. Administrators can also lock or delete staff accounts under Người dùng (Users): the actions button on the person’s row → Khoá tài khoản (Lock account) or Xoá người dùng (Delete user)."
          ),
          p(
            "Google Drive: in Kết nối (Connections), switch to the Google Drive view, select the folder / sheet → Xoá (Delete) and confirm (it is removed from every MCP server; files on Google Drive are not affected). Personal service accounts are deleted in the same view; the system service account key and API key are deleted by an administrator under Cài đặt (Settings) → Google Drive hệ thống (System Google Drive)."
          ),
          p(
            "Apify: in Kết nối (Connections), switch to the Apify view, select the token → Xoá (Delete) and confirm (every MCP server stops using it). Staff can delete their own personal tokens; shared company tokens are deleted by administrators."
          ),
        ],
      },
      {
        id: "en-option-2",
        title: "3. Option 2: Send a request to the Operator",
        blocks: [
          p(
            "Email the contact address below with the subject “Data deletion request” (“Yêu cầu xoá dữ liệu”), including:"
          ),
          ul(
            "Your Facebook account name or ID, the related ad account IDs and Page IDs; or your TikTok advertiser ID, Google Ads customer ID or OpenAI Ads account ID; or the Telegram channel name and chat ID; or the Apify token name and Apify username.",
            "Your account email in the System (if any).",
            "What data you want deleted."
          ),
          p(
            "We may ask you to verify that you own the account before processing. Requests are completed within 30 days and you will receive a confirmation email when done."
          ),
          contact,
        ],
      },
      {
        id: "en-option-3",
        title: "4. Option 3: Revoke access on the platform",
        blocks: [
          ul(
            "Facebook: go to Settings & privacy → Settings → Apps and websites (or Business integrations), select the app you granted access to → Remove. Menu names may vary between Facebook versions; you can also open facebook.com/settings?tab=applications directly.",
            "System User tokens: in Meta Business Suite → Business settings → System users, revoke the token or remove the assigned assets.",
            "TikTok Ads: sign in to TikTok For Business, open the authorization settings (Business Center → Settings → Authorizations, or your developer app management page), select the authorized app → Remove.",
            "Google Ads (including YouTube): if the connection uses OAuth with a refresh token, go to Google Account → Security → Third-party access (myaccount.google.com/permissions), select the app → Remove access. If it uses a service account, remove the service account email under Admin → Access and security → Users in Google Ads (and optionally delete the service account key in Google Cloud).",
            "OpenAI Ads: revoke the API key in the OpenAI Ads dashboard.",
            "Telegram: open @BotFather, send /revoke and pick the bot to invalidate its token; or remove the bot from the notification group/channel.",
            "Google Drive / Google Sheets: in Google Drive open the folder / sheet → Share → remove the System’s service account email; administrators can delete the service account key (Google Cloud → IAM & Admin → Service accounts → Keys) and the API key (APIs & Services → Credentials).",
            "Apify: sign in to Apify Console → Settings → API & Integrations and delete or rotate the token you pasted into the System. Run inputs and results are kept in your Apify account (Runs / Storage); delete them there."
          ),
          p(
            "Once revoked, the token stops working: the System can no longer access your data (or send Telegram messages) and the next check marks the connection or channel as failed. To also delete the data stored in the System, use Option 1 or Option 2."
          ),
        ],
      },
      {
        id: "en-deleted-kept",
        title: "5. What is deleted and what is kept",
        blocks: [
          ul(
            "Deleted immediately when a connection is deleted: the token or API key (its encrypted value is overwritten with empty data). The connection disappears from the interface and every MCP server loses access to its accounts and Pages.",
            "The connection name and the synced list of ad accounts and Pages are kept hidden with the deleted connection record to keep logs consistent. When you send a request under Option 2, the Operator deletes this data permanently.",
            `MCP logs and staff activity logs are append-only audit logs kept until their retention period ends (${c.retentionMcpMonths} and ${c.retentionStaffMonths} month${c.retentionStaffMonths === 1 ? "" : "s"} respectively, plus the current month) for security and legal reasons, then deleted permanently and automatically. Logs never contain tokens or API keys.`,
            "Deleted Telegram channels: the System stops sending messages immediately. The delivery log is kept for the MCP log retention period, then deleted automatically.",
            "Deleted Google Drive folders / sheets: removed from every MCP server immediately and no longer read. The service account key and API key are deleted from the System when an administrator deletes the credentials. Temporary video links are deleted 24 hours after they expire and background video uploads after 30 days; uploaded media IDs are kept until the ad account is removed from the System.",
            "Deleted Apify tokens: the encrypted value is overwritten immediately and every MCP server stops using it. The run history is kept for 90 days, then deleted automatically.",
            "Data held by Meta, TikTok, Google (including files on Google Drive and Google Sheets content), OpenAI, Telegram (including messages already sent to a group/channel) or Apify (including the input and results of runs) is managed by those platforms; deleting data in the System does not delete it on the platform."
          ),
        ],
      },
    ],
  }
}

export const legal = {
  /** <title> of each page (root template adds " · Ads MCP") */
  metaTitle: {
    privacy: "Chính sách quyền riêng tư",
    terms: "Điều khoản dịch vụ",
    dataDeletion: "Hướng dẫn xoá dữ liệu",
  },
  metaDescription: {
    privacy: "Chính sách quyền riêng tư của hệ thống Ads MCP (Privacy Policy).",
    terms: "Điều khoản dịch vụ của hệ thống Ads MCP (Terms of Service).",
    dataDeletion:
      "Hướng dẫn xoá dữ liệu người dùng của hệ thống Ads MCP (Data Deletion Instructions).",
  },
  /** short names: page nav, sidebar rows, mobile menu */
  nav: {
    label: "Trang chính sách",
    footerLabel: "Liên kết chính sách",
    privacy: "Quyền riêng tư",
    terms: "Điều khoản",
    dataDeletion: "Xoá dữ liệu",
  },
  updatedAt: "14/10/2026",
  updatedAtIso: "2026-10-14",
  updatedAtEn: "October 14, 2026",
  /** prefilled subject of the mailto link on /data-deletion */
  deletionMailSubject: "Yêu cầu xoá dữ liệu",
  updatedLabel: { vi: "Cập nhật lần cuối", en: "Last updated" },
  operatorLabel: { vi: "Đơn vị vận hành", en: "Operator" },
  /** jump link under the title + eyebrow above the English part */
  englishJump: "English version",
  englishHeading: "English version",
  contact: {
    vi: {
      label: "Email",
      fallback: (domain: string) => `quản trị viên hệ thống tại ${domain}`,
    },
    en: {
      label: "Email",
      fallback: (domain: string) => `the system administrator at ${domain}`,
    },
  },
  footer: "Ads MCP by: noti.vn",
  docs: {
    privacy: { vi: privacyVi, en: privacyEn },
    terms: { vi: termsVi, en: termsEn },
    dataDeletion: { vi: dataDeletionVi, en: dataDeletionEn },
  },

  /** sidebar footer block + phone "Menu" sheet + command palette */
  links: {
    title: "Liên kết cho ứng dụng",
    open: (name: string) => `Mở trang ${name} trong tab mới`,
    copy: (name: string) => `Sao chép liên kết ${name}`,
    copied: "Đã sao chép liên kết",
    paletteGroup: "Trang chính sách",
  },
} as const
