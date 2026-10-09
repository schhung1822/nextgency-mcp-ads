// Google Drive / Google Sheet (nguồn creative) - chuỗi tiếng Việt. .claude/docs/15-google-drive-media.md
// `errors`: dùng chung cho server (DriveError) - mỗi mục { message, hint }. Các phần UI thêm ở dưới.
export const drive = {
  errors: {
    invalid_link: {
      message: "Link Google Drive / Google Sheet không hợp lệ.",
      hint: "Dán link dạng drive.google.com/file/d/…, drive.google.com/drive/folders/… hoặc docs.google.com/spreadsheets/d/….",
    },
    not_found: {
      message: "Không tìm thấy file hoặc thư mục trên Google Drive.",
      hint: "File có thể đã bị xoá, hoặc chưa được chia sẻ cho email hệ thống.",
    },
    not_public: {
      message: 'File chưa được chia sẻ công khai "Bất kỳ ai có link".',
      hint: "Nếu công ty chỉ chia sẻ trong tên miền (vd. @congty.vn), hãy thêm email hệ thống vào thư mục rồi khai báo thư mục đó ở Kết nối → Google Drive.",
    },
    not_in_scope: {
      message: "Không tìm thấy file trong các thư mục được cấp cho MCP này.",
      hint: "Gọi drive_list_sources để xem các thư mục / sheet được cấp, hoặc dùng link Drive công khai nếu MCP cho phép.",
    },
    permission_denied: {
      message: "Email hệ thống chưa có quyền truy cập file / thư mục này.",
      hint: "Mở Google Drive → Chia sẻ → thêm email hệ thống (quyền Người xem; sheet cần Người chỉnh sửa nếu muốn ghi trạng thái).",
    },
    not_downloadable: {
      message:
        "File này không phải ảnh hoặc video tải được (vd. Google Docs, Sheets, Slides).",
      hint: "Chỉ dùng được file ảnh JPG/PNG/GIF/WebP hoặc video MP4/MOV.",
    },
    abusive_file: {
      message:
        "Google đánh dấu file này có thể độc hại - chỉ chủ file mới tải được.",
      hint: "Tải lại file gốc lên Drive hoặc kiểm tra file với bộ phận media.",
    },
    unsupported_type: {
      message: "Loại file không được hỗ trợ.",
      hint: "Ảnh: JPG, PNG, GIF, WebP. Video: MP4, MOV.",
    },
    too_large: {
      message: "File vượt dung lượng nền tảng cho phép.",
      hint: null,
    },
    claimed: {
      message: "Thư mục / sheet này đã được người khác khai báo.",
      hint: "Liên hệ quản trị viên nếu bạn cần dùng chung.",
    },
    inside_other_source: {
      message: "Thư mục này nằm trong thư mục riêng của người khác.",
      hint: "Liên hệ quản trị viên nếu bạn cần dùng chung.",
    },
    rate_limited: {
      message: "Google Drive đang giới hạn số lượt gọi.",
      hint: "Thử lại sau ít phút.",
    },
    sheet_busy: {
      message:
        "Google Sheet đang bận (đã chạm giới hạn số lượt đọc / ghi mỗi phút).",
      hint: "Thử lại sau ít phút, hoặc xử lý ít dòng hơn mỗi lần.",
    },
    auth_failed: {
      message: "Service account Google không hợp lệ hoặc khoá đã bị thu hồi.",
      hint: "Tạo khoá JSON mới cho service account rồi dán lại.",
    },
    api_disabled: {
      message:
        "Project Google Cloud chưa bật Google Drive API hoặc Google Sheets API.",
      hint: 'Vào Google Cloud Console → APIs & Services → bật "Google Drive API" và "Google Sheets API".',
    },
    api_key_invalid: {
      message:
        "API key Google không hợp lệ hoặc không được phép gọi Google Drive API.",
      hint: "Kiểm tra API key trong Google Cloud (giới hạn API: Google Drive API) rồi lưu lại ở Cài đặt → Google Drive.",
    },
    not_configured: {
      message: "Chưa cấu hình Google Drive cho hệ thống.",
      hint: "Quản trị viên vào Cài đặt → Google Drive để dán service account và API key.",
    },
    public_links_disabled: {
      message: "MCP này không cho phép dùng link Google Drive công khai.",
      hint: 'Bật "Cho phép dùng link Drive công khai" trong cấu hình MCP, hoặc dùng file trong thư mục được cấp.',
    },
    invalid_sheet: {
      message: "Sheet thiếu cột bắt buộc hoặc dòng tiêu đề không đúng.",
      hint: "Kiểm tra dòng tiêu đề và ánh xạ cột ở Kết nối → Google Drive.",
    },
    writeback_disabled: {
      message: "Sheet này không bật ghi trạng thái.",
      hint: 'Bật "Ghi trạng thái vào sheet" ở Kết nối → Google Drive (email hệ thống cần quyền Người chỉnh sửa) và trong cấu hình MCP.',
    },
    row_moved: {
      message:
        "Dòng trong sheet đã thay đổi (bị chèn, xoá hoặc sắp xếp lại) - đã bỏ qua để tránh ghi nhầm.",
      hint: "Đọc lại sheet bằng drive_sheet_read rồi ghi lại.",
    },
    timeout: {
      message: "Google Drive phản hồi quá lâu.",
      hint: "Thử lại sau ít phút.",
    },
    upstream_error: {
      message: "Google Drive / Google Sheets đang gặp lỗi.",
      hint: "Thử lại sau ít phút.",
    },
    range_not_satisfiable: {
      message: "Đoạn dữ liệu yêu cầu nằm ngoài kích thước file.",
      hint: null,
    },
    sheet_tab_not_found: {
      message:
        "Không tìm thấy trang tính (tab) đã khai báo trong Google Sheet.",
      hint: "Tab có thể đã bị xoá - khai báo lại sheet bằng link của đúng tab (có #gid=…).",
    },
  },
  serviceAccount: {
    notJson:
      "Nội dung không phải JSON hợp lệ. Hãy dán toàn bộ nội dung file .json tải từ Google Cloud.",
    notServiceAccount:
      'File JSON không phải khoá service account (trường "type" phải là "service_account").',
    missingEmail: "File JSON thiếu client_email của service account.",
    missingKey: "File JSON thiếu private_key của service account.",
    badKey:
      "private_key trong file JSON không đọc được. Tạo khoá JSON mới cho service account rồi dán lại.",
  },
} as const
