// Chuỗi tiếng Việt - nhóm "notifications" (kênh thông báo Telegram, .claude/docs/14-telegram-notifications.md).
// Chia theo mục: `server` (thông báo thành công của server action), `errors` (lỗi trả về người dùng),
// `telegram` (lỗi/cảnh báo khi gọi Bot API), `messages` (nội dung tin gửi vào Telegram).
// Agent UI thêm chuỗi giao diện vào các mục riêng (vd `list`, `form`, `detail`) - không trộn vào các mục trên.
export const notifications = {
  server: {
    created: "Đã lưu kết nối Telegram.",
    updated: "Đã lưu thay đổi.",
    deleted: "Đã xoá kết nối Telegram.",
    enabled: "Đã bật kết nối Telegram.",
    disabled: "Đã tắt kết nối Telegram.",
    tokenReplaced: "Đã thay bot token.",
    rechecked: "Đã kiểm tra lại kết nối Telegram.",
    testSent: "Đã gửi tin thử. Mở Telegram để kiểm tra.",
  },

  errors: {
    notFound: "Không tìm thấy kết nối Telegram hoặc bạn không có quyền xem.",
    invalidInput: "Thông tin chưa hợp lệ. Vui lòng kiểm tra lại.",
    generic: "Đã có lỗi xảy ra. Vui lòng thử lại.",
    tooManyChecks: (sec: number) =>
      `Bạn kiểm tra Telegram quá nhanh. Vui lòng thử lại sau ${sec} giây.`,
    nameRequired: "Vui lòng nhập tên kết nối.",
    nameTooLong: "Tên kết nối tối đa 100 ký tự.",
    nameBadChars: "Không dùng ký tự điều khiển hoặc ký tự đảo chiều văn bản.",
    botTokenRequired: "Vui lòng dán bot token.",
    botTokenFormat:
      "Bot token không đúng định dạng (dạng 123456789:ABC…, lấy từ @BotFather).",
    chatIdRequired: "Vui lòng nhập Chat ID.",
    chatIdFormat:
      "Chat ID phải là số (nhóm/kênh bắt đầu bằng -100…) hoặc @tên_công_khai của nhóm/kênh.",
    threadIdFormat:
      "Chủ đề (Thread ID) phải là số nguyên dương (để trống nếu không dùng chủ đề).",
    eventInvalid: "Sự kiện không hợp lệ.",
    adminOnlyEvent:
      "Chỉ quản trị viên mới nhận được thông báo cập nhật hệ thống.",
    adminOnlyAllConnections:
      "Chỉ quản trị viên mới nhận được cảnh báo của mọi kết nối.",
    passwordRequired: "Vui lòng nhập mật khẩu để xác nhận.",
    channelDisabled: "Kết nối Telegram đang tắt. Bật lại trước khi gửi tin.",
    credentialsUnreadable:
      "Không giải mã được bot token đã lưu (khoá mã hoá của máy chủ đã đổi?). Hãy bấm Thay token để dán lại.",
    channelNotUsable:
      "Có kết nối Telegram không tồn tại hoặc bạn không có quyền dùng.",
    tooManyChannels: "Chọn tối đa 20 kết nối Telegram.",
    /** sendChannelMessageNow: same dedupe key, earlier delivery still pending (ChatGPT calling the tool twice with one file) */
    duplicateDelivery:
      "Tin này đang được một lần gọi trước gửi đi (chưa có kết quả) - không gửi thêm lần nữa.",
  },

  /** Lỗi/cảnh báo Bot API - luôn kèm cách sửa. `bot` = "@username" khi đã biết, ngược lại "bot". */
  telegram: {
    unauthorized:
      "Bot token không đúng hoặc đã bị thu hồi. Lấy token mới từ @BotFather rồi bấm Thay token.",
    chatNotFound: (bot: string) =>
      `Không tìm thấy chat. Kiểm tra lại Chat ID và chắc chắn ${bot} đã được thêm vào nhóm/kênh, rồi bấm Kiểm tra lại.`,
    threadNotFound:
      "Không tìm thấy chủ đề theo Thread ID. Kiểm tra lại ô Chủ đề (Thread ID), hoặc để trống để gửi vào chủ đề General.",
    forbidden: (bot: string) =>
      `Bot chưa được thêm vào nhóm hoặc chưa có quyền gửi tin. Thêm ${bot} vào nhóm/kênh, cấp quyền gửi tin rồi bấm Kiểm tra lại.`,
    blockedByUser: (bot: string) =>
      `Người nhận đã chặn ${bot}. Mở chat với bot, bấm Start (hoặc bỏ chặn) rồi bấm Kiểm tra lại.`,
    rateLimited: (sec: number) =>
      `Telegram đang giới hạn tốc độ gửi tin. Thử lại sau ${sec} giây.`,
    unavailable:
      "Không kết nối được tới Telegram. Vui lòng thử lại sau ít phút.",
    timeout:
      "Telegram không phản hồi trong 10 giây. Vui lòng thử lại sau ít phút.",
    badRequest: "Telegram từ chối tin nhắn.",
    parseFailed: "Nội dung tin không hợp lệ với Telegram.",
    invalidResponse:
      "Telegram trả về phản hồi không đọc được. Vui lòng thử lại sau.",
    configInvalid:
      "Cấu hình TELEGRAM_API_BASE_URL không hợp lệ (phải là https://…). Liên hệ quản trị máy chủ.",
    channelNotAdmin: (bot: string) =>
      `${bot} chưa là quản trị viên của kênh hoặc chưa có quyền "Đăng tin". Vào kênh → Quản trị viên → thêm bot, bật quyền đăng tin rồi bấm Kiểm tra lại.`,
    notMember: (bot: string) =>
      `${bot} không còn ở trong nhóm. Thêm lại bot vào nhóm rồi bấm Kiểm tra lại.`,
    restricted: (bot: string) =>
      `${bot} bị hạn chế, không được gửi tin trong nhóm. Bỏ hạn chế cho bot rồi bấm Kiểm tra lại.`,
    threadNeedsForum:
      "Nhóm này không bật Chủ đề (Topics) nên không dùng được Thread ID. Hãy để trống ô Chủ đề (Thread ID).",
    warnPrivate: (bot: string) =>
      `Đây là chat riêng: người nhận phải mở chat với ${bot} và bấm Start trước khi nhận tin.`,
    warnBasicGroup:
      "Đây là nhóm thường: nếu Telegram nâng cấp nhóm thành supergroup, hệ thống sẽ tự cập nhật Chat ID mới.",
    warnMigrated:
      "Nhóm đã được nâng cấp thành supergroup - đã dùng Chat ID mới.",
    warnThreadUnchecked:
      "Telegram không có hàm kiểm tra chủ đề: hãy bấm Gửi tin thử để chắc chắn tin vào đúng chủ đề.",
    /** delivery skipped by the worker */
    skippedDeleted: "Kết nối Telegram đã bị xoá, không gửi.",
    skippedDisabled: "Kết nối Telegram đang tắt, không gửi.",
    skippedError: (reason: string) => `Kết nối Telegram đang lỗi, không gửi: ${reason}`,
    expired: "Quá thời gian chờ gửi (1 giờ), đã bỏ qua.",
    retryUnavailable: "Không xếp lịch gửi lại được.",
    /** media (sendPhoto / sendVideo / sendDocument) */
    fileTooLarge:
      "Telegram từ chối tệp vì quá lớn (tối đa 50 MB, ảnh tối đa 10 MB). Hãy dùng tệp nhỏ hơn.",
    mediaRejected:
      "Telegram không xử lý được tệp này (định dạng hoặc kích thước ảnh không hợp lệ). Thử gửi dạng tệp hoặc dùng tệp khác.",
    uploadTimeout:
      "Telegram không phản hồi kịp khi tải tệp lên - tin có thể đã được gửi, hãy kiểm tra nhóm trước khi gửi lại. Nếu chưa có, thử tệp nhỏ hơn hoặc thử lại sau.",
  },

  /** Nội dung tin Telegram (HTML do format.ts ghép; mọi giá trị động được escape ở đó). */
  messages: {
    appName: "Ads MCP",
    test: {
      title: "Tin thử từ Ads MCP",
      body: (channel: string) =>
        `Kết nối Telegram "${channel}" hoạt động bình thường. Bạn sẽ nhận thông báo ở đây.`,
      by: "Người gửi",
    },
    connection: {
      expiring: "Kết nối quảng cáo sắp hết hạn",
      invalid: "Kết nối quảng cáo bị lỗi",
      recovered: "Kết nối quảng cáo hoạt động lại",
      connection: "Kết nối",
      owner: "Người tạo",
      expiresAt: "Hạn token",
      fixExpiring:
        "Cách xử lý: mở Ads MCP → Kết nối → chọn kết nối → Thay token trước khi hết hạn.",
      fixInvalid:
        "Cách xử lý: mở Ads MCP → Kết nối → chọn kết nối → Kiểm tra lại hoặc Thay token. MCP dùng kết nối này đang không gọi được nền tảng.",
    },
    update: {
      available: "Có bản cập nhật mới",
      version: "Phiên bản mới",
      current: "Đang chạy",
      howTo: "Admin mở Cài đặt → Cập nhật hệ thống để cập nhật.",
      succeeded: "Cập nhật hệ thống thành công",
      failed: "Cập nhật hệ thống thất bại",
      rolledBack: "Cập nhật lỗi, đã quay về bản cũ",
      target: "Phiên bản",
    },
    mcpWrite: {
      mcp: "MCP",
      account: "TKQC",
      tool: "Tool",
      reason: "Lý do",
      more: (n: number) => `… và ${n} thay đổi khác`,
      paused: (what: string) => `AI đã tạm dừng ${what}`,
      activated: (what: string) => `AI đã bật ${what}`,
      budget: (what: string) => `AI đã đổi ngân sách ${what}`,
      created: (what: string) => `AI đã tạo ${what}`,
      copied: (what: string) => `AI đã sao chép ${what}`,
      deleted: (what: string) => `AI đã xoá/lưu trữ ${what}`,
      updated: (what: string) => `AI đã sửa ${what}`,
      objects: (n: number, level: string) => `${n} ${level}`,
      levels: {
        campaign: "chiến dịch",
        ad_group: "nhóm quảng cáo",
        adset: "nhóm quảng cáo",
        ad: "quảng cáo",
        creative: "mẫu quảng cáo",
        object: "đối tượng",
      } as Record<string, string>,
      status: {
        active: "Đang chạy",
        paused: "Tạm dừng",
        archived: "Đã lưu trữ",
        deleted: "Đã xoá",
      } as Record<string, string>,
      empty: "(trống)",
    },
    aiMessage: {
      title: (mcp: string) => `🤖 Tin từ AI · MCP ${mcp}`,
    },
    /** dòng ghi nguồn cuối MỌI tin (§10.1): chỉ "<a>linkLabel</a>" (chữ nghiêng) */
    credit: {
      linkLabel: "Ads MCP Simple",
    },
  },

  /** Tệp đính kèm tin Telegram (ảnh / video / tệp - media.ts). Không bao giờ chứa URL. */
  media: {
    kinds: { photo: "Ảnh", video: "Video", document: "Tệp" },
    /** notification_deliveries.preview: "[Ảnh: a.jpg · 1,2 MB]" */
    previewLabel: (kind: string, name: string, size: string) =>
      `[${kind}: ${name} · ${size}]`,
    /** tên tệp khi không có tên: tep-20261009-1430 */
    fallbackFileStem: "tep",
    errors: {
      telegram_file_fetch_failed: {
        message: "Không tải được tệp từ đường dẫn.",
        hint: "Dùng link công khai tải trực tiếp được tệp (không cần đăng nhập), hoặc đính kèm tệp vào cuộc trò chuyện.",
      },
      telegram_file_too_large: {
        message: "Tệp vượt quá 50 MB - giới hạn gửi tệp của Telegram.",
        hint: "Dùng tệp nhỏ hơn (ảnh ≤ 10 MB, tệp ≤ 50 MB) hoặc gửi link tải trong nội dung tin.",
      },
      telegram_file_type_not_allowed: {
        message: "Loại tệp này không được phép gửi.",
        hint: "Chỉ gửi được ảnh JPG/PNG/WebP/GIF, video MP4/MOV, PDF, Word/Excel/PowerPoint (DOCX/XLSX/PPTX, không có macro) và tệp chữ CSV/TSV/TXT/MD/JSON.",
      },
      telegram_file_timeout: {
        message:
          "Tải tệp quá thời gian chờ - tệp quá lớn hoặc máy chủ nguồn chậm.",
        hint: "Thử tệp nhỏ hơn hoặc link khác.",
      },
      telegram_file_invalid: {
        message: "Tệp rỗng hoặc bị hỏng.",
        hint: "Kiểm tra lại tệp rồi gửi lại.",
      },
      telegram_busy: {
        message: "Máy chủ đang gửi tệp khác, chưa nhận thêm được.",
        hint: "Thử lại sau vài giây.",
      },
      url_not_allowed: {
        message: "Đường dẫn tệp không được phép.",
        hint: "Chỉ dùng link https công khai (không dùng địa chỉ nội bộ).",
      },
    },
    fetchFailedStatus: (status: number) =>
      `Máy chủ chứa tệp trả về lỗi HTTP ${status}.`,
    tooManyRedirects: "Đường dẫn tệp chuyển hướng quá nhiều lần.",
    emptyFile: "Tệp tải về rỗng.",
    httpsOnly: "Đường dẫn tệp phải dùng https://.",
    photoTooLarge: "Ảnh lớn hơn 10 MB nên không gửi dạng ảnh được.",
    notPhoto: "Tệp không phải ảnh nên không gửi dạng ảnh được.",
    notVideo: "Chỉ video MP4 mới gửi dạng video được.",
    sendAsHint: 'Dùng send_as "auto" hoặc "document" để gửi dạng tệp.',
    macro: "Tệp Office có macro (VBA) không được phép gửi.",
    macroHint: "Lưu lại dạng DOCX/XLSX/PPTX không có macro rồi gửi lại.",
    officeEmbedded:
      "Tệp Office chứa đối tượng nhúng (OLE, ActiveX, tệp nhị phân hoặc tệp chạy được) nên không được phép gửi.",
    officeEmbeddedHint:
      "Xoá đối tượng nhúng rồi lưu lại, hoặc xuất ra PDF rồi gửi.",
    /** one media send per MCP at a time */
    busyMcp:
      "MCP này đang gửi một tệp khác vào Telegram - chưa gửi thêm tệp được.",
    busyMcpHint: "Đợi lần gửi trước xong (tối đa khoảng 1 phút) rồi thử lại.",
    /** the upload was cut by the deadline: Telegram may still have posted it */
    uploadUncertain:
      "Quá thời gian chờ khi tải tệp lên Telegram - tệp có thể đã được gửi, kiểm tra nhóm trước khi gửi lại.",
    uploadUncertainHint:
      "Mở nhóm Telegram xem tin đã có chưa; chỉ gửi lại khi chưa có (nên dùng tệp nhỏ hơn).",
    markup: "Tệp HTML/SVG/XML không được phép gửi.",
    textTooLarge: "Nội dung tệp chữ vượt quá 256 KB.",
    textTooLargeHint: "Rút gọn nội dung hoặc chia thành nhiều tệp.",
    textInvalid:
      "Tệp chữ phải là UTF-8 hợp lệ, không rỗng và không chứa ký tự NUL.",
    textExtension: "Tệp chữ phải có đuôi .csv, .tsv, .txt, .md hoặc .json.",
    textExtensionHint: 'Đặt file_name có đuôi phù hợp, vd "bao-cao.csv".',
  },

  // ---------------------------------------------------------------------------
  // Giao diện (/connections tab Telegram, /connections/telegram/new, /connections/telegram/[id])
  // ---------------------------------------------------------------------------

  /** nhãn dùng chung của giao diện */
  ui: {
    crumb: "Telegram",
    typeLabel: "Telegram",
    status: {
      active: "Hoạt động",
      error: "Lỗi",
      disabled: "Đã tắt",
    } as Record<string, string>,
    deliveryStatus: {
      pending: "Đang chờ",
      sent: "Đã gửi",
      failed: "Thất bại",
    } as Record<string, string>,
    sources: {
      system: "Hệ thống",
      mcp_tool: "AI gửi tin",
      mcp_write: "AI thay đổi QC",
      test: "Tin thử",
    } as Record<string, string>,
    eventTypes: {
      connection_expiring: "Kết nối sắp hết hạn",
      connection_invalid: "Kết nối lỗi",
      connection_recovered: "Kết nối hoạt động lại",
      update_available: "Có bản cập nhật",
      update_succeeded: "Cập nhật thành công",
      update_failed: "Cập nhật thất bại",
      mcp_write: "Thay đổi quảng cáo",
      mcp_message: "Tin từ AI",
      test: "Tin thử",
    } as Record<string, string>,
    /** sự kiện hệ thống chọn được cho một kênh */
    events: {
      connection_health: {
        label: "Sức khoẻ kết nối quảng cáo",
        help: "Báo khi kết nối sắp hết hạn, bị lỗi hoặc hoạt động lại.",
        short: "Cảnh báo kết nối",
      },
      system_update: {
        label: "Cập nhật hệ thống",
        help: "Báo khi có phiên bản mới và kết quả cập nhật. Chỉ quản trị viên.",
        short: "Cập nhật hệ thống",
      },
    },
    allConnectionsShort: "Mọi kết nối",
    chatTypes: {
      private: "Chat riêng",
      group: "Nhóm",
      supergroup: "Siêu nhóm",
      channel: "Kênh",
    } as Record<string, string>,
    adminOnly: "Chỉ quản trị viên",
    noThread: "Không dùng chủ đề",
    tokenHint: (hint: string) => `••••${hint.replace(/^…/, "")}`,
  },

  list: {
    tab: "Telegram",
    tableLabel: "Danh sách kết nối Telegram",
    searchPlaceholder: "Tìm theo tên hoặc chat…",
    searchLabel: "Tìm kết nối Telegram",
    colName: "Tên",
    colOwner: "Người tạo",
    colChat: "Chat",
    colThread: "Chủ đề",
    colEvents: "Sự kiện",
    colStatus: "Trạng thái",
    colLastSent: "Gửi lần cuối",
    neverSent: "Chưa gửi",
    noEvents: "Chỉ tin từ MCP",
    mcpCount: (n: number) => `${n} MCP`,
    emptyTitle: "Chưa có kết nối Telegram",
    emptyDescription:
      "Thêm bot Telegram để nhận cảnh báo kết nối, thay đổi do AI thực hiện và tin nhắn từ AI ngay trong nhóm của bạn.",
    emptyFilteredTitle: "Không có kết nối Telegram phù hợp",
    emptyFilteredDescription: "Thử đổi từ khoá tìm kiếm hoặc bỏ bớt bộ lọc.",
    filterStatus: "Trạng thái",
    /** "+2" chip: the remaining subscribed events, listed in its tooltip */
    moreEvents: (n: number) => `+${n}`,
    add: "Thêm kết nối Telegram",
  },

  form: {
    metaTitle: "Thêm kết nối Telegram",
    title: "Thêm kết nối Telegram",
    description:
      "Dán bot token từ @BotFather và Chat ID của nơi nhận thông báo, kiểm tra rồi lưu.",
    cardTitle: "Thông tin bot và chat",
    cardDescription:
      "Bot token được mã hoá trước khi lưu và không bao giờ hiển thị lại.",
    nameLabel: "Tên kết nối",
    namePlaceholder: "Ví dụ: Nhóm Marketing, Cảnh báo QC",
    nameHelp: "Tên gợi nhớ, hiện trong danh sách kết nối và khi chọn kết nối Telegram cho MCP.",
    botTokenLabel: "Bot token",
    botTokenPlaceholder: "123456789:AA…",
    botTokenHelp: "BotFather gửi token này sau lệnh /newbot.",
    chatIdLabel: "Chat ID",
    chatIdPlaceholder: "-1001234567890 hoặc @ten_kenh",
    chatIdHelp:
      "Nhóm/kênh: số bắt đầu bằng -100…; kênh hoặc nhóm công khai có thể dùng @tên. Cách lấy: xem panel Hướng dẫn.",
    threadLabel: "Chủ đề (Thread ID)",
    threadPlaceholder: "Ví dụ: 42",
    threadHelp:
      "Chỉ cho nhóm bật Chủ đề (Topics): tin sẽ vào đúng chủ đề này. Để trống để gửi vào chủ đề General.",
    optional: "(tuỳ chọn)",
    eventsLabel: "Sự kiện hệ thống",
    eventsHelp:
      "Thông báo thay đổi do AI thực hiện và tin nhắn từ AI được bật riêng trong từng MCP (bước Nền tảng).",
    allConnectionsLabel: "Nhận cảnh báo của mọi kết nối",
    allConnectionsHelp:
      "Mặc định chỉ nhận cảnh báo cho kết nối của chính bạn. Bật để nhận cả cảnh báo kết nối của nhân viên.",
    check: "Kiểm tra",
    checking: "Đang kiểm tra…",
    save: "Kiểm tra & lưu",
    saving: "Đang lưu…",
    back: "Chọn nền tảng",
  },

  check: {
    okTitle: "Bot và chat hợp lệ",
    failTitle: "Chưa kiểm tra được",
    bot: "Bot",
    chat: "Chat",
    type: "Loại",
    thread: "Chủ đề (Thread ID)",
    forum: "Nhóm bật Chủ đề",
    outdated:
      "Bạn đã sửa bot token, Chat ID hoặc Thread ID sau lần kiểm tra - bấm Kiểm tra lần nữa.",
    warnings: "Lưu ý",
    /** screen-reader announcement after "Kiểm tra" */
    announceOk: (chat: string) => `Bot và chat hợp lệ: ${chat}.`,
  },

  detail: {
    metaTitle: "Kết nối Telegram",
    createdTitle: "Đã lưu kết nối Telegram",
    createdHint:
      "Bấm Gửi tin thử để chắc chắn bot gửi được tin vào đúng nhóm/chủ đề.",
    sendTest: "Gửi tin thử",
    /** header action while the settings form has unsaved changes (the save bar is the one brand button) */
    saveFirstTest: "Lưu thay đổi trước khi gửi tin thử",
    saveFirstEnable: "Lưu thay đổi trước khi bật kết nối",
    sending: "Đang gửi…",
    testFailed: "Gửi tin thử không thành công",
    recheck: "Kiểm tra lại",
    recheckFailed: "Kiểm tra chưa thành công",
    replaceToken: "Thay token",
    enable: "Bật kết nối",
    disable: "Tắt kết nối",
    delete: "Xoá kết nối",
    statusAlert: {
      error: "Kết nối Telegram đang lỗi",
      disabled: "Kết nối Telegram đã tắt",
    } as Record<string, string>,
    disabledHint:
      "Kết nối đang tắt nên không gửi thông báo nào (kể cả từ MCP). Bấm Bật kết nối khi cần.",
    infoTitle: "Bot & chat",
    bot: "Bot",
    botId: "Bot ID",
    chat: "Chat",
    chatId: "Chat ID",
    chatType: "Loại chat",
    thread: "Chủ đề (Thread ID)",
    token: "Token đang lưu",
    owner: "Người tạo",
    lastSent: "Gửi lần cuối",
    lastError: "Lỗi lần cuối",
    createdAt: "Ngày tạo",
    never: "Chưa có",
    editTitle: "Cài đặt",
    editDescription:
      "Đổi Chat ID hoặc Thread ID sẽ được kiểm tra lại với Telegram khi lưu.",
    saved: "Đã lưu thay đổi.",
    usedByTitle: "MCP đang dùng kết nối này",
    usedByNone:
      "Chưa có MCP nào gửi thông báo qua kết nối này. Chọn kết nối Telegram ở bước Nền tảng khi tạo hoặc sửa MCP.",
    usedByOther: (n: number) => `${n} MCP của người khác`,
    deliveriesTitle: "Lần gửi gần đây",
    deliveriesDescription: "50 tin gần nhất, mới nhất ở trên.",
    deliveriesTable: "Lịch sử gửi tin Telegram",
    colTime: "Thời gian",
    colSource: "Nguồn",
    colEvent: "Sự kiện",
    colStatus: "Trạng thái",
    colDetail: "Nội dung / lỗi",
    colMcp: "MCP",
    attempts: (n: number) => `${n} lần thử`,
    noDeliveries: "Chưa gửi tin nào. Bấm Gửi tin thử để bắt đầu.",
    refresh: "Tải lại",
  },

  replace: {
    title: "Thay bot token",
    description:
      "Dán bot token mới (ví dụ sau khi thu hồi token cũ bằng /revoke ở @BotFather). Token mới được kiểm tra trước khi thay.",
    currentHint: (hint: string) => `Token đang lưu: ••••${hint.replace(/^…/, "")}`,
    tokenLabel: "Bot token mới",
    submit: "Kiểm tra & thay token",
  },

  remove: {
    title: "Xoá kết nối Telegram?",
    description: (name: string) =>
      `Kết nối "${name}" và bot token đã lưu sẽ bị xoá. Các MCP đang dùng kết nối này sẽ không gửi thông báo vào đây nữa.`,
    affected: "MCP bị ảnh hưởng",
    confirm: "Xoá kết nối",
  },
} as const
