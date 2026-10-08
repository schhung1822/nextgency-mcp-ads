// Chuỗi giao diện - nhóm "legal": 3 trang công khai /privacy, /terms, /data-deletion (tiếng Việt trước, bản tiếng
// Anh cho người duyệt app của Meta/TikTok/Google/OpenAI ở cuối trang) + khối "Liên kết cho ứng dụng" ở sidebar.
// Nội dung phải khớp hệ thống thật (01-product-spec, 05-security, 11-meta-pages, 14-telegram-notifications,
// services/connections.ts).
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
            "Sự đồng ý của người dùng: người dùng chủ động kết nối tài khoản quảng cáo, Trang, kênh Telegram và cấp quyền cho token; có thể rút lại bất cứ lúc nào (mục 8).",
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
            "Token, API key, khoá service account, bot token Telegram và đường dẫn MCP được mã hoá AES-256-GCM; khoá mã hoá được giữ tách khỏi cơ sở dữ liệu.",
            "Mật khẩu được băm một chiều; hỗ trợ xác thực 2 bước (TOTP); tạm khoá khi nhập sai nhiều lần.",
            "Phân quyền theo vai trò Quản trị viên / Nhân viên; nhân viên chỉ thấy kết nối, kênh Telegram và MCP của chính mình.",
            "Thao tác ghi do trợ lý AI đề xuất có thể yêu cầu xác nhận 2 bước và bị giới hạn ngân sách; quảng cáo tạo mới hoặc sao chép luôn ở trạng thái tạm dừng.",
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
            "Rút lại quyền truy cập: xoá kết nối trong Hệ thống, thu hồi token hoặc API key, hoặc gỡ ứng dụng khỏi tài khoản Facebook, TikTok For Business hay tài khoản Google. Sau đó Hệ thống không truy cập được dữ liệu nền tảng của bạn nữa. Với Telegram: xoá kênh thông báo trong Hệ thống và/hoặc thu hồi bot token bằng @BotFather (lệnh /revoke).",
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
            "User consent: users choose to connect ad accounts, Pages and Telegram channels and to grant permissions to their token, and can withdraw at any time (section 8).",
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
            "Tokens, API keys, service account keys, Telegram bot tokens and MCP links are encrypted with AES-256-GCM; encryption keys are kept separate from the database.",
            "Passwords are hashed; two-factor authentication (TOTP) is supported; repeated wrong attempts trigger a temporary lock.",
            "Role-based access (Administrator / Staff); staff only see their own connections, Telegram channels and MCP servers.",
            "Write actions proposed by an AI assistant can require two-step confirmation and are subject to budget limits; newly created or copied ads always start paused.",
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
            "Withdraw access: delete the connection in the System, revoke the token or API key, or remove the app from your Facebook account, TikTok For Business or Google account. The System can then no longer access your platform data. For Telegram: delete the notification channel in the System and/or revoke the bot token with @BotFather (the /revoke command).",
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
            "Không dùng Hệ thống cho quảng cáo trái pháp luật, lừa đảo, spam hoặc xâm phạm quyền của người khác.",
            "Không tìm cách vượt phân quyền, dò quét, tấn công hoặc làm quá tải Hệ thống.",
            "Không chia sẻ token, API key, bot token Telegram hoặc đường dẫn MCP cho người không được phép."
          ),
        ],
      },
      {
        id: "trach-nhiem-chi-phi",
        title: "5. Chi phí quảng cáo và thao tác của trợ lý AI",
        blocks: [
          ul(
            "Mọi thay đổi trên tài khoản quảng cáo, kể cả thay đổi do trợ lý AI thực hiện qua MCP, đều dùng token hoặc API key do bạn cung cấp và có thể phát sinh chi phí thật. Bạn và đơn vị của bạn chịu trách nhiệm về ngân sách, chi tiêu và nội dung quảng cáo.",
            "Hệ thống có các lớp bảo vệ: xác nhận 2 bước cho thao tác ghi (khi bật), giới hạn mức thay đổi ngân sách, trần ngân sách, giới hạn số thao tác; quảng cáo tạo mới hoặc sao chép luôn ở trạng thái tạm dừng. Các lớp này giúp giảm rủi ro nhưng không thay thế việc bạn kiểm tra trước khi xác nhận và trước khi bật quảng cáo.",
            "Trợ lý AI có thể hiểu sai yêu cầu: hãy đọc kỹ bản xem trước trước khi xác nhận. Thao tác xoá không hoàn tác được."
          ),
        ],
      },
      {
        id: "ben-thu-ba",
        title: "6. Dịch vụ của bên thứ ba",
        blocks: [
          p(
            "Meta, TikTok, Google, OpenAI, Telegram và các trợ lý AI là dịch vụ độc lập với điều khoản riêng. Đơn vị vận hành không kiểm soát việc các nền tảng này thay đổi, giới hạn hoặc gián đoạn API của họ."
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
        id: "tam-ngung",
        title: "9. Tạm ngừng và chấm dứt",
        blocks: [
          p(
            "Quản trị viên có thể khoá tài khoản, tắt hoặc xoay khoá đường dẫn MCP, xoá kết nối khi phát hiện vi phạm, rủi ro bảo mật, hoặc khi bạn không còn làm việc với đơn vị. Bạn có thể ngừng sử dụng bất cứ lúc nào bằng cách xoá kết nối và MCP của mình."
          ),
        ],
      },
      {
        id: "rieng-tu",
        title: "10. Quyền riêng tư",
        blocks: [
          p(
            `Việc xử lý dữ liệu tuân theo Chính sách quyền riêng tư tại ${c.baseUrl}/privacy.`
          ),
        ],
      },
      {
        id: "luat",
        title: "11. Luật áp dụng",
        blocks: [
          p(
            "Điều khoản này được điều chỉnh bởi pháp luật Việt Nam. Tranh chấp được ưu tiên giải quyết bằng thương lượng; nếu không thành, tranh chấp được đưa ra cơ quan có thẩm quyền tại Việt Nam."
          ),
        ],
      },
      {
        id: "thay-doi-dk",
        title: "12. Thay đổi điều khoản",
        blocks: [
          p(
            "Điều khoản có thể được cập nhật; ngày cập nhật gần nhất ghi ở đầu trang. Việc tiếp tục sử dụng Hệ thống sau khi thay đổi có hiệu lực đồng nghĩa với việc bạn chấp nhận điều khoản mới."
          ),
        ],
      },
      {
        id: "lien-he-dk",
        title: "13. Liên hệ",
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
            "Do not use the System for unlawful, deceptive or spam advertising or to infringe the rights of others.",
            "Do not attempt to bypass permissions, probe, attack or overload the System.",
            "Do not share tokens, API keys, Telegram bot tokens or MCP links with unauthorised people."
          ),
        ],
      },
      {
        id: "en-spend",
        title: "5. Ad spend and AI-initiated actions",
        blocks: [
          ul(
            "Every change to an ad account, including changes made by an AI assistant through MCP, uses the token or API key you provided and may incur real costs. You and your organisation are responsible for budgets, spend and ad content.",
            "The System adds safeguards: two-step confirmation for write actions (when enabled), budget change limits, budget caps and write-rate limits; newly created or copied ads always start paused. These reduce risk but do not replace your own review before confirming and before activating ads.",
            "An AI assistant can misunderstand a request: read the preview carefully before confirming. Deletions cannot be undone."
          ),
        ],
      },
      {
        id: "en-third",
        title: "6. Third-party services",
        blocks: [
          p(
            "Meta, TikTok, Google, OpenAI, Telegram and AI assistants are independent services with their own terms. The Operator does not control changes, limits or outages of their APIs."
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
        id: "en-suspension",
        title: "9. Suspension and termination",
        blocks: [
          p(
            "Administrators may lock accounts, disable or rotate MCP links and delete connections in case of violations, security risks, or when you no longer work with the organisation. You may stop using the System at any time by deleting your connections and MCP servers."
          ),
        ],
      },
      {
        id: "en-privacy",
        title: "10. Privacy",
        blocks: [
          p(
            `Data is processed according to the Privacy Policy at ${c.baseUrl}/privacy.`
          ),
        ],
      },
      {
        id: "en-law",
        title: "11. Governing law",
        blocks: [
          p(
            "These terms are governed by the laws of Vietnam. Disputes shall first be resolved by negotiation; failing that, they shall be brought before the competent authorities of Vietnam."
          ),
        ],
      },
      {
        id: "en-changes-terms",
        title: "12. Changes",
        blocks: [
          p(
            "These terms may be updated; the last update date is shown at the top of the page. Continuing to use the System after a change takes effect means you accept the updated terms."
          ),
        ],
      },
      {
        id: "en-contact-terms",
        title: "13. Contact",
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
      `Trang này hướng dẫn cách xoá dữ liệu liên quan tới tài khoản Facebook (Meta), TikTok Ads, Google Ads (gồm quảng cáo YouTube), OpenAI Ads hoặc kênh thông báo Telegram đã được kết nối vào hệ thống Ads MCP tại ${c.domain} (“Hệ thống”), do ${c.orgName} (“Đơn vị vận hành”) vận hành.`,
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
        ],
      },
      {
        id: "cach-1",
        title: "2. Cách 1: Tự xoá trong Hệ thống",
        blocks: [
          ol(
            "Đăng nhập Hệ thống, mở mục Kết nối quảng cáo.",
            "Chọn kết nối Meta (hoặc TikTok Ads, Google Ads, OpenAI Ads) cần xoá.",
            "Bấm Thêm → Xoá kết nối, rồi xác nhận."
          ),
          p(
            "Kênh Telegram: trong mục Kết nối quảng cáo, mở chế độ xem Telegram, chọn kênh cần xoá → Xoá, rồi xác nhận. Nhân viên xoá được kết nối và kênh do mình tạo; quản trị viên xoá được mọi kết nối và kênh. Quản trị viên cũng có thể khoá hoặc xoá tài khoản nhân sự ở mục Người dùng (nút Thao tác trên dòng của người đó → Khoá tài khoản hoặc Xoá người dùng)."
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
            "Tên hoặc ID tài khoản Facebook, ID tài khoản quảng cáo và ID Trang liên quan; hoặc ID nhà quảng cáo TikTok (advertiser ID), ID khách hàng Google Ads (customer ID), ID tài khoản OpenAI Ads; hoặc tên kênh Telegram và chat ID.",
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
            "Telegram: mở @BotFather, gửi lệnh /revoke và chọn bot để vô hiệu hoá bot token; hoặc gỡ bot khỏi nhóm/kênh nhận thông báo."
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
            "Dữ liệu nằm trên Meta, TikTok, Google, OpenAI hoặc Telegram (kể cả tin nhắn đã gửi vào nhóm/kênh) do các nền tảng đó quản lý; xoá trong Hệ thống không xoá dữ liệu trên nền tảng."
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
      `This page explains how to delete data related to a Facebook (Meta), TikTok Ads, Google Ads (including YouTube ads) or OpenAI Ads account, or a Telegram notification channel, connected to the Ads MCP system at ${c.domain} (the “System”), operated by ${c.orgName} (the “Operator”).`,
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
        ],
      },
      {
        id: "en-option-1",
        title: "2. Option 1: Delete it yourself in the System",
        blocks: [
          ol(
            "Sign in to the System and open Kết nối quảng cáo (Ad connections).",
            "Select the Meta (or TikTok Ads, Google Ads, OpenAI Ads) connection to delete.",
            "Click Thêm (More) → Xoá kết nối (Delete connection) and confirm."
          ),
          p(
            "Telegram channels: in Kết nối quảng cáo (Ad connections), switch to the Telegram view, select the channel → Xoá (Delete) and confirm. Staff can delete the connections and channels they created; administrators can delete any connection or channel. Administrators can also lock or delete staff accounts under Người dùng (Users): the actions button on the person’s row → Khoá tài khoản (Lock account) or Xoá người dùng (Delete user)."
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
            "Your Facebook account name or ID, the related ad account IDs and Page IDs; or your TikTok advertiser ID, Google Ads customer ID or OpenAI Ads account ID; or the Telegram channel name and chat ID.",
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
            "Telegram: open @BotFather, send /revoke and pick the bot to invalidate its token; or remove the bot from the notification group/channel."
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
            "Data held by Meta, TikTok, Google, OpenAI or Telegram (including messages already sent to a group/channel) is managed by those platforms; deleting data in the System does not delete it on the platform."
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
  updatedAt: "08/10/2026",
  updatedAtIso: "2026-10-08",
  updatedAtEn: "October 8, 2026",
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
