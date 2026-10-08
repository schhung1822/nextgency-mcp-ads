// Chuỗi giao diện tiếng Việt - nhóm "updates": phiên bản & cập nhật hệ thống (.claude/docs/10-update-system.md).
export const updates = {
  title: "Cập nhật hệ thống",
  description: "Xem phiên bản đang chạy, kiểm tra bản mới và cập nhật chỉ với một cú bấm. Chỉ quản trị viên dùng được trang này.",
  backToSettings: "Quay lại Cài đặt",

  /** thẻ trong trang Cài đặt */
  settingsCard: {
    title: "Phiên bản & cập nhật",
    description: "Xem bản đang chạy và cập nhật lên bản mới.",
    current: "Đang chạy",
    newAvailable: (v: string) => `Có bản mới ${v}`,
    open: "Mở trang cập nhật",
  },

  /** menu người dùng (mọi người) + mục cho quản trị viên */
  menu: {
    version: (v: string) => `Phiên bản ${v}`,
    newVersion: (v: string) => `Có bản mới ${v}`,
    dotLabel: "Có bản cập nhật mới",
    sidebarLabel: "Phiên bản",
    current: "Hiện tại",
    latest: "Mới nhất",
    notChecked: "Chưa kiểm tra",
    badgeNew: "Có bản mới",
    badgeUpToDate: "Đã cập nhật",
    openDetails: (current: string, latest: string | null) =>
      latest
        ? `Phiên bản hiện tại ${current}, mới nhất ${latest}. Mở trang Cập nhật hệ thống`
        : `Phiên bản hiện tại ${current}. Mở trang Cập nhật hệ thống`,
  },

  versionCard: {
    title: "Phiên bản",
    running: "Đang chạy",
    latest: "Bản mới nhất",
    lastChecked: "Kiểm tra lần cuối",
    published: "Phát hành",
    neverChecked: "Chưa kiểm tra lần nào",
    badgeUpToDate: "Mới nhất",
    badgeNew: "Có bản mới",
    devBuild:
      "Đây là bản phát triển (không gắn với một bản phát hành), nên không cập nhật tự động được. Hãy dùng ảnh Docker của một bản phát hành để bật tính năng này.",
    upToDate: "Bạn đang dùng bản mới nhất.",
    noLatest: "Chưa biết bản mới nhất. Bấm Kiểm tra ngay để hỏi GitHub.",
    checking: "Đang kiểm tra bản mới trên GitHub…",
    checkFailed: "Lần kiểm tra gần nhất không thành công",
    checkFailedAt: (when: string) => `lúc ${when}`,
  },

  notes: {
    title: (v: string) => `Có gì mới trong ${v}`,
    empty: "Bản phát hành này không có ghi chú.",
    viewOnGithub: "Xem trên GitHub",
    newTab: "(mở tab mới)",
  },

  actions: {
    check: "Kiểm tra ngay",
    checking: "Đang kiểm tra…",
    update: (v: string) => `Cập nhật lên ${v}`,
    updating: "Đang cập nhật…",
    retry: "Thử lại",
  },

  toast: {
    checkedNew: (v: string) => `Có bản mới ${v}.`,
    checkedLatest: "Bạn đang dùng bản mới nhất.",
    started: "Đã gửi yêu cầu cập nhật. Đang chờ dịch vụ cập nhật nhận việc…",
  },

  confirm: {
    title: (v: string) => `Cập nhật lên ${v}?`,
    description: (from: string, to: string) => `Xác nhận bằng mật khẩu để cập nhật từ ${from} lên ${to}.`,
    submit: "Cập nhật",
    submitting: "Đang gửi yêu cầu…",
    points: [
      "Ứng dụng sẽ gián đoạn khoảng 1-2 phút trong lúc khởi động lại. Người đang dùng trang có thể thấy lỗi ngắn.",
      "Hệ thống tự sao lưu cơ sở dữ liệu trước khi cập nhật.",
      "Nếu có lỗi, hệ thống tự quay về bản đang chạy.",
    ],
    hint: "Nhập mật khẩu của bạn để xác nhận việc cập nhật.",
  },

  progress: {
    title: "Tiến trình cập nhật",
    description: (from: string, to: string) => `Từ ${from} lên ${to}`,
    pending: "Đang chờ dịch vụ cập nhật nhận việc…",
    restarting: "Ứng dụng đang khởi động lại, vui lòng đợi. Trang sẽ tự kết nối lại.",
    reconnecting: "Chưa kết nối được tới ứng dụng, đang thử lại…",
    sessionEnded: "Phiên đăng nhập đã hết hạn. Hãy tải lại trang để đăng nhập lại.",
    reload: "Tải lại trang",
    succeeded: (v: string) => `Đã cập nhật lên ${v}. Trang sẽ tự tải lại.`,
    failed: "Cập nhật không thành công.",
    rolledBack: "Cập nhật gặp lỗi và hệ thống đã quay về bản cũ.",
    noMessage: "Không có thông báo chi tiết. Xem nhật ký của dịch vụ cập nhật trên máy chủ.",
    steps: {
      backup: "Sao lưu cơ sở dữ liệu",
      pull: "Tải bản mới",
      migrate: "Cập nhật cơ sở dữ liệu",
      restart: "Khởi động lại ứng dụng",
      healthcheck: "Kiểm tra hoạt động",
      rollback: "Quay về bản cũ",
    },
    stepState: {
      done: "Xong",
      current: "Đang chạy",
      todo: "Chờ",
      failed: "Lỗi",
    },
  },

  history: {
    title: "Lịch sử cập nhật",
    description: "10 lần gần nhất.",
    empty: "Chưa có lần cập nhật nào.",
    emptyHint: "Khi bạn cập nhật, từng lần sẽ được ghi lại ở đây.",
    by: (who: string) => `bởi ${who}`,
    status: {
      pending: "Đang chờ",
      running: "Đang chạy",
      succeeded: "Thành công",
      failed: "Thất bại",
      rolled_back: "Đã quay về bản cũ",
    },
  },

  updater: {
    title: "Cập nhật tự động",
    online: "Đang hoạt động",
    offline: "Chưa bật",
    onlineHint: "Dịch vụ cập nhật đang chạy trên máy chủ và sẵn sàng nhận yêu cầu.",
    onlineVersion: (v: string) => `Phiên bản dịch vụ: ${v}`,
    lastSeen: "Tín hiệu gần nhất",
    offlineHint:
      "Nút Cập nhật chỉ dùng được khi dịch vụ cập nhật (updater) đang chạy trên máy chủ. Trong lúc chờ, bạn có thể cập nhật bằng tay.",
    manualTitle: "Cập nhật bằng tay",
    manualSteps: [
      "Đăng nhập máy chủ (SSH) và vào thư mục chứa docker-compose.yml.",
      "Nếu ghi chú phát hành báo có thay đổi docker-compose.yml hoặc Caddyfile, chạy git pull trước.",
      "Chạy lệnh bên dưới, thay X.Y.Z bằng phiên bản muốn cập nhật. Ứng dụng tự chạy migration trước khi web và worker khởi động lại. Chi tiết: docs/deploy-vps.md mục 11.",
    ],
    manualCommand:
      "sed -i 's/^APP_VERSION=.*/APP_VERSION=X.Y.Z/' .env && docker compose pull && docker compose up -d --no-build",
    enableTitle: "Bật cập nhật tự động",
    enableSteps: [
      "Bật dịch vụ updater: thêm COMPOSE_PROFILES=updater vào .env và kiểm tra HOST_PROJECT_DIR, UPDATER_DOCKER_CONFIG theo docs/deploy-vps.md mục 11.",
      "Chạy docker compose up -d --no-build. Sau khoảng 1 phút trạng thái ở đây chuyển sang Đang hoạt động.",
    ],
    note: "Web không bao giờ được cấp quyền Docker. Việc chạy Docker chỉ do dịch vụ updater đảm nhiệm.",
  },

  /** lý do không cho bấm Cập nhật */
  block: {
    no_update: "Chưa có bản mới để cập nhật.",
    dev_build: "Bản phát triển không cập nhật tự động được.",
    busy: "Đang có một lần cập nhật chạy. Hãy đợi nó xong.",
    updater_offline: "Dịch vụ cập nhật chưa chạy trên máy chủ.",
  },

  loadFailed: "Không tải được trạng thái cập nhật. Vui lòng tải lại trang.",

  /** lỗi trả về từ action / service */
  errors: {
    forbidden: "Chỉ quản trị viên được cập nhật hệ thống.",
    invalidTarget: "Phiên bản đích không hợp lệ.",
    noUpdate: "Chưa có bản mới để cập nhật. Hãy bấm Kiểm tra ngay rồi thử lại.",
    devBuild: "Bản phát triển không cập nhật tự động được.",
    targetMismatch: "Bản mới nhất đã thay đổi. Hãy tải lại trang rồi thử lại.",
    busy: "Đang có một lần cập nhật chạy hoặc đang chờ. Hãy đợi nó xong.",
    updaterOffline: "Dịch vụ cập nhật chưa chạy trên máy chủ nên chưa thể cập nhật tự động.",
    staleExpired: "Không có dịch vụ cập nhật nhận việc nên yêu cầu đã hết hạn.",
    generic: "Không gửi được yêu cầu cập nhật. Vui lòng thử lại.",
    checkGeneric: "Không kiểm tra được bản mới. Vui lòng thử lại sau.",
    checkThrottled: (sec: number) => `Bạn kiểm tra quá nhanh. Vui lòng thử lại sau ${sec} giây.`,
  },

  /** lỗi khi hỏi GitHub (không bao giờ chứa token) */
  github: {
    noRelease:
      "Không tìm thấy bản phát hành nào. Nếu kho mã là riêng tư, hãy đặt UPDATE_GITHUB_TOKEN (Token B ở README bước 1, của tài khoản GitHub được noti.vn cấp quyền) cho web và worker.",
    badRepo: "UPDATE_REPO không hợp lệ. Định dạng đúng là tên-chủ/tên-kho.",
    unauthorized: "GitHub từ chối token (UPDATE_GITHUB_TOKEN sai hoặc hết hạn).",
    forbidden: "GitHub không cho phép truy cập kho này. Kiểm tra quyền của UPDATE_GITHUB_TOKEN.",
    rateLimited: "GitHub đang giới hạn số lần kiểm tra. Hãy thử lại sau ít phút hoặc đặt UPDATE_GITHUB_TOKEN.",
    rateLimitedAt: (when: string) => `GitHub đang giới hạn số lần kiểm tra. Thử lại sau ${when}, hoặc đặt UPDATE_GITHUB_TOKEN.`,
    unavailable: "GitHub tạm thời không phản hồi. Hệ thống sẽ thử lại ở lần kiểm tra tới.",
    timeout: "Hết thời gian chờ GitHub. Hệ thống sẽ thử lại ở lần kiểm tra tới.",
    network: "Không kết nối được tới GitHub. Kiểm tra mạng của máy chủ.",
    badResponse: "GitHub trả về dữ liệu không đọc được.",
  },
} as const
