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
      "Chưa có gì? Bắt đầu bằng Kết nối → Thêm kết nối, rồi Tạo MCP.",
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
            "Meta, TikTok, Google Ads (gồm YouTube) hoặc OpenAI Ads. Hướng dẫn lấy token đúng nền tảng sẽ hiện ở bước tiếp theo.",
        },
        {
          title: "Kênh thông báo, kho creative và nguồn dữ liệu",
          detail:
            "Telegram: bot gửi cảnh báo, thông báo vào nhóm / kênh.\nGoogle Drive: khai báo thư mục ảnh, video hoặc Google Sheet kế hoạch để AI lấy file lên quảng cáo.\nApify: dán API token để AI lấy dữ liệu sàn TMĐT, mạng xã hội, Google Maps… Ba mục này mở trang khai báo riêng.",
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
        summary:
          "Chọn AI được thấy những tài khoản quảng cáo nào và có được lấy dữ liệu qua Apify không. Cần ít nhất 1 nền tảng: Meta, TikTok, Google Ads, OpenAI Ads hoặc Apify.",
        steps: [
          {
            title: "Bật nền tảng cần dùng",
            detail:
              "Nền tảng quảng cáo chỉ hiện khi bạn đã có kết nối. Chưa có? Bấm Thêm kết nối rồi quay lại.",
          },
          {
            title: "Apify (lấy dữ liệu)",
            detail:
              "Thẻ Apify nằm cùng các nền tảng quảng cáo: bật để AI lấy dữ liệu (Shopee, Lazada, TikTok Shop, TikTok, Facebook, Google Maps, trang web…) bằng token Apify công ty + token cá nhân của chủ MCP (tự xoay vòng). Một MCP có thể vừa quản lý quảng cáo vừa lấy dữ liệu Apify, hoặc chỉ dùng Apify. Chưa có token dùng được thì công tắc bị khoá - bấm Thêm token Apify (Kết nối → Apify) rồi quay lại.",
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
          {
            title: "Telegram (tuỳ chọn)",
            detail:
              "Tick kết nối Telegram mà MCP được dùng để gửi thông báo. Chỉ hiện kết nối do chính chủ MCP tạo (kể cả quản trị viên) - MCP không dùng được kết nối Telegram của người khác. Chưa có? Bấm Thêm kết nối Telegram rồi quay lại.",
          },
          {
            title: "Google Drive (tuỳ chọn)",
            detail:
              "Tick thư mục ảnh / video hoặc Google Sheet kế hoạch creative mà AI được đọc (nhóm Của công ty, Của tôi; quản trị viên thấy thêm Của nhân viên). MCP của nhân viên chỉ dùng được nguồn công ty và nguồn riêng của chủ MCP. Không chọn: AI chỉ dùng được link Drive công khai. Chưa có? Khai báo ở Kết nối → Google Drive rồi quay lại.",
          },
        ],
        tips: [
          "Nên bắt đầu hẹp (ít tài khoản) rồi mở rộng sau trong tab Cấu hình.",
          "Quảng cáo YouTube nằm trong kết nối Google Ads (chiến dịch Video / Demand Gen).",
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
          {
            title: "Telegram (khi đã chọn kết nối)",
            detail:
              "AI được gửi tin: AI gửi báo cáo vào Telegram khi bạn yêu cầu, có thể kèm 1 ảnh, video hoặc tệp (link công khai, tệp bạn đính kèm trong ChatGPT, hoặc tệp CSV/TXT do AI viết).\nTự báo khi AI thay đổi quảng cáo: mỗi thao tác ghi thành công gửi 1 tin tóm tắt trước → sau.\nMọi tin đều có dòng ghi nguồn \"Ads MCP Simple\" ở cuối.",
          },
          {
            title: "GMV Max (TikTok Shop) - chỉ quản trị viên",
            detail:
              "Thẻ TikTok Ads có công tắc Cho phép AI thay đổi GMV Max (mặc định tắt: AI chỉ xem chỉ số GMV Max). Chỉ quản trị viên bật được; nhân viên nhờ quản trị viên mở MCP để bật. Khi bật, mọi thay đổi GMV Max luôn phải xác nhận 2 bước; ở chế độ bảo vệ Tùy chỉnh nâng cao còn cần trần ngân sách/ngày, ở chế độ Cơ bản AI không tạo mới / sao chép được chiến dịch GMV Max. Chiến dịch GMV Max tạo mới / sao chép chạy ngay. Đọc kỹ ảnh hưởng của từng quyền hiện ngay dưới công tắc.",
          },
          {
            title: "Google Drive",
            detail:
              "Cho phép dùng link Drive công khai (mặc định bật): AI lấy được ảnh, video từ link \"Bất kỳ ai có đường liên kết\" bạn dán vào chat - cần quản trị viên đã lưu API key.\nCho phép ghi trạng thái vào Google Sheet (mặc định bật): sau khi lên quảng cáo, AI ghi trạng thái, mã quảng cáo vào đúng dòng của sheet đã bật ghi; mỗi lần ghi tính vào giới hạn thao tác ghi / 10 phút.\nAI chỉ tải được ảnh, video lên khi MCP có quyền Tạo mới ở nền tảng đó. Video lớn (TikTok > 10 MB, Meta > 50 MB) được tải ở chế độ nền vài phút.",
          },
          {
            title: "Apify (khi đã bật ở bước 2)",
            detail:
              "Thẻ Apify nằm cùng thẻ quyền của các nền tảng quảng cáo.\nTrần mỗi lần chạy (mặc định 1 USD) luôn áp dụng, kể cả chế độ Cơ bản; mỗi lần chạy tốn credit Apify và tính vào giới hạn thao tác ghi.\nCho phép Actor ngoài danh mục: chỉ quản trị viên bật (khi sửa MCP phải nhập lại mật khẩu).",
          },
        ],
        tips: [
          "Đối tượng mới tạo hoặc sao chép luôn ở trạng thái tạm dừng, bạn bật khi đã kiểm tra - trừ chiến dịch GMV Max (TikTok Shop): TikTok cho chạy ngay.",
        ],
        warnings: [
          "Quyền Xoá/Lưu trữ KHÔNG thể hoàn tác. Chỉ bật khi thật sự cần, AI vẫn phải xin xác nhận trước khi xoá.",
        ],
      },
      {
        title: "Bước 4 · Bảo vệ",
        summary:
          "Mặc định là chế độ Cơ bản: chỉ đặt ngày hết hạn. Bật Tùy chỉnh nâng cao nếu muốn siết thêm.",
        steps: [
          {
            title: "Cơ bản hoặc Tùy chỉnh nâng cao",
            detail:
              "Cơ bản (mặc định): chỉ áp dụng ngày hết hạn - không xác nhận 2 bước, không trần chi tiêu, không giới hạn tốc độ, mọi IP. Xoá vẫn luôn cần xác nhận và đối tượng tạo mới vẫn ở trạng thái tạm dừng.\nBật Tùy chỉnh nâng cao để đặt các giới hạn bên dưới. Tắt lại thì giá trị đã nhập được giữ, bật lại là áp dụng.",
          },
          {
            title: "Xác nhận 2 bước cho thao tác ghi",
            detail:
              "AI cho bạn xem trước thay đổi (ví dụ ngân sách cũ → mới) và chỉ làm khi bạn đồng ý. Nên để bật.",
          },
          {
            title: "Giới hạn ngân sách (nâng cao)",
            detail:
              "Giới hạn % thay đổi mỗi lần và trần theo từng loại tiền (ngày, trọn đời, giá thầu/CPA). Tiền tệ không bao giờ bị cộng chéo.",
          },
          {
            title: "Giới hạn tốc độ (nâng cao)",
            detail:
              "Số lệnh mỗi phút, số thao tác ghi mỗi 10 phút và giãn cách giữa các lệnh ghi (giây), để AI không gọi API dồn dập.",
          },
          {
            title: "Giới hạn tin Telegram / giờ (nâng cao)",
            detail:
              "Chỉ hiện khi MCP dùng kết nối Telegram: số tin AI được gửi mỗi giờ (mặc định 20).",
          },
          {
            title: "Trần Apify mỗi ngày (nâng cao)",
            detail:
              "Chỉ hiện khi MCP bật Apify: tổng chi phí Apify mỗi ngày (giờ Việt Nam), mặc định 10 USD, 0 = không giới hạn. Chế độ Cơ bản không có trần ngày, chỉ còn trần mỗi lần chạy - MCP dùng token Apify công ty nên bật Tùy chỉnh nâng cao.",
          },
          {
            title: "Thời hạn & IP",
            detail:
              "Ngày hết hạn (link tự ngừng, có ở cả hai chế độ) và danh sách IP được phép (nâng cao). Để trống nếu không cần.",
          },
          {
            title: "Bấm Tạo MCP",
            detail:
              "Bạn cần nhập lại mật khẩu (và mã 2FA nếu có) vì link dùng được ngay sau khi tạo.",
          },
        ],
        warnings: [
          "Đặt danh sách IP sẽ chặn Claude Code/Gemini CLI chạy trên máy cá nhân có IP thay đổi.",
          "Tắt xác nhận 2 bước (hoặc dùng chế độ Cơ bản) nghĩa là AI sửa quảng cáo ngay khi được yêu cầu.",
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
        {
          title: "Telegram",
          detail:
            "Chọn kết nối Telegram ở khung Nền tảng, bật AI được gửi tin / Tự báo khi AI thay đổi quảng cáo ở khung Quyền, giới hạn tin/giờ ở khung Bảo vệ (chế độ Tùy chỉnh nâng cao).",
        },
        {
          title: "Google Drive",
          detail:
            "Chọn thư mục / sheet ở khung Nền tảng (khối Google Drive); bật hoặc tắt Cho phép dùng link Drive công khai và Cho phép ghi trạng thái vào Google Sheet ở khung Quyền. Nguồn không còn dùng được bị loại khỏi MCP khi bạn lưu.",
        },
        {
          title: "GMV Max (TikTok Shop)",
          detail:
            "Công tắc Cho phép AI thay đổi GMV Max nằm trong thẻ TikTok Ads ở khung Quyền. Chỉ quản trị viên bật được; nhân viên chỉ tắt được.",
        },
        {
          title: "Apify",
          detail:
            "Bật / tắt thẻ Apify ở khung Nền tảng (cùng các nền tảng quảng cáo); trần mỗi lần chạy và Actor ngoài danh mục (chỉ quản trị viên) ở thẻ Apify của khung Quyền; trần Apify mỗi ngày ở khung Bảo vệ (Tùy chỉnh nâng cao).",
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
          "Tên đơn vị vận hành và email liên hệ quyền riêng tư, hiển thị trên các trang công khai /privacy, /terms, /data-deletion (dán vào Meta App Dashboard, TikTok for Developers, màn hình đồng ý OAuth của Google Cloud / OpenAI). Để trống sẽ dùng tên miền.",
      },
      {
        title: "Lưu thay đổi",
        detail: "Thanh Có thay đổi chưa lưu hiện ra khi bạn sửa; bấm Lưu để áp dụng.",
      },
    ],
    tips: [
      "Phiên bản API nền tảng chỉ đọc; đổi bằng biến môi trường rồi khởi động lại.",
      "Thẻ Google Drive hệ thống lưu riêng (nút Lưu thông tin xác thực), không đi theo thanh Có thay đổi chưa lưu.",
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

  telegramList: {
    title: "Về kết nối Telegram",
    summary:
      "Kết nối Telegram là một bot gửi tin vào nhóm, kênh hoặc chat riêng: cảnh báo kết nối quảng cáo, thay đổi do AI thực hiện và tin nhắn từ AI.",
    steps: [
      {
        title: "Thêm kết nối Telegram",
        detail:
          "Bấm Thêm kết nối → nhóm Kênh thông báo → Telegram. Dán bot token và Chat ID rồi bấm Kiểm tra & lưu.",
      },
      {
        title: "Chọn kết nối Telegram trong MCP",
        detail:
          "Ở bước Nền tảng của MCP, chọn kết nối Telegram để AI báo mỗi lần sửa quảng cáo hoặc gửi tin tóm tắt.",
      },
      {
        title: "Theo dõi trạng thái",
        detail:
          "Hoạt động: gửi tin bình thường.\nLỗi: bot bị gỡ khỏi nhóm, mất quyền hoặc token bị thu hồi - mở kết nối để xem cách sửa.\nĐã tắt: không gửi gì cho tới khi bật lại.",
      },
    ],
    tips: [
      "Một bot có thể dùng cho nhiều kết nối (mỗi kết nối một nhóm hoặc một chủ đề).",
      "Nhân viên chỉ thấy kết nối Telegram của mình; quản trị viên thấy tất cả.",
    ],
  },

  telegramNew: {
    title: "Cách kết nối Telegram",
    summary:
      "Tạo bot với @BotFather, thêm bot vào nơi nhận tin, rồi dán bot token và Chat ID vào đây.",
    steps: [
      {
        title: "Tạo bot với @BotFather",
        detail:
          "Trong Telegram, mở chat với @BotFather (bot chính thức, có dấu tích xanh), gửi /newbot, đặt tên hiển thị và username kết thúc bằng \"bot\". BotFather trả về bot token dạng 123456789:AA… - dán vào ô Bot token.",
        link: { label: "Mở @BotFather", url: "https://t.me/BotFather" },
      },
      {
        title: "Thêm bot vào nhóm hoặc kênh",
        detail:
          "Nhóm: Thêm thành viên → tìm username của bot.\nKênh: Quản trị viên → Thêm quản trị viên → chọn bot.\nChat riêng: mở chat với bot và bấm Start.",
      },
      {
        title: "Cấp quyền gửi tin",
        detail:
          "Kênh: bật quyền Đăng tin cho bot. Nhóm: thành viên phải được gửi tin, hoặc đặt bot làm quản trị viên nếu nhóm hạn chế quyền. Nhóm bật Chủ đề: bot cần được gửi tin trong chủ đề bạn chọn.",
      },
      {
        title: "Lấy Chat ID (cách chính thức)",
        detail:
          "Cách 1 (Telegram Web): mở nhóm/kênh trên Telegram Web (web.telegram.org/a/), số sau dấu # trên thanh địa chỉ (dạng -100…) là Chat ID.\nCách 2 (getUpdates): lưu ý đường link dưới đây chứa bot token - không gửi hay chụp màn hình nó cho ai. Gửi một tin vào nhóm (nhắc @tên_bot), rồi mở trình duyệt vào https://api.telegram.org/bot<token>/getUpdates (thay <token> bằng bot token). Tìm \"chat\":{\"id\":-100…} - đó là Chat ID. Nếu bot đã đặt webhook, getUpdates sẽ báo lỗi - dùng cách 1.",
      },
      {
        title: "Lấy Chủ đề (Thread ID) - nếu nhóm bật Chủ đề",
        detail:
          "Trong nhóm bật Chủ đề, nhấn giữ (hoặc chuột phải) một tin trong chủ đề → Sao chép liên kết. Liên kết dạng https://t.me/c/1234567890/42/100: số ở giữa (42) là Thread ID. Để trống để gửi vào chủ đề General.",
      },
      {
        title: "Kiểm tra & lưu",
        detail:
          "Kiểm tra cho xem bot, chat và quyền gửi tin mà chưa lưu gì. Kiểm tra & lưu sẽ lưu kết nối; sau đó bấm Gửi tin thử.",
      },
    ],
    warnings: [
      "Các bot bên thứ ba như @userinfobot, @getidsbot không phải của Telegram và đọc được tin bạn chuyển tiếp cho chúng. Hãy ưu tiên cách chính thức (Telegram Web hoặc getUpdates).",
      "Ai có bot token đều điều khiển được bot. Không gửi token qua chat hay ảnh chụp màn hình (kể cả đường link getUpdates). Nếu lộ, gửi /revoke cho @BotFather rồi bấm Thay token.",
    ],
    tips: [
      "Bot vẫn gửi được tin khi bật Privacy mode - chế độ này chỉ giới hạn tin bot đọc được.",
      "Muốn gửi vào nhiều nhóm, thêm nhiều kết nối dùng chung một bot.",
    ],
    links: [
      { label: "Telegram Bot API (chính thức)", url: "https://core.telegram.org/bots/api" },
      { label: "Giới thiệu bot và BotFather", url: "https://core.telegram.org/bots/features#botfather" },
    ],
  },

  telegramDetail: {
    title: "Quản lý kết nối Telegram",
    summary: "Kiểm tra bot còn gửi được tin, chỉnh nơi nhận và xem lịch sử gửi.",
    steps: [
      {
        title: "Gửi tin thử",
        detail:
          "Gửi một tin ngay vào chat/chủ đề đã chọn - cách chắc chắn nhất để biết bot đúng nơi, đủ quyền.",
      },
      {
        title: "Kiểm tra lại",
        detail:
          "Gọi Telegram để xác nhận token, chat và quyền của bot; kết nối lỗi sẽ hoạt động lại khi kiểm tra đạt.",
      },
      {
        title: "Sửa cài đặt",
        detail:
          "Đổi tên, Chat ID, Thread ID hoặc sự kiện hệ thống rồi bấm Lưu trên thanh Có thay đổi chưa lưu.",
      },
      {
        title: "Thay token",
        detail:
          "Khi thu hồi token ở @BotFather (/revoke), dán token mới tại đây (cần nhập lại mật khẩu).",
      },
      {
        title: "Xem lần gửi gần đây",
        detail:
          "50 tin gần nhất kèm trạng thái và lỗi (nếu có) giúp tìm nguyên nhân khi không nhận được thông báo.",
      },
    ],
    warnings: [
      "Xoá kết nối sẽ gỡ kết nối Telegram khỏi mọi MCP đang dùng và không thể hoàn tác.",
    ],
  },

  apifyList: {
    title: "Về token Apify",
    summary:
      "Apify là nền tảng thu thập dữ liệu web. Thêm API token để AI lấy dữ liệu Shopee, TikTok, Facebook, Google Maps… qua MCP - hệ thống tự chọn Actor phù hợp và tự xoay vòng token.",
    steps: [
      {
        title: "Lấy API token",
        detail:
          "Đăng nhập Apify Console → Settings → API & Integrations → sao chép Personal API token (dạng apify_api_…).",
        link: {
          label: "Mở Apify Console",
          url: "https://console.apify.com/settings/integrations",
        },
      },
      {
        title: "Thêm token",
        detail:
          "Bấm Thêm token Apify, dán token, bấm Kiểm tra để xem tài khoản, gói và credit rồi bấm Kiểm tra & lưu.",
      },
      {
        title: "Bật Apify trong MCP",
        detail:
          "Ở bước Nền tảng & tài khoản của MCP, bật thẻ Apify (Apify là một nền tảng như Meta, TikTok… - MCP có thể chỉ dùng Apify); ở bước Quyền đặt trần chi phí mỗi lần chạy.",
      },
      {
        title: "Theo dõi trạng thái",
        detail:
          "Hoạt động: dùng được.\nHết credit: tạm bỏ qua tới ngày làm mới credit.\nToken không hợp lệ / Lỗi: mở token để xem cách sửa.\nĐã tắt: AI không dùng tới.",
      },
    ],
    tips: [
      "Token Công ty: mọi MCP bật Apify đều xoay vòng được (chỉ quản trị viên thêm). Token Cá nhân: chỉ MCP của chính người thêm.",
      "Nhân viên thấy token công ty ở dạng chỉ xem cùng token cá nhân của mình; quản trị viên thấy tất cả.",
      "Token hết credit được tự bỏ qua, AI chuyển sang token còn credit.",
    ],
    warnings: [
      "Điều khoản Apify cấm một người lập nhiều tài khoản cá nhân: chỉ xoay vòng giữa các tài khoản Apify hợp pháp khác nhau. Nhiều token của cùng một tài khoản dùng chung credit.",
      "Đặt giới hạn chi tiêu hằng tháng trong Apify Console → Billing → Limits để chặn chi phí ngoài ý muốn.",
    ],
    links: [
      {
        label: "Apify Console - API & Integrations",
        url: "https://console.apify.com/settings/integrations",
      },
      {
        label: "Điều khoản Apify (General Terms)",
        url: "https://docs.apify.com/legal/general-terms-and-conditions",
      },
    ],
  },

  apifyNew: {
    title: "Cách thêm token Apify",
    summary:
      "Chỉ cần API token của Apify. Kiểm tra cho xem tài khoản, gói và credit trước khi lưu.",
    steps: [
      {
        title: "Mở trang API & Integrations",
        detail:
          "Đăng nhập Apify Console → Settings → API & Integrations. Tài khoản tổ chức: dùng token của tổ chức hoặc Personal API token trong tổ chức.",
        link: {
          label: "Mở Apify Console",
          url: "https://console.apify.com/settings/integrations",
        },
      },
      {
        title: "Sao chép token",
        detail:
          "Sao chép Personal API token (dạng apify_api_…) rồi dán vào ô API token. Không dùng token giới hạn quyền (scoped) trừ khi bạn đã thử chạy được Actor bằng nó.",
      },
      {
        title: "Chọn phạm vi",
        detail:
          "Quản trị viên: Dùng chung công ty (mọi MCP bật Apify dùng được) hoặc Cá nhân. Nhân viên: luôn là Cá nhân - chỉ MCP của chính bạn dùng.",
      },
      {
        title: "Kiểm tra & lưu",
        detail:
          "Kiểm tra hiện tài khoản, gói, credit đã dùng / giới hạn và ngày làm mới credit mà chưa lưu gì. Kiểm tra & lưu sẽ lưu token để MCP bắt đầu xoay vòng qua token này.",
      },
    ],
    warnings: [
      "Điều khoản Apify cấm một người lập nhiều tài khoản cá nhân. Chỉ thêm token của các tài khoản Apify hợp pháp khác nhau; token cùng tài khoản dùng chung credit.",
      "Token Apify có toàn quyền tài khoản (chạy Actor, chi tiền). Ứng dụng mã hoá token và không bao giờ hiển thị lại - đừng gửi token qua chat hay ảnh chụp màn hình.",
    ],
    tips: [
      "Đặt giới hạn chi tiêu hằng tháng trong Apify Console → Billing → Limits - lớp bảo vệ cuối cùng nếu có sự cố.",
      "Gói Free có $5 credit mỗi tháng; một số Actor sàn TMĐT chỉ trả dữ liệu mẫu với gói Free.",
    ],
  },

  apifyDetail: {
    title: "Quản lý token Apify",
    summary:
      "Xem credit còn lại, MCP dùng được token này và các lần chạy Actor gần đây.",
    steps: [
      {
        title: "Kiểm tra lại",
        detail:
          "Gọi Apify để cập nhật tài khoản, gói và credit ngay (hệ thống cũng tự kiểm tra mỗi 6 giờ). Token hết credit hoạt động lại khi credit được làm mới.",
      },
      {
        title: "Thay token",
        detail:
          "Khi tạo lại token trong Apify Console, dán token mới tại đây (cần nhập lại mật khẩu).",
      },
      {
        title: "Tắt / bật",
        detail:
          "Token đang tắt không được MCP dùng tới, nhưng vẫn giữ nguyên để bật lại sau.",
      },
      {
        title: "Lần chạy gần đây",
        detail:
          "20 lần chạy gần nhất kèm trạng thái và chi phí thực - giúp biết credit đã dùng vào việc gì.",
      },
    ],
    warnings: [
      "Xoá token không xoá token trên Apify. Nếu không dùng nữa, hãy xoá hoặc tạo lại token trong Apify Console.",
    ],
  },

  /** Mẹo sử dụng → Chạy tự động (/tips/automation) */
  automationTips: {
    title: "Mẹo: chạy tự động",
    summary:
      "Ứng dụng AI tự chạy câu lệnh theo lịch và gọi MCP của bạn - app này không tự gửi lệnh cho AI.",
    steps: [
      {
        title: "Tạo MCP riêng",
        detail:
          "Chế độ Chỉ báo cáo: quyền Chỉ xem. Chế độ Tự tắt: Xem + Bật/Tắt, bật Tùy chỉnh nâng cao ở bước Bảo vệ, tắt Xác nhận 2 bước, trần ngân sách thấp.",
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

  /** Mẹo sử dụng → Tạo quảng cáo số lượng lớn (/tips/bulk-ads) */
  tipsBulkAds: {
    title: "Mẹo: lên quảng cáo hàng loạt",
    summary:
      "Mỗi dòng Google Sheet là một creative; AI tải ảnh, video từ Drive, tạo quảng cáo tạm dừng rồi ghi kết quả vào dòng đó.",
    steps: [
      {
        title: "Chuẩn bị Drive",
        detail:
          "Thư mục ảnh / video và Google Sheet chia sẻ cho email hệ thống (sheet: Người chỉnh sửa), khai báo ở Kết nối → tab Google Drive.",
      },
      {
        title: "Điền sheet theo mẫu",
        detail:
          'Dán dòng tiêu đề hoặc nhập tệp CSV mẫu. Trạng thái trống, "Chờ lên" hoặc "Chưa tạo ads" = cần lên.',
      },
      {
        title: "MCP riêng",
        detail:
          'Quyền Tạo mới, bước Bảo vệ bật Tùy chỉnh nâng cao + Trần ngân sách/ngày (khuyên dùng), bật "Cho phép ghi trạng thái vào Google Sheet", gán thư mục + sheet.',
      },
      {
        title: "Chạy theo lượt nhỏ",
        detail:
          "Soạn câu lệnh, dán vào Claude / ChatGPT, mỗi lượt 5-10 dòng; đồng ý từng bản xem trước.",
      },
      {
        title: "Duyệt rồi bật",
        detail:
          "Mở Link chiến dịch trong sheet, kiểm tra quảng cáo (đang tạm dừng) rồi tự bật.",
      },
    ],
    tips: [
      "Video và ảnh bìa để chung một ô Link Drive (mỗi link một dòng trong ô).",
      "Không sắp xếp, chèn, xoá dòng khi AI đang chạy.",
    ],
    warnings: [
      "Quảng cáo AI tạo luôn tạm dừng - chỉ tiêu tiền khi bạn tự bật.",
    ],
  },

  /** Mẹo sử dụng → Tự động kiểm tra quảng cáo (/tips/ad-check) */
  tipsAdCheck: {
    title: "Mẹo: tự kiểm tra quảng cáo",
    summary:
      "Tác vụ hẹn giờ trên web gộp chi tiêu quảng cáo (Ads MCP) với đơn hàng thật (MCP bán hàng) và gửi báo cáo vào Telegram.",
    steps: [
      {
        title: "MCP chỉ xem + Telegram",
        detail:
          'Quyền Chỉ xem; chọn kết nối Telegram và bật "AI được gửi tin".',
      },
      {
        title: "MCP bán hàng",
        detail:
          "Pancake POS, Nhanh.vn, KiotViet, Sapo, Haravan chưa có MCP chính thức: dùng MCP bên thứ ba hoặc tự kết nối qua API.",
      },
      {
        title: "Cùng một ứng dụng AI",
        detail:
          'Claude trên web: thêm cả hai làm custom connector, tool đọc và telegram_send_message để "Always allow".',
      },
      {
        title: "Chạy thử rồi đặt lịch",
        detail:
          "Dán câu lệnh, đối chiếu số liệu, rồi đặt lịch mỗi ngày (vd 8:00) hoặc mỗi giờ.",
      },
      {
        title: "Theo dõi",
        detail:
          "Xem vài lượt đầu trong mục Scheduled và Nhật ký MCP.",
      },
    ],
    tips: [
      "Gắn utm_campaign = mã chiến dịch vào link quảng cáo để khớp đơn chính xác.",
      "Lịch trên web chạy khi máy bạn tắt; lịch trên máy tính cần máy bật 24/7.",
    ],
    warnings: [
      "Không đưa tên, số điện thoại, địa chỉ khách vào báo cáo hay Telegram.",
    ],
  },
} as const satisfies Record<string, unknown>
