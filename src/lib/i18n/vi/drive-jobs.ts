// Tải video lên nền (Google Drive → Meta / TikTok, job "media.video_upload") - thông báo lỗi lưu vào
// media_upload_jobs.error_message (AI xem qua ads_get_media_upload, giao diện có thể hiển thị). Không chứa URL / token.
export const driveJobs = {
  videoUpload: {
    errors: {
      mcp_unavailable:
        "MCP đã bị tắt, hết hạn hoặc bị xoá nên không tải video lên nữa.",
      account_not_in_scope:
        "Tài khoản quảng cáo không còn trong phạm vi của MCP (hoặc MCP không còn quyền tạo mới trên nền tảng này).",
      drive_not_in_scope:
        "Video không còn nằm trong thư mục Google Drive được cấp cho MCP (hoặc MCP đã tắt dùng link Drive công khai).",
      drive_unavailable:
        "Không truy cập được Google Drive bằng thông tin đăng nhập đã dùng (đã bị xoá, tắt hoặc thiếu API key hệ thống).",
      file_changed:
        "File video trên Google Drive đã bị thay đổi, xoá hoặc chuyển vào thùng rác sau khi yêu cầu tải lên.",
      unsupported:
        "Nền tảng này chưa hỗ trợ tải video dung lượng lớn ở chế độ nền.",
      interrupted:
        "Việc tải lên bị gián đoạn do worker khởi động lại. Hãy gọi lại ads_upload_media để tải lại.",
      internal: "Lỗi hệ thống khi tải video lên. Hãy thử lại sau ít phút.",
      stale:
        "Lượt tải bị dừng vì quá lâu không cập nhật tiến độ. Hãy gọi lại ads_upload_media để tải lại.",
      job_already_failed:
        "Video đã lên nền tảng nhưng lượt tải đã bị đánh dấu lỗi trước đó (quá lâu không cập nhật) - media_id ghi trong nhật ký MCP.",
    },
    /** giới hạn số lượt tải nền đang chạy (ads_upload_media trả lỗi rate_limited) */
    limits: {
      perMcp: (n: number) =>
        `MCP này đang có ${n} video tải lên ở chế độ nền - chưa nhận thêm.`,
      perOwner: (n: number) =>
        `Các MCP của chủ sở hữu MCP này đang có ${n} video tải lên ở chế độ nền - chưa nhận thêm.`,
      system:
        "Hệ thống đang có nhiều video chờ tải lên ở chế độ nền - chưa nhận thêm.",
      hint: "Gọi ads_get_media_upload để xem các lượt đang chạy; thử lại khi có lượt đã xong (thường vài phút).",
    },
    /** lượt tải của MCP khác (cùng tài khoản + cùng file) - không lộ thông tin của MCP kia */
    busyElsewhere:
      "Tệp này đang được tải lên tài khoản này, thử lại sau ít phút (khi xong, ads_upload_media sẽ trả lại media_id).",
  },
  /** kiểm tra định kỳ / đăng ký nguồn Drive (an ninh H1) */
  sources: {
    insideOtherPersonal:
      "Thư mục / Sheet này hiện nằm bên trong thư mục cá nhân của người khác đã được đăng ký - MCP của nhân viên khác sẽ không dùng được nguồn này. Chuyển nó ra ngoài thư mục đó (hoặc xoá nguồn) rồi bấm Kiểm tra lại.",
  },
} as const

export type VideoUploadErrorCode = keyof typeof driveJobs.videoUpload.errors
