// Chuỗi tiếng Việt - nhóm "guides": nội dung panel "Hướng dẫn" bên phải (máy tính) / icon mở sheet (di động).
// Mỗi mục là một GuideDef (src/lib/guide-types.ts). Viết ngắn, có số bước, cảnh báo riêng; thuật ngữ theo
// .claude/docs/06-ui-design-system.md §8. Thêm hướng dẫn cho trang mới: thêm một mục ở đây rồi render
// <PageGuide guide={t.guides.xxx} /> trong trang.
import type { GuideDef } from "../../guide-types"

export const guides = {
  ui: {
    panelLabel: "Hướng dẫn",
    open: "Mở hướng dẫn",
    collapse: "Thu gọn",
    expandTab: "Hướng dẫn",
    close: "Đóng hướng dẫn",
    newTab: "(mở tab mới)",
    stepsLabel: "Các bước",
    tips: "Mẹo",
    warnings: "Lưu ý",
    scopes: "Quyền cần có",
    links: "Liên kết hữu ích",
    sheetDescription: "Gợi ý ngắn cho trang bạn đang xem.",
  },

  overview: {
    title: "Cách đọc Tổng quan",
    summary:
      "Trang này cho bạn bức tranh nhanh: AI đang dùng MCP đến đâu và có gì cần xử lý.",
    steps: [
      {
        title: "Xem 4 ô số liệu",
        detail:
          "Lượt gọi MCP, tỉ lệ lỗi, kết nối và MCP đang hoạt động. Mũi tên và % so với kỳ trước đó cùng độ dài.",
      },
      {
        title: "Đọc khu Cảnh báo",
        detail:
          "Token sắp hết hạn, kết nối lỗi, MCP gặp nhiều lỗi… Bấm vào một dòng để đi thẳng tới nơi cần sửa.",
      },
      {
        title: "Xem biểu đồ lượt gọi",
        detail:
          "Mỗi cột là một ngày (giờ Việt Nam). Cột lỗi tăng đột ngột nghĩa là nên mở Nhật ký MCP để xem nguyên nhân.",
      },
    ],
    tips: [
      "Nhân viên chỉ thấy số liệu của kết nối và MCP do chính mình tạo.",
      "Chưa có gì? Bắt đầu bằng Kết nối quảng cáo → Thêm kết nối, rồi Tạo MCP.",
    ],
  },

  connections: {
    title: "Về kết nối quảng cáo",
    summary:
      "Kết nối là một token bạn dán từ app developer của nền tảng. Ứng dụng dùng token này để đọc và sửa quảng cáo thay bạn.",
    steps: [
      {
        title: "Thêm kết nối",
        detail:
          "Chọn nền tảng, dán token, kiểm tra rồi chọn tài khoản quảng cáo được dùng.",
      },
      {
        title: "Theo dõi trạng thái",
        detail:
          "Hoạt động: dùng bình thường.\nSắp hết hạn: còn ít ngày, nên thay token sớm.\nLỗi / Hết hạn: AI không dùng được cho tới khi bạn thay token.",
      },
      {
        title: "Mở một kết nối để quản lý",
        detail:
          "Kiểm tra lại, đồng bộ tài khoản, bật/tắt từng TKQC, thay token hoặc xoá.",
      },
    ],
    tips: [
      "Mỗi nền tảng có thể có nhiều kết nối (ví dụ nhiều Business Manager).",
      "Cột Hạn token giúp bạn thấy token nào sắp hết hạn để thay trước.",
    ],
    warnings: [
      "Token có toàn quyền chi tiền. Ứng dụng mã hoá token và không bao giờ hiển thị lại, hãy giữ kín token gốc.",
    ],
  },

  connectionNew: {
    platform: {
      title: "Bước 1 · Chọn nền tảng",
      summary: "Chọn nền tảng quảng cáo bạn muốn kết nối.",
      steps: [
        {
          title: "Bấm vào một nền tảng",
          detail:
            "Meta hoặc OpenAI Ads. Hướng dẫn lấy token đúng nền tảng sẽ hiện ở bước tiếp theo.",
        },
        {
          title: "Chuẩn bị app developer",
          detail:
            "Bạn cần một app/tài khoản developer của nền tảng đó và quyền truy cập vào tài khoản quảng cáo cần dùng.",
        },
      ],
      tips: [
        "Muốn kết nối nhiều nền tảng? Thêm lần lượt từng kết nối, mỗi lần một nền tảng.",
      ],
    },
    verify: {
      title: "Bước 3 · Kiểm tra & chọn tài khoản",
      summary:
        "Ứng dụng kiểm tra token rồi liệt kê các tài khoản quảng cáo (TKQC) tìm thấy.",
      steps: [
        {
          title: "Đọc kết quả kiểm tra",
          detail:
            "Token hợp lệ sẽ hiện hạn sử dụng và danh sách quyền. Nếu lỗi, làm theo gợi ý rồi bấm Kiểm tra lại hoặc Sửa thông tin.",
        },
        {
          title: "Bật tài khoản được dùng trong MCP",
          detail:
            "TKQC đã đóng, bị vô hiệu hoá, chờ duyệt và tài khoản quản lý (MCC) mặc định tắt. Chỉ bật những tài khoản bạn thật sự cần.",
        },
        {
          title: "Bấm Lưu kết nối",
          detail:
            "Token được mã hoá trước khi lưu. Bạn có thể bật/tắt TKQC lại bất cứ lúc nào trong trang chi tiết.",
        },
      ],
      tips: [
        "Nút Mặc định đặt lại việc bật/tắt như ứng dụng gợi ý ban đầu.",
        "Chưa thấy tài khoản nào? Kiểm tra quyền đã cấp cho token ở bước trước.",
      ],
    },
  },

  connectionDetail: {
    title: "Quản lý một kết nối",
    summary: "Xem sức khoẻ của token và chọn tài khoản quảng cáo được dùng.",
    steps: [
      {
        title: "Kiểm tra lại",
        detail:
          "Gọi lại nền tảng để xác nhận token còn dùng được và cập nhật trạng thái, hạn token.",
      },
      {
        title: "Đồng bộ tài khoản",
        detail:
          "Lấy lại danh sách TKQC (tài khoản mới thêm, đổi tên, đóng). Tài khoản mới mặc định theo quy tắc an toàn.",
      },
      {
        title: "Bật/tắt từng TKQC",
        detail:
          "Chỉ tài khoản đang bật mới dùng được trong MCP. Tắt một tài khoản là AI mất quyền với tài khoản đó ngay.",
      },
      {
        title: "Thay token",
        detail:
          "Dán token mới khi token cũ hết hạn hoặc bị thu hồi. Kết nối, MCP và nhật ký được giữ nguyên.",
      },
    ],
    warnings: [
      "Xoá kết nối sẽ làm các MCP đang dùng nó mất tài khoản tương ứng và không thể hoàn tác. Nhật ký cũ vẫn được giữ theo thời gian lưu trữ.",
    ],
  },

  mcpList: {
    title: "Về MCP",
    summary:
      "MCP là một đường link bạn dán vào Claude, ChatGPT hoặc Gemini để AI xem và điều khiển quảng cáo theo quyền bạn chọn.",
    steps: [
      {
        title: "Tạo MCP",
        detail:
          "Đặt tên, chọn tài khoản quảng cáo, chọn quyền và thiết lập bảo vệ. Mất khoảng 2 phút.",
      },
      {
        title: "Dán link vào AI",
        detail:
          "Sao chép link ở màn hình kết quả (hoặc xem lại trong chi tiết MCP) rồi làm theo hướng dẫn cho Claude, ChatGPT, Gemini.",
      },
      {
        title: "Theo dõi",
        detail:
          "Cột Lượt gọi 7 ngày và số lỗi cho biết MCP có đang được dùng. Chi tiết từng lệnh nằm ở Nhật ký.",
      },
    ],
    warnings: [
      "Ai có link đều dùng được MCP. Không chia sẻ công khai; nghi lộ link thì vào MCP → Bảo mật → Xoay key.",
    ],
  },

  mcpNew: {
    steps: [
      {
        title: "Bước 1 · Đặt tên",
        summary: "Đặt tên dễ nhớ để bạn và đồng nghiệp phân biệt các MCP.",
        steps: [
          {
            title: "Nhập tên MCP",
            detail:
              "Ví dụ: Báo cáo hằng ngày – Team Meta. Tên chỉ để bạn nhận biết, AI không thấy tên này.",
          },
          {
            title: "Mô tả (tuỳ chọn)",
            detail: "Ghi mục đích hoặc ai dùng để sau này dễ nhớ.",
          },
        ],
        tips: ["Đặt tên theo mục đích (báo cáo, tối ưu, kiểm tra) hơn là theo người."],
      },
      {
        title: "Bước 2 · Nền tảng & tài khoản",
        summary: "Chọn AI được thấy những tài khoản quảng cáo nào.",
        steps: [
          {
            title: "Bật nền tảng cần dùng",
            detail:
              "Chỉ hiện nền tảng bạn đã có kết nối. Chưa có? Bấm Thêm kết nối rồi quay lại.",
          },
          {
            title: "Chọn kết nối",
            detail:
              "Một MCP có thể gom nhiều kết nối của cùng một nền tảng.",
          },
          {
            title: "Tất cả hay từng tài khoản",
            detail:
              "Tất cả tài khoản: gồm cả TKQC đồng bộ thêm sau này. Chọn từng tài khoản: AI chỉ thấy đúng các tài khoản bạn tick.",
          },
        ],
        tips: [
          "Nên bắt đầu hẹp (ít tài khoản) rồi mở rộng sau trong tab Cấu hình.",
        ],
        warnings: [
          "Kết nối đang lỗi hoặc bị tắt sẽ khiến MCP không dùng được cho tới khi sửa xong.",
        ],
      },
      {
        title: "Bước 3 · Quyền",
        summary: "Chọn AI được làm gì với từng nền tảng. Quyền Xem luôn bật.",
        steps: [
          {
            title: "Chọn nhanh một mức quyền",
            detail:
              "Chỉ xem: chỉ đọc số liệu.\nVận hành: thêm bật/tắt và sửa ngân sách, giá thầu, lịch.\nToàn quyền: thêm sao chép và tạo mới (trừ xoá).",
          },
          {
            title: "Tinh chỉnh từng quyền",
            detail:
              "Mở Chi tiết từng quyền nếu cần khác mức có sẵn. Nút Áp dụng cho mọi nền tảng sao chép mức quyền sang các nền tảng khác.",
          },
        ],
        tips: [
          "Đối tượng mới tạo hoặc sao chép luôn ở trạng thái tạm dừng, bạn bật khi đã kiểm tra.",
        ],
        warnings: [
          "Quyền Xoá/Lưu trữ KHÔNG thể hoàn tác. Chỉ bật khi thật sự cần, AI vẫn phải xin xác nhận trước khi xoá.",
        ],
      },
      {
        title: "Bước 4 · Bảo vệ",
        summary:
          "Đã có mặc định an toàn, bạn có thể bấm Tạo MCP ngay hoặc siết thêm.",
        steps: [
          {
            title: "Xác nhận 2 bước cho thao tác ghi",
            detail:
              "AI cho bạn xem trước thay đổi (ví dụ ngân sách cũ → mới) và chỉ làm khi bạn đồng ý. Nên để bật.",
          },
          {
            title: "Giới hạn ngân sách",
            detail:
              "Giới hạn % thay đổi mỗi lần và trần theo từng loại tiền (ngày, trọn đời, giá thầu/CPA). Tiền tệ không bao giờ bị cộng chéo.",
          },
          {
            title: "Giới hạn tốc độ",
            detail:
              "Số lệnh mỗi phút và số thao tác ghi mỗi 10 phút, để AI không gọi dồn dập.",
          },
          {
            title: "Thời hạn & IP",
            detail:
              "Ngày hết hạn (link tự ngừng) và danh sách IP được phép. Để trống nếu không cần.",
          },
          {
            title: "Bấm Tạo MCP",
            detail:
              "Bạn cần nhập lại mật khẩu (và mã 2FA nếu có) vì link dùng được ngay sau khi tạo.",
          },
        ],
        warnings: [
          "Đặt danh sách IP sẽ chặn Claude Code/Gemini CLI chạy trên máy cá nhân có IP thay đổi.",
          "Tắt xác nhận 2 bước nghĩa là AI sửa quảng cáo ngay khi được yêu cầu.",
        ],
      },
    ] satisfies readonly GuideDef[],
  },

  mcpCreated: {
    title: "Kết nối MCP với AI",
    summary: "MCP đã sẵn sàng. Dán link vào ứng dụng AI bạn dùng.",
    steps: [
      {
        title: "Sao chép link MCP",
        detail: "Bấm nút Sao chép ở khung Link MCP.",
      },
      {
        title: "Chọn ứng dụng AI",
        detail:
          "Chọn Claude, ChatGPT hoặc Gemini ở phần Hướng dẫn kết nối ngay trên trang và làm theo từng bước (có lệnh sao chép sẵn).",
      },
      {
        title: "Thử một câu hỏi",
        detail: "Ví dụ: “Liệt kê tài khoản quảng cáo và chi tiêu hôm qua”.",
      },
    ],
    warnings: [
      "Ai có link đều dùng được MCP. Không đăng công khai hay dán vào nhóm chat.",
      "Bạn xem lại được link trong chi tiết MCP (cần nhập lại mật khẩu).",
    ],
  },

  mcpDetail: {
    overview: {
      title: "MCP · Tổng quan",
      summary: "Tình trạng sử dụng 7–14 ngày gần nhất và phạm vi của MCP.",
      steps: [
        {
          title: "Đọc số liệu",
          detail:
            "Lượt gọi, lỗi, thao tác ghi và lần dùng cuối cho biết AI có đang dùng MCP.",
        },
        {
          title: "Kiểm tra phạm vi",
          detail:
            "Khung Phạm vi MCP tóm tắt tài khoản, quyền và các giới hạn đang áp dụng.",
        },
      ],
      tips: [
        "Nhiều lỗi liên tiếp? Mở tab Nhật ký để xem lệnh nào lỗi và vì sao.",
      ],
    },
    config: {
      title: "MCP · Cấu hình",
      summary: "Sửa tên, tài khoản, quyền và bảo vệ của MCP.",
      steps: [
        {
          title: "Chỉnh các mục cần đổi",
          detail:
            "Thanh Có thay đổi chưa lưu hiện ra ngay khi bạn sửa. Bấm Lưu thay đổi để áp dụng hoặc Huỷ để bỏ.",
        },
        {
          title: "Có hiệu lực ở lệnh tiếp theo",
          detail: "Link MCP giữ nguyên, AI không cần kết nối lại.",
        },
      ],
      warnings: [
        "ChatGPT Business/Enterprise lưu danh sách tool: sau khi đổi quyền, admin workspace cần làm mới app trong ChatGPT.",
        "Kết nối hoặc TKQC không còn dùng được sẽ bị loại khỏi MCP khi bạn lưu.",
      ],
    },
    connect: {
      title: "MCP · Kết nối AI",
      summary: "Xem lại link MCP và hướng dẫn dán vào Claude, ChatGPT, Gemini.",
      steps: [
        {
          title: "Xem lại link",
          detail:
            "Link bị che. Bấm Xem lại link và nhập mật khẩu (và mã 2FA) để hiện đầy đủ. Mỗi lần xem đều được ghi nhật ký.",
        },
        {
          title: "Làm theo hướng dẫn của ứng dụng AI",
          detail:
            "Chọn tab Claude, ChatGPT hoặc Gemini; sau khi xem lại link, lệnh sẽ tự điền link thật.",
        },
      ],
      warnings: ["Không gửi link qua nhóm chat hoặc nơi công khai."],
    },
    logs: {
      title: "MCP · Nhật ký",
      summary: "Đường tắt sang Nhật ký MCP đã lọc theo MCP này.",
      steps: [
        {
          title: "Mở Nhật ký MCP",
          detail:
            "Mỗi lệnh AI gửi tới MCP: thời gian, tool, tài khoản, giá trị trước → sau và trạng thái.",
        },
        {
          title: "Thao tác của nhân sự",
          detail:
            "Tạo, sửa, xoay key, xem lại link… nằm trong Nhật ký nhân sự.",
        },
      ],
    },
    security: {
      title: "MCP · Bảo mật",
      summary: "Quản lý link, bật/tắt và xoá MCP.",
      steps: [
        {
          title: "Tắt/Bật MCP",
          detail:
            "Tắt: AI gọi tới nhận lỗi không tìm thấy. Bật lại bất cứ lúc nào, link giữ nguyên.",
        },
        {
          title: "Xoay key khi nghi lộ link",
          detail:
            "Link cũ ngừng hoạt động ngay, link mới hiện một lần. Bạn phải dán link mới vào mọi ứng dụng AI đang dùng.",
        },
        {
          title: "Xoá MCP",
          detail: "Xoá vĩnh viễn MCP và link của nó. Nhật ký vẫn được giữ theo thời gian lưu trữ.",
        },
      ],
      warnings: [
        "Xoay key và Xoá MCP không hoàn tác được và cần nhập lại mật khẩu.",
      ],
    },
  },

  logs: {
    mcp: {
      title: "Nhật ký MCP",
      summary: "Mọi lệnh AI gửi tới các MCP của bạn.",
      steps: [
        {
          title: "Chọn khoảng thời gian",
          detail: "Mặc định là gần đây nhất; đổi bằng bộ chọn ngày.",
        },
        {
          title: "Lọc",
          detail:
            "Theo MCP, nền tảng, trạng thái, tool hoặc từ khoá để tìm đúng lệnh cần xem.",
        },
        {
          title: "Bấm một dòng để xem chi tiết",
          detail:
            "Thấy yêu cầu, kết quả, giá trị trước → sau và lỗi (nếu có). Dữ liệu nhạy cảm đã được che.",
        },
        {
          title: "Xuất CSV",
          detail: "Xuất theo bộ lọc đang chọn (tối đa 100.000 dòng). Cần nhập lại mật khẩu.",
        },
      ],
      tips: ["Nhân viên chỉ thấy nhật ký MCP của chính mình."],
    },
    staff: {
      title: "Nhật ký nhân sự",
      summary: "Thao tác của đồng nghiệp trên ứng dụng (chỉ quản trị viên).",
      steps: [
        {
          title: "Xem ai làm gì",
          detail:
            "Đăng nhập, tạo/sửa kết nối và MCP, xoay key, xem lại link, đổi quyền…",
        },
        {
          title: "Lọc và xuất",
          detail: "Lọc theo người thực hiện, hành động, thời gian rồi Xuất CSV nếu cần lưu lại.",
        },
      ],
      warnings: [
        "Nhật ký tự xoá sau số tháng đặt trong Cài đặt và không khôi phục được.",
      ],
    },
  },

  settings: {
    title: "Về Cài đặt",
    summary: "Các thiết lập chung cho cả hệ thống (chỉ quản trị viên).",
    steps: [
      {
        title: "Lưu trữ nhật ký",
        detail:
          "Số tháng giữ nhật ký MCP và nhật ký nhân sự (1–24). Nhật ký cũ hơn bị xoá vĩnh viễn mỗi đêm.",
      },
      {
        title: "Bảo mật",
        detail:
          "Bắt buộc 2FA cho quản trị viên hoặc cho mọi người, và thời lượng phiên đăng nhập tối đa.",
      },
      {
        title: "Thông tin pháp lý",
        detail:
          "Tên đơn vị vận hành và email liên hệ quyền riêng tư, hiển thị trên các trang công khai /privacy, /terms, /data-deletion (dán vào Meta App Dashboard / OpenAI). Để trống sẽ dùng tên miền.",
      },
      {
        title: "Lưu thay đổi",
        detail: "Thanh Có thay đổi chưa lưu hiện ra khi bạn sửa; bấm Lưu để áp dụng.",
      },
    ],
    tips: [
      "Phiên bản API nền tảng chỉ đọc; đổi bằng biến môi trường rồi khởi động lại.",
    ],
    warnings: [
      "Giảm số tháng lưu trữ sẽ xoá phần nhật ký cũ, không thể hoàn tác.",
      "Bật bắt buộc 2FA: ai chưa có 2FA sẽ phải thiết lập ở lần vào trang tiếp theo.",
    ],
  },

  updates: {
    title: "Cách cập nhật hệ thống",
    summary:
      "Cập nhật lên bản mới chỉ với một cú bấm. Hệ thống tự sao lưu và tự quay về bản cũ nếu có lỗi (chỉ quản trị viên).",
    steps: [
      {
        title: "Kiểm tra bản mới",
        detail:
          "Hệ thống tự hỏi GitHub mỗi 6 giờ và kiểm tra ngay mỗi khi bạn mở trang này. Muốn kiểm tra lại, bấm Kiểm tra ngay.",
      },
      {
        title: "Đọc ghi chú phát hành",
        detail: "Xem bản mới có gì thay đổi trước khi cập nhật.",
      },
      {
        title: "Bấm Cập nhật và xác nhận mật khẩu",
        detail:
          "Ứng dụng gián đoạn khoảng 1-2 phút. Bạn có thể theo dõi từng bước ngay trên trang; trang tự tải lại khi xong.",
      },
      {
        title: "Nếu nút Cập nhật bị khoá",
        detail:
          "Dịch vụ cập nhật (updater) chưa chạy trên máy chủ. Làm theo hướng dẫn cập nhật bằng tay hoặc bật updater ở thẻ Cập nhật tự động.",
      },
    ],
    tips: [
      "Mọi người đều thấy số phiên bản ở menu tài khoản; chỉ quản trị viên thấy thông báo có bản mới.",
      "Mỗi lần cập nhật được ghi vào Nhật ký nhân sự.",
    ],
    warnings: [
      "Không đóng máy chủ hay chạy lệnh Docker khác trong lúc đang cập nhật.",
      "Cập nhật không đảo ngược thay đổi cơ sở dữ liệu. Nếu lỗi, hệ thống quay về bản cũ nhưng giữ bản sao lưu ở máy chủ.",
    ],
  },

  users: {
    title: "Quản lý người dùng",
    summary: "Tạo tài khoản cho đội và phân quyền (chỉ quản trị viên).",
    steps: [
      {
        title: "Thêm người dùng",
        detail:
          "Nhập email, tên và vai trò. Ứng dụng tạo mật khẩu tạm thời và chỉ hiện một lần: hãy gửi cho người đó.",
      },
      {
        title: "Chọn vai trò",
        detail:
          "Quản trị viên: toàn quyền, thấy mọi kết nối và MCP.\nNhân viên: chỉ dùng kết nối và MCP của chính mình.",
      },
      {
        title: "Lần đăng nhập đầu",
        detail:
          "Người dùng phải đổi mật khẩu tạm. 2FA là tuỳ chọn, mỗi người tự bật trong Tài khoản (hoặc bắt buộc nếu bật trong Cài đặt).",
      },
      {
        title: "Quản lý tài khoản",
        detail:
          "Đổi vai trò, đặt lại mật khẩu, đặt lại 2FA, khoá hoặc mở khoá ở menu của từng dòng.",
      },
    ],
    warnings: [
      "Luôn giữ ít nhất 1 quản trị viên đang hoạt động.",
      "Đổi vai trò, tạo quản trị viên, đặt lại mật khẩu/2FA của quản trị viên, khoá hoặc xoá một quản trị viên đều cần nhập lại mật khẩu của bạn. Đặt lại mật khẩu/2FA của nhân viên hỏi lại mật khẩu khi phiên đăng nhập đã quá 10 phút.",
    ],
  },

  account: {
    title: "Tài khoản của bạn",
    summary: "Hồ sơ, mật khẩu, 2FA và các phiên đăng nhập.",
    steps: [
      {
        title: "Đổi mật khẩu",
        detail:
          "Tối thiểu 8 ký tự. Nên dùng mật khẩu dài, riêng cho ứng dụng này.",
      },
      {
        title: "Bật xác thực 2 bước (tuỳ chọn)",
        detail:
          "Quét mã QR bằng Google Authenticator hoặc Authy, nhập mã 6 số và lưu mã dự phòng ở nơi an toàn.",
      },
      {
        title: "Kiểm tra phiên đăng nhập",
        detail:
          "Thấy thiết bị lạ? Đăng xuất phiên đó rồi đổi mật khẩu.",
      },
    ],
    tips: [
      "Menu Giao diện cho phép đổi sáng/tối và giảm hiệu ứng trong suốt để dễ đọc hơn.",
    ],
  },

  automationTips: {
    title: "Mẹo chạy tự động",
    summary:
      "Ứng dụng AI tự chạy câu lệnh theo lịch và gọi MCP của bạn - app này không tự gửi lệnh cho AI.",
    steps: [
      {
        title: "Tạo MCP riêng",
        detail:
          "Chế độ Chỉ báo cáo: quyền Chỉ xem. Chế độ Tự tắt: Xem + Bật/Tắt, tắt Xác nhận 2 bước, trần ngân sách thấp.",
      },
      {
        title: "Soạn quy tắc",
        detail: "Nhập ngưỡng CPA, sao chép câu lệnh hoặc skill.",
      },
      {
        title: "Đặt lịch",
        detail:
          "Thêm link MCP vào ứng dụng AI rồi tạo tác vụ hẹn giờ theo tab Claude / ChatGPT / Gemini. Cần 30 phút/lần: Claude Desktop (cục bộ) hoặc Gemini CLI.",
      },
      {
        title: "Theo dõi",
        detail: "Kiểm tra Nhật ký MCP sau vài lượt chạy đầu tiên.",
      },
    ],
    tips: [
      "Bắt đầu bằng chế độ Chỉ báo cáo, đối chiếu vài ngày rồi mới cho AI tự tắt.",
      "Đặt Ngày hết hạn cho MCP chạy thử để link tự ngừng khi bạn quên.",
    ],
    warnings: [
      "Tắt MCP (tab Bảo mật) là cách dừng nhanh nhất khi AI làm sai.",
    ],
  },
} as const satisfies Record<string, unknown>
