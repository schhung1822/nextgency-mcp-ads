// Chuỗi tiếng Việt cho trạng thái sức khoẻ của kết nối: `statusMessage` (chuyện gì đã xảy ra) và
// `statusHint` (việc cần làm tiếp theo) luôn tách riêng để giao diện hiển thị 2 dòng rõ ràng.
export const connectionStatus = {
  /** statusMessage - only what happened, no instruction */
  message: {
    invalid: "Token không hợp lệ hoặc đã bị thu hồi.",
    expired: (date: string) => `Token đã hết hạn từ ${date}.`,
    expiring: (days: number, date: string) => `Token sẽ hết hạn sau ${days} ngày (${date}).`,
    checkFailed: (msg: string) => `Không kiểm tra được: ${msg}`,
    credentialsUnreadable: "Không giải mã được token đã lưu.",
  },
  /** statusHint - the concrete next step, per platform */
  hint: {
    /** token rejected / expired → create a new credential and replace it */
    invalid: {
      meta: 'Tạo token mới trong Graph API Explorer (cùng app), rồi bấm "Thay token" ở trang kết nối.',
      openai_ads: 'Tạo API key mới trong OpenAI Ads, rồi bấm "Thay token" ở trang kết nối.',
    },
    /** token still works but is about to expire */
    expiring: {
      meta: 'Tạo token mới trong Graph API Explorer trước khi hết hạn, rồi bấm "Thay token" ở trang kết nối.',
      openai_ads: 'Tạo API key mới trước khi hết hạn, rồi bấm "Thay token" ở trang kết nối.',
    },
    /** stored ciphertext cannot be decrypted by this process */
    credentialsUnreadable: 'Quản trị viên cần kiểm tra cấu hình ENCRYPTION_KEYS của máy chủ, hoặc dán lại token bằng "Thay token".',
    /** wizard: nothing saved yet */
    pasteAgain: "Hãy tạo token mới rồi dán lại.",
    /** last check failed for a transient reason (rate limit, 5xx, timeout) - nothing is wrong with the token */
    retry: 'Thử lại bằng nút "Kiểm tra lại" sau ít phút; nếu vẫn lỗi, kiểm tra trạng thái của nền tảng.',
  },
} as const
