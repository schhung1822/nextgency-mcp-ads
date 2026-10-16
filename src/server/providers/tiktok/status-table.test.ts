// normalizeStatus / statusDetail against "Supported secondary statuses for a primary status" (doc 1757239620352002,
// checked 2026-10-16) + the Upgraded Smart+ ad statuses (providers/tiktok.md §3). op = ENABLE unless the row says otherwise.
import { describe, expect, it } from "vitest"
import type { NormalizedStatus } from "../types"
import { deliveryBlockedReason, normalizeStatus, statusDetail } from "./api"
import { toSummary } from "./objects"

const TABLE: [string, NormalizedStatus][] = [
  // campaign
  ["CAMPAIGN_STATUS_DELETE", "deleted"],
  ["CAMPAIGN_STATUS_ADVERTISER_AUDIT_DENY", "rejected"],
  ["CAMPAIGN_STATUS_ADVERTISER_AUDIT", "pending_review"],
  ["ADVERTISER_CONTRACT_PENDING", "disabled"],
  ["ADVERTISER_ACCOUNT_PUNISH", "disabled"],
  ["CAMPAIGN_STATUS_BUDGET_EXCEED", "active"], // switched on, not delivering: status_raw tells why
  ["CAMPAIGN_STATUS_DISABLE", "paused"],
  ["CAMPAIGN_STATUS_AWAITING_RELEASE", "paused"],
  ["CAMPAIGN_STATUS_ENABLE", "active"],
  // GMV Max STATUS_DISABLE group
  ["CAMPAIGN_STATUS_LIVE_GMV_MAX_AUTHORIZATION_CANCEL", "paused"],
  ["CAMPAIGN_STATUS_PRODUCT_GMV_MAX_AUTHORIZATION_CANCEL", "paused"],
  ["CAMPAIGN_STATUS_IDENTITY_USED_BY_LIVE_GMV_MAX", "paused"],
  ["CAMPAIGN_STATUS_PRODUCT_USED_BY_PRODUCT_GMV_MAX", "paused"],
  ["CAMPAIGN_STATUS_IDENTITY_USED_BY_GMV_MAX_AD", "active"], // NOT_DELIVERY, op ENABLE
  ["CAMPAIGN_STATUS_TIKTOK_SHOP_UNAVAILABLE", "disabled"],
  ["CAMPAIGN_STATUS_REVIEW_DISAPPROVED", "rejected"],
  // ad group
  ["ADGROUP_STATUS_CAMPAIGN_DELETE", "deleted"],
  ["ADGROUP_STATUS_DELETE", "deleted"],
  ["ADGROUP_STATUS_CAMPAIGN_DISABLE", "paused"],
  ["ADGROUP_STATUS_DISABLE", "paused"],
  ["ADGROUP_STATUS_ADVERTISER_AUDIT_DENY", "rejected"],
  ["ADGROUP_STATUS_ADVERTISER_AUDIT", "pending_review"],
  ["ADGROUP_STATUS_BALANCE_EXCEED", "active"],
  ["ADGROUP_STATUS_CREATE", "active"],
  ["ADGROUP_STATUS_TRANSCODING_FAIL", "active"],
  ["ADGROUP_STATUS_AUDIT", "pending_review"],
  ["ADGROUP_STATUS_REAUDIT", "pending_review"],
  ["ADGROUP_STATUS_AUDIT_DENY", "rejected"],
  ["ADGROUP_STATUS_PARTIAL_AUDIT_NO_DELIVERY", "pending_review"],
  ["ADGROUP_STATUS_LIVE_NOT_START", "active"],
  ["ADGROUP_STATUS_INDUSTRY_QUALIFICATION_DENY", "rejected"],
  ["ADGROUP_STATUS_FROZEN", "disabled"],
  ["ADGROUP_STATUS_SEARCH_KEYWORDS_IN_REVIEW", "pending_review"],
  ["ADGROUP_STATUS_SEARCH_KEYWORDS_NOT_AVAILABLE", "disabled"],
  ["ADGROUP_STATUS_SEARCH_KEYWORDS_PARTIAL_APPROVED", "active"],
  ["ADGROUP_STATUS_PARTIAL_AUDIT_DELIVERY_OK", "active"],
  ["ADGROUP_STATUS_SHADOW_ADGROUP_REAUDIT", "active"],
  ["ADGROUP_STATUS_DELIVERY_OK", "active"],
  ["ADGROUP_STATUS_REVIEW_PARTIALLY_APPROVED", "active"],
  ["ADGROUP_STATUS_TIME_DONE", "archived"],
  ["ADGROUP_STATUS_RF_DEDUCTION_FAILED", "disabled"],
  ["ADGROUP_STATUS_RF_NO_VALID_CREATIVE", "disabled"],
  ["ADGROUP_STATUS_RF_CLOSED_OTHERS", "disabled"],
  ["ADGROUP_STATUS_RF_AD_AUDIT_DENY", "rejected"],
  ["ADVERTISER_ACCOUNT_INVALID", "disabled"],
  ["ADGROUP_STATUS_RF_ADGROUP_INVALID", "disabled"],
  ["ADGROUP_STATUS_RF_WITHDRAW_ORDER", "disabled"],
  ["ADGROUP_STATUS_RF_TERMINATE", "archived"],
  ["ADGROUP_STATUS_RF_TIME_DONE", "archived"],
  ["ADGROUP_STATUS_PROMOTE_AD_NOT_APPROVED", "rejected"],
  ["ADGROUP_STATUS_PROMOTE_WITHDRAW_ORDER", "disabled"],
  // ad
  ["AD_STATUS_ADGROUP_DELETE", "deleted"],
  ["AD_STATUS_DELETE", "deleted"],
  ["AD_STATUS_ADVERTISER_AUDIT_DENY", "rejected"],
  ["AD_STATUS_LIVE_OFFLINE", "active"],
  ["AD_STATUS_ADGROUP_PARTIAL_AUDIT_NO_DELIVERY", "pending_review"],
  ["AD_STATUS_PARTIAL_AUDIT_NO_DELIVERY", "pending_review"],
  ["AD_STATUS_ADGROUP_AUDIT_DENY", "rejected"],
  ["AD_STATUS_AUDIT", "pending_review"],
  ["AD_STATUS_REAUDIT", "pending_review"],
  ["AD_STATUS_AUDIT_DENY", "rejected"],
  ["AD_STATUS_PRODUCT_UNAVAILABLE", "disabled"],
  ["AD_STATUS_ANCHOR_UNAVAILABLE", "disabled"],
  ["AD_STAUS_PIXEL_UNBIND", "active"], // sic (doc typo)
  ["AD_STATUS_PARTIAL_AUDIT_DELIVERY_OK", "active"],
  ["AD_STATUS_REVIEW_PARTIALLY_APPROVED", "active"],
  ["AD_STATUS_DELIVERY_OK", "active"],
  ["AD_STATUS_CAMPAIGN_DISABLE", "paused"],
  ["AD_STATUS_ADGROUP_DISABLE", "paused"],
  ["AD_STATUS_DONE", "archived"],
  ["AD_STATUS_RF_ADGROUP_CLOSED", "disabled"],
  ["AD_STATUS_PROMOTE_AD_OFFLINE_AUDIT", "rejected"],
  ["AD_STATUS_PROMOTE_ADGROUP_CLOSED", "disabled"],
  // Upgraded Smart+ ad statuses
  ["AD_STATUS_DELIVERY_AND_REAUDIT", "active"],
  ["AD_STATUS_PRIVACY_POLICY_REJECTED", "rejected"],
  ["AD_STATUS_PRIVACY_POLICY_AUDIT", "pending_review"],
  ["AD_STATUS_DELIVERY_AND_TRANSCODING_FAIL", "active"],
  ["AD_STATUS_COLLECTION_TOGGLED_OFF", "disabled"],
]

describe("normalizeStatus theo bảng secondary_status chính thức (doc 1757239620352002)", () => {
  it.each(TABLE)("ENABLE + %s → %s", (sec, expected) => {
    expect(normalizeStatus("ENABLE", sec)).toBe(expected)
  })

  it("người dùng tạm dừng vẫn thắng (DISABLE + bất kỳ trạng thái phụ không xoá / từ chối) → paused", () => {
    expect(
      normalizeStatus("DISABLE", "ADGROUP_STATUS_SHADOW_ADGROUP_REAUDIT")
    ).toBe("paused")
    expect(
      normalizeStatus("DISABLE", "ADGROUP_STATUS_SEARCH_KEYWORDS_NOT_AVAILABLE")
    ).toBe("paused")
    expect(normalizeStatus("DISABLE", "AD_STATUS_DELETE")).toBe("deleted")
  })
})

describe("statusDetail", () => {
  it("duyệt một phần đang chạy → partially_approved; từ chối một phần → partially_rejected; còn lại null", () => {
    for (const s of [
      "AD_STATUS_PARTIAL_AUDIT_DELIVERY_OK",
      "AD_STATUS_REVIEW_PARTIALLY_APPROVED",
      "ADGROUP_STATUS_PARTIAL_AUDIT_DELIVERY_OK",
      "ADGROUP_STATUS_REVIEW_PARTIALLY_APPROVED",
      "ADGROUP_STATUS_SEARCH_KEYWORDS_PARTIAL_APPROVED",
    ]) {
      expect(statusDetail(s), s).toBe("partially_approved")
    }
    expect(statusDetail("ADGROUP_STATUS_PARTIAL_AUDIT_DENY")).toBe(
      "partially_rejected"
    )
    expect(normalizeStatus("ENABLE", "ADGROUP_STATUS_PARTIAL_AUDIT_DENY")).toBe(
      "rejected"
    )
    for (const s of [
      "AD_STATUS_DELIVERY_OK",
      "AD_STATUS_PARTIAL_AUDIT_NO_DELIVERY",
      "AD_STATUS_AUDIT_DENY",
      "",
      undefined,
      5,
    ]) {
      expect(statusDetail(s)).toBeNull()
    }
  })

  it("toSummary điền statusDetail chỉ khi có", () => {
    const partial = toSummary(
      "ad",
      {
        ad_id: "1",
        ad_name: "A",
        operation_status: "ENABLE",
        secondary_status: "AD_STATUS_REVIEW_PARTIALLY_APPROVED",
      },
      "VND"
    )
    expect(partial.status).toBe("active")
    expect(partial.statusDetail).toBe("partially_approved")
    const normal = toSummary(
      "ad",
      {
        ad_id: "2",
        ad_name: "B",
        operation_status: "ENABLE",
        secondary_status: "AD_STATUS_DELIVERY_OK",
      },
      "VND"
    )
    expect(normal).not.toHaveProperty("statusDetail")
  })
})

describe("delivery_blocked_reason (bật nhưng không phân phối - nhóm STATUS_NOT_DELIVERY)", () => {
  const BLOCKED: [string, string][] = [
    ["ADGROUP_STATUS_CREATE", "no_ads"],
    ["CAMPAIGN_STATUS_BUDGET_EXCEED", "budget_exceeded"],
    ["ADGROUP_STATUS_BUDGET_EXCEED", "budget_exceeded"],
    ["AD_STATUS_CAMPAIGN_EXCEED", "campaign_budget_exceeded"],
    ["ADGROUP_STATUS_BALANCE_EXCEED", "balance_insufficient"],
    ["CAMPAIGN_STATUS_TTS_ACCOUNT_BALANCE_INSUFFICIENT", "balance_insufficient"],
    ["ADGROUP_STATUS_NOT_START", "not_started"],
    ["ADGROUP_STATUS_LIVE_NOT_START", "live_not_started"],
    ["AD_STATUS_LIVE_OFFLINE", "live_offline"],
    ["AD_STATUS_TRANSCODING_FAIL", "transcoding_failed"],
    ["AD_STATUS_ADGROUP_ASSET_AUTHORIZATION_LOST", "asset_authorization_lost"],
    ["AD_STAUS_PIXEL_UNBIND", "pixel_unauthorized"],
    ["ADGROUP_STATUS_PIXEL_UNBIND", "pixel_unauthorized"],
    ["ADGROUP_STATUS_ADGROUP_QUOTA_LIMIT", "quota_limit"],
    ["AD_STATUS_AD_PRE_ONLINE", "pre_online"],
    ["ADGROUP_STATUS_INDUSTRY_QUALIFICATION_MISSING", "qualification_missing"],
    ["AD_STATUS_ADGROUP_INDUSTRY_QUALIFICATION_EXPIRED", "qualification_expired"],
    ["AD_STATUS_MUSIC_AUTHORIZATION_MISSING", "music_authorization_missing"],
    ["AD_STATUS_PROCESS_AUDIO", "processing_audio"],
    ["AD_STATUS_NO_AUTHORIZATION_OF_SHOWCASE", "showcase_unauthorized"],
    ["ADGROUP_STATUS_IDENTITY_USED_BY_GMV_MAX_AD", "identity_used_by_gmv_max"],
    ["ADGROUP_STATUS_RF_NO_DELIVERY_CREATIVE", "rf_no_creative"],
    ["ADGROUP_STATUS_RF_SHORT_BALANCE", "rf_short_balance"],
    ["ADGROUP_STATUS_RF_BOOKING", "rf_booked"],
    ["ADGROUP_STATUS_RF_SCHEDULE", "rf_scheduled"],
  ]
  it.each(BLOCKED)("%s → status active (giữ nguyên) + code %s", (sec, code) => {
    expect(normalizeStatus("ENABLE", sec)).toBe("active")
    expect(deliveryBlockedReason(sec)?.code).toBe(code)
  })

  it("đang phân phối / Smart+ DELIVERY_AND_TRANSCODING_FAIL / rỗng → null", () => {
    for (const s of ["AD_STATUS_DELIVERY_OK", "AD_STATUS_DELIVERY_AND_TRANSCODING_FAIL", "ADGROUP_STATUS_SHADOW_ADGROUP_REAUDIT", "", null]) {
      expect(deliveryBlockedReason(s)).toBeNull()
    }
  })

  it("toSummary: extra.delivery_blocked_reason chỉ khi status active; tạm dừng thì không", () => {
    const on = toSummary(
      "ad_group",
      { adgroup_id: "1", adgroup_name: "G", operation_status: "ENABLE", secondary_status: "ADGROUP_STATUS_BUDGET_EXCEED" },
      "VND"
    )
    expect(on.status).toBe("active")
    expect(on.extra?.delivery_blocked_reason).toEqual({ code: "budget_exceeded", label: "đã hết ngân sách" })
    const off = toSummary(
      "ad_group",
      { adgroup_id: "1", adgroup_name: "G", operation_status: "DISABLE", secondary_status: "ADGROUP_STATUS_DISABLE" },
      "VND"
    )
    expect(off.extra).not.toHaveProperty("delivery_blocked_reason")
  })
})
