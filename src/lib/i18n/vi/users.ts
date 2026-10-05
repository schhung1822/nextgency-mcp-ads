// Chuỗi giao diện tiếng Việt - nhóm "users" (trang Người dùng, chỉ Admin).
export const users = {
  metaTitle: "Người dùng",
  title: "Người dùng",
  description: "Tạo tài khoản cho đội của bạn, phân quyền và quản lý bảo mật đăng nhập.",
  add: "Thêm người dùng",
  tableLabel: "Danh sách người dùng",

  columns: {
    user: "Người dùng",
    name: "Tên",
    email: "Email",
    role: "Vai trò",
    twoFactor: "2FA",
    status: "Trạng thái",
    lastLogin: "Đăng nhập cuối",
    actions: "Thao tác",
  },

  you: "Bạn",
  /** re-auth hint when the target of a sensitive action is an admin (ban / unban / delete / revoke sessions) */
  adminTargetReauthHint: "Người này là quản trị viên - nhập lại mật khẩu (và mã 2FA) của bạn để xác nhận.",
  /** re-auth hint for staff targets once the session is no longer fresh (reset password / 2FA) */
  reauthFreshHint:
    "Thao tác nhạy cảm - nhập lại mật khẩu (và mã 2FA) của bạn để xác nhận. Sau khi xác nhận, bạn không phải nhập lại trong 10 phút.",
  noName: "(chưa đặt tên)",
  neverLoggedIn: "Chưa đăng nhập",
  twoFactorOn: "Đã bật",
  twoFactorOff: "Chưa bật",
  status: {
    active: "Hoạt động",
    banned: "Đã khoá",
    mustChangePassword: "Chờ đổi mật khẩu",
  },
  roles: {
    admin: "Quản trị viên",
    staff: "Nhân viên",
  },
  roleHints: {
    admin: "Toàn quyền: quản lý người dùng, cài đặt, thấy mọi kết nối và MCP.",
    staff: "Chỉ tạo và dùng kết nối, MCP của chính mình.",
  },
  /** one-liners under the role options (create / change role) */
  roleShort: {
    admin: "Toàn quyền, thấy mọi kết nối và MCP.",
    staff: "Chỉ dùng kết nối và MCP của mình.",
  },

  tabs: {
    all: "Tất cả",
    admin: "Quản trị viên",
    staff: "Nhân viên",
    banned: "Đã khoá",
  },
  search: {
    placeholder: "Tìm theo tên hoặc email",
    label: "Tìm người dùng",
  },
  filterTwoFactor: "Xác thực 2 bước",
  emptyFiltered: {
    title: "Không có người dùng phù hợp",
    description: "Thử đổi từ khoá tìm kiếm hoặc bỏ bớt bộ lọc.",
  },

  empty: {
    title: "Chưa có người dùng nào khác",
    description: "Thêm tài khoản cho nhân viên để họ tự kết nối quảng cáo và tạo MCP.",
  },

  rowActions: {
    menu: (name: string) => `Thao tác với ${name}`,
    changeRole: "Đổi vai trò",
    resetPassword: "Đặt lại mật khẩu",
    reset2fa: "Đặt lại 2FA",
    ban: "Khoá tài khoản",
    unban: "Mở khoá",
    sessions: "Xem phiên đăng nhập",
    delete: "Xoá người dùng",
    selfHint: "Đây là tài khoản của bạn",
    openAccount: "Mở trang Tài khoản",
  },

  create: {
    title: "Thêm người dùng",
    description: "Người dùng sẽ đăng nhập bằng mật khẩu tạm và phải đổi mật khẩu ở lần đầu.",
    name: "Họ tên",
    email: "Email",
    role: "Vai trò",
    password: "Mật khẩu tạm",
    passwordHint: "Ít nhất 8 ký tự. Bấm “Tạo ngẫu nhiên” để có mật khẩu mạnh.",
    generate: "Tạo ngẫu nhiên",
    submit: "Tạo người dùng",
    submitting: "Đang tạo…",
    doneTitle: "Đã tạo người dùng",
    doneDescription:
      "Gửi email và mật khẩu tạm cho người dùng qua kênh an toàn (không gửi chung một tin nhắn công khai). Mật khẩu tạm chỉ hiện lần này.",
    adminReauthTitle: "Xác nhận bằng tài khoản của bạn",
    adminReauthHint: "Tạo quản trị viên là thao tác nhạy cảm - nhập lại mật khẩu và mã 2FA của bạn để xác nhận.",
    roleAria: "Vai trò của người dùng mới",
    copyAll: "Sao chép thông tin đăng nhập",
    loginUrl: "Địa chỉ đăng nhập",
    copyText: (email: string, password: string, url: string) =>
      `Địa chỉ đăng nhập: ${url}\nEmail: ${email}\nMật khẩu tạm: ${password}`,
    reauthRequired: "Nhập mật khẩu của bạn để tạo quản trị viên.",
    doneEmail: "Email đăng nhập",
    donePassword: "Mật khẩu tạm",
    close: "Xong",
  },

  changeRole: {
    title: (name: string) => `Đổi vai trò của ${name}`,
    description: "Thay đổi có hiệu lực ngay ở lần tải trang kế tiếp của người dùng.",
    role: "Vai trò mới",
    password: "Mật khẩu của bạn",
    passwordHint: "Đổi vai trò là thao tác nhạy cảm - nhập lại mật khẩu (và mã 2FA) để xác nhận.",
    codeRequired: "Nhập mã xác thực 6 số từ ứng dụng Authenticator.",
    submit: "Đổi vai trò",
    submitting: "Đang lưu…",
  },

  resetPassword: {
    title: (name: string) => `Đặt lại mật khẩu cho ${name}`,
    description:
      "Người dùng bị đăng xuất khỏi mọi thiết bị và phải đổi mật khẩu khi đăng nhập lại bằng mật khẩu tạm.",
    password: "Mật khẩu tạm mới",
    adminReauthHint: "Người này là quản trị viên - nhập lại mật khẩu và mã 2FA của bạn để xác nhận.",
    submit: "Đặt lại mật khẩu",
    submitting: "Đang lưu…",
    doneTitle: "Đã đặt lại mật khẩu",
    doneDescription: "Gửi mật khẩu tạm cho người dùng qua kênh an toàn. Mật khẩu chỉ hiện lần này.",
  },

  reset2fa: {
    title: (name: string) => `Đặt lại xác thực 2 bước của ${name}?`,
    description:
      "Ứng dụng xác thực và mã dự phòng cũ sẽ mất hiệu lực, người dùng bị đăng xuất. Họ có thể bật lại 2FA trong trang Tài khoản (hoặc ngay lần đăng nhập tới nếu hệ thống bắt buộc).",
    confirm: "Đặt lại 2FA",
  },

  ban: {
    title: (name: string) => `Khoá tài khoản ${name}?`,
    description: "Người dùng bị đăng xuất ngay và không đăng nhập được cho tới khi mở khoá. MCP họ tạo vẫn giữ nguyên.",
    confirm: "Khoá tài khoản",
  },
  unban: {
    title: (name: string) => `Mở khoá tài khoản ${name}?`,
    description: "Người dùng có thể đăng nhập lại bằng mật khẩu hiện tại.",
    confirm: "Mở khoá",
  },

  delete: {
    title: (name: string) => `Xoá người dùng ${name}?`,
    description:
      "Tài khoản bị xoá vĩnh viễn. Nhật ký cũ vẫn giữ email của họ. Nếu người dùng còn kết nối hoặc MCP, hãy xoá chúng trước.",
    confirm: "Xoá người dùng",
  },

  sessions: {
    title: (name: string) => `Phiên đăng nhập của ${name}`,
    description: "Các thiết bị đang đăng nhập. Thu hồi để buộc thiết bị đó đăng nhập lại.",
    empty: "Không có phiên đăng nhập nào đang hoạt động.",
    revoke: "Thu hồi",
    revokeLabel: (device: string) => `Thu hồi phiên trên ${device}`,
    revokeAll: "Thu hồi tất cả",
    loading: "Đang tải phiên đăng nhập…",
    loadFailed: "Không tải được danh sách phiên. Thử lại sau.",
    createdAt: "Đăng nhập lúc",
    lastActive: "Hoạt động gần nhất",
    ip: "IP",
    unknownIp: "Không rõ IP",
    reauthTitle: (name: string) => `Thu hồi phiên đăng nhập của ${name}`,
    reauthDescription: "Người này là quản trị viên - nhập lại mật khẩu (và mã 2FA) của bạn để xác nhận.",
  },

  toast: {
    created: "Đã tạo người dùng",
    credentialsCopied: "Đã sao chép thông tin đăng nhập",
    roleChanged: "Đã đổi vai trò",
    passwordReset: "Đã đặt lại mật khẩu",
    twoFactorReset: "Đã đặt lại xác thực 2 bước",
    banned: "Đã khoá tài khoản",
    unbanned: "Đã mở khoá tài khoản",
    deleted: "Đã xoá người dùng",
    sessionRevoked: "Đã thu hồi phiên đăng nhập",
    sessionsRevoked: "Đã thu hồi mọi phiên đăng nhập",
  },

  errors: {
    self: "Bạn không thể thực hiện thao tác này với chính tài khoản của mình. Hãy dùng trang Tài khoản.",
    lastAdmin:
      "Cần luôn còn ít nhất 1 quản trị viên đang hoạt động (và đã bật 2FA nếu hệ thống bắt buộc). Hãy chỉ định quản trị viên khác trước.",
    notFound: "Không tìm thấy người dùng. Có thể người dùng đã bị xoá - tải lại trang.",
    ownsResources: (connections: number, mcps: number) =>
      `Người dùng còn ${connections} kết nối và ${mcps} MCP. Hãy xoá chúng trước khi xoá người dùng.`,
    sameRole: "Người dùng đã có vai trò này.",
  },

  validation: {
    roleInvalid: "Chọn vai trò hợp lệ.",
  },
} as const
