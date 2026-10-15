// Google Drive / Google Sheet - chuỗi tiếng Việt cho service + giao diện (.claude/docs/15-google-drive-media.md).
// Lỗi gọi Google (DriveError) nằm ở `drive.ts`. File này: `service` (thông báo của service/action); các task sau
// thêm `settings`, `sources`, `wizard`, `detail`, `mcp`… ở cuối.
export const driveUi = {
  service: {
    notFound: "Không tìm thấy thư mục / sheet Google Drive.",
    credentialNotFound: "Không tìm thấy service account Google Drive.",
    adminOnly: "Chỉ quản trị viên được thực hiện thao tác này.",
    companyAdminOnly:
      "Chỉ quản trị viên được thêm, sửa hoặc xoá thư mục / sheet của công ty.",
    ownCredentialOnly: "Bạn chỉ dùng được service account của chính mình.",
    notConfigured:
      "Chưa cấu hình Google Drive cho hệ thống - liên hệ quản trị viên.",
    invalidInput: "Dữ liệu không hợp lệ.",
    nameRequired: "Nhập tên hiển thị.",
    nameTooLong: "Tên tối đa 120 ký tự.",
    invalidServiceAccount:
      'File JSON không phải khoá service account Google (cần "type": "service_account", client_email, private_key).',
    serviceAccountRequired: "Dán nội dung file JSON khoá service account.",
    invalidApiKey: "API key Google phải có dạng AIza… (39 ký tự).",
    credentialInUse:
      "Service account đang được dùng bởi thư mục / sheet đã khai báo - xoá hoặc chuyển các nguồn đó trước.",
    kindMismatchFolder: "Link này không phải thư mục Google Drive.",
    kindMismatchSheet: "Link này không phải Google Sheet.",
    sheetGidRequired:
      "Mở đúng tab trong Google Sheet rồi sao chép link (link phải có #gid=…).",
    trashed: "Thư mục / file đang nằm trong thùng rác của Google Drive.",
    recursiveDepthRange: "Số cấp thư mục con từ 0 đến 3.",
    headerRowRange: "Dòng tiêu đề phải từ 1 đến 100.",
    linkColumnRequired: 'Cần chọn cột chứa link Drive (vd. "Link Drive").',
    columnNotInHeader: "Cột không có trong dòng tiêu đề của sheet.",
    writebackNeedsEdit:
      "Email hệ thống chưa có quyền Người chỉnh sửa trên sheet - không bật được ghi trạng thái.",
    writebackNeedsStatusColumn:
      'Cần chọn cột trạng thái (vd. "Trạng thái") để bật ghi trạng thái.',
    sourceUnavailable:
      "Thư mục / sheet đang lỗi hoặc đã tắt - kiểm tra lại ở Kết nối → Google Drive.",
    subfolderOutside: "Thư mục con không nằm trong thư mục đã khai báo.",
    driveSourcesNotUsable:
      "Có thư mục / sheet không dùng được cho MCP này (không tồn tại hoặc không thuộc quyền của chủ MCP).",
    throttled: "Bạn thao tác quá nhanh - thử lại sau ít giây.",
    reauthRequired: "Nhập lại mật khẩu (hoặc mã 2FA) để xác nhận thao tác này.",
    generic: "Có lỗi xảy ra, vui lòng thử lại.",
    googleUnavailable:
      "Không gọi được Google Drive lúc này - thử lại sau ít phút.",
    linkRequired: "Dán link thư mục Google Drive hoặc Google Sheet.",
    nameBadChars: "Không dùng ký tự điều khiển hoặc ký tự đảo chiều văn bản.",
    columnTooLong: "Tên cột tối đa 100 ký tự.",
    columnDuplicate: "Mỗi cột trong sheet chỉ được chọn cho 1 mục.",
    headerEmpty:
      "Dòng tiêu đề đang trống - kiểm tra lại số thứ tự dòng tiêu đề.",
    apiKeyConflict: "Không thể vừa nhập API key mới vừa xoá API key.",
    credentialDisabled: "Service account đang bị tắt.",
    serviceAccountIsSystem:
      'Đây là service account hệ thống - không cần thêm riêng, chọn "Email hệ thống" khi khai báo thư mục / sheet.',
    serviceAccountTaken:
      "Service account này đã được thêm (bởi bạn hoặc người khác).",
    notFolderSource: "Nguồn này không phải thư mục Google Drive.",
    notSheetSource: "Nguồn này không phải Google Sheet.",
    fileNotMedia: "File không phải ảnh hoặc video.",
    claimedBy: (email: string) => `Đã được khai báo bởi ${email}.`,
    /** staff: one message for not found / wrong type / trashed / claimed / inside or containing another person's folder (no oracle) */
    registrationRefused:
      "Không khai báo được link này: không tìm thấy, sai loại, đang trong thùng rác, đã có người khác khai báo hoặc liên quan tới thư mục riêng của người khác. Kiểm tra link và chia sẻ cho email hệ thống; cần dùng chung thì liên hệ quản trị viên.",
    alreadyRegisteredByYou: "Bạn đã khai báo thư mục / sheet này rồi.",
    sheetOtherScope:
      "Google Sheet này đã được khai báo ở phạm vi khác (công ty / riêng) - mọi tab của cùng một sheet phải cùng phạm vi và cùng người khai báo.",
    containsOtherPersonal: (n: number) =>
      `Thư mục này chứa ${n} thư mục riêng của người khác - khai báo nó sẽ khiến các thư mục đó bị dùng chung. Hãy chọn thư mục khác hoặc nhờ chủ sở hữu xoá thư mục riêng trước.`,
    uploadJobStale:
      "Tải video lên bị gián đoạn (hệ thống vừa khởi động lại) - hãy thử lại.",
    uploadJobExpired:
      "Yêu cầu tải video lên chờ quá lâu nên đã bị huỷ - hãy thử lại.",
    done: {
      credentialSaved: "Đã lưu thông tin xác thực Google Drive.",
      credentialDeleted: "Đã xoá thông tin xác thực Google Drive.",
      credentialTested: "Kết nối Google Drive hoạt động bình thường.",
      personalCreated: "Đã thêm service account riêng.",
      personalDeleted: "Đã xoá service account riêng.",
      sourceCreated: "Đã khai báo thư mục / sheet.",
      sourceUpdated: "Đã lưu thay đổi.",
      sourceDeleted: "Đã xoá thư mục / sheet.",
      sourceRechecked: "Thư mục / sheet hoạt động bình thường.",
    },
  },

  // ---------------------------------------------------------------------------------------------------------------
  // Giao diện (task ui-drive): Kết nối → tab "Google Drive", /connections/drive/new, /connections/drive/[id],
  // Cài đặt → thẻ "Google Drive hệ thống".
  // ---------------------------------------------------------------------------------------------------------------
  ui: {
    crumb: "Google Drive",
    tab: "Google Drive",
    kind: { folder: "Thư mục", sheet: "Google Sheet" } as Record<
      string,
      string
    >,
    scope: { company: "Công ty", personal: "Riêng" } as Record<string, string>,
    status: {
      active: "Hoạt động",
      error: "Lỗi",
      disabled: "Đã tắt",
    } as Record<string, string>,
    notConfigured: "Chưa cấu hình",
    systemEmail: "Email hệ thống",
    personalCredential: (name: string) => `Service account riêng · ${name}`,
    keyHint: (hint: string) => `…${hint}`,
  },

  list: {
    add: "Thêm thư mục / sheet",
    colName: "Tên",
    colKind: "Loại",
    colScope: "Phạm vi",
    colOwner: "Người tạo",
    colStatus: "Trạng thái",
    colChecked: "Kiểm tra lần cuối",
    colMcp: "MCP",
    searchPlaceholder: "Tìm theo tên thư mục / sheet…",
    searchLabel: "Tìm thư mục / sheet",
    filterKind: "Loại",
    filterScope: "Phạm vi",
    filterStatus: "Trạng thái",
    tableLabel: "Danh sách thư mục / sheet Google Drive",
    emptyTitle: "Chưa có thư mục / sheet nào",
    emptyDescription:
      "Chia sẻ thư mục ảnh / video hoặc Google Sheet kế hoạch creative cho email hệ thống, rồi khai báo ở đây để AI dùng khi lên quảng cáo.",
    emptyFilteredTitle: "Không có thư mục / sheet phù hợp",
    emptyFilteredDescription: "Thử từ khoá khác hoặc bỏ bớt bộ lọc.",
    never: "Chưa kiểm tra",
    mcpCount: (n: number) => (n > 0 ? `${n} MCP` : "Chưa gán MCP"),
    systemTitle: "Email hệ thống",
    systemHint:
      "Chia sẻ thư mục (quyền Người xem) hoặc Google Sheet (Người chỉnh sửa nếu muốn ghi trạng thái) cho email này, rồi khai báo bên dưới.",
    systemCopyLabel: "Email hệ thống Google Drive",
    /** admin only: whether the system API key exists (AI can read "Anyone with the link" files) */
    publicLinksOn: "Đọc link Drive công khai: đã bật (có API key)",
    publicLinksOff: "Đọc link Drive công khai: chưa bật (chưa có API key)",
    publicLinksOffHint:
      "Quản trị viên cần thêm API key trong Cài đặt → Google Drive hệ thống để AI đọc được link “Bất kỳ ai có link”.",
    systemErrorTitle: "Thông tin xác thực Google Drive đang lỗi",
    systemErrorAdmin:
      "Mở Cài đặt → Google Drive hệ thống, bấm Kiểm tra để xem chi tiết.",
    systemErrorStaff:
      "Báo quản trị viên kiểm tra Cài đặt → Google Drive hệ thống.",
    notConfiguredTitle: "Chưa cấu hình Google Drive",
    notConfiguredAdmin:
      "Dán service account JSON trong Cài đặt → Google Drive hệ thống để mọi người có email chia sẻ thư mục.",
    notConfiguredStaff:
      "Liên hệ quản trị viên để cấu hình Google Drive. Bạn vẫn có thể dùng service account riêng (nâng cao) bên dưới.",
    openSettings: "Mở Cài đặt",
  },

  personal: {
    title: "Service account riêng",
    badge: "Nâng cao",
    description:
      "Chỉ cần khi bạn không muốn chia sẻ thư mục cho email hệ thống. Service account riêng chỉ dùng cho thư mục / sheet của chính chủ.",
    add: "Thêm service account",
    empty: "Chưa có service account riêng nào.",
    listLabel: "Service account riêng",
    test: "Kiểm tra",
    delete: "Xoá",
    actionsLabel: (name: string) => `Thao tác với ${name}`,
    sources: (n: number) =>
      n > 0
        ? `${n} thư mục / sheet đang dùng`
        : "Chưa dùng cho thư mục / sheet nào",
    testFailed: "Service account không hoạt động",
    dialogTitle: "Thêm service account riêng",
    dialogDescription:
      "Dán nội dung file JSON khoá service account của bạn. Khoá được mã hoá và không bao giờ hiển thị lại.",
    nameLabel: "Tên gợi nhớ",
    namePlaceholder: "vd. Drive cá nhân của Lan",
    jsonLabel: "Service account JSON",
    jsonPlaceholder:
      '{ "type": "service_account", "client_email": "…", "private_key": "…" }',
    jsonHelp:
      "Google Cloud → IAM → Service accounts → Keys → Add key → JSON. Bật Google Drive API và Google Sheets API cho project đó.",
    save: "Kiểm tra & thêm",
    saving: "Đang kiểm tra…",
    deleteTitle: "Xoá service account riêng?",
    deleteDescription: (name: string) =>
      `Service account “${name}” sẽ bị xoá khỏi hệ thống. Các thư mục / sheet đang dùng nó phải được xoá trước.`,
    deleteConfirm: "Xoá service account",
  },

  settings: {
    title: "Google Drive hệ thống",
    description:
      "Service account đọc thư mục / Google Sheet được chia sẻ cho nó; API key đọc link Drive công khai. Dùng chung cho cả công ty.",
    notConfigured: "Chưa cấu hình",
    email: "Email service account",
    emailCopyLabel: "Email service account Google Drive",
    project: "Dự án Google Cloud",
    keyId: "Mã khoá",
    apiKey: "API key",
    apiKeyNone: "Chưa có - link công khai tắt",
    lastChecked: "Kiểm tra lần cuối",
    never: "Chưa kiểm tra",
    sources: "Thư mục / sheet đang dùng",
    statusErrorTitle: "Google Drive đang lỗi",
    jsonLabel: "Service account JSON",
    jsonLabelReplace: "Thay service account JSON",
    jsonPlaceholder:
      '{ "type": "service_account", "client_email": "…", "private_key": "…" }',
    jsonHelpNew:
      "Dán toàn bộ nội dung file JSON tải về khi tạo khoá cho service account.",
    jsonHelpKeep:
      "Để trống để giữ khoá hiện tại. Khoá đã lưu không bao giờ hiển thị lại.",
    apiKeyLabel: "API key (link Drive công khai)",
    apiKeyPlaceholder: "AIza…",
    apiKeyHelp:
      "Không bắt buộc. Cần để AI đọc link “Bất kỳ ai có link”. Giới hạn key chỉ cho Google Drive API.",
    apiKeyKeep: (hint: string) =>
      `Đang lưu key …${hint}. Để trống để giữ nguyên.`,
    clearApiKey: "Xoá API key (tắt link Drive công khai)",
    check: "Kiểm tra",
    checking: "Đang kiểm tra…",
    save: "Lưu thông tin xác thực",
    delete: "Xoá",
    testFailed: "Google Drive không hoạt động",
    nothingToSave: "Dán service account JSON hoặc API key mới trước khi lưu.",
    reauthSave: {
      title: "Xác nhận lưu thông tin Google Drive",
      description:
        "Thông tin này cho phép đọc mọi thư mục được chia sẻ cho email hệ thống. Nhập lại mật khẩu để tiếp tục.",
      submit: "Lưu",
    },
    reauthDelete: {
      title: "Xoá thông tin xác thực Google Drive?",
      description:
        "Nhân viên sẽ không khai báo thêm được thư mục / sheet bằng email hệ thống, AI không đọc được link Drive công khai. Nhập lại mật khẩu để xoá.",
      submit: "Xoá",
    },
    deleteInUse: (n: number) =>
      `Đang có ${n} thư mục / sheet dùng thông tin này - xoá các nguồn đó ở Kết nối → Google Drive trước.`,
  },

  wizard: {
    metaTitle: "Thêm thư mục / sheet Google Drive",
    title: "Thêm thư mục / sheet Google Drive",
    description:
      "Khai báo thư mục ảnh / video hoặc Google Sheet kế hoạch creative để AI dùng khi lên quảng cáo.",
    steps: [
      { title: "Loại & phạm vi" },
      { title: "Chia sẻ & kiểm tra" },
      { title: "Cài đặt & lưu" },
    ],
    stepProgress: (i: number, n: number, title: string) =>
      `Bước ${i}/${n} · ${title}`,
    kindTitle: "Bạn muốn khai báo gì?",
    kind: {
      folder: {
        label: "Thư mục Google Drive",
        description:
          "Thư mục chứa ảnh / video creative. AI liệt kê file trong thư mục (và thư mục con) để lên quảng cáo.",
      },
      sheet: {
        label: "Google Sheet",
        description:
          "Bảng kế hoạch creative: mỗi dòng một link file + nền tảng + TKQC. AI đọc các dòng “Chờ lên” và ghi lại trạng thái.",
      },
    } as Record<string, { label: string; description: string }>,
    scopeTitle: "Ai được dùng?",
    scope: {
      company: {
        label: "Công ty",
        description:
          "Mọi nhân viên thấy và gán được cho MCP của mình (chỉ đọc file). Chỉ quản trị viên sửa / xoá.",
      },
      personal: {
        label: "Riêng của tôi",
        description:
          "Chỉ bạn và quản trị viên thấy; chỉ MCP của bạn dùng được.",
      },
    } as Record<string, { label: string; description: string }>,
    scopeStaffNote:
      "Bạn khai báo thư mục / sheet riêng. Thư mục / sheet dùng chung của công ty do quản trị viên khai báo.",
    credentialTitle: "Chia sẻ cho email nào?",
    credentialSystem: "Email hệ thống (khuyên dùng)",
    credentialSystemHint:
      "Không cần tạo gì thêm - chỉ chia sẻ thư mục cho email này.",
    credentialOwn: "Service account riêng",
    credentialOwnHint: "Dùng khoá service account của chính bạn (nâng cao).",
    credentialCompanyNote:
      "Thư mục / sheet công ty luôn được đọc bằng email hệ thống.",
    credentialPick: "Chọn service account",
    noOwnCredentials: "Bạn chưa có service account riêng.",
    addOwn: "Thêm service account",
    systemMissing:
      "Hệ thống chưa cấu hình Google Drive - chọn service account riêng hoặc liên hệ quản trị viên.",
    systemMissingAdmin:
      "Hệ thống chưa cấu hình Google Drive - vào Cài đặt → Google Drive hệ thống để dán service account JSON.",
    shareTitle: "Chia sẻ rồi dán link",
    shareSteps: {
      folder: [
        "Mở thư mục trên Google Drive → Chia sẻ.",
        "Thêm email ở trên với quyền Người xem → Gửi.",
        "Sao chép link thư mục rồi dán vào ô bên dưới.",
      ],
      sheet: [
        "Mở Google Sheet → Chia sẻ.",
        "Thêm email ở trên: Người chỉnh sửa nếu muốn AI ghi trạng thái, không thì Người xem.",
        "Mở đúng tab chứa danh sách creative, sao chép link (có #gid=…) rồi dán vào ô bên dưới.",
      ],
    } as Record<string, readonly string[]>,
    emailCopyLabel: "Email để chia sẻ",
    linkLabel: {
      folder: "Link thư mục",
      sheet: "Link Google Sheet (đúng tab)",
    } as Record<string, string>,
    linkPlaceholder: {
      folder: "https://drive.google.com/drive/folders/…",
      sheet: "https://docs.google.com/spreadsheets/d/…/edit#gid=0",
    } as Record<string, string>,
    linkHelp: {
      folder: "Link có dạng drive.google.com/drive/folders/<mã thư mục>.",
      sheet:
        "Link có dạng docs.google.com/spreadsheets/d/<mã>/edit#gid=<mã tab> - mở đúng tab rồi sao chép link trên thanh địa chỉ. Đổi tên tab sau này vẫn dùng được.",
    } as Record<string, string>,
    headerRowLabel: "Dòng tiêu đề",
    headerRowHelp: "Dòng chứa tên cột, thường là 1.",
    check: "Kiểm tra",
    checking: "Đang kiểm tra…",
    checkOkTitle: "Đã đọc được",
    checkFailTitle: "Chưa đọc được thư mục / sheet",
    announceOk: (name: string) => `Đã đọc được ${name}.`,
    outdated: "Bạn đã sửa thông tin sau lần kiểm tra - bấm Kiểm tra lại.",
    needCheck: "Bấm Kiểm tra để hệ thống đọc thử trước khi tiếp tục.",
    previewName: "Tên trên Google Drive",
    previewFolderCounts: (
      images: number,
      videos: number,
      folders: number,
      more: boolean
    ) =>
      `${images}${more ? "+" : ""} ảnh · ${videos}${more ? "+" : ""} video · ${folders} thư mục con`,
    previewContent: "Nội dung (cấp đầu)",
    previewSharedDrive: "Bộ nhớ dùng chung (Shared drive)",
    previewTab: "Tab",
    previewRows: (n: number) => `${n} dòng`,
    previewHeader: "Dòng tiêu đề",
    previewHeaderEmpty: "(trống)",
    previewPermission: "Quyền của email",
    previewCanEdit: "Người chỉnh sửa - ghi trạng thái được",
    previewViewOnly: "Người xem - chỉ đọc",
    previewEmptyFolder:
      "Thư mục chưa có ảnh / video nào ở cấp đầu - vẫn khai báo được, AI sẽ thấy file khi bạn thêm vào.",
    settingsTitle: "Cài đặt",
    nameLabel: "Tên hiển thị",
    nameHelp: "Để trống để dùng tên trên Google Drive.",
    depthLabel: "Thư mục con AI được duyệt",
    depthOptions: ["Chỉ thư mục này", "1 cấp con", "2 cấp con", "3 cấp con"],
    depthHelp:
      "Khi AI liệt kê file có kèm thư mục con. Nhiều cấp thì chậm hơn.",
    columnsTitle: "Ánh xạ cột",
    columnsDescription:
      "Chọn cột trong sheet cho từng mục. Hệ thống đã gợi ý theo tên cột - sửa nếu sheet đặt tên khác.",
    columnsReadGroup: "Cột AI đọc",
    columnsWriteGroup: "Cột hệ thống ghi (khi bật ghi trạng thái)",
    /** collapsible with the system-written columns (opened while write-back is on) */
    columnsAdvanced: "Cột ghi trạng thái (nâng cao)",
    columnsAdvancedHint:
      "Khi bật ghi trạng thái, hệ thống chỉ ghi vào các cột này (dạng chữ, không chạy công thức). Cột Trạng thái là bắt buộc, các cột khác tuỳ chọn.",
    columns: {
      link: "Link Drive",
      cover: "Ảnh bìa",
      name: "Tên creative",
      platform: "Nền tảng",
      account: "Tài khoản QC",
      content: "Nội dung",
      headline: "Tiêu đề",
      destination: "Link đích",
      status: "Trạng thái",
      mediaId: "Mã media",
      adIds: "Mã quảng cáo",
      postLink: "Link bài viết",
      campaignLink: "Link chiến dịch",
      note: "Ghi chú hệ thống",
      updatedAt: "Cập nhật lúc",
    } as Record<string, string>,
    /** short help under some column pickers (tuỳ chọn) */
    columnHelp: {
      cover:
        "Tuỳ chọn. Link Drive của ảnh bìa cho video ở dòng đó (AI chỉ đọc). Chọn Không dùng mà sheet có cột tên “Ảnh bìa” thì AI vẫn tự nhận ra.",
      mediaId:
        "Tuỳ chọn. AI ghi mã ảnh / video trên nền tảng sau khi tải lên.",
      adIds: "Tuỳ chọn. AI ghi mã các quảng cáo đã tạo từ dòng này.",
      postLink:
        "Tuỳ chọn. AI ghi link bài viết / bài quảng cáo sau khi tạo quảng cáo từ dòng này.",
      campaignLink:
        "Tuỳ chọn. AI ghi link chiến dịch trong trình quản lý quảng cáo để mở nhanh.",
      note: "Tuỳ chọn. AI ghi lý do lỗi và cách sửa, hoặc ghi chú ngắn.",
      updatedAt:
        "Tuỳ chọn. AI ghi giờ Việt Nam + tên MCP mỗi lần cập nhật dòng.",
    } as Record<string, string>,
    required: "Bắt buộc",
    notUsed: "Không dùng",
    columnPlaceholder: "Tên cột trong sheet",
    columnSelectLabel: (label: string) => `Cột cho “${label}”`,
    writebackLabel: "Cho phép AI ghi trạng thái vào sheet",
    writebackHelp:
      "Sau khi lên quảng cáo, AI ghi trạng thái, mã quảng cáo vào đúng dòng - chỉ ghi vào các cột ghi trạng thái bên dưới, không sửa cột khác.",
    writebackNeedsEdit:
      "Email đang chỉ có quyền Người xem trên sheet. Cấp quyền Người chỉnh sửa rồi bấm Kiểm tra lại để bật.",
    writebackNeedsStatus: "Chọn cột Trạng thái để bật ghi trạng thái.",
    templateHint:
      "Mẫu cột gợi ý: Link Drive · Ảnh bìa · Tên creative · Nền tảng · Tài khoản QC · Nội dung · Tiêu đề · Link đích · Trạng thái · Mã media · Mã quảng cáo · Link bài viết · Link chiến dịch · Ghi chú hệ thống · Cập nhật lúc.",
    back: "Quay lại",
    next: "Tiếp tục",
    save: "Lưu thư mục / sheet",
    saving: "Đang lưu…",
  },

  detail: {
    metaTitle: "Thư mục / sheet Google Drive",
    recheck: "Kiểm tra lại",
    rechecking: "Đang kiểm tra…",
    recheckFailed: "Chưa đọc được thư mục / sheet",
    edit: "Sửa cài đặt",
    delete: "Xoá",
    openInDrive: "Mở trên Google Drive",
    errorTitle: "Không đọc được thư mục / sheet",
    disabledTitle: "Thư mục / sheet đang tắt",
    disabledHint:
      "MCP không dùng được nguồn này cho tới khi kiểm tra lại thành công.",
    readOnlyNote:
      "Thư mục / sheet của công ty - bạn được xem và gán cho MCP của mình; chỉ quản trị viên sửa hoặc xoá.",
    createdTitle: "Đã khai báo",
    createdHint:
      "Gán thư mục / sheet này cho MCP (khối Google Drive ở bước Nền tảng) để AI dùng được.",
    infoTitle: "Thông tin",
    kind: "Loại",
    scope: "Phạm vi",
    credential: "Đọc bằng",
    owner: "Người tạo",
    googleName: "Tên trên Google Drive",
    googleId: "Mã trên Google",
    sharedDrive: "Bộ nhớ dùng chung (Shared drive)",
    depth: "Thư mục con AI được duyệt",
    headerRow: "Dòng tiêu đề",
    writeback: "Ghi trạng thái",
    writebackOn: "Đang bật",
    writebackOff: "Tắt",
    lastChecked: "Kiểm tra lần cuối",
    never: "Chưa kiểm tra",
    createdAt: "Ngày khai báo",
    columnsTitle: "Ánh xạ cột",
    columnsRead: "AI đọc",
    columnsWrite: "AI ghi",
    /** next to "AI ghi" when write-back is off (the chips are dimmed) */
    columnsWriteOff: "(đang tắt)",
    /** link columns not mapped yet (sheets declared before v1.0.8) */
    columnsUnused: (labels: string) => `Chưa dùng: ${labels}`,
    /** cover column not mapped but found by its header name (drive_sheet_read reads it anyway) */
    coverAuto: (label: string, name: string) =>
      `${name === label ? name : `${label}: ${name}`} (tự nhận)`,
    coverAutoTitle: "Tự nhận theo tên cột - AI đọc cột này làm ảnh bìa video",
    coverMissing:
      "Chưa có cột Ảnh bìa (tuỳ chọn) - thêm cột “Ảnh bìa” vào sheet nếu muốn mỗi video có ảnh bìa riêng.",
    usedByTitle: "Đang dùng trong MCP",
    usedByNone: "Chưa có MCP nào dùng thư mục / sheet này.",
    usedByOther: (n: number) => `+ ${n} MCP của người khác`,
    filesTitle: "File trong thư mục",
    filesDescription:
      "Ảnh / video AI thấy được (chỉ đọc) và TKQC đã dùng từng file.",
    filterLabel: "Lọc loại file",
    filterAll: "Tất cả",
    filterImage: "Ảnh",
    filterVideo: "Video",
    breadcrumbLabel: "Đường dẫn thư mục",
    loadMore: "Tải thêm",
    loadingMore: "Đang tải…",
    filesEmpty: "Thư mục này chưa có ảnh / video nào.",
    filesEmptyFiltered: "Không có file phù hợp với bộ lọc.",
    skipped: (n: number) => `${n} file khác (tài liệu, PDF…) được bỏ qua.`,
    filesErrorTitle: "Không tải được danh sách file",
    retry: "Thử lại",
    /** live listing failed: the header badge still shows the last saved check */
    staleStatus: "Trạng thái ở đầu trang là kết quả của lần kiểm tra trước",
    staleStatusNever: "Nguồn này chưa được kiểm tra lần nào.",
    staleStatusManage:
      "Bấm Kiểm tra lại để đọc lại nguồn và cập nhật trạng thái.",
    staleStatusView:
      "Bấm Tải lại để thử lại; nếu vẫn lỗi, báo người khai báo nguồn này.",
    reload: "Tải lại",
    reloading: "Đang tải…",
    usedIn: (n: number) => `Đã dùng ở ${n} TKQC`,
    usedInShort: (n: number) => `${n} TKQC`,
    notUsed: "Chưa dùng",
    openFolder: (name: string) => `Mở thư mục ${name}`,
    sheetTitle: "Xem trước sheet",
    sheetDescription:
      "20 dòng đầu theo ánh xạ cột (chỉ đọc) và thống kê trạng thái.",
    statusCountsLabel: "Thống kê trạng thái",
    emptyStatus: "Chưa có trạng thái",
    /** values written by the system (SHEET_STATUS in src/server/drive/types.ts) → chip colour */
    sheetStatusTone: {
      "chờ lên": "warning",
      "đang xử lý": "info",
      "đã lên": "success",
      lỗi: "danger",
    } as Record<string, "warning" | "info" | "success" | "danger">,
    rowsRead: (n: number, more: boolean) =>
      more
        ? `Đã đọc ${n} dòng đầu - sheet còn nhiều dòng hơn.`
        : `Tổng ${n} dòng.`,
    sheetEmpty: "Sheet chưa có dòng dữ liệu nào dưới dòng tiêu đề.",
    sheetErrorTitle: "Không đọc được sheet",
    missingColumns: (cols: string) =>
      `Không tìm thấy cột trong dòng tiêu đề: ${cols}. Sửa ánh xạ cột hoặc tên cột trong sheet.`,
    colRow: "Dòng",
    sheetTableLabel: "Các dòng đầu của sheet",
    editTitle: "Sửa cài đặt",
    editDescription: "Đổi tên hiển thị và cách AI dùng thư mục / sheet này.",
    editSave: "Lưu thay đổi",
    editSaving: "Đang lưu…",
    editHeaderUnknown:
      "Chưa đọc được dòng tiêu đề của sheet - nhập đúng tên cột như trong sheet.",
    remove: {
      title: "Xoá thư mục / sheet?",
      description: (name: string) =>
        `“${name}” sẽ bị gỡ khỏi mọi MCP đang dùng. File trên Google Drive không bị ảnh hưởng.`,
      confirm: "Xoá thư mục / sheet",
      affected: "MCP sẽ mất quyền dùng nguồn này:",
    },
  },

  guides: {
    list: {
      title: "Về Google Drive",
      summary:
        "Khai báo thư mục ảnh / video và Google Sheet kế hoạch creative để AI lấy file lên quảng cáo - không cần tải file lên máy chủ.",
      steps: [
        {
          title: "Chia sẻ cho email hệ thống",
          detail:
            "Sao chép email hệ thống ở đầu tab, mở thư mục / sheet trên Google Drive → Chia sẻ → thêm email (Người xem; sheet cần Người chỉnh sửa nếu muốn ghi trạng thái).",
        },
        {
          title: "Khai báo thư mục / sheet",
          detail:
            "Bấm Thêm thư mục / sheet, dán link rồi Kiểm tra. Thư mục công ty: mọi nhân viên dùng; thư mục riêng: chỉ chủ và quản trị viên.",
        },
        {
          title: "Gán cho MCP",
          detail:
            "Trong MCP, khối Google Drive: chọn thư mục / sheet. AI liệt kê file, đọc sheet, tải ảnh / video lên TKQC và ghi trạng thái.",
        },
      ],
      tips: [
        "Mỗi thư mục chỉ khai báo được một lần - người khai báo đầu tiên là chủ.",
        "Link Drive công khai (“Bất kỳ ai có link”) dùng được mà không cần khai báo nếu quản trị viên đã thêm API key.",
      ],
    },
    new: {
      title: "Khai báo thư mục / sheet",
      summary:
        "Hệ thống đọc thư mục / sheet bằng email hệ thống (service account). Bạn chỉ cần chia sẻ cho email đó - không cần đăng nhập Google.",
      steps: [
        {
          title: "Chọn loại và phạm vi",
          detail:
            "Thư mục: ảnh / video creative. Google Sheet: danh sách creative theo dòng (link, nền tảng, TKQC, trạng thái).",
        },
        {
          title: "Chia sẻ và dán link",
          detail:
            "Thư mục: quyền Người xem. Sheet: Người chỉnh sửa nếu muốn AI ghi trạng thái. Link sheet phải là link của đúng tab (#gid=).",
        },
        {
          title: "Kiểm tra và lưu",
          detail:
            "Hệ thống đọc thử: tên thật, số ảnh / video, dòng tiêu đề. Với sheet, chọn cột tương ứng rồi lưu.",
        },
      ],
      tips: [
        "Thư mục con của thư mục đã khai báo không cần khai báo lại - chọn số cấp thư mục con ở bước 3.",
        "Thư mục đã được người khác khai báo sẽ không khai báo lại được - liên hệ quản trị viên.",
      ],
      warnings: [
        "Không chia sẻ thư mục chứa dữ liệu nhạy cảm cho email hệ thống - mọi file trong đó AI đều đọc được qua MCP được cấp.",
      ],
    },
    /** wizard /connections/drive/new: one guide per step (like connectionNew) */
    newSteps: [
      {
        title: "Bước 1 · Loại & phạm vi",
        summary:
          "Chọn bạn khai báo thư mục ảnh / video hay Google Sheet kế hoạch creative, và ai được dùng nó.",
        steps: [
          {
            title: "Thư mục Google Drive",
            detail:
              "Chứa ảnh (JPG, PNG, GIF, WebP) và video (MP4, MOV). AI liệt kê file trong thư mục (và thư mục con nếu bạn cho phép) rồi tải lên TKQC khi lên quảng cáo.",
          },
          {
            title: "Google Sheet",
            detail:
              "Bảng kế hoạch: mỗi dòng một creative (link Drive, nền tảng, TKQC, nội dung…). AI đọc các dòng chờ lên và có thể ghi lại trạng thái, mã quảng cáo.",
          },
          {
            title: "Phạm vi",
            detail:
              "Công ty (chỉ quản trị viên khai báo): mọi nhân viên gán được cho MCP của mình.\nRiêng của tôi: chỉ bạn và quản trị viên thấy; chỉ MCP của bạn dùng được.",
          },
        ],
        tips: [
          "Một thư mục có nhiều thư mục con không cần khai báo từng thư mục - chọn số cấp thư mục con ở bước 3.",
        ],
      },
      {
        title: "Bước 2 · Chia sẻ & kiểm tra",
        summary:
          "Hệ thống đọc Google Drive bằng một email service account. Bạn chỉ cần chia sẻ thư mục / sheet cho email đó - không cần đăng nhập Google.",
        steps: [
          {
            title: "Sao chép email",
            detail:
              "Bấm Sao chép ở ô email (thường là email hệ thống, dạng …@….iam.gserviceaccount.com).",
          },
          {
            title: "Chia sẻ trên Google Drive",
            detail:
              "Mở thư mục / sheet → Chia sẻ → dán email.\nThư mục: quyền Người xem là đủ.\nSheet: Người chỉnh sửa nếu muốn AI ghi trạng thái vào sheet, không thì Người xem.\nBỏ tick “Thông báo cho mọi người” cũng được.",
          },
          {
            title: "Dán link rồi bấm Kiểm tra",
            detail:
              "Thư mục: link dạng drive.google.com/drive/folders/<mã>.\nSheet: mở đúng tab chứa danh sách creative rồi sao chép link trên thanh địa chỉ - link phải có #gid=<mã tab>.",
          },
        ],
        warnings: [
          "Lỗi “Chưa có quyền” / “Không tìm thấy”: chưa chia sẻ cho đúng email, hoặc thư mục nằm trong Shared drive mà email chưa được thêm.",
          "Lỗi “Link phải có #gid”: bạn đã sao chép link của cả file - mở đúng tab rồi sao chép lại.",
          "Lỗi “Chưa bật Google Drive API / Sheets API” hoặc “Service account không hợp lệ”: báo quản trị viên kiểm tra Cài đặt → Google Drive hệ thống.",
          "Lỗi “Đã được khai báo”: thư mục / sheet đã có người khai báo - liên hệ quản trị viên nếu cần dùng chung.",
        ],
      },
      {
        title: "Bước 3 · Cài đặt & lưu",
        summary:
          "Đặt tên dễ nhận ra và cho biết AI dùng thư mục / sheet thế nào.",
        steps: [
          {
            title: "Tên hiển thị",
            detail:
              "Để trống sẽ dùng tên trên Google Drive. Tên này hiện trong danh sách và khi chọn nguồn cho MCP.",
          },
          {
            title: "Thư mục: số cấp thư mục con",
            detail:
              "Chỉ thư mục này, hoặc 1–3 cấp thư mục con. Nhiều cấp thì AI liệt kê chậm hơn.",
          },
          {
            title: "Sheet: ánh xạ cột",
            detail:
              "Hệ thống gợi ý theo tên cột trong dòng tiêu đề. Bắt buộc: cột Link Drive. Nên có: Tên creative, Nền tảng, TKQC, Nội dung, Tiêu đề, Link đích. Tuỳ chọn: Ảnh bìa (ảnh bìa riêng cho video của từng dòng).",
          },
          {
            title: "Sheet: ghi trạng thái",
            detail:
              "Bật khi email có quyền Người chỉnh sửa. Mở “Cột ghi trạng thái (nâng cao)” để chọn cột Trạng thái (bắt buộc), Mã media, Mã quảng cáo, Ghi chú hệ thống, Cập nhật lúc. AI không bao giờ sửa cột khác.",
          },
        ],
        tips: [
          "Lưu xong, gán thư mục / sheet cho MCP ở khối Google Drive (bước Nền tảng của MCP) để AI dùng được.",
        ],
      },
    ],
    detail: {
      title: "Thư mục / sheet Google Drive",
      summary:
        "Xem file AI thấy được, trạng thái đọc gần nhất và các MCP đang dùng nguồn này.",
      steps: [
        {
          title: "Kiểm tra lại khi có lỗi",
          detail:
            "Lỗi thường do bỏ chia sẻ, đổi quyền hoặc xoá thư mục. Chia sẻ lại cho email rồi bấm Kiểm tra lại.",
        },
        {
          title: "Đã dùng ở TKQC",
          detail:
            "File đã tải lên một TKQC được dùng lại mã media, không tải lại (trừ khi file thay đổi trên Drive).",
        },
      ],
      tips: [
        "Ảnh thu nhỏ lấy trực tiếp từ Google Drive; chỉ người có quyền xem nguồn này mới thấy.",
      ],
    },
  },
} as const
