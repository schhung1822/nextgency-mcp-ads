// Chuỗi giao diện - nhóm "disclaimers": popup "Miễn trừ trách nhiệm" bắt buộc đọc + xác nhận trước khi thêm kết nối
// (quảng cáo, Telegram, Google Drive, Apify) và trước khi tạo MCP. Logic chặn: src/lib/disclaimers.ts; ghi nhận + kiểm tra
// phía máy chủ: src/server/services/disclaimers.ts (activity_logs `legal.disclaimer_accept`).
//
// SỬA NỘI DUNG `docs.*` = PHẢI tăng DISCLAIMER_VERSIONS trong src/lib/disclaimers.ts (mọi người xác nhận lại) và cập
// nhật mã băm trong src/lib/disclaimers.test.ts. Vai trò và cách gọi tên khớp Điều khoản dịch vụ / Chính sách quyền
// riêng tư (src/lib/i18n/vi/legal.ts): "Hệ thống", "Đơn vị vận hành" (bên kiểm soát dữ liệu), noti.vn = nhà phát triển.
// Đánh dấu `**đậm**` được hiển thị bằng <Rich>.
import type { DisclaimerKind } from "@/lib/disclaimers"

export interface DisclaimerSection {
  id: string
  title: string
  paragraphs?: string[]
  items?: string[]
}

export interface DisclaimerDoc {
  title: string
  /** one sentence under the title (dialog description) */
  summary: string
  intro: string[]
  sections: DisclaimerSection[]
  /** last paragraph, right above the end of the scroll region */
  closing: string
}

// ---------------------------------------------------------------------------------------------------------------
// K1 - trước khi thêm kết nối (tài khoản quảng cáo, Trang, TikTok Shop, Telegram, Google Drive / Google Sheet, Apify)
// ---------------------------------------------------------------------------------------------------------------

const connection: DisclaimerDoc = {
  title: "Miễn trừ trách nhiệm - vui lòng đọc kỹ trước khi kết nối",
  summary:
    "Đọc hết nội dung bên dưới, đánh dấu đồng ý rồi mới bắt đầu thêm kết nối.",
  intro: [
    "Bạn sắp kết nối tài khoản quảng cáo, Trang Facebook, cửa hàng TikTok Shop, bot Telegram, thư mục / sheet Google Drive hoặc token Apify vào hệ thống Ads MCP Simple by noti.vn (“Hệ thống”). Hệ thống do **Đơn vị vận hành** - tổ chức đã cài đặt và quản trị Hệ thống này, là bên kiểm soát dữ liệu - cung cấp cho nhân sự được cấp quyền. Phần mềm Ads MCP Simple by noti.vn do **noti.vn** phát triển; noti.vn không vận hành Hệ thống này và không truy cập dữ liệu của Hệ thống.",
    "Nội dung dưới đây là một phần của Điều khoản dịch vụ và Chính sách quyền riêng tư của Hệ thống. Bạn chỉ có thể bắt đầu kết nối sau khi đã đọc hết và xác nhận đồng ý.",
  ],
  sections: [
    {
      id: "quyen-hop-phap",
      title: "1. Bạn phải có quyền hợp pháp",
      items: [
        "Bạn cam kết **là chủ sở hữu hoặc được uỷ quyền hợp lệ** để quản lý tài khoản quảng cáo, Trang Facebook, cửa hàng TikTok Shop, bot và nhóm / kênh Telegram, thư mục / sheet Google Drive, tài khoản Apify mà bạn kết nối, và được phép cho Hệ thống truy cập chúng thay mặt bạn hoặc đơn vị của bạn.",
        "Không kết nối tài sản của người khác khi chưa có sự đồng ý rõ ràng của họ. Không dùng Hệ thống cho quảng cáo trái pháp luật, gian dối, spam hoặc xâm phạm quyền của người khác.",
        "Bạn tự chịu trách nhiệm tuân thủ điều khoản, chính sách quảng cáo và chính sách dành cho nhà phát triển của **Meta, TikTok, Google** (gồm YouTube, Google Drive, Google Sheets), **OpenAI, Telegram, Apify**, cùng pháp luật Việt Nam về quảng cáo, thương mại điện tử và bảo vệ dữ liệu cá nhân.",
      ],
    },
    {
      id: "token",
      title: "2. Token, khoá truy cập và quyền của ứng dụng",
      items: [
        "Access token, App Secret, refresh token, khoá service account, API key, bot token và token Apify mà bạn nhập **cấp quyền rất rộng, kể cả quyền tạo, sửa, bật quảng cáo và chi tiêu ngân sách thật**. Ai có được chúng có thể làm mọi việc mà chúng cho phép, kể cả bên ngoài Hệ thống.",
        "Hệ thống mã hoá các thông tin này (AES-256-GCM), không hiển thị lại, không ghi vào nhật ký và không gửi cho trợ lý AI, nhưng **không có biện pháp kỹ thuật nào an toàn tuyệt đối**.",
        "Bạn tự bảo vệ tài khoản đăng nhập Hệ thống (mật khẩu mạnh, bật xác thực 2 bước), không chia sẻ token cho người khác và **thu hồi token ngay trên nền tảng** (đồng thời báo quản trị viên) khi nghi bị lộ.",
        "**Chỉ cấp cho ứng dụng nhà phát triển (developer app) những quyền tối thiểu cần thiết.** Với TikTok: chỉ tick các nhóm quyền theo hướng dẫn kết nối; **không cấp quyền GMV MAX → Session và GMV MAX → Exclusive Authorization** - Hệ thống không dùng 2 quyền này, và nếu token bị lộ, Exclusive Authorization cho phép chuyển tài khoản GMV Max của cửa hàng sang nơi khác (làm tạm dừng mọi chiến dịch GMV Max của tài khoản cũ).",
      ],
    },
    {
      id: "chi-phi",
      title: "3. Chi phí và kết quả quảng cáo",
      items: [
        "**Mọi chi phí phát sinh trên nền tảng quảng cáo do chủ tài khoản quảng cáo chịu**, kể cả chi phí phát sinh từ thao tác của bạn, của đồng nghiệp hoặc của trợ lý AI dùng kết nối này qua MCP.",
        "Hệ thống, Đơn vị vận hành và noti.vn **không cam kết hiệu quả, doanh thu, đơn hàng hay ROI** của bất kỳ quảng cáo nào.",
        "Với **TikTok GMV Max**: chiến dịch được TikTok tự tối ưu theo doanh thu cửa hàng. Tạm dừng, xoá, sửa ROI mục tiêu hoặc sửa sản phẩm trong ngày làm **mất Bảo vệ ROI (tín dụng quảng cáo) của ngày đó**; bật một chiến dịch có thể tự tạm dừng quảng cáo Shop khác dùng cùng cửa hàng, sản phẩm. Chiến dịch GMV Max tạo mới hoặc sao chép **chạy và tiêu tiền ngay** (TikTok không cho tạo ở trạng thái tạm dừng).",
      ],
    },
    {
      id: "ben-thu-ba",
      title: "4. Nền tảng bên thứ ba",
      items: [
        "Meta, TikTok, Google, OpenAI, Telegram và Apify là dịch vụ độc lập. API của họ có thể thay đổi, bị giới hạn, gián đoạn hoặc trả dữ liệu trễ, thiếu, sai; chỉ số trong Hệ thống có thể chênh lệch với trình quản lý quảng cáo.",
        "Tài khoản quảng cáo, Trang, cửa hàng, bot hoặc tài khoản Google của bạn có thể bị nền tảng hạn chế, khoá, vô hiệu hoá hoặc từ chối quảng cáo theo chính sách của họ. Những việc này **không thuộc trách nhiệm của noti.vn hay Đơn vị vận hành**.",
      ],
    },
    {
      id: "apify",
      title: "5. Lấy dữ liệu qua Apify",
      paragraphs: [
        "Token Apify cho phép Hệ thống chạy các chương trình thu thập dữ liệu web (“Actor”, phần lớn do bên thứ ba viết) bằng credit của tài khoản Apify. **Mọi chi phí của các lần chạy - kể cả do trợ lý AI hoặc đồng nghiệp dùng chung token yêu cầu - tính vào tài khoản Apify của chủ token**; trần chi phí của Hệ thống chỉ giúp hạn chế, bạn nên đặt thêm giới hạn chi tiêu trong tài khoản Apify. Dữ liệu thu thập là **dữ liệu của bên thứ ba** và có thể sai hoặc lỗi thời; tác giả Actor có thể xem đầu vào và kết quả lần chạy. **Bạn tự chịu trách nhiệm bảo đảm việc thu thập và sử dụng dữ liệu là hợp pháp**: tuân thủ điều khoản của trang đích (sàn thương mại điện tử, mạng xã hội, website), quyền sở hữu trí tuệ và pháp luật Việt Nam về bảo vệ dữ liệu cá nhân. Bạn cũng phải tuân thủ điều khoản của Apify, trong đó **cấm một người tạo hoặc dùng nhiều tài khoản Apify cá nhân** - chỉ thêm token của tài khoản Apify hợp pháp mà bạn hoặc đơn vị của bạn sở hữu.",
      ],
    },
    {
      id: "du-lieu",
      title: "6. Dữ liệu và nhật ký",
      items: [
        "Token đã mã hoá, danh sách tài khoản quảng cáo, Trang, kênh Telegram, thư mục / sheet đã khai báo và nhật ký thao tác được lưu trên **máy chủ của Đơn vị vận hành**, không lưu ở noti.vn.",
        "Mọi thao tác của bạn trong Hệ thống và mọi lệnh MCP dùng kết nối này đều được ghi nhật ký (thời gian, người thực hiện, địa chỉ IP, thiết bị, nội dung thay đổi đã che thông tin bí mật) và lưu theo thời hạn quản trị viên cài đặt. Bạn đồng ý với việc ghi nhật ký này.",
        "Chi tiết cách xử lý dữ liệu xem trong Chính sách quyền riêng tư.",
      ],
    },
    {
      id: "gioi-han",
      title: "7. Giới hạn trách nhiệm",
      paragraphs: [
        "Hệ thống được cung cấp “nguyên trạng” và “theo khả năng sẵn có”. **Trong phạm vi pháp luật cho phép, noti.vn và Đơn vị vận hành không chịu trách nhiệm** đối với bất kỳ thiệt hại trực tiếp hay gián tiếp nào, mất doanh thu hoặc lợi nhuận, mất dữ liệu, chi phí quảng cáo phát sinh, tài khoản bị hạn chế hoặc khoá, phát sinh từ việc kết nối hoặc sử dụng kết nối, kể cả khi đã được cảnh báo trước về khả năng xảy ra thiệt hại.",
      ],
    },
    {
      id: "boi-hoan",
      title: "8. Bồi hoàn",
      paragraphs: [
        "Bạn chịu trách nhiệm và **bồi hoàn cho noti.vn và Đơn vị vận hành** mọi thiệt hại, chi phí (kể cả chi phí pháp lý hợp lý) và khiếu nại của bên thứ ba phát sinh từ việc bạn kết nối tài sản không thuộc quyền của mình, cung cấp thông tin sai, hoặc vi phạm điều khoản, chính sách của nền tảng hay quy định pháp luật.",
      ],
    },
    {
      id: "ghi-nhan",
      title: "9. Ghi nhận xác nhận của bạn",
      items: [
        "Khi bạn bấm xác nhận, Hệ thống ghi lại **tài khoản của bạn, thời gian, địa chỉ IP, thiết bị và phiên bản nội dung** bạn đã đồng ý. Bản ghi này có giá trị như sự chấp thuận bằng văn bản của bạn.",
        "Bạn chỉ cần xác nhận một lần cho mỗi phiên bản nội dung. Nội dung này có thể được cập nhật; khi có phiên bản mới, bạn phải đọc và xác nhận lại trước khi thêm kết nối.",
      ],
    },
  ],
  closing:
    "Nếu không đồng ý với bất kỳ nội dung nào ở trên, hãy bấm “Huỷ” và không kết nối. Có câu hỏi, hãy liên hệ quản trị viên Hệ thống trước khi tiếp tục.",
}

// ---------------------------------------------------------------------------------------------------------------
// K2 - trước khi tạo MCP
// ---------------------------------------------------------------------------------------------------------------

const mcp: DisclaimerDoc = {
  title: "Miễn trừ trách nhiệm - vui lòng đọc kỹ trước khi tạo MCP",
  summary:
    "Đọc hết nội dung bên dưới, đánh dấu đồng ý rồi mới bắt đầu tạo MCP.",
  intro: [
    "Bạn sắp tạo một đường dẫn MCP cho phép **trợ lý AI** (Claude, ChatGPT, Gemini…) dùng các kết nối của bạn trong hệ thống Ads MCP Simple by noti.vn (“Hệ thống”): xem chỉ số, bật / tắt, sửa, sao chép, tạo mới, xoá quảng cáo, gửi tin Telegram, đọc và ghi Google Drive / Google Sheet - trong phạm vi quyền bạn chọn. Hệ thống do **Đơn vị vận hành** (tổ chức đã cài đặt và quản trị Hệ thống này, là bên kiểm soát dữ liệu) cung cấp; phần mềm Ads MCP Simple by noti.vn do **noti.vn** phát triển.",
    "Nội dung dưới đây là một phần của Điều khoản dịch vụ và Chính sách quyền riêng tư của Hệ thống. Bạn chỉ có thể bắt đầu tạo MCP sau khi đã đọc hết và xác nhận đồng ý.",
  ],
  sections: [
    {
      id: "ai-co-the-sai",
      title: "1. Trợ lý AI có thể sai",
      items: [
        "Trợ lý AI **có thể hiểu nhầm yêu cầu, chọn nhầm tài khoản / chiến dịch, tính sai số liệu hoặc tự đưa ra thao tác bạn không mong muốn**.",
        "Dữ liệu bên ngoài mà AI đọc được - tên quảng cáo, nội dung bài viết, ô trong Google Sheet, tên file, tin nhắn - **có thể chứa câu lệnh chèn vào (prompt injection)** khiến AI làm sai.",
        "**Mọi thao tác thực hiện qua MCP được coi là do chủ MCP thực hiện**, bất kể do bạn, người khác có đường dẫn hay trợ lý AI tự đề xuất.",
      ],
    },
    {
      id: "lop-bao-ve",
      title: "2. Các lớp bảo vệ chỉ là công cụ hỗ trợ",
      items: [
        "Xác nhận 2 bước, giới hạn mức thay đổi ngân sách, trần ngân sách, giới hạn số thao tác, giới hạn địa chỉ IP và thời hạn MCP **giúp giảm rủi ro nhưng không bảo đảm ngăn được mọi sai sót**.",
        "Trước khi đồng ý một thao tác ghi, **bạn phải tự đọc kỹ bản xem trước** (đối tượng, tài khoản, số tiền, trạng thái). Đồng ý = bạn chịu trách nhiệm về thao tác đó.",
        "**Thao tác xoá không hoàn tác được.** Chỉ cấp quyền xoá khi thật cần.",
      ],
    },
    {
      id: "gmv-max",
      title: "3. TikTok GMV Max chạy và tiêu tiền ngay",
      items: [
        "Quảng cáo tạo mới hoặc sao chép qua MCP luôn ở trạng thái tạm dừng, **trừ chiến dịch TikTok GMV Max**: TikTok không cho tạo ở trạng thái tạm dừng, nên khi quản trị viên đã cho phép thay đổi GMV Max cho MCP, chiến dịch GMV Max tạo mới hoặc sao chép **chạy và tiêu tiền NGAY** sau khi được xác nhận.",
        "Tạm dừng, xoá, sửa ROI mục tiêu hoặc sửa sản phẩm, video trong ngày làm **mất Bảo vệ ROI (tín dụng quảng cáo) của ngày đó**; bật một chiến dịch GMV Max có thể tự tạm dừng quảng cáo Shop khác dùng cùng cửa hàng, sản phẩm ở mọi tài khoản quảng cáo; khi bật tự tăng ngân sách, mức chi trong ngày có thể vượt xa ngân sách ngày.",
      ],
    },
    {
      id: "link-mcp",
      title: "4. Đường dẫn MCP có giá trị như mật khẩu",
      items: [
        "**Ai có đường dẫn MCP là dùng được mọi quyền đã cấp cho nó**, không cần đăng nhập Hệ thống.",
        "Bạn tự giữ bí mật đường dẫn: không dán vào nơi công khai, tài liệu chia sẻ, ảnh chụp màn hình hay nhóm chat. Khi nghi bị lộ, **xoay key hoặc tắt MCP ngay** và báo quản trị viên.",
        "Chỉ cấp cho MCP đúng các tài khoản, kênh, thư mục và quyền cần dùng; đặt thời hạn và giới hạn địa chỉ IP khi có thể.",
      ],
    },
    {
      id: "ung-dung-ai",
      title: "5. Ứng dụng AI là bên thứ ba",
      items: [
        "Claude (Anthropic), ChatGPT (OpenAI), Gemini (Google) và các ứng dụng AI khác là dịch vụ độc lập. Dữ liệu quảng cáo, nội dung Trang, Google Sheet… mà AI nhận được qua MCP được **nhà cung cấp AI xử lý theo điều khoản và chính sách của họ**, nằm ngoài sự kiểm soát của noti.vn và Đơn vị vận hành.",
        "Bạn tự kiểm tra rằng việc đưa dữ liệu của đơn vị vào ứng dụng AI được phép theo quy định nội bộ và hợp đồng của đơn vị.",
      ],
    },
    {
      id: "tu-dong",
      title: "6. Tác vụ tự động và theo lịch",
      paragraphs: [
        "Tác vụ theo lịch hoặc tự động (ví dụ tác vụ định kỳ trong ứng dụng AI, quy tắc tự bật / tắt, tự đổi ngân sách) **chạy khi không có người giám sát**. Bạn chịu trách nhiệm về kết quả của chúng và phải tự theo dõi, kiểm tra thường xuyên.",
      ],
    },
    {
      id: "trach-nhiem",
      title: "7. Quyền hợp pháp, chi phí và nền tảng",
      items: [
        "Bạn chỉ đưa vào MCP những kết nối mà bạn có quyền hợp pháp sử dụng, và tự tuân thủ điều khoản, chính sách quảng cáo của Meta, TikTok, Google, OpenAI, Telegram và pháp luật.",
        "**Mọi chi phí quảng cáo phát sinh do chủ tài khoản quảng cáo chịu.** Hệ thống, Đơn vị vận hành và noti.vn không cam kết hiệu quả, doanh thu hay ROI.",
        "API của các nền tảng có thể thay đổi, gián đoạn hoặc trả dữ liệu trễ, sai; tài khoản có thể bị nền tảng hạn chế hoặc khoá - không thuộc trách nhiệm của noti.vn hay Đơn vị vận hành.",
        "Mọi lệnh MCP được ghi nhật ký (thời gian, ứng dụng AI, địa chỉ IP, công cụ, tham số, giá trị trước và sau khi ghi; thông tin bí mật đã được che) trên máy chủ của Đơn vị vận hành và lưu theo thời hạn quản trị viên cài đặt.",
      ],
    },
    {
      id: "gioi-han",
      title: "8. Giới hạn trách nhiệm và bồi hoàn",
      paragraphs: [
        "**Trong phạm vi pháp luật cho phép, noti.vn và Đơn vị vận hành không chịu trách nhiệm** đối với bất kỳ thiệt hại trực tiếp hay gián tiếp nào, mất doanh thu hoặc lợi nhuận, mất dữ liệu, chi phí quảng cáo phát sinh, tài khoản bị hạn chế hoặc khoá, phát sinh từ việc tạo, chia sẻ hoặc sử dụng MCP, kể cả từ thao tác do trợ lý AI thực hiện.",
        "Bạn chịu trách nhiệm và **bồi hoàn cho noti.vn và Đơn vị vận hành** mọi thiệt hại, chi phí (kể cả chi phí pháp lý hợp lý) và khiếu nại của bên thứ ba phát sinh từ việc bạn hoặc người có đường dẫn MCP của bạn sử dụng MCP trái quyền, trái chính sách nền tảng hoặc trái pháp luật.",
      ],
    },
    {
      id: "ghi-nhan",
      title: "9. Ghi nhận xác nhận của bạn",
      items: [
        "Khi bạn bấm xác nhận, Hệ thống ghi lại **tài khoản của bạn, thời gian, địa chỉ IP, thiết bị và phiên bản nội dung** bạn đã đồng ý. Bản ghi này có giá trị như sự chấp thuận bằng văn bản của bạn.",
        "Bạn chỉ cần xác nhận một lần cho mỗi phiên bản nội dung. Nội dung này có thể được cập nhật; khi có phiên bản mới, bạn phải đọc và xác nhận lại trước khi tạo MCP.",
      ],
    },
  ],
  closing:
    "Nếu không đồng ý với bất kỳ nội dung nào ở trên, hãy bấm “Huỷ” và không tạo MCP. Có câu hỏi, hãy liên hệ quản trị viên Hệ thống trước khi tiếp tục.",
}

export const disclaimers = {
  docs: { connection, mcp } satisfies Record<DisclaimerKind, DisclaimerDoc>,

  dialog: {
    versionLine: (version: string, date: string) =>
      `Phiên bản ${version} · áp dụng từ ${date}`,
    regionLabel: "Nội dung miễn trừ trách nhiệm",
    readHint: "Kéo xuống đọc hết nội dung để tiếp tục",
    readDone: "Bạn đã đọc hết nội dung",
    progressLabel: "Tiến độ đọc",
    countdown: (s: number) => `Có thể xác nhận sau ${s} giây`,
    checkbox:
      "Tôi đã đọc kỹ, hiểu và đồng ý toàn bộ nội dung miễn trừ trách nhiệm trên",
    checkboxLockedHint:
      "Ô xác nhận mở khi bạn đã đọc hết nội dung và đủ thời gian đọc tối thiểu.",
    confirm: "Tôi đồng ý và bắt đầu",
    confirming: "Đang ghi nhận…",
    cancel: "Huỷ",
    endMark: "Hết nội dung",
    linksLead: "Xem thêm:",
    terms: "Điều khoản dịch vụ",
    privacy: "Chính sách quyền riêng tư",
    newTab: "(mở trong tab mới)",
  },

  errors: {
    /** create refused by the server: this user never accepted the current version */
    required: {
      connection:
        "Bạn cần đọc và xác nhận miễn trừ trách nhiệm trước khi thêm kết nối. Hãy tải lại trang để đọc và xác nhận.",
      mcp: "Bạn cần đọc và xác nhận miễn trừ trách nhiệm trước khi tạo MCP. Hãy tải lại trang để đọc và xác nhận.",
    } satisfies Record<DisclaimerKind, string>,
    stale:
      "Nội dung miễn trừ trách nhiệm vừa được cập nhật. Hãy tải lại trang để đọc phiên bản mới.",
    invalid: "Yêu cầu không hợp lệ. Hãy tải lại trang.",
    throttled: "Bạn thao tác quá nhanh. Hãy thử lại sau ít phút.",
    generic: "Chưa ghi nhận được xác nhận. Vui lòng thử lại.",
  },
} as const
