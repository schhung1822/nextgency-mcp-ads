// Chuỗi giao diện tiếng Việt dùng chung.
export const common = {
  appName: "Ads MCP",
  appFullName: "Ads MCP by: noti.vn",
  save: "Lưu thay đổi",
  cancel: "Huỷ",
  confirm: "Xác nhận",
  delete: "Xoá",
  edit: "Sửa",
  back: "Quay lại",
  next: "Tiếp tục",
  close: "Đóng",
  copy: "Sao chép",
  copied: "Đã sao chép",
  copyFailed: "Không sao chép được. Hãy bôi đen và sao chép thủ công.",
  more: "Thêm",
  search: "Tìm kiếm…",
  loading: "Đang tải…",
  retry: "Thử lại",
  noData: "Chưa có dữ liệu",
  genericError: "Đã có lỗi xảy ra. Vui lòng thử lại.",
  forbidden: "Bạn không có quyền thực hiện thao tác này.",

  notFound: {
    metaTitle: "Không tìm thấy trang",
    code: "404",
    title: "Không tìm thấy trang",
    description:
      "Trang bạn mở không tồn tại, đã bị xoá hoặc bạn không có quyền xem. Kiểm tra lại đường dẫn hoặc quay về Tổng quan.",
    home: "Về Tổng quan",
  },

  errorPage: {
    title: "Đã có lỗi xảy ra",
    description:
      "Trang này gặp sự cố khi tải. Bạn có thể thử lại; nếu lỗi lặp lại, hãy báo cho quản trị viên kèm mã lỗi bên dưới.",
    digest: (id: string) => `Mã lỗi: ${id}`,
    retry: "Thử lại",
    home: "Về Tổng quan",
  },

  brand: {
    byline: "by noti.vn",
    logoAlt: "noti.vn",
    markAlt: "Ads MCP",
  },

  notices: {
    label: "Thông báo hệ thống",
  },

  nav: {
    label: "Điều hướng chính",
    dashboard: "Tổng quan",
    connections: "Kết nối quảng cáo",
    mcp: "MCP",
    logs: "Nhật ký",
    users: "Người dùng",
    settings: "Cài đặt",
    account: "Tài khoản",
    adminGroup: "Quản trị",
    toggleSidebar: "Thu gọn/mở rộng thanh bên",
    skipToContent: "Bỏ qua điều hướng, tới nội dung chính",
    breadcrumb: "Đường dẫn trang",
    crumbNew: "Tạo mới",
    crumbUpdates: "Cập nhật hệ thống",
    crumbEdit: "Chỉnh sửa",
    crumbDetail: "Chi tiết",
    crumbDev: "Dev",
    crumbDevUi: "Thư viện giao diện",
  },

  /** thanh điều hướng cố định ở đáy màn hình điện thoại (< 768px) */
  bottomNav: {
    label: "Điều hướng nhanh",
    dashboard: "Tổng quan",
    connections: "Kết nối",
    mcp: "MCP",
    logs: "Nhật ký",
    menu: "Menu",
    menuTitle: "Menu",
    menuDescription: "Trang quản trị, giao diện và đăng xuất.",
    adminGroup: "Quản trị",
    appearance: "Giao diện",
  },

  user: {
    menu: "Menu tài khoản",
    signOut: "Đăng xuất",
    appearance: "Giao diện",
    roleAdmin: "Quản trị viên",
    roleStaff: "Nhân viên",
  },

  theme: {
    label: "Giao diện",
    light: "Sáng",
    dark: "Tối",
    system: "Hệ thống",
    toggle: "Đổi giao diện sáng/tối",
  },

  transparency: {
    label: "Giảm hiệu ứng trong suốt",
    description: "Dùng nền đặc thay cho hiệu ứng kính mờ để dễ đọc hơn.",
  },

  commandPalette: {
    open: "Mở tìm kiếm nhanh",
    close: "Đóng",
    title: "Tìm nhanh",
    description: "Nhảy tới trang, MCP hoặc kết nối.",
    placeholder: "Gõ để tìm trang…",
    empty: "Không tìm thấy kết quả.",
    pages: "Trang",
    shortcutHint: "Nhấn ⌘K hoặc Ctrl+K",
    footerNavigate: "di chuyển",
    footerOpen: "mở",
    footerClose: "đóng",
  },

  notifications: {
    label: "Thông báo",
  },

  table: {
    selectAll: "Chọn tất cả",
    selectRow: "Chọn dòng",
    empty: "Không có dữ liệu phù hợp.",
    loadMore: "Tải thêm",
    loadingMore: "Đang tải thêm…",
    previous: "Trang trước",
    nextPage: "Trang sau",
    selected: (n: number) => `Đã chọn ${n} dòng`,
    clearSelection: "Bỏ chọn",
    sortAsc: "Sắp xếp tăng dần",
    sortDesc: "Sắp xếp giảm dần",
    sortBy: (col: string) => `Sắp xếp theo ${col}`,
    pageOf: (page: number, total: number) => `Trang ${page}/${total}`,
    rowsTotal: (n: number) => `${n} dòng`,
    bulkActions: "Thao tác hàng loạt",
    columns: "Cột hiển thị",
  },

  filter: {
    search: "Tìm kiếm…",
    clear: "Xoá bộ lọc",
    clearAll: "Xoá tất cả bộ lọc",
    groupLabel: "Bộ lọc",
    selectedCount: (n: number) => `${n} đã chọn`,
    noOptions: "Không có lựa chọn",
    removeFilter: (label: string) => `Bỏ lọc ${label}`,
  },

  dateRange: {
    label: "Khoảng thời gian",
    placeholder: "Chọn khoảng thời gian",
    today: "Hôm nay",
    yesterday: "Hôm qua",
    last7: "7 ngày qua",
    last30: "30 ngày qua",
    thisMonth: "Tháng này",
    lastMonth: "Tháng trước",
    custom: "Tuỳ chọn",
    apply: "Áp dụng",
  },

  pageHeader: {
    back: "Quay lại",
    moreActions: "Thêm",
  },

  confirmDialog: {
    typeToConfirm: (name: string) => `Gõ "${name}" để xác nhận`,
    typeMismatch: "Tên chưa khớp",
    irreversible: "Thao tác này không thể hoàn tác.",
  },

  secret: {
    show: "Hiện",
    hide: "Ẩn",
    showLabel: "Hiện giá trị",
    hideLabel: "Ẩn giá trị",
    savedHint: (hint: string) => `Đang lưu: ${hint} - để trống nếu không đổi`,
  },

  json: {
    expandAll: "Mở rộng tất cả",
    collapseAll: "Thu gọn tất cả",
    copy: "Sao chép JSON",
    items: (n: number) => `${n} mục`,
    keys: (n: number) => `${n} khoá`,
    expand: "Mở rộng",
    collapse: "Thu gọn",
  },

  helpPanel: {
    title: "Hướng dẫn",
    steps: "Các bước",
    requiredScopes: "Quyền cần cấp",
    warnings: "Lưu ý",
    openLink: "Mở trang",
    newTab: "(mở tab mới)",
  },

  stepper: {
    label: "Tiến trình",
    step: (n: number) => `Bước ${n}`,
    completed: "Đã xong",
    current: "Đang làm",
  },

  saveBar: {
    unsaved: "Có thay đổi chưa lưu",
    discard: "Huỷ",
    save: "Lưu",
    saving: "Đang lưu…",
  },

  kpi: {
    increase: "Tăng",
    decrease: "Giảm",
  },

  status: {
    connection: {
      active: "Hoạt động",
      expiring: "Sắp hết hạn",
      invalid: "Lỗi xác thực",
      disabled: "Đã tắt",
    },
    mcp: {
      active: "Hoạt động",
      disabled: "Đã tắt",
      expired: "Hết hạn",
    },
    log: {
      success: "Thành công",
      error: "Lỗi",
      denied: "Bị từ chối",
      rate_limited: "Vượt giới hạn",
      pending_confirmation: "Chờ xác nhận",
      invalid_request: "Yêu cầu không hợp lệ",
    },
    object: {
      active: "Đang chạy",
      paused: "Tạm dừng",
      archived: "Đã lưu trữ",
      deleted: "Đã xoá",
      removed: "Đã gỡ",
      pending_review: "Chờ duyệt",
      rejected: "Bị từ chối",
      disabled: "Đã tắt",
      unknown: "Không rõ",
    },
    account: {
      active: "Hoạt động",
      disabled: "Bị vô hiệu hoá",
      pending: "Đang chờ",
      closed: "Đã đóng",
      unknown: "Không rõ",
    },
    unknown: "Không rõ",
  },
} as const
