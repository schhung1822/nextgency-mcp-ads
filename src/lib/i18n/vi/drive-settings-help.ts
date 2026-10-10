// Chuỗi tiếng Việt - khung "Hướng dẫn cấu hình" trong thẻ Cài đặt → Google Drive hệ thống
// (src/app/(dashboard)/settings/_components/drive-settings-help.tsx).
// Đã đối chiếu với code: src/server/services/drive-credentials.ts (lưu: đăng nhập Google + đọc thử Drive; API key chỉ
// kiểm tra định dạng), src/lib/schemas/drive.ts (GOOGLE_API_KEY_RE: "AIza" + 35 ký tự = 39), src/server/drive/**
// (link công khai: cần API key hệ thống + công tắc của từng MCP) và docs/huong-dan-google-drive.md.
// Cú pháp nhỏ trong chuỗi: **đậm**, `mã` (hiển thị bằng <strong> / <code>, không phải HTML).

export interface DriveHelpStep {
  text: string
  links?: readonly { label: string; url: string }[]
}

export const driveSettingsHelp = {
  title: "Hướng dẫn cấu hình",
  newTab: "(mở trong thẻ mới)",
  /** ô gạch đứt trong thẻ khi chưa cấu hình (bước "Google Drive hệ thống" đã rời khỏi khung Hướng dẫn của trang) */
  notConfiguredHint:
    "Nhân viên chưa có email để chia sẻ thư mục. Làm theo phần Hướng dẫn cấu hình trong thẻ này rồi dán khoá JSON vào đây.",
  required: "Bắt buộc",
  optional: "Không bắt buộc",

  purpose: {
    title: "Google Drive hệ thống dùng để làm gì?",
    points: [
      "AI **lấy ảnh, video trong thư mục Drive** và **đọc / ghi Google Sheet** kế hoạch để lên quảng cáo - không phải tải file lên máy chủ.",
      "Dùng **một email hệ thống** (service account) **chung cho cả công ty**. Mọi người chia sẻ thư mục / sheet cho email này, giống chia sẻ cho một đồng nghiệp.",
      'Không có nút đăng nhập Google: khoá JSON của service account chính là "mật khẩu" của email hệ thống.',
    ],
  },

  json: {
    title: "Lấy file khoá JSON của service account",
    steps: [
      {
        text: "Tạo hoặc chọn **project Google Cloud** (dùng chung project với Google Ads được).",
        links: [
          {
            label: "Tạo project",
            url: "https://console.cloud.google.com/projectcreate",
          },
        ],
      },
      {
        text: "Bật **cả hai**: **Google Drive API** và **Google Sheets API** (APIs & Services → Library → Enable).",
        links: [
          {
            label: "Bật Google Drive API",
            url: "https://console.cloud.google.com/apis/library/drive.googleapis.com",
          },
          {
            label: "Bật Google Sheets API",
            url: "https://console.cloud.google.com/apis/library/sheets.googleapis.com",
          },
        ],
      },
      {
        text: "**IAM & Admin → Service accounts → Create service account**, đặt tên (vd. `ads-mcp-drive`) → **Create and continue**. Bước gán vai trò: **bỏ qua, không cần role** → **Done**.",
        links: [
          {
            label: "Mở Service accounts",
            url: "https://console.cloud.google.com/iam-admin/serviceaccounts",
          },
        ],
      },
      {
        text: "Bấm vào service account vừa tạo → tab **Keys → Add key → Create new key → JSON → Create**. Trình duyệt tải về một file `.json`.",
      },
      {
        text: "Mở file bằng **Notepad** (Windows) hoặc **TextEdit** (Mac), chép **toàn bộ nội dung** (từ `{` đến `}`) và dán vào ô **Service account JSON** → **Lưu thông tin xác thực**.",
      },
    ] as readonly DriveHelpStep[],
    checkNote:
      "Khi lưu, hệ thống đăng nhập Google bằng khoá và đọc thử Drive. Sai khoá hoặc chưa bật Google Drive API sẽ báo lỗi ngay, không lưu gì.",
    secretNote:
      "File JSON là **bí mật**: ai có nó đọc được mọi thư mục đã chia sẻ cho email hệ thống. Không gửi qua chat / email; xoá file sau khi dán.",
    blockedTitle: 'Google báo "Service account key creation is disabled"?',
    blocked:
      "Tổ chức Google Cloud đang chặn tạo khoá. Nhờ người quản trị Google Cloud tắt chính sách `iam.disableServiceAccountKeyCreation` (hoặc `iam.managed.disableServiceAccountKeyCreation`) cho riêng project này, hoặc dùng một project khác không bị chặn.",
  },

  apiKey: {
    title: "API key (link Drive công khai)",
    what: 'Cho AI đọc link Drive đang chia sẻ **"Bất kỳ ai có đường liên kết"** mà nhân viên dán vào chat - **không cần** chia sẻ cho email hệ thống hay khai báo thư mục.',
    without:
      "**Không có API key:** chỉ dùng được thư mục / sheet đã chia sẻ cho email hệ thống; mọi MCP không dùng được link công khai.",
    withKey:
      "**Có API key:** từng MCP vẫn phải bật **Cho phép dùng link Drive công khai** thì AI mới dùng được link công khai.",
    stepsLabel: "Cách tạo API key",
    steps: [
      {
        text: "**APIs & Services → Credentials → Create credentials → API key**.",
        links: [
          {
            label: "Mở Credentials",
            url: "https://console.cloud.google.com/apis/credentials",
          },
        ],
      },
      {
        text: "Mở key vừa tạo (**Edit API key**) → **API restrictions → Restrict key** → chỉ chọn **Google Drive API** → **Save**.",
      },
      {
        text: "Sao chép key (bắt đầu bằng `AIza`, dài 39 ký tự) và dán vào ô **API key** → **Lưu thông tin xác thực**.",
      },
    ] as readonly DriveHelpStep[],
    checkNote:
      "Khi lưu, API key **chỉ được kiểm tra định dạng**. Key sai hoặc giới hạn nhầm API sẽ báo lỗi ở lần đầu AI dùng một link công khai.",
    security:
      "**Bảo mật:** chỉ cho key dùng **Google Drive API**, không chia sẻ key cho ai. Muốn tắt link công khai: tick **Xoá API key** rồi lưu.",
  },

  after: {
    title: "Sau khi lưu",
    steps: [
      {
        text: "Email hệ thống hiện cho mọi người ở **Kết nối → tab Google Drive** (khối **Email hệ thống**, có nút sao chép).",
      },
      {
        text: "Chia sẻ thư mục ảnh / video cho email đó với quyền **Người xem**. Google Sheet: **Người xem**, hoặc **Người chỉnh sửa** nếu muốn AI ghi lại trạng thái.",
      },
      {
        text: "Khai báo ở **Kết nối → Google Drive → Thêm thư mục / sheet**, rồi chọn thư mục / sheet trong cấu hình MCP.",
      },
    ] as readonly DriveHelpStep[],
  },
}
