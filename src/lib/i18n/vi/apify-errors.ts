// Chuỗi tiếng Việt phía server của tích hợp Apify (16-apify.md): lỗi API Apify (src/server/apify/errors.ts), lỗi
// service token (src/server/services/apify-tokens.ts) và trạng thái do job apify.health ghi. Không chứa token / URL.
// Chuỗi giao diện (tab Apify, form, chi tiết) nằm ở ./apify.ts.
export const apifyErrors = {
  /** ApifyError: `message` + `hint` (cách sửa) */
  api: {
    invalid_token: {
      message:
        "Apify từ chối token (sai, đã bị xoá, hết hạn hoặc tài khoản bị khoá).",
      hint: "Tạo token mới trong Apify Console → Settings → API & Integrations rồi bấm Thay token.",
    },
    token_missing: {
      message: "Yêu cầu tới Apify thiếu token (lỗi hệ thống).",
      hint: "Báo quản trị viên kiểm tra lại phiên bản ứng dụng.",
    },
    out_of_credit: {
      message:
        "Tài khoản Apify đã hết credit hoặc chạm giới hạn chi tiêu tháng.",
      hint: "Chờ chu kỳ credit mới, nâng gói hoặc tăng giới hạn chi tiêu trong Apify Console (Billing → Limits).",
    },
    paid_plan_required: {
      message: "Actor này cần tài khoản Apify có gói trả phí.",
      hint: "Dùng token của tài khoản Apify có gói trả phí hoặc chọn Actor khác.",
    },
    account_busy: {
      message:
        "Tài khoản Apify đang chạy quá nhiều Actor cùng lúc hoặc không còn đủ RAM cho lần chạy mới.",
      hint: "Đợi các lần chạy khác xong rồi thử lại, hoặc nâng gói Apify.",
    },
    insufficient_permissions: {
      message:
        "Token Apify không đủ quyền cho thao tác này (token bị giới hạn quyền).",
      hint: "Dùng token không giới hạn quyền, hoặc cấp quyền chạy Actor và đọc storage mặc định của run trong Apify Console.",
    },
    actor_not_allowed: {
      message:
        "Actor này không chạy được qua API (cần quyền đầy đủ, đã bị khoá hoặc ngừng hoạt động).",
      hint: "Chọn Actor khác.",
    },
    input_invalid: {
      message: "Apify từ chối dữ liệu đầu vào (input) của Actor.",
      hint: "Sửa input theo schema của Actor rồi thử lại.",
    },
    charge_limit_invalid: {
      message:
        "Trần chi phí mỗi lần chạy thấp hơn mức tối thiểu Actor yêu cầu.",
      hint: "Tăng trần mỗi lần chạy (nếu được phép) hoặc chọn Actor khác.",
    },
    bad_request: {
      message: "Apify từ chối yêu cầu.",
      hint: null,
    },
    not_found: {
      message:
        "Không tìm thấy trên Apify (Actor, lần chạy hoặc dữ liệu đã bị xoá / hết hạn lưu trữ).",
      hint: "Kiểm tra lại mã; dữ liệu của lần chạy chỉ được Apify giữ khoảng 7 ngày.",
    },
    forbidden: {
      message: "Apify không cho phép thao tác này.",
      hint: null,
    },
    rate_limited: {
      message: "Apify đang giới hạn tốc độ gọi API.",
      hint: "Thử lại sau ít giây.",
    },
    upstream: {
      message: "Apify đang gặp sự cố.",
      hint: "Thử lại sau ít phút.",
    },
    timeout: {
      message: "Apify không phản hồi kịp.",
      hint: "Thử lại sau ít phút.",
    },
    network: {
      message: "Không kết nối được tới Apify.",
      hint: "Kiểm tra mạng của máy chủ rồi thử lại.",
    },
    aborted: {
      message: "Yêu cầu tới Apify đã bị huỷ.",
      hint: null,
    },
    invalid_response: {
      message: "Apify trả về dữ liệu không đọc được.",
      hint: "Thử lại sau ít phút.",
    },
    response_too_large: {
      message: "Dữ liệu Apify trả về quá lớn.",
      hint: "Giảm số dòng (limit) hoặc chọn ít trường hơn (fields).",
    },
    config: {
      message:
        "Biến môi trường APIFY_API_BASE_URL không hợp lệ (chỉ nhận https://).",
      hint: "Sửa biến môi trường rồi khởi động lại.",
    },
    no_token: {
      message: "Không còn token Apify nào dùng được (hết credit / lỗi).",
      hint: "Vào Kết nối → Apify để kiểm tra lại, thay token hoặc thêm token của một tài khoản Apify khác.",
    },
    daily_budget_exceeded: {
      message: "MCP đã chạm trần chi phí Apify trong ngày (giờ Việt Nam).",
      hint: "Chờ sang ngày mới (giờ Việt Nam) hoặc giảm max_charge_usd; chủ MCP có thể nâng trần Apify mỗi ngày trong MCP → Cấu hình → Bảo vệ.",
    },
    start_uncertain: {
      message:
        "Không chắc lần chạy Actor đã bắt đầu hay chưa (Apify không phản hồi kịp). Hệ thống không tự chạy lại để tránh tính tiền 2 lần.",
      hint: "Đợi 1–2 phút rồi thử lại.",
    },
  },

  /** chi tiết lỗi trần ngày: đã dùng (gồm lần chạy chưa xong tính theo trần), trần lần này, trần ngày - USD */
  dailyBudgetDetail: (spentUsd: string, runCapUsd: string, dailyMaxUsd: string) =>
    `MCP đã dùng khoảng ${spentUsd} USD hôm nay (lần chạy chưa xong tính theo trần); lần chạy này cần tới ${runCapUsd} USD, vượt trần ${dailyMaxUsd} USD/ngày.`,

  /** trạng thái token do kiểm tra (job apify.health / Kiểm tra lại / xoay vòng) ghi vào status_message */
  status: {
    actorsDisabled:
      "Tài khoản Apify đang bị tắt quyền chạy Actor. Kiểm tra gói / thanh toán trong Apify Console.",
    outOfCredit: "Tài khoản Apify đã hết credit tháng này.",
  },

  /** ApifyServiceError (service token) */
  service: {
    notFound: "Không tìm thấy token Apify.",
    readOnly: "Chỉ quản trị viên được thay đổi token dùng chung công ty.",
    scopeAdminOnly: "Chỉ quản trị viên được thêm token dùng chung công ty.",
    confirmName: "Gõ đúng tên token để xác nhận xoá.",
    credentialsUnreadable:
      "Không giải mã được token đã lưu (khoá mã hoá thay đổi?). Hãy bấm Thay token.",
    unavailable: "Không kết nối được tới Apify. Thử lại sau ít phút.",
    otherMcp: "MCP của người khác",
    generic: "Không thực hiện được thao tác. Thử lại sau ít phút.",
    otherAccount:
      "Token mới thuộc tài khoản Apify khác - hãy thêm token mới thay vì thay token này (các lần chạy cũ gắn với tài khoản cũ).",
    conflict: "Token vừa được thay đổi ở nơi khác (tắt, thay hoặc xoá). Tải lại trang rồi thử lại.",
    tooManyChecks: (sec: number) => `Bạn kiểm tra token Apify quá nhanh. Thử lại sau ${sec} giây.`,
  },
} as const
