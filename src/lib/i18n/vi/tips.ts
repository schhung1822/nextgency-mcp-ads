// Chuỗi tiếng Việt - nhóm trang "Mẹo sử dụng" (/tips/*): khung chung (tiêu đề, menu chọn mẹo), mẹo "Tạo quảng cáo số
// lượng lớn" (/tips/bulk-ads) và "Tự động kiểm tra quảng cáo" (/tips/ad-check). Nội dung mẹo "Chạy tự động"
// (/tips/automation) nằm ở automation.ts. Văn bản câu lệnh / skill do src/lib/{bulk-ads,ad-check}-prompt.ts dựng.
// Thông tin về các ứng dụng AI và phần mềm bán hàng kiểm tra ngày 10/10/2026.

import type { TipSlug } from "@/lib/tips-routes"

export const tips = {
  title: "Mẹo sử dụng",
  description:
    "Cách tận dụng Ads MCP với Claude, ChatGPT, Gemini: cho AI chạy theo lịch, lên quảng cáo hàng loạt từ Google Sheet và tự kiểm tra quảng cáo bằng đơn hàng thật.",
  createMcp: "Tạo MCP",
  navLabel: "Chọn mẹo",

  pages: {
    automation: {
      label: "Chạy tự động",
      short: "Chạy tự động",
      metaTitle: "Chạy tự động · Mẹo sử dụng",
    },
    "bulk-ads": {
      label: "Tạo quảng cáo số lượng lớn",
      short: "Lên QC hàng loạt",
      metaTitle: "Tạo quảng cáo số lượng lớn · Mẹo sử dụng",
    },
    "ad-check": {
      label: "Tự động kiểm tra quảng cáo",
      short: "Báo cáo đơn thật",
      metaTitle: "Tự động kiểm tra quảng cáo · Mẹo sử dụng",
    },
  } satisfies Record<
    TipSlug,
    { label: string; short: string; metaTitle: string }
  >,

  /** pieces used by every tip */
  shared: {
    who: "Dành cho",
    result: "Bạn nhận được",
    prepareTitle: "Cần chuẩn bị",
    prepareDescription:
      "Đánh dấu từng mục khi đã xong. Dấu tick được nhớ trên trình duyệt này.",
    stepsTitle: "Làm từng bước",
    youSee: "Bạn sẽ thấy:",
    tocLabel: "Trên trang này",
    toc: {
      prepare: "Chuẩn bị",
      steps: "Từng bước",
      sheet: "Mẫu sheet",
      builder: "Soạn câu lệnh",
      schedule: "Đặt lịch",
      pos: "MCP bán hàng",
      why: "Vì sao trên web",
      faq: "Lỗi thường gặp",
      safety: "An toàn",
    },
    // ---- form số trong các mẹo (src/lib/vi-amount.ts) ----
    numbers: {
      empty: "Chưa nhập. Nhập số, vd 200000 hoặc 200.000.",
      format:
        "Không đọc được số này. Nhập số, vd 200000 hoặc 200.000 (số lẻ: 12,5).",
      positive: "Phải lớn hơn 0.",
      notNegative: "Không được nhỏ hơn 0.",
      range: (min: number, max: number) =>
        `Nhập số nguyên từ ${min} đến ${max}.`,
      max: (max: string) => `Tối đa ${max}.`,
      understood: (v: string) => `= ${v}`,
    },
    currencyError: "Nhập mã tiền tệ 3 chữ cái, vd VND, USD.",
    timeError: "Chọn giờ chạy, vd 08:00.",
    copyBlocked: "Sửa các ô báo lỗi ở trên rồi mới sao chép được.",
    previewBlocked: "Sửa các ô báo lỗi để xem tóm tắt.",
    connectorLabel: "Tên connector / MCP bạn đã đặt",
    connectorPlaceholder: "Ads MCP",
    connectorHelp:
      'Đúng tên bạn đặt khi thêm link MCP vào Claude / ChatGPT (hướng dẫn gợi ý "Ads MCP"). Để trống = Ads MCP.',
    basicGroup: "Cơ bản",
    advancedGroup: "Nâng cao (không bắt buộc)",
    advancedHint: "Giữ mặc định nếu chưa chắc.",
    copyPrompt: "Sao chép câu lệnh",
    copySkill: "Sao chép SKILL.md",
    copyShort: "Sao chép câu lệnh ngắn",
    copySchedule: "Sao chép câu đặt lịch",
    checkTitle: "Kiểm tra kết quả",
    faqTitle: "Lỗi hay gặp và câu hỏi thường gặp",
    safetyTitle: "An toàn",
    newTab: "(mở tab mới)",
    outputsLabel: "Văn bản để sao chép",
    promptTab: "Câu lệnh đầy đủ",
    skillTab: "Skill (SKILL.md)",
    skillLabel: "Nội dung tệp SKILL.md",
    skillShortTitle: "Câu lệnh ngắn (khi đã cài skill)",
    skillShortLabel: "Câu lệnh ngắn gọi skill",
    skillHelp: (name: string) =>
      `Skill giúp AI làm đúng các bước mỗi lần mà câu lệnh vẫn ngắn. Lưu nội dung dưới đây thành tệp SKILL.md trong thư mục tên ${name}. Claude: nén cả thư mục (không phải riêng tệp) thành .zip rồi tải lên ở Customize → Skills. Gemini: tải tệp SKILL.md lên ở Settings → Skills. ChatGPT: chỉ gói Business / Enterprise / Healthcare / Edu có Skills (Plugins → Plugin Directory → Skills).`,
    open: "Mở",
  },

  // ---- Tip a: "Chạy tự động" (phần còn lại ở automation.ts) ------------------------------------------------------
  automation: {
    title: "Cho AI tự kiểm tra quảng cáo theo lịch",
    who: "Người chạy quảng cáo muốn AI tự soát CPA mỗi giờ hoặc mỗi ngày, kể cả lúc không ngồi trước máy.",
    result:
      "Claude, ChatGPT hoặc Gemini tự chạy câu lệnh theo lịch, gọi MCP của bạn rồi báo quảng cáo có CPA vượt ngưỡng (hoặc tự tạm dừng chúng).",

    prepare: [
      {
        title: "Gói AI có tác vụ hẹn giờ",
        detail:
          "Claude Pro / Max / Team / Enterprise, hoặc ChatGPT gói trả phí (tab Work). Gemini app chưa gọi được MCP tự thêm ở Việt Nam - dùng Gemini CLI.",
      },
      {
        title: "Tài khoản quảng cáo đã kết nối",
        detail:
          "Trang Kết nối có tài khoản cần kiểm tra, trạng thái Hoạt động.",
      },
      {
        title: "Ngưỡng CPA của bạn",
        detail:
          "Mức chi phí mỗi chuyển đổi tối đa chấp nhận được và tiền tệ của tài khoản (vd 200.000 VND).",
      },
      {
        title: "Máy luôn bật (chỉ khi cần 30 phút/lần)",
        detail:
          "Lịch trên web tối thiểu 1 giờ/lần và không cần máy bật. Dày hơn thì cần Claude Desktop (cục bộ) hoặc Gemini CLI trên máy bật 24/7.",
      },
    ],

    /** "Bạn sẽ thấy" of the four step cards (Bước 1-4 in automation.ts) */
    see: {
      mcp: "MCP mới trong danh sách MCP, kèm link để sao chép và tab Kết nối AI. Tab Tổng quan ghi đúng quyền bạn chọn.",
      builder:
        "Câu lệnh và skill tự cập nhật theo số bạn nhập; bấm Sao chép câu lệnh để dùng ở Bước 3.",
      schedule:
        "Tác vụ mới trong mục Scheduled (Claude) hoặc Scheduled của tab Work (ChatGPT), kèm giờ chạy tiếp theo.",
      monitor:
        "Sau mỗi lượt: ads_list_accounts, ads_get_report (và ads_set_status nếu Tự tắt) trong Nhật ký MCP.",
    },
    openMcpNew: "Mở Tạo MCP",

    faq: [
      {
        q: 'Báo "confirmation_required" hoặc "chưa tắt quảng cáo nào"',
        a: "MCP đang bật Xác nhận 2 bước. Chế độ Tự tắt cần một MCP riêng đã tắt Xác nhận 2 bước (MCP → tab Cấu hình). Lúc chạy theo lịch không có ai bấm đồng ý.",
      },
      {
        q: "AI báo không có tool ads_get_report hoặc không kết nối được MCP",
        a: "Kiểm tra connector còn bật cho tác vụ; MCP chưa bị tắt hoặc hết hạn (MCP → tab Bảo mật). ChatGPT: chatgpt.com/plugins → mở plugin → Refresh.",
      },
      {
        q: '"Không có quảng cáo vượt ngưỡng" dù bạn thấy CPA cao',
        a: "Quy tắc chỉ xét tài khoản cùng tiền tệ với ô Tiền tệ, và chỉ xét quảng cáo đã chi từ mức Chi tiêu tối thiểu. Kiểm tra hai ô này.",
      },
      {
        q: "Tác vụ không chạy đúng giờ",
        a: "Lịch trên web có thể trễ vài phút. Gói Free không có tác vụ hẹn giờ. Lịch cục bộ (Claude Desktop, Gemini CLI) cần máy bật và app mở.",
      },
      {
        q: 'Báo vượt "Giới hạn thao tác ghi / 10 phút"',
        a: "MCP chặn khi AI tắt quá nhiều quảng cáo trong 10 phút - đúng thiết kế. Chỉ tăng giới hạn (MCP → tab Cấu hình) khi bạn chắc quy tắc đúng.",
      },
      {
        q: "Có tốn hạn mức của gói AI không?",
        a: "Có. Mỗi lượt chạy tính như một cuộc trò chuyện. Mỗi giờ tốn hơn nhiều so với mỗi ngày.",
      },
    ],

    safety: [
      "Bắt đầu bằng chế độ Chỉ báo cáo (MCP Chỉ xem) vài ngày, đối chiếu với Trình quản lý quảng cáo rồi mới cho AI tự tắt.",
      "Chế độ Tự tắt: MCP riêng chỉ Xem + Bật/Tắt, Trần ngân sách/ngày thấp, Giới hạn thao tác ghi / 10 phút nhỏ (vd 5).",
      "Câu lệnh mẫu cấm AI bật bất cứ thứ gì; giới hạn thật nằm ở trần ngân sách và giới hạn thao tác ghi của MCP.",
      "Dừng khẩn cấp: MCP → tab Bảo mật → Tắt MCP. Dừng hẳn: xoá tác vụ hẹn giờ trong ứng dụng AI.",
      "Đặt Ngày hết hạn cho MCP chạy thử để link tự ngừng khi bạn quên.",
    ],
  },

  // ---- Tip b: "Tạo quảng cáo số lượng lớn" -----------------------------------------------------------------------
  bulk: {
    title: "Lên hàng loạt quảng cáo từ Google Drive và Google Sheet",
    description:
      "Mỗi dòng trong Google Sheet là một creative. AI đọc các dòng chờ lên, lấy ảnh, video trên Drive, tạo quảng cáo rồi ghi kết quả vào chính dòng đó.",
    who: "Đội media có nhiều ảnh, video trên Google Drive và muốn lên vài chục quảng cáo mà không phải làm tay từng cái.",
    result:
      "Quảng cáo được tạo sẵn ở trạng thái tạm dừng; sheet tự điền Đã lên, mã quảng cáo, link chiến dịch - bạn chỉ việc xem lại rồi bật.",
    flowLabel: "Luồng làm việc",
    flow: [
      {
        title: "Bạn điền sheet",
        detail: "Mỗi dòng: link ảnh / video, nền tảng, tài khoản, nội dung.",
      },
      {
        title: "AI đọc dòng chờ lên",
        detail: 'Trạng thái trống, "Chờ lên" hoặc "Chưa tạo ads".',
      },
      {
        title: "Tải ảnh, video từ Drive",
        detail: "Thẳng lên tài khoản quảng cáo, không tải trùng.",
      },
      {
        title: "Tạo quảng cáo tạm dừng",
        detail: "Bạn xem bản xem trước và đồng ý từng bước.",
      },
      {
        title: "Ghi kết quả vào sheet",
        detail: "Đã lên + mã quảng cáo + link, hoặc Lỗi + lý do.",
      },
    ],

    prepare: [
      {
        title: "Google Drive hệ thống đã được cài",
        detail:
          'Quản trị viên làm một lần ở Cài đặt → "Google Drive hệ thống". Kiểm tra: trang Kết nối → tab Google Drive có khối Email hệ thống (đuôi .iam.gserviceaccount.com).',
      },
      {
        title: "Thư mục ảnh / video đã chia sẻ và khai báo",
        detail:
          'Chia sẻ thư mục cho email hệ thống (quyền Người xem) và khai báo ở Kết nối → tab Google Drive. Hoặc để file ở chế độ "Bất kỳ ai có đường liên kết".',
      },
      {
        title: "Google Sheet theo mẫu bên dưới",
        detail:
          "Chia sẻ cho email hệ thống với quyền Người chỉnh sửa để AI ghi được trạng thái.",
      },
      {
        title: "Một MCP riêng để lên quảng cáo",
        detail:
          'Quyền Tạo mới trên nền tảng cần lên, Trần ngân sách/ngày cho từng loại tiền, bật "Cho phép ghi trạng thái vào Google Sheet", gán thư mục + sheet. Không dùng chung MCP chạy theo lịch.',
      },
      {
        title: "MCP đã được thêm vào ứng dụng AI",
        detail:
          "Claude hoặc ChatGPT trên web (xem tab Kết nối AI của MCP). Việc này làm trong cuộc trò chuyện thường, không cần đặt lịch.",
      },
    ],

    /** short safety box right under the intro */
    safetyAlertTitle: "An toàn khi lên hàng loạt",
    safetyAlert: [
      "Quảng cáo luôn được tạo **TẠM DỪNG** - chỉ chạy khi bạn tự bật.",
      "**Trần ngân sách/ngày** của MCP chặn mọi mức ngân sách cao hơn.",
      "**Xác nhận 2 bước**: bạn duyệt từng lần tải file, tạo quảng cáo.",
      "Dùng **MCP riêng** cho việc này, không cấp quyền Xoá.",
    ],

    steps: [
      {
        title: "Tạo Google Sheet từ mẫu",
        detail:
          "Chọn một trong hai cách. Nút sao chép và tải tệp nằm ở mục **Mẫu Google Sheet** bên dưới.",
        substeps: [
          "**Cách 1 - dán tiêu đề:** mở một Google Sheet trống, bấm ô **A1**, bấm **Sao chép dòng tiêu đề** rồi dán (Ctrl+V).",
          "**Cách 2 - nhập tệp mẫu:** bấm **Tải tệp mẫu CSV**. Trong Google Sheet chọn **Tệp → Nhập → Tải lên** rồi chọn tệp vừa tải.",
          "Ở hộp **Nhập tệp**: **Vị trí nhập** chọn **Chèn (các) trang tính mới**, bỏ chọn **Chuyển đổi văn bản thành số, ngày tháng và công thức** → **Nhập dữ liệu**.",
        ],
        see: "Dòng 1 có 14 cột, từ Link Drive tới Cập nhật lúc. Tệp mẫu có thêm 3 dòng ví dụ - xoá đi khi điền thật.",
        href: "#mau-sheet",
        actionLabel: "Xem mẫu sheet",
      },
      {
        title: "Điền mỗi dòng một creative",
        detail: "Một dòng = một ảnh, một video, hoặc vài ảnh cùng nội dung.",
        substeps: [
          "Dán link Drive của ảnh / video vào cột **Link Drive**. Nhiều file trong một ô: xuống dòng bằng **Ctrl+Enter** (Mac: **⌘+Enter**).",
          "Ghi **Nền tảng**, **Tài khoản QC**, **Nội dung**, **Tiêu đề**, **Link đích**.",
          "Cột **Trạng thái**: để trống, hoặc ghi **Chờ lên** / **Chưa tạo ads**.",
          "Để trống 6 cột hệ thống, từ **Mã media** tới **Cập nhật lúc** - AI tự điền.",
        ],
        see: "Mỗi creative một dòng; các cột từ Mã media tới Cập nhật lúc còn trống.",
      },
      {
        title: "Chia sẻ sheet cho email hệ thống",
        detail: "Để AI đọc được sheet và ghi lại trạng thái.",
        substeps: [
          "Ads MCP: **Kết nối → tab Google Drive** → khối **Email hệ thống** → bấm sao chép.",
          "Google Sheet: bấm **Chia sẻ** → dán email → chọn **Người chỉnh sửa**.",
          "Bỏ tick **Thông báo cho mọi người** → **Chia sẻ**.",
        ],
        see: "Email hệ thống nằm trong danh sách người có quyền truy cập, quyền Người chỉnh sửa.",
        href: "/connections?tab=drive",
        actionLabel: "Mở Kết nối → Google Drive",
      },
      {
        title: "Khai báo sheet trong Ads MCP",
        detail:
          "**Kết nối → tab Google Drive → Thêm thư mục / sheet**. Trang này có 3 bước:",
        substeps: [
          "**Loại & phạm vi**: chọn **Google Sheet**. Ở **Ai được dùng?** chọn **Công ty** (mọi người cùng dùng) hoặc **Riêng của tôi** - nhân viên chỉ có **Riêng của tôi**. Bấm **Tiếp tục**.",
          "**Chia sẻ & kiểm tra**: chọn **Email hệ thống (khuyên dùng)**. Mở đúng tab của sheet, sao chép link (có đuôi `#gid=`) và dán vào. **Dòng tiêu đề** = 1 → **Kiểm tra** → **Tiếp tục**.",
          "**Cài đặt & lưu**: xem lại **Ánh xạ cột**, rồi bật **Cho phép AI ghi trạng thái vào sheet**.",
          "Khi bật ghi, khối **Cột ghi trạng thái (nâng cao)** tự mở: kiểm tra đã chọn cột **Link bài viết**, **Link chiến dịch** → **Lưu thư mục / sheet**.",
        ],
        see: 'Khung "Đã đọc được" ghi "Người chỉnh sửa - ghi trạng thái được"; lưu xong chuyển sang trang chi tiết của sheet.',
        href: "/connections/drive/new",
        actionLabel: "Mở Thêm thư mục / sheet",
      },
      {
        title: "Khai báo thư mục ảnh / video",
        detail:
          "Làm như bước 4 nhưng chọn **Thư mục Google Drive** và dán link thư mục chứa creative.",
        substeps: [
          "Bỏ qua bước này nếu mọi file trong sheet đều chia sẻ **Bất kỳ ai có đường liên kết**.",
        ],
        see: "Khung Đã đọc được hiện số ảnh, số video, số thư mục con.",
        href: "/connections/drive/new",
        actionLabel: "Mở Thêm thư mục / sheet",
      },
      {
        title: "Tạo MCP riêng cho việc lên quảng cáo",
        detail: '**MCP → Tạo MCP**, đặt tên vd "Lên QC theo sheet".',
        substeps: [
          "Bước **Nền tảng & tài khoản**: chọn tài khoản quảng cáo. Nhóm **Ảnh, video quảng cáo (không bắt buộc)**: tick thư mục và sheet.",
          "Bước **Quyền**: bật **Tạo mới** cho nền tảng cần lên (hoặc chọn nhanh **Toàn quyền (trừ xoá)**). Khối **Google Drive**: bật **Cho phép ghi trạng thái vào Google Sheet**.",
          "Bước **Bảo vệ**: giữ **Xác nhận 2 bước cho thao tác ghi**, nhập **Ngân sách/ngày** (bắt buộc) cho từng loại tiền → **Tạo MCP**.",
        ],
        see: "Link MCP để sao chép và hướng dẫn kết nối AI.",
        href: "/mcp-servers/new",
        actionLabel: "Mở Tạo MCP",
      },
      {
        title: "Thêm MCP vào ứng dụng AI",
        detail:
          "Mở MCP vừa tạo → tab **Kết nối AI** → làm theo hướng dẫn cho Claude hoặc ChatGPT.",
        substeps: [
          'Nhớ tên bạn đặt cho connector (vd **Ads MCP**) - ô "Tên connector" của form bên dưới cần tên này.',
          "ChatGPT: mỗi lần đổi quyền MCP, vào **chatgpt.com/plugins** → mở plugin → **Refresh**.",
        ],
        see: "Ứng dụng AI liệt kê được các tool `drive_list_sources`, `drive_sheet_read`, `ads_upload_media`…",
      },
      {
        title: "Soạn câu lệnh và chạy lượt đầu",
        detail:
          "Điền form ở mục **Soạn câu lệnh** → bấm **Sao chép câu lệnh** → dán vào một cuộc trò chuyện mới.",
        substeps: [
          "ChatGPT: gõ **@** rồi chọn plugin của MCP trước khi dán.",
          "Lượt đầu chỉ nên 2-3 dòng để kiểm tra.",
        ],
        see: "AI báo các dòng sẽ làm, các dòng có vấn đề, rồi hiện bản xem trước mỗi lần tải file / tạo quảng cáo để bạn đồng ý.",
        href: "#soan-cau-lenh",
        actionLabel: "Tới form soạn câu lệnh",
      },
      {
        title: "Duyệt rồi tự bật quảng cáo",
        detail:
          "Bấm **Link chiến dịch** trong sheet (hoặc mở Trình quản lý quảng cáo), xem lại nội dung, ảnh, ngân sách, đối tượng rồi tự bật.",
        substeps: ["Chạy lượt tiếp theo cho các dòng còn lại."],
        see: "Quảng cáo mới ở trạng thái tạm dừng, đang chờ nền tảng duyệt.",
      },
    ],

    sheet: {
      title: "Mẫu Google Sheet",
      description:
        "Dùng đúng tên cột dưới đây thì hệ thống tự nhận ra, không cần ánh xạ. Thứ tự cột có thể khác, tên khác thì chọn lại ở bước Ánh xạ cột.",
      headerLabel: "Dòng tiêu đề (dán vào ô A1)",
      headerHelp:
        "Các tên cột cách nhau bằng phím Tab nên khi dán vào ô A1, mỗi tên tự vào một ô.",
      copyHeader: "Sao chép dòng tiêu đề",
      download: "Tải tệp mẫu CSV",
      downloadHelp:
        "Tệp CSV (UTF-8) có dòng tiêu đề + 3 dòng ví dụ: ảnh Meta, video TikTok kèm ảnh bìa, và nhiều ảnh trong một ô (mỗi ảnh một quảng cáo).",
      downloaded: "Đã tải tệp mẫu",
      columnsTitle: "Ý nghĩa từng cột",
      columnsLabel: "Các cột của sheet",
      whoYou: "Bạn điền",
      whoSystem: "Hệ thống ghi",
      whoBoth: "Bạn + hệ thống",
      legendLabel: "Màu các ô tiêu đề:",
      required: "Bắt buộc",
      columns: [
        {
          name: "Link Drive",
          who: "you",
          required: true,
          detail:
            "Link file trên Google Drive. Nhiều file trong một ô (video + ảnh bìa, nhiều ảnh): mỗi link một dòng trong ô, tối đa 10 link.",
        },
        {
          name: "Tên creative",
          who: "you",
          detail: "Tên đặt cho media và quảng cáo.",
        },
        {
          name: "Nền tảng",
          who: "you",
          detail:
            "Meta (hoặc Facebook, FB, Instagram, IG) · TikTok · OpenAI (ChatGPT). Không phân biệt hoa thường.",
        },
        {
          name: "Tài khoản QC",
          who: "you",
          detail:
            "ID (khuyên dùng) hoặc tên tài khoản quảng cáo đúng như trong Ads MCP. Tài khoản phải nằm trong MCP.",
        },
        {
          name: "Nội dung",
          who: "you",
          detail: "Nội dung chính của quảng cáo (primary text).",
        },
        { name: "Tiêu đề", who: "you", detail: "Tiêu đề quảng cáo." },
        {
          name: "Link đích",
          who: "you",
          detail: "Trang đích khi khách bấm vào quảng cáo (có thể gắn UTM).",
        },
        {
          name: "Trạng thái",
          who: "both",
          detail:
            'Trống, "Chờ lên" hoặc "Chưa tạo ads" = cần lên. Hệ thống ghi "Đang xử lý", "Đã lên" hoặc "Lỗi".',
        },
        {
          name: "Mã media",
          who: "system",
          detail: "Mã ảnh / video trên nền tảng sau khi tải lên.",
        },
        {
          name: "Mã quảng cáo",
          who: "system",
          detail: "Mã các quảng cáo đã tạo từ dòng này.",
        },
        {
          name: "Link bài viết",
          who: "system",
          detail:
            "Link bài viết / bài quảng cáo nếu AI có link thật. Có thể để trống.",
        },
        {
          name: "Link chiến dịch",
          who: "system",
          detail:
            "Link mở chiến dịch trong trình quản lý quảng cáo (vd Meta Ads Manager) để bạn duyệt nhanh.",
        },
        {
          name: "Ghi chú hệ thống",
          who: "system",
          detail: 'Lý do lỗi, hoặc ghi chú như "Quảng cáo đang tạm dừng".',
        },
        {
          name: "Cập nhật lúc",
          who: "system",
          detail:
            "Giờ Việt Nam + tên MCP, vd 10/10/2026 14:05 · MCP Lên QC theo sheet.",
        },
      ],
      statusTitle: "Giá trị cột Trạng thái",
      statuses: [
        {
          value: "Chờ lên",
          aliases: 'Trống, "Chưa tạo ads", "Chưa tạo", "Chưa lên"',
          detail:
            "Dòng cần lên. AI chỉ đọc các dòng này (trừ khi bạn bảo khác).",
        },
        {
          value: "Đang xử lý",
          aliases: "",
          detail: "AI đang làm dòng này. Lượt sau AI bỏ qua dòng này.",
        },
        {
          value: "Đã lên",
          aliases: '"Đã tạo ads", "Đã tạo"',
          detail: "Đã tạo quảng cáo (tạm dừng).",
        },
        {
          value: "Lỗi",
          aliases: "",
          detail:
            'Xem lý do ở Ghi chú hệ thống. Sửa xong, đổi lại thành "Chờ lên".',
        },
      ],
      aliasesLabel: "Cũng nhận:",
    },

    builder: {
      title: "Soạn câu lệnh lên quảng cáo",
      description:
        "Điền vài thông tin, câu lệnh và skill bên dưới tự cập nhật. Dán câu lệnh vào một cuộc trò chuyện mới với Claude hoặc ChatGPT.",
      sheetLabel: "Tên Google Sheet trong Ads MCP",
      sheetPlaceholder: "Vd: Kế hoạch creative T10",
      sheetHelp:
        "Tên hiển thị khi khai báo. Để trống nếu MCP chỉ có một sheet.",
      batchLabel: "Số dòng mỗi lượt",
      batchHelp:
        "1-20 dòng. Nên 5-10 để dễ kiểm tra và không bị quá thời gian.",
      platformLabel: "Nền tảng",
      platforms: {
        sheet: "Theo cột Nền tảng",
        meta: "Meta",
        tiktok: "TikTok",
        openai_ads: "OpenAI Ads",
      },
      platformHelp:
        "Google Ads chưa hợp để lên hàng loạt bằng ảnh, video (xem phần câu hỏi bên dưới).",
      accountLabel: "Tài khoản quảng cáo",
      accountPlaceholder: "Để trống = theo cột Tài khoản QC",
      accountHelp: "Tên hoặc ID. Điền khi mọi dòng lên cùng một tài khoản.",
      structureLabel: "Chiến dịch và nhóm quảng cáo",
      structures: {
        existing: {
          title: "Dùng chiến dịch có sẵn",
          hint: "Quảng cáo mới vào chiến dịch / nhóm bạn đã tạo.",
        },
        new: {
          title: "Tạo chiến dịch mới",
          hint: "AI tạo 1 chiến dịch + 1 nhóm cho mỗi tài khoản.",
        },
      },
      campaignLabel: "Tên chiến dịch",
      campaignPlaceholderExisting: "Vd: Ra mắt serum",
      campaignPlaceholderNew: "Vd: Lên QC theo sheet T10",
      campaignHelpExisting: "Để trống thì AI hỏi bạn trong cuộc trò chuyện.",
      campaignHelpNew: "Tên chiến dịch AI sẽ tạo (tạm dừng).",
      groupLabel: "Tên nhóm quảng cáo",
      groupPlaceholder: "Vd: Nữ 25-34",
      groupHelp: "Để trống = nhóm đang có của chiến dịch.",
      budgetLabel: "Ngân sách/ngày",
      budgetHelp:
        "Vd 200000 hoặc 200.000 (đơn vị chính của tiền tệ). Không vượt Trần ngân sách/ngày của MCP.",
      currencyLabel: "Tiền tệ",
      currencyHelp: "Mã 3 chữ cái, vd VND, USD.",
      writebackLabel: "Ghi trạng thái vào sheet",
      writebackHelp:
        "Nên bật. Tắt thì sheet không đổi và lượt sau AI sẽ đọc lại các dòng cũ.",
      preview: (n: number, where: string) =>
        `Mỗi lượt AI làm tối đa ${n} dòng chờ lên, ${where}. Quảng cáo luôn tạo ở trạng thái tạm dừng.`,
      previewExisting: "đưa quảng cáo vào chiến dịch có sẵn",
      previewNew: (budget: string) =>
        `tạo chiến dịch mới với ngân sách ${budget}/ngày`,
      promptHelp:
        'Dán vào một cuộc trò chuyện mới. Chạy xong một lượt, nhắn "chạy lượt tiếp theo" để làm các dòng còn lại.',
      promptLabel: "Câu lệnh lên quảng cáo từ Google Sheet",
    },

    check: [
      {
        title: "Trong Google Sheet",
        detail:
          'Trạng thái "Đã lên", có Mã media, Mã quảng cáo, Link chiến dịch và Cập nhật lúc. Dòng "Lỗi" có lý do ở Ghi chú hệ thống.',
      },
      {
        title: "Trong Nhật ký MCP",
        detail:
          "Từng lệnh: ads_upload_media, lệnh tạo quảng cáo, drive_sheet_update_rows kèm giá trị trước → sau của từng ô.",
      },
      {
        title: "Trong Trình quản lý quảng cáo",
        detail:
          "Quảng cáo mới ở trạng thái tạm dừng / chờ duyệt. Kiểm tra rồi mới bật.",
      },
    ],
    openLogs: "Mở Nhật ký MCP",
    openDrive: "Mở tab Google Drive",

    tipsTitle: "Mẹo để chạy trơn tru",
    tips: [
      "Chạy lượt nhỏ 5-10 dòng: mỗi lệnh của AI có giới hạn thời gian, mỗi MCP chỉ được khoảng 20 lượt đọc + 20 lượt ghi Google Sheet mỗi phút, và mỗi lần tải file / tạo quảng cáo đều cần bạn đồng ý khi bật Xác nhận 2 bước. Lượt nhỏ dễ kiểm tra, lỗi thì làm lại nhanh.",
      'Muốn đồng ý một lần: nhắn "cho tôi xem trước toàn bộ rồi tôi đồng ý một lần" - AI trình bày danh sách trước khi làm.',
      "Video lớn (TikTok trên 10 MB, Meta trên 50 MB) được tải ở chế độ nền vài phút: AI nhận mã lượt tải và kiểm tra lại bằng ads_get_media_upload. Mỗi MCP tải nền tối đa 3 video cùng lúc.",
      "Không tải trùng: file đã tải lên đúng tài khoản đó trước đây sẽ dùng lại mã cũ ngay.",
      "Video trên Meta và TikTok cần ảnh bìa: để link video và link ảnh bìa trong cùng ô Link Drive.",
      "Đừng sắp xếp, lọc, chèn hay xoá dòng trong lúc AI đang chạy - dòng bị lệch sẽ bị bỏ qua để tránh ghi nhầm.",
      "Mã tài khoản dài (TikTok 19 chữ số) bị Google Sheet đổi thành số mũ: chọn cột Tài khoản QC → Định dạng → Số → Văn bản thuần túy trước khi gõ, hoặc ghi tên tài khoản.",
    ],

    faq: [
      {
        q: 'Dòng bị bỏ qua với "row_moved" - "Dòng trong sheet đã thay đổi"',
        a: 'Có người chèn, xoá hoặc sắp xếp dòng trong lúc AI làm. Nhắn AI "đọc lại sheet rồi ghi lại trạng thái".',
      },
      {
        q: '"Google Sheet đang bận" hoặc "MCP này đã dùng hết 20 lượt đọc / ghi Google Sheet trong một phút"',
        a: "Đợi khoảng 1 phút rồi chạy tiếp. Giảm số dòng mỗi lượt; câu lệnh mẫu đã gộp việc ghi nhiều dòng vào một lần.",
      },
      {
        q: '"Không tìm thấy file trong các thư mục được cấp cho MCP này"',
        a: "File không nằm trong thư mục đã gán cho MCP và không phải link công khai. Gán thư mục vào MCP (tab Cấu hình) hoặc chuyển file vào thư mục đã gán.",
      },
      {
        q: '"File chưa được chia sẻ công khai" hoặc "MCP này không cho phép dùng link Google Drive công khai"',
        a: 'Đổi chia sẻ file thành "Bất kỳ ai có đường liên kết" và bật "Cho phép dùng link Drive công khai" trong MCP - hoặc đơn giản hơn: để file trong thư mục đã khai báo.',
      },
      {
        q: 'Báo cần quyền "Tạo mới", hoặc AI không thấy tool drive_*',
        a: "Mở MCP → tab Cấu hình → bật quyền Tạo mới cho nền tảng đó và gán thư mục / sheet. ChatGPT: chatgpt.com/plugins → mở plugin → Refresh.",
      },
      {
        q: '"vượt trần … mà MCP này cho phép" hoặc "MCP này chưa đặt trần ngân sách/ngày cho tiền tệ …"',
        a: 'Ngân sách vượt Trần ngân sách/ngày của MCP. Giảm ngân sách trong form, hoặc chủ MCP vào tab Cấu hình → "Trần chi tiêu theo tiền tệ" để nâng / nhập trần.',
      },
      {
        q: '"Sheet này không bật ghi trạng thái"',
        a: 'Bật "Cho phép AI ghi trạng thái vào sheet" ở trang chi tiết sheet (email hệ thống cần quyền Người chỉnh sửa) và "Cho phép ghi trạng thái vào Google Sheet" trong MCP.',
      },
      {
        q: "Tài khoản QC không thuộc MCP, hoặc trùng tên",
        a: "Thêm tài khoản đó vào MCP (bước Nền tảng & tài khoản), hoặc ghi ID tài khoản thay cho tên.",
      },
      {
        q: 'Dòng kẹt ở "Đang xử lý"',
        a: 'Lượt chạy bị dừng giữa chừng (hết thời gian, đóng cuộc trò chuyện) hoặc video còn tải nền. Hỏi AI "các lượt tải video nền gần đây thế nào?"; nếu chưa có quảng cáo thì đổi Trạng thái về "Chờ lên".',
      },
      {
        q: "Lên được trên Google Ads không?",
        a: "Chưa nên: tool tạo quảng cáo Google Ads hiện là quảng cáo tìm kiếm (chữ), video phải là video YouTube. Sheet hợp nhất cho Meta, TikTok và OpenAI Ads (OpenAI Ads chỉ nhận ảnh).",
      },
    ],

    safety: [
      "Quảng cáo, chiến dịch, nhóm do AI tạo luôn ở trạng thái tạm dừng - không có gì tự chạy và tiêu tiền cho tới khi bạn bật (riêng chiến dịch TikTok GMV Max chạy ngay, chỉ tạo được khi quản trị viên bật quyền GMV Max cho MCP).",
      "Giữ Xác nhận 2 bước cho MCP này: AI phải cho bạn xem trước từng lần tải file và tạo quảng cáo.",
      "Trần ngân sách/ngày là bắt buộc khi MCP có quyền Tạo mới: AI không đặt được ngân sách vượt mức này.",
      "MCP riêng, chỉ Xem + Tạo mới, không cấp Xoá. Đặt Ngày hết hạn nếu chỉ dùng cho một đợt.",
      "AI chỉ ghi vào các cột hệ thống của sheet. Chữ trong sheet là dữ liệu: AI không làm theo câu lệnh ai đó viết vào ô.",
    ],
  },

  // ---- Tip c: "Tự động kiểm tra quảng cáo" -----------------------------------------------------------------------
  adCheck: {
    title: "Báo cáo quảng cáo bằng đơn hàng thật, gửi vào Telegram",
    description:
      "Kết hợp số liệu quảng cáo của Ads MCP với đơn hàng từ phần mềm bán hàng (POS) để biết quảng cáo nào ra đơn thật.",
    who: "Chủ shop, trưởng nhóm quảng cáo muốn mỗi sáng biết chiến dịch nào ra đơn, chiến dịch nào chỉ tốn tiền - không cần mở máy tính.",
    result:
      "Theo lịch, AI lấy chi tiêu quảng cáo và đơn hàng thật, tính ROAS / chi phí mỗi đơn thật, chấm Tốt / Cần xem / Chưa ra đơn rồi gửi bản tóm tắt vào Telegram.",
    flowLabel: "Luồng làm việc",
    flow: [
      {
        title: "Lịch trên web tự chạy",
        detail: "Máy chủ của Claude / ChatGPT chạy, máy bạn tắt cũng được.",
      },
      {
        title: "Lấy chi tiêu quảng cáo",
        detail: "Từ Ads MCP (chỉ xem) - theo chiến dịch.",
      },
      {
        title: "Lấy đơn hàng thật",
        detail: "Từ MCP bán hàng: tổng tiền, UTM.",
      },
      {
        title: "Phân tích theo skill",
        detail: "ROAS thật, chi phí mỗi đơn, so với mục tiêu.",
      },
      {
        title: "Gửi Telegram",
        detail: "Bản tóm tắt ngắn + đề xuất, không tự sửa quảng cáo.",
      },
    ],

    why: {
      title: "Vì sao nên đặt lịch trên web",
      description:
        "Tác vụ hẹn giờ trên web chạy ở máy chủ của hãng AI, không cần máy tính của bạn bật 24/7.",
      points: [
        {
          title: "Lịch trên web",
          detail:
            "Claude (claude.ai), ChatGPT (chatgpt.com) chạy tác vụ trên máy chủ của họ: máy bạn tắt, ngủ hay mất mạng vẫn chạy và báo kết quả.",
        },
        {
          title: "Lịch trên máy tính",
          detail:
            "Claude Desktop chạy cục bộ, Gemini CLI, Task Scheduler / cron cần máy bật 24/7 và app luôn mở; máy ngủ là lỡ lượt chạy.",
        },
        {
          title: "Tần suất",
          detail:
            "Lịch trên web tối thiểu 1 giờ/lần - thừa đủ cho báo cáo mỗi sáng hoặc theo giờ.",
        },
      ],
      appsTitle: "Ứng dụng nào làm được (kiểm tra 10/10/2026)",
      appsLabel: "So sánh ứng dụng AI",
      apps: [
        {
          name: "Claude trên web (claude.ai)",
          badge: "Khuyên dùng",
          tone: "good",
          points: [
            "Chạy trên máy chủ Anthropic, tối thiểu mỗi giờ.",
            "Một tác vụ dùng được mọi connector đã kết nối: Ads MCP + MCP bán hàng cùng lúc.",
            "Gói Pro, Max, Team, Enterprise (gói Free không có tác vụ hẹn giờ).",
            "Không gửi email kết quả - câu lệnh mẫu gửi qua Telegram.",
          ],
        },
        {
          name: "ChatGPT trên web (chatgpt.com, tab Work)",
          badge: "Chạy thử trước",
          tone: "try",
          points: [
            "Chạy trên máy chủ OpenAI, gói trả phí tối đa mỗi giờ (Free / Go không có Work).",
            "OpenAI chưa ghi rõ tác vụ hẹn giờ gọi được MCP tự thêm: tạo tác vụ, bấm chạy thử và xem Nhật ký MCP trước khi tin dùng.",
            "Trong cuộc trò chuyện thường dùng được nhiều app: gõ @ chọn từng app.",
          ],
        },
        {
          name: "Gemini app (Spark Schedules)",
          badge: "Chưa dùng được ở Việt Nam",
          tone: "no",
          points: [
            "Spark đã có ở Việt Nam (gói Google AI Pro hoặc Ultra) và chạy trên máy chủ Google.",
            "Nhưng Custom apps (MCP tự thêm) chỉ mở cho người dùng ở Mỹ - lịch Spark chưa gọi được Ads MCP hay MCP bán hàng.",
          ],
        },
        {
          name: "Gemini CLI trên máy chủ luôn bật",
          badge: "Thay thế",
          tone: "alt",
          points: [
            "Cài Gemini CLI trên một VPS / máy luôn bật, thêm cả hai MCP bằng gemini mcp add, đặt lịch bằng cron.",
            "Dùng được ở Việt Nam, nhiều MCP cùng lúc; máy phải bật 24/7.",
          ],
        },
      ],
      appsNote:
        "Claude Desktop (chạy cục bộ) cũng dùng được hai MCP nhưng máy phải luôn bật và app luôn mở.",
      stepsLink: "Xem cách đặt lịch từng ứng dụng",
    },

    /** yellow box in the intro: the tip needs a sales MCP */
    posAlertTitle: "Mẹo này cần một MCP bán hàng (POS)",
    posAlert:
      "Pancake POS, Nhanh.vn, KiotViet, Sapo, Haravan chưa có MCP chính thức. Chưa có MCP bán hàng thì đọc mục **MCP bán hàng (POS)** trước khi làm.",
    posAlertLink: "Xem mục MCP bán hàng",

    pos: {
      title: "MCP bán hàng (POS)",
      description:
        "Báo cáo cần một MCP đọc được đơn hàng từ phần mềm bán hàng của bạn. Ads MCP không có sẵn phần này.",
      needTitle: "MCP bán hàng cần trả được",
      needs: [
        "**Đơn hàng theo khoảng ngày** (lọc theo ngày tạo đơn).",
        "Mỗi đơn có **mã đơn**, **thời gian tạo**, **trạng thái** (để bỏ đơn huỷ / hoàn) và **tổng tiền** kèm tiền tệ.",
        "**UTM** của đơn (`utm_source`, `utm_campaign`) hoặc trường nguồn / ghi chú có UTM - để biết đơn đến từ chiến dịch nào.",
        "Chỉ cần **quyền đọc**. Không cần tên, số điện thoại, địa chỉ khách.",
      ],
      statusTitle: "Chưa có MCP chính thức",
      statusNote:
        "Tới ngày 10/10/2026, Pancake POS, Nhanh.vn, KiotViet, Sapo, Haravan **chưa có MCP chính thức** của chính hãng.",
      optionsTitle: "Hai cách để có MCP bán hàng",
      options: [
        {
          title: "Dùng MCP của bên thứ ba",
          detail:
            "Đã có vài MCP không chính thức cho Pancake POS, KiotViet (trên GitHub, các trang danh bạ MCP). **Tự kiểm tra độ tin cậy**: ai làm, mã nguồn có công khai không, dữ liệu đi qua máy chủ nào. Chỉ dùng khoá API chỉ đọc.",
        },
        {
          title: "Nhờ lập trình viên dựng MCP nhỏ",
          detail:
            "Gói API của phần mềm bán hàng (Pancake POS Open API, Nhanh.vn Open API, KiotViet Public API, Haravan API…) thành MCP có một tool **đọc đơn hàng theo ngày** trả các trường ở trên. Chạy trên máy chủ của bạn với link https để thêm vào Claude.",
        },
      ],
      nextNote:
        "Có link MCP bán hàng rồi thì thêm vào Claude như bước 3 ở mục **Làm từng bước**.",
    },

    prepare: [
      {
        title: "Một MCP riêng, chỉ xem",
        detail:
          'Quyền "Chỉ xem" cho mọi nền tảng, chỉ chọn tài khoản cần báo cáo. AI không thể sửa quảng cáo dù câu lệnh sai.',
      },
      {
        title: "Kết nối Telegram",
        detail:
          'Kết nối → tab Telegram → "Thêm kết nối Telegram" (tạo bot ở @BotFather, thêm bot vào nhóm). Bấm "Gửi tin thử" để chắc bot gửi đúng nhóm.',
      },
      {
        title: "Gán Telegram cho MCP",
        detail:
          'Bước "Nền tảng & tài khoản" → nhóm "Thông báo (không bắt buộc)" → chọn kết nối Telegram. Bước "Quyền" → khối Telegram bật "AI được gửi tin".',
      },
      {
        title: "Một MCP bán hàng (POS)",
        detail:
          "Chưa có MCP chính thức: dùng MCP bên thứ ba (tự kiểm tra độ tin cậy, chỉ cấp quyền đọc) hoặc nhờ lập trình viên dựng. Xem mục MCP bán hàng (POS).",
      },
      {
        title: "UTM trên link quảng cáo",
        detail:
          "UTM là đoạn đuôi gắn vào link quảng cáo để phần mềm bán hàng ghi lại đơn đến từ chiến dịch nào. Vd ?utm_source=facebook&utm_campaign={{campaign.id}} (Meta tự điền mã chiến dịch). Kiểm tra đơn trên phần mềm bán hàng có lưu UTM.",
      },
      {
        title: "Cả hai MCP trong cùng một ứng dụng AI",
        detail:
          "Vd Claude trên web: thêm Ads MCP và MCP bán hàng thành hai custom connector của cùng tài khoản.",
      },
    ],

    steps: [
      {
        title: "Tạo MCP chỉ xem và gán Telegram",
        detail: '**MCP → Tạo MCP**, đặt tên vd "Báo cáo đơn hàng".',
        substeps: [
          "Bước **Nền tảng & tài khoản**: chọn tài khoản. Nhóm **Thông báo (không bắt buộc)**: chọn kết nối Telegram.",
          "Bước **Quyền**: chọn nhanh **Chỉ xem**. Khối **Telegram**: bật **AI được gửi tin**.",
          "Bước **Bảo vệ**: giữ mặc định → **Tạo MCP**.",
        ],
        see: "Link MCP. Tab Tổng quan của MCP ghi Kết nối Telegram đã chọn.",
        href: "/mcp-servers/new",
        actionLabel: "Mở Tạo MCP",
      },
      {
        title: "Thêm Ads MCP vào Claude",
        detail: "Trên **claude.ai**:",
        substeps: [
          "**Customize → Connectors** → **+ Add** → **Add custom connector**.",
          "Đặt tên (vd **Ads MCP**), dán link MCP → **Continue**.",
          "**Authentication** chọn **No sign in** → **Add**.",
        ],
        see: "Connector mới trong danh sách Connectors.",
      },
      {
        title: "Thêm MCP bán hàng vào Claude",
        detail: "Lặp lại bước 2 với link (và cách đăng nhập) của MCP bán hàng.",
        substeps: [
          "Họ yêu cầu đăng nhập: bấm **Connect** và đăng nhập tài khoản cửa hàng.",
          "Chưa có MCP bán hàng: xem mục **MCP bán hàng (POS)**.",
        ],
        see: "Hai connector cùng ở trạng thái đã kết nối.",
        href: "#mcp-ban-hang",
        actionLabel: "Xem mục MCP bán hàng",
      },
      {
        title: "Cho phép tool chạy không cần bấm duyệt",
        detail: "Lúc chạy theo lịch không có ai bấm duyệt.",
        substeps: [
          "**Customize → Connectors** → mở từng connector → **Tool permissions**.",
          "Các tool đọc (`ads_list_accounts`, `ads_get_report`, `telegram_list_channels`, tool đọc đơn hàng) và `telegram_send_message`: chọn **Always allow**.",
          "Tool ghi khác của MCP bán hàng: để nguyên hoặc chọn **Block**.",
        ],
        see: 'Các tool trên ở "Always allow".',
      },
      {
        title: "Chạy thử trong một cuộc trò chuyện",
        detail:
          "Điền form ở mục **Soạn câu lệnh** → **Sao chép câu lệnh** → dán vào cuộc trò chuyện mới.",
        substeps: [
          "Đối chiếu số liệu với Trình quản lý quảng cáo và phần mềm bán hàng.",
        ],
        see: 'Tin trong nhóm Telegram, tiêu đề "Tin từ AI · MCP <tên>", có phần Tổng, Tốt, Cần xem, Đề xuất.',
        href: "#soan-cau-lenh",
        actionLabel: "Tới form soạn câu lệnh",
      },
      {
        title: "(Nên làm) Cài skill",
        detail:
          "Skill giữ các bước cố định, câu lệnh hẹn giờ chỉ còn một dòng.",
        substeps: [
          "**Settings → Capabilities**: bật **Code execution and file creation**.",
          "Lưu SKILL.md (tab **Skill** của form) vào thư mục `bao-cao-qc-don-hang`, nén cả thư mục thành .zip.",
          "**Customize → Skills** → **+** → **+ Create skill** → **Upload a skill** → chọn tệp .zip.",
        ],
        see: "Skill bao-cao-qc-don-hang trong danh sách Skills.",
      },
      {
        title: "Đặt lịch",
        detail: "Trong cuộc trò chuyện vừa chạy thử:",
        substeps: [
          "Dán câu lệnh (hoặc câu lệnh ngắn gọi skill).",
          "Nhắn thêm **Câu đặt lịch** (ngay dưới câu lệnh trong form).",
          "Kiểm tra tên, lịch, hướng dẫn Claude đề xuất → **Schedule**.",
          "Cách khác: thanh bên **Scheduled** → **New task** → **Set up manually**.",
        ],
        see: "Tác vụ mới trong mục Scheduled với giờ chạy bạn chọn.",
      },
      {
        title: "Theo dõi vài lượt đầu",
        detail:
          "Mở mục **Scheduled** xem từng lượt chạy, đối chiếu **Nhật ký MCP**. Chỉ để chạy lâu dài khi số liệu khớp.",
        see: "Mỗi lượt có `ads_list_accounts`, `ads_get_report`, `telegram_send_message` - không có lệnh ghi lên quảng cáo.",
        href: "/logs",
        actionLabel: "Mở Nhật ký MCP",
      },
    ],

    builder: {
      title: "Soạn câu lệnh và skill báo cáo",
      description:
        "Điền thông tin của bạn, câu lệnh và SKILL.md bên dưới tự cập nhật. Câu lệnh chỉ đọc số liệu và gửi Telegram, không thay đổi quảng cáo.",
      periodLabel: "Kỳ báo cáo",
      periods: {
        yesterday: "Hôm qua",
        last_7d: "7 ngày gần nhất",
        today: "Hôm nay (tới lúc chạy)",
      },
      periodHelp:
        "Báo cáo buổi sáng nên chọn Hôm qua: số liệu ngày trước đã gần đủ.",
      accountsLabel: "Tài khoản quảng cáo",
      accountsPlaceholder: "Để trống = mọi tài khoản trong MCP",
      accountsHelp: "Tên hoặc ID, cách nhau bằng dấu phẩy.",
      targetLabel: "Mục tiêu",
      targets: {
        roas: {
          title: "ROAS tối thiểu",
          hint: "Doanh thu thật / chi tiêu, vd 3.",
        },
        cpa: {
          title: "Chi phí mỗi đơn tối đa",
          hint: "Chi tiêu / số đơn thật, vd 80000.",
        },
      },
      roasValueLabel: "Mức ROAS cần đạt",
      roasValueHelp:
        "Vd 3 nghĩa là 1 đồng quảng cáo mang về 3 đồng doanh thu. Số lẻ: 2,5.",
      cpaValueLabel: "Mức chi phí mỗi đơn tối đa",
      cpaValueHelp: "Vd 80000 hoặc 80.000 (đơn vị chính của tiền tệ).",
      currencyLabel: "Tiền tệ của đơn hàng",
      currencyHelp: "Chỉ so ROAS với tài khoản quảng cáo cùng tiền tệ.",
      minSpendLabel: "Chi tiêu tối thiểu để chấm",
      minSpendHelp:
        "Chiến dịch chi ít hơn mức này chỉ được đếm, chưa chấm Tốt / Cần xem. Vd 200000 hoặc 200.000.",
      matchLabel: "Cách khớp đơn hàng với quảng cáo",
      matches: {
        utm_id: "UTM ghi mã chiến dịch (khuyên dùng)",
        utm_name: "UTM ghi tên chiến dịch",
        product: "Theo sản phẩm (đơn không có UTM)",
      },
      matchHelp:
        "UTM là đoạn đuôi của link quảng cáo (vd ?utm_campaign=123) mà phần mềm bán hàng lưu cùng đơn. Ghi mã chiến dịch là chính xác nhất vì mã không đổi khi bạn đổi tên chiến dịch.",
      posLabel: "Phần mềm bán hàng",
      pos: {
        pancake: "Pancake POS",
        nhanh: "Nhanh.vn",
        kiotviet: "KiotViet",
        sapo: "Sapo",
        haravan: "Haravan",
        other: "Khác",
      },
      posHelp: "Chỉ để ghi tên vào câu lệnh. Cần một MCP bán hàng đã kết nối.",
      frequencyLabel: "Lịch chạy",
      frequencies: { daily: "Mỗi ngày", hourly: "Mỗi giờ" },
      timeLabel: "Giờ chạy",
      timeHelp: "Giờ Việt Nam. Nên 8-9 giờ sáng.",
      telegramLabel: "Tên kết nối Telegram",
      telegramPlaceholder: "Để trống = kết nối duy nhất của MCP",
      telegramHelp: "Đúng tên đặt ở Kết nối → tab Telegram.",
      preview: (target: string, schedule: string) =>
        `Mục tiêu: ${target}. Lịch đề xuất: ${schedule}.`,
      promptHelp:
        "Dán vào ô hướng dẫn của tác vụ hẹn giờ. Không cần cài skill.",
      promptLabel: "Câu lệnh báo cáo quảng cáo bằng đơn hàng thật",
      scheduleTitle: "Câu đặt lịch (Claude)",
      scheduleHelp:
        "Gửi ngay sau câu lệnh, trong cùng cuộc trò chuyện, để Claude đề xuất lịch. Không đưa câu này vào nội dung tác vụ.",
      scheduleLabel: "Câu nhắn để đặt lịch",
    },

    check: [
      {
        title: "Trong Telegram",
        detail:
          'Tin có tiêu đề "Tin từ AI · MCP <tên MCP>" đúng giờ bạn đặt (lịch trên web có thể trễ vài phút).',
      },
      {
        title: "Trong Nhật ký MCP",
        detail:
          "Mỗi lượt: ads_list_accounts, ads_get_report, telegram_list_channels, telegram_send_message. Không có lệnh ghi lên quảng cáo.",
      },
      {
        title: "Trong ứng dụng AI",
        detail:
          "Claude: mục Scheduled, mỗi lượt là một phiên riêng. ChatGPT: mục Scheduled của Work.",
      },
    ],
    openLogs: "Mở Nhật ký MCP",
    openTelegram: "Mở tab Telegram",

    faq: [
      {
        q: "Số đơn thật khác số chuyển đổi nền tảng báo",
        a: 'Bình thường: nền tảng tính theo cửa sổ ghi nhận (sau khi bấm / xem), còn phần mềm bán hàng chỉ ghi đơn thật. Đơn không có UTM vào nhóm "Không rõ nguồn". Chênh lệch quá lớn → kiểm tra UTM và pixel.',
      },
      {
        q: 'Báo cáo "Hôm qua" nên chạy lúc mấy giờ?',
        a: "Khoảng 8-9 giờ sáng. TikTok cập nhật chậm khoảng 30 phút tới 2 giờ, Google Ads 1-3 giờ, Meta còn ghi nhận chuyển đổi muộn.",
      },
      {
        q: "AI có tự tắt quảng cáo dở không?",
        a: 'Không. MCP chỉ xem và câu lệnh chỉ đề xuất. Muốn AI tự tạm dừng quảng cáo, xem mẹo "Chạy tự động".',
      },
      {
        q: "Tài khoản quảng cáo dùng USD, đơn hàng tính VND",
        a: "Ads MCP không quy đổi và không cộng chéo tiền tệ. Tài khoản khác tiền tệ với đơn hàng chỉ được báo chi tiêu, không tính ROAS.",
      },
      {
        q: "Không nhận được tin Telegram",
        a: 'Thử "Gửi tin thử" ở kết nối Telegram; kiểm tra MCP đã chọn kết nối đó và bật "AI được gửi tin"; xem lỗi của telegram_send_message trong Nhật ký MCP (vd vượt giới hạn tin mỗi giờ).',
      },
      {
        q: "Tác vụ hẹn giờ báo lỗi ở MCP bán hàng",
        a: "Thường do phiên đăng nhập của connector bán hàng hết hạn: mở Customize → Connectors, kết nối lại rồi bấm chạy thử tác vụ.",
      },
      {
        q: "Có tốn hạn mức của gói AI không?",
        a: "Có. Mỗi lượt chạy tính vào hạn mức như một cuộc trò chuyện. Lịch mỗi ngày tốn ít hơn nhiều so với mỗi giờ.",
      },
    ],

    safety: [
      "MCP chỉ xem: AI không thay đổi được quảng cáo dù câu lệnh hay dữ liệu bị sai.",
      "Đơn hàng có thông tin khách: câu lệnh chỉ lấy mã đơn, tổng tiền, UTM - không đưa tên, số điện thoại, địa chỉ vào báo cáo hay Telegram.",
      "MCP bán hàng của bên thứ ba đọc được dữ liệu cửa hàng: chọn nhà cung cấp tin cậy, chỉ cấp quyền đọc, thu hồi khi không dùng.",
      "Chỉ thêm bot vào nhóm Telegram gồm người cần xem báo cáo.",
      "Ai có link MCP đều dùng được nó. Không dán link vào tác vụ chia sẻ cho người khác.",
    ],
  },
}
