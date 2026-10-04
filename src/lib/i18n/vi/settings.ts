// Chuỗi giao diện tiếng Việt - nhóm "settings". Chỉ agent sở hữu nhóm này sửa file này.
export const settings = {
  title: "Cài đặt",
  metaTitle: "Cài đặt · Ads MCP",
  description: "Cấu hình lưu trữ nhật ký, bảo mật và xem thông tin hệ thống.",
  save: "Lưu thay đổi",
  saved: "Đã lưu cài đặt.",
  noChanges: "Không có thay đổi nào để lưu.",
  saveFailed: "Không lưu được cài đặt. Vui lòng thử lại.",

  retention: {
    title: "Lưu trữ nhật ký",
    description:
      "Nhật ký cũ hơn số tháng này sẽ tự xoá theo từng tháng (job chạy 03:15 mỗi ngày).",
    mcp: "Nhật ký MCP (tháng)",
    staff: "Nhật ký nhân sự (tháng)",
    help: (n: number) =>
      `Giữ ít nhất ${n} tháng trọn + tháng hiện tại. Dữ liệu cũ hơn bị xoá vĩnh viễn và không khôi phục được.`,
    range: "Từ 1 đến 24 tháng.",
    shrinkWarning:
      "Giảm số tháng sẽ xoá phần nhật ký cũ ở lần bảo trì tiếp theo - không thể hoàn tác.",
  },

  security: {
    title: "Bảo mật",
    description: "Áp dụng cho mọi tài khoản trong hệ thống.",
    require2faAdmin: "Bắt buộc xác thực 2 bước cho quản trị viên",
    require2faAdminHelp:
      "Mặc định tắt: 2FA là tuỳ chọn, mỗi người tự bật/tắt trong trang Tài khoản. Khuyên bật khi đưa lên máy chủ thật - quản trị viên chưa có 2FA sẽ phải thiết lập ở lần vào trang tiếp theo.",
    require2fa: "Bắt buộc xác thực 2 bước cho mọi người",
    require2faHelp:
      "Bật mục này để mọi tài khoản (cả nhân viên) chưa bật 2FA phải thiết lập ở lần vào trang tiếp theo.",
    sessionHours: "Thời lượng phiên đăng nhập tối đa (giờ)",
    sessionHoursHelp: "Từ 1 đến 168 giờ. Hết thời gian này, người dùng phải đăng nhập lại.",
  },

  apiVersions: {
    title: "Phiên bản API nền tảng",
    description:
      "Chỉ đọc. Đổi bằng biến môi trường rồi khởi động lại ứng dụng.",
    platform: "Nền tảng",
    version: "Phiên bản",
    envVar: "Biến môi trường",
    note: "Ghi chú",
    notes: {
      meta: "v24.0 hết hạn ngày 06/10/2026. Từ 27/10/2026 thay đổi của v26 áp dụng cho mọi phiên bản.",
      openai_ads: "API mới, thay đổi nhanh - xem tài liệu nền tảng trước khi nâng cấp.",
    },
    warnSoon: "Sắp hết hạn",
    expired: "Đã hết hạn",
  },

  system: {
    title: "Thông tin hệ thống",
    description: "Phiên bản ứng dụng và dung lượng bảng nhật ký.",
    appVersion: "Phiên bản ứng dụng",
    timezone: "Múi giờ ứng dụng",
    table: "Bảng",
    partitions: "Partition",
    size: "Dung lượng",
    rows: "Số dòng (ước tính)",
    range: "Khoảng thời gian",
    mcpLogs: "Nhật ký MCP",
    staffLogs: "Nhật ký nhân sự",
    stats: "Thống kê theo giờ",
    defaultPartition: "Partition mặc định",
    defaultRowsWarning: (n: string) =>
      `Có ${n} dòng rơi vào partition mặc định (ngoài các tháng đã tạo). Job “logs.maintain” cần chạy để tạo partition tháng.`,
    defaultEmpty: "Trống - tốt",
    partitionCount: (n: number) => `${n} partition`,
    showPartitions: "Xem danh sách partition",
    hidePartitions: "Ẩn danh sách partition",
  },
} as const
