// Chuỗi giao diện tiếng Việt - nhóm "mcp". Chỉ agent sở hữu nhóm này sửa file này.
export const mcp = {
  meta: {
    listTitle: "MCP",
    newTitle: "Tạo MCP",
    detailTitle: "Chi tiết MCP",
  },

  list: {
    title: "MCP",
    description:
      "Tạo link MCP để Claude, ChatGPT, Gemini điều khiển quảng cáo trong phạm vi bạn cho phép.",
    create: "Tạo MCP",
    tableLabel: "Danh sách MCP",
    searchPlaceholder: "Tìm theo tên MCP…",
    searchLabel: "Tìm MCP",
    filterStatus: "Trạng thái",
    filterPlatform: "Nền tảng",
    /** Apify used by the MCP (platform column / filter, like the ad platforms) */
    apifyPlatform: "Apify",
    filterOwner: "Người tạo",
    viewAll: "Tất cả",
    viewMine: "Của tôi",
    col: {
      name: "Tên",
      owner: "Người tạo",
      platforms: "Nền tảng",
      permissions: "Quyền",
      status: "Trạng thái",
      lastUsed: "Lần dùng cuối",
      calls7d: "Lượt gọi 7 ngày",
    },
    neverUsed: "Chưa dùng",
    errorsHint: (n: number) => `${n} lỗi`,
    capsMissingBadge: "Chưa đặt trần",
    capsMissingHint: (curs: string) =>
      `Có quyền ghi nhưng chưa đặt trần ngân sách/ngày cho ${curs}`,
    callsLabel: (n: string) => `${n} lượt gọi`,
    permSummary: {
      readOnly: "Chỉ xem",
      operate: "Vận hành",
      full: "Toàn quyền",
      more: (n: number) => `+${n}`,
    },
    emptyTitle: "Chưa có MCP nào",
    emptyDescription:
      "MCP là một đường link bạn dán vào Claude, ChatGPT hoặc Gemini để AI xem và điều khiển quảng cáo theo quyền bạn chọn.",
    emptyNoMatch: "Không có MCP nào khớp bộ lọc.",
    openDetail: (name: string) => `Mở MCP ${name}`,
  },

  wizard: {
    title: "Tạo MCP",
    description:
      "4 bước: đặt tên, chọn nền tảng (tài khoản quảng cáo, Apify), chọn quyền và thiết lập bảo vệ.",
    steps: {
      name: { title: "Tên", description: "Đặt tên dễ nhớ" },
      platforms: {
        title: "Nền tảng & tài khoản",
        description: "AI được thấy gì",
      },
      permissions: { title: "Quyền", description: "AI được làm gì" },
      protection: { title: "Bảo vệ", description: "Giới hạn an toàn" },
    },
    stepProgress: (n: number, total: number, title: string) =>
      `Bước ${n}/${total} · ${title}`,
    back: "Quay lại",
    next: "Tiếp tục",
    submit: "Tạo MCP",
    submitting: "Đang tạo…",
    reauthTitle: "Xác minh để tạo MCP",
    reauthDescription:
      "MCP được tạo xong sẽ hiện link dùng được ngay - nhập lại mật khẩu (và mã 2FA nếu đã bật) để xác nhận. Thao tác này được ghi vào nhật ký.",
    reauthSubmit: "Xác minh và tạo MCP",
    fixErrors: "Vui lòng sửa các mục được đánh dấu.",
    noConnectionsTitle: "Bạn chưa có kết nối quảng cáo hay token Apify nào",
    noConnectionsDescription:
      "MCP cần ít nhất 1 nền tảng: kết nối quảng cáo (Meta, TikTok, Google Ads, OpenAI Ads) hoặc token Apify để AI lấy dữ liệu. Thêm kết nối hoặc token trước, rồi quay lại tạo MCP.",
    addConnection: "Thêm kết nối",
    addApifyToken: "Thêm token Apify",
  },

  nameStep: {
    cardTitle: "Thông tin MCP",
    nameLabel: "Tên MCP",
    namePlaceholder: "Vd: Báo cáo hằng ngày – Team Meta",
    nameHelp: "Tên chỉ để bạn nhận biết, AI không thấy tên này.",
    descriptionLabel: "Mô tả (tuỳ chọn)",
    descriptionPlaceholder:
      "Vd: Dùng cho trợ lý Claude của team chạy quảng cáo Meta, chỉ xem số liệu.",
  },

  platformsStep: {
    cardTitle: "Chọn nền tảng và tài khoản",
    cardDescription:
      "Chọn ít nhất 1 nền tảng: nền tảng quảng cáo bạn đã có kết nối (AI chỉ thấy các tài khoản bạn chọn ở đây) hoặc Apify để AI lấy dữ liệu.",
    enablePlatform: (p: string) => `Dùng ${p} trong MCP này`,
    connectionsLabel: "Kết nối",
    noConnections: (p: string) => `Bạn chưa có kết nối ${p}.`,
    addConnectionFor: (p: string) => `Thêm kết nối ${p}`,
    unavailablePlatforms: "Nền tảng chưa có kết nối:",
    accountsAll: "Tất cả tài khoản",
    accountsAllHelp: "Gồm cả tài khoản đồng bộ thêm sau này.",
    accountsPick: "Chọn từng tài khoản",
    accountCount: (n: number) => `${n} tài khoản đang bật`,
    noEnabledAccounts: "Kết nối này chưa có tài khoản nào đang bật.",
    ownerSuffix: (email: string) => `của ${email}`,
    connectionStatusWarning:
      "Kết nối đang lỗi hoặc bị tắt - MCP sẽ không dùng được cho tới khi kết nối hoạt động lại.",
    selectedSummary: (conn: number, acc: string) => `${conn} kết nối · ${acc}`,
    allAccounts: "tất cả tài khoản",
    nAccounts: (n: number) => `${n} tài khoản`,
    accountsListLabel: (name: string) => `Tài khoản của kết nối ${name}`,
    pagesTitle: "Trang Facebook (chỉ đọc bài viết & chỉ số)",
    pagesNone: "Không dùng Trang",
    pagesAll: "Tất cả Trang đang bật",
    pagesAllHelp: "Gồm cả Trang bật thêm sau này.",
    pagesPick: "Chọn từng Trang",
    pageCount: (n: number) => `${n} Trang đang bật`,
    noEnabledPages:
      "Kết nối này chưa có Trang nào đang bật - đồng bộ và bật Trang ở trang Kết nối.",
    pagesListLabel: (name: string) => `Trang Facebook của kết nối ${name}`,
    pageNoInsights: "không xem được chỉ số",
  },

  permissionsStep: {
    cardTitle: "Chọn quyền cho từng nền tảng",
    cardDescription:
      "Quyền Xem luôn bật. Thao tác ghi có xác nhận 2 bước khi bạn bật Tùy chỉnh nâng cao và Xác nhận 2 bước ở bước Bảo vệ (xoá và GMV Max luôn cần xác nhận).",
    presets: "Chọn nhanh",
    presetReadOnly: "Chỉ xem",
    presetOperate: "Vận hành (xem + bật/tắt + sửa)",
    presetFull: "Toàn quyền (trừ xoá)",
    presetShort: {
      readOnly: "Chỉ xem",
      operate: "Vận hành",
      full: "Toàn quyền",
      custom: "Tuỳ chỉnh",
    },
    presetHint: {
      readOnly: "AI chỉ đọc số liệu, không thay đổi gì.",
      operate: "Xem + bật/tắt + sửa ngân sách, giá thầu, lịch chạy.",
      full: "Thêm sao chép và tạo mới (trừ xoá/lưu trữ).",
      custom: "Bạn đã tự chọn từng quyền bên dưới.",
    },
    presetsLabel: (platform: string) => `Mức quyền cho ${platform}`,
    individualTitle: "Chi tiết từng quyền",
    applyPresetAll: "Áp dụng cho mọi nền tảng",
    alwaysOn: "Luôn bật",
    deleteWarning:
      "Xoá/Lưu trữ KHÔNG thể hoàn tác. Chỉ bật khi thật sự cần - AI luôn phải xin xác nhận trước khi xoá.",
    noPlatforms: "Hãy chọn ít nhất 1 nền tảng ở bước trước.",
  },

  protectionStep: {
    cardTitle: "Bảo vệ",
    cardDescription:
      "Mặc định là chế độ Cơ bản: chỉ cần chọn ngày hết hạn (nếu muốn) rồi bấm Tạo MCP. Bật Tùy chỉnh nâng cao để tự đặt xác nhận 2 bước, trần chi tiêu, giới hạn tốc độ và IP được phép.",
    /** mode switch (off = Cơ bản / basic, on = Tùy chỉnh nâng cao / advanced) */
    modeLabel: "Tùy chỉnh nâng cao",
    modeHelpOff:
      "Đang dùng chế độ Cơ bản: chỉ áp dụng ngày hết hạn. Bật để tự đặt xác nhận 2 bước, giới hạn đổi ngân sách, trần chi tiêu, giới hạn tốc độ và IP được phép.",
    modeHelpOn:
      "Đang bật: mọi giới hạn bên dưới được áp dụng. Tắt để quay về chế độ Cơ bản - giá trị bạn đã nhập được giữ lại, bật lại là áp dụng.",
    basicNoteLabel: "Chế độ Cơ bản",
    basicNotLimitedTitle: "Không giới hạn trong chế độ Cơ bản",
    basicNotLimited: [
      "Xác nhận 2 bước cho thao tác ghi",
      "Giới hạn thay đổi ngân sách mỗi lần",
      "Trần chi tiêu theo tiền tệ (ngân sách/ngày, trọn đời, giá thầu/CPA)",
      "Giới hạn tốc độ (lệnh/phút, thao tác ghi / 10 phút, giãn cách giữa các lệnh ghi)",
      "Giới hạn tin Telegram / giờ",
      "Trần Apify mỗi ngày",
      "IP được phép (mọi IP đều dùng được)",
    ],
    basicAlwaysTitle: "Luôn áp dụng",
    basicAlways: [
      "Xoá (không hoàn tác) luôn cần bạn xác nhận",
      "Đối tượng tạo mới hoặc sao chép luôn ở trạng thái tạm dừng",
      "TikTok GMV Max: mọi thay đổi luôn cần xác nhận; tạo mới / sao chép GMV Max cần chế độ Tùy chỉnh nâng cao và trần Ngân sách/ngày",
      "Trần chi phí mỗi lần chạy Apify; chạy Actor Apify ngoài danh mục luôn cần xác nhận",
      "Ngày hết hạn của MCP",
    ],
    basicKept:
      "Giá trị nâng cao đã nhập (nếu có) được giữ lại - bật lại Tùy chỉnh nâng cao là áp dụng.",
    twoStepLabel: "Xác nhận 2 bước cho thao tác ghi",
    twoStepHelp:
      "AI phải cho bạn xem trước thay đổi (vd ngân sách cũ → mới) và chỉ thực hiện khi bạn đồng ý. Thao tác xoá luôn cần xác nhận.",
    twoStepOffWarning:
      "Tắt xác nhận 2 bước: AI sẽ thực hiện thay đổi ngay khi được yêu cầu.",
    budgetPctLabel: "Giới hạn thay đổi ngân sách mỗi lần",
    budgetPctHelp:
      "Vd 50%: ngân sách 1.000.000 ₫ chỉ được đổi trong khoảng 500.000 – 1.500.000 ₫ mỗi lần.",
    maxBudgetLabel: "Trần ngân sách/ngày",
    maxBudgetHelp:
      "Bắt buộc khi MCP có quyền Bật/Tắt, Sửa, Sao chép hoặc Tạo mới - mỗi loại tiền của tài khoản quảng cáo một mức. MCP chỉ có quyền Xem (hoặc thêm Xoá/Lưu trữ) thì để trống được. AI không được đặt hoặc bật ngân sách/ngày vượt mức này.",
    maxBudgetNoCurrency:
      "Chọn tài khoản ở bước 2 để đặt trần ngân sách theo tiền tệ.",
    maxBudgetPlaceholder: "Không giới hạn",
    maxDailyRequiredPlaceholder: "Nhập mức tối đa",
    capRequired: "Bắt buộc",
    maxLifetimeLabel: "Trần ngân sách trọn đời (tuỳ chọn)",
    maxLifetimeHelp:
      "Khi đã đặt trần ngân sách/ngày, ngân sách trọn đời tự bị giới hạn ở trần ngày × số ngày chạy (hoặc × 30 ngày nếu chưa có ngày kết thúc). Ô này đặt thêm một mức tối đa cố định. Để trống = chỉ áp dụng giới hạn theo ngày.",
    maxLifetimePlaceholder: "Theo trần ngày",
    maxBidLabel: "Trần giá thầu/CPA (tuỳ chọn)",
    maxBidHelp:
      "Áp dụng cho giá thầu, CPC tối đa, chi phí mục tiêu (CPA)… mà AI đặt. Để trống = không giới hạn.",
    capsNoCurrency: "Chọn tài khoản ở bước 2 để đặt trần theo tiền tệ.",
    writeRateLabel: "Giới hạn thao tác ghi / 10 phút",
    writeRateHelp:
      "Số thao tác thay đổi quảng cáo (bật/tắt, sửa, tạo, sao chép, xoá…) AI được thực hiện trong 10 phút. Mặc định 20.",
    perTenMinutesSuffix: "thao tác/10 phút",
    writeDelayLabel: "Giãn cách giữa các lệnh ghi",
    writeDelayHelp:
      "Lệnh sửa, bật/tắt, tạo mới, sao chép, xoá, tải ảnh/video chỉ chạy sau khi lệnh trước của MCP này xong ít nhất bấy nhiêu giây, tránh gọi API dồn dập dễ bị coi là spam. Hệ thống tự chờ (tối đa 30 giây). Từ 0 đến 30, 0 = tắt.",
    secondsSuffix: "giây",
    expiresLabel: "Ngày hết hạn (tuỳ chọn)",
    expiresHelp:
      "Sau ngày này (23:59 giờ Việt Nam) link MCP tự ngừng hoạt động. Để trống = không hết hạn.",
    clearExpiry: "Bỏ ngày hết hạn",
    rateLimitLabel: "Giới hạn số lệnh mỗi phút",
    rateLimitHelp: "Chặn AI gọi quá nhiều lần liên tục. Mặc định 60.",
    allowedIpsLabel: "IP được phép (tuỳ chọn)",
    allowedIpsPlaceholder:
      "Mỗi dòng 1 IP hoặc dải CIDR, vd:\n203.0.113.10\n160.79.104.0/21",
    allowedIpsHelp: "Để trống = mọi IP. Hỗ trợ IPv4/IPv6 và CIDR.",
    allowedIpsWarning:
      "Khi đặt danh sách IP, Claude Code và Gemini CLI chạy trên máy cá nhân (IP nhà/4G thay đổi) sẽ bị chặn. Claude trên web/app gọi từ dải 160.79.104.0/21 của Anthropic.",
    percentSuffix: "%",
    perMinuteSuffix: "lệnh/phút",
    groupSafety: "An toàn khi AI sửa quảng cáo",
    groupSafetyDesc: "Kiểm soát cách AI thay đổi và chi tiêu.",
    groupSpend: "Trần chi tiêu theo tiền tệ",
    groupSpendDesc:
      "Bắt buộc nhập Ngân sách/ngày cho mỗi loại tiền khi MCP có quyền bật/tắt, sửa, sao chép hoặc tạo quảng cáo. Mỗi loại tiền của tài khoản trong phạm vi MCP có một hàng riêng - không cộng chéo tiền tệ.",
    capDaily: "Ngân sách/ngày",
    capLifetime: "Ngân sách trọn đời",
    capBid: "Giá thầu/CPA",
    capCurrencyTitle: (cur: string) => `Tiền tệ ${cur}`,
    capsHelpToggle: "Giải thích các mức trần",
    groupRate: "Giới hạn tốc độ",
    groupRateDesc: "Chặn AI gọi quá nhiều lệnh trong thời gian ngắn.",
    groupAccess: "Thời hạn & địa chỉ truy cập",
    groupAccessDesc: "Tự ngừng link sau một ngày hoặc chỉ cho phép một số IP.",
    expiryPresets: {
      none: "Không hết hạn",
      d30: "30 ngày",
      d90: "90 ngày",
      y1: "1 năm",
      custom: "Chọn ngày",
    },
    expiryPresetsLabel: "Chọn nhanh thời hạn",
    expiryPickLabel: "Chọn ngày hết hạn",
    ipCount: (n: number) => `${n} IP/dải đã nhập`,
  },

  /** Telegram notification channels in the MCP form (14-telegram-notifications.md §6) */
  telegram: {
    /** step 2/3 subheading separating the Telegram block from the ad platforms */
    optionalGroup: "Thông báo (không bắt buộc)",
    title: "Kết nối Telegram",
    description:
      "Chọn kết nối Telegram mà MCP này được dùng: AI gửi báo cáo khi bạn yêu cầu và (tuỳ chọn) tự báo mỗi khi AI thay đổi quảng cáo. Không chọn = không dùng Telegram.",
    channelsLabel: "Kết nối Telegram",
    selectedCount: (n: number) => `Đã chọn ${n} kết nối`,
    thread: "gửi vào chủ đề riêng",
    ownerSuffix: (email: string) => `của ${email}`,
    statusError: "Đang lỗi",
    statusDisabled: "Đang tắt",
    statusHint:
      "Kết nối Telegram đang lỗi hoặc đang tắt sẽ không nhận tin cho tới khi hoạt động lại (kiểm tra ở trang Kết nối → Telegram).",
    emptyTitle: "Chưa có kết nối Telegram",
    emptyDescription:
      "Tạo bot Telegram và thêm kết nối Telegram ở trang Kết nối, rồi quay lại đây để chọn.",
    addChannel: "Thêm kết nối Telegram",
    ownerOnlyNote: (email: string) =>
      `MCP của ${email} chỉ dùng được kết nối Telegram của người này.`,
    permissionsTitle: "Telegram",
    permissionsDescription: (n: number) =>
      `Áp dụng cho ${n} kết nối Telegram đã chọn ở bước Nền tảng.`,
    noChannelsSelected:
      "Chưa chọn kết nối Telegram nào - chọn ở bước Nền tảng nếu muốn AI gửi thông báo.",
    toolLabel: "AI được gửi tin",
    toolHelp:
      "AI gửi báo cáo hoặc thông báo vào Telegram khi bạn yêu cầu, có thể kèm 1 ảnh, video hoặc tệp (ảnh ≤ 10 MB, tệp ≤ 50 MB). Tin luôn có tiêu đề \"Tin từ AI\" và dòng ghi nguồn \"Ads MCP Simple\" ở cuối. Ở chế độ bảo vệ Tùy chỉnh nâng cao có thêm giới hạn số tin mỗi giờ.",
    notifyLabel: "Tự báo khi AI thay đổi quảng cáo",
    notifyHelp:
      "Sau mỗi lần AI bật/tắt, đổi ngân sách, sửa, tạo, sao chép hoặc xoá thành công, hệ thống tự gửi 1 tin tóm tắt (trước → sau) vào các kết nối Telegram đã chọn.",
    groupTitle: "Telegram",
    groupDescription: "Giới hạn số tin AI được gửi vào Telegram.",
    perHourLabel: "Giới hạn tin Telegram / giờ",
    perHourHelp:
      "Số tin AI được chủ động gửi vào Telegram trong 1 giờ (1-200). Mặc định 20. Tin tự báo khi AI thay đổi quảng cáo không tính vào giới hạn này.",
    perHourSuffix: "tin/giờ",
    summaryChannels: "Kết nối Telegram",
    summaryTool: "AI được gửi tin Telegram",
    summaryNotify: "Tự báo khi AI thay đổi quảng cáo",
    summaryPerHour: "Giới hạn tin Telegram / giờ",
    summaryNone: "Không dùng",
    deletedChannel: "(kết nối đã xoá)",
  },

  /** Google Drive block of the MCP form + overview (15-google-drive-media.md §7.5, §11) */
  drive: {
    /** step 2 subheading separating the Drive block from the ad platforms / Telegram */
    optionalGroup: "Ảnh, video quảng cáo (không bắt buộc)",
    title: "Google Drive",
    description:
      "Chọn thư mục hoặc Google Sheet mà AI được đọc để lấy ảnh, video lên quảng cáo. Không chọn = AI chỉ dùng được link Drive công khai (nếu bật ở bước Quyền).",
    sourcesLabel: "Thư mục / sheet Google Drive",
    selectedCount: (n: number) => `Đã chọn ${n} nguồn`,
    groups: {
      company: "Của công ty",
      mine: "Của tôi",
      /** existing MCP of another user: that user's personal sources */
      owner: (email: string) => `Riêng của ${email}`,
      staff: "Của nhân viên",
    },
    kindFolder: "Thư mục",
    kindSheet: "Google Sheet",
    writeback: "ghi trạng thái",
    ownerSuffix: (email: string) => `của ${email}`,
    statusError: "Đang lỗi",
    statusDisabled: "Đang tắt",
    statusHint:
      "Nguồn đang lỗi hoặc đang tắt: AI chưa đọc được cho tới khi nguồn hoạt động lại (kiểm tra ở trang Kết nối → Google Drive).",
    emptyTitle: "Chưa có thư mục / sheet Google Drive",
    emptyDescription:
      "Khai báo thư mục ảnh/video hoặc Google Sheet ở trang Kết nối → Google Drive, rồi quay lại đây để chọn.",
    addSource: "Thêm thư mục / sheet",
    ownerOnlyNote: (email: string) =>
      `MCP của ${email} chỉ dùng được nguồn của công ty và nguồn riêng của người này.`,
    permissionsTitle: "Google Drive",
    permissionsDescription: (n: number) =>
      n > 0
        ? `Áp dụng cho ${n} nguồn Google Drive đã chọn ở bước Nền tảng và link Drive công khai.`
        : "Áp dụng cho link Drive công khai và các nguồn Google Drive chọn ở bước Nền tảng.",
    publicLabel: "Cho phép dùng link Drive công khai",
    publicHelp:
      "AI được lấy ảnh, video từ link Drive đang chia sẻ \"Bất kỳ ai có đường liên kết\" mà bạn dán vào chat, kể cả thư mục chưa khai báo. Chỉ đọc được file công khai.",
    publicUnavailable:
      "Quản trị viên chưa lưu API key Google Drive trong Cài đặt nên link công khai chưa dùng được.",
    writebackLabel: "Cho phép ghi trạng thái vào Google Sheet",
    writebackHelp:
      "Sau khi tạo quảng cáo từ một dòng trong sheet, AI ghi trạng thái, mã quảng cáo và thời gian vào dòng đó. Chỉ áp dụng cho sheet đã bật ghi trạng thái.",
    writebackNoSheet: "Chưa chọn Google Sheet nào bật ghi trạng thái.",
    needsCreate:
      "AI chỉ tải được ảnh, video từ Drive lên quảng cáo khi MCP có quyền Tạo mới ở ít nhất 1 nền tảng.",
    needsCreateSelected: (n: number) =>
      `Đã chọn ${n} nguồn Google Drive nhưng chưa nền tảng nào có quyền Tạo mới - AI chỉ xem được file, không tải ảnh, video lên quảng cáo. Bật quyền Tạo mới ở ít nhất 1 nền tảng nếu muốn AI lên quảng cáo từ Drive.`,
    /** source picker: a source switched off cannot be newly picked */
    disabledLocked: "không chọn mới được khi nguồn đang tắt",
    summarySources: "Google Drive",
    summaryPublic: "Link Drive công khai",
    summaryWriteback: "Ghi trạng thái vào Google Sheet",
    summaryNone: "Không dùng",
  },

  /** Apify block of the MCP form + overview (16-apify.md §8) */
  /** Meta card of step "Chọn quyền": admin-only switch settings.metaPageMessages (11-meta-pages.md §13) */
  metaMessages: {
    groupLabel: "Tin nhắn Trang Facebook",
    /** overview "Phạm vi MCP" summary row */
    summaryLabel: "Đọc tin nhắn Trang",
    summaryOn: "Bật (quản trị viên cho phép)",
    summaryOff: "Tắt",
    switchLabel: "Cho phép AI đọc tin nhắn Messenger của Trang",
    adminBadge: "Chỉ quản trị viên bật",
    helpOff:
      "Đang tắt: AI chỉ đọc bài viết, bình luận và chỉ số của các Trang đã chọn, không đọc hộp thư.",
    helpOn:
      "Đang bật: AI đọc được danh sách cuộc trò chuyện và nội dung tin nhắn Messenger (chỉ đọc, không gửi) của **mọi Trang đã chọn** ở bước trước - kể cả tên khách. Số điện thoại và email trong tin được tự động che trước khi gửi cho AI; nhật ký chỉ lưu số lượng, không lưu nội dung.",
    staffLocked: "Chỉ quản trị viên được bật. Nhờ quản trị viên bật nếu MCP này cần đọc tin nhắn.",
    staffCanTurnOff:
      "Quản trị viên đã bật cho MCP này: bạn có thể tắt, nhưng thêm Trang (hoặc chọn \"Tất cả Trang\") khi đang bật cần quản trị viên lưu.",
    noPages: "Chọn ít nhất 1 Trang Facebook ở bước \"Nền tảng & tài khoản\" để dùng được.",
    tokenNote:
      "Token của kết nối Meta cần quyền pages_messaging và via cần quyền Nhắn tin / Kiểm duyệt trên Trang (chip \"Tin nhắn\" ở thẻ Trang của kết nối).",
    reauth: {
      title: "Xác minh để bật đọc tin nhắn",
      description:
        "Cho AI đọc tin nhắn của khách là thay đổi nhạy cảm (dữ liệu cá nhân). Nhập lại mật khẩu (và mã 2FA nếu có) để lưu - thao tác này được ghi vào nhật ký.",
      submit: "Xác minh và lưu",
      submitting: "Đang lưu…",
    },
  },
  apify: {
    title: "Apify",
    /** one line under the title of the Apify platform card (step "Nền tảng & tài khoản") */
    platformDescription:
      "Lấy dữ liệu sàn TMĐT, mạng xã hội, Google Maps, trang web… để AI phân tích.",
    description:
      "AI chạy các việc lấy dữ liệu đã chọn lọc (Shopee, Lazada, TikTok Shop, TikTok, Facebook, Instagram, Threads, YouTube, Google Maps, trang web…) trên tài khoản Apify để phân tích.",
    /** overview "Phạm vi MCP": what the Apify platform block gives the AI */
    enableLabel: "Lấy dữ liệu qua Apify",
    /** platform card (on): where the Apify options live */
    permissionsHint:
      "Trần chi phí mỗi lần chạy và Actor ngoài danh mục: đặt ở phần Quyền.",
    enableHelp:
      "Mỗi lần chạy tốn credit của tài khoản Apify (token công ty + token cá nhân của chủ MCP, tự xoay vòng) và luôn có trần chi phí. Dữ liệu thu về là của bên thứ ba - AI chỉ dùng để phân tích.",
    pool: (s: { tokens: number; accounts: number; usableNow: number }) =>
      `Kho token: ${s.tokens} token · ${s.accounts} tài khoản Apify · ${s.usableNow} dùng được ngay`,
    poolScopes: (company: number, personal: number) =>
      `${company} token công ty, ${personal} token cá nhân`,
    noToken:
      "Chưa có token Apify nào dùng được cho MCP này. Thêm token ở trang Kết nối → Apify rồi quay lại.",
    noTokenOwner: (email: string) =>
      `Chưa có token Apify dùng được cho MCP của ${email} (token công ty hoặc token cá nhân của người này).`,
    addToken: "Thêm token Apify",
    notUsableNow:
      "Hiện chưa có token nào dùng được ngay (hết credit hoặc đang lỗi) - AI sẽ nhận lỗi khi chạy cho tới khi tài khoản Apify có credit lại.",
    tosNote:
      "Điều khoản Apify cấm một người lập nhiều tài khoản Personal: chỉ thêm token của các tài khoản Apify hợp pháp khác nhau. Nhiều token cùng một tài khoản dùng chung credit.",
    runMaxLabel: "Trần mỗi lần chạy (USD)",
    runMaxHelp:
      "Chi phí tối đa của 1 lần chạy, 0,05 - 20 USD (mặc định 1, tối đa 2 chữ số thập phân). Apify tự dừng lần chạy khi chạm trần. Luôn áp dụng, kể cả ở chế độ bảo vệ Cơ bản. Actor tính phí theo tài nguyên (vd đọc / crawl trang web) bị giới hạn thời gian chạy theo trần; phí lưu lượng proxy không nằm trong trần.",
    usdSuffix: "USD",
    storeLabel: "Cho phép Actor ngoài danh mục",
    storeHelpOff:
      "Mặc định AI chỉ chạy các việc trong danh mục (đã giới hạn sẵn input và số kết quả). Bật để AI tìm và chạy Actor khác trên Apify Store - vẫn chặn Actor rủi ro, trường đăng nhập / cookie và vẫn áp trần chi phí.",
    storeHelpOn:
      "AI được tìm và chạy Actor trên Apify Store (trừ Actor cần quyền đầy đủ, ngừng hỗ trợ, bảo trì hoặc thuê theo tháng). Mỗi lần chạy Actor ngoài danh mục LUÔN cần người dùng xác nhận trong khung chat (xem trước Actor, input, chi phí tối đa) ở mọi chế độ bảo vệ. Theo dõi chi phí trong Nhật ký.",
    adminBadge: "Chỉ quản trị viên",
    staffLocked: "Chỉ quản trị viên được bật công tắc này.",
    staffCanTurnOff: "Quản trị viên đã bật cho MCP này - bạn có thể tắt.",
    /** protection step (advanced) */
    groupTitle: "Apify",
    groupDescription: "Giới hạn tiền Apify AI được dùng mỗi ngày cho MCP này.",
    dailyLabel: "Trần Apify mỗi ngày (USD)",
    dailyHelp:
      "Tổng chi phí các lần chạy trong 1 ngày (giờ Việt Nam) - lần chạy chưa xong tính theo trần của nó. 0 - 1.000 USD, mặc định 10; 0 = không giới hạn theo ngày. Trần mỗi lần chạy vẫn luôn áp dụng.",
    basicNote: (runMax: string) =>
      `Apify: chế độ Cơ bản không có trần theo ngày, nhưng trần mỗi lần chạy (${runMax} USD) vẫn áp dụng.`,
    /** overview rows */
    summaryEnabled: "Apify",
    runMaxLine: (usd: string) => `Trần mỗi lần chạy: ${usd}`,
    overviewNoToken:
      "Kho token Apify của chủ MCP đang trống - AI chưa thấy công cụ Apify. Thêm token ở trang Kết nối → Apify.",
    summaryRunMax: "Trần Apify mỗi lần chạy",
    summaryDaily: "Trần Apify mỗi ngày",
    summaryStore: "Actor ngoài danh mục Apify",
    noDailyCap: "Không giới hạn",
    usd: (text: string) => `${text} USD`,
    /** re-authentication when an admin turns "Actor ngoài danh mục" on (config tab) */
    reauth: {
      title: "Xác minh để lưu thay đổi nhạy cảm",
      description:
        "Bật Actor ngoài danh mục Apify (hoặc quyền GMV Max) là thay đổi nhạy cảm (chi tiêu thật). Nhập lại mật khẩu (và mã 2FA nếu có) để lưu - thao tác này được ghi vào nhật ký.",
      submit: "Xác minh và lưu",
      submitting: "Đang lưu…",
    },
  },

  success: {
    title: (name: string) => `Đã tạo MCP "${name}"`,
    description:
      "Sao chép link bên dưới và dán vào Claude, ChatGPT hoặc Gemini theo hướng dẫn.",
    urlLabel: "Link MCP",
    warningTitle: "Ai có link này đều dùng được MCP",
    warning:
      "Không chia sẻ công khai, không dán vào nhóm chat. Nếu lộ link, vào MCP → Bảo mật → Xoay key để link cũ ngừng hoạt động ngay.",
    revealNote:
      "Bạn có thể xem lại link sau trong trang chi tiết MCP (cần nhập lại mật khẩu).",
    goToDetail: "Xem chi tiết MCP",
    backToList: "Về danh sách MCP",
    createAnother: "Tạo MCP khác",
  },

  detail: {
    tabs: {
      overview: "Tổng quan",
      config: "Cấu hình",
      connect: "Kết nối AI",
      logs: "Nhật ký",
      security: "Bảo mật",
    },
    tabsLabel: "Các phần của MCP",
    ownerLabel: "Người tạo",
    createdAt: (d: string) => `Tạo lúc ${d}`,
    notFound: "Không tìm thấy MCP này hoặc bạn không có quyền xem.",
  },

  overview: {
    calls7d: "Lượt gọi 7 ngày",
    errors7d: "Lỗi 7 ngày",
    writes7d: "Thao tác ghi 7 ngày",
    lastUsed: "Lần dùng cuối",
    errorRate: (pct: string) => `Tỉ lệ lỗi ${pct}`,
    avgDuration: (d: string) => `Trung bình ${d}/lệnh`,
    neverUsed: "Chưa dùng",
    lastClient: (c: string) => `Client: ${c}`,
    chartTitle: "Lượt gọi 14 ngày qua",
    chartDescription: "Số lệnh AI gửi tới MCP mỗi ngày (giờ Việt Nam).",
    chartCalls: "Lượt gọi",
    chartErrors: "Lỗi",
    chartEmpty: "Chưa có lượt gọi nào. Dán link MCP vào AI để bắt đầu.",
    byPlatformTitle: "Theo nền tảng (7 ngày)",
    summaryTitle: "Phạm vi MCP",
    summaryAccounts: "Tài khoản",
    summaryPermissions: "Quyền",
    summaryMode: "Chế độ bảo vệ",
    modeBasic: "Cơ bản",
    modeAdvanced: "Tùy chỉnh nâng cao",
    /** basic mode: a limit that does not apply */
    unlimited: "Không giới hạn",
    summaryTwoStep: "Xác nhận 2 bước",
    summaryBudgetPct: "Giới hạn đổi ngân sách",
    summaryMaxBudget: "Trần ngân sách/ngày",
    summaryRateLimit: "Giới hạn lệnh/phút",
    summaryMaxLifetime: "Trần ngân sách trọn đời",
    summaryMaxBid: "Trần giá thầu/CPA",
    summaryWriteRate: "Giới hạn thao tác ghi / 10 phút",
    summaryWriteDelay: "Giãn cách lệnh ghi",
    nSeconds: (n: number) => `${n} giây`,
    summaryExpires: "Hết hạn",
    summaryAllowedIps: "IP được phép",
    on: "Bật",
    off: "Tắt",
    noExpiry: "Không hết hạn",
    anyIp: "Mọi IP",
    nIps: (n: number) => `${n} IP/dải`,
    expiredNotice:
      "MCP đã hết hạn - AI không dùng được. Vào Cấu hình để đổi ngày hết hạn.",
    disabledNotice:
      "MCP đang tắt - AI không dùng được. Vào Bảo mật để bật lại.",
    deletedConnection: "(kết nối đã xoá)",
    /** a platform with permissions but no ad account the MCP can actually use */
    noUsable: {
      titleAll: "MCP này chưa có tài khoản dùng được",
      titleSome: "Một số nền tảng chưa có tài khoản dùng được",
      descriptionAll: "Bật TKQC trong trang kết nối để AI dùng được MCP này.",
      descriptionSome:
        "AI chưa gọi được các nền tảng dưới đây. Bật TKQC trong trang kết nối.",
      reason: {
        deleted: "Kết nối đã bị xoá",
        unavailable: "Kết nối đang tắt hoặc không còn dùng được",
        no_accounts: "Chưa bật TKQC nào trong các kết nối đã chọn",
      },
      openConnections: "Mở trang kết nối",
    },
    capsMissingTitle: "MCP này chưa có trần ngân sách/ngày",
    capsMissingBody: (curs: string) =>
      `MCP được tạo trước bản cập nhật bảo mật, đang có quyền ghi nhưng chưa đặt trần ngân sách/ngày cho ${curs}. AI vẫn dùng được nhưng không có giới hạn chi tiêu. Hãy mở tab Cấu hình và nhập trần cho từng loại tiền.`,
    /** a "caps required" MCP whose scope gained a currency without a cap (e.g. a new ad account synced later) */
    capsMissingBodyRequired: (curs: string) =>
      `MCP chưa có trần ngân sách/ngày cho ${curs} (vd tài khoản quảng cáo mới được đồng bộ) nên AI không được bật chạy hoặc đổi ngân sách ở các tài khoản dùng loại tiền này. Hãy mở tab Cấu hình và nhập trần.`,
    capsMissingAction: "Đặt trần ngân sách",
  },

  config: {
    formId: "mcp-config-form",
    infoTitle: "Thông tin",
    saved: "Đã lưu cấu hình. Thay đổi có hiệu lực ở lệnh tiếp theo của AI.",
    chatgptNote:
      "ChatGPT Business/Enterprise lưu danh sách tool khi admin xuất bản app. Sau khi đổi quyền, admin workspace cần làm mới (refresh) app trong ChatGPT.",
    ownerNote: (email: string) =>
      `MCP này thuộc ${email} - chỉ dùng được kết nối của người tạo.`,
    /** name shown instead of a connection the viewer may not see */
    otherOwnerConnection: "Kết nối của người dùng khác",
    /** connections / ad accounts the editor drops when the config is saved (deleted, switched off) */
    scopeIssues: {
      title: "Một số kết nối hoặc TKQC không còn dùng được",
      description:
        "Những mục dưới đây sẽ bị loại khỏi MCP khi bạn lưu cấu hình; phần còn lại vẫn hoạt động bình thường.",
      connectionDeleted: (name: string) =>
        `Kết nối "${name}" đã bị xoá - sẽ bị loại khỏi MCP khi bạn lưu.`,
      connectionDisabled: (name: string) =>
        `Kết nối "${name}" đang tắt - sẽ bị loại khỏi MCP khi bạn lưu.`,
      connectionUnavailable: (name: string) =>
        `Kết nối "${name}" không còn dùng được cho MCP này - sẽ bị loại khỏi MCP khi bạn lưu.`,
      /** `names`: account names we know (at most 3 are shown), `unknown`: accounts we have no name for */
      accountsDisabled: (conn: string, names: string[], unknown: number) => {
        const shown = names.slice(0, 3).map((n) => `"${n}"`)
        const more = Math.max(0, names.length - shown.length) + unknown
        const who =
          shown.length === 0
            ? `${more} TKQC`
            : `TKQC ${shown.join(", ")}${more > 0 ? ` và ${more} TKQC khác` : ""}`
        return `${who} của kết nối "${conn}" đã tắt - sẽ bị loại khỏi MCP khi bạn lưu.`
      },
      platformDropped: (platform: string) =>
        `${platform} không còn kết nối nào dùng được nên cũng sẽ bị bỏ khỏi MCP khi bạn lưu.`,
      keepHint:
        "Muốn giữ lại? Đừng lưu - hãy bật lại kết nối hoặc TKQC ở trang kết nối rồi tải lại trang này.",
      openConnections: "Mở trang kết nối",
    },
    /** contextual save bar while the stored config still points at things that are gone */
    prune: {
      summary: (s: { connections: number; accounts: number; platforms: number }) => {
        const parts: string[] = []
        if (s.connections > 0) parts.push(`${s.connections} kết nối`)
        if (s.accounts > 0) parts.push(`${s.accounts} TKQC`)
        if (s.platforms > 0) parts.push(`${s.platforms} nền tảng`)
        return parts.length > 1
          ? `${parts.slice(0, -1).join(", ")} và ${parts[parts.length - 1]}`
          : (parts[0] ?? "")
      },
      barOnly: (summary: string) =>
        `Lưu để loại ${summary} không còn dùng được khỏi MCP.`,
      barWithEdits: (summary: string) =>
        `Có thay đổi chưa lưu - gồm loại ${summary} không còn dùng được khỏi MCP.`,
    },
  },

  connect: {
    urlTitle: "Link MCP",
    urlDescription:
      "Link đầy đủ chỉ hiện khi bạn xác minh lại danh tính. Mọi lần xem đều được ghi nhật ký.",
    maskedLabel: "Link MCP (đã che)",
    reveal: "Xem lại link",
    hide: "Ẩn link",
    revealedLabel: "Link MCP",
    guideTitle: "Hướng dẫn kết nối",
    guideDescription: "Chọn ứng dụng AI bạn dùng và làm theo từng bước.",
    guideMaskedNote:
      'Bấm "Xem lại link" để điền link thật vào các lệnh bên dưới.',
  },

  reveal: {
    title: "Xác minh để xem link",
    description:
      "Nhập lại mật khẩu đăng nhập để xem link MCP. Thao tác này được ghi vào nhật ký.",
    passwordLabel: "Mật khẩu",
    codeLabel: "Mã xác thực 6 số",
    codeHelp:
      "Mở ứng dụng Authenticator (Google Authenticator, Authy…) để lấy mã.",
    submit: "Xác minh và xem link",
    submitting: "Đang xác minh…",
  },

  logs: {
    title: "Nhật ký MCP",
    description:
      "Mọi lệnh AI gửi tới MCP này: thời gian, tool, tài khoản, giá trị trước → sau, trạng thái.",
    open: "Mở nhật ký MCP",
    staffNote:
      "Các thao tác của nhân sự với MCP (tạo, sửa, xoay key, xem lại link…) nằm trong Nhật ký nhân sự.",
  },

  security: {
    groupAccess: "Truy cập",
    groupAccessDesc: "Quản lý link và trạng thái hoạt động của MCP.",
    dangerZone: "Vùng nguy hiểm",
    dangerZoneDesc: "Thao tác dưới đây không thể hoàn tác.",
    rotateTitle: "Xoay key",
    rotateDescription:
      "Tạo link mới, link cũ ngừng hoạt động NGAY. Dùng khi nghi lộ link. Bạn sẽ phải dán link mới vào mọi ứng dụng AI đang dùng.",
    rotateAction: "Xoay key",
    rotateReauthTitle: "Xác minh để xoay key",
    rotateReauthDescription:
      "Link hiện tại sẽ ngừng hoạt động ngay và link mới được tạo. Nhập lại mật khẩu để xác nhận - thao tác này được ghi vào nhật ký.",
    rotateReauthSubmit: "Xác minh và xoay key",
    rotatedTitle: "Link MCP mới",
    rotatedDescription:
      "Đây là lần duy nhất link mới hiện mà không cần xác minh. Sao chép và cập nhật vào ứng dụng AI.",
    lastRotated: (d: string) => `Xoay lần cuối: ${d}`,
    neverRotated: "Chưa xoay key lần nào.",
    toggleTitleOn: "Tắt MCP",
    toggleTitleOff: "Bật MCP",
    toggleDescriptionOn:
      "Tạm ngừng MCP: AI gọi tới sẽ nhận lỗi không tìm thấy. Có thể bật lại bất cứ lúc nào, link giữ nguyên.",
    toggleDescriptionOff:
      "MCP đang tắt. Bật lại để AI dùng tiếp với link hiện tại.",
    disableAction: "Tắt MCP",
    enableAction: "Bật MCP",
    disableConfirmTitle: "Tắt MCP này?",
    disableConfirmDescription:
      "AI sẽ không dùng được MCP cho tới khi bạn bật lại.",
    expiredHint:
      "MCP đã hết hạn - bật lại không có tác dụng cho tới khi bạn đổi ngày hết hạn trong Cấu hình.",
    deleteTitle: "Xoá MCP",
    deleteDescription:
      "Xoá vĩnh viễn MCP và link của nó. Nhật ký vẫn được giữ theo thời gian lưu trữ.",
    deleteAction: "Xoá MCP",
    deleteConfirmTitle: (name: string) => `Xoá MCP "${name}"?`,
    deleteConfirmDescription:
      "Link MCP ngừng hoạt động ngay và không thể khôi phục.",
  },

  toast: {
    created: "Đã tạo MCP.",
    updated: "Đã lưu cấu hình MCP.",
    noChanges: "Không có thay đổi nào.",
    enabled: "Đã bật MCP.",
    disabled: "Đã tắt MCP.",
    rotated: "Đã xoay key. Link cũ đã ngừng hoạt động.",
    deleted: "Đã xoá MCP.",
  },

  errors: {
    generic: "Không thực hiện được thao tác. Vui lòng thử lại.",
    twoFactorRequired: "Bạn cần bật xác thực 2 bước trước khi tiếp tục.",
  },

  guide: {
    tabsLabel: "Ứng dụng AI",
    copyCommand: "Sao chép lệnh",
    copySnippet: "Sao chép",
    /** long snippets (tips): toggle of the capped preview */
    expandSnippet: "Xem toàn bộ",
    collapseSnippet: "Thu gọn",
    stepsLabel: "Các bước",
    notesLabel: "Lưu ý",
    serverName: "ads-nextgency",
    clients: {
      claude: {
        tab: "Claude",
        title: "Claude (web, desktop, điện thoại)",
        steps: [
          "Mở claude.ai → Customize → Connectors (claude.ai/customize/connectors).",
          'Bấm "+ Add" → "Add custom connector" (một số tài khoản chỉ có nút "Add custom connector").',
          'Đặt tên (vd "Ads MCP"), dán link MCP vào ô URL → Continue.',
          'Mục Authentication chọn "No sign in" (có nơi ghi "No sign-in"), không điền OAuth. Bấm Add.',
          'Trong cuộc trò chuyện, bấm nút "+" → Connectors → bật "Ads MCP". Ứng dụng desktop và điện thoại tự đồng bộ connector từ web.',
        ],
        notes: [
          "Gói Free chỉ thêm được 1 connector; Pro/Max/Team/Enterprise thêm được nhiều.",
          "Team/Enterprise: chỉ Owner thêm được (Organization settings → Connectors → Add → Custom → Web), thành viên bấm Connect ở Customize → Connectors. Cả workspace dùng chung 1 link - mọi người có cùng quyền của MCP này.",
          "Máy chủ cần IPv4 (bản ghi A) và chứng chỉ HTTPS hợp lệ. Nếu đặt danh sách IP được phép, thêm dải 160.79.104.0/21 của Anthropic.",
          "Mỗi kết quả tối đa ~150.000 ký tự, mỗi lệnh tối đa 240 giây.",
        ],
      },
      chatgpt: {
        tab: "ChatGPT",
        title: "ChatGPT (web)",
        steps: [
          'Mở chatgpt.com/plugins → bấm "+" → "Add custom MCP server" (có thể hiện "Create custom MCP server").',
          'Đặt tên (vd "Ads MCP"), mục Connection dán link MCP vào Server URL, Authentication chọn "No authentication".',
          'Đọc cảnh báo, bấm "I understand and want to continue" → "Create as a plugin".',
          'Cài plugin: chatgpt.com/plugins?view=personal → mở plugin → bấm "+". Trong cuộc trò chuyện, gõ @ và chọn plugin.',
        ],
        notes: [
          "Từ 10/2026 ChatGPT không còn bước bật Developer mode. MCP tự thêm chỉ dùng trên web (chưa có trên điện thoại).",
          "Quyền ghi (bật/tắt, sửa, tạo…): trang trợ giúp OpenAI ghi Business/Enterprise/Edu được ghi, Pro chỉ đọc; tài liệu cho nhà phát triển không giới hạn theo gói - hãy thử thực tế.",
          'Business/Enterprise: admin cấp quyền "Create custom MCP servers" (tên mới của Developer mode). ChatGPT lưu "ảnh chụp" danh sách tool → sau khi đổi quyền MCP, vào chatgpt.com/plugins → mở plugin → Refresh.',
        ],
      },
      geminiCli: {
        tab: "Gemini CLI",
        title: "Gemini CLI",
        steps: [
          "Mở file ~/.gemini/settings.json (tạo mới nếu chưa có).",
          "Thêm khối mcpServers bên dưới (giữ nguyên các cài đặt khác).",
          'Khởi động lại Gemini CLI và gõ /mcp để kiểm tra server "adsnextgency".',
        ],
        notes: [
          'Tên server không dùng dấu gạch dưới "_".',
          "httpUrl = giao thức Streamable HTTP (bắt buộc).",
          "Nếu MCP đặt danh sách IP được phép, máy cá nhân có IP thay đổi sẽ bị chặn.",
        ],
      },
      geminiEnterprise: {
        tab: "Gemini Enterprise",
        title: "Gemini Enterprise",
        steps: [
          "Admin vào bảng điều khiển Gemini Enterprise → Data stores / Connectors → thêm custom MCP server.",
          "Dán link MCP vào ô URL.",
          "Authentication: chọn No authentication. Lưu và bật cho người dùng.",
        ],
        notes: [
          "Chỉ hỗ trợ Streamable HTTP và cần chứng chỉ HTTPS hợp lệ.",
          "Cả tổ chức dùng chung 1 link - mọi người có cùng quyền của MCP này.",
        ],
      },
      claudeCode: {
        tab: "Claude Code",
        title: "Claude Code (dòng lệnh)",
        steps: [
          "Mở terminal và chạy lệnh bên dưới (--scope user để dùng ở mọi thư mục).",
          'Chạy claude, gõ /mcp để kiểm tra kết nối "ads-nextgency".',
        ],
        notes: [
          "Claude Code cắt kết quả dài hơn ~25.000 token (chỉnh bằng biến MAX_MCP_OUTPUT_TOKENS).",
          "Nếu MCP đặt danh sách IP được phép, máy cá nhân có IP thay đổi sẽ bị chặn.",
        ],
      },
      geminiApp: {
        tab: "Gemini app",
        title: "Ứng dụng Gemini (gemini.google.com)",
        unsupportedTitle: "Chưa hỗ trợ ở phiên bản này",
        unsupported:
          "Ứng dụng Gemini hiện chỉ cho thêm app tuỳ chỉnh ở Mỹ/tiếng Anh và có thể yêu cầu đăng nhập OAuth - Ads MCP v1 chưa hỗ trợ. Hãy dùng Gemini CLI hoặc Gemini Enterprise.",
      },
    },
  },
} as const
