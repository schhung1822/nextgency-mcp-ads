// Chuỗi giao diện tiếng Việt - xác minh lại danh tính (mật khẩu + mã 2FA) trước thao tác nhạy cảm.
export const reauth = {
  passwordLabel: "Mật khẩu của bạn",
  passwordRequired: "Nhập mật khẩu.",
  codeLabel: "Mã xác thực 6 số",
  codeHelp: "Mở ứng dụng Authenticator (Google Authenticator, Authy…) để lấy mã.",
  codeInvalid: "Mã xác thực gồm 6 chữ số.",
  hint: "Thao tác nhạy cảm - nhập lại mật khẩu (và mã 2FA nếu đã bật) để xác nhận. Lần thử sai được ghi nhật ký.",
  submitting: "Đang xác minh…",
  errors: {
    failed: "Mật khẩu hoặc mã xác thực không đúng.",
    codeRequired: "Nhập mã xác thực 6 số từ ứng dụng Authenticator.",
    locked: "Bạn đã nhập sai quá nhiều lần. Vui lòng thử lại sau 15 phút.",
    required: "Thao tác nhạy cảm - nhập lại mật khẩu (và mã 2FA) của bạn để xác nhận.",
  },
} as const
