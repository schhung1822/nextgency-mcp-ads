// Chuỗi tiếng Việt - nhóm "apify" (token Apify ở trang Kết nối, .claude/docs/16-apify.md §8).
// `server`: thông báo thành công mặc định (UI dùng khi server action không trả `message`).
// Giao diện: `ui` (nhãn dùng chung), `list` (tab Apify), `form` (/connections/apify/new), `check` (kết quả Kiểm tra),
// `detail` (/connections/apify/[id]), `rename`, `replace`, `remove`. Lỗi kiểm tra zod: APIFY_SCHEMA_MESSAGES
// (src/lib/schemas/apify.ts); lỗi từ Apify do service trả về (đã có cách sửa).
export const apify = {
  server: {
    created: "Đã lưu token Apify.",
    renamed: "Đã đổi tên token.",
    enabled: "Đã bật token Apify.",
    disabled: "Đã tắt token Apify.",
    tokenReplaced: "Đã thay token Apify.",
    rechecked: "Đã kiểm tra lại token Apify.",
    deleted: "Đã xoá token Apify.",
  },

  /** nhãn dùng chung của giao diện */
  ui: {
    crumb: "Apify",
    brand: "Apify",
    scope: {
      company: "Công ty",
      personal: "Cá nhân",
    } as Record<string, string>,
    status: {
      active: "Hoạt động",
      exhausted: "Hết credit",
      invalid: "Token không hợp lệ",
      error: "Lỗi",
      disabled: "Đã tắt",
    } as Record<string, string>,
    /** badge "Hết credit tới 01/11" (ngày làm mới credit, giờ Việt Nam) */
    exhaustedUntil: (date: string) => `Hết credit tới ${date}`,
    /** plan.id của Apify → tên gói hiển thị (id lạ: hiện nguyên văn) */
    plans: {
      FREE: "Free",
      STARTER: "Starter",
      SCALE: "Scale",
      BUSINESS: "Business",
      ENTERPRISE: "Enterprise",
    } as Record<string, string>,
    /** "Tài khoản Apify" khi Apify chưa trả username */
    noUsername: "Chưa rõ tài khoản",
    unknown: "Chưa rõ",
    /** "1,20 US$ / 5,00 US$" */
    usageOf: (used: string, limit: string) => `${used} / ${limit}`,
    noLimit: "chưa rõ giới hạn",
    resetOn: (date: string) => `Làm mới ${date}`,
    tokenHint: (hint: string) => `apify_api_••••${hint.replace(/^…/, "")}`,
    adminOnly: "Chỉ quản trị viên",
    newTab: "(mở tab mới)",
  },

  list: {
    tab: "Apify",
    tableLabel: "Danh sách token Apify",
    searchPlaceholder: "Tìm theo tên hoặc tài khoản Apify…",
    searchLabel: "Tìm token Apify",
    colName: "Tên",
    colScope: "Phạm vi",
    colOwner: "Người thêm",
    colAccount: "Tài khoản Apify",
    colCredit: "Credit",
    colStatus: "Trạng thái",
    colChecked: "Kiểm tra lần cuối",
    colActions: "Thao tác",
    never: "Chưa kiểm tra",
    noCredit: "Chưa có số liệu",
    filterScope: "Phạm vi",
    filterStatus: "Trạng thái",
    emptyTitle: "Chưa có token Apify",
    emptyDescription:
      "Thêm API token của Apify để AI lấy dữ liệu Shopee, TikTok, Facebook, Google Maps… qua MCP. Thêm được nhiều token - hệ thống tự xoay vòng.",
    emptyFilteredTitle: "Không có token phù hợp",
    emptyFilteredDescription: "Thử đổi từ khoá tìm kiếm hoặc bỏ bớt bộ lọc.",
    add: "Thêm token Apify",
    readOnly: "Chỉ xem",
    readOnlyHint:
      "Token dùng chung công ty - chỉ quản trị viên sửa hoặc xoá được.",
    rowMenu: (name: string) => `Thao tác với token ${name}`,
    open: "Xem chi tiết",
    recheck: "Kiểm tra lại",
    enable: "Bật token",
    disable: "Tắt token",
    delete: "Xoá token",
    recheckFailed: "Kiểm tra chưa đạt",
  },

  form: {
    metaTitle: "Thêm token Apify",
    title: "Thêm token Apify",
    description:
      "Dán API token của Apify, kiểm tra tài khoản và credit rồi lưu. Thêm được nhiều token.",
    cardTitle: "Thông tin token",
    cardDescription:
      "Token được mã hoá trước khi lưu và không bao giờ hiển thị lại.",
    nameLabel: "Tên gợi nhớ",
    namePlaceholder: "Ví dụ: Apify công ty, Apify của Lan",
    nameHelp: "Hiện trong danh sách token, nhật ký và khi bật Apify cho MCP.",
    tokenLabel: "API token",
    tokenPlaceholder: "apify_api_…",
    tokenHelp:
      "Apify Console → Settings → API & Integrations → sao chép Personal API token.",
    consoleLink: "Mở Apify Console",
    scopeTitle: "Phạm vi dùng",
    scope: {
      company: {
        label: "Dùng chung công ty",
        description:
          "Mọi MCP bật Apify đều xoay vòng được token này. Chỉ quản trị viên thêm, sửa hoặc xoá.",
      },
      personal: {
        label: "Cá nhân",
        description: "Chỉ MCP do chính bạn tạo dùng token này.",
      },
    } as Record<string, { label: string; description: string }>,
    scopeStaffNote:
      "Token bạn thêm là token cá nhân: chỉ MCP của chính bạn dùng. Token dùng chung công ty do quản trị viên thêm.",
    tosTitle: "Lưu ý điều khoản Apify",
    tosBody:
      "Điều khoản Apify không cho một người lập nhiều tài khoản cá nhân. Chỉ xoay vòng token của các tài khoản Apify hợp pháp khác nhau (vd. mỗi người một tài khoản); nhiều token của cùng một tài khoản dùng chung một hạn mức credit.",
    limitTip:
      "Nên đặt giới hạn chi tiêu hằng tháng trong Apify Console → Billing → Limits để không bị trừ quá số tiền bạn muốn.",
    check: "Kiểm tra",
    checking: "Đang kiểm tra…",
    /** the server checks the token with Apify again before saving */
    save: "Kiểm tra & lưu",
    saving: "Đang lưu…",
    back: "Chọn loại kết nối",
    savedTitle: "Đã lưu token Apify",
    savedBody: (name: string) =>
      `Token "${name}" đã sẵn sàng. MCP bật Apify sẽ xoay vòng qua token này.`,
    addAnother: "Thêm token khác",
    viewToken: "Xem token vừa lưu",
    goList: "Về danh sách token",
  },

  check: {
    okTitle: "Token hợp lệ",
    failTitle: "Chưa kiểm tra được",
    account: "Tài khoản Apify",
    plan: "Gói",
    credit: "Credit tháng này",
    remaining: "Còn lại",
    reset: "Làm mới credit",
    actorsDisabled:
      "Tài khoản này hiện không chạy được Actor (Apify đang tắt tính năng chạy Actor - thường do hết credit hoặc tài khoản chưa xác minh). Vẫn lưu được, nhưng AI chỉ dùng được token sau khi kiểm tra lại đạt.",
    sameAccount: (n: number) =>
      `Đã có ${n} token khác của cùng tài khoản Apify này. Các token của một tài khoản dùng chung credit - thêm token này không làm tăng credit AI dùng được.`,
    outdated: "Bạn đã sửa token sau lần kiểm tra - bấm Kiểm tra lần nữa.",
    /** screen-reader announcement after "Kiểm tra" */
    announceOk: (account: string) => `Token hợp lệ: tài khoản ${account}.`,
  },

  detail: {
    metaTitle: "Token Apify",
    recheck: "Kiểm tra lại",
    rechecking: "Đang kiểm tra…",
    recheckFailed: "Kiểm tra chưa đạt",
    rename: "Đổi tên",
    replaceToken: "Thay token",
    enable: "Bật token",
    disable: "Tắt token",
    delete: "Xoá token",
    statusAlert: {
      invalid: "Token không còn hợp lệ",
      error: "Token đang lỗi",
      exhausted: "Token đã hết credit",
      disabled: "Token đã tắt",
    } as Record<string, string>,
    invalidHint:
      "Apify từ chối token này (đã bị xoá, tạo lại hoặc tài khoản bị khoá). Tạo token mới trong Apify Console → Settings → API & Integrations rồi bấm Thay token.",
    errorHint: "Bấm Kiểm tra lại sau ít phút; nếu vẫn lỗi, bấm Thay token.",
    exhaustedHint: (date: string | null) =>
      date
        ? `Tài khoản Apify đã dùng hết credit của chu kỳ này. AI tự chuyển sang token khác và dùng lại token này từ ${date} (ngày làm mới credit).`
        : "Tài khoản Apify đã dùng hết credit của chu kỳ này. AI tự chuyển sang token khác cho tới khi credit được làm mới.",
    disabledHint:
      "Token đang tắt nên AI không dùng tới. Bấm Bật token khi cần.",
    readOnlyTitle: "Token dùng chung công ty",
    readOnlyHint:
      "Bạn xem được tên, trạng thái và credit; chỉ quản trị viên sửa hoặc xoá token này.",
    creditTitle: "Credit Apify",
    creditDescription:
      "Số liệu lấy từ Apify khi kiểm tra (tự động mỗi 6 giờ). Bấm Kiểm tra lại để cập nhật ngay.",
    used: "Đã dùng",
    limit: "Giới hạn chu kỳ",
    remaining: "Còn lại",
    resetAt: "Làm mới credit",
    creditUnknown: "Chưa có số liệu credit - bấm Kiểm tra lại.",
    usagePercent: (p: number) => `Đã dùng ${p}% giới hạn`,
    usageBarLabel: "Credit đã dùng trong chu kỳ",
    sharedNote:
      "Các token của cùng một tài khoản Apify dùng chung credit này. Giới hạn chu kỳ là hard limit đặt trong Apify Console → Billing → Limits.",
    infoTitle: "Thông tin",
    account: "Tài khoản Apify",
    plan: "Gói",
    token: "Token đang lưu",
    scope: "Phạm vi",
    owner: "Người thêm",
    lastChecked: "Kiểm tra lần cuối",
    lastUsed: "Dùng lần cuối",
    createdAt: "Ngày thêm",
    never: "Chưa có",
    usageTitle: "MCP dùng được token này",
    usageNone:
      "Chưa có MCP nào bật Apify dùng được token này. Bật Apify ở bước Quyền khi tạo hoặc sửa MCP.",
    usageOther: (n: number) => `${n} MCP của người khác`,
    runsTitle: "Lần chạy gần đây",
    runsDescription:
      "20 lần chạy Actor gần nhất bằng token này, mới nhất ở trên.",
    runsTable: "Lịch sử chạy Actor bằng token này",
    colTime: "Thời gian",
    colMcp: "MCP",
    colTask: "Việc / Actor",
    colStatus: "Trạng thái",
    colCost: "Chi phí",
    noRuns:
      "Chưa có lần chạy nào. Khi AI lấy dữ liệu qua Apify bằng token này, lần chạy sẽ hiện ở đây.",
    storeActor: "Actor ngoài danh mục",
    costPending: "Chưa có",
    runStatus: {
      READY: "Chờ chạy",
      RUNNING: "Đang chạy",
      SUCCEEDED: "Thành công",
      FAILED: "Thất bại",
      "TIMING-OUT": "Sắp quá giờ",
      "TIMED-OUT": "Quá thời gian",
      ABORTING: "Đang dừng",
      ABORTED: "Đã dừng",
      // daily-cap reservations (apify_runs): starting / start not confirmed (still counted for the day)
      STARTING: "Đang khởi chạy",
      UNKNOWN: "Không rõ đã chạy chưa",
    } as Record<string, string>,
    refresh: "Tải lại",
  },

  rename: {
    title: "Đổi tên token",
    description: "Tên chỉ dùng để hiển thị, không ảnh hưởng tới token.",
    label: "Tên gợi nhớ",
    submit: "Lưu tên",
  },

  replace: {
    title: "Thay token Apify",
    description:
      "Dán token mới (ví dụ sau khi tạo lại token trong Apify Console). Token mới được kiểm tra với Apify trước khi thay.",
    tokenLabel: "API token mới",
    currentHint: (hint: string) =>
      `Token đang lưu: apify_api_••••${hint.replace(/^…/, "")}`,
    submit: "Kiểm tra & thay token",
  },

  remove: {
    title: "Xoá token Apify?",
    description: (name: string) =>
      `Token "${name}" sẽ bị xoá khỏi hệ thống (token trên Apify vẫn còn). MCP đang xoay vòng qua token này sẽ dùng các token còn lại.`,
    affected: "MCP bị ảnh hưởng",
    confirm: "Xoá token",
    revokeTip:
      "Không dùng nữa? Xoá hoặc tạo lại token trong Apify Console để token cũ hết hiệu lực.",
  },
} as const
