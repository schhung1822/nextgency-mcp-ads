// Chuỗi giao diện tiếng Việt - nhóm "dashboard". Chỉ agent sở hữu nhóm này sửa file này.
export const dashboard = {
  title: "Tổng quan",
  metaTitle: "Tổng quan · Ads MCP",
  description: "Theo dõi nhanh kết nối, MCP và lượt gọi từ AI.",
  descriptionStaff: "Theo dõi nhanh kết nối, MCP và lượt gọi từ AI của bạn.",
  createMcp: "Tạo MCP",

  kpi: {
    connections: "Kết nối",
    connectionsWarn: (n: number) => (n > 0 ? `${n} cần chú ý` : "Tất cả ổn định"),
    noConnections: "Chưa có kết nối nào",
    adAccounts: "Tài khoản QC",
    adAccountsHint: "Đang bật để dùng trong MCP",
    activeMcp: "MCP hoạt động",
    activeMcpHint: (total: number) => `Trên tổng ${total} MCP`,
    calls24h: "Lượt gọi 24h",
    callsHint: "Chỉ tính lệnh gọi tool",
    errorRate24h: "Tỉ lệ lỗi 24h",
    errorsHint: (n: number) => `${n} lượt lỗi`,
    vsPrev: "so với 24h trước",
  },

  chart: {
    title: "Lượt gọi MCP",
    description: (days: number) => `Lượt gọi tool trong ${days} ngày qua, theo nền tảng`,
    range: "Khoảng thời gian biểu đồ",
    days7: "7 ngày",
    days30: "30 ngày",
    other: "Khác",
    total: "Tổng",
    empty: "Chưa có lượt gọi nào trong khoảng này.",
    emptyHint: "Sau khi kết nối MCP với Claude/ChatGPT/Gemini, số liệu sẽ hiện ở đây (cập nhật mỗi 5 phút).",
    addConnection: "Thêm kết nối",
    tableToggle: "Xem dạng bảng",
    chartToggle: "Xem biểu đồ",
    date: "Ngày",
  },

  alerts: {
    title: "Cảnh báo",
    none: "Không có cảnh báo nào.",
    noneHint: "Mọi kết nối đang hoạt động bình thường.",
    expiresIn: (days: number) =>
      days <= 0 ? "Token đã hết hạn" : `Token hết hạn sau ${days} ngày`,
    invalid: "Lỗi xác thực - kiểm tra lại token",
    expiring: "Token sắp hết hạn",
    check: "Kiểm tra lại",
    manage: "Quản lý kết nối",
    defaultPartition: (n: string) =>
      `Có ${n} dòng nhật ký nằm ngoài partition tháng. Hãy kiểm tra job bảo trì nhật ký.`,
    openSettings: "Mở Cài đặt",
    updateTitle: (v: string) => `Có bản mới ${v}`,
    updateHint: (current: string) => `Bạn đang dùng ${current}. Cập nhật để nhận bản vá và tính năng mới.`,
    updateCta: "Xem và cập nhật",
  },

  recent: {
    title: "Hoạt động gần đây",
    viewAll: "Xem tất cả",
    empty: "Chưa có hoạt động nào.",
    mcpCall: "Lượt gọi MCP",
    staffAction: "Nhân sự",
    by: (who: string) => `bởi ${who}`,
  },
} as const
