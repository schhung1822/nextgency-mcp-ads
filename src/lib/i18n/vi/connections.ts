// Chuỗi giao diện tiếng Việt - nhóm "connections". Chỉ agent sở hữu nhóm này sửa file này.
export const connections = {
  /** screen-reader prefix of the "next step" line under a connection status message */
  statusHintLabel: "Việc cần làm:",

  list: {
    title: "Kết nối quảng cáo",
    metaTitle: "Kết nối quảng cáo",
    description:
      "Dán token từ app developer của bạn để kết nối tài khoản quảng cáo.",
    add: "Thêm kết nối",
    tabAll: "Tất cả",
    searchPlaceholder: "Tìm theo tên kết nối…",
    searchLabel: "Tìm kết nối",
    filterStatus: "Trạng thái",
    tableLabel: "Danh sách kết nối",
    colName: "Tên",
    colPlatform: "Nền tảng",
    colOwner: "Người tạo",
    colAccounts: "TKQC",
    colStatus: "Trạng thái",
    colExpires: "Hạn token",
    colChecked: "Kiểm tra lúc",
    noExpiry: "Không hạn",
    accountsOf: (enabled: number, total: number) =>
      `${enabled}/${total} đang bật`,
    emptyTitle: "Chưa có kết nối nào",
    emptyDescription:
      "Thêm kết nối đầu tiên để bắt đầu điều khiển quảng cáo từ AI.",
    emptyFilteredTitle: "Không có kết nối phù hợp",
    emptyFilteredDescription: "Thử đổi từ khoá tìm kiếm hoặc bỏ bớt bộ lọc.",
    openDetail: (name: string) => `Mở kết nối ${name}`,
    tabsLabel: "Lọc theo nền tảng",
  },

  new: {
    title: "Thêm kết nối",
    metaTitle: "Thêm kết nối",
    description:
      "Chọn nền tảng, dán thông tin từ app developer rồi kiểm tra trước khi lưu.",
    steps: {
      platform: "Chọn nền tảng",
      platformDesc: "Meta, OpenAI Ads",
      credentials: "Nhập thông tin",
      credentialsDesc: "Token và thông tin app",
      verify: "Kiểm tra & chọn tài khoản",
      verifyDesc: "Xác thực và đồng bộ TKQC",
    },
    choosePlatform: "Bạn muốn kết nối nền tảng nào?",
    choosePlatformHint:
      "Mỗi nền tảng có thể thêm nhiều kết nối. Bạn có thể đổi lại ở bước sau.",
    selectPlatform: (name: string) => `Chọn ${name}`,
    stepProgress: (n: number, total: number, title: string) =>
      `Bước ${n}/${total} · ${title}`,
    formTitle: (platform: string) => `Thông tin kết nối ${platform}`,
    formDescription:
      "Thông tin được mã hoá trước khi lưu và không bao giờ hiển thị lại.",
    nameLabel: "Tên kết nối",
    namePlaceholder: "Ví dụ: BM chính, Via Shop VN…",
    nameHelp: "Tên gợi nhớ để bạn và đồng nghiệp nhận ra kết nối này.",
    guideTitle: (platform: string) => `Cách lấy token ${platform}`,
    optional: "(tuỳ chọn)",
    comingSoon: "Sắp ra mắt",
    comingSoonCard: "Kết nối này sẽ có trong phiên bản tới.",
    comingSoonAria: (name: string) => `${name} - sắp ra mắt`,
    comingSoonTitle: (name: string) => `Kết nối ${name} chưa sẵn sàng`,
    comingSoonBody: (name: string) =>
      `Kết nối ${name} đang được hoàn thiện và sẽ có trong phiên bản cập nhật tới. Khi có bản mới, quản trị viên sẽ thấy thông báo ở Cài đặt → Cập nhật hệ thống. Hiện bạn có thể dùng Meta và OpenAI Ads.`,
    comingSoonClose: "Đã hiểu",
    verifyNow: "Kiểm tra kết nối",
    verifying: "Đang kiểm tra token và tìm tài khoản quảng cáo…",
    verifyingHint: "Việc này có thể mất vài giây. Vui lòng không đóng trang.",
    verifyFailedTitle: "Không kiểm tra được kết nối",
    verifyFailedHintsTitle: "Bạn có thể thử",
    verifyFailedHints: [
      "Kiểm tra token dán đủ, không thừa hoặc thiếu ký tự và đúng nền tảng đã chọn.",
      "Tạo token mới trong trang quản lý của nền tảng rồi dán lại (token cũ có thể đã hết hạn hoặc bị thu hồi).",
      'Nếu nền tảng đang bận, bấm "Kiểm tra lại" sau ít phút.',
    ],
    verifyOkTitle: "Token hợp lệ",
    tokenExpires: (date: string) => `Hết hạn: ${date}`,
    tokenNoExpiry: "Không có hạn sử dụng",
    scopes: "Quyền (scope)",
    warnings: "Lưu ý",
    accountsTitle: "Tài khoản quảng cáo tìm thấy",
    accountsDescription:
      "Bật những tài khoản được phép dùng trong MCP. Bạn có thể đổi lại sau trong trang chi tiết.",
    accountsCount: (n: number) => `${n} tài khoản`,
    accountsPicked: (on: number, total: number) =>
      `Đang bật ${on}/${total} tài khoản`,
    noAccounts:
      "Token hợp lệ nhưng chưa thấy tài khoản quảng cáo nào. Kiểm tra lại quyền đã cấp cho token.",
    enableAll: "Bật tất cả",
    disableAll: "Tắt tất cả",
    resetDefaults: "Mặc định",
    resetDefaultsLabel: "Đặt lại về trạng thái bật/tắt mặc định",
    /** shown when some found accounts start OFF (see isDefaultEnabled) */
    defaultOffNote: {
      both: "TKQC đã đóng/vô hiệu hoá/chờ duyệt và tài khoản quản lý (MCC) mặc định tắt. Bật tay những tài khoản bạn thật sự cần dùng trong MCP.",
      inactive:
        "TKQC đã đóng/vô hiệu hoá/chờ duyệt mặc định tắt. Bật tay những tài khoản bạn thật sự cần dùng trong MCP.",
      manager:
        "Tài khoản quản lý (MCC) mặc định tắt vì không chứa chiến dịch riêng. Bật tay nếu bạn thật sự cần dùng trong MCP.",
    },
    save: "Lưu kết nối",
    saved: "Đã lưu kết nối.",
    retry: "Kiểm tra lại",
    editCredentials: "Sửa thông tin",
    requiredField: (label: string) => `Vui lòng nhập ${label}.`,
  },

  detail: {
    metaTitle: "Chi tiết kết nối",
    overview: "Tổng quan",
    status: "Trạng thái",
    statusAlert: {
      // active: the last check failed for a transient reason (rate limit, 5xx, timeout) - the token is not at fault
      active: "Lần kiểm tra gần nhất chưa thành công",
      invalid: "Kết nối đang lỗi",
      expiring: "Token sắp hết hạn",
      disabled: "Kết nối đã bị tắt",
    },
    credential: "Token đang lưu",
    expires: "Hạn token",
    scopes: "Quyền (scope)",
    noScopes: "Nền tảng không trả về danh sách quyền",
    owner: "Người tạo",
    lastChecked: "Kiểm tra lần cuối",
    createdAt: "Ngày tạo",
    warnings: "Lưu ý từ lần kiểm tra gần nhất",
    recheck: "Kiểm tra lại",
    rechecked: "Đã kiểm tra lại kết nối.",
    sync: "Đồng bộ tài khoản",
    synced: (n: number) =>
      `Đã đồng bộ ${n} tài khoản quảng cáo. Tài khoản mới (nếu có) đang tắt - bật ở danh sách bên dưới.`,
    replace: "Thay token",
    rename: "Đổi tên",
    delete: "Xoá kết nối",
    accountsTitle: "Tài khoản quảng cáo",
    accountsDescription:
      "Chỉ tài khoản đang bật mới dùng được trong MCP. Tài khoản mới phát hiện sẽ ở trạng thái tắt cho tới khi bạn bật.",
    accountsTable: "Danh sách tài khoản quảng cáo",
    colAccount: "Tài khoản",
    colId: "ID",
    colCurrency: "Tiền tệ",
    colTimezone: "Múi giờ",
    colStatus: "Trạng thái",
    colEnabled: "Cho phép dùng",
    colSynced: "Đồng bộ lúc",
    managerBadge: "MCC",
    toggleAccount: (name: string) => `Cho phép dùng ${name} trong MCP`,
    accountToggled: (enabled: boolean) =>
      enabled ? "Đã bật tài khoản." : "Đã tắt tài khoản.",
    noAccounts:
      'Chưa có tài khoản quảng cáo nào. Bấm "Đồng bộ tài khoản" để tải lại.',
    usedBy: "MCP đang dùng kết nối này",
    usedByNone: "Chưa có MCP nào dùng kết nối này.",
    usedByOther: (n: number) => `${n} MCP của người khác`,
  },

  pages: {
    title: "Trang Facebook",
    description:
      "Trang mà via của token quản lý (trực tiếp hoặc qua Business Manager). Trang đang bật mới chọn được trong MCP để đọc bài viết và chỉ số - chỉ đọc, không đăng hay sửa bài.",
    count: (enabled: number, total: number) => `${enabled}/${total} Trang đang bật`,
    table: "Danh sách Trang Facebook",
    colPage: "Trang",
    colFollowers: "Người theo dõi",
    colSource: "Nguồn",
    colAbilities: "Đọc được",
    colEnabled: "Cho phép dùng",
    sourceDirect: "Trực tiếp",
    sourceBm: (name: string) => `BM: ${name}`,
    abilityPosts: "Bài viết",
    abilityInsights: "Chỉ số",
    abilityAds: "Bài QC",
    listOnly: "Chỉ liệt kê",
    listOnlyHelp:
      "Via không có vai trò trên Trang này nên không đọc được bài viết/chỉ số.",
    missingBadge: "Không còn thấy",
    missingHelp:
      "Lần đồng bộ gần nhất không thấy Trang này (via mất quyền hoặc Trang bị gỡ khỏi BM). MCP sẽ không dùng Trang này.",
    toggle: (name: string) => `Cho phép dùng Trang ${name} trong MCP`,
    toggled: (enabled: boolean) => (enabled ? "Đã bật Trang." : "Đã tắt Trang."),
    lastSync: "Đồng bộ Trang lúc",
    neverSynced:
      'Chưa đồng bộ Trang. Bấm "Đồng bộ tài khoản" để tải danh sách Trang (cần token có quyền pages_show_list).',
    syncFailedTitle: "Không đọc được danh sách Trang",
    syncFailedHelp:
      "Danh sách bên dưới là lần đồng bộ thành công trước đó. Tạo token mới có các quyền pages_show_list, pages_read_engagement, read_insights, business_management rồi bấm \"Thay token\".",
    syncWarnings: "Lưu ý từ lần đồng bộ Trang",
    missingScopes: (scopes: string) =>
      `Token thiếu quyền ${scopes} - tool Trang trong MCP sẽ không đọc được chỉ số/bài viết. Tạo token mới có các quyền này rồi bấm "Thay token".`,
    empty: "Token không quản lý Trang Facebook nào.",
    newDisabledNote:
      "Trang mới phát hiện sau lần đồng bộ đầu tiên sẽ ở trạng thái tắt cho tới khi bạn bật.",
  },

  rename: {
    title: "Đổi tên kết nối",
    description: "Tên chỉ dùng để hiển thị, không ảnh hưởng tới token.",
    submit: "Lưu tên",
    done: "Đã đổi tên kết nối.",
  },

  replace: {
    title: "Thay token",
    description:
      "Nhập lại toàn bộ thông tin kết nối. Token cũ không hiển thị lại - sau khi kiểm tra thành công, token mới sẽ thay thế token cũ.",
    currentHint: (hint: string) => `Token đang lưu: ${hint}`,
    passwordLabel: "Mật khẩu đăng nhập của bạn",
    passwordHelp:
      "Thay token là thao tác nhạy cảm nên cần xác nhận lại mật khẩu (và mã 2FA nếu đã bật).",
    submit: "Kiểm tra & thay token",
    done: "Đã thay token và đồng bộ lại tài khoản. Tài khoản mới phát hiện (nếu có) đang tắt - hãy bật nếu muốn dùng trong MCP.",
  },

  remove: {
    title: "Xoá kết nối?",
    description: (name: string) =>
      `Kết nối "${name}" và token đã lưu sẽ bị xoá. Các MCP đang dùng kết nối này vẫn tồn tại nhưng mất quyền truy cập các tài khoản của nó.`,
    affected: "MCP bị ảnh hưởng",
    loadingImpact: "Đang kiểm tra MCP đang dùng…",
    confirm: "Xoá kết nối",
    done: "Đã xoá kết nối.",
  },

  errors: {
    notFound: "Không tìm thấy kết nối hoặc bạn không có quyền xem.",
    accountNotFound: "Không tìm thấy tài khoản quảng cáo trong kết nối này.",
    invalidInput: "Thông tin chưa hợp lệ. Vui lòng kiểm tra lại.",
    tokenInvalid:
      "Token không hợp lệ hoặc đã bị thu hồi. Hãy tạo token mới rồi dán lại.",
    tokenExpired: (date: string) =>
      `Token đã hết hạn từ ${date}. Hãy tạo token mới rồi bấm "Thay token".`,
    tokenExpiring: (days: number, date: string) =>
      `Token sẽ hết hạn sau ${days} ngày (${date}). Hãy thay token mới trước khi hết hạn.`,
    upstream:
      "Không kết nối được tới nền tảng quảng cáo. Vui lòng thử lại sau ít phút.",
    checkFailed: (msg: string) => `Không kiểm tra được: ${msg}`,
    wrongPassword: "Mật khẩu không đúng.",
    passwordRequired: "Vui lòng nhập mật khẩu để xác nhận.",
    nameRequired: "Vui lòng nhập tên kết nối.",
    nameTooLong: "Tên kết nối tối đa 100 ký tự.",
    platformRequired: "Vui lòng chọn nền tảng.",
    tooManyAccounts: "Quá nhiều tài khoản trong một lần cập nhật.",
    connectionDisabled: "Kết nối đã bị tắt.",
    pagesUnreadable: "Không đọc được danh sách Trang Facebook (Meta trả lỗi).",
    pageNotFound: "Không tìm thấy Trang trong kết nối này.",
    tooManyPages: "Quá nhiều Trang trong một lần cập nhật.",
    generic: "Đã có lỗi xảy ra. Vui lòng thử lại.",
  },
} as const
