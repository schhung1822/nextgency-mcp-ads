// Chuỗi tiếng Việt - GMV Max (TikTok Shop) trong luồng Thêm kết nối → TikTok Ads
// (src/app/(dashboard)/connections/new/_components/tiktok-gmv-max-guide.tsx + thẻ TikTok ở bước 1).
// Nội dung đối chiếu tài liệu chính thức TikTok (Help Center GMV Max, API for Business - xem
// .claude/docs/providers/tiktok.md §GMV Max). Lời cảnh báo giữ cùng ý với
// src/server/providers/tiktok/gmv-max-text.ts (GMV_MAX_CAUTION) - client component không import src/server/*.
// Tên menu của TikTok giữ nguyên tiếng Anh khi chưa xác minh được nhãn tiếng Việt.
// Cú pháp nhỏ trong chuỗi: **đậm**, `mã` (hiển thị bằng <strong> / <code>, không phải HTML).

export interface GmvGuideStep {
  text: string
  /** "Bạn sẽ thấy": what is on screen when the step worked */
  see?: string
  links?: readonly { label: string; url: string }[]
}

export interface GmvGuideFlow {
  /** small heading above a numbered list (e.g. "Cách A - …") */
  title: string
  steps: readonly GmvGuideStep[]
  note?: string
}

const BC_URL = "https://business.tiktok.com/"
const PORTAL_URL = "https://business-api.tiktok.com/portal"
const HELP = (slug: string, vi = false) =>
  `https://ads.tiktok.com/help/article/${slug}${vi ? "?lang=vi" : ""}`

export const tiktokGmvMax = {
  /** step 1: appended to the TikTok Ads card description */
  cardNote: "Gồm cả GMV Max (TikTok Shop).",

  /** step 2: the Alert above the form */
  note: {
    title: "Dùng GMV Max (TikTok Shop)?",
    body: "Kết nối TikTok Ads này dùng luôn cho GMV Max, không cần tạo kết nối riêng - nhớ cấp đủ quyền cho app (tick tất cả). Mặc định AI chỉ xem và phân tích chỉ số GMV Max; AI chỉ thay đổi chiến dịch GMV Max khi quản trị viên bật quyền đó trong MCP, và luôn phải xác nhận 2 bước. Hạn chế sửa liên tục: tạm dừng hay sửa ROI trong ngày làm mất Bảo vệ ROI của ngày đó.",
    open: "Xem hướng dẫn GMV Max",
  },

  dialog: {
    title: "Hướng dẫn thiết lập GMV Max",
    description:
      "Làm lần lượt từ trên xuống. Mỗi bước có dòng “Bạn sẽ thấy” để biết mình đã làm đúng.",
    close: "Đã hiểu",
    newTab: "(mở trong thẻ mới)",
    seeLabel: "Bạn sẽ thấy:",
    required: "Bắt buộc",
    optional: "Tuỳ chọn",
    labelsNote:
      "Tên nút và menu của TikTok ghi theo giao diện tiếng Anh. Nếu bạn dùng giao diện tiếng Việt, tên có thể khác một chút.",
  },

  caution: {
    title: "Lưu ý khi dùng AI với GMV Max",
    points: [
      "GMV Max **tự tối ưu theo ngày**. Dùng AI để **xem và phân tích** chỉ số: chi tiêu, doanh thu, ROI, số đơn theo ngày, sản phẩm, video, phiên LIVE.",
      "**Hạn chế bật/tắt hay sửa** chiến dịch GMV Max. Sửa liên tục làm gián đoạn quá trình tối ưu (học) của GMV Max.",
      "TikTok khuyên **giữ mỗi mức ROI mục tiêu ít nhất 3 ngày trọn vẹn** (GMV Max cho LIVE: sửa ROI tối đa 1 lần/ngày).",
      "Tạm dừng, xoá, sửa ROI hoặc sửa sản phẩm trong ngày sẽ **mất Bảo vệ ROI** (tín dụng quảng cáo) của ngày đó.",
      "Mặc định AI **chỉ xem**. AI chỉ bật/tắt, sửa (ngân sách, ROI, sản phẩm, video), sao chép, tạo mới hay xoá chiến dịch GMV Max khi **quản trị viên bật “Cho phép AI thay đổi GMV Max”** trong MCP (bước Chọn quyền), và **luôn phải xác nhận 2 bước**.",
      "Mọi thay đổi GMV Max **bắt buộc có trần ngân sách/ngày** trong MCP, tính theo **mức chi tối đa có thể mỗi ngày** (gồm tăng ngân sách tự động và ngày khuyến mãi); không đọc được ngân sách thì AI không làm.",
    ],
    runsNowTitle: "Tạo mới / sao chép GMV Max: chạy ngay",
    runsNow:
      "Chiến dịch GMV Max tạo mới hoặc sao chép qua API **CHẠY NGAY** và tiêu tiền ngay - không tạo ở trạng thái tạm dừng được - và có thể tự tạm dừng quảng cáo Shop khác dùng cùng cửa hàng / sản phẩm / tài khoản TikTok ở **MỌI** tài khoản quảng cáo.",
  },

  about: {
    title: "GMV Max là gì? AI làm được gì?",
    points: [
      "**GMV Max** là quảng cáo tự động của **TikTok Shop**. TikTok tự chọn người xem, video và mức chi để đạt ROI mục tiêu bạn đặt.",
      "Có 2 loại: **GMV Max sản phẩm** (Product GMV Max) và **GMV Max cho LIVE** (LIVE GMV Max).",
      "GMV Max dùng chung kết nối TikTok Ads này - **không cần kết nối riêng**. App cần **đủ quyền** (Bước 4: tick tất cả).",
      "AI xem được: cửa hàng nào sẵn sàng, danh sách chiến dịch GMV Max, chi tiêu / doanh thu / ROI / số đơn theo ngày, theo sản phẩm, theo video và theo phiên LIVE.",
      "AI thay đổi được (chỉ khi **quản trị viên cho phép** trong MCP): bật/tắt, ngân sách, ROI mục tiêu, sản phẩm, video, sao chép, tạo mới, xoá. Không làm qua MCP: đổi tài khoản GMV Max độc quyền của cửa hàng, phiên Max delivery / Creative boost.",
      "ROI và số đơn của GMV Max **gồm cả đơn tự nhiên**. Đừng so trực tiếp với ROAS của báo cáo TikTok thường. Chi tiêu GMV Max có thể không nằm (đầy đủ) trong báo cáo thường - đừng cộng hai báo cáo với nhau vì có thể bị trùng hoặc sai.",
      "GMV Max chỉ có ở cửa hàng tại: **Việt Nam, Indonesia, Malaysia, Philippines, Singapore, Thái Lan, Mỹ**.",
    ],
  },

  prereq: {
    title: "Cần chuẩn bị gì?",
    points: [
      "Một **TikTok Shop** đang hoạt động và **tài khoản quảng cáo** TikTok bạn muốn dùng cho GMV Max.",
      "Một **Business Center** chứa cả cửa hàng và tài khoản quảng cáo đó.",
      "Bạn là **Admin** của Business Center (vai trò Standard là chưa đủ).",
      "Bạn có quyền **Ad promotion** (chạy quảng cáo) với cửa hàng.",
      "Bạn có vai trò **Admin** hoặc **Operator** trên tài khoản quảng cáo.",
      "Nếu bạn là agency: chủ cửa hàng sẵn sàng bấm duyệt yêu cầu của bạn.",
    ],
  },

  shop: {
    title: "Bước 1. Đưa cửa hàng vào Business Center",
    flows: [
      {
        title: "Cửa hàng của bạn",
        steps: [
          {
            text: "Mở **Business Center** và đăng nhập.",
            links: [{ label: "Mở Business Center", url: BC_URL }],
          },
          { text: "Ở menu bên trái, chọn **Accounts** → **Shops**." },
          {
            text: "Bấm **Add Shop** → chọn cửa hàng → bấm **Start setup in TikTok Seller Center**.",
          },
          {
            text: "Làm tiếp các bước trong Seller Center rồi bấm **Finish Setup**.",
            see: "Cửa hàng hiện trong danh sách **Shops** của Business Center.",
          },
        ],
      },
      {
        title: "Agency (cửa hàng của khách)",
        steps: [
          { text: "Xin chủ cửa hàng **mã cửa hàng** (shop code)." },
          {
            text: "Trong Business Center, bấm **Add shop** → **Request access to TikTok shop partners**.",
          },
          {
            text: "Nhập mã cửa hàng → bấm **Request**.",
            see: "Chủ cửa hàng nhận email. Khi họ duyệt, cửa hàng hiện trong Business Center của bạn.",
          },
          {
            text: "Mở cửa hàng vừa thêm → **Assign new member** để cấp quyền cho người chạy quảng cáo.",
          },
        ],
        note: "Mỗi cửa hàng chỉ gắn với **một** Business Center chủ sở hữu, nhưng có thể chia sẻ quyền cho Business Center khác (agency).",
      },
    ] as readonly GmvGuideFlow[],
    links: [
      {
        label: "Thêm cửa hàng vào Business Center",
        url: HELP("add-tiktok-shop-from-business-center"),
      },
      {
        label: "Xin quyền truy cập cửa hàng",
        url: HELP("requesting-tiktok-shop-access-business-center"),
      },
    ],
  },

  account: {
    title: "Bước 2. Chọn tài khoản quảng cáo GMV Max cho cửa hàng",
    intro:
      "Mỗi cửa hàng chỉ có **1 tài khoản quảng cáo GMV Max** tại một thời điểm. Hãy chọn đúng tài khoản bạn sẽ kết nối vào Ads MCP. Làm **một trong hai** cách dưới đây.",
    flows: [
      {
        title: "Cách A - Trong Seller Center (chủ cửa hàng)",
        steps: [
          { text: "Đăng nhập **TikTok Shop Seller Center**." },
          {
            text: "Ở menu bên trái, chọn **Shop Ads** → **Manage account** (bản tiếng Việt: **Quảng cáo Shop** → **Quản lý tài khoản**).",
          },
          {
            text: "Mở mục **GMV Max account** → bấm **Add GMV Max account** (trong phần **Authorization needed**).",
          },
          {
            text: "Chọn tài khoản quảng cáo rồi xác nhận. Nên đặt tài khoản này làm **primary ad account** để xem số liệu GMV Max ngay trong Seller Center.",
            see: "Tài khoản quảng cáo hiện trong mục **GMV Max account**.",
          },
        ],
        note: "Cách này cần tài khoản quảng cáo, tài khoản TikTok và cửa hàng nằm **cùng một Business Center**.",
      },
      {
        title: "Cách B - Trong Business Center (agency hoặc chủ cửa hàng)",
        steps: [
          {
            text: "Mở Business Center → menu bên trái **Accounts** → **TikTok Shop Accounts**.",
          },
          { text: "Chọn cửa hàng → bấm **Set up GMV Max**." },
          {
            text: "Chọn tài khoản quảng cáo → bấm **Request GMV Max authorization** → **Confirm**.",
            see: "Yêu cầu ở trạng thái **Pending** (đang chờ duyệt).",
          },
          {
            text: "Chủ cửa hàng nhận email và thông báo trong Business Center → bấm **Approve**.",
            see: "Tài khoản quảng cáo có nhãn **GMV Max account** trong Business Center.",
          },
        ],
      },
    ] as readonly GmvGuideFlow[],
    warningTitle: "Đổi tài khoản GMV Max sẽ dừng chiến dịch cũ",
    warning:
      "Khi cửa hàng chuyển sang tài khoản quảng cáo GMV Max khác, **mọi chiến dịch GMV Max** của cửa hàng ở tài khoản cũ **tự tạm dừng** và phải tạo lại ở tài khoản mới. Chỉ đổi khi thật cần.",
    links: [
      {
        label: "Xin quyền GMV Max trong Business Center",
        url: HELP("how-to-request-gmv-max-authorization-in-business-center"),
      },
      {
        label: "Thêm tài khoản GMV Max trong Seller Center",
        url: HELP("how-to-request-gmv-max-authorization-for-tiktok-accounts"),
      },
      {
        label: "Hướng dẫn về GMV Max (tiếng Việt)",
        url: HELP("gmv-max-guidelines", true),
      },
    ],
  },

  live: {
    title: "Bước 3. GMV Max cho LIVE: liên kết tài khoản TikTok",
    intro:
      "Chỉ cần nếu bạn chạy GMV Max cho LIVE. Bỏ qua nếu chỉ chạy GMV Max sản phẩm.",
    steps: [
      {
        text: "Kết nối tài khoản TikTok chính thức của cửa hàng vào Business Center, rồi bấm **Turn on exclusive LIVE GMV Max permissions**.",
      },
      {
        text: "Business Center → menu bên trái **Accounts** → chọn tài khoản TikTok đó → bấm **Link ad account**.",
      },
      {
        text: "Chọn tài khoản quảng cáo GMV Max → bấm **Confirm**.",
        see: "Tài khoản quảng cáo được phép chạy chiến dịch GMV Max cho LIVE.",
      },
    ] as readonly GmvGuideStep[],
    note: "Một tài khoản TikTok chỉ cấp quyền cho **một** Business Center tại một thời điểm.",
    links: [
      {
        label: "Cấp quyền LIVE GMV Max",
        url: HELP(
          "how-to-authorize-an-ad-account-to-run-a-live-gmv-max-campaign-in-business"
        ),
      },
    ],
  },

  scope: {
    title: "Bước 4. Cấp đủ quyền cho app (tick tất cả) rồi cấp quyền lại",
    steps: [
      {
        text: "Mở **TikTok API for Business** → **My Apps** → chọn app bạn dùng cho Ads MCP.",
        links: [{ label: "Mở TikTok API for Business", url: PORTAL_URL }],
      },
      {
        text: "Ở mục **Scope of permission**, bấm biểu tượng **chỉnh sửa**.",
      },
      {
        text: "Tick **tất cả** nhóm quyền và **mọi ô con**: tick ô của từng nhóm cấp 1 để chọn trọn nhóm, rồi mở từng nhóm kiểm tra không sót ô nào - **trừ 2 ô** nói ở bước dưới.",
      },
      {
        text: "Kiểm tra kỹ các ô của GMV Max: **Ads Management → GMV MAX** (Store Management, Identity And Video, custom anchor), **Reporting → GMV MAX Report** và **Onsite Commerce Store** đã được tick. **Bỏ tick** 2 ô **GMV MAX → Session** và **GMV MAX → Exclusive Authorization**: Ads MCP không dùng, và nếu token bị lộ, Exclusive Authorization cho phép chuyển tài khoản GMV Max của cửa hàng.",
        see: "Mọi ô trong Scope of permission đều được tick, trừ Session và Exclusive Authorization của GMV MAX.",
      },
      {
        text: "Ghi lý do (ví dụ `Quản lý quảng cáo và GMV Max qua AI`) → bấm **Submit**. TikTok duyệt lại app trong **2–3 ngày làm việc**.",
        see: "Các quyền GMV MAX hiện trong Scope of permission của app sau khi được duyệt.",
      },
      {
        text: "Cấp đủ quyền cho app **không có nghĩa AI được làm hết**: AI chỉ làm những gì bạn cho phép trong từng MCP. Riêng thay đổi GMV Max, chỉ **quản trị viên** bật được trong MCP.",
      },
      {
        text: "Token cũ **không tự có quyền mới**. Người quản trị tài khoản quảng cáo mở lại **Advertiser authorization URL** của app → chọn tài khoản → đồng ý.",
        see: "TikTok chuyển về trang Thêm kết nối, kèm `auth_code` mới trên thanh địa chỉ.",
      },
      {
        text: "Kết nối **mới**: chọn **Đổi auth_code** ngay trên form này. Kết nối **đã có**: mở kết nối → **Thay token** → **Đổi auth_code**. Mã chỉ sống 1 giờ và dùng được 1 lần.",
      },
    ] as readonly GmvGuideStep[],
    links: [
      {
        label: "Cách đổi quyền của app (TikTok)",
        url: "https://business-api.tiktok.com/portal/docs?id=1738855280338946",
      },
    ],
  },

  check: {
    title: "Bước 5. Kiểm tra đã dùng được chưa",
    steps: [
      {
        text: "Bấm **Kiểm tra kết nối** ở form này.",
        see: "Mục **Lưu ý** có dòng “GMV Max (TikTok Shop): tài khoản … đã sẵn sàng với … cửa hàng”.",
      },
      {
        text: "Nếu thấy dòng “Token chưa có quyền GMV Max…”: làm lại Bước 4 (chờ duyệt xong, rồi cấp quyền lại và đổi auth_code).",
      },
      {
        text: "Lưu kết nối (bật tài khoản quảng cáo đó), rồi chọn tài khoản này khi tạo MCP. Mức quyền **Chỉ xem** là đủ để AI phân tích GMV Max. Muốn AI thay đổi GMV Max: chọn thêm quyền và nhờ **quản trị viên** bật “Cho phép AI thay đổi GMV Max” trong MCP.",
      },
      {
        text: "Hỏi AI: “Kiểm tra cửa hàng GMV Max của TKQC X”. AI dùng `tiktok_gmv_max_shops`.",
        see: "AI liệt kê từng cửa hàng: đã sẵn sàng hay chưa, và lý do nếu chưa.",
      },
    ] as readonly GmvGuideStep[],
    notReadyTitle: "Cửa hàng chưa sẵn sàng thường do:",
    notReady: [
      "Tài khoản quảng cáo chưa là **GMV Max account** của cửa hàng (Bước 2).",
      "Bạn thiếu quyền **Ad promotion** với cửa hàng, hoặc không phải **Admin** Business Center.",
      "Cửa hàng ở ngoài 7 thị trường có GMV Max.",
    ],
    links: [
      {
        label: "Khắc phục cài đặt tài khoản GMV Max",
        url: HELP(
          "troubleshoot-account-settings-for-gmv-max-in-tiktok-ads-manager"
        ),
      },
    ],
  },

  prompts: {
    title: "Câu hỏi mẫu cho AI (chỉ phân tích)",
    intro: "Thay X, Y bằng tên tài khoản quảng cáo, chiến dịch của bạn.",
    items: [
      "Tổng chi tiêu, doanh thu, ROI và số đơn GMV Max 7 ngày qua của TKQC X, chia theo từng ngày.",
      "So sánh các chiến dịch GMV Max sản phẩm tháng này: chiến dịch nào ROI thấp hơn mục tiêu?",
      "Top 10 sản phẩm theo doanh thu tuần qua trong chiến dịch GMV Max Y. Sản phẩm nào tốn tiền mà ít đơn?",
      "Video nào trong chiến dịch Y đang kéo nhiều đơn nhất? Video nào chi nhiều mà chưa ra đơn?",
      "Phiên LIVE nào hôm qua có ROI tốt nhất?",
      "Chiến dịch GMV Max nào đang kém? Chỉ phân tích và đề xuất, chưa sửa gì.",
    ],
  },

  roiLinks: [
    {
      label: "Bảo vệ ROI cho GMV Max (tiếng Việt)",
      url: HELP("about-roi-protection-for-gmv-max-campaigns", true),
    },
    {
      label: "Phương pháp hay nhất cho GMV Max sản phẩm (tiếng Việt)",
      url: HELP("best-practices-for-product-gmv-max", true),
    },
  ],
}

/**
 * MCP form (bước "Chọn quyền", thẻ TikTok) + tóm tắt MCP: công tắc "Cho phép AI thay đổi GMV Max" (chỉ quản trị viên
 * bật được) và bảng ảnh hưởng của từng quyền. Giữ cùng ý với src/server/providers/tiktok/gmv-max-text.ts.
 */
export const tiktokGmvMaxMcp = {
  groupLabel: "GMV Max (TikTok Shop)",
  switchLabel: "Cho phép AI thay đổi GMV Max (TikTok Shop)",
  adminBadge: "Chỉ quản trị viên",
  helpOff:
    "Đang tắt: AI chỉ **xem chỉ số** GMV Max - không bật/tắt, sửa, sao chép, tạo mới hay xoá chiến dịch GMV Max.",
  helpOn:
    "Đang bật: AI được thay đổi chiến dịch GMV Max theo các quyền TikTok đã chọn ở trên.",
  staffLocked:
    "Chỉ quản trị viên bật được - nhờ quản trị viên mở MCP này để bật.",
  staffCanTurnOff:
    "Quản trị viên đã bật quyền này. Bạn tắt được, nhưng sau khi lưu chỉ quản trị viên bật lại được. Khi quyền còn bật, bạn chỉ giữ nguyên hoặc thu hẹp được tài khoản, quyền và hạn mức TikTok - muốn mở rộng, nhờ quản trị viên lưu.",
  detectedTitle: "Tài khoản đã chọn có GMV Max",
  /** admin; `on`: the switch is already on (no "before you switch it on") */
  detectedBody: (names: string, more: number, on = false) =>
    `${names}${more > 0 ? ` và ${more} tài khoản khác` : ""} có cửa hàng TikTok Shop dùng GMV Max. ${on ? "AI đang được thay đổi GMV Max theo các quyền đã cấp - đọc kỹ ảnh hưởng của từng quyền bên dưới." : "Đọc kỹ ảnh hưởng của từng quyền trước khi bật."}`,
  /** staff: the switch is an admin decision (no "read before you switch it on") */
  detectedBodyStaff: (names: string, more: number) =>
    `${names}${more > 0 ? ` và ${more} tài khoản khác` : ""} có cửa hàng TikTok Shop dùng GMV Max. Quyền thay đổi GMV Max do quản trị viên quyết định - dưới đây là ảnh hưởng của từng quyền.`,
  impactTitle: "Ảnh hưởng của từng quyền tới GMV Max",
  impactToggle: "Xem ảnh hưởng của từng quyền tới GMV Max",
  impactIntro:
    "GMV Max tự tối ưu theo ngày - mỗi lần thay đổi đều ảnh hưởng tới chi tiêu và quá trình học:",
  granted: "Đã cấp",
  notGranted: "Chưa cấp",
  impact: {
    status:
      "Tạm dừng giữa ngày làm **mất Bảo vệ ROI** của ngày đó. Bật lên có thể **tự tạm dừng quảng cáo Shop khác** dùng cùng cửa hàng / sản phẩm / tài khoản TikTok ở mọi tài khoản quảng cáo.",
    update:
      "**Ngân sách**: tự tăng ngân sách có thể chi tới **khoảng 31 lần** ngân sách ngày, ngày khuyến mãi thêm 50%. **ROI mục tiêu**: TikTok khuyên giữ **ít nhất 3 ngày** (LIVE: tối đa 1 lần/ngày), sửa ROI làm mất Bảo vệ ROI. **Sản phẩm / video**: mất Bảo vệ ROI của ngày sửa, GMV Max phải tối ưu lại.",
    copyCreate:
      "Chiến dịch GMV Max tạo qua API **CHẠY NGAY** và tiêu tiền ngay - không tạo ở trạng thái tạm dừng được. Mỗi sản phẩm chỉ ở **1** chiến dịch GMV Max sản phẩm đang bật; có thể tự tạm dừng quảng cáo Shop khác.",
    delete:
      "**Không hoàn tác**, mất dữ liệu tối ưu đã học và mất Bảo vệ ROI của ngày xoá.",
  },
  copyCreateLabel: "Sao chép / Tạo mới",
  always:
    "Luôn áp dụng: **mọi thay đổi GMV Max phải xác nhận 2 bước** (kể cả khi tắt xác nhận 2 bước ở bước Bảo vệ) và **bắt buộc có trần ngân sách/ngày** cho loại tiền của tài khoản - tính theo mức chi tối đa có thể (gồm tự tăng ngân sách, ngày khuyến mãi).",
  notOpened:
    "Không làm qua MCP: đổi tài khoản GMV Max độc quyền của cửa hàng (exclusive authorization), phiên Max delivery / Creative boost. GMV Max không có nhóm quảng cáo nên không thêm nhóm quảng cáo được.",
  readOnlyNote:
    "TikTok đang chỉ có quyền **Xem**: chọn thêm quyền ở trên thì AI mới thay đổi được GMV Max.",
  runsNowTitle: "Chiến dịch GMV Max tạo mới / sao chép sẽ chạy ngay",
  runsNow:
    "Chiến dịch GMV Max tạo qua API sẽ **CHẠY NGAY** (không tạo ở trạng thái tạm dừng được) và có thể tự tạm dừng quảng cáo Shop khác dùng cùng cửa hàng / sản phẩm / tài khoản TikTok ở **MỌI** tài khoản quảng cáo.",
  // MCP overview / summaries
  summaryLabel: "AI thay đổi GMV Max",
  summaryOn: "Bật",
  summaryOff: "Tắt - chỉ xem chỉ số",
  summaryBadge: "Được thay đổi GMV Max",
  /** MCP list: badge of MCPs with the switch on */
  listBadge: "GMV Max: AI được thay đổi",
  listBadgeHint:
    "Quản trị viên đã cho phép AI thay đổi chiến dịch GMV Max (TikTok Shop) qua MCP này - mọi thay đổi vẫn phải xác nhận 2 bước.",
  /** config tab: turning the switch on asks for the password (+ 2FA code) */
  reauth: {
    title: "Xác minh để bật quyền GMV Max",
    description:
      "Cho phép AI thay đổi chiến dịch GMV Max là thay đổi nhạy cảm (chi tiêu thật). Nhập lại mật khẩu (và mã 2FA nếu có) để lưu - thao tác này được ghi vào nhật ký.",
    submit: "Xác minh và lưu",
    submitting: "Đang lưu…",
  },
}
