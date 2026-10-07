// Chuỗi tiếng Việt - trang "Mẹo chạy tự động" (/automation-tips): cách cho Claude / ChatGPT / Gemini tự chạy
// theo lịch qua MCP. Văn bản câu lệnh / skill do src/lib/automation-prompt.ts dựng.

export const automation = {
  metaTitle: "Mẹo chạy tự động",
  title: "Mẹo chạy tự động",
  description:
    "Cho Claude, ChatGPT, Gemini tự kiểm tra quảng cáo qua MCP theo lịch mỗi giờ (30 phút nếu chạy trên máy tính). Ví dụ: tự tắt quảng cáo có CPA vượt ngưỡng.",
  createMcp: "Tạo MCP chạy tự động",

  how: {
    title: "Cách hoạt động",
    description:
      "Ứng dụng AI tự mở một cuộc trò chuyện theo lịch, gọi MCP của bạn rồi gửi kết quả.",
    stepsLabel: "Bốn bước thiết lập",
    steps: [
      {
        title: "Tạo MCP riêng",
        detail:
          "Chỉ cấp đúng quyền tác vụ cần, đặt trần ngân sách và giới hạn thao tác ghi thấp.",
      },
      {
        title: "Soạn quy tắc",
        detail: "Nhập ngưỡng CPA bên dưới để có câu lệnh hoặc skill viết sẵn.",
      },
      {
        title: "Đặt lịch trong AI",
        detail: "Dùng tác vụ hẹn giờ của Claude, ChatGPT hoặc Gemini.",
      },
      {
        title: "Theo dõi Nhật ký",
        detail: "Mọi lệnh AI gửi tới MCP đều nằm trong Nhật ký MCP.",
      },
    ],
  },

  mcpSetup: {
    title: "Bước 1 - Tạo MCP riêng cho tác vụ tự động",
    description:
      "Không dùng chung MCP bạn đang chat hằng ngày. Tác vụ tự động chạy khi không có ai ngồi xem, nên chỉ cấp đúng quyền cần thiết.",
    modesLabel: "Hai chế độ",
    modes: {
      report: {
        title: "Chỉ báo cáo",
        badge: "Khuyên dùng khi mới bắt đầu",
        summary:
          "AI kiểm tra và gửi danh sách quảng cáo nên tắt, bạn tự quyết.",
        items: [
          "Quyền: Chỉ xem.",
          "Không cần trần ngân sách vì MCP không có quyền ghi.",
          "Đặt Ngày hết hạn nếu chỉ chạy thử một thời gian.",
        ],
      },
      pause: {
        title: "Tự tắt quảng cáo",
        badge: "Khi đã tin quy tắc",
        summary: "AI tự tạm dừng quảng cáo vượt ngưỡng ngay trong lượt chạy.",
        items: [
          "Quyền: Xem + Bật/Tắt. Không cấp Sửa, Sao chép, Tạo mới, Xoá.",
          'Tắt "Xác nhận 2 bước cho thao tác ghi" - lúc chạy theo lịch không có ai bấm đồng ý. Đây là lý do phải dùng MCP riêng.',
          "Nhập Trần ngân sách/ngày (bắt buộc) ở mức thấp: kể cả khi AI làm sai, nó không bật được quảng cáo có ngân sách vượt trần.",
          'Đặt "Giới hạn thao tác ghi / 10 phút" nhỏ, vd 5.',
          "Chỉ chọn những tài khoản quảng cáo cần kiểm tra.",
        ],
      },
    },
    note: "Quyền Bật/Tắt cho phép cả tạm dừng lẫn bật chạy. Câu lệnh mẫu cấm AI bật bất cứ thứ gì, nhưng giới hạn thật nằm ở trần ngân sách và giới hạn thao tác ghi của MCP.",
  },

  builder: {
    title: "Bước 2 - Soạn quy tắc: tắt quảng cáo khi CPA vượt ngưỡng",
    description:
      "Nhập số liệu của bạn, câu lệnh và skill bên dưới tự cập nhật. Dùng đơn vị chính của tiền tệ tài khoản (vd 200000 VND, 12.5 USD).",
    modeLabel: "Chế độ",
    modes: {
      report: {
        title: "Chỉ báo cáo",
        hint: "Không thay đổi gì trên tài khoản.",
      },
      pause: {
        title: "Tự tắt quảng cáo",
        hint: "Tạm dừng quảng cáo vượt ngưỡng.",
      },
    },
    cpaLabel: "CPA tối đa",
    cpaHelp:
      "Quảng cáo có chi phí / chuyển đổi cao hơn mức này bị coi là vượt ngưỡng.",
    currencyLabel: "Tiền tệ",
    currencyHelp: "Mã 3 chữ cái của tài khoản quảng cáo, vd VND, USD.",
    minSpendLabel: "Chi tiêu tối thiểu trước khi xét",
    minSpendHelp: "Bỏ qua quảng cáo mới chạy, chưa đủ dữ liệu.",
    windowLabel: "Khoảng dữ liệu",
    windowHelp: "Tính theo múi giờ của tài khoản quảng cáo.",
    windows: {
      today: "Hôm nay",
      last_7d: "7 ngày gần nhất",
      last_14d: "14 ngày gần nhất",
      last_30d: "30 ngày gần nhất",
    },
    maxPerRunLabel: "Tắt tối đa mỗi lần chạy",
    maxPerRunHelp: "1-50 quảng cáo. Giữ nhỏ để một lỗi không tắt cả tài khoản.",
    unitAds: "quảng cáo",
    preview: (cpa: string, minSpend: string) =>
      `Quảng cáo đã chi từ ${minSpend} và có CPA trên ${cpa} sẽ bị coi là vượt ngưỡng.`,
    outputsLabel: "Văn bản để sao chép",
    outputs: {
      prompt: {
        tab: "Câu lệnh đầy đủ",
        help: "Dán thẳng vào ô câu lệnh của tác vụ hẹn giờ (hoặc tệp ads-cpa.txt nếu dùng Gemini CLI). Không cần cài skill.",
        label: "Câu lệnh đầy đủ cho tác vụ hẹn giờ",
      },
      skill: {
        tab: "Skill (SKILL.md)",
        help: "Skill giúp AI làm đúng quy tắc mỗi lần chạy mà câu lệnh hẹn giờ vẫn ngắn. Lưu nội dung dưới đây thành tệp SKILL.md trong thư mục tên kiem-tra-cpa-ads. Claude: nén cả thư mục (không phải riêng tệp) thành .zip rồi tải lên ở Customize → Skills. Gemini: tải tệp SKILL.md lên ở Settings → Skills. ChatGPT: chỉ gói Business / Enterprise / Healthcare / Edu có Skills (Plugins → Plugin Directory → Skills).",
        label: "Nội dung tệp SKILL.md",
        shortLabel: "Câu lệnh ngắn gọi skill",
        shortTitle: "Câu lệnh cho tác vụ hẹn giờ (khi đã cài skill)",
      },
    },
  },

  platforms: {
    title: "Bước 3 - Đặt lịch trong ứng dụng AI",
    description:
      "Thêm link MCP vào ứng dụng AI trước (xem tab Kết nối AI của MCP), rồi tạo tác vụ hẹn giờ. Thông tin kiểm tra ngày 07/10/2026 - các ứng dụng AI thay đổi tính năng rất nhanh.",
    tabsLabel: "Ứng dụng AI",
    frequencyLabel: "Tần suất",
    stepsLabel: "Các bước",
    notesLabel: "Lưu ý",
    newTab: "(mở tab mới)",
    codeLabel: "Lệnh / tệp mẫu",
    intervalNote:
      "Tác vụ chạy trên máy chủ của Claude, ChatGPT, Gemini cho tối thiểu 1 giờ/lần. Muốn 30 phút/lần phải chạy trên máy tính luôn bật: tác vụ cục bộ của Claude Desktop (tab Claude) hoặc Gemini CLI (tab Gemini CLI).",
    clients: {
      claude: {
        tab: "Claude",
        title: "Claude - Tác vụ hẹn giờ (Scheduled tasks)",
        frequency: "Mỗi giờ · 30 phút nếu chạy cục bộ",
        plans:
          "Gói Pro, Max, Team, Enterprise. Gói Free thêm được connector nhưng không có tác vụ hẹn giờ. Dùng được cả hai chế độ: Chỉ báo cáo và Tự tắt.",
        steps: [
          'Thêm connector: claude.ai → Customize → Connectors → "+ Add" → "Add custom connector" → đặt tên, dán link MCP → Continue → mục Authentication chọn "No sign in" → Add. Team/Enterprise: Owner thêm ở Organization settings → Connectors.',
          'Đặt quyền tool: trong Customize → Connectors mở connector vừa thêm → Tool permissions. Các tool đọc chọn "Always allow". Chế độ Tự tắt: ads_set_status cũng chọn "Always allow" - lúc chạy theo lịch không có ai bấm duyệt.',
          '(Nên làm) Cài skill: Settings → Capabilities bật "Code execution and file creation", rồi Customize → Skills → "+" → "+ Create skill" → "Upload a skill" → chọn tệp .zip ở Bước 2.',
          'Tạo lịch - giao diện mới (ô nhắn tin không còn nút Chat / Cowork): trong một cuộc trò chuyện, dán câu lệnh ở Bước 2 và thêm "chạy mỗi giờ"; kiểm tra tên, lịch và hướng dẫn Claude đề xuất rồi bấm "Schedule".',
          'Tạo lịch - Cowork (Team/Enterprise, hoặc chưa có giao diện mới): thanh bên trái "Scheduled" → "New task" → "Set up manually" → nhập Task name, câu lệnh, approval mode, tần suất "hourly" → "Save". Hoặc gõ /schedule trong một tác vụ Cowork.',
          'Approval mode: Chỉ báo cáo dùng "Manually approve". Tự tắt: tool đã đặt "Always allow" được duyệt ở mọi chế độ; Cowork còn có "Skip all approvals". Không nên dựa vào "Automatically approve" vì Claude có thể tự chặn thao tác ghi.',
          "Theo dõi lượt chạy đầu tiên trong mục Scheduled và đối chiếu Nhật ký MCP. Nếu Claude vẫn dừng hỏi duyệt mỗi lần tắt quảng cáo, chuyển về chế độ Chỉ báo cáo.",
        ],
        notes: [
          "Tác vụ chạy trên máy chủ của Claude nên vẫn chạy khi máy tính ngủ hoặc app đóng. Mỗi lượt là một phiên riêng trong mục Scheduled; điện thoại nhận thông báo khi xong hoặc khi cần bạn xử lý. Không có email - muốn nhận qua Slack/Gmail, bật connector đó và ghi vào câu lệnh.",
          'Cần 30 phút/lần: Claude Desktop → tab Code → Routines → New routine → Local (chọn một thư mục), rồi nhờ Claude đặt lịch "every 30 minutes". App phải mở và máy phải thức (Settings → This computer → System → Keep computer awake; gập máy vẫn ngủ). Bấm Run now lần đầu và chọn "always allow" cho từng tool.',
          "Tool tắt quảng cáo được MCP đánh dấu là thao tác có tác động; Claude có thể vẫn hỏi duyệt dù đã chọn Always allow - chưa kiểm chứng, hãy chạy thử trước.",
          'Team/Enterprise: admin phải cho phép "Always allow" với tool của connector (mặc định tắt) và bật chạy Cowork trên cloud (Enterprise mặc định tắt).',
          "Anthropic khuyên không giao cho tác vụ hẹn giờ các thao tác khó hoàn tác và luôn xem lại kết quả - bạn chịu trách nhiệm với mọi thao tác. Mỗi lượt tính vào hạn mức của gói (chạy mỗi giờ = 24 lượt/ngày).",
        ],
        code: [],
        links: [
          {
            label: "Tác vụ hẹn giờ",
            url: "https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-cowork",
          },
          {
            label: "Approval mode",
            url: "https://support.claude.com/en/articles/13345190-get-started-with-cowork",
          },
          {
            label: "Thêm custom connector",
            url: "https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp",
          },
          {
            label: "Dùng skill",
            url: "https://support.claude.com/en/articles/12512180-using-skills-in-claude",
          },
          {
            label: "Tác vụ cục bộ (Claude Desktop)",
            url: "https://code.claude.com/docs/en/desktop-scheduled-tasks",
          },
          {
            label: "Lưu ý an toàn",
            url: "https://support.claude.com/en/articles/13364135",
          },
        ],
      },
      chatgpt: {
        tab: "ChatGPT",
        title: "ChatGPT - Tác vụ hẹn giờ (Scheduled) trong Work",
        frequency: "Tối đa mỗi giờ (gói trả phí)",
        plans:
          "MCP tự thêm chỉ dùng trên web. Quyền ghi: trang trợ giúp OpenAI vẫn ghi chỉ Business / Enterprise / Edu (Pro chỉ đọc), còn tài liệu cho nhà phát triển không giới hạn theo gói - hãy thử trên gói của bạn. Chưa rõ với Free / Go / Plus.",
        steps: [
          'Thêm MCP (không còn bước bật Developer mode): chatgpt.com/plugins → nút "+" → "Add custom MCP server" (có thể hiện "Create custom MCP server") → đặt tên, mục Connection dán link MCP vào Server URL → Authentication chọn "No authentication" → "I understand and want to continue" → "Create as a plugin".',
          'Cài plugin: chatgpt.com/plugins?view=personal → mở plugin vừa tạo → bấm "+" để cài.',
          'Ở đầu trang chủ chuyển tab từ "Chat" sang "Work", mở cuộc trò chuyện Work mới, gõ @ và chọn plugin, dán câu lệnh ở Bước 2 kèm "lặp lại việc này mỗi giờ". Tác vụ hiện trong mục "Scheduled".',
          'Nhận kết quả: Settings → Notifications → chọn "Push", "Email" hoặc cả hai.',
          'Chế độ Tự tắt: Settings → Plugins (hoặc Apps) → plugin → Permissions → chọn "Allow all actions" nếu có. Nếu không, mỗi lần tắt quảng cáo tác vụ sẽ dừng chờ bạn duyệt.',
          "Chạy thử và đối chiếu Nhật ký MCP để chắc tác vụ hẹn giờ gọi được MCP.",
        ],
        notes: [
          'OpenAI chưa ghi rõ tác vụ hẹn giờ gọi được MCP tự thêm; tài liệu chỉ nói tác vụ tạo trong Work trên web "can use plugins". Hãy kiểm tra trước khi tin dùng.',
          "Số tác vụ đang bật tối đa: Free/Go 3, Plus 5, Business/Edu 10, Pro/Enterprise 15. Gói Free chỉ chạy tối đa 1 lần/ngày.",
          '"Allow all actions" không có ở cài đặt chung của workspace; thành viên workspace không được chọn "Always allow". Business/Enterprise: admin cấp quyền "Create custom MCP servers" (tên mới của Developer mode).',
          "Tác vụ hẹn giờ không dùng được GPTs (GPTs ngừng hoạt động 11/12/2026). Skills chỉ có ở Business/Enterprise/Healthcare/Edu: Plugins → Plugin Directory → tab Skills → Create → Upload, gọi bằng @.",
          "Tác vụ tự tạm dừng khi lâu không dùng, khi cần bạn xử lý hoặc khi xoá cuộc trò chuyện của nó. Lượt chạy trong Work tính vào hạn mức Work.",
          "Đổi quyền MCP trong app này → vào chatgpt.com/plugins, mở plugin, bấm Refresh để ChatGPT nhận danh sách tool mới.",
        ],
        code: [],
        links: [
          {
            label: "Tác vụ hẹn giờ",
            url: "https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt",
          },
          {
            label: "Thêm custom MCP server",
            url: "https://developers.openai.com/api/docs/guides/custom-mcp-server",
          },
          {
            label: "Quyền của app/plugin",
            url: "https://help.openai.com/articles/20001495",
          },
        ],
      },
      gemini: {
        tab: "Gemini",
        title: "Gemini app - Spark Schedules",
        frequency: "Mỗi giờ",
        plans:
          "Hiện chưa dùng được ở Việt Nam: Custom apps (MCP tự thêm) chỉ mở cho người dùng ở Mỹ, giao diện tiếng Anh, tài khoản cá nhân. Spark cần Google AI Ultra (gói Pro mới có ở Mỹ). Ở Việt Nam, dùng tab Gemini CLI.",
        steps: [
          'Thêm MCP (nếu tài khoản đủ điều kiện): gemini.google.com → Settings → Connected Apps (hoặc Personal Intelligence → Connected Apps) → mục "Custom apps" → Add a custom app → dán link MCP → Next.',
          "(Nên làm) Cài skill: Settings → Skills → Upload → chọn tệp SKILL.md ở Bước 2.",
          'Thanh bên → "Switch to Spark" → Schedules → "Create manually" → đặt tên, chọn chạy hourly, dán câu lệnh (gõ / để chọn skill, @ để chọn app) → "Create".',
          'Mở lịch → More → "Run now" để chạy thử, kiểm tra Nhật ký MCP.',
        ],
        notes: [
          "Gemini luôn bắt người dùng bấm xác nhận thao tác ghi của Custom apps, nên chỉ dùng được chế độ Chỉ báo cáo.",
          "Trang trợ giúp của Google chưa nói Custom apps có nhận link MCP không đăng nhập hay không - chưa kiểm chứng.",
          '"Scheduled actions" trong khung chat thường chuẩn bị nội dung trước tới vài giờ - không hợp để theo dõi quảng cáo.',
          "Giờ chạy của Spark chỉ là ước lượng, có thể trễ khi hệ thống đông. Tối đa 50 lịch đang bật, 15 lượt chạy cùng lúc.",
          "Gems trên tài khoản cá nhân sẽ chuyển thành Skills từ 11/2026 - dùng skill thay cho Gem.",
        ],
        code: [],
        links: [
          {
            label: "Spark Schedules",
            url: "https://support.google.com/gemini/answer/17094507",
          },
          {
            label: "Custom apps (MCP)",
            url: "https://support.google.com/gemini/answer/17209137",
          },
          {
            label: "Skills",
            url: "https://support.google.com/gemini/answer/17094296",
          },
        ],
      },
      geminiCli: {
        tab: "Gemini CLI",
        title: "Gemini CLI + lịch của máy tính (30 phút/lần)",
        frequency: "30 phút hoặc tuỳ ý",
        plans:
          "Chạy trên máy tính của bạn (Windows / macOS / Linux) nên dùng được ở Việt Nam và đặt được 30 phút/lần. Máy phải bật. Hợp với người quen dùng dòng lệnh.",
        steps: [
          "Cài Gemini CLI, chạy gemini một lần để đăng nhập tài khoản Google (hoặc đặt biến môi trường GEMINI_API_KEY lấy từ Google AI Studio).",
          "Thêm MCP bằng lệnh mẫu dưới. Cờ --trust cho tool chạy không cần bấm xác nhận - khi chạy nền, Gemini CLI từ chối mọi tool cần xác nhận. Quyền của MCP (Bước 1) mới là giới hạn thật.",
          "Lưu câu lệnh đầy đủ ở Bước 2 vào tệp ads-cpa.txt trong thư mục người dùng.",
          'Windows: lưu tệp ads-cpa.ps1 (mẫu dưới), mở Task Scheduler → Create Task → Triggers: Daily, "Repeat task every: 30 minutes", "for a duration of: Indefinitely" → Actions: Program "powershell", Arguments "-NoProfile -ExecutionPolicy Bypass -File C:\\Users\\<tên bạn>\\ads-cpa.ps1".',
          "macOS / Linux: thêm dòng cron mẫu dưới bằng crontab -e (thay gemini bằng đường dẫn đầy đủ lấy từ lệnh which gemini).",
          "Chạy tay một lần, mở tệp ads-cpa.log xem kết quả và đối chiếu Nhật ký MCP.",
        ],
        notes: [
          "Lịch Task Scheduler / cron là cách dùng chung của hệ điều hành, không phải hướng dẫn chính thức của Google.",
          "Link MCP nằm dạng chữ thường trong ~/.gemini/settings.json - không dùng máy dùng chung.",
          "Không có thông báo đẩy: kết quả ghi vào ads-cpa.log. Máy ngủ hoặc tắt thì lượt chạy bị bỏ qua.",
          "Hạn mức theo ngày: khoảng 1.000 yêu cầu với tài khoản Google, 250 với API key miễn phí. Mỗi lượt kiểm tra tốn vài yêu cầu (48 lượt/ngày nếu chạy 30 phút/lần).",
          "Không dùng --approval-mode=yolo: chế độ đó duyệt cả lệnh shell và sửa tệp trên máy, không chỉ tool MCP.",
        ],
        code: [
          {
            label: "Thêm MCP (thay <link MCP>)",
            code: "gemini mcp add --transport http --trust -s user adsnoti <link MCP>",
          },
          {
            label: "Windows - tệp ads-cpa.ps1",
            code: '$prompt = Get-Content "$env:USERPROFILE\\ads-cpa.txt" -Raw\ngemini -p $prompt --skip-trust | Out-File -Append -Encoding utf8 "$env:USERPROFILE\\ads-cpa.log"',
          },
          {
            label: "macOS / Linux - dòng cron",
            code: '*/30 * * * * gemini -p "$(cat $HOME/ads-cpa.txt)" --skip-trust >> $HOME/ads-cpa.log 2>&1',
          },
        ],
        links: [
          {
            label: "MCP trong Gemini CLI",
            url: "https://geminicli.com/docs/tools/mcp-server/",
          },
          {
            label: "Chế độ chạy nền (headless)",
            url: "https://geminicli.com/docs/cli/headless/",
          },
        ],
      },
    },
  },

  monitor: {
    title: "Bước 4 - Theo dõi và dừng khẩn cấp",
    description:
      "Kiểm tra vài lượt chạy đầu tiên thật kỹ trước khi để tác vụ tự chạy lâu dài.",
    items: [
      {
        title: "Xem AI đã làm gì",
        detail:
          "Nhật ký MCP ghi từng lệnh: thời gian, tool, quảng cáo bị tác động, trạng thái trước → sau.",
      },
      {
        title: "Dừng ngay khi có sự cố",
        detail:
          "Vào MCP → tab Bảo mật → Tắt MCP. Mọi lượt chạy sau sẽ thất bại cho tới khi bạn bật lại.",
      },
      {
        title: "Xoá hẳn lịch chạy",
        detail:
          "Tắt MCP chỉ chặn tạm thời. Muốn dừng hẳn, xoá tác vụ hẹn giờ trong ứng dụng AI.",
      },
    ],
    openLogs: "Xem thao tác ghi trong Nhật ký",
    openMcp: "Mở danh sách MCP",
  },

  warnings: {
    title: "Trước khi bật tự động",
    items: [
      "Số liệu trong ngày của Meta có độ trễ và chuyển đổi được ghi nhận muộn - CPA buổi sáng thường cao hơn thực tế. Đặt chi tiêu tối thiểu đủ lớn hoặc dùng khoảng 7 ngày.",
      "AI có thể hiểu sai. Chạy chế độ Chỉ báo cáo vài ngày, đối chiếu với Trình quản lý quảng cáo rồi mới chuyển sang Tự tắt.",
      "Ai có link MCP đều dùng được nó. Không dán link vào tác vụ chia sẻ cho người khác.",
    ],
  },
}
