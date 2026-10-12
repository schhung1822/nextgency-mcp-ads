// Shared Vietnamese strings for TikTok GMV Max (single source of truth).
// Used by the GMV Max read tools (gmv-max.ts / extensions.ts), the write guards (mutate.ts, copy.ts,
// set-status confirmation) and the connection UI / guide. Plain data only: no imports, safe for both
// server and client bundles. Paraphrases TikTok's official GMV Max guidance (see
// .claude/docs/providers/tiktok.md §8). Strings are data for the AI, never instructions to act.
// Never interpolate platform text (names, upstream error messages) into these sentences - ids / codes only.

/** D4 — short caution attached to every GMV Max tool result. */
export const GMV_MAX_CAUTION =
  "GMV Max tự tối ưu theo ngày. Dùng AI để XEM và PHÂN TÍCH chỉ số; hạn chế bật/tắt hay chỉnh sửa " +
  "(AI chỉ thay đổi được GMV Max khi quản trị viên đã bật quyền GMV Max cho MCP). " +
  "TikTok khuyên giữ mỗi mức ROI mục tiêu ít nhất 3 ngày trọn vẹn (LIVE: tối đa 1 lần/ngày); " +
  "tạm dừng, xoá, sửa ROI hoặc sản phẩm trong ngày làm mất Bảo vệ ROI của ngày đó."

/**
 * C3 — any write on a GMV Max campaign (status, budget, edit, products, videos, copy, delete) when the MCP setting
 * tiktok_gmv_max_write is off (only an admin can turn it on).
 */
export function gmvMaxLockedMessage(id: string): string {
  return (
    `MCP này chưa được quản trị viên cho phép thay đổi chiến dịch GMV Max (${id}) - AI chỉ xem được chỉ số. ` +
    "Muốn bật/tắt, đổi ngân sách / ROI mục tiêu / sản phẩm / video, sao chép hoặc xoá: nhờ quản trị viên bật quyền GMV Max cho MCP, hoặc làm trong TikTok Ads Manager / Seller Center."
  )
}

/** Hint of the locked refusal. */
export const GMV_MAX_LOCKED_HINT =
  'Quản trị viên mở MCP → Cấu hình → bước "Chọn quyền" → khối TikTok → bật "Cho phép AI thay đổi GMV Max (TikTok Shop)" (MCP cần thêm quyền tương ứng: Bật/Tắt, Sửa, Sao chép, Tạo mới, Xoá).'

/** Generic "new ad group under a GMV Max campaign" refusal: GMV Max has no ad groups / ads in the API. */
export function gmvMaxNoAdGroupsMessage(id: string): string {
  return (
    `Chiến dịch ${id} là GMV Max: không có nhóm quảng cáo / quảng cáo để thêm. ` +
    "Sản phẩm của chiến dịch đổi bằng tiktok_gmv_max_update (item_group_ids), video bằng tiktok_gmv_max_creatives - " +
    "chỉ khi quản trị viên đã bật quyền GMV Max cho MCP."
  )
}

/** D3 fail-closed — the GMV Max check itself failed for a candidate campaign (refused operations). */
export function gmvMaxUnverifiedMessage(id: string): string {
  return (
    `Không xác minh được chiến dịch ${id} có phải GMV Max hay không (TikTok không trả lời yêu cầu kiểm tra). ` +
    "Để an toàn, thao tác này bị chặn - hãy thử lại sau, hoặc làm trong TikTok Ads Manager."
  )
}

/** D3 fail-closed — the GMV Max check was refused (40001/40125): the token cannot read GMV Max campaigns. */
export function gmvMaxPermissionUnverifiedMessage(id: string): string {
  return (
    `Token chưa có quyền đọc chiến dịch GMV Max nên không xác minh được chiến dịch ${id} có phải GMV Max hay không. ` +
    "Để an toàn, thao tác này bị chặn - cấp thêm quyền cho developer app (xem gợi ý), hoặc làm trong TikTok Ads Manager."
  )
}

/** D3 — warning when pausing / disabling a GMV Max campaign (set_status). */
export const GMV_MAX_PAUSE_WARNING =
  "Chiến dịch GMV Max: tạm dừng làm mất Bảo vệ ROI (tín dụng quảng cáo) của hôm nay, dừng giữa chừng cũng làm gián đoạn quá trình tối ưu theo ngày; " +
  "chỉ tạm dừng khi thật cần."

/** D3 — warning when enabling a GMV Max campaign (set_status). */
export const GMV_MAX_ENABLE_WARNING =
  "Chiến dịch GMV Max: bật lên có thể tự tạm dừng quảng cáo Shop khác (VSA/PSA/LIVE Shopping) dùng cùng cửa hàng/sản phẩm/" +
  "tài khoản TikTok ở MỌI tài khoản QC; TikTok không tự bật lại các quảng cáo đó."

/** Per-id variants used in set_status previews / results. */
export function gmvMaxPauseWarning(id: string): string {
  return `${id}: ${GMV_MAX_PAUSE_WARNING}`
}
export function gmvMaxEnableWarning(id: string): string {
  return `${id}: ${GMV_MAX_ENABLE_WARNING}`
}

/** Activation guardrail: the worst-case daily spend of a GMV Max campaign could not be read. */
export function gmvMaxBudgetUnverifiedMessage(id: string): string {
  return (
    `Không đọc được ngân sách của chiến dịch GMV Max ${id} (/campaign/gmv_max/info/) nên chưa tính được mức chi tối đa có thể mỗi ngày ` +
    "(gồm tăng ngân sách tự động / ngày khuyến mãi)."
  )
}

/** Activation of a GMV Max campaign: worst-case daily spend notes (preview / guardrail). */
export const GMV_MAX_SESSIONS_NOT_INCLUDED =
  "Chưa gồm ngân sách riêng của phiên Max delivery / Creative boost (nếu có) - các phiên này chi thêm ngoài mức trên."
export const GMV_MAX_LEGACY_AUTO_BUDGET_NOTE =
  "Đang bật tăng ngân sách tự động kiểu cũ (auto_budget_enabled): ngân sách ngày có thể tăng tới 10 lần - tính theo mức tối đa này."
export const GMV_MAX_BOOST_FALLBACK_NOTE =
  "Tăng ngân sách tự động / ngày khuyến mãi đang bật nhưng TikTok không trả mức tối đa - tính theo mức tối đa TikTok công bố (31 lần ngân sách ngày)."

/** D5 — ads_get_report / ads_list_objects on a TikTok account that has GMV Max campaigns. */
export const GMV_MAX_NOT_IN_REPORT_WARNING =
  "Tài khoản có chiến dịch GMV Max: chi tiêu/doanh thu GMV Max có thể không nằm (đầy đủ) trong báo cáo này " +
  "(TikTok loại GMV Max tạo từ TikTok Shop khỏi báo cáo thường; GMV Max tạo nơi khác chưa được xác minh) - xem bằng tiktok_gmv_max_report; " +
  "không cộng hai báo cáo vì có thể bị trùng hoặc sai."

/** D5 — ads_list_objects (TikTok campaigns) when GMV Max campaigns were found (tagged extra.gmv_max). */
export const GMV_MAX_LIST_NOTE =
  "Chiến dịch có extra.gmv_max là GMV Max (TikTok Shop): xem bằng tiktok_gmv_max_campaigns / tiktok_gmv_max_report; " +
  "AI chỉ thay đổi được khi quản trị viên đã bật quyền GMV Max cho MCP; " +
  "chi tiêu/doanh thu GMV Max có thể không nằm (đầy đủ) trong ads_get_report - không cộng hai báo cáo vì có thể bị trùng hoặc sai."

/** Hint appended to "campaign not found" errors on TikTok (GMV Max campaigns may be absent from /campaign/get/). */
export const GMV_MAX_NOT_FOUND_HINT =
  "Nếu đây là chiến dịch GMV Max, dùng tiktok_gmv_max_campaigns để xem."

/** Common tail of the GMV Max permission hints (40001/40125). */
const SCOPE_TAIL =
  "cho developer app (TikTok duyệt lại 2-3 ngày làm việc), rồi cho advertiser cấp quyền lại và đổi auth_code mới; " +
  'đồng thời kiểm tra tài khoản QC là "GMV Max account" của cửa hàng (Business Center hoặc Seller Center).'

/** Generic hint for TikTok 40001/40125 on GMV Max endpoints (gmv_max/*, campaign/gmv_max/*). */
export const GMV_MAX_SCOPE_HINT =
  "Bật thêm quyền Ads Management > Campaign > Read Campaigns, Ads Management > GMV MAX (Store Management) và Reporting > GMV MAX Report " +
  SCOPE_TAIL

/**
 * Path-specific permission hint (official "Scope of permission" column, research §1):
 * /gmv_max/campaign/get/ + /campaign/gmv_max/info/ → Ads Management > Campaign > Read Campaigns;
 * /gmv_max/store/list/ → Ads Management > GMV MAX > Store Management; /gmv_max/report/get/ → Reporting > GMV MAX Report.
 */
export function gmvMaxScopeHint(path: string): string {
  const p = `/${path.replace(/^\/+|\/+$/g, "")}/`
  if (
    p === "/gmv_max/campaign/get/" ||
    p === "/campaign/gmv_max/info/" ||
    p === "/gmv_max/bid/recommend/"
  ) {
    return `Bật thêm quyền Ads Management > Campaign > Read Campaigns ${SCOPE_TAIL}`
  }
  if (p === "/campaign/gmv_max/create/" || p === "/campaign/gmv_max/update/") {
    return `Bật thêm quyền Ads Management > Campaign > Create and Update Campaigns ${SCOPE_TAIL}`
  }
  if (
    p === "/gmv_max/store/list/" ||
    p === "/gmv_max/store/shop_ad_usage_check/" ||
    p === "/gmv_max/occupied_custom_shop_ads/list/"
  ) {
    return `Bật thêm quyền Ads Management > GMV MAX > Store Management ${SCOPE_TAIL}`
  }
  if (
    p === "/gmv_max/identity/get/" ||
    p === "/gmv_max/video/get/" ||
    p === "/campaign/gmv_max/creative/update/"
  ) {
    return `Bật thêm quyền Ads Management > GMV MAX > Identity And Video ${SCOPE_TAIL}`
  }
  if (p === "/store/product/get/") {
    return `Bật thêm quyền Onsite Commerce Store (cửa hàng TikTok Shop) ${SCOPE_TAIL}`
  }
  if (p === "/gmv_max/report/get/")
    return `Bật thêm quyền Reporting > GMV MAX Report ${SCOPE_TAIL}`
  return GMV_MAX_SCOPE_HINT
}

/** Notes always attached to tiktok_gmv_max_report results. */
export const GMV_MAX_REPORT_NOTES: readonly string[] = [
  "ROI và số đơn của GMV Max GỒM CẢ đơn tự nhiên (organic) - không so sánh trực tiếp với ROAS của ads_get_report.",
  "Một số chỉ số GMV Max có thể trễ tới khoảng 11 giờ.",
  "Dữ liệu GMV Max chỉ có từ 2024-09-27.",
  "Không cộng chi phí GMV Max với chi phí của ads_get_report: GMV Max có thể không nằm (đầy đủ) trong báo cáo thường, cộng lại có thể bị trùng hoặc sai.",
]

/** Account level of tiktok_gmv_max_report: TikTok counts undeleted campaigns only and offers no status filter there. */
export const GMV_MAX_ACCOUNT_LEVEL_DELETED_NOTE =
  "Cấp account: TikTok mặc định chỉ tính chiến dịch chưa xoá và cấp này không có bộ lọc trạng thái - chi tiêu của chiến dịch GMV Max đã xoá có thể bị thiếu. " +
  "Cần tổng chi tiêu đầy đủ thì dùng level=campaign (include_deleted=true)."

/** D5 — ads_list_objects (TikTok campaigns): the account has GMV Max campaigns but none was tagged in this page. */
export const GMV_MAX_LIST_HIDDEN_NOTE =
  "Tài khoản có chiến dịch GMV Max (có thể không hiện trong danh sách này) - xem bằng tiktok_gmv_max_campaigns, chỉ số bằng tiktok_gmv_max_report."

// ---------------------------------------------------------------------------
// Phase 2 — writes opened behind the admin-only MCP switch (tiktok_gmv_max_write)
// ---------------------------------------------------------------------------

/** C6 — red warning of every GMV Max create / copy preview and result. */
export const GMV_MAX_RUNS_NOW_WARNING =
  "CẢNH BÁO: Chiến dịch GMV Max tạo qua API sẽ CHẠY NGAY (không tạo ở trạng thái tạm dừng được) và có thể tự tạm dừng quảng cáo Shop khác " +
  "dùng cùng cửa hàng / sản phẩm / tài khoản TikTok ở MỌI tài khoản QC."

/** C4 — reason shown when a GMV Max write is forced through two-step confirmation. */
export function gmvMaxConfirmReason(id: string): string {
  return `${id}: chiến dịch GMV Max - mọi thay đổi luôn cần xác nhận 2 bước.`
}

/** ROI protection rule (help "About ROI protection for GMV Max campaigns"). */
export const GMV_MAX_ROI_PROTECTION_NOTE =
  "Bảo vệ ROI: tăng ROI mục tiêu thủ công, hoặc giảm lần thứ hai trong cùng một ngày, làm mất Bảo vệ ROI của ngày đó " +
  "(LIVE: sửa ROI thủ công quá 2 lần trong ngày). TikTok khuyên giữ mỗi mức ROI ít nhất 3 ngày trọn vẹn (LIVE: tối đa 1 lần/ngày)."

/** C7 — the ROI history only knows changes made through this app. */
export const GMV_MAX_ROI_HISTORY_SCOPE =
  "Lịch sử đổi ROI chỉ tính các lần đổi qua Ads MCP - thay đổi trong TikTok Ads Manager / Seller Center không được tính."

/** C7 — Product GMV Max: ROI changed less than 3 full days ago. */
export function gmvMaxRoiRecentWarning(id: string, changedOn: string, fullDays: number): string {
  return (
    `CẢNH BÁO MẠNH: ROI mục tiêu của chiến dịch GMV Max sản phẩm ${id} đã được đổi qua MCP ngày ${changedOn} ` +
    `(mới ${fullDays} ngày trọn vẹn) - TikTok khuyên giữ mỗi mức ROI ít nhất 3 ngày trọn vẹn; đổi tiếp làm gián đoạn quá trình học.`
  )
}

/** C7 — LIVE GMV Max: ROI already changed today (account time zone). */
export function gmvMaxRoiLiveTodayWarning(id: string, count: number): string {
  return (
    `CẢNH BÁO MẠNH: ROI mục tiêu của chiến dịch GMV Max LIVE ${id} đã được đổi qua MCP ${count} lần hôm nay - ` +
    "TikTok khuyên đổi tối đa 1 lần/ngày; đổi nhiều lần làm gián đoạn quá trình học và có thể mất Bảo vệ ROI hôm nay."
  )
}

/** C7 — manual ROI raise. */
export const GMV_MAX_ROI_RAISE_WARNING =
  "Đang TĂNG ROI mục tiêu thủ công → TikTok không áp dụng Bảo vệ ROI cho chiến dịch này hôm nay."

/** C7 — second lowering in the same day. */
export const GMV_MAX_ROI_SECOND_LOWER_WARNING =
  "Đây là lần GIẢM ROI mục tiêu thứ hai trong hôm nay → TikTok không áp dụng Bảo vệ ROI cho chiến dịch này hôm nay."

/** Products of a Product GMV Max campaign changed. */
export const GMV_MAX_PRODUCTS_EDIT_WARNING =
  "Sửa danh sách sản phẩm: TikTok không áp dụng Bảo vệ ROI cho ngày sửa sản phẩm; GMV Max sẽ tối ưu lại. " +
  "Mỗi sản phẩm chỉ được ở 1 chiến dịch Product GMV Max đang bật; thêm sản phẩm đang chạy quảng cáo Shop khác (VSA/PSA) sẽ tự tạm dừng các quảng cáo đó ở mọi tài khoản QC."

/** Creatives removed / added back. */
export const GMV_MAX_CREATIVES_WARNING =
  "Gỡ / thêm lại video làm GMV Max tối ưu lại (có thể ảnh hưởng hiệu quả trong ngày). TikTok khuyên chờ khoảng 20 phút rồi mới kiểm tra " +
  "trạng thái video (creative_delivery_status) bằng tiktok_gmv_max_report level creative; video đã gỡ có trạng thái EXCLUDED."

/** Budget change of a GMV Max campaign. */
export const GMV_MAX_BUDGET_EFFECT_NOTE =
  "Chiến dịch GMV Max: TikTok chưa công bố thời điểm ngân sách mới có hiệu lực (có thể ngay lập tức). " +
  "TikTok khuyên giữ mức tiêu ngân sách dưới 80% và tăng ngân sách khi hiệu quả tốt lên."

/** Delete of a GMV Max campaign. */
export const GMV_MAX_DELETE_WARNING =
  "Xoá chiến dịch GMV Max: không hoàn tác, mất dữ liệu tối ưu; TikTok không áp dụng Bảo vệ ROI cho ngày xoá."

/** Auto budget increase / promotion days switched on. */
export const GMV_MAX_BOOST_WARNING =
  "Tăng ngân sách tự động / ngày khuyến mãi: ngân sách ngày có thể tự tăng nhiều lần (tới ~31 lần với 300% × 10 lần); " +
  "khi MCP có trần ngân sách ngày (chế độ Tùy chỉnh nâng cao), trần được so với mức chi tối đa có thể này. Ngày khuyến mãi còn hạ ROI mục tiêu 10-30% trong các ngày đó; " +
  "TikTok khuyên bật ngày khuyến mãi trước sự kiện 3-5 ngày."

/** Create / copy: not copied settings. */
export const GMV_MAX_COPY_NOT_COPIED_NOTE =
  "Bản sao KHÔNG bật tăng ngân sách tự động / ngày khuyến mãi (bật lại bằng tiktok_gmv_max_update nếu cần); lịch chạy bắt đầu từ lúc tạo."

/** C6 — copy of an "all products" Product GMV Max campaign. */
export function gmvMaxCopyAllProductsMessage(id: string): string {
  return (
    `Chiến dịch GMV Max ${id} quảng bá TẤT CẢ sản phẩm của cửa hàng: mỗi cửa hàng chỉ có 1 chiến dịch Product GMV Max "tất cả sản phẩm" đang bật, ` +
    "nên bản sao sẽ tranh chấp với chiến dịch gốc - không sao chép. Muốn chạy thêm, dùng tiktok_gmv_max_create với các sản phẩm khác (chưa nằm trong chiến dịch GMV Max đang bật nào)."
  )
}

/** Hint when products / identities are still occupied (create / copy / update). */
export const GMV_MAX_OCCUPIED_HINT =
  "Tạm dừng chiến dịch đang dùng chúng (ads_set_status) hoặc chọn sản phẩm khác (xem tiktok_gmv_max_products: chỉ dùng sản phẩm AVAILABLE + UNOCCUPIED) - tạo bằng tiktok_gmv_max_create."

/** GMV Max create / copy refused: the MCP is in the basic protection mode (no money caps). */
export function gmvMaxBasicProtectionMessage(op: "create" | "copy", currency: string): string {
  return (
    `MCP đang ở chế độ bảo vệ Cơ bản (không có trần chi tiêu) nên không ${op === "create" ? "tạo" : "sao chép"} được chiến dịch GMV Max - chiến dịch mới chạy ngay. ` +
    `Tạo / sao chép chiến dịch GMV Max cần chế độ Tùy chỉnh nâng cao và trần Ngân sách/ngày cho ${currency}. Bật/tắt và đổi ngân sách GMV Max vẫn dùng được.`
  )
}

export function gmvMaxBasicProtectionHint(currency: string): string {
  return `Nhờ chủ MCP vào trang quản trị Ads MCP → MCP → mở MCP này → tab Cấu hình → mục Bảo vệ → bật "Tùy chỉnh nâng cao", nhập Ngân sách/ngày cho ${currency} rồi lưu; sau đó thử lại.`
}

/** The adapter got a GMV Max write without mcp-core's strict daily-spend guard (fail closed). */
export const GMV_MAX_GUARD_MISSING =
  "Thiếu bước kiểm tra trần ngân sách/ngày cho thao tác GMV Max nên chưa thực hiện."

// ---------------------------------------------------------------------------
// Phase 2 fixes (security + API conformance review 2026-10-10)
// ---------------------------------------------------------------------------

/** S2 — a GMV Max write reached the adapter for EXECUTION without a consumed two-step confirmation. */
export function gmvMaxUnconfirmedMessage(id: string): string {
  return `Thay đổi chiến dịch GMV Max ${id} luôn cần người dùng xác nhận 2 bước - lần gọi này chưa qua bước xác nhận nên chưa thực hiện.`
}
export const GMV_MAX_UNCONFIRMED_HINT =
  "Gọi lại tool KHÔNG kèm confirm_token để nhận bản xem trước, cho người dùng xem rồi gọi lại với confirm_token khi họ đồng ý."

/** S5 — the 24 h history of GMV Max campaigns started by this MCP cannot be read (fail closed). */
export const GMV_MAX_STARTED_HISTORY_UNAVAILABLE =
  "Không đọc được lịch sử các chiến dịch GMV Max MCP này đã cho chạy trong 24 giờ qua (để kiểm tra trần ngân sách cộng dồn) nên chưa thực hiện. Thử lại sau."

/** S5 — label of the cumulative cap check (shown in the refusal). */
export function gmvMaxStartedTotalLabel(count: number, prior: string): string {
  return `Tổng mức chi tối đa/ngày của ${count} chiến dịch GMV Max MCP này đã tạo / sao chép / bật / tăng mức chi trong 24 giờ qua (${prior}) cộng thao tác này`
}

/** S5 — preview note of the cumulative cap check. */
export function gmvMaxStartedTotalNote(count: number, prior: string, total: string): string {
  return `Trần ngân sách cộng dồn: ${count} chiến dịch GMV Max MCP này đã cho chạy / tăng mức chi trong 24 giờ qua có mức chi tối đa ${prior}/ngày; tính cả thao tác này là ${total}/ngày (phải nằm trong trần ngân sách/ngày của MCP).`
}

/** A2 — the campaign could not be read back after the write. */
export function gmvMaxReadBackUnavailable(id: string): string {
  return `LƯU Ý: TikTok đã nhận thay đổi nhưng chưa đọc lại được chiến dịch GMV Max ${id} để đối chiếu - kiểm tra lại bằng tiktok_gmv_max_campaigns (include_details) hoặc TikTok Ads Manager.`
}

/** A2 — read-back differs from what was sent (no extra spend). */
export function gmvMaxReadBackMismatch(id: string, diffs: string): string {
  return `LỖI ĐỐI CHIẾU: sau khi gửi, TikTok báo chiến dịch GMV Max ${id} có ${diffs}. Kiểm tra lại trong TikTok Ads Manager.`
}

/** A2 — read-back shows MORE possible spend than what was approved. */
export function gmvMaxReadBackOverspend(id: string, worst: string, approved: string, diffs: string): string {
  return (
    `TikTok đã nhận thay đổi nhưng đọc lại thấy chiến dịch GMV Max ${id} có mức chi tối đa có thể ${worst}/ngày - cao hơn mức đã duyệt ${approved}/ngày` +
    `${diffs ? ` (${diffs})` : ""}. KIỂM TRA hoặc TẠM DỪNG chiến dịch ngay trong TikTok Ads Manager.`
  )
}
export const GMV_MAX_READBACK_CHECK_HINT =
  "Mở TikTok Ads Manager → GMV Max → chiến dịch này: kiểm tra ngân sách, tăng ngân sách tự động, ngày khuyến mãi; tạm dừng nếu không đúng ý (hoặc ads_set_status paused)."

/** S1 — copy of a deleted GMV Max campaign. */
export function gmvMaxCopyDeletedMessage(id: string): string {
  return `Chiến dịch GMV Max ${id} đã bị xoá - không sao chép chiến dịch đã xoá (bản sao sẽ CHẠY NGAY). Tạo mới bằng tiktok_gmv_max_create nếu cần.`
}

/** A5 — copy of a campaign that uses campaign-level customized posts. */
export function gmvMaxCopyCustomPostsMessage(id: string): string {
  return (
    `Chiến dịch GMV Max ${id} dùng bài đăng tuỳ chỉnh cấp chiến dịch (customized posts) - TikTok không cho chép các bài này sang chiến dịch khác ` +
    "và tính năng này sắp ngừng; không sao chép. Tạo mới bằng tiktok_gmv_max_create (hoặc sao chép trong TikTok Ads Manager)."
  )
}

/** A5 — the source ROI target had more precision than TikTok accepts. */
export function gmvMaxRoasRoundedWarning(source: number, sent: number): string {
  return `ROI mục tiêu của chiến dịch gốc là ${source}; TikTok chỉ nhận 1 chữ số thập phân nên bản sao dùng ${sent}.`
}

/** A7 — creatives can only be changed on a delivering campaign. */
export function gmvMaxNotDeliveringMessage(id: string, status: string | null): string {
  return (
    `Chiến dịch GMV Max ${id} không ở trạng thái đang phân phối (Active - CAMPAIGN_STATUS_ENABLE${status ? `; hiện tại: ${status}` : ""}) - ` +
    "TikTok chỉ cho gỡ / thêm lại video của chiến dịch đang hoạt động."
  )
}

/** A9 — delete answered with an error but the campaign is deleted. */
export function gmvMaxDeletedDespiteError(id: string): string {
  return `TikTok báo lỗi khi xoá nhưng đọc lại thấy chiến dịch GMV Max ${id} đã bị xoá.`
}

/** A4 — products removed by a full-replacement update. */
export function gmvMaxProductsRemovedWarning(ids: string[]): string {
  return `Danh sách sản phẩm là THAY THẾ TOÀN BỘ: sẽ GỠ ${ids.length} sản phẩm khỏi chiến dịch (${ids.slice(0, 20).join(", ")}${ids.length > 20 ? ", …" : ""}). Muốn giữ, thêm lại các id này vào item_group_ids.`
}

/** A1 — promotion days already off: nothing is sent (sending promotion_days can switch it on). */
export const GMV_MAX_PROMO_ALREADY_OFF =
  "Ngày khuyến mãi đang tắt - không gửi gì (gửi promotion_days có thể làm TikTok tự bật lại)."

/** A1 — documented defaults used when enabling a boost without known values. */
export function gmvMaxBoostDefaultsNote(label: string, pct: number, limit: number): string {
  return `${label}: chưa có mức tăng → dùng mặc định của TikTok +${pct}% × tối đa ${limit} lần/ngày (đã gửi rõ lên TikTok và tính vào mức chi tối đa).`
}

/** A11 — legacy root auto_budget_enabled (budget × 10). */
export const GMV_MAX_LEGACY_AUTO_BUDGET_ON =
  "Chiến dịch đang bật tăng ngân sách tự động kiểu cũ (auto_budget_enabled, tới 10 lần ngân sách ngày) - đã tính vào mức chi tối đa có thể; tắt trong TikTok Ads Manager nếu không cần."

/** A2 — a pause that did not take effect (the campaign keeps spending). */
export function gmvMaxPauseNotApplied(id: string, status: string): string {
  return `LỖI: TikTok đã nhận lệnh tạm dừng nhưng đọc lại thấy chiến dịch GMV Max ${id} vẫn ở trạng thái ${status} (VẪN CHI TIÊU) - tạm dừng ngay trong TikTok Ads Manager.`
}
